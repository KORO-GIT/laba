// Synthetic localhost records only; production is never contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base = 'http://127.0.0.1:8093';
try { await fetch(`${base}/healthz`); throw Error('Port 8093 occupied'); }
catch (error) { if (error.message.includes('occupied')) throw error; }
const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'laba-sync-browser-'));
const token = 'synthetic-browser-accounting-token-at-least-32-characters';
const server = spawn(process.execPath, ['src/server.mjs'], {
  stdio: 'ignore', windowsHide: true,
  env: { ...process.env, AUTH_MODE: 'development', NODE_ENV: 'test', PORT: '8093',
    DB_PATH: path.join(directory, 'test.db'), BOOTSTRAP_ADMIN_EMAIL: 'admin@local.test',
    DEV_USER_EMAIL: 'admin@local.test', ACCOUNTING_SYNC_TOKEN: token }
});
let browser;
const errors = [];
const record = { spreadsheetId: 'synthetic', sheetId: 1, rowNumber: 2,
  sourceName: 'Тестовий засіб', sheetName: 'Облік', asset: 'Тестовий засіб',
  boardIdentifier: 'TEST-001', identifiers: ['TEST-001'], status: 'ПОТРЕБУЄ СЕРВІСУ',
  caseLocation: 'ЛАБА', sourceComment: 'Перевірка синхронізації' };
async function sync(boardLocation, extra = {}, pending = false) {
  const response = await fetch(`${base}/api/internal/accounting/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Laba-Sync-Token': token },
    body: JSON.stringify({ records: [{ ...record, boardLocation, ...extra }] })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  if (!pending) assert.deepEqual(payload.actions, []);
  return payload;
}
try {
  let ready = false;
  for (let n = 0; n < 300; n++) {
    if (server.exitCode !== null) throw Error('Local server exited');
    try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  await sync('ЛАБА');
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await page.goto(`${base}/service`);
  await page.locator('[data-lane="new"] .maintenance-card').waitFor();
  await sync('КИЇВ');
  await page.locator('[data-lane="shipped"] .maintenance-card').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('[data-lane="new"] .maintenance-card').count(), 0);
  assert.equal(navigations, 1);
  await page.locator('[data-lane="shipped"] .maintenance-card').click();
  await page.locator('#card-history').getByText('Облік', { exact: true }).waitFor();
  fs.mkdirSync(path.resolve('data'), { recursive: true });
  await page.screenshot({ path: path.resolve('data/maintenance-sync-desktop.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await sync('ЛАБА');
  await page.locator('[data-lane="new"] .maintenance-card').waitFor({ timeout: 15000 });
  assert.equal(navigations, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.resolve('data/maintenance-sync-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sync('КИЇВ');
  await page.locator('[data-lane="shipped"] .maintenance-card').waitFor({ timeout: 15000 });
  const returnedLane = page.locator('[data-lane="returned"]');
  await returnedLane.scrollIntoViewIfNeeded();
  const start = await page.locator('[data-lane="shipped"] .maintenance-card').boundingBox();
  const end = await returnedLane.locator('.maintenance-list').boundingBox();
  assert.ok(start && end);
  const moved = page.waitForResponse(response => response.url().endsWith('/move') && response.request().method() === 'POST');
  await page.mouse.move(start.x + start.width / 2, start.y + 30);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + 25, { steps: 15 });
  await page.mouse.up();
  assert.equal((await moved).status(), 200);
  const action = (await sync('КИЇВ', {}, true)).actions[0];
  assert.equal(action.actionKind, 'service_return');
  const comment = `${record.sourceComment}\n${action.commentAppend}`;
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/maintenance/service') && response.status() === 200);
  await sync('ЛАБА', { status: 'ПОТРЕБУЄ ОГЛЯДУ', sourceComment: comment });
  await refreshed;
  await returnedLane.locator('.maintenance-card').waitFor({ timeout: 15000 });
  await returnedLane.locator('.maintenance-card').click();
  await page.locator('#card-details').getByText(comment, { exact: true }).waitFor();
  assert.equal(navigations, 1);
  await page.screenshot({ path: path.resolve('data/service-return-desktop.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await returnedLane.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.resolve('data/service-return-mobile.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Service sync browser: shipment, return drag, comment, history, desktop/mobile, no reload: OK');
} finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
