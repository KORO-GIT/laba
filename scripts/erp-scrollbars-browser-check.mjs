// Synthetic localhost only. Check native scrolling, both themes and OS high contrast.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base='http://127.0.0.1:8087';
try {await fetch(`${base}/healthz`);throw Error('Port 8087 occupied');} catch(error) {if(error.message.includes('occupied'))throw error;}
const temporaryRoot=fs.realpathSync(os.tmpdir());
const directory=fs.mkdtempSync(path.join(temporaryRoot,'laba-scrollbars-browser-'));
const server=spawn(process.execPath,['src/server.mjs'],{stdio:'ignore',windowsHide:true,env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8087',DB_PATH:path.join(directory,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}});
let browser;
const errors=[],checks=[];
async function api(endpoint,body) {
  const response=await fetch(`${base}/api/erp/${endpoint}`,{method:'POST',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID()},body:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
}
async function changedScroll(locator,axis,before=0) {
  await locator.page().waitForFunction(({selector,axis,before})=>document.querySelector(selector)[axis]>before,{selector:await locator.evaluate(e=>e.tagName==='DIALOG'?'dialog':e.tagName==='TEXTAREA'?'textarea[name="serials"]':e.classList.contains('unit-list')?'.unit-list':'.table-wrap'),axis,before},{timeout:5000});
}
try {
  let ready=false;
  for(let n=0;n<150;n++) {
    if(server.exitCode!==null)throw Error('Local server exited');
    try {if((await fetch(`${base}/healthz`)).ok){ready=true;break;}} catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready);
  const client=await api('clients',{name:'Синтетичний клієнт'});
  await api('orders',{clientId:client.id,title:'Перевірка прокрутки',model:'Test',kind:'repair',priority:'normal',serials:[],unnumbered:24,reference:'Synthetic only',steps:[{title:'Огляд',instructions:'',plannedMinutes:10}]});
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
  for(const [width,theme] of [[1440,'dark'],[1440,'light'],[390,'dark'],[360,'light']]) {
    const context=await browser.newContext({viewport:{width,height:860},isMobile:width<500,hasTouch:width<500,reducedMotion:'reduce'});
    const page=await context.newPage();let posts=0;
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts++;});
    await page.goto(`${base}/erp#orders`);
    await page.getByRole('heading',{name:'Замовлення',exact:true}).waitFor();
    if(theme==='light')await page.getByRole('button',{name:'Увімкнути світлу тему',exact:true}).click();
    await page.getByRole('button',{name:'Відкрити',exact:true}).click();
    const dialog=page.locator('dialog[open]'),units=page.locator('.unit-list');
    await units.waitFor();
    await page.mouse.move(0,0);
    const style=await dialog.evaluate(d=>{
      const css=getComputedStyle(d),bar=getComputedStyle(d,'::-webkit-scrollbar'),thumb=getComputedStyle(d,'::-webkit-scrollbar-thumb');
      return {width:bar.width,background:bar.backgroundColor,thumb:thumb.backgroundColor,radius:thumb.borderRadius,buttons:getComputedStyle(d,'::-webkit-scrollbar-button').display,gutter:css.scrollbarGutter,standard:css.scrollbarColor,overflow:d.scrollHeight>d.clientHeight};
    });
    assert.equal(style.width,'10px');assert.equal(style.radius,'999px');assert.equal(style.background,'rgba(0, 0, 0, 0)');
    assert.equal(style.thumb,theme==='dark'?'rgb(104, 117, 127)':'rgb(122, 135, 145)');
    assert.equal(style.buttons,'none');assert.equal(style.gutter,'stable');assert.equal(style.standard,'auto');assert.ok(style.overflow);
    await units.hover();await page.mouse.wheel(0,220);await changedScroll(units,'scrollTop');
    assert.ok(await units.evaluate(e=>e.scrollHeight>e.clientHeight));
    await dialog.evaluate(d=>{d.scrollTop=0;});
    const box=await dialog.boundingBox();
    await page.screenshot({path:path.resolve(`data/erp-scrollbars-order-${width}-${theme}.png`)});
    if(width>=500) {
      // Grab the actual native thumb near its upper end, not a custom JS handle.
      await page.mouse.move(box.x+box.width-6,box.y+30);
      await page.screenshot({path:path.resolve(`data/erp-scrollbars-hover-${width}-${theme}.png`)});
      await page.mouse.down();
      await page.mouse.move(box.x+box.width-6,box.y+180,{steps:12});await page.mouse.up();
      await changedScroll(dialog,'scrollTop');
    } else {
      // Swipe the dialog's padding, outside the independently scrollable unit list.
      const cdp=await context.newCDPSession(page),x=Math.round(box.x+12),y=Math.round(box.y+box.height-100);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-step*25}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await changedScroll(dialog,'scrollTop');await cdp.detach();
    }
    await page.getByRole('button',{name:'Закрити',exact:true}).click();
    await page.getByRole('button',{name:'Прийняти партію',exact:true}).click();
    const serials=page.locator('textarea[name="serials"]');
    await serials.fill(Array.from({length:50},(_,i)=>`TEST-${i+1}`).join('\n'));
    await serials.press('Control+Home');await serials.press('Control+End');await changedScroll(serials,'scrollTop');
    await serials.evaluate(e=>{e.scrollTop=0;});await serials.hover();await page.mouse.wheel(0,160);await changedScroll(serials,'scrollTop');
    await page.locator('dialog').evaluate(d=>{d.scrollTop=0;});
    await page.mouse.move(0,0);
    await page.screenshot({path:path.resolve(`data/erp-scrollbars-${width}-${theme}.png`)});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no page horizontal overflow');
    const fieldBounds=await serials.boundingBox();assert.ok(fieldBounds.x>=0&&fieldBounds.x+fieldBounds.width<=width);
    const expected=await serials.inputValue();
    await page.keyboard.press('Escape');
    if(width<500) {
      const table=page.locator('.table-wrap');
      if(await table.evaluate(e=>e.scrollWidth>e.clientWidth)) {
        await table.hover();await page.mouse.wheel(240,0);await changedScroll(table,'scrollLeft');
      }
    }
    assert.ok(expected.includes('TEST-50'));assert.equal(posts,0,'browser QA must not save form data');
    checks.push(`${width} ${theme}: rounded theme / nested wheel / ${width<500?'touch':'thumb drag'} / textarea keyboard / no overflow`);
    await context.close();
  }
  const context=await browser.newContext({forcedColors:'active'}),page=await context.newPage();
  await page.goto(`${base}/erp#orders`);await page.getByRole('heading',{name:'Замовлення',exact:true}).waitFor();
  await page.getByRole('button',{name:'Відкрити',exact:true}).click();await page.locator('.unit-list').waitFor();
  assert.equal(await page.locator('dialog').evaluate(d=>getComputedStyle(d).scrollbarColor),'auto');
  assert.equal(await page.locator('dialog').evaluate(d=>getComputedStyle(d).scrollbarWidth),'auto');
  assert.equal(await page.locator('dialog').evaluate(d=>getComputedStyle(d,'::-webkit-scrollbar').width),'auto');
  checks.push('forced-colors: native OS scrollbar restored');
  await context.close();assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks}));
} finally {
  await browser?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('laba-scrollbars-browser-'));fs.rmSync(resolved,{recursive:true});
}
