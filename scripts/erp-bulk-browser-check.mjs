// Synthetic localhost only: no production accounts, timers, or writes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base='http://127.0.0.1:8091';
try{await fetch(`${base}/healthz`);throw Error('Port 8091 occupied');}catch(e){if(e.message.includes('occupied'))throw e;}
const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'laba-bulk-check-'));
const server=spawn(process.execPath,['src/server.mjs'],{stdio:'ignore',windowsHide:true,env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8091',DB_PATH:path.join(dir,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}});
let browser;
async function api(endpoint,body){const r=await fetch(`${base}/api/erp/${endpoint}`,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
try{
  for(let i=0;i<120;i++){try{if((await fetch(`${base}/healthz`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  const worker=await api('members',{name:'Майстер пакетної перевірки',email:'bulk@example.test',role:'technician'});
  const client=await api('clients',{name:'Synthetic bulk client'});
  const order=await api('orders',{clientId:client.id,title:'Пакетна перевірка',model:'Synthetic device',kind:'repair',priority:'normal',reference:'TEST ONLY',serials:Array.from({length:77},(_,i)=>`BULK-${String(i+1).padStart(3,'0')}`),steps:[{title:'Огляд',instructions:'Синтетична перевірка'},{title:'Фінальна перевірка',instructions:''}]});
  let detail=await api(`orders/${order.id}`);
  await api('assign',{userId:worker.id,tasks:detail.tasks.map(({id,version})=>({id,version}))});
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{'x-dev-user-email':'bulk@example.test'}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/erp#my`);await page.getByRole('button',{name:'Почати зміну',exact:true}).click();
  await page.getByRole('button',{name:'Перерва',exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'Обрати доступні на сторінці'}).check();
  await page.getByRole('button',{name:'Завершити вибрані (25)'}).waitFor();
  await page.getByRole('button',{name:'Наступна',exact:true}).click();
  await page.getByText('Сторінка 2 з 4', {exact:false}).waitFor();
  await page.getByRole('checkbox',{name:'Обрати доступні на сторінці'}).check();
  await page.getByRole('button',{name:'Завершити вибрані (50)'}).click();
  await page.getByRole('heading',{name:'Завершити 50 завдань?'}).waitFor();
  assert.equal(await page.locator('.batch-task-list li').count(),50);
  for(const [width,theme] of [[1440,'dark'],[390,'dark'],[360,'light']]){
    await page.setViewportSize({width,height:844});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.ok(await page.locator('#dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    fs.mkdirSync('data',{recursive:true});await page.screenshot({path:`data/erp-bulk-${width}-${theme}.png`});
  }
  await page.getByRole('button',{name:'Підтвердити завершення',exact:true}).click();
  await page.getByText('Збережено в обліку',{exact:true}).waitFor();
  detail=await api(`orders/${order.id}`);assert.equal(detail.tasks.filter(t=>t.state==='done').length,50);
  // Filtering clears selection. A stale concurrent assignment aborts the whole next batch.
  await page.getByRole('searchbox').fill('Огляд');await page.getByRole('button',{name:'Завершити вибрані (0)'}).waitFor();
  await page.getByRole('checkbox',{name:'Обрати доступні на сторінці'}).check();
  await page.getByRole('button',{name:'Завершити вибрані (27)'}).click();
  const stale=detail.tasks.find(t=>t.sequence===0&&t.state!=='done');
  await api('assign',{userId:worker.id,tasks:[{id:stale.id,version:stale.version}]});
  await page.getByRole('button',{name:'Підтвердити завершення',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Запис уже змінився'}).waitFor();
  assert.ok(await page.locator('#dialog').evaluate(n=>n.open));
  assert.equal((await api(`orders/${order.id}`)).tasks.filter(t=>t.state==='done').length,50);
  assert.equal(await page.locator('.batch-task-list li').count(),27);
  assert.deepEqual(errors,[]);console.log('ERP bulk browser: 50 cross-page selections, 1440/390/360 dark/light, real completion, atomic conflict and preserved selection passed');
}finally{
  await browser?.close();if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),root);assert.ok(path.basename(resolved).startsWith('laba-bulk-check-'));fs.rmSync(resolved,{recursive:true});
}
