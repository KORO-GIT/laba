export function migrateCrews(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS erp_crews (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT '', lead_id INTEGER NOT NULL REFERENCES users(id),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS erp_crew_members (
      crew_id INTEGER NOT NULL REFERENCES erp_crews(id), user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY(crew_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS erp_crew_user ON erp_crew_members(user_id,crew_id);
    CREATE TABLE IF NOT EXISTS erp_task_participants (
      task_id INTEGER NOT NULL REFERENCES erp_tasks(id), work_round INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      state TEXT NOT NULL CHECK(state IN ('active','paused','finished')),
      note TEXT NOT NULL DEFAULT '', PRIMARY KEY(task_id,work_round,user_id)
    );
  `);
  for (const [table, name, definition] of [
    ['erp_tasks', 'crew_id', 'INTEGER REFERENCES erp_crews(id)'],
    ['erp_tasks', 'work_mode', "TEXT NOT NULL DEFAULT 'individual' CHECK(work_mode IN ('individual','pool','shared'))"],
    ['erp_tasks', 'work_round', 'INTEGER NOT NULL DEFAULT 1'],
    ['erp_time_entries', 'crew_id', 'INTEGER REFERENCES erp_crews(id)'],
    ['erp_time_entries', 'work_round', 'INTEGER NOT NULL DEFAULT 1']
  ]) {
    if (!db.pragma(`table_info(${table})`).some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS erp_tasks_crew ON erp_tasks(crew_id,state);
    CREATE INDEX IF NOT EXISTS erp_time_crew ON erp_time_entries(crew_id,user_id);
    CREATE INDEX IF NOT EXISTS erp_participant_user ON erp_task_participants(user_id,task_id);`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(name) VALUES(?)').run('erp_crews_v1');
}

// All writes are called inside the existing ERP command's IMMEDIATE transaction.
export function createCrewFeatures({ db, get, all, run, insert, entity, version, role, requireRole, manages, event, fail, now, activeShift, maxShiftMs }) {
  const member = (crewId, userId) => Boolean(get(`SELECT m.user_id FROM erp_crew_members m JOIN erp_crews c ON c.id=m.crew_id WHERE m.crew_id=? AND m.user_id=? AND c.archived=0`, crewId, userId));
  const eligible = user => ['admin','manager','technician'].includes(role(user));
  const participants = task => all('SELECT * FROM erp_task_participants WHERE task_id=? AND work_round=?', task.id, task.work_round);
  const isLeader = (task, user) => manages(user) || get('SELECT lead_id FROM erp_crews WHERE id=?', task.crew_id)?.lead_id === user.id;
  const stopOwnTimer = (taskId, userId, time) => run('UPDATE erp_time_entries SET ended_at=MAX(started_at,MIN(?,(SELECT started_at+? FROM erp_shifts WHERE id=shift_id))) WHERE task_id=? AND user_id=? AND ended_at IS NULL', time, maxShiftMs, taskId, userId);
  function refreshShared(task, fallback = 'paused') {
    const active = get('SELECT id FROM erp_time_entries WHERE task_id=? AND ended_at IS NULL', task.id);
    run('UPDATE erp_tasks SET state=?,version=version+1 WHERE id=?', active ? 'in_progress' : fallback, task.id);
  }
  function stopUserTasks(userId, time) {
    for (const task of all('SELECT t.* FROM erp_tasks t JOIN erp_time_entries e ON e.task_id=t.id WHERE e.user_id=? AND e.ended_at IS NULL', userId)) {
      stopOwnTimer(task.id, userId, time);
      if (task.work_mode === 'shared') {
        run("UPDATE erp_task_participants SET state='paused' WHERE task_id=? AND work_round=? AND user_id=?", task.id, task.work_round, userId);
        refreshShared(task);
      } else run("UPDATE erp_tasks SET state='paused',version=version+1 WHERE id=?", task.id);
    }
  }
  function listCrews(user) {
    const management = manages(user) || role(user) === 'observer';
    return all(`SELECT c.*,u.display_name AS lead_name,
      (SELECT COUNT(*) FROM erp_tasks WHERE crew_id=c.id AND state!='done') AS open_tasks,
      (SELECT COUNT(*) FROM erp_tasks WHERE crew_id=c.id AND state='done') AS done_tasks,
      (SELECT COUNT(*) FROM erp_time_entries WHERE crew_id=c.id AND ended_at IS NULL) AS active_people,
      (SELECT COALESCE(SUM(MAX(0,COALESCE(e.ended_at,MIN(?,s.started_at+?))-e.started_at)),0) FROM erp_time_entries e JOIN erp_shifts s ON s.id=e.shift_id WHERE e.crew_id=c.id) AS work_ms
      FROM erp_crews c JOIN users u ON u.id=c.lead_id
      WHERE ? OR (c.archived=0 AND EXISTS(SELECT 1 FROM erp_crew_members WHERE crew_id=c.id AND user_id=?)) ORDER BY c.archived,c.name`, now(), maxShiftMs, management ? 1 : 0, user.id).map(crew => ({
        ...crew, members: all(`SELECT u.id,u.display_name,u.enabled FROM erp_crew_members m JOIN users u ON u.id=m.user_id WHERE m.crew_id=? ORDER BY u.display_name,u.id`, crew.id)
      }));
  }
  function saveCrew(user, id, body) {
    requireRole(user, ['admin','manager']);
    if (!body.members.includes(body.leadId)) fail(400, 'Старший має входити до складу команди');
    for (const userId of body.members) if (!eligible(entity('users', userId))) fail(400, 'До команди можна додати лише активного майстра або керівника з ERP-доступом');
    let before = null;
    if (id) {
      before = entity('erp_crews', id); version(before, body.version);
      const oldMembers = all('SELECT user_id FROM erp_crew_members WHERE crew_id=?', id).map(row => row.user_id);
      before = { ...before, members: oldMembers };
      if (body.archived && get("SELECT id FROM erp_tasks WHERE crew_id=? AND state!='done'", id)) fail(409, 'Спочатку завершіть або перепризначте незавершені роботи команди');
      for (const userId of oldMembers.filter(value => !body.members.includes(value))) {
        if (get(`SELECT t.id FROM erp_tasks t WHERE t.crew_id=? AND t.state!='done' AND
          (t.assigned_to=? OR EXISTS(SELECT 1 FROM erp_task_participants p WHERE p.task_id=t.id AND p.work_round=t.work_round AND p.user_id=? AND p.state!='finished'))`, id, userId, userId)) fail(409, 'Учасник має незавершену роботу в команді. Спочатку завершіть внесок або перепризначте роботу');
      }
      run('UPDATE erp_crews SET name=?,description=?,lead_id=?,archived=?,version=version+1 WHERE id=?', body.name, body.description, body.leadId, body.archived ? 1 : 0, id);
      run('DELETE FROM erp_crew_members WHERE crew_id=?', id);
    } else {
      if (get('SELECT COUNT(*) AS count FROM erp_crews').count >= 200) fail(409, 'Досягнуто межі 200 команд. Потрібне розширення реєстру');
      id = insert('INSERT INTO erp_crews(name,description,lead_id) VALUES(?,?,?)', body.name, body.description, body.leadId);
    }
    for (const userId of body.members) run('INSERT INTO erp_crew_members VALUES(?,?)', id, userId);
    event(user, before ? 'crew.updated' : 'crew.created', 'crew', id, { before, after: body });
    return { id };
  }
  function assignCrew(user, body) {
    requireRole(user, ['admin','manager']);
    const crew = entity('erp_crews', body.crewId);
    if (crew.archived) fail(409, 'Команда в архіві');
    if (!all('SELECT u.* FROM users u JOIN erp_crew_members m ON m.user_id=u.id WHERE m.crew_id=?', crew.id).some(eligible)) fail(409, 'У команди немає активних виконавців');
    for (const selected of body.tasks) {
      const task = entity('erp_tasks', selected.id); version(task, selected.version);
      if (['in_progress','done'].includes(task.state) || get('SELECT id FROM erp_time_entries WHERE task_id=? AND ended_at IS NULL', task.id)) fail(409, 'Активну або завершену операцію не можна перепризначити');
      run("UPDATE erp_tasks SET crew_id=?,work_mode=?,assigned_to=NULL,state='pending',work_round=work_round+1,version=version+1 WHERE id=?", crew.id, body.mode, task.id);
    }
    event(user, 'crew.assigned', 'crew', crew.id, { mode: body.mode, tasks: body.tasks.map(task => task.id) });
    return { count: body.tasks.length };
  }
  function sharedAction(user, task, body) {
    const time = now();
    const participant = get('SELECT * FROM erp_task_participants WHERE task_id=? AND work_round=? AND user_id=?', task.id, task.work_round, user.id);
    if (task.state === 'done') fail(409, 'Операцію вже завершено');
    if (body.action === 'complete') {
      if (!isLeader(task, user)) fail(403, 'Спільну операцію закриває старший команди або керівник');
      const people = participants(task);
      if (!people.length || people.some(person => person.state !== 'finished') || get('SELECT id FROM erp_time_entries WHERE task_id=? AND ended_at IS NULL', task.id)) fail(409, 'Кожен учасник має спочатку завершити свій внесок. Чужі таймери не зупиняються автоматично');
      run("UPDATE erp_tasks SET state='done',completed_by=?,completed_at=?,note=?,version=version+1 WHERE id=?", user.id, time, body.note, task.id);
      if (!get("SELECT id FROM erp_tasks WHERE unit_id=? AND state!='done'", task.unit_id)) run("UPDATE erp_units SET state='quality',version=version+1 WHERE id=?", task.unit_id);
    } else {
      if (!member(task.crew_id, user.id)) fail(403, 'Ви не входите до цієї робочої команди');
      if (body.action === 'start') {
        if (participant?.state === 'active') fail(409, 'Ваш таймер уже працює');
        const shift = activeShift(user.id);
        if (!shift || shift.state !== 'active' || time - shift.started_at >= maxShiftMs) fail(409, 'Спочатку відкрийте активну зміну тривалістю до 16 годин');
        if (get('SELECT id FROM erp_time_entries WHERE user_id=? AND ended_at IS NULL', user.id)) fail(409, 'Спочатку призупиніть свою поточну роботу');
        if (get("SELECT id FROM erp_tasks WHERE unit_id=? AND sequence<? AND state!='done'", task.unit_id, task.sequence)) fail(409, 'Попередня операція ще не завершена');
        run("INSERT INTO erp_task_participants(task_id,work_round,user_id,state) VALUES(?,?,?,'active') ON CONFLICT(task_id,work_round,user_id) DO UPDATE SET state='active'", task.id, task.work_round, user.id);
        insert('INSERT INTO erp_time_entries(task_id,user_id,shift_id,started_at,crew_id,work_round) VALUES(?,?,?,?,?,?)', task.id, user.id, shift.id, time, task.crew_id, task.work_round);
        refreshShared(task);
        run("UPDATE erp_units SET state='working',version=version+1 WHERE id=?", task.unit_id);
      } else {
        if (!participant || participant.state === 'finished') fail(409, 'Спочатку почніть свій внесок');
        if (body.action === 'block' && !body.note) fail(400, 'Вкажіть причину перешкоди');
        if (!['pause','block','finish_part'].includes(body.action)) fail(400, 'Невідома дія');
        if (body.action === 'pause' && participant.state !== 'active') fail(409, 'Ваш таймер уже на паузі');
        stopOwnTimer(task.id, user.id, time);
        run('UPDATE erp_task_participants SET state=?,note=? WHERE task_id=? AND work_round=? AND user_id=?', body.action === 'finish_part' ? 'finished' : 'paused', body.note, task.id, task.work_round, user.id);
        if (body.action === 'block') run('UPDATE erp_tasks SET note=? WHERE id=?', body.note, task.id);
        refreshShared(task, body.action === 'block' ? 'blocked' : 'paused');
      }
    }
    event(user, `task.${body.action}`, 'task', task.id, { unitId: task.unit_id, crewId: task.crew_id, workRound: task.work_round, note: body.note });
    return { id: task.id };
  }
  function decorateTask(task, user) {
    const shared = task.work_mode === 'shared';
    return { ...task,
      my_active: Boolean(get('SELECT id FROM erp_time_entries WHERE task_id=? AND user_id=? AND ended_at IS NULL', task.id, user.id)),
      can_start: eligible(user) && (task.crew_id ? member(task.crew_id,user.id) && (shared || task.assigned_to===null || task.assigned_to===user.id) : task.assigned_to===user.id),
      my_elapsed_ms: get('SELECT COALESCE(SUM(MAX(0,COALESCE(e.ended_at,MIN(?,s.started_at+?))-e.started_at)),0) AS ms FROM erp_time_entries e JOIN erp_shifts s ON s.id=e.shift_id WHERE e.task_id=? AND e.user_id=?', now(), maxShiftMs, task.id, user.id).ms,
      can_finalize: shared && isLeader(task, user),
      contributors: shared ? all(`SELECT p.*,u.display_name AS name FROM erp_task_participants p JOIN users u ON u.id=p.user_id WHERE p.task_id=? AND p.work_round=? ORDER BY p.user_id`, task.id, task.work_round) : []
    };
  }
  function workHistory(user, id) {
    requireRole(user, ['admin','manager','warehouse','inspector','observer']);
    entity('erp_tasks', id);
    return all(`SELECT e.user_id,u.display_name AS name,e.work_round,e.crew_id,c.name AS crew_name,
      SUM(MAX(0,COALESCE(e.ended_at,MIN(?,s.started_at+?))-e.started_at)) AS elapsed_ms,
      COUNT(*) AS intervals,MIN(e.started_at) AS started_at,MAX(e.ended_at IS NULL) AS active
      FROM erp_time_entries e JOIN users u ON u.id=e.user_id JOIN erp_shifts s ON s.id=e.shift_id
      LEFT JOIN erp_crews c ON c.id=e.crew_id WHERE e.task_id=? GROUP BY e.user_id,e.work_round,e.crew_id ORDER BY e.work_round,e.user_id`, now(), maxShiftMs, id);
  }
  return { member, listCrews, saveCrew, assignCrew, sharedAction, stopUserTasks, decorateTask, workHistory };
}
