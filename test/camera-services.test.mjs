import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readUnit = (name) => readFile(new URL(`../deploy/go2rtc/${name}`, import.meta.url), 'utf8');

test('USB capture retries until a late camera becomes available', async () => {
  const unit = await readUnit('laba-ustreamer.service');

  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test('camera gateway remains available when the USB camera appears late', async () => {
  const unit = await readUnit('go2rtc.service');

  assert.match(unit, /^After=.*tailscaled\.service$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /^Requires=.*laba-ustreamer\.service.*$/m);
  assert.doesNotMatch(unit, /^After=.*laba-ustreamer\.service.*$/m);
});

test('H.264 encoder retries without a hard USB service dependency', async () => {
  const unit = await readUnit('laba-h264-encoder.service');

  assert.match(unit, /^After=.*laba-ustreamer\.service$/m);
  assert.match(unit, /^Wants=.*laba-ustreamer\.service$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /^Requires=.*laba-ustreamer\.service.*$/m);
});
