import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.mjs';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const defaultWorkflows = [
  {
    module: 'workshop',
    title: 'Майстерня',
    description: 'Огляд, ремонт і підготовка бортів до обльоту.',
    entryLaneKey: 'new',
    sourceStatuses: ['ПОТРЕБУЄ ОГЛЯДУ', 'ТЕХНІЧНІ ПРОБЛЕМИ'],
    lanes: [
      ['new', 'Нові', '#f26430', 10, null],
      ['inspection', 'На огляді', '#f4b942', 20, null],
      ['repair', 'У ремонті', '#4f9de8', 30, null],
      ['postponed', 'Відкладено', '#9b9c93', 40, null],
      ['ready', 'Готово', '#b6ee73', 50, 'НА ОБЛІТ']
    ]
  },
  {
    module: 'service',
    title: 'Сервіс',
    description: 'Підготовка документів і відправлення на гарантійний сервіс.',
    entryLaneKey: 'new',
    sourceStatuses: ['ПОТРЕБУЄ СЕРВІСУ', 'ВТРАЧЕНИЙ'],
    lanes: [
      ['new', 'Нові', '#f26430', 10, null],
      ['documents_preparing', 'Готуються документи', '#f4b942', 20, null],
      ['documents_submitted', 'Документи подано', '#4f9de8', 30, null],
      ['awaiting_shipment', 'Очікує відправлення', '#bb86fc', 40, null],
      ['shipped', 'Відправлено', '#b6ee73', 50, null]
    ]
  }
];

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
    stream_mode TEXT NOT NULL DEFAULT 'auto' CHECK (stream_mode IN ('auto', 'mjpeg')),
    parent_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
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

  CREATE TABLE IF NOT EXISTS user_module_access (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module TEXT NOT NULL CHECK (module IN ('workshop', 'service', 'devices')),
    access_level TEXT NOT NULL CHECK (access_level IN ('viewer', 'operator', 'admin')),
    PRIMARY KEY (user_id, module)
  );

  CREATE TABLE IF NOT EXISTS workflow_boards (
    module TEXT PRIMARY KEY CHECK (module IN ('workshop', 'service')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    entry_lane_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_lanes (
    module TEXT NOT NULL REFERENCES workflow_boards(module) ON DELETE CASCADE,
    lane_key TEXT NOT NULL,
    title TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#f26430',
    sort_order INTEGER NOT NULL DEFAULT 0,
    target_status TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (module, lane_key)
  );

  CREATE TABLE IF NOT EXISTS workflow_source_statuses (
    normalized_status TEXT PRIMARY KEY,
    display_status TEXT NOT NULL,
    module TEXT NOT NULL REFERENCES workflow_boards(module) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_card_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL REFERENCES workflow_boards(module) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#f4b942',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (module, normalized_name)
  );

  CREATE TABLE IF NOT EXISTS workflow_card_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL REFERENCES workflow_boards(module) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f9de8',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (module, normalized_name)
  );

  CREATE TABLE IF NOT EXISTS maintenance_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL CHECK (module IN ('workshop', 'service')),
    source_key TEXT NOT NULL,
    source_spreadsheet_id TEXT NOT NULL,
    source_sheet_id INTEGER NOT NULL,
    source_row_number INTEGER NOT NULL,
    source_name TEXT NOT NULL,
    source_sheet_name TEXT NOT NULL,
    asset TEXT NOT NULL,
    board_identifier TEXT NOT NULL,
    identifiers_json TEXT NOT NULL DEFAULT '[]',
    source_status TEXT NOT NULL,
    source_comment TEXT NOT NULL DEFAULT '',
    source_board_location TEXT,
    source_case_location TEXT,
    lane TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    report_number TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (module, source_key)
  );

  CREATE TABLE IF NOT EXISTS maintenance_card_status_assignments (
    card_id INTEGER NOT NULL REFERENCES maintenance_cards(id) ON DELETE CASCADE,
    status_id INTEGER NOT NULL REFERENCES workflow_card_statuses(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (card_id, status_id)
  );

  CREATE TABLE IF NOT EXISTS maintenance_card_label_assignments (
    card_id INTEGER NOT NULL REFERENCES maintenance_cards(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES workflow_card_labels(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (card_id, label_id)
  );

  CREATE TABLE IF NOT EXISTS maintenance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES maintenance_cards(id) ON DELETE CASCADE,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    from_lane TEXT,
    to_lane TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounting_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES maintenance_cards(id) ON DELETE CASCADE,
    action_kind TEXT NOT NULL DEFAULT 'status',
    source_lane TEXT NOT NULL DEFAULT '',
    target_status TEXT NOT NULL DEFAULT '',
    target_board_location TEXT,
    target_case_location TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT
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

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_devices_enabled ON devices(enabled, sort_order);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_module_access_user ON user_module_access(user_id, module);
  CREATE INDEX IF NOT EXISTS idx_workflow_lanes_order ON workflow_lanes(module, sort_order, lane_key);
  CREATE INDEX IF NOT EXISTS idx_workflow_status_module ON workflow_source_statuses(module, normalized_status);
  CREATE INDEX IF NOT EXISTS idx_workflow_card_status_order ON workflow_card_statuses(module, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_workflow_card_label_order ON workflow_card_labels(module, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_maintenance_board ON maintenance_cards(module, removed_at, lane, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_maintenance_source ON maintenance_cards(source_spreadsheet_id, source_sheet_id, source_row_number);
  CREATE INDEX IF NOT EXISTS idx_maintenance_events_card ON maintenance_events(card_id, id DESC);
`);

db.transaction(() => {
  const insertBoard = db.prepare(`
    INSERT OR IGNORE INTO workflow_boards (module, title, description, entry_lane_key)
    VALUES (?, ?, ?, ?)
  `);
  const insertLane = db.prepare(`
    INSERT OR IGNORE INTO workflow_lanes
      (module, lane_key, title, color, sort_order, target_status, is_system)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const insertStatus = db.prepare(`
    INSERT OR IGNORE INTO workflow_source_statuses (normalized_status, display_status, module)
    VALUES (?, ?, ?)
  `);
  for (const workflow of defaultWorkflows) {
    const created = insertBoard.run(workflow.module, workflow.title, workflow.description, workflow.entryLaneKey);
    if (!created.changes) continue;
    for (const lane of workflow.lanes) insertLane.run(workflow.module, ...lane);
    for (const status of workflow.sourceStatuses) insertStatus.run(status, status, workflow.module);
  }
})();

const serviceLostMigration = 'service-lost-containers-v1';
if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(serviceLostMigration)) {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO workflow_source_statuses (normalized_status, display_status, module)
      VALUES ('ВТРАЧЕНИЙ', 'ВТРАЧЕНИЙ', 'service')
      ON CONFLICT(normalized_status) DO UPDATE SET
        display_status = excluded.display_status,
        module = excluded.module
    `).run();
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(serviceLostMigration);
  })();
}

const deviceColumns = new Set(db.pragma('table_info(devices)').map((column) => column.name));
if (!deviceColumns.has('stream_name')) {
  db.exec('ALTER TABLE devices ADD COLUMN stream_name TEXT');
}
if (!deviceColumns.has('stream_mode')) {
  db.exec("ALTER TABLE devices ADD COLUMN stream_mode TEXT NOT NULL DEFAULT 'auto' CHECK (stream_mode IN ('auto', 'mjpeg'))");
}
if (!deviceColumns.has('parent_device_id')) {
  db.exec('ALTER TABLE devices ADD COLUMN parent_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_devices_parent ON devices(parent_device_id, sort_order)');

const maintenanceCardColumns = new Set(db.pragma('table_info(maintenance_cards)').map((column) => column.name));
if (!maintenanceCardColumns.has('report_number')) {
  db.exec("ALTER TABLE maintenance_cards ADD COLUMN report_number TEXT NOT NULL DEFAULT ''");
}
if (!maintenanceCardColumns.has('source_comment')) {
  db.exec("ALTER TABLE maintenance_cards ADD COLUMN source_comment TEXT NOT NULL DEFAULT ''");
}
if (!maintenanceCardColumns.has('source_board_location')) {
  db.exec('ALTER TABLE maintenance_cards ADD COLUMN source_board_location TEXT');
}
if (!maintenanceCardColumns.has('source_case_location')) {
  db.exec('ALTER TABLE maintenance_cards ADD COLUMN source_case_location TEXT');
}

const accountingOutboxColumns = new Set(db.pragma('table_info(accounting_outbox)').map((column) => column.name));
if (!accountingOutboxColumns.has('action_kind')) {
  db.exec("ALTER TABLE accounting_outbox ADD COLUMN action_kind TEXT NOT NULL DEFAULT 'status'");
}
if (!accountingOutboxColumns.has('source_lane')) {
  db.exec("ALTER TABLE accounting_outbox ADD COLUMN source_lane TEXT NOT NULL DEFAULT ''");
}
if (!accountingOutboxColumns.has('target_board_location')) {
  db.exec('ALTER TABLE accounting_outbox ADD COLUMN target_board_location TEXT');
}
if (!accountingOutboxColumns.has('target_case_location')) {
  db.exec('ALTER TABLE accounting_outbox ADD COLUMN target_case_location TEXT');
}
db.exec(`
  UPDATE accounting_outbox
  SET source_lane = COALESCE((
    SELECT lane FROM maintenance_cards WHERE maintenance_cards.id = accounting_outbox.card_id
  ), '')
  WHERE source_lane = ''
`);
db.exec('DROP INDEX IF EXISTS idx_accounting_outbox_pending');
db.exec(`
  CREATE UNIQUE INDEX idx_accounting_outbox_pending
  ON accounting_outbox (
    card_id,
    action_kind,
    source_lane,
    target_status,
    COALESCE(target_board_location, ''),
    COALESCE(target_case_location, '')
  )
  WHERE state = 'pending'
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_maintenance_card_status ON maintenance_card_status_assignments(status_id, card_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_maintenance_card_label ON maintenance_card_label_assignments(label_id, card_id)');

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

db.prepare(`
  INSERT OR IGNORE INTO user_module_access (user_id, module, access_level)
  SELECT id, 'devices', role FROM users
`).run();

for (const module of ['workshop', 'service', 'devices']) {
  db.prepare(`
    INSERT INTO user_module_access (user_id, module, access_level)
    SELECT id, ?, 'admin' FROM users WHERE email = ? COLLATE NOCASE
    ON CONFLICT(user_id, module) DO UPDATE SET access_level = 'admin'
  `).run(module, config.bootstrapAdminEmail);
}

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
    SELECT u.*, COALESCE(GROUP_CONCAT(a.device_id || ':' || a.access_level), '') AS access_map,
      COALESCE((
        SELECT GROUP_CONCAT(m.module || ':' || m.access_level)
        FROM user_module_access m
        WHERE m.user_id = u.id
      ), '') AS module_access_map
    FROM users u
    LEFT JOIN user_device_access a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, u.email
  `),
  listDevices: db.prepare('SELECT * FROM devices ORDER BY sort_order, name'),
  deviceById: db.prepare('SELECT * FROM devices WHERE id = ?'),
  deviceBySlug: db.prepare('SELECT * FROM devices WHERE slug = ? COLLATE NOCASE AND enabled = 1'),
  cameraByParent: db.prepare(`
    SELECT * FROM devices
    WHERE parent_device_id = ? AND kind = 'camera' AND enabled = 1
    ORDER BY sort_order, id
    LIMIT 1
  `),
  accessForUser: db.prepare(`
    SELECT a.device_id, a.access_level
    FROM user_device_access a
    WHERE a.user_id = ?
  `),
  accessForUserAndDevice: db.prepare(`
    SELECT access_level FROM user_device_access WHERE user_id = ? AND device_id = ?
  `),
  moduleAccessForUser: db.prepare(`
    SELECT module, access_level FROM user_module_access WHERE user_id = ?
  `),
  moduleAccessForUserAndModule: db.prepare(`
    SELECT access_level FROM user_module_access WHERE user_id = ? AND module = ?
  `),
  workflowBoardByModule: db.prepare('SELECT * FROM workflow_boards WHERE module = ?'),
  listWorkflowBoards: db.prepare('SELECT * FROM workflow_boards ORDER BY CASE module WHEN \'workshop\' THEN 0 ELSE 1 END'),
  listWorkflowLanes: db.prepare(`
    SELECT * FROM workflow_lanes WHERE module = ? ORDER BY sort_order, lane_key
  `),
  listWorkflowStatuses: db.prepare(`
    SELECT normalized_status, display_status FROM workflow_source_statuses
    WHERE module = ? ORDER BY display_status COLLATE NOCASE
  `),
  listWorkflowCardStatuses: db.prepare(`
    SELECT id, name, color FROM workflow_card_statuses
    WHERE module = ? ORDER BY sort_order, id
  `),
  listWorkflowCardLabels: db.prepare(`
    SELECT id, name, color FROM workflow_card_labels
    WHERE module = ? ORDER BY sort_order, id
  `),
  workflowModuleByStatus: db.prepare(`
    SELECT module FROM workflow_source_statuses WHERE normalized_status = ?
  `),
  listModuleAccess: db.prepare(`
    SELECT user_id, access_level FROM user_module_access WHERE module = ? ORDER BY user_id
  `),
  maintenanceCardById: db.prepare('SELECT * FROM maintenance_cards WHERE id = ?'),
  listMaintenanceCards: db.prepare(`
    SELECT * FROM maintenance_cards
    WHERE module = ? AND removed_at IS NULL
    ORDER BY lane, sort_order, id
  `),
  listMaintenanceCardStatuses: db.prepare(`
    SELECT s.id, s.name, s.color
    FROM maintenance_card_status_assignments a
    JOIN workflow_card_statuses s ON s.id = a.status_id
    WHERE a.card_id = ?
    ORDER BY s.sort_order, s.id
  `),
  listMaintenanceCardLabels: db.prepare(`
    SELECT l.id, l.name, l.color
    FROM maintenance_card_label_assignments a
    JOIN workflow_card_labels l ON l.id = a.label_id
    WHERE a.card_id = ?
    ORDER BY l.sort_order, l.id
  `),
  listMaintenanceEvents: db.prepare(`
    SELECT id, actor_email, action, from_lane, to_lane, created_at
    FROM maintenance_events WHERE card_id = ? ORDER BY id DESC LIMIT ?
  `),
  pendingAccountingActions: db.prepare(`
    SELECT o.id, o.card_id, o.action_kind, o.source_lane, o.target_status,
      o.target_board_location, o.target_case_location, o.attempts,
      c.source_spreadsheet_id, c.source_sheet_id, c.source_row_number,
      c.board_identifier, c.source_status
    FROM accounting_outbox o
    JOIN maintenance_cards c ON c.id = o.card_id
    WHERE o.state = 'pending'
    ORDER BY o.id
    LIMIT ?
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

  const moduleAccess = Object.fromEntries(
    String(row.module_access_map ?? '')
      .split(',')
      .filter(Boolean)
      .map((entry) => entry.split(':'))
  );

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    access,
    moduleAccess
  };
}

export function serializeMaintenanceCard(row, events = [], cardStatuses = [], cardLabels = []) {
  let identifiers = [];
  try { identifiers = JSON.parse(row.identifiers_json || '[]'); } catch {}
  return {
    id: row.id,
    module: row.module,
    asset: row.asset,
    boardIdentifier: row.board_identifier,
    identifiers,
    sourceName: row.source_name,
    sourceSheetName: row.source_sheet_name,
    sourceRowNumber: row.source_row_number,
    sourceStatus: row.source_status,
    sourceComment: row.source_comment || '',
    lane: row.lane,
    cardStatuses,
    cardLabels,
    sortOrder: row.sort_order,
    notes: row.notes,
    reportNumber: row.report_number || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events
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
    parentDeviceId: row.parent_device_id ?? null,
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
      streamMode: row.stream_mode ?? 'auto',
      hasSecret: Boolean(row.secret_enc)
    });
  }

  return base;
}
