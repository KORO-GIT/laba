import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(`window.deviceAsset = ${JSON.stringify(request.url)};`);
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

  const devices = await fetch(`${root}/api/devices`).then((response) => response.json());
  assert.equal(devices.length, 1);
  assert.equal(devices[0].slug, 'k1se-01');
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
