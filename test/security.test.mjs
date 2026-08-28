import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  isAllowedDeviceHost,
  requireSameOrigin,
  safeSlug,
  safeStreamName
} from '../src/security.mjs';

test('device slugs accept only safe DNS labels', () => {
  assert.equal(safeSlug('k1se-01'), true);
  assert.equal(safeSlug('-camera'), false);
  assert.equal(safeSlug('camera.example'), false);
  assert.equal(safeSlug('Камера'), false);
  assert.equal(safeSlug('a'.repeat(58)), true);
  assert.equal(safeSlug('a'.repeat(59)), false);
});

test('go2rtc stream names cannot alter paths or query strings', () => {
  assert.equal(safeStreamName('camera-01.main'), true);
  assert.equal(safeStreamName('camera_01'), true);
  assert.equal(safeStreamName('../api/config'), false);
  assert.equal(safeStreamName('camera?src=other'), false);
  assert.equal(safeStreamName('a'.repeat(128)), true);
  assert.equal(safeStreamName('a'.repeat(129)), false);
});

test('device hosts stay inside configured private subnet', () => {
  assert.equal(isAllowedDeviceHost('192.168.0.70'), true);
  assert.equal(isAllowedDeviceHost('192.168.1.70'), false);
  assert.equal(isAllowedDeviceHost('127.0.0.1'), false);
  assert.equal(isAllowedDeviceHost('example.com'), false);
});

test('device secrets round-trip through authenticated encryption', () => {
  const original = JSON.stringify({ username: 'lab', password: 'not-a-real-secret' });
  const encrypted = encryptSecret(original);
  assert.notEqual(encrypted, original);
  assert.equal(decryptSecret(encrypted), original);
  const parts = encrypted.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  assert.throws(() => decryptSecret(parts.join('.')));
});

test('same-origin check rejects a different origin', () => {
  assert.doesNotThrow(() => requireSameOrigin({ headers: { origin: 'https://laba.example', host: 'laba.example' } }));
  assert.throws(() => requireSameOrigin({ headers: { origin: 'https://evil.example', host: 'laba.example' } }));
});
