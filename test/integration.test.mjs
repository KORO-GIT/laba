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

function websocketHandshake(port, host, origin, requestPath = '/websocket') {
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
  const upstream = http.createServer((request, response) => {
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
      ALLOWED_DEVICE_SUBNETS: '127.0.0.0/8'
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

  const homepage = await fetch(root).then((response) => response.text());
  assert.match(homepage, /Фільтри пристроїв/);
  assert.doesNotMatch(homepage, /Уся лабораторія/);

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

  const embeddedPlayer = await fetch(`${root}/laba-camera/player`, {
    headers: { 'X-Forwarded-Host': 'k1se-01-laba.zpseapil.club' }
  });
  assert.equal(embeddedPlayer.status, 200);
  assert.match(embeddedPlayer.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(await embeddedPlayer.text(), /camera-player/);

  const embeddedMeta = await fetch(`${root}/laba-camera/meta`, {
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
    '/laba-camera/ws?src=attacker-controlled'
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
