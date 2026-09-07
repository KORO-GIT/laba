import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function websocketHandshake(port, host, origin, requestPath = '/websocket', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${host}`,
        `Origin: ${origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: SGVsbG9Xb3JsZDEyMzQ1Ng==',
        ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
        '', ''
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('WebSocket handshake timed out'));
    });
    socket.once('error', reject);
  });
}

async function waitFor(url, child, logs) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${logs.join('')}`);
}

test('development server serves portal API and protected admin writes', async (context) => {
  const port = await freePort();
  const upstreamPort = await freePort();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'laba-test-'));
  const logs = [];
  let upstreamUpgradeOrigin = null;
  let upstreamUpgradeUrl = null;
  let upstreamUpgradeAuthorization = null;
  const upstreamRequests = [];
  const audioRequests = [];
  const starlinkRequests = [];
  const audioStatus = {
    version: 1,
    adapter: { available: true, powered: true, discovering: false, pairable: true, name: 'PiLABA4B' },
    devices: [{
      address: 'AA:BB:CC:DD:EE:FF', name: 'Test Speaker', paired: true,
      bonded: true, trusted: true, connected: true, audio: true, icon: 'audio-card'
    }],
    audio: {
      available: true, sinks: [{ id: 57, name: 'Test Speaker', default: true }],
      defaultSinkId: 57, volume: 40, muted: false
    },
    player: { available: false, status: 'Stopped', player: null, title: null, artist: null },
    clap: {
      enabled: true, listening: true, source: 'Webcam C270 Mono',
      config: { sensitivity: 70, maxIntervalMs: 1100, minIntervalMs: 160 },
      limits: { sensitivity: { min: 30, max: 80 }, maxIntervalMs: { min: 350, max: 1500 } }
    }
  };
  const starlinkStatus = {
    version: 1,
    connected: true,
    state: 'CONNECTED',
    device: { hardwareVersion: 'mini1_panda_prod2', bypassMode: true, uptimeSeconds: 3600 },
    router: { available: false, state: 'BYPASSED', source: 'DISH_TELEMETRY' },
    network: { pingMs: 24.5, downloadMbps: 31.2, uploadMbps: 7.4, ethernetMbps: 1000 },
    obstruction: { fractionPercent: 3.7, currentlyObstructed: false },
    gps: { satellites: 12, valid: true, inhibited: false, locationAvailable: false },
    config: { snowMeltMode: 'AUTO', powerSaveEnabled: false, powerSaveStartMinutesUtc: 0, powerSaveDurationMinutes: 1 },
    health: { alerts: [], hardwareSelfTestCodes: [] },
    capabilities: { reboot: true, gpsInhibit: true, powerSave: true, snowMelt: false, clearObstructionMap: true, stow: false },
    history: { ping: { averageMs: 27.1 }, loss: { averagePercent: 0.2 }, series: { pingMs: [24, 28] }, events: [] }
  };
  const upstream = http.createServer(async (request, response) => {
    if (request.url.startsWith('/v1/')) {
      let rawBody = '';
      for await (const chunk of request) rawBody += chunk;
      const record = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : null
      };
      const isStarlink = request.headers.authorization === 'Bearer test-starlink-agent-token-with-at-least-32-characters';
      (isStarlink ? starlinkRequests : audioRequests).push(record);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(isStarlink ? starlinkStatus : audioStatus));
      return;
    }
    upstreamRequests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url.startsWith('/api/hls/')) {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(`window.deviceAsset = ${JSON.stringify(request.url)};`);
  });
  upstream.on('upgrade', (request, socket) => {
    upstreamUpgradeOrigin = request.headers.origin;
    upstreamUpgradeUrl = request.url;
    upstreamUpgradeAuthorization = request.headers.authorization;
    const accept = crypto
      .createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.end([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Accept: ${accept}`,
      '', ''
    ].join('\r\n'));
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await once(upstream, 'listening');
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      PORT: String(port),
      DB_PATH: path.join(temp, 'portal.db'),
      BOOTSTRAP_ADMIN_EMAIL: 'admin@test.local',
      DEV_USER_EMAIL: 'admin@test.local',
      ALLOWED_DEVICE_SUBNETS: '127.0.0.0/8',
      AUDIO_AGENT_URL: `http://127.0.0.1:${upstreamPort}`,
      AUDIO_AGENT_TOKEN: 'test-audio-agent-token-with-at-least-32-characters',
      STARLINK_AGENT_URL: `http://127.0.0.1:${upstreamPort}`,
      STARLINK_AGENT_TOKEN: 'test-starlink-agent-token-with-at-least-32-characters',
      ACCOUNTING_SYNC_TOKEN: 'test-accounting-sync-token-with-at-least-32-characters',
      DESKTOP_GATEWAY_URL: `http://127.0.0.1:${upstreamPort}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    upstream.close();
    await once(upstream, 'close');
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const root = `http://127.0.0.1:${port}`;
  await waitFor(`${root}/healthz`, child, logs);

  const me = await fetch(`${root}/api/me`).then((response) => response.json());
  assert.equal(me.role, 'admin');
  assert.equal(me.displayName, 'Власник');
  assert.deepEqual(me.modules, { workshop: 'admin', service: 'admin', devices: 'admin' });

  const novncModule = await fetch(`${root}/novnc/core/rfb.js?v=1.7.0`);
  assert.equal(novncModule.status, 200);
  assert.match(novncModule.headers.get('content-type'), /javascript/);
  assert.match(await novncModule.text(), /class RFB/);

  const desktopWebsocket = await websocketHandshake(
    port,
    `127.0.0.1:${port}`,
    root,
    '/api/admin/desktop/ws'
  );
  assert.match(desktopWebsocket, /^HTTP\/1\.1 101 /, logs.join(''));
  assert.equal(upstreamUpgradeUrl, '/');
  assert.equal(upstreamUpgradeOrigin, undefined);
  assert.equal(upstreamUpgradeAuthorization, undefined);

  const crossOriginDesktop = await websocketHandshake(
    port,
    `127.0.0.1:${port}`,
    'https://attacker.example',
    '/api/admin/desktop/ws'
  );
  assert.match(crossOriginDesktop, /^HTTP\/1\.1 403 /);

  const viewerCreated = await fetch(`${root}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({
      email: 'viewer@test.local', displayName: 'Viewer', role: 'viewer', enabled: true, access: [],
      moduleAccess: { workshop: 'viewer', service: 'none', devices: 'none' }
    })
  });
  assert.equal(viewerCreated.status, 201);
  const viewerHeaders = { 'X-Dev-User-Email': 'viewer@test.local' };
  const boardAdminCreated = await fetch(`${root}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({
      email: 'workshop-admin@test.local', displayName: 'Workshop Admin', role: 'viewer', enabled: true, access: [],
      moduleAccess: { workshop: 'admin', service: 'none', devices: 'none' }
    })
  });
  assert.equal(boardAdminCreated.status, 201);
  const boardAdminHeaders = { 'X-Dev-User-Email': 'workshop-admin@test.local' };
  const viewerWorkshop = await fetch(`${root}/api/maintenance/workshop`, { headers: viewerHeaders });
  assert.equal(viewerWorkshop.status, 200);
  const viewerService = await fetch(`${root}/api/maintenance/service`, { headers: viewerHeaders });
  assert.equal(viewerService.status, 403);
  const viewerDesktop = await websocketHandshake(
    port,
    `127.0.0.1:${port}`,
    root,
    '/api/admin/desktop/ws',
    { 'X-Dev-User-Email': 'viewer@test.local' }
  );
  assert.match(viewerDesktop, /^HTTP\/1\.1 403 /);
  const viewerAdminPage = await fetch(`${root}/admin`, { headers: viewerHeaders });
  assert.equal(viewerAdminPage.status, 403);
  const boardAdminPage = await fetch(`${root}/admin?board=workshop`, { headers: boardAdminHeaders });
  assert.equal(boardAdminPage.status, 200);
  assert.match(await boardAdminPage.text(), /id="workflow-form"/);
  const boardAdminWorkshopPage = await fetch(`${root}/workshop`, { headers: boardAdminHeaders });
  assert.equal(boardAdminWorkshopPage.status, 200);
  const boardAdminWorkshopHtml = await boardAdminWorkshopPage.text();
  assert.match(boardAdminWorkshopHtml, /id="board-settings-link"/);
  assert.match(boardAdminWorkshopHtml, /id="tara-asset-filter"/);
  assert.match(boardAdminWorkshopHtml, /styles\.css\?v=0\.23\.3/);
  const iconsAsset = await fetch(`${root}/assets/icons.js`, { headers: boardAdminHeaders });
  assert.equal(iconsAsset.status, 200);
  const iconsSource = await iconsAsset.text();
  assert.match(iconsSource, /'arrow-left'/);
  assert.match(iconsSource, /'arrow-right'/);
  const boardAdminUserList = await fetch(`${root}/api/admin/users`, { headers: boardAdminHeaders });
  assert.equal(boardAdminUserList.status, 403);
  const boardAdminMe = await fetch(`${root}/api/me`, { headers: boardAdminHeaders }).then((response) => response.json());
  assert.equal(boardAdminMe.role, 'viewer');
  assert.equal(boardAdminMe.modules.workshop, 'admin');

  const audio = await fetch(`${root}/api/admin/audio`).then((response) => response.json());
  assert.equal(audio.adapter.powered, true);
  assert.equal(audio.devices[0].name, 'Test Speaker');
  assert.deepEqual(audioRequests.at(-1), {
    method: 'GET', url: '/v1/status',
    authorization: 'Bearer test-audio-agent-token-with-at-least-32-characters', body: null
  });

  const rejectedClapConfig = await fetch(`${root}/api/admin/audio/clap/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, sensitivity: 74, maxIntervalMs: 1050 })
  });
  assert.equal(rejectedClapConfig.status, 403);

  const updatedClapConfig = await fetch(`${root}/api/admin/audio/clap/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ enabled: false, sensitivity: 74, maxIntervalMs: 1050 })
  });
  assert.equal(updatedClapConfig.status, 200);
  assert.deepEqual(audioRequests.at(-1), {
    method: 'POST', url: '/v1/clap/config',
    authorization: 'Bearer test-audio-agent-token-with-at-least-32-characters',
    body: { enabled: false, sensitivity: 74, maxIntervalMs: 1050 }
  });

  const invalidClapConfig = await fetch(`${root}/api/admin/audio/clap/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ enabled: true, sensitivity: 100, maxIntervalMs: 2000 })
  });
  assert.equal(invalidClapConfig.status, 400);

  const rejectedAudioWrite = await fetch(`${root}/api/admin/audio/bluetooth/power`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false })
  });
  assert.equal(rejectedAudioWrite.status, 403);

  const poweredOff = await fetch(`${root}/api/admin/audio/bluetooth/power`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(poweredOff.status, 200);
  assert.deepEqual(audioRequests.at(-1), {
    method: 'POST', url: '/v1/bluetooth/power',
    authorization: 'Bearer test-audio-agent-token-with-at-least-32-characters', body: { enabled: false }
  });

  const invalidBluetoothAddress = await fetch(`${root}/api/admin/audio/bluetooth/devices/not-a-mac/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root }, body: '{}'
  });
  assert.equal(invalidBluetoothAddress.status, 400);

  const starlink = await fetch(`${root}/api/admin/starlink`).then((response) => response.json());
  assert.equal(starlink.connected, true);
  assert.equal(starlink.device.bypassMode, true);
  assert.equal(starlink.router.state, 'BYPASSED');
  assert.deepEqual(starlinkRequests.at(-1), {
    method: 'GET', url: '/v1/status',
    authorization: 'Bearer test-starlink-agent-token-with-at-least-32-characters', body: null
  });

  const starlinkRequestsBeforeSnowMelt = starlinkRequests.length;
  const rejectedSnowMelt = await fetch(`${root}/api/admin/starlink/snow-melt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ mode: 'ALWAYS_ON' })
  });
  assert.equal(rejectedSnowMelt.status, 403);
  assert.match((await rejectedSnowMelt.json()).error, /власник/);
  assert.equal(starlinkRequests.length, starlinkRequestsBeforeSnowMelt);

  const adminPage = await fetch(`${root}/admin`).then((response) => response.text());
  assert.match(adminPage, /id="starlink-router-tab"/);
  assert.match(adminPage, /id="clap-enabled"/);
  assert.match(adminPage, /id="clap-sensitivity"/);
  assert.match(adminPage, /id="clap-max-interval"/);
  assert.match(adminPage, /Лише власник/);
  assert.match(adminPage, /до 30 подій/);

  const rejectedStarlinkReboot = await fetch(`${root}/api/admin/starlink/reboot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true })
  });
  assert.equal(rejectedStarlinkReboot.status, 403);

  const invalidStarlinkReboot = await fetch(`${root}/api/admin/starlink/reboot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ confirm: false })
  });
  assert.equal(invalidStarlinkReboot.status, 400);

  const rebootedStarlink = await fetch(`${root}/api/admin/starlink/reboot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ confirm: true })
  });
  assert.equal(rebootedStarlink.status, 200);
  assert.deepEqual(starlinkRequests.at(-1), {
    method: 'POST', url: '/v1/reboot',
    authorization: 'Bearer test-starlink-agent-token-with-at-least-32-characters', body: { confirm: true }
  });

  const homepage = await fetch(root).then((response) => response.text());
  assert.match(homepage, /id="module-grid"/);
  assert.match(homepage, /Лабораторія/);

  const devicePage = await fetch(`${root}/devices`).then((response) => response.text());
  assert.match(devicePage, /Фільтри пристроїв/);

  const modules = await fetch(`${root}/api/modules`).then((response) => response.json());
  assert.deepEqual(modules.modules.map((module) => module.key), ['workshop', 'service', 'devices', 'erp']);

  const rejectedAccountingSync = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [] })
  });
  assert.equal(rejectedAccountingSync.status, 403);

  const accountingHeaders = {
    'Content-Type': 'application/json',
    'X-Laba-Sync-Token': 'test-accounting-sync-token-with-at-least-32-characters'
  };
  const repairRecord = {
    spreadsheetId: 'sheet-test', sheetId: 17, rowNumber: 4,
    sourceName: 'Nemesis', sheetName: 'Облік', asset: 'Nemesis',
    boardIdentifier: '014', identifiers: ['014', 'KIT-UA-NM-014'], status: 'ТЕХНІЧНІ ПРОБЛЕМИ',
    sourceComment: 'Пошкоджено верхню кришку.'
  };
  const syncedRepair = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [repairRecord] })
  });
  assert.equal(syncedRepair.status, 200);
  assert.deepEqual((await syncedRepair.json()).actions, []);

  let workshop = await fetch(`${root}/api/maintenance/workshop`).then((response) => response.json());
  assert.equal(workshop.cards.length, 1);
  assert.equal(workshop.cards[0].boardIdentifier, '014');
  assert.equal(workshop.cards[0].lane, 'new');
  assert.equal(workshop.cards[0].sourceComment, repairRecord.sourceComment);

  const updatedSourceComment = 'Потрібна повторна перевірка кріплення.';
  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ records: [{ ...repairRecord, sourceComment: updatedSourceComment }] })
  });
  workshop = await fetch(`${root}/api/maintenance/workshop`).then((response) => response.json());
  assert.equal(workshop.cards[0].sourceComment, updatedSourceComment);
  assert.equal(workshop.cards[0].notes, '');

  const movedReady = await fetch(`${root}/api/maintenance/workshop/cards/${workshop.cards[0].id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ lane: 'ready', beforeCardId: null })
  });
  assert.equal(movedReady.status, 200);
  assert.equal((await movedReady.json()).lane, 'ready');

  const syncWithAction = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [repairRecord] })
  }).then((response) => response.json());
  assert.equal(syncWithAction.actions.length, 1);
  assert.equal(syncWithAction.actions[0].targetStatus, 'НА ОБЛІТ');

  const ack = await fetch(`${root}/api/internal/accounting/ack`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ results: [{ id: syncWithAction.actions[0].id, success: true }] })
  });
  assert.equal(ack.status, 200);

  workshop = await fetch(`${root}/api/maintenance/workshop`).then((response) => response.json());
  assert.equal(workshop.cards.length, 0);

  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ records: [{ ...repairRecord, status: 'НА ОБЛІТ' }] })
  });
  workshop = await fetch(`${root}/api/maintenance/workshop`).then((response) => response.json());
  assert.equal(workshop.cards.length, 0);

  const deniedWorkflowAdmin = await fetch(`${root}/api/admin/workflows`, { headers: viewerHeaders });
  assert.equal(deniedWorkflowAdmin.status, 403);
  const workflowAdmin = await fetch(`${root}/api/admin/workflows`).then((response) => response.json());
  assert.deepEqual(workflowAdmin.boards.map((board) => board.key), ['workshop', 'service']);
  assert.equal(workflowAdmin.boards[0].entryLaneKey, 'new');
  assert.deepEqual(workflowAdmin.boards[0].sourceStatuses, ['ПОТРЕБУЄ ОГЛЯДУ', 'ТЕХНІЧНІ ПРОБЛЕМИ']);
  assert.deepEqual(workflowAdmin.boards[0].cardStatuses, []);
  assert.deepEqual(workflowAdmin.boards[0].cardLabels, []);
  assert.equal(workflowAdmin.boards[0].lanes.find((lane) => lane.key === 'ready').targetStatus, 'НА ОБЛІТ');
  assert.deepEqual(workflowAdmin.boards[1].sourceStatuses, ['ВТРАЧЕНИЙ', 'ПОТРЕБУЄ СЕРВІСУ']);

  const boardAdminWorkflowsResponse = await fetch(`${root}/api/admin/workflows`, { headers: boardAdminHeaders });
  assert.equal(boardAdminWorkflowsResponse.status, 200);
  const boardAdminWorkflows = await boardAdminWorkflowsResponse.json();
  assert.deepEqual(boardAdminWorkflows.boards.map((board) => board.key), ['workshop']);
  const ownWorkshop = boardAdminWorkflows.boards[0];
  const ownWorkshopUpdate = await fetch(`${root}/api/admin/workflows/workshop`, {
    method: 'PATCH',
    headers: {
      ...boardAdminHeaders,
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
      Origin: root
    },
    body: JSON.stringify({
      title: ownWorkshop.title,
      description: ownWorkshop.description,
      entryLaneKey: ownWorkshop.entryLaneKey,
      sourceStatuses: ownWorkshop.sourceStatuses,
      cardStatuses: ownWorkshop.cardStatuses,
      cardLabels: ownWorkshop.cardLabels,
      lanes: ownWorkshop.lanes.map(({ key, title, color, targetStatus }) => ({ key, title, color, targetStatus })),
      access: ownWorkshop.access
    })
  });
  assert.equal(ownWorkshopUpdate.status, 200);
  const foreignWorkflowUpdate = await fetch(`${root}/api/admin/workflows/service`, {
    method: 'PATCH',
    headers: {
      ...boardAdminHeaders,
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
      Origin: root
    },
    body: '{}'
  });
  assert.equal(foreignWorkflowUpdate.status, 403);

  const lostRecordAlreadyInKyiv = {
    ...repairRecord,
    rowNumber: 5,
    boardIdentifier: '019',
    identifiers: ['019', 'KIT-UA-NM-019'],
    status: 'ВТРАЧЕНИЙ',
    boardLocation: '',
    caseLocation: '  київ  '
  };
  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ records: [lostRecordAlreadyInKyiv] })
  });
  let service = await fetch(`${root}/api/maintenance/service`).then((response) => response.json());
  assert.equal(service.cards.length, 0);

  const lostRecord = {
    ...repairRecord,
    rowNumber: 6,
    boardIdentifier: '020',
    identifiers: ['020', 'KIT-UA-NM-020'],
    status: 'ВТРАЧЕНИЙ',
    boardLocation: '',
    caseLocation: 'ЛАБА'
  };
  const syncedLost = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [lostRecord] })
  });
  assert.equal(syncedLost.status, 200);
  service = await fetch(`${root}/api/maintenance/service`).then((response) => response.json());
  assert.equal(service.cards.length, 1);
  assert.equal(service.cards[0].asset, 'ТАРА');
  assert.equal(service.cards[0].boardIdentifier, '020');
  assert.equal(service.cards[0].sourceName, repairRecord.sourceName);
  assert.equal(service.cards[0].reportNumber, '');

  const reportResponse = await fetch(`${root}/api/maintenance/service/cards/${service.cards[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ notes: 'Готуємо документи.', reportNumber: 'РП-2026-020' })
  });
  assert.equal(reportResponse.status, 200);
  assert.equal((await reportResponse.json()).reportNumber, 'РП-2026-020');

  const movedLostToShipped = await fetch(`${root}/api/maintenance/service/cards/${service.cards[0].id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ lane: 'shipped', beforeCardId: null })
  });
  assert.equal(movedLostToShipped.status, 200);
  const lostLocationAction = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ records: [lostRecord] })
  }).then((response) => response.json());
  assert.equal(lostLocationAction.actions.length, 1);
  assert.equal(lostLocationAction.actions[0].actionKind, 'locations');
  assert.equal(lostLocationAction.actions[0].targetStatus, '');
  assert.equal(lostLocationAction.actions[0].targetBoardLocation, null);
  assert.equal(lostLocationAction.actions[0].targetCaseLocation, 'КИЇВ');
  await fetch(`${root}/api/internal/accounting/ack`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ results: [{ id: lostLocationAction.actions[0].id, success: true }] })
  });
  service = await fetch(`${root}/api/maintenance/service`).then((response) => response.json());
  assert.equal(service.cards.length, 0);

  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ records: [{ ...lostRecord, caseLocation: 'КИЇВ' }] })
  });
  service = await fetch(`${root}/api/maintenance/service`).then((response) => response.json());
  assert.equal(service.cards.length, 0);

  const serviceRecord = {
    ...repairRecord,
    rowNumber: 7,
    boardIdentifier: '021',
    identifiers: ['021', 'KIT-UA-NM-021'],
    status: 'ПОТРЕБУЄ СЕРВІСУ',
    boardLocation: 'ЛАБА',
    caseLocation: 'БОСТОН'
  };
  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [serviceRecord] })
  });
  service = await fetch(`${root}/api/maintenance/service`).then((response) => response.json());
  assert.equal(service.cards.length, 1);
  const movedServiceToShipped = await fetch(`${root}/api/maintenance/service/cards/${service.cards[0].id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ lane: 'shipped', beforeCardId: null })
  });
  assert.equal(movedServiceToShipped.status, 200);
  const serviceLocationAction = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [serviceRecord] })
  }).then((response) => response.json());
  assert.equal(serviceLocationAction.actions.length, 1);
  assert.equal(serviceLocationAction.actions[0].actionKind, 'locations');
  assert.equal(serviceLocationAction.actions[0].targetStatus, '');
  assert.equal(serviceLocationAction.actions[0].targetBoardLocation, 'НА РЕМОНТІ');
  assert.equal(serviceLocationAction.actions[0].targetCaseLocation, 'НА РЕМОНТІ');
  await fetch(`${root}/api/internal/accounting/ack`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ results: [{ id: serviceLocationAction.actions[0].id, success: true }] })
  });
  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders,
    body: JSON.stringify({ records: [{
      ...serviceRecord,
      boardLocation: 'НА РЕМОНТІ',
      caseLocation: 'НА РЕМОНТІ'
    }] })
  });
  service = await fetch(`${root}/api/maintenance/service`).then((response) => response.json());
  assert.equal(service.cards.length, 0);

  const workshopSettings = workflowAdmin.boards[0];
  const updatedWorkflowResponse = await fetch(`${root}/api/admin/workflows/workshop`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({
      title: 'Ремонтна майстерня',
      description: 'Керований процес ремонту.',
      entryLaneKey: 'inspection',
      sourceStatuses: ['ПОТРЕБУЄ ДІАГНОСТИКИ'],
      cardStatuses: [
        { id: null, name: 'Чекаємо запчастини', color: '#f4b942' },
        { id: null, name: 'Потрібне погодження', color: '#4f9de8' }
      ],
      cardLabels: [
        { id: null, name: 'Простий ремонт', color: '#b6ee73' },
        { id: null, name: 'Складний ремонт', color: '#f26430' }
      ],
      lanes: [
        ...workshopSettings.lanes.slice(0, 2).map(({ key, title, color, targetStatus }) => ({ key, title, color, targetStatus })),
        { key: 'quality_control', title: 'Контроль якості', color: '#36c5a8', targetStatus: '' },
        ...workshopSettings.lanes.slice(2).map(({ key, title, color, targetStatus }) => ({
          key,
          title,
          color,
          targetStatus: key === 'ready' ? 'ГОТОВО ДО ОБЛЬОТУ' : targetStatus
        }))
      ],
      access: workflowAdmin.users.map((user) => ({
        userId: user.id,
        level: user.primaryAdmin ? 'admin' : 'operator'
      }))
    })
  });
  assert.equal(updatedWorkflowResponse.status, 200);
  const updatedWorkflow = await updatedWorkflowResponse.json();
  assert.equal(updatedWorkflow.title, 'Ремонтна майстерня');
  assert.equal(updatedWorkflow.entryLaneKey, 'inspection');
  assert.equal(updatedWorkflow.lanes[2].key, 'quality_control');
  assert.equal(updatedWorkflow.lanes[2].color, '#36c5a8');
  assert.deepEqual(updatedWorkflow.cardStatuses.map(({ name, color }) => ({ name, color })), [
    { name: 'Чекаємо запчастини', color: '#f4b942' },
    { name: 'Потрібне погодження', color: '#4f9de8' }
  ]);
  assert.ok(updatedWorkflow.cardStatuses.every((status) => Number.isInteger(status.id)));
  assert.deepEqual(updatedWorkflow.cardLabels.map(({ name, color }) => ({ name, color })), [
    { name: 'Простий ремонт', color: '#b6ee73' },
    { name: 'Складний ремонт', color: '#f26430' }
  ]);
  assert.ok(updatedWorkflow.cardLabels.every((label) => Number.isInteger(label.id)));
  const viewerWorkflowUser = workflowAdmin.users.find((user) => user.email === 'viewer@test.local');
  assert.equal(updatedWorkflow.access.find((grant) => grant.userId === viewerWorkflowUser.id).level, 'operator');

  const collisionResponse = await fetch(`${root}/api/admin/workflows/service`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({
      title: workflowAdmin.boards[1].title,
      description: workflowAdmin.boards[1].description,
      entryLaneKey: workflowAdmin.boards[1].entryLaneKey,
      sourceStatuses: ['ПОТРЕБУЄ ДІАГНОСТИКИ'],
      lanes: workflowAdmin.boards[1].lanes.map(({ key, title, color, targetStatus }) => ({ key, title, color, targetStatus })),
      access: workflowAdmin.boards[1].access
    })
  });
  assert.equal(collisionResponse.status, 409);

  const diagnosisRecord = {
    ...repairRecord,
    rowNumber: 5,
    boardIdentifier: '015',
    identifiers: ['015', 'KIT-UA-NM-015'],
    status: 'ПОТРЕБУЄ ДІАГНОСТИКИ'
  };
  await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [diagnosisRecord] })
  });
  workshop = await fetch(`${root}/api/maintenance/workshop`).then((response) => response.json());
  assert.equal(workshop.title, 'Ремонтна майстерня');
  assert.equal(workshop.cards.length, 1);
  assert.equal(workshop.cards[0].lane, 'inspection');
  assert.equal(workshop.lanes[2].key, 'quality_control');
  assert.equal(workshop.cardStatuses.length, 2);
  assert.equal(workshop.cardLabels.length, 2);

  const updatedCardResponse = await fetch(`${root}/api/maintenance/workshop/cards/${workshop.cards[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({
      notes: 'Очікуємо постачання.',
      cardStatusIds: updatedWorkflow.cardStatuses.map((status) => status.id),
      cardLabelIds: updatedWorkflow.cardLabels.map((label) => label.id)
    })
  });
  assert.equal(updatedCardResponse.status, 200);
  const updatedCard = await updatedCardResponse.json();
  assert.equal(updatedCard.notes, 'Очікуємо постачання.');
  assert.deepEqual(updatedCard.cardStatuses.map((status) => status.name), ['Чекаємо запчастини', 'Потрібне погодження']);
  assert.deepEqual(updatedCard.cardLabels.map((label) => label.name), ['Простий ремонт', 'Складний ремонт']);

  const invalidCardStatus = await fetch(`${root}/api/maintenance/workshop/cards/${workshop.cards[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ notes: updatedCard.notes, cardStatusIds: [999999] })
  });
  assert.equal(invalidCardStatus.status, 400);

  const invalidCardLabel = await fetch(`${root}/api/maintenance/workshop/cards/${workshop.cards[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ notes: updatedCard.notes, cardLabelIds: [999999] })
  });
  assert.equal(invalidCardLabel.status, 400);

  await fetch(`${root}/api/maintenance/workshop/cards/${workshop.cards[0].id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({ lane: 'ready', beforeCardId: null })
  });
  const customStatusAction = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [diagnosisRecord] })
  }).then((response) => response.json());
  assert.equal(customStatusAction.actions.length, 1);
  assert.equal(customStatusAction.actions.at(-1).targetStatus, 'ГОТОВО ДО ОБЛЬОТУ');

  const remappedWorkflowResponse = await fetch(`${root}/api/admin/workflows/workshop`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1', Origin: root },
    body: JSON.stringify({
      title: updatedWorkflow.title,
      description: updatedWorkflow.description,
      entryLaneKey: updatedWorkflow.entryLaneKey,
      sourceStatuses: updatedWorkflow.sourceStatuses,
      cardStatuses: updatedWorkflow.cardStatuses.slice(0, 1).map((status) => ({
        id: status.id,
        name: 'Очікуємо запчастини',
        color: status.color
      })),
      cardLabels: updatedWorkflow.cardLabels.slice(0, 1).map((label) => ({
        id: label.id,
        name: 'Середній ремонт',
        color: '#f4b942'
      })),
      lanes: updatedWorkflow.lanes.map(({ key, title, color, targetStatus }) => ({
        key,
        title,
        color,
        targetStatus: key === 'ready' ? 'ПЕРЕВІРЕНО' : targetStatus
      })),
      access: updatedWorkflow.access
    })
  });
  assert.equal(remappedWorkflowResponse.status, 200);
  const cardAfterStatusSettings = await fetch(`${root}/api/maintenance/workshop`).then((response) => response.json());
  assert.deepEqual(cardAfterStatusSettings.cards[0].cardStatuses.map((status) => status.name), ['Очікуємо запчастини']);
  assert.deepEqual(cardAfterStatusSettings.cards[0].cardLabels.map((label) => label.name), ['Середній ремонт']);
  const remappedActions = await fetch(`${root}/api/internal/accounting/sync`, {
    method: 'POST', headers: accountingHeaders, body: JSON.stringify({ records: [diagnosisRecord] })
  }).then((response) => response.json());
  assert.equal(remappedActions.actions.length, 1);
  assert.equal(remappedActions.actions[0].targetStatus, 'ПЕРЕВІРЕНО');

  const devices = await fetch(`${root}/api/devices`).then((response) => response.json());
  assert.equal(devices.length, 1);
  assert.equal(devices[0].slug, 'k1se-01');
  assert.equal(devices[0].notes, 'Перший принтер лабораторії');
  assert.equal(devices[0].proxyUrl, 'https://k1se-01-laba.zpseapil.club/');

  const rejected = await fetch(`${root}/api/admin/devices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(rejected.status, 403);

  const created = await fetch(`${root}/api/admin/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
      Origin: root
    },
    body: JSON.stringify({
      slug: 'camera-01', name: 'Camera 01', kind: 'camera', driver: 'http',
      host: '127.0.0.1', protocol: 'http', uiPort: upstreamPort, apiPort: null,
      notes: '', enabled: true, sortOrder: 20
    })
  });
  assert.equal(created.status, 201);
  const createdDevice = await created.json();

  const proxiedAsset = await fetch(`${root}/assets/device.js`, {
    headers: { 'X-Forwarded-Host': 'camera-01-laba.zpseapil.club' }
  });
  assert.equal(proxiedAsset.status, 200);
  assert.equal(await proxiedAsset.text(), 'window.deviceAsset = "/assets/device.js";');

  const websocketHost = 'camera-01-laba.zpseapil.club';
  const websocketResponse = await websocketHandshake(port, websocketHost, `http://${websocketHost}`);
  assert.match(websocketResponse, /^HTTP\/1\.1 101 /, logs.join(''));
  assert.equal(upstreamUpgradeOrigin, `http://127.0.0.1:${upstreamPort}`);

  const rejectedWebsocket = await websocketHandshake(port, websocketHost, 'https://attacker.example');
  assert.match(rejectedWebsocket, /^HTTP\/1\.1 403 /);

  const gatewayCreated = await fetch(`${root}/api/admin/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
      Origin: root
    },
    body: JSON.stringify({
      slug: 'camera-live', name: 'Camera Live', kind: 'camera', driver: 'http',
      host: '127.0.0.1', protocol: 'http', uiPort: upstreamPort, apiPort: null,
      streamName: 'camera-main',
      streamMode: 'mjpeg', parentDeviceId: devices[0].id,
      secret: JSON.stringify({ username: 'gateway-user', password: 'gateway-pass' }),
      notes: '', enabled: true, sortOrder: 30
    })
  });
  assert.equal(gatewayCreated.status, 201);
  const gatewayDevice = await gatewayCreated.json();
  assert.equal(gatewayDevice.streamName, 'camera-main');
  assert.equal(gatewayDevice.streamMode, 'mjpeg');
  assert.equal(gatewayDevice.parentDeviceId, devices[0].id);

  const invalidParent = await fetch(`${root}/api/admin/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
      Origin: root
    },
    body: JSON.stringify({
      slug: 'camera-orphan', name: 'Camera Orphan', kind: 'camera', driver: 'http',
      host: '127.0.0.1', protocol: 'http', uiPort: upstreamPort, apiPort: null,
      parentDeviceId: 999999, notes: '', enabled: true, sortOrder: 40
    })
  });
  assert.equal(invalidParent.status, 400);

  const gatewayHost = 'camera-live-laba.zpseapil.club';
  const cameraPage = await fetch(root, { headers: { 'X-Forwarded-Host': gatewayHost } });
  assert.equal(cameraPage.status, 200);
  assert.match(cameraPage.headers.get('content-security-policy'), /media-src 'self' data: blob:/);
  assert.match(cameraPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(cameraPage.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(await cameraPage.text(), /ЗАХИЩЕНИЙ ПЕРЕГЛЯД/);

  const cameraAsset = await fetch(`${root}/assets/camera.js`, {
    headers: { 'X-Forwarded-Host': gatewayHost }
  });
  assert.equal(cameraAsset.status, 200);
  assert.match(await cameraAsset.text(), /gatewayPath.*\/ws/);

  const gatewayMeta = await fetch(`${root}/gateway/meta`, {
    headers: { 'X-Forwarded-Host': gatewayHost }
  });
  assert.deepEqual(await gatewayMeta.json(), {
    name: 'Camera Live',
    portalUrl: 'https://laba.zpseapil.club/',
    modes: 'mjpeg'
  });

  const linkedStream = await fetch(`${root}/laba-camera/stream`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(linkedStream.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/api/stream.mjpeg?src=camera-main',
    authorization: `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  });

  const linkedSnapshot = await fetch(`${root}/laba-camera/snapshot?cache-bust=1`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(linkedSnapshot.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/api/frame.jpeg?src=camera-main',
    authorization: `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  });

  const embeddedPlayer = await fetch(`${root}/webcam/laba/player`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(embeddedPlayer.status, 200);
  assert.match(embeddedPlayer.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(await embeddedPlayer.text(), /camera-player/);

  const embeddedCameraAsset = await fetch(`${root}/assets/camera.js`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(embeddedCameraAsset.status, 200);
  assert.match(await embeddedCameraAsset.text(), /gatewayPath.*\/ws/);

  const embeddedMeta = await fetch(`${root}/webcam/laba/meta`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.deepEqual(await embeddedMeta.json(), {
    name: 'Camera Live',
    portalUrl: 'https://laba.zpseapil.club/',
    modes: 'mjpeg'
  });

  const linkedHlsMaster = await fetch(`${root}/laba-camera/api/stream.m3u8?src=attacker-controlled`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(linkedHlsMaster.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/api/stream.m3u8?src=camera-main&mp4',
    authorization: `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  });

  const linkedHlsPlaylist = await fetch(`${root}/laba-camera/api/hls/playlist.m3u8?id=session-1`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(linkedHlsPlaylist.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/api/hls/playlist.m3u8?id=session-1',
    authorization: `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  });

  const linkedHlsSegment = await fetch(`${root}/laba-camera/api/hls/segment.ts?id=session-1&n=4`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(linkedHlsSegment.status, 200);
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/api/hls/segment.ts?id=session-1&n=4',
    authorization: `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  });

  const upstreamCountBeforeInvalidPrinterHls = upstreamRequests.length;
  const invalidPrinterHls = await fetch(`${root}/laba-camera/api/hls/segment.ts?id=session-1&n=4&src=other`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(invalidPrinterHls.status, 400);
  assert.equal(upstreamRequests.length, upstreamCountBeforeInvalidPrinterHls);

  const upstreamCountBeforeBlockedApi = upstreamRequests.length;
  const blockedGatewayApi = await fetch(`${root}/api/streams`, {
    headers: { 'X-Forwarded-Host': gatewayHost }
  });
  assert.equal(blockedGatewayApi.status, 404);
  assert.equal(upstreamRequests.length, upstreamCountBeforeBlockedApi);

  const hls = await fetch(`${root}/gateway/hls/playlist.m3u8?id=session-1`, {
    headers: { 'X-Forwarded-Host': gatewayHost }
  });
  assert.equal(hls.status, 200);
  assert.equal(await hls.text(), '#EXTM3U\n');
  assert.deepEqual(upstreamRequests.at(-1), {
    url: '/api/hls/playlist.m3u8?id=session-1',
    authorization: `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  });
  assert.equal(hls.headers.get('cache-control'), 'no-store');

  const upstreamCountBeforeInvalidHls = upstreamRequests.length;
  const invalidHls = await fetch(`${root}/gateway/hls/private.m3u8?id=session-1`, {
    headers: { 'X-Forwarded-Host': gatewayHost }
  });
  assert.equal(invalidHls.status, 404);
  assert.equal(upstreamRequests.length, upstreamCountBeforeInvalidHls);

  const printerCameraWebsocket = await websocketHandshake(
    port,
    'k1se-01-laba.zpseapil.club',
    'http://k1se-01-laba.zpseapil.club',
    '/webcam/laba/ws?src=attacker-controlled'
  );
  assert.match(printerCameraWebsocket, /^HTTP\/1\.1 101 /, logs.join(''));
  assert.equal(upstreamUpgradeUrl, '/api/ws?src=camera-main');
  assert.equal(upstreamUpgradeOrigin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(
    upstreamUpgradeAuthorization,
    `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  );

  const gatewayWebsocket = await websocketHandshake(
    port,
    gatewayHost,
    `http://${gatewayHost}`,
    '/gateway/ws?src=attacker-controlled'
  );
  assert.match(gatewayWebsocket, /^HTTP\/1\.1 101 /, logs.join(''));
  assert.equal(upstreamUpgradeUrl, '/api/ws?src=camera-main');
  assert.equal(upstreamUpgradeOrigin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(
    upstreamUpgradeAuthorization,
    `Basic ${Buffer.from('gateway-user:gateway-pass').toString('base64')}`
  );

  const blockedGatewayWebsocket = await websocketHandshake(
    port,
    gatewayHost,
    `http://${gatewayHost}`,
    '/api/ws?src=camera-main'
  );
  assert.match(blockedGatewayWebsocket, /^HTTP\/1\.1 403 /);

  const disabled = await fetch(`${root}/api/admin/devices/${createdDevice.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
      Origin: root
    },
    body: JSON.stringify({
      slug: 'camera-01', name: 'Camera 01', kind: 'camera', driver: 'http',
      host: '127.0.0.1', protocol: 'http', uiPort: upstreamPort, apiPort: null,
      notes: '', enabled: false, sortOrder: 20
    })
  });
  assert.equal(disabled.status, 200);

  const disabledProxy = await fetch(`${root}/assets/device.js`, {
    headers: { 'X-Forwarded-Host': 'camera-01-laba.zpseapil.club' }
  });
  assert.equal(disabledProxy.status, 404);
});
