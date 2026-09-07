import crypto from 'node:crypto';
import { migrateCrews, createCrewFeatures } from './erp-crews.mjs';
import { migrateMaterials, createMaterialFeatures, quantityMilli } from './erp-materials.mjs';
import { migrateGuides, createGuideFeatures } from './erp-guides.mjs';

export function migrateErp(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS erp_members (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN ('admin','manager','warehouse','technician','inspector','observer'))
      );
      CREATE TABLE IF NOT EXISTS erp_clients (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS erp_templates (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, steps_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS erp_orders (
        id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES erp_clients(id),
        title TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('repair','upgrade','service')),
        priority TEXT NOT NULL CHECK(priority IN ('normal','high','urgent')), due_date TEXT,
        notes TEXT NOT NULL DEFAULT '', steps_json TEXT NOT NULL, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS erp_receipts (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES erp_orders(id),
        reference TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
        actor_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS erp_units (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES erp_orders(id),
        receipt_id INTEGER NOT NULL REFERENCES erp_receipts(id), client_id INTEGER NOT NULL REFERENCES erp_clients(id),
        model_key TEXT NOT NULL, serial TEXT, serial_key TEXT,
        state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received','working','quality','ready','delivered')),
        version INTEGER NOT NULL DEFAULT 1, delivered_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS erp_serial_in_custody ON erp_units(client_id, model_key, serial_key)
        WHERE serial_key IS NOT NULL AND delivered_at IS NULL;
      CREATE INDEX IF NOT EXISTS erp_units_order ON erp_units(order_id, state);
      CREATE TABLE IF NOT EXISTS erp_tasks (
        id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES erp_units(id),
        sequence INTEGER NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
        planned_minutes INTEGER NOT NULL DEFAULT 0 CHECK(planned_minutes >= 0),
        assigned_to INTEGER REFERENCES users(id), completed_by INTEGER REFERENCES users(id),
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','in_progress','paused','blocked','done')),
        note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, completed_at INTEGER,
        UNIQUE(unit_id,sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS erp_one_running_task ON erp_tasks(assigned_to) WHERE state='in_progress';
      CREATE INDEX IF NOT EXISTS erp_tasks_assignee ON erp_tasks(assigned_to,state);
      CREATE TABLE IF NOT EXISTS erp_shifts (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
        state TEXT NOT NULL CHECK(state IN ('active','paused','closed')), started_at INTEGER NOT NULL,
        ended_at INTEGER, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS erp_one_open_shift ON erp_shifts(user_id) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS erp_shift_intervals (
        id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES erp_shifts(id),
        started_at INTEGER NOT NULL, ended_at INTEGER, CHECK(ended_at IS NULL OR ended_at >= started_at)
      );
      CREATE INDEX IF NOT EXISTS erp_intervals_shift ON erp_shift_intervals(shift_id);
      CREATE TABLE IF NOT EXISTS erp_time_entries (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES erp_tasks(id),
        user_id INTEGER NOT NULL REFERENCES users(id), shift_id INTEGER NOT NULL REFERENCES erp_shifts(id),
        started_at INTEGER NOT NULL, ended_at INTEGER, CHECK(ended_at IS NULL OR ended_at >= started_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS erp_one_running_timer ON erp_time_entries(user_id) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS erp_time_user ON erp_time_entries(user_id,started_at);
      CREATE INDEX IF NOT EXISTS erp_time_task ON erp_time_entries(task_id,started_at);
      CREATE TABLE IF NOT EXISTS erp_quality_checks (
        id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES erp_units(id),
        result TEXT NOT NULL CHECK(result IN ('pass','rework')), note TEXT NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS erp_quality_unit ON erp_quality_checks(unit_id);
      CREATE TABLE IF NOT EXISTS erp_deliveries (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES erp_orders(id),
        reference TEXT NOT NULL, recipient TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS erp_delivery_units (
        delivery_id INTEGER NOT NULL REFERENCES erp_deliveries(id),
        unit_id INTEGER NOT NULL UNIQUE REFERENCES erp_units(id), PRIMARY KEY(delivery_id,unit_id)
      );
      CREATE TABLE IF NOT EXISTS erp_stock_lots (
        id INTEGER PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL,
        client_id INTEGER REFERENCES erp_clients(id), condition TEXT NOT NULL CHECK(condition IN ('new','good','unknown','defective')),
        shelf TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL, origin_unit_id INTEGER REFERENCES erp_units(id), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS erp_stock_moves (
        id INTEGER PRIMARY KEY, lot_id INTEGER NOT NULL REFERENCES erp_stock_lots(id),
        from_location TEXT NOT NULL CHECK(from_location IN ('external','warehouse','workbench','installed')),
        to_location TEXT NOT NULL CHECK(to_location IN ('warehouse','workbench','installed','returned','scrap')),
        unit_id INTEGER REFERENCES erp_units(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
        note TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
        CHECK(from_location != to_location)
      );
      CREATE INDEX IF NOT EXISTS erp_stock_moves_lot ON erp_stock_moves(lot_id,unit_id);
      CREATE TABLE IF NOT EXISTS erp_events (
        id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL,
        entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS erp_events_actor_action ON erp_events(actor_id,action);
      CREATE TABLE IF NOT EXISTS erp_commands (
        user_id INTEGER NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,request_id)
      );
      CREATE TRIGGER IF NOT EXISTS erp_moves_no_update BEFORE UPDATE ON erp_stock_moves BEGIN
        SELECT RAISE(ABORT,'Stock ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS erp_moves_no_delete BEFORE DELETE ON erp_stock_moves BEGIN
        SELECT RAISE(ABORT,'Stock ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS erp_events_no_update BEFORE UPDATE ON erp_events BEGIN
        SELECT RAISE(ABORT,'ERP audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS erp_events_no_delete BEFORE DELETE ON erp_events BEGIN
        SELECT RAISE(ABORT,'ERP audit is append-only'); END;
    `);
    if (!db.pragma('table_info(erp_orders)').some(column=>column.name==='version')) db.exec('ALTER TABLE erp_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run('erp_v1');
    migrateCrews(db);
    migrateMaterials(db);
    migrateGuides(db);
  }).immediate();
}

export function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

export const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;
export const unitCode = (id) => `LB-${String(id).padStart(6, '0')}`;
export const orderCode = (id) => `WO-${String(id).padStart(5, '0')}`;

export function createErp(db) {
  migrateErp(db);
  db.function('erp_casefold', { deterministic: true }, value=>String(value??'').toLocaleLowerCase('uk-UA'));
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const insert = (sql, ...args) => Number(run(sql, ...args).lastInsertRowid);
  const now = () => Date.now();
  const role = (user) => user?.enabled ? (user.role === 'admin' ? 'admin' : get('SELECT role FROM erp_members WHERE user_id=?', user.id)?.role ?? 'none') : 'none';
  const requireRole = (user, roles) => { if (!roles.includes(role(user))) fail(403, 'Немає прав на цю дію у виробництві'); };
  const manages = (user) => ['admin','manager'].includes(role(user));
  const event = (user, action, type, id, details = {}) => insert('INSERT INTO erp_events(actor_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)', user.id, action, type, id, JSON.stringify(details), now());
  const entity = (table, id) => {
    const row = get(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row) fail(404, 'Запис не знайдено');
    return row;
  };
  const version = (row, expected) => { if (row.version !== expected) fail(409, 'Запис уже змінився. Оновіть дані та повторіть дію.'); };
  const activeShift = (userId) => get('SELECT * FROM erp_shifts WHERE user_id=? AND ended_at IS NULL', userId);
  const canWorkUnit = (user, id) => manages(user) || Boolean(get(`SELECT t.id FROM erp_tasks t WHERE t.unit_id=? AND ((t.crew_id IS NULL AND t.assigned_to=?) OR EXISTS(SELECT 1 FROM erp_crew_members m JOIN erp_crews c ON c.id=m.crew_id WHERE m.crew_id=t.crew_id AND m.user_id=? AND c.archived=0))`, id, user.id, user.id));
  const stopTimer = (taskId, time) => run('UPDATE erp_time_entries SET ended_at=MAX(started_at,MIN(?,(SELECT started_at+? FROM erp_shifts WHERE id=shift_id))) WHERE task_id=? AND ended_at IS NULL', time, MAX_SHIFT_MS, taskId);
  const crews = createCrewFeatures({ db,get,all,run,insert,entity,version,role,requireRole,manages,event,fail,now,activeShift,maxShiftMs:MAX_SHIFT_MS });
  const materials = createMaterialFeatures({get,all,run,insert,entity,version,requireRole,event,fail,now,moveStock});
  const guides = createGuideFeatures({get,all,run,insert,entity,version,role,requireRole,event,fail,now});

  function replayCommand(user, requestId, path, body) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([path, body])).digest('hex');
    const previous = get('SELECT * FROM erp_commands WHERE user_id=? AND request_id=?', user.id, requestId);
    if(!previous)return null;
    if(previous.fingerprint!==fingerprint)fail(409,'Ідентифікатор повторного запиту має інші дані');
    return {result:JSON.parse(previous.response_json)};
  }
  function command(user, requestId, path, body, work) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([path, body])).digest('hex');
    return db.transaction(() => {
      const previous=replayCommand(user,requestId,path,body);
      if(previous)return previous.result;
      const result = work();
      run('INSERT INTO erp_commands VALUES(?,?,?,?,?)', user.id, requestId, fingerprint, JSON.stringify(result), now());
      return result;
    }).immediate();
  }

  function receive(user, order, body) {
    if (body.serials.length + body.unnumbered < 1) fail(400, 'Додайте хоча б один виріб');
    if (body.serials.length + body.unnumbered > 500) fail(400, 'За одну прийомку — до 500 виробів');
    const receiptId = insert('INSERT INTO erp_receipts(order_id,reference,quantity,actor_id,created_at) VALUES(?,?,?,?,?)', order.id, body.reference, body.serials.length + body.unnumbered, user.id, now());
    const steps = JSON.parse(order.steps_json);
    const ids = [];
    for (const serial of [...body.serials, ...Array(body.unnumbered).fill(null)]) {
      const id = insert('INSERT INTO erp_units(order_id,receipt_id,client_id,model_key,serial,serial_key,created_at) VALUES(?,?,?,?,?,?,?)', order.id, receiptId, order.client_id, order.model.trim().toLocaleUpperCase('uk-UA'), serial, serial?.toLocaleUpperCase('uk-UA') ?? null, now());
      for (const [sequence, step] of steps.entries()) insert('INSERT INTO erp_tasks(unit_id,sequence,title,instructions,planned_minutes) VALUES(?,?,?,?,?)', id, sequence, step.title, step.instructions, step.plannedMinutes);
      ids.push(id);
    }
    event(user, 'receipt.created', 'order', order.id, { receiptId, quantity: ids.length, reference: body.reference });
    return { id: order.id, receiptId, quantity: ids.length };
  }

  const taskSelect = `SELECT t.*, u.serial, u.state AS unit_state, u.order_id, o.title AS order_title, o.model, o.priority, o.due_date,
    COALESCE(p.display_name,p.email,g.name,'Не призначено') AS assignee, g.name AS crew_name,
    COALESCE((SELECT SUM(MAX(0,COALESCE(e.ended_at,MIN(?,s.started_at+${MAX_SHIFT_MS}))-e.started_at)) FROM erp_time_entries e JOIN erp_shifts s ON s.id=e.shift_id WHERE e.task_id=t.id),0) AS elapsed_ms,
    (SELECT COUNT(*) FROM erp_tasks prev WHERE prev.unit_id=t.unit_id AND prev.sequence<t.sequence AND prev.state!='done') AS waiting_for
    FROM erp_tasks t JOIN erp_units u ON u.id=t.unit_id JOIN erp_orders o ON o.id=u.order_id LEFT JOIN users p ON p.id=t.assigned_to LEFT JOIN erp_crews g ON g.id=t.crew_id`;
  const serializeTask = (t) => ({ ...t, unit_code: unitCode(t.unit_id), order_code: orderCode(t.order_id) });

  function orderDetail(user, id) {
    requireRole(user, ['admin','manager','warehouse','inspector','observer']);
    const order = get('SELECT o.*,c.name AS client_name FROM erp_orders o JOIN erp_clients c ON c.id=o.client_id WHERE o.id=?', id);
    if (!order) fail(404, 'Замовлення не знайдено');
    return {
      ...order, code: orderCode(id), steps: JSON.parse(order.steps_json), materialSpec:materials.orderNeeds(id),
      units: all('SELECT * FROM erp_units WHERE order_id=? ORDER BY id', id).map(u => ({ ...u, code: unitCode(u.id) })),
      tasks: all(`${taskSelect} WHERE u.order_id=? ORDER BY u.id,t.sequence`, now(), id).map(t=>serializeTask(crews.decorateTask(t,user))),
      receipts: all('SELECT * FROM erp_receipts WHERE order_id=? ORDER BY id DESC', id),
      deliveries: all('SELECT d.*,COUNT(du.unit_id) AS quantity FROM erp_deliveries d JOIN erp_delivery_units du ON du.delivery_id=d.id WHERE d.order_id=? GROUP BY d.id ORDER BY d.id DESC', id),
      quality: all('SELECT q.*,u.display_name AS actor FROM erp_quality_checks q JOIN erp_units v ON v.id=q.unit_id JOIN users u ON u.id=q.actor_id WHERE v.order_id=? ORDER BY q.id DESC', id)
    };
  }

  function listOrders() {
    return all(`SELECT o.*,c.name AS client_name,COUNT(u.id) AS received,
      SUM(u.state='received') AS waiting,SUM(u.state='working') AS working,SUM(u.state='quality') AS quality,
      SUM(u.state='ready') AS ready,SUM(u.state='delivered') AS delivered
      FROM erp_orders o JOIN erp_clients c ON c.id=o.client_id LEFT JOIN erp_units u ON u.order_id=o.id
      GROUP BY o.id ORDER BY o.id DESC LIMIT 200`).map(o => ({ ...o, code: orderCode(o.id), steps: JSON.parse(o.steps_json) }));
  }

  function team() {
    return all(`SELECT u.id,u.display_name,u.email,u.enabled,COALESCE(m.role,'none') AS erp_role,u.role AS portal_role,
      (SELECT COUNT(*) FROM erp_tasks WHERE assigned_to=u.id AND state!='done') AS assigned,
      (SELECT COUNT(*) FROM erp_events WHERE actor_id=u.id AND action='task.complete') AS completed,
      (SELECT COUNT(*) FROM erp_events WHERE actor_id=u.id AND action='task.finish_part') AS contributions,
      (SELECT COUNT(*) FROM erp_tasks WHERE assigned_to=u.id AND state='blocked') AS blocked
      FROM users u LEFT JOIN erp_members m ON m.user_id=u.id ORDER BY u.display_name,u.id`).map(u => {
        const shift = activeShift(u.id);
        const current = get(`${taskSelect} WHERE t.id=(SELECT e.task_id FROM erp_time_entries e WHERE e.user_id=? AND e.ended_at IS NULL)`, now(), u.id);
        const workMs = get(`SELECT COALESCE(SUM(MAX(0,COALESCE(e.ended_at,MIN(?,s.started_at+?))-e.started_at)),0) AS ms FROM erp_time_entries e JOIN erp_shifts s ON s.id=e.shift_id WHERE e.user_id=?`, now(), MAX_SHIFT_MS, u.id).ms;
        return { ...u, erp_role: u.portal_role === 'admin' ? 'admin' : u.erp_role, shift, current: current ? serializeTask(current) : null, work_ms: workMs };
      });
  }

  function shifts(userId) {
    return all(`SELECT s.*,COALESCE((SELECT SUM(MAX(0,COALESCE(i.ended_at,MIN(?,s.started_at+?))-i.started_at)) FROM erp_shift_intervals i WHERE i.shift_id=s.id),0) AS elapsed_ms FROM erp_shifts s WHERE user_id=? ORDER BY s.id DESC LIMIT 60`, now(), MAX_SHIFT_MS, userId);
  }

  function stock() {
    return all(`SELECT l.*,COALESCE(c.name,'Власність майстерні') AS owner_name,COALESCE(i.uom,'pcs') AS uom,
      COALESCE(SUM(CASE WHEN m.to_location='warehouse' THEN m.quantity ELSE 0 END - CASE WHEN m.from_location='warehouse' THEN m.quantity ELSE 0 END),0) AS warehouse,
      COALESCE(SUM(CASE WHEN m.to_location='workbench' THEN m.quantity ELSE 0 END - CASE WHEN m.from_location='workbench' THEN m.quantity ELSE 0 END),0) AS workbench,
      COALESCE(SUM(CASE WHEN m.to_location='installed' THEN m.quantity ELSE 0 END - CASE WHEN m.from_location='installed' THEN m.quantity ELSE 0 END),0) AS installed,
      COALESCE(SUM(CASE WHEN m.to_location='returned' THEN m.quantity ELSE 0 END),0) AS returned,
      COALESCE(SUM(CASE WHEN m.to_location='scrap' THEN m.quantity ELSE 0 END),0) AS scrap
      FROM erp_stock_lots l LEFT JOIN erp_clients c ON c.id=l.client_id LEFT JOIN erp_materials i ON i.id=l.material_id LEFT JOIN erp_stock_moves m ON m.lot_id=l.id GROUP BY l.id ORDER BY l.id DESC LIMIT 500`).map(lot=>({...lot,...Object.fromEntries(['warehouse','workbench','installed','returned','scrap'].map(k=>[k,lot[k]/lot.quantity_scale]))}));
  }

  function snapshot(user, query = {}) {
    const access = role(user);
    requireRole(user, ['admin','manager','warehouse','technician','inspector','observer']);
    const taskState=query.taskState||'all';
    const taskPage=query.page||0;
    const needle=(query.q||'').toLocaleLowerCase('uk-UA');
    const personal=`(t.assigned_to=? OR t.id IN (SELECT p.task_id FROM erp_task_participants p JOIN erp_tasks own ON own.id=p.task_id JOIN erp_crew_members m ON m.crew_id=own.crew_id JOIN erp_crews c ON c.id=own.crew_id WHERE p.user_id=? AND m.user_id=? AND own.work_mode='shared' AND p.work_round=own.work_round AND c.archived=0))`;
    const where=`${personal} AND (?='all' OR (?='open' AND t.state!='done') OR t.state=?)
      AND instr(erp_casefold(COALESCE(u.serial,'')||' '||t.title||' '||o.title||' '||o.model||' LB-'||printf('%06d',u.id)),?)>0`;
    const taskArgs=[user.id,user.id,user.id,taskState,taskState,taskState,needle];
    const taskCount=get(`SELECT COUNT(*) AS count FROM erp_tasks t JOIN erp_units u ON u.id=t.unit_id JOIN erp_orders o ON o.id=u.order_id WHERE ${where}`,...taskArgs).count;
    const result = {
      me: { id: user.id, name: user.display_name || user.email, role: access }, serverTime: now(),
      shifts: shifts(user.id),
      crews: ['admin','manager','technician','observer'].includes(access) ? crews.listCrews(user) : [],
      myTaskCount:taskCount, myTaskPage:taskPage, myTaskPageSize:50,
      myTaskCounts:get(`SELECT COUNT(*) AS total,COALESCE(SUM(state!='done'),0) AS open,COALESCE(SUM(state='done'),0) AS done,COALESCE(SUM(state='blocked'),0) AS blocked FROM erp_tasks t WHERE ${personal}`,user.id,user.id,user.id),
      myTasks: all(`${taskSelect} WHERE ${where} ORDER BY CASE t.state WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'paused' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,CASE o.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,o.due_date IS NULL,o.due_date,t.id LIMIT 50 OFFSET ?`, now(),...taskArgs,taskPage*50).map(t=>serializeTask(crews.decorateTask(t,user)))
    };
    if (access !== 'technician') {
      result.orders = listOrders();
      result.clients = all('SELECT * FROM erp_clients ORDER BY name LIMIT 1000');
      result.templates = all('SELECT * FROM erp_templates ORDER BY id DESC LIMIT 100').map(t => ({...t, steps: JSON.parse(t.steps_json),materialSpec:materials.spec('template',t.id)}));
      result.materials = materials.catalogue();
      result.stock = stock();
      result.stockCount=get('SELECT COUNT(*) AS count FROM erp_stock_lots').count;
      result.totals = get(`SELECT COUNT(*) AS received,COALESCE(SUM(state='ready'),0) AS ready,COALESCE(SUM(state='delivered'),0) AS delivered,COALESCE(SUM(state='quality'),0) AS quality FROM erp_units`);
      result.orderCount = get('SELECT COUNT(*) AS count FROM erp_orders').count;
    }
    if (manages(user) || access === 'observer') {
      result.team = team();
      result.events = all(`SELECT e.*,COALESCE(NULLIF(u.display_name,''),u.email) AS actor FROM erp_events e JOIN users u ON u.id=e.actor_id ORDER BY e.id DESC LIMIT 80`);
    }
    if(['admin','manager','warehouse','observer'].includes(access))result.materialPlanning=materials.planning(user);
    return result;
  }

  function taskAction(user, id, body) {
    requireRole(user, ['admin','manager','technician']);
    const task = entity('erp_tasks', id);
    if (task.crew_id && !crews.member(task.crew_id,user.id) && !(task.work_mode==='shared' && body.action==='complete' && manages(user))) fail(403,'Ви не входите до цієї робочої команди');
    if (task.work_mode==='pool' && task.assigned_to===null && body.action==='start') {
      version(task,body.version);
      run('UPDATE erp_tasks SET assigned_to=? WHERE id=?',user.id,id);
      task.assigned_to=user.id;
    }
    if (task.work_mode==='shared') {
      version(task,body.version);
      if (['ready','delivered'].includes(entity('erp_units',task.unit_id).state)) fail(409,'Виріб уже пройшов контроль або виданий');
      return crews.sharedAction(user,task,body);
    }
    if (body.action==='finish_part') fail(400,'Дія доступна лише для спільної операції');
    if (task.assigned_to !== user.id) fail(403, 'Дія доступна лише призначеному майстру');
    version(task, body.version);
    const unit = entity('erp_units', task.unit_id);
    if (['ready','delivered'].includes(unit.state)) fail(409, 'Виріб уже пройшов контроль або виданий');
    const time = now();
    if (body.action === 'start') {
      if (!['pending','paused','blocked'].includes(task.state)) fail(409, 'Роботу вже розпочато або завершено');
      const shift = activeShift(user.id);
      if (!shift || shift.state !== 'active' || time - shift.started_at >= MAX_SHIFT_MS) fail(409, 'Спочатку розпочніть активну зміну. Зміна понад 16 годин потребує закриття.');
      if (get('SELECT id FROM erp_time_entries WHERE user_id=? AND ended_at IS NULL', user.id)) fail(409, 'Спочатку призупиніть поточну роботу');
      if (get("SELECT id FROM erp_tasks WHERE unit_id=? AND sequence<? AND state!='done'", task.unit_id, task.sequence)) fail(409, 'Попередня операція ще не завершена');
      run("UPDATE erp_tasks SET state='in_progress',version=version+1 WHERE id=?", id);
      run("UPDATE erp_units SET state='working',version=version+1 WHERE id=?", task.unit_id);
      insert('INSERT INTO erp_time_entries(task_id,user_id,shift_id,started_at,crew_id,work_round) VALUES(?,?,?,?,?,?)', id, user.id, shift.id, time,task.crew_id,task.work_round);
    } else {
      if (body.action === 'block' && !body.note) fail(400, 'Вкажіть причину блокування');
      if (body.action !== 'block' && task.state !== 'in_progress') fail(409, 'Спочатку розпочніть роботу');
      if (task.state === 'done') fail(409, 'Завершену операцію можна повернути лише через контроль якості');
      stopTimer(id, time);
      const next = { pause: 'paused', block: 'blocked', complete: 'done' }[body.action];
      run('UPDATE erp_tasks SET state=?,note=?,version=version+1,completed_by=?,completed_at=? WHERE id=?', next, body.note, body.action === 'complete' ? user.id : null, body.action === 'complete' ? time : null, id);
      if (body.action === 'complete' && !get("SELECT id FROM erp_tasks WHERE unit_id=? AND state!='done'", task.unit_id)) run("UPDATE erp_units SET state='quality',version=version+1 WHERE id=?", task.unit_id);
    }
    event(user, `task.${body.action}`, 'task', id, { unitId: task.unit_id, note: body.note });
    return { id };
  }

  function shiftAction(user, body) {
    requireRole(user, ['admin','manager','technician']);
    const shift = activeShift(user.id);
    const time = now();
    if (body.action === 'start') {
      if (shift) fail(409, 'Попередня зміна ще відкрита');
      const id = insert("INSERT INTO erp_shifts(user_id,state,started_at) VALUES(?,'active',?)", user.id, time);
      insert('INSERT INTO erp_shift_intervals(shift_id,started_at) VALUES(?,?)', id, time);
      event(user, 'shift.start', 'shift', id);
      return { id };
    }
    if (!shift) fail(409, 'Немає відкритої зміни');
    version(shift, body.version);
    const cutoff = Math.min(time, shift.started_at + MAX_SHIFT_MS);
    if (body.action === 'resume') {
      if (shift.state !== 'paused' || time >= shift.started_at + MAX_SHIFT_MS) fail(409, 'Зміну неможливо продовжити. Закрийте її та відкрийте нову.');
      run("UPDATE erp_shifts SET state='active',version=version+1 WHERE id=?", shift.id);
      insert('INSERT INTO erp_shift_intervals(shift_id,started_at) VALUES(?,?)', shift.id, time);
    } else {
      if (body.action === 'pause' && shift.state !== 'active') fail(409, 'Зміна вже на перерві');
      crews.stopUserTasks(user.id,cutoff);
      run('UPDATE erp_shift_intervals SET ended_at=MAX(started_at,?) WHERE shift_id=? AND ended_at IS NULL', cutoff, shift.id);
      run('UPDATE erp_shifts SET state=?,ended_at=?,version=version+1 WHERE id=?', body.action === 'end' ? 'closed' : 'paused', body.action === 'end' ? cutoff : null, shift.id);
    }
    event(user, `shift.${body.action}`, 'shift', shift.id, { capped: time > cutoff });
    return { id: shift.id };
  }

  function quality(user, id, body) {
    requireRole(user, ['admin','manager','inspector']);
    const unit = entity('erp_units', id);
    version(unit, body.version);
    if (unit.state !== 'quality') fail(409, 'Виріб ще не готовий до контролю якості');
    if (get('SELECT t.id FROM erp_tasks t JOIN erp_time_entries e ON e.task_id=t.id WHERE t.unit_id=? AND e.user_id=?', id, user.id)) fail(409, 'Перевірку має виконати інша людина, ніж виконавець робіт');
    if (body.result === 'pass') {
      if (get("SELECT id FROM erp_tasks WHERE unit_id=? AND state!='done'", id)) fail(409, 'Є незавершені операції');
      if (get("SELECT lot_id,SUM(CASE WHEN to_location='workbench' THEN quantity ELSE 0 END-CASE WHEN from_location='workbench' THEN quantity ELSE 0 END) AS qty FROM erp_stock_moves WHERE unit_id=? GROUP BY lot_id HAVING qty>0", id)) fail(409, 'Спочатку підтвердьте встановлення або повернення всіх виданих деталей');
      run("UPDATE erp_units SET state='ready',version=version+1 WHERE id=?", id);
    } else {
      if (!body.note) fail(400, 'Опишіть зауваження для доопрацювання');
      const task = get('SELECT * FROM erp_tasks WHERE unit_id=? AND id=?', id, body.taskId);
      if (!task) fail(400, 'Оберіть операцію для доопрацювання');
      // Repeat the chosen operation and downstream checks; previous time records remain intact.
      run("UPDATE erp_tasks SET state='pending',completed_at=NULL,completed_by=NULL,note=?,work_round=work_round+1,version=version+1 WHERE unit_id=? AND sequence>=?", body.note, id, task.sequence);
      run("UPDATE erp_units SET state='working',version=version+1 WHERE id=?", id);
    }
    insert('INSERT INTO erp_quality_checks(unit_id,result,note,actor_id,created_at) VALUES(?,?,?,?,?)', id, body.result, body.note, user.id, now());
    event(user, `quality.${body.result}`, 'unit', id, { note: body.note });
    return { id };
  }

  function deliver(user, orderId, body) {
    requireRole(user, ['admin','manager','warehouse']);
    entity('erp_orders', orderId);
    for (const selected of body.units) {
      const unit = entity('erp_units', selected.id);
      version(unit, selected.version);
      if (unit.order_id !== orderId || unit.state !== 'ready') fail(409, 'Видавати можна лише перевірені вироби цього замовлення');
      if (get(`SELECT lot_id,SUM(CASE WHEN to_location='workbench' THEN quantity ELSE 0 END-CASE WHEN from_location='workbench' THEN quantity ELSE 0 END) AS qty FROM erp_stock_moves WHERE unit_id=? GROUP BY lot_id HAVING qty>0`, unit.id)) fail(409, 'Закрийте залишки комплектуючих на робочому місці цього виробу');
    }
    const id = insert('INSERT INTO erp_deliveries(order_id,reference,recipient,actor_id,created_at) VALUES(?,?,?,?,?)', orderId, body.reference, body.recipient, user.id, now());
    for (const unit of body.units) {
      run('INSERT INTO erp_delivery_units VALUES(?,?)', id, unit.id);
      run("UPDATE erp_units SET state='delivered',delivered_at=?,version=version+1 WHERE id=?", now(), unit.id);
    }
    event(user, 'delivery.created', 'order', orderId, { deliveryId: id, quantity: body.units.length, reference: body.reference });
    return { id, quantity: body.units.length };
  }

  function receiveStock(user, body) {
    requireRole(user, ['admin','manager','warehouse']);
    const receipt=materials.receiptInfo(body);
    if (body.clientId) entity('erp_clients', body.clientId);
    if (body.originUnitId) {
      const unit = entity('erp_units', body.originUnitId);
      if (unit.client_id !== body.clientId || ['ready','delivered'].includes(unit.state)) fail(409, 'Зняті деталі мають належати клієнту цього відкритого виробу');
      if (body.condition === 'new') fail(400, 'Знята деталь не може мати стан «Нова»');
    }
    const id = insert('INSERT INTO erp_stock_lots(sku,name,client_id,condition,shelf,reference,origin_unit_id,created_at,material_id,quantity_scale,replenishment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', receipt.material?.sku??body.sku, receipt.material?.name??body.name, body.clientId, body.condition, body.shelf, body.reference, body.originUnitId, now(),receipt.material?.id??null,receipt.scale,body.replenishmentId??null);
    insert("INSERT INTO erp_stock_moves(lot_id,from_location,to_location,unit_id,quantity,note,actor_id,created_at) VALUES(?,'external','warehouse',?,?,?,?,?)", id, body.originUnitId, receipt.quantity, body.reference, user.id, now());
    materials.receiveReplenishment(user,body.replenishmentId,receipt.quantity,id);
    event(user, 'stock.received', 'lot', id, { quantity: body.quantity,uom:receipt.material?.uom??'pcs', reference: body.reference, originUnitId: body.originUnitId });
    return { id };
  }

  function moveStock(user, id, body) {
    requireRole(user, ['admin','manager','warehouse','technician']);
    const lot = entity('erp_stock_lots', id);
    const uom=lot.material_id?entity('erp_materials',lot.material_id).uom:'pcs';
    const quantity=quantityMilli(body.quantity,uom)*lot.quantity_scale/1000;
    if(!Number.isSafeInteger(quantity)||quantity<=0)fail(400,'Некоректна точність або кількість складського руху');
    const allowed = new Set(['warehouse:workbench','workbench:warehouse','workbench:installed','installed:warehouse','warehouse:returned','warehouse:scrap']);
    if (!allowed.has(`${body.from}:${body.to}`)) fail(400, 'Недопустиме складське переміщення');
    if (body.to === 'scrap' && !manages(user)) fail(403, 'Списання підтверджує керівник');
    if (body.to === 'returned' && !lot.client_id) fail(400, 'Це власність майстерні, а не клієнта');
    if (body.to === 'installed' && !['new','good'].includes(lot.condition)) fail(409, 'Неперевірені або несправні деталі не можна встановлювати');
    const needsUnit = [body.from,body.to].some(l => ['workbench','installed'].includes(l));
    if (needsUnit) {
      if (!body.unitId) fail(400, 'Оберіть виріб');
      const unit = entity('erp_units', body.unitId);
      if (['ready','delivered'].includes(unit.state)) fail(409, 'Виріб уже перевірений або виданий');
      if (lot.client_id && lot.client_id !== unit.client_id) fail(409, 'Комплектуючі належать іншому клієнту');
      if (role(user) === 'technician' && (!canWorkUnit(user, body.unitId) || !['workbench:installed','workbench:warehouse'].includes(`${body.from}:${body.to}`))) fail(403, 'Майстер може використовувати лише видані комплектуючі свого виробу');
    } else {
      if (role(user) === 'technician') fail(403, 'Потрібен доступ комірника');
      if (body.unitId) fail(400, 'Ця дія не прив’язується до виробу');
    }
    const balance = get(`SELECT COALESCE(SUM(CASE WHEN to_location=? THEN quantity ELSE 0 END-CASE WHEN from_location=? THEN quantity ELSE 0 END),0) AS qty FROM erp_stock_moves WHERE lot_id=? ${body.from === 'warehouse' ? '' : 'AND unit_id=?'}`, body.from, body.from, id, ...(body.from === 'warehouse' ? [] : [body.unitId])).qty;
    if (balance < quantity) fail(409, 'Недостатньо залишку в обраному місці');
    const moveId = insert('INSERT INTO erp_stock_moves(lot_id,from_location,to_location,unit_id,quantity,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)', id, body.from, body.to, body.unitId, quantity, body.note, user.id, now());
    if (needsUnit) run('UPDATE erp_units SET version=version+1 WHERE id=?', body.unitId);
    event(user, 'stock.moved', 'lot', id, { moveId, ...body,uom });
    return { id: moveId };
  }

  return { ...guides, role, requireRole, command, replayCommand, snapshot, orderDetail, taskAction, shiftAction, quality, deliver, receiveStock, moveStock,
    saveMaterial:materials.saveMaterial,saveMaterialSpec:materials.saveSpec,linkMaterialLot:materials.linkLot,
    replenishments:materials.requests,saveReplenishment:materials.saveReplenishment,consumeMaterials:materials.consume,previewConsumption:materials.previewConsumption,
    saveCrew:crews.saveCrew, assignCrew:crews.assignCrew, workHistory:crews.workHistory,
    crewTasks(user,id,query) {
      requireRole(user,['admin','manager','technician','observer']);
      if (!manages(user) && role(user)!=='observer' && !crews.member(id,user.id)) fail(403,'Немає доступу до робіт цієї команди');
      entity('erp_crews',id);
      const needle=(query.q||'').toLocaleLowerCase('uk-UA');
      const where=`t.crew_id=? AND (?='all' OR (?='open' AND t.state!='done') OR t.state=?) AND instr(erp_casefold(COALESCE(u.serial,'')||' '||t.title||' '||o.title||' LB-'||printf('%06d',u.id)),?)>0`;
      const args=[id,query.taskState,query.taskState,query.taskState,needle];
      const count=get(`SELECT COUNT(*) AS n FROM erp_tasks t JOIN erp_units u ON u.id=t.unit_id JOIN erp_orders o ON o.id=u.order_id WHERE ${where}`,...args).n;
      const tasks=all(`${taskSelect} WHERE ${where} ORDER BY CASE t.state WHEN 'in_progress' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,t.id LIMIT 50 OFFSET ?`,now(),...args,query.page*50).map(t=>serializeTask(crews.decorateTask(t,user)));
      return {tasks,count,page:query.page,pageSize:50};
    },
    updateOrder(user,id,body) {
      requireRole(user,['admin','manager']);
      const order=entity('erp_orders',id);version(order,body.version);
      run('UPDATE erp_orders SET title=?,priority=?,due_date=?,notes=?,version=version+1 WHERE id=?',body.title,body.priority,body.dueDate,body.notes,id);
      event(user,'order.updated','order',id,{before:{title:order.title,priority:order.priority,dueDate:order.due_date,notes:order.notes},after:body});
      return {id};
    },
    closeMemberShift(user,id,body) {
      requireRole(user,['admin','manager']);
      const shift=activeShift(id);
      if(!shift)fail(409,'У користувача немає відкритої зміни');
      version(shift,body.version);
      if(body.endedAt<shift.started_at||body.endedAt>now())fail(400,'Час закриття має бути між початком зміни та поточним часом');
      const latest=get('SELECT MAX(COALESCE(ended_at,started_at)) AS time FROM erp_shift_intervals WHERE shift_id=?',shift.id)?.time??shift.started_at;
      const latestWork=get('SELECT MAX(COALESCE(ended_at,started_at)) AS time FROM erp_time_entries WHERE shift_id=?',shift.id)?.time??shift.started_at;
      if(body.endedAt<Math.max(latest,latestWork))fail(400,'Не можна закрити зміну до вже зафіксованої операції');
      const cutoff=Math.min(body.endedAt,shift.started_at+MAX_SHIFT_MS);
      crews.stopUserTasks(id,cutoff);
      run('UPDATE erp_shift_intervals SET ended_at=MAX(started_at,?) WHERE shift_id=? AND ended_at IS NULL',cutoff,shift.id);
      run("UPDATE erp_shifts SET state='closed',ended_at=?,version=version+1 WHERE id=?",cutoff,shift.id);
      event(user,'shift.closed_by_manager','shift',shift.id,{userId:id,endedAt:cutoff,reason:body.reason});
      return {id:shift.id};
    },
    createMember(user, body) {
      requireRole(user, ['admin']);
      if (get('SELECT id FROM users WHERE email=? COLLATE NOCASE',body.email)) fail(409,'Користувач уже є в LABA. Призначте роль у його рядку команди.');
      const id=insert("INSERT INTO users(email,display_name,role,enabled) VALUES(?,?,'viewer',1)",body.email.toLowerCase(),body.name);
      run('INSERT INTO erp_members(user_id,role) VALUES(?,?)',id,body.role);
      event(user,'member.created','user',id,{role:body.role});
      return {id};
    },
    memberShifts(user,id) { requireRole(user,['admin','manager','observer']); entity('users',id); return shifts(id); },
    createClient(user, body) {
      requireRole(user, ['admin','manager']);
      const id = insert('INSERT INTO erp_clients(name,contact,notes,created_at) VALUES(?,?,?,?)', body.name, body.contact, body.notes, now());
      event(user, 'client.created', 'client', id);
      return { id };
    },
    createTemplate(user, body) {
      requireRole(user, ['admin','manager']);
      const id = insert('INSERT INTO erp_templates(name,steps_json,created_at) VALUES(?,?,?)', body.name, JSON.stringify(body.steps), now());
      event(user, 'template.created', 'template', id);
      return { id };
    },
    createOrder(user, body) {
      requireRole(user, ['admin','manager']);
      entity('erp_clients', body.clientId);
      const steps = body.templateId ? JSON.parse(entity('erp_templates', body.templateId).steps_json) : body.steps;
      const id = insert('INSERT INTO erp_orders(client_id,title,model,kind,priority,due_date,notes,steps_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', body.clientId, body.title, body.model, body.kind, body.priority, body.dueDate, body.notes, JSON.stringify(steps), now());
      receive(user, entity('erp_orders', id), body);
      materials.copyTemplate(user,id,body.templateId);
      event(user, 'order.created', 'order', id);
      return { id };
    },
    receiveUnits(user,id,body) { requireRole(user,['admin','manager','warehouse']); return receive(user,entity('erp_orders',id),body); },
    assign(user,body) {
      requireRole(user,['admin','manager']);
      const assignee = entity('users',body.userId);
      if (!['admin','manager','technician'].includes(role(assignee))) fail(400,'Оберіть активного майстра з доступом до виробництва');
      for (const selected of body.tasks) {
        const task = entity('erp_tasks',selected.id);
        version(task,selected.version);
        if (['in_progress','done'].includes(task.state)) fail(409,'Активну або завершену роботу не можна перепризначити');
        run("UPDATE erp_tasks SET assigned_to=?,crew_id=NULL,work_mode='individual',work_round=work_round+1,version=version+1 WHERE id=?",body.userId,task.id);
      }
      event(user,'tasks.assigned','user',body.userId,{tasks:body.tasks.map(t=>t.id)});
      return {count:body.tasks.length};
    },
    setMember(user,id,body) {
      requireRole(user,['admin']);
      const member=entity('users',id);
      if (member.role==='admin') fail(409,'Глобальний адміністратор зберігає повний доступ');
      if (activeShift(id) || get('SELECT id FROM erp_time_entries WHERE user_id=? AND ended_at IS NULL',id)) fail(409,'Спочатку закрийте зміну та активну роботу користувача');
      if (!['admin','manager','technician'].includes(body.role) && get('SELECT user_id FROM erp_crew_members m JOIN erp_crews c ON c.id=m.crew_id WHERE m.user_id=? AND c.archived=0',id)) fail(409,'Спочатку приберіть користувача з активних робочих команд');
      if (body.role==='none') run('DELETE FROM erp_members WHERE user_id=?',id);
      else run('INSERT INTO erp_members(user_id,role) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role',id,body.role);
      event(user,'member.updated','user',id,{role:body.role});
      return {id};
    },
    stockHistory(user,id) {
      requireRole(user,['admin','manager','warehouse','observer']);
      const lot=entity('erp_stock_lots',id);
      const uom=lot.material_id?entity('erp_materials',lot.material_id).uom:'pcs';
      return all('SELECT m.*,u.display_name AS actor FROM erp_stock_moves m JOIN users u ON u.id=m.actor_id WHERE lot_id=? ORDER BY m.id DESC LIMIT 200',id).map(m=>({...m,quantity:m.quantity/lot.quantity_scale,uom}));
    }
  };
}
