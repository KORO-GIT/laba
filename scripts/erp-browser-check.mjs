import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base='http://127.0.0.1:8083';
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
const errors=[];
try {
  const desktop=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const page=await desktop.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(`${base}/erp`);
  await page.getByRole('heading',{name:'Виробництво під контролем'}).waitFor();
  await page.screenshot({path:path.resolve('data/erp-desktop.png'),fullPage:true});
  for(const name of ['Замовлення','Склад','Команда','Клієнти','Шаблони робіт']) {
    await page.getByRole('link',{name,exact:true}).click();
    await page.getByRole('heading',{name:name==='Склад'?'Склад комплектуючих':name,exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`${name} desktop overflows`);
  }
  await page.getByRole('link',{name:'Замовлення',exact:true}).click();
  await page.getByRole('button',{name:'Відкрити',exact:true}).first().click();
  await page.locator('dialog[open] .unit-list').waitFor();
  assert.equal(await page.locator('dialog[open] .unit-row').count(),12);
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  await page.getByRole('button',{name:'Прийняти партію',exact:true}).click();
  await page.locator('dialog[open] form').waitFor();
  await page.getByRole('button',{name:'Закрити',exact:true}).click();
  const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,extraHTTPHeaders:{'X-Dev-User-Email':'olena@example.test'},reducedMotion:'reduce'});
  const phone=await mobile.newPage();
  phone.on('pageerror',error=>errors.push(error.message));
  phone.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await phone.goto(`${base}/erp#my`);
  await phone.getByRole('heading',{name:'Моя робота',exact:true}).waitFor();
  assert.equal(await phone.getByRole('link',{name:'Склад',exact:true}).count(),0);
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile overflows');
  if (!await phone.locator('.task-card.running').count()) {
    await phone.locator('.task-card button:enabled').filter({hasText:/^(Почати|Продовжити)$/}).first().click();
    await phone.locator('.task-card.running').waitFor();
  }
  await phone.screenshot({path:path.resolve('data/erp-mobile.png')});
  const running=phone.locator('.task-card.running');
  await running.getByRole('button',{name:'Пауза',exact:true}).click();
  await phone.locator('.task-card.running').waitFor({state:'hidden'});
  await phone.getByRole('status').filter({hasText:'Збережено в обліку'}).waitFor();
  await phone.locator('.task-card').filter({hasText:'На паузі'}).getByRole('button',{name:'Продовжити',exact:true}).click();
  await phone.locator('.task-card.running').waitFor();
  await phone.locator('.task-card.running').getByRole('button',{name:'Готово',exact:true}).click();
  await phone.getByRole('button',{name:'Підтвердити',exact:true}).click();
  await phone.locator('dialog[open]').waitFor({state:'hidden'});
  await phone.locator('.task-card.running').waitFor({state:'hidden'});
  await phone.getByRole('link',{name:'Мої зміни',exact:true}).click();
  await phone.getByRole('heading',{name:'Мої зміни',exact:true}).waitFor();
  await phone.setViewportSize({width:360,height:740});
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'small mobile overflows');
  assert.deepEqual(errors,[],'browser errors');
  console.log(JSON.stringify({ok:true,desktop:'data/erp-desktop.png',mobile:'data/erp-mobile.png',checks:['admin navigation','order detail','receipt form','technician isolation','mobile pause/resume/complete','shifts','360px layout','CSP/page errors']}));
} finally { await browser.close(); }
