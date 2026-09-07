import crypto from 'node:crypto';

export const GUIDE_ROLES=['admin','manager','warehouse','technician','inspector','observer'];
export const GUIDE_IMAGE_LIMIT=256*1024*1024;

export function migrateGuides(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS erp_guides (
      id INTEGER PRIMARY KEY, draft_json TEXT NOT NULL, published_json TEXT,
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1, published_at INTEGER,
      created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS erp_guide_images (
      id TEXT PRIMARY KEY, guide_id INTEGER NOT NULL REFERENCES erp_guides(id),
      content BLOB NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0),
      width INTEGER NOT NULL, height INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS erp_guide_images_guide ON erp_guide_images(guide_id);
  `);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(name) VALUES(?)').run('erp_guides_v1');
}

// All writes run in ERP's existing IMMEDIATE transaction (including request replay and audit).
export function createGuideFeatures({get,all,run,insert,entity,version,role,requireRole,event,fail,now}) {
  const admin=user=>requireRole(user,['admin']);
  const parse=row=>JSON.parse(row);
  const summary=(row,document)=>({id:row.id,title:document.title,summary:document.summary,category:document.category,model:document.model,
    steps:document.steps.length,photos:document.steps.filter(s=>s.imageId).length,
    status:row.archived?'archived':row.published_json?'published':'draft',hasChanges:row.draft_json!==row.published_json,
    version:row.version,updatedAt:row.updated_at,publishedAt:row.published_at});
  function guideList(user,query) {
    requireRole(user,GUIDE_ROLES);
    const isAdmin=role(user)==='admin';
    if(!isAdmin&&query.scope!=='published')fail(403,'Чернетки доступні лише адміністратору');
    const document=isAdmin&&query.scope!=='published'?'draft_json':'published_json';
    const where=[query.scope==='archived'?'archived=1':query.scope==='all'?'1=1':'archived=0'];
    if(query.scope==='published')where.push('published_json IS NOT NULL');
    if(query.scope==='draft')where.push('(published_json IS NULL OR draft_json!=published_json)');
    const args=[];
    if(query.q.trim()){where.push(`instr(erp_casefold(${document}),?)>0`);args.push(query.q.trim().toLocaleLowerCase('uk-UA'));}
    const condition=where.join(' AND '),count=get(`SELECT COUNT(*) AS n FROM erp_guides WHERE ${condition}`,...args).n;
    const rows=all(`SELECT * FROM erp_guides WHERE ${condition} ORDER BY updated_at DESC,id DESC LIMIT 24 OFFSET ?`,...args,query.page*24);
    return {items:rows.map(row=>summary(row,parse(row[document]))),count,page:query.page,pageSize:24,
      ...(isAdmin?{imageBytes:get('SELECT COALESCE(SUM(byte_size),0) AS n FROM erp_guide_images').n,imageLimit:GUIDE_IMAGE_LIMIT}:{})};
  }
  function guideDetail(user,id,draft=false) {
    requireRole(user,GUIDE_ROLES);if(draft)admin(user);
    const row=entity('erp_guides',id);
    if(!draft&&(row.archived||!row.published_json))fail(404,'Опубліковану інструкцію не знайдено');
    const document=parse(draft?row.draft_json:row.published_json);
    const images=all('SELECT id,width,height,byte_size FROM erp_guide_images WHERE guide_id=?',id);
    const used=new Set(document.steps.map(s=>s.imageId).filter(Boolean));
    return {...summary(row,document),document,images:images.filter(i=>draft||used.has(i.id))};
  }
  function saveGuide(user,id,body) {
    admin(user);
    const before=id?entity('erp_guides',id):null;
    if(before){version(before,body.version);if(before.archived)fail(409,'Спочатку поверніть інструкцію з архіву');}
    else if(get('SELECT COUNT(*) AS n FROM erp_guides').n>=1000)fail(409,'Досягнуто межі 1000 інструкцій');
    const document={title:body.title,summary:body.summary,category:body.category,model:body.model,steps:body.steps};
    for(const step of body.steps)if(step.imageId&&!get('SELECT id FROM erp_guide_images WHERE id=? AND guide_id=?',step.imageId,id??0))fail(400,'Фото не належить цій інструкції');
    if(body.publish&&body.steps.some(step=>!step.title||(!step.text&&!step.imageId)))fail(400,'Перед публікацією додайте назву та текст або фото до кожного кроку');
    const json=JSON.stringify(document),time=now();
    if(before)run(`UPDATE erp_guides SET draft_json=?,published_json=?,published_at=?,version=version+1,updated_by=?,updated_at=? WHERE id=?`,json,body.publish?json:before.published_json,body.publish?time:before.published_at,user.id,time,id);
    else id=insert('INSERT INTO erp_guides(draft_json,published_json,published_at,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',json,body.publish?json:null,body.publish?time:null,user.id,user.id,time,time);
    event(user,body.publish?'guide.published':before?'guide.draft_updated':'guide.created','guide',id,{before:before?{draft:parse(before.draft_json),published:before.published_json?parse(before.published_json):null,version:before.version}:null,after:document});
    return {id,version:before?before.version+1:1};
  }
  function archiveGuide(user,id,body) {
    admin(user);const row=entity('erp_guides',id);version(row,body.version);
    run('UPDATE erp_guides SET archived=?,version=version+1,updated_by=?,updated_at=? WHERE id=?',Number(body.archived),user.id,now(),id);
    event(user,body.archived?'guide.archived':'guide.restored','guide',id,{version:row.version});return {id};
  }
  function checkGuideUpload(user,id,expectedVersion) {
    admin(user);const row=entity('erp_guides',id);version(row,expectedVersion);
    if(row.archived)fail(409,'Фото не можна додати до архівної інструкції');
    if(get('SELECT COUNT(*) AS n FROM erp_guide_images WHERE guide_id=?',id).n>=100)fail(409,'До цієї інструкції вже додано 100 фото; зверніться до адміністратора системи');
    if(get('SELECT COALESCE(SUM(byte_size),0) AS n FROM erp_guide_images').n>=GUIDE_IMAGE_LIMIT)fail(409,'Сховище інструкцій заповнене; потрібне розширення');
  }
  function saveGuideImage(user,id,body,image) {
    checkGuideUpload(user,id,body.version);
    if(get('SELECT COALESCE(SUM(byte_size),0) AS n FROM erp_guide_images').n+image.data.length>GUIDE_IMAGE_LIMIT)fail(409,'Сховище інструкцій заповнене; потрібне розширення');
    const imageId=crypto.randomUUID();
    run('INSERT INTO erp_guide_images VALUES(?,?,?,?,?,?,?,?)',imageId,id,image.data,image.data.length,image.width,image.height,user.id,now());
    event(user,'guide.image_added','guide',id,{imageId,bytes:image.data.length,width:image.width,height:image.height});
    return {id:imageId,width:image.width,height:image.height,byte_size:image.data.length};
  }
  function guideImage(user,id,imageId) {
    requireRole(user,GUIDE_ROLES);const row=entity('erp_guides',id);
    if(role(user)!=='admin'&&(row.archived||!row.published_json||!parse(row.published_json).steps.some(s=>s.imageId===imageId)))fail(404,'Фото не знайдено');
    const image=get('SELECT content FROM erp_guide_images WHERE id=? AND guide_id=?',imageId,id);
    if(!image)fail(404,'Фото не знайдено');return image.content;
  }
  return {guideList,guideDetail,saveGuide,archiveGuide,checkGuideUpload,saveGuideImage,guideImage};
}
