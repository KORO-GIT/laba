import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const token = 'synthetic-accounting-token-at-least-32-characters';
const record = (extra = {}) => ({
  spreadsheetId: 'synthetic-sheet', sheetId: 1, rowNumber: 2,
  sourceName: 'Тестова таблиця', sheetName: 'Облік', asset: 'Тестовий засіб',
  boardIdentifier: '001', identifiers: ['001', 'KIT-TEST-1'],
  status: 'ПОТРЕБУЄ СЕРВІСУ', boardLocation: 'ЛАБА', caseLocation: 'ЛАБА',
  sourceComment: 'Коментар з таблиці', ...extra
});

async function fixture(context) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'laba-maintenance-test-'));
  const dbPath = path.join(temp, 'portal.db');
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const root = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  async function start() {
    const logs = [];
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, NODE_ENV: 'test', AUTH_MODE: 'development', PORT: String(port),
        DB_PATH: dbPath, BOOTSTRAP_ADMIN_EMAIL: 'admin@test.local', DEV_USER_EMAIL: 'admin@test.local',
        ACCOUNTING_SYNC_TOKEN: token, AUDIO_AGENT_URL: '', STARLINK_AGENT_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(logs.join(''));
      try { if ((await fetch(`${root}/healthz`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Server not ready: ${logs.join('')}`);
  }
  context.after(async () => {
    await stop();
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await start();
  async function request(route, body, method = 'POST', headers = {}) {
    const response = await fetch(`${root}${route}`, {
      method: body === undefined ? 'GET' : method,
      headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root,
        'X-Laba-Sync-Token': token, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  }
  return {
    root, dbPath, start, stop, request,
    sync: records => request('/api/internal/accounting/sync', { records }),
    board: (module = 'service') => request(`/api/maintenance/${module}`),
    move: (id, lane, module = 'service') => request(`/api/maintenance/${module}/cards/${id}/move`, { lane }),
    ack: id => request('/api/internal/accounting/ack', { results: [{ id, success: true }] })
  };
}

test('service imports shipped boards and containers from their own location columns without echo writes', async context => {
  const f = await fixture(context);
  const records = [
    record({ boardLocation: '  київ  ' }),
    record({ rowNumber: 3, boardLocation: 'НА РЕМОНТІ' }),
    record({ rowNumber: 4, status: 'ВТРАЧЕНИЙ', caseLocation: 'КИЇВ' }),
    record({ rowNumber: 5, status: 'ВТРАЧЕНИЙ', boardLocation: 'КИЇВ' }),
    record({ rowNumber: 6, caseLocation: 'КИЇВ' }),
    record({ rowNumber: 7, status: 'ТЕХНІЧНІ ПРОБЛЕМИ', boardLocation: 'КИЇВ' })
  ];
  assert.deepEqual((await f.sync(records)).actions, []);
  const first = await f.board();
  assert.equal(first.cards.length, 5);
  assert.equal(first.cards.filter(card => card.lane === 'shipped').length, 3);
  assert.equal(first.cards.filter(card => card.asset === 'ТАРА' && card.lane === 'new').length, 1);
  assert.equal((await f.board('workshop')).cards[0].lane, 'new');
  assert.deepEqual((await f.sync(records)).actions, []);
  assert.deepEqual((await f.board()).cards.map(card => card.id), first.cards.map(card => card.id));
  assert.deepEqual((await f.sync([])).actions, []);
  assert.equal((await f.board()).cards.length, 5, 'Partial/empty snapshot does not erase absent rows');
});

test('local shipment survives polling, acknowledgement and restart without an echo or archive', async context => {
  const f = await fixture(context);
  const original = record();
  await f.sync([original]);
  const card = (await f.board()).cards[0];
  await f.move(card.id, 'shipped');
  const queued = (await f.sync([original])).actions;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].targetBoardLocation, 'НА РЕМОНТІ');
  assert.equal(queued[0].targetCaseLocation, 'НА РЕМОНТІ');
  assert.equal((await f.board()).cards[0].lane, 'shipped');
  await f.ack(queued[0].id);
  assert.equal((await f.board()).cards[0].lane, 'shipped');
  await f.stop();
  await f.start();
  const applied = record({ boardLocation: 'НА РЕМОНТІ', caseLocation: 'НА РЕМОНТІ' });
  assert.deepEqual((await f.sync([applied])).actions, []);
  const workflows = await f.request('/api/admin/workflows');
  const service = workflows.boards.find(board => board.key === 'service');
  await f.request('/api/admin/workflows/service', {
    title: service.title, description: service.description, entryLaneKey: service.entryLaneKey,
    sourceStatuses: service.sourceStatuses, lanes: service.lanes.map(({ system, ...lane }) => lane),
    access: service.access
  }, 'PATCH');
  assert.deepEqual((await f.sync([applied])).actions, [], 'Settings save does not resend a confirmed shipment');
  assert.equal((await f.board()).cards[0].id, card.id);
});

test('sheet changes cancel stale writes and late acknowledgements cannot hide or move the card', async context => {
  const f = await fixture(context);
  await f.sync([record()]);
  const card = (await f.board()).cards[0];
  await f.move(card.id, 'shipped');
  const action = (await f.sync([record()])).actions[0];
  assert.deepEqual((await f.sync([record({ boardLocation: 'КИЇВ' })])).actions, []);
  assert.equal((await f.ack(action.id)).accepted, 0);
  assert.equal((await f.board()).cards[0].lane, 'shipped');
  assert.deepEqual((await f.sync([record({ boardLocation: 'ЛАБА' })])).actions, []);
  assert.equal((await f.board()).cards[0].lane, 'new');
  await f.move(card.id, 'shipped');
  const second = (await f.sync([record()])).actions[0];
  assert.deepEqual((await f.sync([record({ boardLocation: 'БОСТОН' })])).actions, []);
  assert.equal((await f.board()).cards[0].lane, 'new');
  assert.equal((await f.ack(second.id)).accepted, 0);
  await f.move(card.id, 'shipped');
  assert.deepEqual((await f.sync([record({ status: 'ТЕХНІЧНІ ПРОБЛЕМИ' })])).actions, []);
  assert.equal((await f.board()).cards.length, 0);
  assert.equal((await f.board('workshop')).cards.length, 1);
});

test('sheet round trips preserve report, notes, labels, comments and manual intermediate stages', async context => {
  const f = await fixture(context);
  const workflows = await f.request('/api/admin/workflows');
  const service = workflows.boards.find(board => board.key === 'service');
  await f.request('/api/admin/workflows/service', {
    title: service.title, description: service.description, entryLaneKey: service.entryLaneKey,
    sourceStatuses: service.sourceStatuses, lanes: service.lanes.map(({ system, ...lane }) => lane),
    access: service.access, cardLabels: [{ name: 'Складний', color: '#abcdef' }],
    cardStatuses: [{ name: 'Чекаємо', color: '#abcdef' }]
  }, 'PATCH');
  await f.sync([record({ status: 'ВТРАЧЕНИЙ' })]);
  const board = await f.board();
  const card = board.cards[0];
  await f.request(`/api/maintenance/service/cards/${card.id}`, {
    notes: 'Робочі примітки', reportNumber: 'РП-123',
    cardLabelIds: [board.cardLabels[0].id], cardStatusIds: [board.cardStatuses[0].id]
  }, 'PATCH');
  await f.move(card.id, 'documents_preparing');
  await f.sync([record({ status: 'ВТРАЧЕНИЙ' })]);
  assert.equal((await f.board()).cards[0].lane, 'documents_preparing');
  await f.sync([record({ status: 'ВТРАЧЕНИЙ', caseLocation: 'КИЇВ', sourceComment: 'Оновлений коментар' })]);
  let changed = (await f.board()).cards[0];
  assert.equal(changed.lane, 'shipped');
  assert.equal(changed.reportNumber, 'РП-123');
  assert.equal(changed.notes, 'Робочі примітки');
  assert.equal(changed.sourceComment, 'Оновлений коментар');
  assert.equal(changed.cardLabels[0].name, 'Складний');
  assert.equal(changed.cardStatuses[0].name, 'Чекаємо');
  assert.ok(changed.events.some(event => event.actorEmail === 'Облік' && event.toLane === 'shipped'));
  const withoutLocations = record({ status: 'ВТРАЧЕНИЙ' });
  delete withoutLocations.boardLocation;
  delete withoutLocations.caseLocation;
  await f.sync([withoutLocations]);
  assert.equal((await f.board()).cards[0].lane, 'shipped');
  await f.sync([record({ status: 'ВТРАЧЕНИЙ' })]);
  changed = (await f.board()).cards[0];
  assert.equal(changed.lane, 'new');
  assert.equal(changed.id, card.id);
  assert.equal(changed.reportNumber, 'РП-123');
});

test('legacy archived shipment returns with its history and additive migration preserves old values', async context => {
  const f = await fixture(context);
  await f.sync([record()]);
  const card = (await f.board()).cards[0];
  await f.request(`/api/maintenance/service/cards/${card.id}`, { notes: 'Збережено', reportNumber: 'РП-1' }, 'PATCH');
  await f.move(card.id, 'shipped');
  const action = (await f.sync([record()])).actions[0];
  await f.ack(action.id);
  await f.stop();
  const db = new Database(f.dbPath);
  db.prepare('UPDATE maintenance_cards SET removed_at=CURRENT_TIMESTAMP WHERE id=?').run(card.id);
  db.exec('ALTER TABLE maintenance_cards DROP COLUMN source_board_location');
  db.exec('ALTER TABLE maintenance_cards DROP COLUMN source_case_location');
  const old = db.prepare('SELECT * FROM maintenance_cards').all();
  db.close();
  await f.start();
  await f.stop();
  await f.start();
  const migrated = new Database(f.dbPath, { readonly: true });
  for (const previous of old) {
    const current = migrated.prepare('SELECT * FROM maintenance_cards WHERE id=?').get(previous.id);
    for (const [key, value] of Object.entries(previous)) assert.deepEqual(current[key], value, key);
  }
  assert.deepEqual(migrated.pragma('foreign_key_check'), []);
  migrated.close();
  assert.deepEqual((await f.sync([record({ boardLocation: 'КИЇВ' })])).actions, []);
  const restored = (await f.board()).cards[0];
  assert.equal(restored.id, card.id);
  assert.equal(restored.lane, 'shipped');
  assert.equal(restored.reportNumber, 'РП-1');
  assert.equal(restored.notes, 'Збережено');
});

test('shipment comments are persisted once per move, not on reorder, restart or settings save', async context => {
  const f = await fixture(context);
  await f.sync([record()]);
  const card = (await f.board()).cards[0];
  await f.move(card.id, 'shipped');
  const action = (await f.sync([record()])).actions[0];
  assert.match(action.commentAppend, /^Відправлено на сервіс: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
  await f.move(card.id, 'shipped');
  await f.stop();
  await f.start();
  assert.deepEqual((await f.sync([record()])).actions[0], action);
  const fieldsApplied = record({ boardLocation: 'НА РЕМОНТІ', caseLocation: 'НА РЕМОНТІ' });
  assert.equal((await f.sync([fieldsApplied])).actions[0].id, action.id, 'Location alone does not acknowledge the comment');
  const workflows = await f.request('/api/admin/workflows');
  const service = workflows.boards.find(board => board.key === 'service');
  await f.request('/api/admin/workflows/service', {
    title: service.title, description: service.description, entryLaneKey: service.entryLaneKey,
    sourceStatuses: service.sourceStatuses, lanes: service.lanes.map(({ system, ...lane }) => lane), access: service.access
  }, 'PATCH');
  assert.equal((await f.sync([fieldsApplied])).actions[0].commentAppend, action.commentAppend);
  const confirmed = { ...fieldsApplied, sourceComment: `${fieldsApplied.sourceComment}\n${action.commentAppend}` };
  assert.deepEqual((await f.sync([confirmed])).actions, []);
  assert.equal((await f.ack(action.id)).accepted, 0, 'Snapshot recovered a lost acknowledgement');
  await f.move(card.id, 'awaiting_shipment');
  await f.move(card.id, 'shipped');
  const repeat = (await f.sync([confirmed])).actions[0];
  // A new move is an independent event even when physical location has not yet changed.
  assert.notEqual(repeat.id, action.id);
});

test('return writes inspection, both LABA locations and a dated comment; service history coexists with workshop', async context => {
  const f = await fixture(context);
  const shipped = record({ boardLocation: 'НА РЕМОНТІ', caseLocation: 'НА РЕМОНТІ' });
  await f.sync([shipped]);
  const board = await f.board();
  assert.equal(board.lanes.find(lane => lane.key === 'returned').title, 'Отримано після сервісу');
  const card = board.cards[0];
  await f.request(`/api/maintenance/service/cards/${card.id}`, { notes: 'Примітка', reportNumber: 'РП-2' }, 'PATCH');
  await f.move(card.id, 'returned');
  const action = (await f.sync([shipped])).actions[0];
  assert.equal(action.actionKind, 'service_return');
  assert.equal(action.targetStatus, 'ПОТРЕБУЄ ОГЛЯДУ');
  assert.equal(action.targetBoardLocation, 'ЛАБА');
  assert.equal(action.targetCaseLocation, 'ЛАБА');
  assert.match(action.commentAppend, /^Повернувся із сервісу: /);
  await f.ack(action.id);
  const returned = record({ status: 'ПОТРЕБУЄ ОГЛЯДУ', sourceComment: `${shipped.sourceComment}\n${action.commentAppend}` });
  assert.deepEqual((await f.sync([returned])).actions, []);
  assert.equal((await f.board('workshop')).cards[0].lane, 'new');
  await f.stop();
  await f.start();
  assert.deepEqual((await f.sync([returned])).actions, []);
  const history = (await f.board()).cards[0];
  assert.equal(history.id, card.id);
  assert.equal(history.lane, 'returned');
  assert.equal(history.reportNumber, 'РП-2');
  assert.equal(history.notes, 'Примітка');
  assert.equal(history.sourceComment, returned.sourceComment);
  await f.sync([{ ...returned, status: 'НА ОБЛІТ' }]);
  assert.equal((await f.board()).cards[0].lane, 'returned', 'Completed service history remains visible');
  await f.sync([record()]);
  assert.equal((await f.board()).cards[0].lane, 'new', 'A new service cycle reuses the card and history');
});

test('return acknowledgement recovery and source-side returns do not produce echo writes', async context => {
  const f = await fixture(context);
  const shipped = record({ boardLocation: 'КИЇВ' });
  await f.sync([shipped]);
  const card = (await f.board()).cards[0];
  await f.move(card.id, 'returned');
  const action = (await f.sync([shipped])).actions[0];
  const returned = record({ status: 'ПОТРЕБУЄ ОГЛЯДУ' });
  assert.equal((await f.sync([returned])).actions[0].id, action.id, 'A missing comment must still be appended');
  assert.deepEqual((await f.sync([{ ...returned, sourceComment: action.commentAppend }])).actions, []);
  assert.equal((await f.board()).cards[0].lane, 'returned');
  assert.equal((await f.ack(action.id)).accepted, 0);
  await f.sync([shipped]);
  assert.equal((await f.board()).cards[0].lane, 'shipped');
  assert.deepEqual((await f.sync([returned])).actions, []);
  assert.equal((await f.board()).cards[0].lane, 'returned');
});

test('lost containers cannot be returned as a repaired board', async context => {
  const f = await fixture(context);
  await f.sync([record({ status: 'ВТРАЧЕНИЙ' })]);
  const card = (await f.board()).cards[0];
  const response = await fetch(`${f.root}/api/maintenance/service/cards/${card.id}/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: f.root },
    body: JSON.stringify({ lane: 'returned' })
  });
  assert.equal(response.status, 400);
  assert.equal((await f.board()).cards[0].lane, 'new');
  await f.move(card.id, 'shipped');
  const action = (await f.sync([record({ status: 'ВТРАЧЕНИЙ' })])).actions[0];
  assert.equal(action.targetStatus, '');
  assert.equal(action.targetBoardLocation, null);
  assert.match(action.commentAppend, /^Тару відправлено: /);
});

test('return column migration is additive and does not overwrite customized lanes on restart', async context => {
  const f = await fixture(context);
  await f.stop();
  const db = new Database(f.dbPath);
  db.prepare("DELETE FROM workflow_lanes WHERE module='service' AND lane_key='returned'").run();
  db.prepare("DELETE FROM schema_migrations WHERE name='service-returned-lane-v1'").run();
  db.prepare("UPDATE workflow_lanes SET title='Надіслано', color='#112233', sort_order=90 WHERE module='service' AND lane_key='shipped'").run();
  db.close();
  await f.start();
  const lanes = (await f.board()).lanes;
  assert.equal(lanes.at(-1).key, 'returned');
  assert.equal(lanes.find(lane => lane.key === 'shipped').title, 'Надіслано');
  await f.stop();
  await f.start();
  assert.deepEqual((await f.board()).lanes, lanes);
});
