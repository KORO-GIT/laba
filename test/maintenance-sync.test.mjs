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
