import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  isAllowedDeviceHost,
  requireSameOrigin,
  safeSlug
} from '../src/security.mjs';

test('device slugs accept only safe DNS labels', () => {
  assert.equal(safeSlug('k1se-01'), true);
  assert.equal(safeSlug('-camera'), false);
  assert.equal(safeSlug('camera.example'), false);
  assert.equal(safeSlug('Камера'), false);
  assert.equal(safeSlug('a'.repeat(58)), true);
  assert.equal(safeSlug('a'.repeat(59)), false);
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
  assert.throws(() => decryptSecret(`${encrypted.slice(0, -1)}x`));
});

test('same-origin check rejects a different origin', () => {
  assert.doesNotThrow(() => requireSameOrigin({ headers: { origin: 'https://laba.example', host: 'laba.example' } }));
  assert.throws(() => requireSameOrigin({ headers: { origin: 'https://evil.example', host: 'laba.example' } }));
});
