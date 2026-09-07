// Isolated localhost database and synthetic instructions only; never connects to production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const base='http://127.0.0.1:8088';
try{await fetch(`${base}/healthz`);throw Error('Port 8088 occupied');}catch(error){if(error.message.includes('occupied'))throw error;}
const temporaryRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryRoot,'laba-guides-browser-'));
const server=spawn(process.execPath,['src/server.mjs'],{stdio:'ignore',windowsHide:true,env:{...process.env,AUTH_MODE:'development',NODE_ENV:'development',PORT:'8088',DB_PATH:path.join(directory,'test.db'),BOOTSTRAP_ADMIN_EMAIL:'admin@local.test',DEV_USER_EMAIL:'admin@local.test'}});
let browser;const errors=[],checks=[];
async function api(endpoint,body,email='admin@local.test'){
  const response=await fetch(`${base}/api/erp/${endpoint}`,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json','x-portal-request':'1','x-erp-request-id':crypto.randomUUID(),'x-dev-user-email':email},body:body?JSON.stringify(body):undefined});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
}
try{
  let ready=false;for(let n=0;n<150;n++){if(server.exitCode!==null)throw Error('Local server exited');try{if((await fetch(`${base}/healthz`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  await api('members',{name:'Майстер Тест',email:'worker@example.test',role:'technician'});
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
  const adminContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await adminContext.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(`${base}/erp#guides`);await page.getByRole('heading',{name:'Корисні матеріали',exact:true}).waitFor();
  await page.getByRole('button',{name:'Нова інструкція',exact:true}).click();
  assert.equal(await page.locator('input[type=file]').isDisabled(),true);
  await page.getByLabel('Назва інструкції',{exact:true}).fill('Огляд комплектності · тест');
  await page.getByLabel('Категорія',{exact:true}).fill('Обслуговування');
  await page.getByLabel('Модель / обладнання',{exact:true}).fill('Тестове обладнання');
  await page.getByLabel('Короткий опис',{exact:true}).fill('Синтетична інструкція для перевірки інтерфейсу. Не є робочою процедурою.');
  await page.getByLabel('Назва кроку',{exact:true}).fill('Звірити з документом');
  const stepText='Звірте перелік отриманого обладнання з документом приймання.\n\nЗафіксуйте розбіжності. <img src=x onerror=alert(1)>';
  await page.getByLabel('Що зробити',{exact:true}).fill(stepText);
  await page.getByRole('button',{name:'Зберегти чернетку',exact:true}).click();
  await page.getByText('Чернетку збережено. Тепер можна додавати фото.',{exact:true}).waitFor();
  // The save message precedes refreshing the list; wait for finally() to unlock the form.
  await page.waitForFunction(()=>document.querySelector('input[type=file]')?.disabled===false);
  assert.equal(await page.locator('input[type=file]').isDisabled(),false);
  const created=(await api('guides?scope=draft')).items[0];assert.ok(created);
  assert.equal((await api('guides',undefined,'worker@example.test')).count,0);
  const buffer=await sharp({create:{width:1200,height:700,channels:3,background:'#f26430'}}).png().toBuffer();
  await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer});
  await page.getByText('Фото додано. Збережіть чернетку або опублікуйте зміни.',{exact:true}).waitFor();
  await page.getByLabel('Підпис до фото',{exact:true}).fill('Тестове фото — зразок відображення');
  await page.getByRole('button',{name:'Додати крок',exact:true}).click();
  await page.getByLabel('Назва кроку',{exact:true}).nth(1).fill('Зберегти результат');
  await page.getByLabel('Що зробити',{exact:true}).nth(1).fill('Зафіксуйте результат перевірки у відповідній картці.');
  await page.getByRole('button',{name:'Нижче',exact:true}).first().click();
  assert.equal(await page.getByLabel('Назва кроку',{exact:true}).first().inputValue(),'Зберегти результат');
  await page.getByRole('button',{name:'Вище',exact:true}).nth(1).click();
  await page.getByRole('button',{name:'Попередній перегляд',exact:true}).click();
  await page.locator('.guide-preview:not(.hidden)').waitFor();assert.equal(await page.locator('.guide-step-text img').count(),0);
  await page.getByRole('button',{name:'Опублікувати',exact:true}).click();
  await page.getByText('Опубліковано: майстри бачать цю версію.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  await page.screenshot({path:path.resolve('data/erp-guides-admin-dark.png')});
  checks.push('admin draft / upload / reorder / preview / publish / literal text');
  for(const [width,theme] of [[1440,'dark'],[1440,'light'],[390,'dark'],[360,'light']]){
    const context=await browser.newContext({viewport:{width,height:860},isMobile:width<500,hasTouch:width<500,reducedMotion:'reduce',extraHTTPHeaders:{'x-dev-user-email':'worker@example.test'}}),worker=await context.newPage();
    worker.on('pageerror',e=>errors.push(e.message));let posts=0;worker.on('request',r=>{if(r.method()==='POST')posts++;});
    await worker.goto(`${base}/erp#my`);await worker.getByRole('link',{name:'Інструкції',exact:true}).click();
    await worker.getByRole('heading',{name:'Корисні матеріали',exact:true}).waitFor();
    if(theme==='light')await worker.getByRole('button',{name:'Увімкнути світлу тему',exact:true}).click();
    assert.equal(await worker.getByRole('button',{name:'Нова інструкція',exact:true}).count(),0);
    assert.equal(await worker.getByRole('button',{name:'Редагувати',exact:true}).count(),0);
    const search=worker.getByPlaceholder('Пошук інструкції, моделі або категорії');
    await search.fill('неіснуюче');await worker.getByRole('heading',{name:'Нічого не знайдено',exact:true}).waitFor();
    await search.fill('КОМПЛЕКТНОСТІ');await worker.getByRole('button',{name:'Читати',exact:true}).waitFor();
    await worker.screenshot({path:path.resolve(`data/erp-guides-list-${width}-${theme}.png`)});
    await worker.getByRole('button',{name:'Читати',exact:true}).click();
    await worker.waitForFunction(()=>document.querySelector('.guide-step img')?.naturalWidth>0);
    assert.equal(await worker.locator('.guide-step-text').first().textContent(),stepText);
    assert.equal(await worker.locator('.guide-step-text img').count(),0);
    assert.equal(await worker.locator('.guide-step a').getAttribute('target'),'_blank');
    await worker.getByRole('button',{name:'2. Зберегти результат',exact:true}).click();
    assert.ok(await worker.locator('dialog').evaluate(d=>d.scrollTop>0));
    await worker.locator('dialog').evaluate(d=>{d.scrollTop=0;});
    await worker.screenshot({path:path.resolve(`data/erp-guides-reader-${width}-${theme}.png`)});
    assert.equal(await worker.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await worker.locator('dialog').evaluate(d=>d.scrollWidth>d.clientWidth),false);
    assert.equal(posts,0);await worker.keyboard.press('Escape');await context.close();
    checks.push(`reader ${width} ${theme}: nav / search / photo / TOC / no overflow / read-only`);
  }
  // Saving a newer draft preserves the published snapshot. A conflicting save preserves local fields.
  await page.getByRole('button',{name:'Редагувати',exact:true}).click();
  await page.getByLabel('Назва інструкції',{exact:true}).fill('Нова чернетка');
  await page.getByRole('button',{name:'Зберегти чернетку',exact:true}).click();
  await page.getByText('Чернетку збережено. Тепер можна додавати фото.',{exact:true}).waitFor();
  assert.equal((await api(`guides/${created.id}`,undefined,'worker@example.test')).document.title,created.title);
  const latest=await api(`guides/${created.id}?draft=1`);
  await api(`guides/${created.id}`,{...latest.document,version:latest.version});
  await page.getByLabel('Назва інструкції',{exact:true}).fill('Мій незбережений текст');
  await page.getByRole('button',{name:'Зберегти чернетку',exact:true}).click();
  await page.locator('dialog .dialog-header #toast[role=alert].show').waitFor();
  assert.equal(await page.getByLabel('Назва інструкції',{exact:true}).inputValue(),'Мій незбережений текст');
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  await page.getByRole('button',{name:'Редагувати',exact:true}).click();
  await page.getByRole('button',{name:'Прибрати фото з кроку',exact:true}).first().click();
  await page.getByRole('button',{name:'Раніше додані фото',exact:true}).first().click();
  await page.getByRole('button',{name:'Фото 1',exact:true}).click();
  assert.equal(await page.locator('.guide-editor-photo img').count(),1);
  await page.getByRole('button',{name:'Зберегти чернетку',exact:true}).click();
  await page.getByText('Чернетку збережено. Тепер можна додавати фото.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'До архіву',exact:true}).click();await page.locator('dialog[open]').waitFor({state:'hidden'});
  assert.equal((await api('guides',undefined,'worker@example.test')).count,0);
  await page.getByRole('button',{name:'Архів',exact:true}).click();await page.getByRole('button',{name:'Переглянути',exact:true}).click();
  await page.getByRole('button',{name:'Повернути з архіву',exact:true}).click();await page.locator('dialog[open]').waitFor({state:'hidden'});
  assert.equal((await api('guides',undefined,'worker@example.test')).count,1);
  checks.push('stable published revision / 409 preserves inputs and top-layer error / reuse photo / archive and restore');
  // Mobile administration: fields, upload button and footer remain inside the modal.
  const mobile=await browser.newContext({viewport:{width:360,height:860},isMobile:true,hasTouch:true}),editor=await mobile.newPage();
  editor.on('pageerror',e=>errors.push(e.message));await editor.goto(`${base}/erp#guides`);
  await editor.getByRole('button',{name:'Редагувати',exact:true}).click();await editor.locator('.guide-editor').waitFor();
  await editor.screenshot({path:path.resolve('data/erp-guides-editor-360.png')});
  assert.equal(await editor.locator('dialog').evaluate(d=>d.scrollWidth>d.clientWidth),false);
  await editor.getByRole('button',{name:'Опублікувати',exact:true}).scrollIntoViewIfNeeded();
  await editor.screenshot({path:path.resolve('data/erp-guides-editor-footer-360.png')});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks}));
}finally{
  await browser?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
  const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('laba-guides-browser-'));fs.rmSync(resolved,{recursive:true});
}
