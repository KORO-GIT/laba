import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.mjs';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('printer', 'camera')),
    driver TEXT NOT NULL CHECK (driver IN ('moonraker', 'octoprint', 'http', 'rtsp')),
    host TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'http' CHECK (protocol IN ('http', 'https', 'rtsp')),
    ui_port INTEGER NOT NULL,
    api_port INTEGER,
    stream_name TEXT,
    secret_enc TEXT,
    notes TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_device_access (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    access_level TEXT NOT NULL CHECK (access_level IN ('viewer', 'operator')),
    PRIMARY KEY (user_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_devices_enabled ON devices(enabled, sort_order);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`);

const deviceColumns = new Set(db.pragma('table_info(devices)').map((column) => column.name));
if (!deviceColumns.has('stream_name')) {
  db.exec('ALTER TABLE devices ADD COLUMN stream_name TEXT');
}

const bootstrap = db.prepare('SELECT id FROM users WHERE email = ?').get(config.bootstrapAdminEmail);
if (!bootstrap) {
  db.prepare(`
    INSERT INTO users (email, display_name, role, enabled)
    VALUES (?, ?, 'admin', 1)
  `).run(config.bootstrapAdminEmail, 'Власник');
}

// Translate only the original seeded values; never overwrite user-customized data.
db.prepare(`
  UPDATE users SET display_name = 'Власник', updated_at = CURRENT_TIMESTAMP
  WHERE email = ? COLLATE NOCASE AND display_name = 'Владелец'
`).run(config.bootstrapAdminEmail);

const deviceCount = db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
if (deviceCount === 0) {
  db.prepare(`
    INSERT INTO devices
      (slug, name, kind, driver, host, protocol, ui_port, api_port, notes, enabled, sort_order)
    VALUES
      ('k1se-01', 'Creality K1 SE', 'printer', 'moonraker', '192.168.0.70', 'http', 80, 7125, 'Перший принтер лабораторії', 1, 10)
  `).run();
}

db.prepare(`
  UPDATE devices SET notes = 'Перший принтер лабораторії', updated_at = CURRENT_TIMESTAMP
  WHERE slug = 'k1se-01' COLLATE NOCASE AND notes = 'Первый принтер лаборатории'
`).run();

export const statements = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  touchUserLogin: db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?"),
  listUsers: db.prepare(`
    SELECT u.*, COALESCE(GROUP_CONCAT(a.device_id || ':' || a.access_level), '') AS access_map
    FROM users u
    LEFT JOIN user_device_access a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, u.email
  `),
  listDevices: db.prepare('SELECT * FROM devices ORDER BY sort_order, name'),
  deviceById: db.prepare('SELECT * FROM devices WHERE id = ?'),
  deviceBySlug: db.prepare('SELECT * FROM devices WHERE slug = ? COLLATE NOCASE AND enabled = 1'),
  accessForUser: db.prepare(`
    SELECT a.device_id, a.access_level
    FROM user_device_access a
    WHERE a.user_id = ?
  `),
  accessForUserAndDevice: db.prepare(`
    SELECT access_level FROM user_device_access WHERE user_id = ? AND device_id = ?
  `),
  listAudit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
  insertAudit: db.prepare(`
    INSERT INTO audit_log (actor_email, action, entity_type, entity_id, details_json)
    VALUES (?, ?, ?, ?, ?)
  `)
};

export function audit(actorEmail, action, entityType, entityId, details = {}) {
  statements.insertAudit.run(
    actorEmail,
    action,
    entityType,
    entityId == null ? null : String(entityId),
    JSON.stringify(details)
  );
}

export function serializeUser(row) {
  const access = String(row.access_map ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [deviceId, level] = entry.split(':');
      return { deviceId: Number(deviceId), level };
    });

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    access
  };
}

export function serializeDevice(row, includePrivate = false) {
  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    driver: row.driver,
    enabled: Boolean(row.enabled),
    notes: row.notes,
    sortOrder: row.sort_order
  };

  if (includePrivate) {
    Object.assign(base, {
      host: row.host,
      protocol: row.protocol,
      uiPort: row.ui_port,
      apiPort: row.api_port,
      streamName: row.stream_name ?? '',
      hasSecret: Boolean(row.secret_enc)
    });
  }

  return base;
}
