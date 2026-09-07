// Synthetic, in-memory smoke: no connection to production or external systems.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createErp } from '../src/erp-database.mjs';

const db = new Database(':memory:');
try {
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,display_name TEXT,role TEXT,enabled INTEGER DEFAULT 1);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
    INSERT INTO users VALUES(1,'owner@example.test','Owner','admin',1);`);
  const erp = createErp(db);
  const admin = db.prepare('SELECT * FROM users WHERE id=1').get();
  const client = erp.createClient(admin, { name: 'Synthetic only', contact: '', notes: '' });
  for (let id = 2; id <= 21; id++) {
    db.prepare("INSERT INTO users VALUES(?,?,?,'viewer',1)").run(id, `worker-${id}@example.test`, `Worker ${id}`);
    db.prepare("INSERT INTO erp_members VALUES(?,'technician')").run(id);
  }
  const started = performance.now();
  for (let batch = 0; batch < 20; batch++) {
    const body = { clientId: client.id, title: `Batch ${batch}`, model: 'Test', kind: 'service', priority: 'normal', dueDate: null, notes: '', reference: 'Synthetic', unnumbered: 150, serials: [], steps: Array.from({ length: 3 }, (_, n) => ({ title: `Step ${n}`, instructions: '', plannedMinutes: 10 })) };
    const order = erp.command(admin, crypto.randomUUID(), 'orders', body, () => erp.createOrder(admin, body));
    db.prepare('UPDATE erp_tasks SET assigned_to=? WHERE unit_id IN (SELECT id FROM erp_units WHERE order_id=?)').run(batch + 2, order.id);
  }
  const setupMs = Math.round(performance.now() - started);
  const technician = db.prepare('SELECT * FROM users WHERE id=2').get();
  const timings = (user) => {
    const samples = [];
    for (let n = 0; n < 40; n++) {
      const start = performance.now();
      erp.snapshot(user, { taskState: 'open', page: 0 });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { medianMs: Math.round(samples[20]), p95Ms: Math.round(samples[37]) };
  };
  const owner = timings(admin);
  const worker = timings(technician);
  assert.equal(erp.snapshot(technician).myTaskCount, 450);
  assert.ok(Math.max(owner.p95Ms, worker.p95Ms) < 2000, 'Synthetic read smoke exceeded 2 seconds');
  console.log(JSON.stringify({ ok: true, units: 3000, tasks: 9000, technicians: 20, setupMs, owner, worker, scope: 'in-memory read smoke; not concurrent load or capacity guarantee' }));
} finally { db.close(); }
