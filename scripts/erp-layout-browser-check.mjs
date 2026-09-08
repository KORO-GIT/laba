// Disposable localhost data only. Exercise shared layout without touching production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base='http://127.0.0.1:8089';
try {await fetch(`${base}/healthz`);throw Error('Port 8089 occupied');}catch(error){if(error.message.includes('occupied'))throw error;}
const temporaryRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryRoot,'laba-layout-browser-'));
const server=spawn(process.execPath,['src/server.mjs'],{stdio:'ignore',windowsHide:true,env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8089',DB_PATH:path.join(directory,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}});
let browser;const errors=[],checks=[];
async function api(endpoint,body){
  const response=await fetch(`${base}/api/erp/${endpoint}`,{method:'POST',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID()},body:JSON.stringify(body)});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
}
async function layout(page,description){
  const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth>innerWidth+1,dialogs:[...document.querySelectorAll('dialog[open]')].some(d=>d.scrollWidth>d.clientWidth+1),tables:[...document.querySelectorAll('.table-wrap')].some(t=>t.clientWidth<=600&&t.scrollWidth>t.clientWidth+1)}));
  assert.deepEqual(overflow,{page:false,dialogs:false,tables:false},description);
  const buttons=await page.locator('.button:visible').evaluateAll(nodes=>nodes.map(node=>{
    const rect=node.getBoundingClientRect(),svg=node.querySelector(':scope > svg'),label=node.querySelector('.button-label'),s=svg?.getBoundingClientRect(),t=label?.getBoundingClientRect();
    return {text:node.textContent.trim(),width:rect.width,height:rect.height,minHeight:getComputedStyle(node).minHeight,overflow:node.scrollWidth>node.clientWidth+1,icon:s?{width:s.width,height:s.height,offset:Math.abs(s.y+s.height/2-rect.y-rect.height/2)}:null,overlap:s&&t&&t.width>0?s.right>t.left+1:false};
  }));
  for(const b of buttons){
    assert.ok(!b.overflow&&!b.overlap,`${description}: button ${JSON.stringify(b)}`);
    if(b.icon){assert.equal(b.icon.width,20,description);assert.equal(b.icon.height,20,description);assert.ok(b.icon.offset<=1,`${description}: icon center ${JSON.stringify(b)}`);}
    if(page.viewportSize().width<=600)assert.ok(b.height>=44,`${description}: small touch target ${JSON.stringify(b)}`);
  }
}
async function openSection(page,section){
  await page.goto(`${base}/erp#${section}`);
  await page.locator('#connection').filter({hasText:'Облік актуальний'}).waitFor();
  await page.locator('#content h1').waitFor();
}
async function screenshot(page,name){await page.screenshot({path:path.resolve(`data/erp-layout-${name}.png`),fullPage:true});}
try {
  let ready=false;for(let n=0;n<150;n++){if(server.exitCode!==null)throw Error('Local server exited');try{if((await fetch(`${base}/healthz`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',ignoreDefaultArgs:['--hide-scrollbars']});
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await openSection(page,'templates');await layout(page,'empty templates desktop');await screenshot(page,'empty-1440');
  await page.setViewportSize({width:360,height:860});await layout(page,'empty templates mobile');await screenshot(page,'empty-360');
  await page.getByRole('button',{name:'Створити шаблон',exact:true}).click();await layout(page,'template modal mobile');await screenshot(page,'template-modal-360');await page.keyboard.press('Escape');
  const client=await api('clients',{name:'Тестова організація з довгою назвою виробничого підрозділу',contact:'Диспетчер · contact.with.a.long.name@example.test',notes:'Синтетичні дані для перевірки перенесення тексту.'});
  await api('members',{name:'Тестовий майстер із довгим іменем',email:'long.worker.name@example.test',role:'technician'});
  const steps=[{title:'Перевірка комплектності та технічного стану',instructions:'Синтетичний опис',plannedMinutes:30}];
  await api('templates',{name:'Тестовий маршрут перевірки та відновлення обладнання',steps});
  await api('orders',{clientId:client.id,title:'Перевірка та відновлення обладнання з довгою назвою замовлення',model:'Тестова модель обладнання',kind:'repair',priority:'urgent',serials:['TEST-VERY-LONG-SERIAL-NUMBER-12345678901234567890'],unnumbered:3,reference:'Синтетичне замовлення',steps});
  const material=await api('materials',{name:'Кабель силіконовий для монтажу обладнання',sku:'TEST-WIRE-LONG-CODE',uom:'m',minimum:2,target:5});
  await api('stock',{materialId:material.id,sku:'TEST-WIRE-LONG-CODE',name:'Кабель силіконовий для монтажу обладнання',quantity:1,condition:'new',reference:'Тестова накладна'});
  for(const [width,theme] of [[1440,'dark'],[1024,'light'],[768,'dark'],[600,'dark'],[390,'dark'],[360,'light']]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('laba-theme',theme);},theme);
    for(const section of ['overview','orders','stock','materials','replenishment','team','crews','my','history','clients','templates','guides']){
      await openSection(page,section);
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      await layout(page,`${section} ${width} ${theme}`);
      if(['overview','orders','materials','team'].includes(section)&&[1440,390,360].includes(width))await screenshot(page,`${section}-${width}-${theme}`);
      if(section==='orders'){
        const count=await page.locator('tbody td').count();assert.equal(count,5,'all order values preserved');
        if(width<=600)assert.equal(await page.locator('tbody td').first().getAttribute('data-label'),'ЗАМОВЛЕННЯ');
        await page.getByRole('button',{name:'Відкрити',exact:true}).click();await page.locator('.unit-list').waitFor();
        await layout(page,`order modal ${width}`);
        if([1440,390,360].includes(width))await screenshot(page,`order-modal-${width}`);
        await page.keyboard.press('Escape');
        await page.getByRole('button',{name:'Прийняти партію',exact:true}).click();
        await layout(page,`order form ${width}`);
        const arrows=await page.locator('.select-control').evaluateAll(nodes=>nodes.map(n=>{const a=n.querySelector('svg').getBoundingClientRect(),s=n.querySelector('select').getBoundingClientRect();return {right:s.right-a.right,center:Math.abs(a.y+a.height/2-s.y-s.height/2)};}));
        assert.ok(arrows.length>0);for(const arrow of arrows){assert.equal(arrow.right,14);assert.ok(arrow.center<=1);}
        if(width===360)await screenshot(page,'order-form-360');
        await page.keyboard.press('Escape');
      }
    }
    checks.push(`${width} ${theme}: 12 sections, tables, dialogs, buttons and select alignment`);
  }
  await page.setViewportSize({width:1024,height:600});await openSection(page,'orders');
  await page.getByRole('link',{name:'Інструкції',exact:true}).click();
  await page.getByRole('heading',{name:'Корисні матеріали',exact:true}).waitFor();
  assert.ok(await page.locator('.sidebar').evaluate(n=>n.scrollTop>0),'all navigation remains reachable on short desktop');
  await layout(page,'short desktop 1024x600');checks.push('short desktop: independently scrolling sidebar');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks}));
} finally {
  await browser?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('laba-layout-browser-'));fs.rmSync(resolved,{recursive:true});
}
