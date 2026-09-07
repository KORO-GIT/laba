import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createErp, MAX_SHIFT_MS } from '../src/erp-database.mjs';
import { registerErpRoutes } from '../src/erp-routes.mjs';

test('ERP crews validate members, permissions, revisions and team queue isolation',async context=>{
  const f=fixture(context); const c=await crew(f);
  assert.equal((await f.request('crews',{name:'Bad',leadId:2,members:[3]})).status,400);
  assert.equal((await f.request('crews',{name:'Bad',leadId:4,members:[4]})).status,400);
  assert.equal((await f.request('crews',{name:'Bad',leadId:2,members:[2,2]})).status,400);
  assert.equal((await f.request('crews',{name:'Bad',leadId:2,members:[2]},2)).status,403);
  assert.equal((await f.request(`crews/${c.group.id}/tasks`,undefined,5)).status,403);
  f.db.exec("INSERT INTO erp_members VALUES(5,'technician')");
  assert.equal((await f.request(`crews/${c.group.id}/tasks`,undefined,5)).status,403);
  assert.deepEqual((await f.get('context',5)).crews,[]);
  const own=await f.get('context',2);
  assert.equal(own.crews.length,1);assert.equal(own.team,undefined);assert.equal(own.clients,undefined);
  assert.equal(own.crews[0].members[0].email,undefined,'no coworker email disclosure to technician');
  const edited={name:own.crews[0].name,leadId:2,members:[2,3],description:'Updated',archived:false,version:1};
  await f.post(`crews/${c.group.id}`,edited);
  assert.equal((await f.request(`crews/${c.group.id}`,edited)).status,409);
  assert.equal((await f.request(`crews/${c.group.id}`,{...edited,version:2,archived:true})).status,409);
  assert.equal((await f.request('members/2',{role:'observer'})).status,409);
});

test('ERP team batch queue atomically claims one worker and paginates all 150 units',async context=>{
  const f=fixture(context);const c=await crew(f,'pool',150);
  const first=await f.get(`crews/${c.group.id}/tasks?taskState=open&page=0`,2);
  const second=await f.get(`crews/${c.group.id}/tasks?taskState=open&page=1`,3);
  assert.equal(first.count,300);assert.equal(first.tasks.length,50);assert.notEqual(first.tasks[0].id,second.tasks[0].id);
  const search=await f.get(`crews/${c.group.id}/tasks?q=sn-149`,2);assert.equal(search.count,2);
  await f.post('shifts/action',{action:'start'},2);await f.post('shifts/action',{action:'start'},3);
  const body={action:'start',version:first.tasks[0].version};const key=crypto.randomUUID();
  const winner=await f.request(`tasks/${c.taskId}/action`,body,2,key);assert.equal(winner.status,200);
  const loser=await f.request(`tasks/${c.taskId}/action`,body,3);assert.ok([403,409].includes(loser.status));
  assert.equal((await f.request(`tasks/${c.taskId}/action`,body,2,key)).status,200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries WHERE task_id=?').get(c.taskId).n,1);
  assert.equal(freshTask(f,c.taskId).assigned_to,2);
  await taskDo(f,c.taskId,'pause');
  const group=(await f.get('context')).crews[0];
  assert.equal((await f.request(`crews/${group.id}`,{name:group.name,description:'',members:[3],leadId:3,archived:false,version:group.version})).status,409);
  await taskDo(f,c.taskId,'start');await taskDo(f,c.taskId,'complete');
  const lot=await f.post('stock',{sku:'TEAM',name:'Деталь команди',clientId:null,condition:'new',reference:'Synthetic',quantity:1});
  await f.post(`stock/${lot.id}/move`,{from:'warehouse',to:'workbench',unitId:c.unitId,quantity:1,note:'Для команди'});
  await f.post(`crews/${group.id}`,{name:group.name,description:'',members:[3],leadId:3,archived:false,version:group.version});
  assert.equal((await f.request(`crews/${group.id}/tasks`,undefined,2)).status,403);
  assert.equal((await f.request(`stock/${lot.id}/move`,{from:'workbench',to:'installed',unitId:c.unitId,quantity:1,note:'Колишній учасник'},2)).status,403,'historical team assignment must not retain material permissions after removal');
  assert.equal((await f.get(`tasks/${c.taskId}/work-history`)).length,1,'removing member preserves historical time');
});

test('ERP shared operation keeps individual timers, shift pauses and explicit team completion',async context=>{
  const f=fixture(context);const c=await crew(f);
  await f.post('shifts/action',{action:'start'},2);await f.post('shifts/action',{action:'start'},3);
  await taskDo(f,c.taskId,'start',2);await taskDo(f,c.taskId,'start',3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries WHERE ended_at IS NULL').get().n,2);
  assert.equal((await f.get('context')).team.filter(u=>u.current?.id===c.taskId).length,2);
  const two=(await f.get('context',2)).shifts[0];
  await f.post('shifts/action',{action:'pause',version:two.version},2);
  assert.equal(freshTask(f,c.taskId).state,'in_progress');
  assert.equal(f.db.prepare('SELECT user_id FROM erp_time_entries WHERE ended_at IS NULL').get().user_id,3);
  await taskDo(f,c.taskId,'finish_part',2);
  assert.equal((await f.request(`tasks/${c.taskId}/action`,{action:'complete',version:freshTask(f,c.taskId).version},2)).status,409);
  await taskDo(f,c.taskId,'finish_part',3);
  assert.equal((await f.request(`tasks/${c.taskId}/action`,{action:'complete',version:freshTask(f,c.taskId).version},3)).status,403);
  await taskDo(f,c.taskId,'complete',2);
  assert.equal(freshTask(f,c.taskId).state,'done');
  const history=await f.get(`tasks/${c.taskId}/work-history`);
  assert.deepEqual(history.map(row=>row.user_id),[2,3]);assert.ok(history.every(row=>row.crew_id===c.group.id));
  assert.equal((await f.request(`tasks/${c.taskId}/work-history`,undefined,2)).status,403);
  const ctx=await f.get('context');assert.equal(ctx.team.find(u=>u.id===3).contributions,1);
});

test('ERP shared work cannot run alongside individual work or be closed by someone else ending a shift',async context=>{
  const f=fixture(context);const c=await crew(f);const individual=await order(f,1);await assign(f,individual.id,2);
  await f.post('shifts/action',{action:'start'},2);await f.post('shifts/action',{action:'start'},3);
  await taskDo(f,c.taskId,'start',2);await taskDo(f,c.taskId,'start',3);
  const personal=(await f.get(`orders/${individual.id}`)).tasks[0];
  assert.equal((await f.request(`tasks/${personal.id}/action`,{action:'start',version:personal.version},2)).status,409);
  const shift=(await f.get('context',2)).shifts[0];
  await f.post('members/2/close-shift',{version:shift.version,endedAt:Date.now(),reason:'Завершення робочого дня'});
  assert.equal(freshTask(f,c.taskId).state,'in_progress');assert.equal(f.db.prepare('SELECT user_id FROM erp_time_entries WHERE ended_at IS NULL').get().user_id,3);
  const group=(await f.get('context')).crews[0];
  assert.equal((await f.request(`crews/${group.id}`,{name:group.name,description:'',members:[3],leadId:3,archived:false,version:group.version})).status,409);
  const live=freshTask(f,c.taskId);
  assert.equal((await f.request('assign',{userId:2,tasks:[{id:live.id,version:live.version}]})).status,409);
});

test('ERP shared rework keeps historical contributions and prevents self quality after reassignment',async context=>{
  const f=fixture(context);const c=await crew(f);
  await f.post('shifts/action',{action:'start'},2);await f.post('shifts/action',{action:'start'},3);
  for(const task of (await f.get(`orders/${c.orderId}`)).tasks) {
    for(const user of [2,3]) {await taskDo(f,task.id,'start',user);await taskDo(f,task.id,'finish_part',user);}
    await taskDo(f,task.id,'complete',2);
  }
  const unit=f.db.prepare('SELECT * FROM erp_units WHERE id=?').get(c.unitId);
  assert.equal(unit.state,'quality');
  // Historical worker temporarily gains QC-capable role; it must not bypass independence.
  f.db.prepare("UPDATE erp_members SET role='manager' WHERE user_id=3").run();
  assert.equal((await f.request(`units/${unit.id}/quality`,{result:'pass',version:unit.version},3)).status,409);
  await f.post(`units/${unit.id}/quality`,{result:'rework',note:'Повторна перевірка',taskId:c.taskId,version:unit.version},4);
  assert.equal(freshTask(f,c.taskId).work_round,3);
  await taskDo(f,c.taskId,'start',3);await taskDo(f,c.taskId,'finish_part',3);await taskDo(f,c.taskId,'complete',2);
  const history=await f.get(`tasks/${c.taskId}/work-history`);
  assert.equal(history.length,3);assert.deepEqual(history.map(r=>r.work_round),[2,2,3]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_task_participants WHERE task_id=?').get(c.taskId).n,3);
});

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
async function crew(f, mode='shared', count=1) {
  const group=await f.post('crews',{name:`Бригада ${crypto.randomUUID()}`,leadId:2,members:[2,3],description:'Спільний ремонт'});
  const created=await order(f,count);
  const detail=await f.get(`orders/${created.id}`);
  await f.post('assign-crew',{crewId:group.id,mode,tasks:detail.tasks.map(t=>({id:t.id,version:t.version}))});
  return {group,orderId:created.id,unitId:detail.units[0].id,taskId:detail.tasks[0].id};
}
const freshTask=(f,id)=>f.db.prepare('SELECT * FROM erp_tasks WHERE id=?').get(id);
const createMaterial=(f,overrides={})=>f.post('materials',{sku:`MAT-${crypto.randomUUID()}`,name:'Витратний матеріал',uom:'pcs',minimum:0,target:0,...overrides});
const receiveMaterial=(f,materialId,quantity,overrides={})=>f.post('stock',{materialId,sku:'ignored',name:'ignored',quantity,condition:'new',reference:'Synthetic receipt',...overrides});
const materialRow=async(f,id,owner=null)=>(await f.get('context')).materialPlanning.rows.find(r=>r.materialId===id&&r.clientId===owner);
const setOrderNorm=(f,orderId,lines,version=0)=>f.post(`orders/${orderId}/materials`,{version,lines});
const taskDo=(f,id,action,user=2)=>f.post(`tasks/${id}/action`,{action,version:freshTask(f,id).version},user);
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

test('ERP materials preserve legacy stock, normalize SKU, enforce units and catalogue roles',async context=>{
  const f=fixture(context);
  const legacy=await f.post('stock',{sku:' old-1 ',name:'Old item',quantity:5,condition:'new',reference:'Legacy'});
  const material=await createMaterial(f,{sku:'OLD-1',minimum:2,target:10});
  assert.equal((await materialRow(f,material.id)).warehouseMilli,0,'unlinked legacy lots must not silently count');
  assert.equal((await f.request('materials',{sku:'old-1',name:'Duplicate',uom:'pcs',minimum:0,target:0})).status,409);
  assert.equal((await f.request(`stock/${legacy.id}/link-material`,{materialId:material.id},2)).status,403);
  await f.post(`stock/${legacy.id}/link-material`,{materialId:material.id});
  assert.equal((await materialRow(f,material.id)).warehouseMilli,5000);
  assert.equal(f.db.prepare('SELECT quantity FROM erp_stock_moves WHERE lot_id=?').get(legacy.id).quantity,5);
  assert.equal((await f.get(`stock/${legacy.id}/history`))[0].quantity,5);
  assert.equal((await f.request('stock',{sku:'X',name:'X',materialId:material.id,quantity:0.5,condition:'new',reference:'Bad'})).status,400);
  assert.equal((await f.request(`materials/${material.id}`,{sku:'OLD-1',name:'Changed',uom:'m',minimum:0,target:0,version:1})).status,409);
  assert.equal((await f.request('materials',{sku:'M',name:'M',uom:'g',minimum:5,target:2})).status,400);
  assert.equal((await f.request('materials',{sku:'M',name:'M',uom:'g',minimum:0.0001,target:2})).status,400);
});

test('ERP material templates snapshot norms without spending and count all receipt units',async context=>{
  const f=fixture(context),material=await createMaterial(f),client=await f.post('clients',{name:'Norm client'});
  const template=await f.post('templates',{name:'Модернізація А',steps});
  await f.post(`templates/${template.id}/materials`,{version:0,lines:[{materialId:material.id,quantity:2,source:'workshop'}]});
  const created=await f.post('orders',{clientId:client.id,title:'Norm order',model:'A',kind:'upgrade',priority:'normal',steps,templateId:template.id,serials:[],unnumbered:150,reference:'150 units'});
  assert.equal((await materialRow(f,material.id)).demandMilli,300000);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_stock_moves').get().n,0);
  await f.post(`templates/${template.id}/materials`,{version:1,lines:[{materialId:material.id,quantity:3,source:'workshop'}]});
  assert.equal((await f.get(`orders/${created.id}`)).materialSpec.lines[0].quantityMilli,2000);
  await f.post(`orders/${created.id}/receive`,{serials:[],unnumbered:2,reference:'Additional'});
  assert.equal((await materialRow(f,material.id)).demandMilli,304000);
  assert.equal((await f.request(`templates/${template.id}/materials`,{version:1,lines:[]})).status,409);
  assert.equal((await f.request(`orders/${created.id}/materials`,{version:1,lines:[{materialId:material.id,quantity:1,source:'workshop'},{materialId:material.id,quantity:1,source:'workshop'}]})).status,400);
});

test('ERP material replenishment calculates projected shortages and partial receipts without duplicate requests',async context=>{
  const f=fixture(context),material=await createMaterial(f,{minimum:20,target:50}),created=await order(f,150);
  await setOrderNorm(f,created.id,[{materialId:material.id,quantity:2,source:'workshop'}]);
  await receiveMaterial(f,material.id,200);
  let row=await materialRow(f,material.id);assert.equal(row.projectedMilli,-100000);assert.equal(row.suggestedMilli,150000);assert.equal(row.low,true);
  const request=await f.post('replenishments',{materialId:material.id,quantity:150,note:'Потреба 150 виробів'});
  assert.equal((await f.request('replenishments',{materialId:material.id,quantity:150,note:'Duplicate'})).status,409);
  row=await materialRow(f,material.id);assert.equal(row.warehouseMilli,200000);assert.equal(row.requestedMilli,150000);assert.equal(row.suggestedMilli,0);assert.equal(row.low,true,'a request is not stock');
  await receiveMaterial(f,material.id,50,{replenishmentId:request.id});
  row=await materialRow(f,material.id);assert.equal(row.warehouseMilli,250000);assert.equal(row.requestedMilli,100000);
  await receiveMaterial(f,material.id,100,{replenishmentId:request.id});
  row=await materialRow(f,material.id);assert.equal(row.warehouseMilli,350000);assert.equal(row.projectedMilli,50000);assert.equal(row.low,false);
  assert.equal((await f.get('replenishments')).rows[0].state,'received');
  assert.equal((await f.request('stock',{materialId:material.id,replenishmentId:request.id,sku:'X',name:'X',quantity:1,condition:'new',reference:'Extra'})).status,409);
});

test('ERP material consumption uses fixed point quantities and never spends the same norm twice',async context=>{
  const f=fixture(context),material=await createMaterial(f,{uom:'m'}),created=await order(f,3);
  await setOrderNorm(f,created.id,[{materialId:material.id,quantity:0.125,source:'workshop'}]);
  const lot=await receiveMaterial(f,material.id,1);
  const detail=await f.get(`orders/${created.id}`),key=crypto.randomUUID();
  const body={specVersion:1,units:detail.units.map(u=>({id:u.id,version:u.version})),note:'Фактично використано'};
  const previewPath=`orders/${created.id}/material-preview?units=${detail.units.map(u=>u.id).join(',')}`;
  const quote=await f.get(previewPath);assert.equal(quote.canConsume,true);assert.deepEqual(quote.units,body.units);
  assert.equal(quote.lines[0].consumeMilli,375);assert.equal(quote.lines[0].warehouseRequiredMilli,375);
  assert.equal((await f.request(previewPath,undefined,2)).status,403);
  assert.equal((await f.request(`orders/${created.id}/material-preview?units=1,1`)).status,400);
  assert.equal((await f.request(`orders/${created.id}/material-preview?units=-1`)).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_stock_moves').get().n,1,'preview is read-only');
  const first=await f.request(`orders/${created.id}/consume-materials`,body,1,key);assert.equal(first.status,200);
  assert.deepEqual(await f.request(`orders/${created.id}/consume-materials`,body,1,key),first);
  assert.equal((await materialRow(f,material.id)).warehouseMilli,625);
  const latest=await f.get(`orders/${created.id}`);assert.equal(latest.materialSpec.lines[0].remainingMilli,0);
  assert.equal((await f.get(previewPath)).canConsume,false);
  assert.equal((await f.request(`orders/${created.id}/consume-materials`,body)).status,409,'stale quote cannot be reused');
  assert.equal((await f.request(`orders/${created.id}/consume-materials`,{...body,units:latest.units.map(u=>({id:u.id,version:u.version}))})).status,409);
  const stock=(await f.get('context')).stock.find(l=>l.id===lot.id);assert.equal(stock.warehouse,0.625);assert.equal(stock.installed,0.375);
  assert.ok(f.db.prepare('SELECT quantity FROM erp_stock_moves').all().every(r=>Number.isInteger(r.quantity)));
  assert.equal((await f.request('stock',{materialId:material.id,sku:'X',name:'X',quantity:0.0001,condition:'new',reference:'Bad precision'})).status,400);
});

test('ERP material batch consumption rolls back fully on shortages and respects client ownership',async context=>{
  const f=fixture(context),a=await createMaterial(f),b=await createMaterial(f),created=await order(f,2);
  const other=await f.post('clients',{name:'Other owner'}),detail=await f.get(`orders/${created.id}`);
  await setOrderNorm(f,created.id,[{materialId:a.id,quantity:1,source:'workshop'},{materialId:b.id,quantity:1,source:'client'}]);
  await receiveMaterial(f,a.id,10);
  await receiveMaterial(f,b.id,10,{clientId:other.id});
  await receiveMaterial(f,b.id,10,{clientId:detail.client_id,condition:'defective'});
  const before=f.db.prepare('SELECT COUNT(*) AS n FROM erp_stock_moves').get().n;
  const body={specVersion:1,units:detail.units.map(u=>({id:u.id,version:u.version})),note:'Use norm'};
  const quote=await f.get(`orders/${created.id}/material-preview?units=${detail.units.map(u=>u.id).join(',')}`);
  assert.equal(quote.canConsume,false);assert.equal(quote.lines[1].shortageMilli,2000);
  assert.equal((await f.request(`orders/${created.id}/consume-materials`,body)).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_stock_moves').get().n,before);
  assert.deepEqual((await f.get(`orders/${created.id}`)).units.map(u=>u.version),detail.units.map(u=>u.version));
  assert.equal((await materialRow(f,b.id,detail.client_id)).warehouseMilli,0);
  await receiveMaterial(f,b.id,2,{clientId:detail.client_id});
  await f.post(`orders/${created.id}/consume-materials`,body);
  assert.equal((await materialRow(f,b.id,other.id)).warehouseMilli,10000);
  assert.equal((await materialRow(f,b.id,detail.client_id)).demandMilli,0);
});

test('ERP material forecast caps coverage per unit and does not double subtract workbench material',async context=>{
  const f=fixture(context),material=await createMaterial(f),created=await order(f,2);
  await setOrderNorm(f,created.id,[{materialId:material.id,quantity:2,source:'workshop'}]);
  const detail=await f.get(`orders/${created.id}`),lot=await receiveMaterial(f,material.id,10);
  await f.post(`stock/${lot.id}/move`,{from:'warehouse',to:'workbench',unitId:detail.units[0].id,quantity:3,note:'Extra for first unit'});
  const row=await materialRow(f,material.id);assert.equal(row.warehouseMilli,7000);assert.equal(row.demandMilli,2000);assert.equal(row.projectedMilli,5000);
  const quote=await f.get(`orders/${created.id}/material-preview?units=${detail.units.map(u=>u.id).join(',')}`);
  assert.equal(quote.lines[0].consumeMilli,4000);assert.equal(quote.lines[0].workbenchMilli,2000);assert.equal(quote.lines[0].warehouseRequiredMilli,2000);
  await f.post(`stock/${lot.id}/move`,{from:'workbench',to:'warehouse',unitId:detail.units[0].id,quantity:1,note:'Return extra'});
  assert.equal((await materialRow(f,material.id)).demandMilli,2000);
  await f.post(`orders/${created.id}/consume-materials`,{specVersion:1,units:(await f.get(`orders/${created.id}`)).units.map(u=>({id:u.id,version:u.version})),note:'Use both'});
  assert.equal((await materialRow(f,material.id)).warehouseMilli,6000);
  assert.equal((await materialRow(f,material.id)).demandMilli,0);
});

test('ERP material planning is private, protects CSRF and freezes norms after quality acceptance',async context=>{
  const f=fixture(context),material=await createMaterial(f),created=await order(f,1);
  await setOrderNorm(f,created.id,[{materialId:material.id,quantity:1,source:'workshop'}]);
  const technician=await f.get('context',2);assert.equal(technician.materials,undefined);assert.equal(technician.materialPlanning,undefined);
  assert.equal((await f.request('replenishments',undefined,2)).status,403);
  assert.equal((await f.request(`orders/${created.id}/materials`,{version:1,lines:[]},2)).status,403);
  assert.equal((await f.request('materials',{sku:'FORGED',name:'X',uom:'pcs',minimum:0,target:0},1,crypto.randomUUID(),{origin:'https://evil.test'})).status,403);
  await assign(f,created.id,2);await f.post('shifts/action',{action:'start'},2);
  const unit=(await f.get(`orders/${created.id}`)).units[0];await finishUnit(f,created.id,unit.id);
  const updated=(await f.get(`orders/${created.id}`)).units[0];
  await f.post(`units/${unit.id}/quality`,{result:'pass',version:updated.version},4);
  assert.equal((await materialRow(f,material.id)).demandMilli,0,'accepted units no longer reserve forecast, without inventing consumption');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_stock_moves').get().n,0);
  assert.equal((await f.request(`orders/${created.id}/materials`,{version:1,lines:[]})).status,409);
});

test('ERP replenishment partial receipts retain history through edits, cancellation and retries',async context=>{
  const f=fixture(context),material=await createMaterial(f,{uom:'g'});
  const request=await f.post('replenishments',{materialId:material.id,quantity:10,note:'Initial'});
  const key=crypto.randomUUID(),receipt={materialId:material.id,replenishmentId:request.id,sku:'X',name:'X',quantity:2.125,condition:'good',reference:'Partial'};
  const first=await f.request('stock',receipt,1,key);assert.equal(first.status,200);assert.deepEqual(await f.request('stock',receipt,1,key),first);
  assert.equal((await f.get('replenishments')).rows[0].received_milli,2125);
  assert.equal((await f.request(`replenishments/${request.id}`,{version:1,quantity:10,note:'Stale'})).status,409);
  assert.equal((await f.request(`replenishments/${request.id}`,{version:2,quantity:1,note:'Too small'})).status,400);
  assert.equal((await f.request('stock',{...receipt,quantity:1,condition:'unknown'})).status,400);
  await f.post(`replenishments/${request.id}`,{version:2,quantity:10,cancel:true,note:'Cancel remaining only'});
  assert.equal((await materialRow(f,material.id)).warehouseMilli,2125);assert.equal((await materialRow(f,material.id)).requestedMilli,0);
  assert.equal((await f.get(`stock/${first.body.id}/history`))[0].quantity,2.125);
  await f.post('replenishments',{materialId:material.id,quantity:5,note:'New request'});
  assert.equal((await f.get('replenishments')).count,2);
});

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

test('ERP searches the complete personal queue with pagination and accurate totals',async context=>{
  const f=fixture(context);const {id}=await order(f,150);await assign(f,id);
  const first=await f.get('context?taskState=open&page=0',2);
  const third=await f.get('context?taskState=open&page=2',2);
  assert.equal(first.myTaskCount,300);assert.equal(first.myTaskCounts.open,300);assert.equal(first.myTasks.length,50);assert.equal(third.myTasks.length,50);
  assert.ok(third.myTasks.every(t=>!first.myTasks.some(other=>other.id===t.id)));
  const found=await f.get('context?taskState=open&q=SN-149',2);assert.equal(found.myTaskCount,2);
  const ukrainian=await f.get('context?q='+encodeURIComponent('огляд'),2);assert.equal(ukrainian.myTaskCount,150);
  assert.equal((await f.request('context?page=-1',undefined,2)).status,400);
  assert.equal((await f.get('context?taskState=open',3)).myTaskCount,0);
});

test('ERP records manager shift closure and protects stale order edits without rewriting history',async context=>{
  const f=fixture(context);const {id}=await order(f);const detail=await assign(f,id);const task=detail.tasks[0];
  await f.post('shifts/action',{action:'start'},2);await f.post(`tasks/${task.id}/action`,{action:'start',version:task.version},2);
  const shift=(await f.get('context',2)).shifts[0];
  assert.equal((await f.request('members/2/close-shift',{version:shift.version,endedAt:Date.now(),reason:'Test'},3)).status,403);
  await f.post('members/2/close-shift',{version:shift.version,endedAt:Date.now(),reason:'Майстер забув закрити зміну'});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_time_entries WHERE ended_at IS NULL').get().n,0);
  const event=f.db.prepare("SELECT * FROM erp_events WHERE action='shift.closed_by_manager'").get();assert.equal(event.actor_id,1);assert.match(event.details_json,/Майстер/);
  const updated={title:'Уточнений ремонт',priority:'urgent',dueDate:'2026-10-01',notes:'Новий термін погоджено',version:detail.version};
  await f.post(`orders/${id}/update`,updated);
  assert.equal((await f.request(`orders/${id}/update`,updated)).status,409);
  assert.equal((await f.get(`orders/${id}`)).units.length,3);
  const before=f.db.prepare('SELECT COUNT(*) AS n FROM erp_events').get().n;
  createErp(f.db);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_events').get().n,before,'repeat migration preserves history');
});
