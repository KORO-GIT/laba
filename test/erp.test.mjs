import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createErp, MAX_SHIFT_MS } from '../src/erp-database.mjs';
import { registerErpRoutes } from '../src/erp-routes.mjs';

function fixture(context) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,display_name TEXT,role TEXT,enabled INTEGER DEFAULT 1);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
    INSERT INTO users VALUES(1,'owner@example.test','Owner','admin',1),(2,'a@example.test','A','viewer',1),(3,'b@example.test','B','viewer',1),(4,'qc@example.test','QC','viewer',1),(5,'outsider@example.test','No access','viewer',1);`);
  const erp=createErp(db);
  db.exec("INSERT INTO erp_members VALUES(2,'technician'),(3,'technician'),(4,'inspector')");
  const users=[null,...db.prepare('SELECT * FROM users ORDER BY id').all()];
  const app=Fastify();
  app.addHook('onRequest',async(request,reply)=>{
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(Number(request.headers['x-test-user']||1));
    if(!user?.enabled)return reply.code(401).send({error:'No access'});
    request.portalUser=user;
  });
  registerErpRoutes(app,erp);
  context.after(async()=>{await app.close();db.close();});
  const request=async(path,body,user=1,key=crypto.randomUUID(),headers={})=>{
    const response=await app.inject({method:body===undefined?'GET':'POST',url:`/api/erp/${path}`,headers:{host:'localhost',origin:'http://localhost','x-portal-request':'1','x-erp-request-id':key,'x-test-user':String(user),...headers},...(body===undefined?{}:{payload:body})});
    return {status:response.statusCode,body:response.json()};
  };
  const post=async(path,body,user=1)=>{const r=await request(path,body,user);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const get=async(path,user=1)=>{const r=await request(path,undefined,user);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  return {db,erp,users,request,post,get};
}
const steps=[{title:'Огляд',instructions:'Перевірити комплектність',plannedMinutes:5},{title:'Виконання замовлення',instructions:'За погодженим маршрутом',plannedMinutes:15}];
async function order(f,count=3,clientId) {
  clientId??=(await f.post('clients',{name:`Клієнт ${crypto.randomUUID()}`})).id;
  return f.post('orders',{clientId,title:'Партія майстерні',model:'Модель А',kind:'upgrade',priority:'normal',dueDate:null,steps,serials:Array.from({length:count-1},(_,i)=>`SN-${i+1}`),unnumbered:1,reference:'Прийомка 01'});
}
async function assign(f,id,worker=2) {
  const o=await f.get(`orders/${id}`);
  await f.post('assign',{userId:worker,tasks:o.tasks.map(t=>({id:t.id,version:t.version}))});
  return f.get(`orders/${id}`);
}
async function finishUnit(f,orderId,unitId,worker=2) {
  const detail=await f.get(`orders/${orderId}`);
  for(const task of detail.tasks.filter(t=>t.unit_id===unitId)) {
    await f.post(`tasks/${task.id}/action`,{action:'start',version:task.version},worker);
    const updated=(await f.get('context',worker)).myTasks.find(t=>t.id===task.id);
    await f.post(`tasks/${task.id}/action`,{action:'complete',version:updated.version},worker);
  }
}

test('ERP receives 150 serialised units atomically and preserves replay/duplicate invariants',async context=>{
  const f=fixture(context);
  const created=await order(f,150);
  const detail=await f.get(`orders/${created.id}`);
  assert.equal(detail.units.length,150);assert.equal(detail.tasks.length,300);
  assert.equal(detail.units.filter(u=>u.serial===null).length,1);
  assert.equal(new Set(detail.units.map(u=>u.code)).size,150);
  const key=crypto.randomUUID();
  const receipt={reference:'Прийомка 02',serials:['EXTRA'],unnumbered:0};
  const first=await f.request(`orders/${created.id}/receive`,receipt,1,key);
  const again=await f.request(`orders/${created.id}/receive`,receipt,1,key);
  assert.deepEqual(again,first);assert.equal(first.status,200);
  const duplicate=await f.request(`orders/${created.id}/receive`,{reference:'Дублі',serials:['NEW-OK','SN-1'],unnumbered:0});
  assert.equal(duplicate.status,409);
  assert.equal((await f.get(`orders/${created.id}`)).units.length,151,'the first row in failed receipt rolls back');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_receipts').get().n,2);
  assert.equal((await f.request(`orders/${created.id}/receive`,{...receipt,reference:'Other'},1,key)).status,409);
  const before=f.db.prepare('SELECT COUNT(*) AS n FROM erp_orders').get().n;
  const failed=await f.request('orders',{clientId:detail.client_id,title:'Duplicate intake',model:'Модель А',kind:'repair',priority:'normal',steps,serials:['SN-1'],unnumbered:0,reference:'X'});
  assert.equal(failed.status,409);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_orders').get().n,before);
});

test('ERP enforces assignment, sequence, shift time and independent quality before partial delivery',async context=>{
  const f=fixture(context);const {id}=await order(f);let detail=await assign(f,id);
  const [unit]=detail.units;const tasks=detail.tasks.filter(t=>t.unit_id===unit.id);
  assert.equal((await f.request(`tasks/${tasks[0].id}/action`,{action:'start',version:tasks[0].version},3)).status,403);
  assert.equal((await f.request(`tasks/${tasks[0].id}/action`,{action:'start',version:tasks[0].version},2)).status,409);
  await f.post('shifts/action',{action:'start'},2);
  assert.equal((await f.request(`tasks/${tasks[1].id}/action`,{action:'start',version:tasks[1].version},2)).status,409);
  await finishUnit(f,id,unit.id);
  detail=await f.get(`orders/${id}`);const readyForQc=detail.units[0];assert.equal(readyForQc.state,'quality');
  assert.equal((await f.request(`orders/${id}/deliver`,{reference:'Early',recipient:'Client',units:[{id:unit.id,version:readyForQc.version}]})).status,409);
  f.db.prepare("UPDATE erp_members SET role='manager' WHERE user_id=2").run();
  assert.equal((await f.request(`units/${unit.id}/quality`,{result:'pass',version:readyForQc.version,note:''},2)).status,409);
  await f.post(`units/${unit.id}/quality`,{result:'pass',version:readyForQc.version,note:'Перевірено'},4);
  detail=await f.get(`orders/${id}`);
  const delivery={reference:'Видача 01',recipient:'Представник клієнта',units:[{id:unit.id,version:detail.units[0].version}]};
  const key=crypto.randomUUID();const result=await f.request(`orders/${id}/deliver`,delivery,1,key);
  assert.equal(result.status,200);assert.deepEqual(await f.request(`orders/${id}/deliver`,delivery,1,key),result);
  detail=await f.get(`orders/${id}`);
  assert.equal(detail.units.filter(u=>u.state==='delivered').length,1);assert.equal(detail.units.filter(u=>u.state==='received').length,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries WHERE ended_at IS NOT NULL').get().n,2);
});

test('ERP cannot overspend stock, cross client ownership or deliver unresolved workbench material',async context=>{
  const f=fixture(context);const {id}=await order(f);const detail=await assign(f,id);const unit=detail.units[0];
  const clientB=await f.post('clients',{name:'Інший клієнт'});
  const lotB=await f.post('stock',{sku:'B',name:'Деталь',clientId:clientB.id,condition:'new',reference:'Поставка',quantity:2});
  const move={from:'warehouse',to:'workbench',unitId:unit.id,quantity:1,note:'Видача майстру'};
  assert.equal((await f.request(`stock/${lotB.id}/move`,move)).status,409);
  const lot=await f.post('stock',{sku:'A',name:'Деталь',clientId:detail.client_id,condition:'new',reference:'Поставка',quantity:1});
  const results=await Promise.all([f.request(`stock/${lot.id}/move`,move),f.request(`stock/${lot.id}/move`,move)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await f.request(`stock/${lot.id}/move`,{from:'workbench',to:'installed',unitId:unit.id,quantity:1,note:'Встановив'},3)).status,403);
  await f.post('shifts/action',{action:'start'},2);await finishUnit(f,id,unit.id);
  let current=(await f.get(`orders/${id}`)).units[0];
  assert.equal((await f.request(`units/${unit.id}/quality`,{result:'pass',version:current.version,note:''},4)).status,409);
  await f.post(`stock/${lot.id}/move`,{from:'workbench',to:'installed',unitId:unit.id,quantity:1,note:'Встановив'},2);
  assert.equal((await f.request(`units/${unit.id}/quality`,{result:'pass',version:current.version,note:''},4)).status,409,'stock movement invalidates stale QC form');
  current=(await f.get(`orders/${id}`)).units[0];
  await f.post(`units/${unit.id}/quality`,{result:'pass',version:current.version,note:''},4);
  const stock=(await f.get('context')).stock.find(l=>l.id===lot.id);
  assert.equal(stock.warehouse,0);assert.equal(stock.workbench,0);assert.equal(stock.installed,1);
  assert.throws(()=>f.db.prepare('DELETE FROM erp_stock_moves WHERE lot_id=?').run(lot.id),/append-only/);
  assert.throws(()=>f.db.prepare("UPDATE erp_events SET action='erased'").run(),/append-only/);
});

test('ERP refuses cross-origin, forged roles, disabled and unassigned users; technician sees only their work',async context=>{
  const f=fixture(context);const {id}=await order(f);await assign(f,id);
  assert.equal((await f.request('context',undefined,5)).status,403);
  assert.equal((await f.request('context',undefined,99)).status,401);
  assert.equal((await f.request(`orders/${id}`,undefined,2)).status,403);
  assert.equal((await f.request('clients',{name:'No'},2)).status,403);
  assert.equal((await f.request('members/3',{role:'admin'},2)).status,403);
  assert.equal((await f.request('clients',{name:'X'},1,crypto.randomUUID(),{origin:'https://other.test'})).status,403);
  assert.equal((await f.request('clients',{name:'X'},1,crypto.randomUUID(),{origin:'http://localhost:8080'})).status,403);
  assert.equal((await f.request('clients',{name:'X'},1,crypto.randomUUID(),{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await f.request('clients',{name:'X'},1,crypto.randomUUID(),{'x-portal-request':'0'})).status,403);
  assert.equal((await f.request('clients',{name:'X'},1,'invalid')).status,400);
  assert.equal((await f.request('clients',{name:'X',role:'admin'})).status,400);
  const own=await f.get('context',2);assert.equal(own.myTasks.length,6);assert.equal(own.orders,undefined);assert.equal(own.team,undefined);assert.equal(own.clients,undefined);assert.equal(own.events,undefined);
  const other=await f.get('context',3);assert.equal(other.myTasks.length,0);
  f.db.prepare('UPDATE users SET enabled=0 WHERE id=2').run();assert.equal((await f.request('context',undefined,2)).status,401);
});

test('ERP pause and end stop running timers and protect concurrent/stale changes',async context=>{
  const f=fixture(context);const {id}=await order(f);let detail=await assign(f,id);const task=detail.tasks[0];
  await f.post('shifts/action',{action:'start'},2);await f.post(`tasks/${task.id}/action`,{action:'start',version:task.version},2);
  let own=await f.get('context',2);const shift=own.shifts[0];
  await f.post('shifts/action',{action:'pause',version:shift.version},2);
  own=await f.get('context',2);assert.equal(own.myTasks.find(t=>t.id===task.id).state,'paused');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries WHERE ended_at IS NULL').get().n,0);
  assert.equal((await f.request('shifts/action',{action:'end',version:shift.version},2)).status,409);
  await f.post('shifts/action',{action:'resume',version:own.shifts[0].version},2);
  own=await f.get('context',2);await f.post(`tasks/${task.id}/action`,{action:'start',version:own.myTasks.find(t=>t.id===task.id).version},2);
  own=await f.get('context',2);await f.post('shifts/action',{action:'end',version:own.shifts[0].version},2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries WHERE ended_at IS NULL').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_shift_intervals WHERE ended_at IS NULL').get().n,0);
  assert.equal(f.db.prepare("SELECT state FROM erp_tasks WHERE id=?").get(task.id).state,'paused');
});

test('ERP rework preserves time history and reopens downstream operations',async context=>{
  const f=fixture(context);const {id}=await order(f);let detail=await assign(f,id);const unit=detail.units[0];
  await f.post('shifts/action',{action:'start'},2);await finishUnit(f,id,unit.id);
  detail=await f.get(`orders/${id}`);
  await f.post(`units/${unit.id}/quality`,{result:'rework',version:detail.units[0].version,taskId:detail.tasks[0].id,note:'Повторити перевірку'},4);
  const after=await f.get(`orders/${id}`);assert.equal(after.units[0].state,'working');
  assert.ok(after.tasks.filter(t=>t.unit_id===unit.id).every(t=>t.state==='pending'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries').get().n,2);
  assert.equal(after.quality.length,1);
  assert.equal((await f.request(`tasks/${after.tasks[0].id}/action`,{action:'complete',version:after.tasks[0].version},2)).status,409);
});

test('ERP caps abandoned shifts at 16 hours and never grants access to other LABA modules',async context=>{
  const f=fixture(context);const member=await f.post('members',{name:'Новий майстер',email:'new@example.test',role:'technician'});
  const user=f.db.prepare('SELECT * FROM users WHERE id=?').get(member.id);assert.equal(user.role,'viewer');
  assert.equal(f.erp.role(user),'technician');
  await f.post('shifts/action',{action:'start'},2);
  const old=Date.now()-MAX_SHIFT_MS-3600000;
  f.db.prepare('UPDATE erp_shifts SET started_at=? WHERE user_id=2').run(old);
  f.db.prepare('UPDATE erp_shift_intervals SET started_at=?').run(old);
  const own=await f.get('context',2);assert.equal(own.shifts[0].elapsed_ms,MAX_SHIFT_MS);
  await f.post('shifts/action',{action:'end',version:own.shifts[0].version},2);
  assert.equal(f.db.prepare('SELECT ended_at-started_at AS duration FROM erp_shifts WHERE user_id=2').get().duration,MAX_SHIFT_MS);
});
