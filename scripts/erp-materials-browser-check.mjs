// Synthetic, disposable localhost only. Never reuse an occupied port or production data.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base='http://127.0.0.1:8085';
try {await fetch(`${base}/healthz`);throw new Error('Port 8085 occupied; refusing to use another server');}catch(error){if(error.message.includes('occupied'))throw error;}
const temporaryRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryRoot,'laba-materials-browser-'));
const server=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),stdio:'ignore',windowsHide:true,env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8085',DB_PATH:path.join(directory,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}});
let browser;const errors=[];
async function api(endpoint,body){const r=await fetch(`${base}/api/erp/${endpoint}`,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
try {
  let ready=false;
  for(let n=0;n<150;n++){if(server.exitCode!==null)throw new Error('Local test server exited');try{if((await fetch(`${base}/healthz`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready);
  await api('members',{name:'Майстер Тест',email:'worker@example.test',role:'technician'});
  await api('members',{name:'Комірник Тест',email:'warehouse@example.test',role:'warehouse'});
  const client=await api('clients',{name:'Синтетичний клієнт'}),steps=[{title:'Модернізація',instructions:'Лише тестові дані',plannedMinutes:30}];
  const template=await api('templates',{name:'Типова модернізація · тест',steps});
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
  async function page(email,width=1440,section='materials'){
    const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<500,hasTouch:width<500,extraHTTPHeaders:{'X-Dev-User-Email':email},reducedMotion:'reduce'});
    const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await p.goto(`${base}/erp#${section}`);await p.locator('#connection').filter({hasText:'Облік актуальний'}).waitFor();return p;
  }
  const owner=await page('admin@local.test');
  async function addMaterial(name,sku,uom,minimum,target){
    await owner.getByRole('button',{name:'Додати матеріал',exact:true}).click();
    await owner.getByLabel('Назва матеріалу',{exact:true}).fill(name);await owner.getByLabel('Артикул матеріалу',{exact:true}).fill(sku);
    await owner.getByLabel('Одиниця обліку',{exact:true}).selectOption(uom);await owner.getByLabel('Мінімальний запас',{exact:true}).fill(String(minimum));await owner.getByLabel('Поповнювати до',{exact:true}).fill(String(target));
    await owner.locator('dialog').getByRole('button',{name:'Створити матеріал',exact:true}).click();await owner.locator('dialog').waitFor({state:'hidden'});
  }
  await addMaterial('Кріплення М3','FASTENER-M3','pcs',20,50);
  await addMaterial('Провід силіконовий','WIRE','m',1,3);
  const materials=(await api('context')).materials,fastener=materials.find(m=>m.sku==='FASTENER-M3'),wire=materials.find(m=>m.sku==='WIRE');
  await owner.getByRole('link',{name:'Шаблони робіт',exact:true}).click();
  await owner.getByRole('button',{name:'Норми витрат',exact:true}).click();
  const rows=owner.locator('.material-editor-row');
  await rows.nth(0).getByLabel('Матеріал',{exact:true}).selectOption(String(fastener.id));await rows.nth(0).getByLabel('На один виріб',{exact:true}).fill('2');
  await owner.getByRole('button',{name:'Додати рядок норми',exact:true}).click();
  await rows.nth(1).getByLabel('Матеріал',{exact:true}).selectOption(String(wire.id));await rows.nth(1).getByLabel('На один виріб',{exact:true}).fill('0.125');
  await owner.getByRole('button',{name:'Зберегти норми',exact:true}).click();await owner.locator('dialog').waitFor({state:'hidden'});
  const order=await api('orders',{clientId:client.id,title:'Партія 150 · лише тест',model:'Тестова модель',kind:'upgrade',priority:'normal',dueDate:null,steps,templateId:template.id,serials:[],unnumbered:150,reference:'Тестова прийомка'});
  await owner.reload();await owner.locator('#connection').filter({hasText:'Облік актуальний'}).waitFor();
  await owner.getByRole('link',{name:'Матеріали',exact:true}).click();
  await owner.getByRole('row').filter({hasText:'Кріплення М3'}).getByRole('button',{name:'Прийняти',exact:true}).click();
  await owner.getByLabel('Кількість у вибраній одиниці',{exact:true}).fill('200');await owner.getByLabel('Документ прийомки',{exact:true}).fill('Тестова накладна');
  await owner.getByRole('button',{name:'Підтвердити надходження',exact:true}).click();await owner.locator('dialog').waitFor({state:'hidden'});
  await owner.getByRole('link',{name:/^Поповнення/}).click();await owner.getByRole('heading',{name:'Потреби та поповнення',exact:true}).waitFor();
  const card=owner.locator('.material-need').filter({hasText:'Кріплення М3'});
  await card.getByRole('button',{name:'Створити заявку',exact:true}).click();
  assert.equal(await owner.locator('dialog [name="quantity"]').inputValue(),'150');
  await owner.locator('dialog').getByRole('button',{name:'Створити заявку',exact:true}).click();await owner.locator('dialog').waitFor({state:'hidden'});
  async function receiveRequest(quantity){
    await owner.getByRole('button',{name:'Прийняти за заявкою',exact:true}).click();
    await owner.getByLabel('Кількість у вибраній одиниці',{exact:true}).fill(String(quantity));await owner.getByLabel('Документ прийомки',{exact:true}).fill('Тестове часткове надходження');
    await owner.getByRole('button',{name:'Підтвердити надходження',exact:true}).click();await owner.locator('dialog').waitFor({state:'hidden'});
  }
  await receiveRequest(50);assert.equal((await api('replenishments')).rows[0].received_milli,50000);
  await owner.screenshot({path:path.resolve('data/erp-materials-desktop-dark.png'),fullPage:true});
  await receiveRequest(100);assert.equal((await api('replenishments')).rows[0].state,'received');
  await api('stock',{materialId:wire.id,sku:wire.sku,name:wire.name,quantity:22,condition:'new',reference:'Тестовий провід'});
  await owner.reload();await owner.locator('#connection').filter({hasText:'Облік актуальний'}).waitFor();
  assert.equal((await api('context')).materialPlanning.alertCount,0);
  await owner.getByRole('link',{name:'Замовлення',exact:true}).click();await owner.getByRole('button',{name:'Відкрити',exact:true}).click();
  await owner.getByRole('checkbox',{name:'Обрати всі вироби',exact:true}).check();
  await owner.getByRole('button',{name:'Витрата за нормою для обраних',exact:true}).click();
  await owner.getByRole('heading',{name:'Підтвердити витрату за нормою',exact:true}).waitFor();
  await owner.getByLabel('Документ / підтвердження фактичного використання',{exact:true}).fill('Синтетичне підтвердження 150 виробів');
  const started=performance.now();await owner.getByRole('button',{name:'Провести витрату',exact:true}).click();
  await owner.locator('dialog[open] .unit-list').waitFor();const consumeUiMs=Math.round(performance.now()-started);
  const context=await api('context');assert.equal(context.stock.find(l=>l.material_id===wire.id).warehouse,3.25);
  assert.equal((await api(`orders/${order.id}`)).materialSpec.lines.every(l=>l.remainingMilli===0),true);
  await owner.getByRole('button',{name:'Закрити',exact:true}).click();
  await api(`materials/${fastener.id}`,{sku:fastener.sku,name:fastener.name,uom:'pcs',minimum:60,target:100,version:1});
  const mobile=await page('admin@local.test',390,'replenishment');
  for(const [width,theme] of [[390,'dark'],[360,'light']]){
    await mobile.setViewportSize({width,height:900});if(theme==='light')await mobile.getByRole('button',{name:'Увімкнути світлу тему',exact:true}).click();
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await mobile.screenshot({path:path.resolve(`data/erp-materials-mobile-${theme}.png`),fullPage:true});
  }
  const worker=await page('worker@example.test',390,'replenishment');
  await worker.getByRole('heading',{name:'Моя робота',exact:true}).waitFor();assert.equal(await worker.getByRole('link',{name:/Матеріали|Поповнення/}).count(),0);
  const warehouse=await page('warehouse@example.test',360);assert.equal(await warehouse.getByRole('button',{name:'До шаблонів робіт',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,consumeUiMs,checks:['catalogue via UI','two per-unit template norms','150-unit snapshot','stock receipt','forecasted request150','partial50 + final100','confirmed consumption150','mobile390/360 dark/light','forbidden hash redirects technician','warehouse navigation','no browser errors','synthetic localhost only']}));
} finally {
  await browser?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('laba-materials-browser-'));fs.rmSync(resolved,{recursive:true});
}
