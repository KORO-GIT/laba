import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import sharp from 'sharp';
import {createErp,migrateErp} from '../src/erp-database.mjs';
import {registerErpRoutes} from '../src/erp-routes.mjs';
import {GUIDE_IMAGE_LIMIT} from '../src/erp-guides.mjs';

function fixture(context) {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,display_name TEXT,role TEXT,enabled INTEGER DEFAULT 1);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY);
    INSERT INTO users VALUES(1,'admin@example.test','Admin','admin',1),(2,'worker@example.test','Worker','viewer',1),(3,'manager@example.test','Manager','viewer',1),(4,'none@example.test','No ERP','viewer',1),(5,'disabled@example.test','Disabled','admin',0);`);
  const erp=createErp(db);db.exec("INSERT INTO erp_members VALUES(2,'technician'),(3,'manager')");
  const app=Fastify();
  app.addHook('onRequest',async(request,reply)=>{
    request.portalUser=db.prepare('SELECT * FROM users WHERE id=?').get(Number(request.headers['x-test-user']||1));
    if(!request.portalUser?.enabled)return reply.code(401).send({error:'Unauthorized'});
  });
  registerErpRoutes(app,erp);
  context.after(async()=>{await app.close();db.close();});
  async function request(path,body,user=1,key=crypto.randomUUID(),headers={}) {
    return app.inject({method:body===undefined?'GET':'POST',url:`/api/erp/${path}`,headers:{host:'localhost',origin:'http://localhost','x-portal-request':'1','x-erp-request-id':key,'x-test-user':String(user),...headers},...(body===undefined?{}:{payload:body})});
  }
  async function ok(path,body,user=1,key){const response=await request(path,body,user,key);assert.equal(response.statusCode,200,response.body);return response.json();}
  return {db,erp,request,ok};
}
const guide=(extra={})=>({title:'Огляд обладнання',summary:'Фото та комплектність',category:'Обслуговування',model:'Модель А',steps:[{title:'Перевірка комплектності',text:'Звірити з документом',imageId:null,caption:''}],...extra});
async function photo(extra={}) {
  const image=await sharp({create:{width:120,height:80,channels:3,background:'#f26430'}}).jpeg().withExif({IFD0:{Artist:'PRIVATE ARTIST',Copyright:'PRIVATE'}}).toBuffer();
  return {filename:'photo.jpg',data:image.toString('base64'),...extra};
}

test('ERP guides keep draft content private and publish only explicit revisions',async context=>{
  const f=fixture(context),created=await f.ok('guides',guide());
  assert.equal((await f.ok('guides',undefined,2)).count,0);
  assert.equal((await f.request(`guides/${created.id}`,undefined,2)).statusCode,404);
  assert.equal((await f.request(`guides/${created.id}?draft=1`,undefined,2)).statusCode,403);
  assert.equal((await f.request('guides?scope=all',undefined,3)).statusCode,403);
  const published=await f.ok(`guides/${created.id}`,guide({version:1,publish:true}));
  assert.equal((await f.ok(`guides/${created.id}`,undefined,2)).document.title,'Огляд обладнання');
  await f.ok(`guides/${created.id}`,guide({version:published.version,title:'НОВА ЧЕРНЕТКА',steps:[{title:'Новий крок',text:'Прихований текст',imageId:null,caption:''}]}));
  assert.equal((await f.ok(`guides/${created.id}`,undefined,2)).document.title,'Огляд обладнання');
  assert.equal((await f.ok('guides?q=прихований',undefined,2)).count,0);
  assert.equal((await f.ok('guides?q=ОГЛЯД',undefined,2)).count,1);
  assert.equal((await f.ok('guides?scope=draft&q=нова')).count,1);
  assert.equal((await f.request(`guides/${created.id}`,guide({version:2,publish:true}))).statusCode,409);
  await f.ok(`guides/${created.id}`,guide({version:3,title:'Оновлена інструкція',publish:true}));
  assert.equal((await f.ok(`guides/${created.id}`,undefined,2)).document.title,'Оновлена інструкція');
});

test('ERP guide writes are admin-only and reject CSRF, disabled users and malformed payloads',async context=>{
  const f=fixture(context);
  for(const user of [2,3,4])assert.equal((await f.request('guides',guide(),user)).statusCode,403);
  assert.equal((await f.request('guides',guide(),5)).statusCode,401);
  assert.equal((await f.request('guides',undefined,4)).statusCode,403);
  for(const headers of [{origin:'https://evil.test'},{origin:'http://localhost:99'},{'x-portal-request':'0'},{'sec-fetch-site':'same-site'}])assert.equal((await f.request('guides',guide(),1,crypto.randomUUID(),headers)).statusCode,403);
  assert.equal((await f.request('guides',guide(),1,'invalid')).statusCode,400);
  for(const body of [guide({title:''}),guide({steps:[]}),guide({steps:Array(31).fill(guide().steps[0])}),guide({unexpected:true}),guide({steps:[{title:'',text:'',imageId:null,caption:''}],publish:true})])assert.equal((await f.request('guides',body)).statusCode,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_guides').get().n,0);
});

test('ERP guide image upload decodes, strips metadata and serves only published referenced images',async context=>{
  const f=fixture(context),created=await f.ok('guides',guide()),other=await f.ok('guides',guide({title:'Інша'}));
  const body=await photo({version:1}),key=crypto.randomUUID();
  const image=await f.ok(`guides/${created.id}/images`,body,1,key);
  assert.equal((await f.request(`guides/${created.id}/images/${image.id}`,undefined,2)).statusCode,404);
  assert.equal((await f.request(`guides/${created.id}/images/${image.id}`,undefined,4)).statusCode,403);
  const content=await f.request(`guides/${created.id}/images/${image.id}`);
  assert.equal(content.statusCode,200);assert.equal(content.headers['content-type'],'image/webp');assert.equal(content.headers['cache-control'],'no-store');assert.equal(content.headers['x-content-type-options'],'nosniff');
  const metadata=await sharp(content.rawPayload).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.exif,undefined);assert.equal(metadata.xmp,undefined);assert.equal(metadata.width,120);
  const withImage=guide({version:1,publish:true,steps:[{title:'Комплектність',text:'Текст',imageId:image.id,caption:'Фото до огляду'}]});
  assert.equal((await f.request(`guides/${other.id}`,withImage)).statusCode,400);
  await f.ok(`guides/${created.id}`,withImage);
  assert.equal((await f.request(`guides/${created.id}/images/${image.id}`,undefined,2)).statusCode,200);
  assert.equal((await f.request(`guides/${other.id}/images/${image.id}`,undefined,2)).statusCode,404);
  // Retry remains idempotent even after the guide revision changed.
  assert.equal((await f.ok(`guides/${created.id}/images`,body,1,key)).id,image.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_guide_images').get().n,1);
  assert.equal((await f.request(`guides/${created.id}/images`,{...body,filename:'changed.jpg'},1,key)).statusCode,409);
});

test('ERP guides reject forged, oversized, animated/active and corrupt image inputs',async context=>{
  const f=fixture(context),created=await f.ok('guides',guide()),path=`guides/${created.id}/images`,valid=await photo({version:1});
  for(const user of [2,3,4])assert.equal((await f.request(path,valid,user)).statusCode,403);
  for(const body of [
    {...valid,filename:'../photo.jpg'},{...valid,filename:'x.svg'},
    {...valid,data:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')},
    {...valid,data:valid.data.slice(0,40)}, {...valid,data:valid.data+'\n'},
    {...valid,filename:'image.png'}, {...valid,data:Buffer.from('GIF89a').toString('base64')}
  ])assert.equal((await f.request(path,body)).statusCode,400);
  const huge=await sharp({create:{width:4100,height:4100,channels:3,background:'#123'}}).png().toBuffer();
  assert.equal((await f.request(path,{version:1,filename:'huge.png',data:huge.toString('base64')})).statusCode,400);
  const animation=await sharp(Buffer.concat([Buffer.alloc(20*20*3,0),Buffer.alloc(20*20*3,255)]),{raw:{width:20,height:40,channels:3,pageHeight:20}}).webp({loop:0,delay:[100,100]}).toBuffer();
  assert.equal((await sharp(animation).metadata()).pages,2);
  assert.equal((await f.request(path,{version:1,filename:'animation.webp',data:animation.toString('base64')})).statusCode,400);
  assert.equal((await f.request(path,{...valid,data:'A'.repeat(9*1024*1024)})).statusCode,413);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_guide_images').get().n,0);
});

test('ERP guides archive without deletion and immediately revoke reader/image access',async context=>{
  const f=fixture(context),created=await f.ok('guides',guide()),image=await f.ok(`guides/${created.id}/images`,await photo({version:1}));
  await f.ok(`guides/${created.id}`,guide({version:1,publish:true,steps:[{...guide().steps[0],imageId:image.id}]}));
  await f.ok(`guides/${created.id}/archive`,{version:2,archived:true});
  assert.equal((await f.ok('guides',undefined,2)).count,0);
  assert.equal((await f.request(`guides/${created.id}`,undefined,2)).statusCode,404);
  assert.equal((await f.request(`guides/${created.id}/images/${image.id}`,undefined,2)).statusCode,404);
  assert.equal((await f.ok('guides?scope=archived')).count,1);
  assert.equal((await f.request(`guides/${created.id}`,guide({version:3}))).statusCode,409);
  await f.ok(`guides/${created.id}/archive`,{version:3,archived:false});
  assert.equal((await f.request(`guides/${created.id}/images/${image.id}`,undefined,2)).statusCode,200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_guide_images').get().n,1);
});

test('ERP guides paginate, preserve replay and keep SQLite image records through repeated migrations',async context=>{
  const f=fixture(context),key=crypto.randomUUID(),body=guide({publish:true});
  const created=await f.ok('guides',body,1,key);assert.deepEqual(await f.ok('guides',body,1,key),created);
  for(let n=0;n<25;n++)await f.ok('guides',guide({title:`Інструкція ${n}`,publish:true}));
  assert.equal((await f.ok('guides',undefined,2)).items.length,24);assert.equal((await f.ok('guides?page=1',undefined,2)).items.length,2);
  const image=await f.ok(`guides/${created.id}/images`,await photo({version:1}));
  const before=f.db.prepare('SELECT * FROM erp_guide_images WHERE id=?').get(image.id);
  migrateErp(f.db);migrateErp(f.db);assert.deepEqual(f.db.prepare('SELECT * FROM erp_guide_images WHERE id=?').get(image.id),before);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('quick_check',{simple:true}),'ok');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_events WHERE action='guide.created' OR action='guide.published'").get().n,26);
});

test('ERP guide image storage has aggregate and per-guide quotas without erasing content',async context=>{
  const f=fixture(context),created=await f.ok('guides',guide());
  f.db.prepare('INSERT INTO erp_guide_images VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),created.id,Buffer.from('quota fixture'),GUIDE_IMAGE_LIMIT,1,1,1,Date.now());
  assert.equal((await f.request(`guides/${created.id}/images`,await photo({version:1}))).statusCode,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_guide_images').get().n,1);
  f.db.prepare('UPDATE erp_guide_images SET byte_size=1').run();
  for(let n=1;n<100;n++)f.db.prepare('INSERT INTO erp_guide_images VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),created.id,Buffer.from('x'),1,1,1,1,Date.now());
  assert.equal((await f.request(`guides/${created.id}/images`,await photo({version:1}))).statusCode,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM erp_guide_images').get().n,100);
});
