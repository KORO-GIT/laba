// Full team workflow on an isolated, disposable localhost server and synthetic accounts.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base = 'http://127.0.0.1:8084';
try { await fetch(`${base}/healthz`); throw new Error('Port 8084 is occupied; refusing to use another server'); }
catch(error) { if(error.message.includes('occupied')) throw error; }
const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot,'laba-crews-browser-'));
const server = spawn(process.execPath,['src/server.mjs'],{
  cwd:process.cwd(),stdio:'ignore',windowsHide:true,
  env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8084',DB_PATH:path.join(directory,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}
});
let browser;
const errors=[];
async function api(endpoint,body) {
  const response=await fetch(`${base}/api/erp/${endpoint}`,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
}
try {
  let ready=false;
  for(let n=0;n<150;n++) {
    if(server.exitCode!==null)throw new Error('Local test server exited');
    try {if((await fetch(`${base}/healthz`)).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Local server did not start');
  const alice=await api('members',{name:'Олена Тест',email:'alice@example.test',role:'technician'});
  const bob=await api('members',{name:'Андрій Тест',email:'bob@example.test',role:'technician'});
  const client=await api('clients',{name:'Синтетичний клієнт'});
  const order=await api('orders',{clientId:client.id,title:'Ремонт агродрона · тест',model:'Агродрон',kind:'repair',priority:'normal',dueDate:null,steps:[{title:'Спільна діагностика',instructions:'Тест командного обліку',plannedMinutes:60}],serials:['AGRO-TEST-001'],unnumbered:0,reference:'Лише тест'});
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
  async function page(email,width=390) {
    const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,extraHTTPHeaders:{'X-Dev-User-Email':email},reducedMotion:'reduce'});
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(`${base}/erp`);await page.locator('#connection').filter({hasText:'Облік актуальний'}).waitFor();return page;
  }
  const owner=await page('admin@local.test',1440);
  await owner.getByRole('link',{name:'Робочі команди',exact:true}).click();
  await owner.getByRole('button',{name:'Створити команду',exact:true}).first().click();
  await owner.getByLabel('Назва команди',{exact:true}).fill('Агро · спільна команда');
  await owner.getByLabel('Олена Тест',{exact:true}).check();
  await owner.getByLabel('Андрій Тест',{exact:true}).check();
  await owner.getByLabel('Старший команди',{exact:true}).selectOption(String(alice.id));
  await owner.locator('dialog').getByRole('button',{name:'Створити',exact:true}).click();
  await owner.getByRole('heading',{name:'Агро · спільна команда',exact:true}).waitFor();
  await owner.screenshot({path:path.resolve('data/erp-crews-desktop.png'),fullPage:true});
  await owner.getByRole('link',{name:'Замовлення',exact:true}).click();
  await owner.getByRole('button',{name:'Відкрити',exact:true}).click();
  await owner.getByRole('checkbox',{name:'Обрати всі вироби',exact:true}).check();
  await owner.getByRole('button',{name:'Призначити команді',exact:true}).click();
  assert.equal(await owner.getByLabel('Режим роботи',{exact:true}).inputValue(),'shared');
  await owner.locator('dialog').getByRole('button',{name:'Призначити',exact:true}).click();
  await owner.locator('dialog[open] .unit-list').waitFor();
  await owner.getByRole('button',{name:'Закрити',exact:true}).click();
  const crew=(await api('context')).crews[0];
  const detail=await api(`orders/${order.id}`);const taskId=detail.tasks[0].id;
  const a=await page('alice@example.test');const b=await page('bob@example.test',360);
  for(const phone of [a,b]) {
    await phone.getByRole('button',{name:'Почати зміну',exact:true}).click();
    await phone.getByRole('link',{name:'Робочі команди',exact:true}).click();
    await phone.getByRole('button',{name:'Роботи команди',exact:true}).click();
    await phone.getByRole('button',{name:'Долучитися',exact:true}).waitFor();
  }
  await a.getByRole('button',{name:'Долучитися',exact:true}).click();
  await a.locator('.task-card.running').waitFor();
  // Refresh B through normal navigation to get A's new task revision.
  await b.getByRole('button',{name:'Усі команди',exact:true}).click();
  await b.getByRole('button',{name:'Роботи команди',exact:true}).click();
  await b.getByRole('button',{name:'Долучитися',exact:true}).click();
  await b.locator('.task-card.running').waitFor();
  await b.getByRole('button',{name:'Увімкнути світлу тему',exact:true}).click();
  assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await b.screenshot({path:path.resolve('data/erp-crews-mobile-light.png'),fullPage:true});
  for(const phone of [a,b]) {
    await phone.getByRole('button',{name:'Усі команди',exact:true}).click();
    await phone.getByRole('button',{name:'Роботи команди',exact:true}).click();
    await phone.getByRole('button',{name:'Мій внесок готовий',exact:true}).click();
    await phone.getByRole('button',{name:'Підтвердити',exact:true}).click();
    await phone.locator('.task-card.running').waitFor({state:'hidden'});
  }
  await a.getByRole('button',{name:'Усі команди',exact:true}).click();
  await a.getByRole('button',{name:'Роботи команди',exact:true}).click();
  await a.screenshot({path:path.resolve('data/erp-crews-mobile-dark.png'),fullPage:true});
  await a.getByRole('button',{name:'Завершити спільну операцію',exact:true}).click();
  await a.getByRole('button',{name:'Підтвердити',exact:true}).click();
  await a.getByRole('heading',{name:'Робіт ще немає',exact:true}).waitFor();
  assert.equal((await api(`orders/${order.id}`)).units[0].state,'quality');
  const history=await api(`tasks/${taskId}/work-history`);assert.equal(history.length,2);
  assert.deepEqual(history.map(row=>row.user_id).sort(),[alice.id,bob.id].sort());
  await owner.getByRole('link',{name:'Робочі команди',exact:true}).click();
  await owner.getByRole('button',{name:'Склад команди',exact:true}).click();
  await owner.getByLabel('Назва команди',{exact:true}).fill('Агро · нова назва');
  await owner.getByRole('button',{name:'Зберегти склад',exact:true}).click();
  await owner.getByRole('heading',{name:'Агро · нова назва',exact:true}).waitFor();
  assert.equal((await api('context')).crews.find(c=>c.id===crew.id).members.length,2);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['create/edit crew UI','assign one unit in shared mode','two mobile contributors','dark/light 360/390','personal contribution completion','leader finalizes once','two independent time histories','no production data','no browser errors']}));
} finally {
  await browser?.close();
  if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  const resolved=fs.realpathSync(directory);
  assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('laba-crews-browser-'));
  fs.rmSync(resolved,{recursive:true});
}
