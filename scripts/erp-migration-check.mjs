// Read the source only; run migrations on a disposable SQLite backup, never on production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateErp } from '../src/erp-database.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/erp-migration-check.mjs /absolute/path/to/source.db');
const sourcePath = fs.realpathSync(process.argv[2]);
const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'laba-erp-migration-'));
fs.chmodSync(directory, 0o700);
const copyPath = path.join(directory, 'check.db');
let source;
let copy;
try {
  source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  await source.backup(copyPath);
  source.close();
  source = null;
  copy = new Database(copyPath);
  copy.pragma('foreign_keys=ON');
  const tables = copy.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'erp_%' AND name!='schema_migrations' ORDER BY name").all();
  function digest(table) {
    const hashes = [];
    const name = table.name.replaceAll('"', '""');
    for (const row of copy.prepare(`SELECT * FROM "${name}"`).safeIntegers().iterate()) {
      const json = JSON.stringify(row, (_, value) => typeof value === 'bigint' ? `${value}n` : value);
      hashes.push(crypto.createHash('sha256').update(json).digest('hex'));
    }
    return crypto.createHash('sha256').update(hashes.sort().join('\n')).digest('hex');
  }
  const before = tables.map(digest);
  const previousMigrations = copy.prepare("SELECT * FROM schema_migrations WHERE name!='erp_v1' ORDER BY name").all();
  migrateErp(copy);
  migrateErp(copy);
  assert.deepEqual(copy.pragma('quick_check'), [{ quick_check: 'ok' }]);
  assert.deepEqual(copy.pragma('foreign_key_check'), []);
  assert.deepEqual(tables.map(digest), before, 'Existing table contents changed');
  for (const table of tables) assert.equal(copy.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table.name).sql, table.sql);
  assert.deepEqual(copy.prepare("SELECT * FROM schema_migrations WHERE name!='erp_v1' ORDER BY name").all(), previousMigrations);
  console.log(JSON.stringify({ ok: true, sourceOpenedReadOnly: true, existingTablesPreserved: tables.length, migrationRuns: 2, quickCheck: 'ok', foreignKeys: 'ok' }));
} finally {
  copy?.close();
  source?.close();
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert.ok(path.basename(resolved).startsWith('laba-erp-migration-'));
  fs.rmSync(resolved, { recursive: true });
}
