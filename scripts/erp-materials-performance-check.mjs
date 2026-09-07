// Fixed synthetic in-memory dataset. Includes records beyond UI list caps; no production access.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {createErp} from '../src/erp-database.mjs';
const db=new Database(':memory:');
try {
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,display_name TEXT,role TEXT,enabled INTEGER DEFAULT 1);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);INSERT INTO users VALUES(1,'owner@example.test','Owner','admin',1);`);
  const erp=createErp(db),admin=db.prepare('SELECT * FROM users WHERE id=1').get();
  const command=(body,action)=>erp.command(admin,crypto.randomUUID(),'synthetic',body,()=>action(body));
  const client=erp.createClient(admin,{name:'Synthetic',contact:'',notes:''});
  const started=performance.now(),materials=[];
  for(let n=0;n<3;n++)materials.push(command({sku:`MAT-${n}`,name:`Material ${n}`,uom:'pcs',minimum:20,target:50},b=>erp.saveMaterial(admin,null,b)));
  const lines=materials.map(m=>({materialId:m.id,quantity:2,source:'workshop'}));
  let first;
  for(let n=0;n<201;n++){
    const order=command({clientId:client.id,title:`Batch ${n}`,model:'Test',kind:'upgrade',priority:'normal',dueDate:null,notes:'',reference:'Synthetic',unnumbered:n<20?150:1,serials:[],steps:[{title:'Step',instructions:'',plannedMinutes:10}]},b=>erp.createOrder(admin,b));
    command({version:0,lines},b=>erp.saveMaterialSpec(admin,'order',order.id,b));if(!first)first=order.id;
  }
  for(let n=0;n<501;n++)command({materialId:materials[n%3].id,clientId:null,sku:'ignored',name:'ignored',quantity:40,condition:'new',shelf:'',originUnitId:null,reference:'Synthetic'},b=>erp.receiveStock(admin,b));
  const setupMs=Math.round(performance.now()-started),samples=[];
  for(let n=0;n<20;n++){const start=performance.now();const snapshot=erp.snapshot(admin);samples.push(performance.now()-start);assert.equal(snapshot.orders.length,200);assert.equal(snapshot.stock.length,500);for(const row of snapshot.materialPlanning.rows){assert.equal(row.demandMilli,6362000);assert.equal(row.warehouseMilli,6680000);assert.equal(row.orderCount,201);}}
  samples.sort((a,b)=>a-b);const read={medianMs:Math.round(samples[10]),p95Ms:Math.round(samples[18])};
  const units=erp.orderDetail(admin,first).units.map(u=>({id:u.id,version:u.version}));
  const quote=erp.previewConsumption(admin,first,units.map(u=>u.id));assert.equal(quote.canConsume,true);
  const consumeStart=performance.now();command({specVersion:1,units,note:'Synthetic use'},b=>erp.consumeMaterials(admin,first,b));const consumeMs=Math.round(performance.now()-consumeStart);
  for(const row of erp.snapshot(admin).materialPlanning.rows){assert.equal(row.demandMilli,6062000);assert.equal(row.warehouseMilli,6380000);assert.equal(row.projectedMilli,318000);}
  assert.ok(read.p95Ms<2000,'Material read smoke exceeded 2 seconds');assert.ok(consumeMs<5000,'150-unit material write smoke exceeded 5 seconds');
  console.log(JSON.stringify({ok:true,orders:201,units:3181,materials:3,lots:501,setupMs,read,consume150UnitsMs:consumeMs,scope:'in-memory smoke, all records beyond UI caps; not concurrent capacity guarantee'}));
}finally{db.close();}
