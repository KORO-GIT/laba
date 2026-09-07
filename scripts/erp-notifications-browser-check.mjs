// Disposable localhost only: exercise real dialog/notification lifecycle without production writes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base='http://127.0.0.1:8086';
try{await fetch(`${base}/healthz`);throw Error('Port 8086 occupied; refusing to use another server');}catch(error){if(error.message.includes('occupied'))throw error;}
const temporaryRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryRoot,'laba-notifications-browser-'));
const server=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),stdio:'ignore',windowsHide:true,env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8086',DB_PATH:path.join(directory,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}});
let browser;const errors=[];
async function api(endpoint,body){const r=await fetch(`${base}/api/erp/${endpoint}`,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
try{
  let ready=false;for(let n=0;n<150;n++){if(server.exitCode!==null)throw Error('Local server exited');try{if((await fetch(`${base}/healthz`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const client=await api('clients',{name:'Synthetic only'});
  const order=await api('orders',{clientId:client.id,title:'Тест повідомлень',model:'Test',kind:'repair',priority:'normal',serials:[],unnumbered:4,reference:'Synthetic',steps:[{title:'Перевірка',instructions:'',plannedMinutes:10}]});
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
  for(const [width,theme] of [[1440,'dark'],[390,'dark'],[360,'light']]){
    const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    let posts=0;page.on('request',r=>{if(r.method()==='POST')posts++;});
    await page.goto(`${base}/erp#orders`);await page.getByRole('heading',{name:'Замовлення',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>[...document.querySelector('#content').childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&/^(null|undefined|false)$/.test(n.textContent))),false,'optional page blocks must not render null');
    if(theme==='light')await page.getByRole('button',{name:'Увімкнути світлу тему',exact:true}).click();
    async function openOrder(){await page.getByRole('button',{name:'Відкрити',exact:true}).click();await page.locator('dialog[open] .unit-list').waitFor();}
    async function assertTopmost(role='alert'){
      await page.locator('dialog[open] .dialog-header #toast.show').waitFor();
      assert.equal(await page.locator('#toast').count(),1);
      assert.equal(await page.locator('#toast').getAttribute('role'),role);
      assert.equal(await page.locator('#toast').getAttribute('aria-live'),role==='alert'?'assertive':'polite');
      assert.equal(await page.evaluate(()=>{
        const toast=document.querySelector('#toast'),rect=toast.getBoundingClientRect();
        const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        return rect.width>0&&rect.y>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth&&toast.contains(hit)&&getComputedStyle(toast).filter==='none';
      }),true,'toast must be readable, on top and inside the viewport');
    }
    await openOrder();
    await page.getByRole('button',{name:'Призначити',exact:true}).click();await assertTopmost();
    assert.equal(await page.locator('#toast').textContent(),'Спочатку оберіть вироби');assert.equal(posts,0,'empty selection does not send a write');
    await page.locator('dialog').evaluate(d=>{d.scrollTop=d.scrollHeight;});await assertTopmost();
    await page.screenshot({path:path.resolve(`data/erp-notification-${width}-${theme}.png`)});
    await page.getByRole('button',{name:'Змінити термін / пріоритет',exact:true}).click();
    assert.equal(await page.locator('#toast.show').count(),0,'old validation does not leak into another dialog');
    await page.getByLabel('Назва',{exact:true}).fill('Unsaved text must survive');
    const before=await api(`orders/${order.id}`);
    await api(`orders/${order.id}/update`,{title:before.title,priority:before.priority,dueDate:before.due_date,notes:before.notes,version:before.version});
    const response=page.waitForResponse(r=>r.url().endsWith(`/orders/${order.id}/update`)&&r.request().method()==='POST');
    await page.locator('dialog').getByRole('button',{name:'Зберегти',exact:true}).click();assert.equal((await response).status(),409);
    await assertTopmost();assert.equal(await page.getByLabel('Назва',{exact:true}).inputValue(),'Unsaved text must survive');
    assert.equal(await page.locator('dialog [role="alert"]').count(),1,'no duplicate inline error announcement');
    // Long server error is literal text, not HTML; input and modal stay usable.
    const longMessage='Перевірте документ: '+('ДовгийАртикул'.repeat(16))+' <img src=x onerror=alert(1)>';
    await page.route('**/api/erp/orders/*/update',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:longMessage})}));
    await page.locator('dialog').getByRole('button',{name:'Зберегти',exact:true}).click();
    await page.locator('#toast').filter({hasText:longMessage}).waitFor();await assertTopmost();assert.equal(await page.locator('#toast img').count(),0);
    await page.screenshot({path:path.resolve(`data/erp-notification-long-${width}-${theme}.png`)});
    await page.unroute('**/api/erp/orders/*/update');
    await page.getByRole('button',{name:'Закрити',exact:true}).click();await openOrder();
    await page.getByRole('button',{name:'Змінити термін / пріоритет',exact:true}).click();
    await page.getByLabel('Назва',{exact:true}).fill('Saved synthetic title');
    await page.locator('dialog').getByRole('button',{name:'Зберегти',exact:true}).click();
    await page.locator('dialog[open] .unit-list').waitFor();await assertTopmost('status');
    assert.equal(await page.locator('#toast').textContent(),'Збережено в обліку','success survives replacing/reopening modal');
    await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});
    await page.locator('body > #toast.show').waitFor();assert.equal(await page.locator('#toast').count(),1);
    await page.locator('#toast.show').waitFor({state:'hidden',timeout:7000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['validation inside top-layer dialog','sticky after scroll','409 preserves input','one live announcement','long error wraps and escapes HTML','success survives dialog replacement','Escape returns toast to page','single node and timer expiry','desktop1440/mobile390/360 dark/light','no production data']}));
}finally{
  await browser?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('laba-notifications-browser-'));fs.rmSync(resolved,{recursive:true});
}
