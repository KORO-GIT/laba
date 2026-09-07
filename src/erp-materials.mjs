const denied = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export const skuKey = value => value.normalize('NFKC').trim().toLocaleUpperCase('uk-UA');
export function quantityMilli(value, uom = 'pcs') {
  const scaled = value * 1000;
  if (!Number.isFinite(value) || value < 0 || value > 1000000 || Math.abs(scaled - Math.round(scaled)) > 0.000001 || (uom === 'pcs' && !Number.isInteger(value))) denied('Кількість: цілі штуки або до 3 знаків після коми; максимум 1 000 000');
  return Math.round(scaled);
}

export function migrateMaterials(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS erp_materials (
      id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      uom TEXT NOT NULL CHECK(uom IN ('pcs','m','g','ml')),
      minimum_milli INTEGER NOT NULL DEFAULT 0 CHECK(minimum_milli>=0),
      target_milli INTEGER NOT NULL DEFAULT 0 CHECK(target_milli>=minimum_milli),
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS erp_material_specs (
      id INTEGER PRIMARY KEY, template_id INTEGER UNIQUE REFERENCES erp_templates(id),
      order_id INTEGER UNIQUE REFERENCES erp_orders(id),
      source_template_id INTEGER REFERENCES erp_templates(id), source_version INTEGER,
      lines_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      CHECK((template_id IS NULL)!=(order_id IS NULL))
    );
    CREATE TABLE IF NOT EXISTS erp_replenishments (
      id INTEGER PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES erp_materials(id),
      client_id INTEGER REFERENCES erp_clients(id), quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
      received_milli INTEGER NOT NULL DEFAULT 0 CHECK(received_milli>=0 AND received_milli<=quantity_milli),
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','received','cancelled')),
      note TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS erp_one_open_replenishment ON erp_replenishments(material_id,COALESCE(client_id,0)) WHERE state='open';
  `);
  for (const [name, definition] of [
    ['material_id','INTEGER REFERENCES erp_materials(id)'],
    ['quantity_scale','INTEGER NOT NULL DEFAULT 1 CHECK(quantity_scale IN (1,1000))'],
    ['replenishment_id','INTEGER REFERENCES erp_replenishments(id)']
  ]) if (!db.pragma('table_info(erp_stock_lots)').some(column=>column.name===name)) db.exec(`ALTER TABLE erp_stock_lots ADD COLUMN ${name} ${definition}`);
  db.exec('CREATE INDEX IF NOT EXISTS erp_lots_material_owner ON erp_stock_lots(material_id,client_id);');
  db.prepare('INSERT OR IGNORE INTO schema_migrations(name) VALUES(?)').run('erp_materials_v1');
}

// Writes run inside ERP's existing IMMEDIATE transaction, including ledger and request receipt.
export function createMaterialFeatures({ get,all,run,insert,entity,version,requireRole,event,fail,now,moveStock }) {
  const managers = ['admin','manager'];
  const stockRoles = [...managers,'warehouse'];
  const readRoles = [...stockRoles,'observer'];
  const key = (material, owner) => `${material}:${owner??0}`;
  const column = kind => kind === 'template' ? 'template_id' : 'order_id';
  const catalogue = () => all('SELECT * FROM erp_materials ORDER BY name,id');
  function spec(kind,id) {
    const row=get(`SELECT * FROM erp_material_specs WHERE ${column(kind)}=?`,id);
    return row ? {...row,lines:JSON.parse(row.lines_json)} : {version:0,lines:[]};
  }
  function saveMaterial(user,id,body) {
    requireRole(user,managers);
    const before=id?entity('erp_materials',id):null;
    if(before)version(before,body.version);
    else if(get('SELECT COUNT(*) AS n FROM erp_materials').n>=500)fail(409,'Досягнуто межі 500 позицій номенклатури; потрібне розширення каталогу');
    const sku=skuKey(body.sku);
    if(before&&(before.sku!==sku||before.uom!==body.uom))fail(409,'Артикул і одиниця обліку незмінні. Створіть окрему позицію для іншої одиниці');
    const minimum=quantityMilli(body.minimum,body.uom),target=quantityMilli(body.target,body.uom);
    if(target<minimum)fail(400,'Цільовий запас має бути не меншим за мінімальний');
    if(before)run('UPDATE erp_materials SET name=?,minimum_milli=?,target_milli=?,version=version+1 WHERE id=?',body.name,minimum,target,id);
    else id=insert('INSERT INTO erp_materials(sku,name,uom,minimum_milli,target_milli,created_at) VALUES(?,?,?,?,?,?)',sku,body.name,body.uom,minimum,target,now());
    event(user,before?'material.updated':'material.created','material',id,{before,after:body});
    return {id};
  }
  function saveSpec(user,kind,id,body) {
    requireRole(user,managers);
    entity(kind==='template'?'erp_templates':'erp_orders',id);
    const before=spec(kind,id);version(before,body.version);
    if(kind==='order'&&get("SELECT id FROM erp_units WHERE order_id=? AND state IN ('ready','delivered')",id))fail(409,'Норми замовлення зафіксовані після першого прийнятого контролем виробу');
    const lines=body.lines.map(line=>{
      const material=entity('erp_materials',line.materialId);
      const quantity=quantityMilli(line.quantity,material.uom);
      if(!quantity)fail(400,'Норма має бути більшою за нуль');
      return {materialId:material.id,sku:material.sku,name:material.name,uom:material.uom,source:line.source,quantityMilli:quantity};
    });
    if(before.id)run('UPDATE erp_material_specs SET lines_json=?,version=version+1 WHERE id=?',JSON.stringify(lines),before.id);
    else insert(`INSERT INTO erp_material_specs(${column(kind)},lines_json) VALUES(?,?)`,id,JSON.stringify(lines));
    if(kind==='order')run('UPDATE erp_orders SET version=version+1 WHERE id=?',id);
    event(user,'materials.spec_updated',kind,id,{before:{version:before.version,lines:before.lines},after:lines});
    return {id,version:before.version+1};
  }
  function copyTemplate(user,orderId,templateId) {
    if(!templateId)return;
    const source=spec('template',templateId);
    if(!source.lines.length)return;
    insert('INSERT INTO erp_material_specs(order_id,source_template_id,source_version,lines_json) VALUES(?,?,?,?)',orderId,templateId,source.version,JSON.stringify(source.lines));
    event(user,'materials.spec_copied','order',orderId,{templateId,sourceVersion:source.version,lines:source.lines});
  }
  function linkLot(user,id,body) {
    requireRole(user,managers);
    const lot=entity('erp_stock_lots',id),material=entity('erp_materials',body.materialId);
    if(lot.material_id)fail(409,'Партію вже зв’язано з номенклатурою');
    if(material.uom!=='pcs'||skuKey(lot.sku)!==material.sku)fail(400,'Стару партію можна зв’язати лише з тим самим артикулом в одиниці «шт.»');
    run('UPDATE erp_stock_lots SET material_id=? WHERE id=?',material.id,id);
    event(user,'material.lot_linked','lot',id,{materialId:material.id});
    return {id};
  }
  function receiptInfo(body) {
    const material=body.materialId?entity('erp_materials',body.materialId):null;
    const quantity=quantityMilli(body.quantity,material?.uom??'pcs');
    if(!quantity)fail(400,'Кількість має бути більшою за нуль');
    if(body.replenishmentId&&!material)fail(400,'Для заявки потрібна позиція номенклатури');
    if(body.replenishmentId) {
      const request=entity('erp_replenishments',body.replenishmentId);
      if(request.state!=='open'||request.material_id!==material.id||request.client_id!==body.clientId)fail(409,'Заявка закрита або має інший матеріал чи власника');
      if(body.originUnitId||!['new','good'].includes(body.condition))fail(400,'Заявку закривають лише придатні нові надходження, не зняті деталі');
      if(quantity>request.quantity_milli-request.received_milli)fail(409,'Надходження перевищує залишок заявки; спочатку уточніть її кількість');
    }
    return {material,scale:material?1000:1,quantity:material?quantity:quantity/1000};
  }
  function receiveReplenishment(user,id,quantity,lotId) {
    if(!id)return;
    run("UPDATE erp_replenishments SET received_milli=received_milli+?,state=CASE WHEN received_milli+?=quantity_milli THEN 'received' ELSE 'open' END,version=version+1 WHERE id=?",quantity,quantity,id);
    event(user,'replenishment.received','replenishment',id,{lotId,quantityMilli:quantity});
  }
  function saveReplenishment(user,id,body) {
    requireRole(user,stockRoles);
    const before=id?entity('erp_replenishments',id):null;
    if(before){version(before,body.version);if(before.state!=='open')fail(409,'Заявку вже закрито');}
    const material=entity('erp_materials',before?.material_id??body.materialId);
    const owner=before?before.client_id:body.clientId;
    if(owner)entity('erp_clients',owner);
    const quantity=quantityMilli(body.quantity,material.uom);
    if(!quantity||quantity<(before?.received_milli??0))fail(400,'Кількість має бути додатною та не меншою за вже отримане');
    const state=body.cancel?'cancelled':quantity===(before?.received_milli??0)?'received':'open';
    if(before)run('UPDATE erp_replenishments SET quantity_milli=?,state=?,note=?,version=version+1 WHERE id=?',quantity,state,body.note,id);
    else id=insert('INSERT INTO erp_replenishments(material_id,client_id,quantity_milli,note,actor_id,created_at) VALUES(?,?,?,?,?,?)',material.id,owner,quantity,body.note,user.id,now());
    event(user,before?'replenishment.updated':'replenishment.created','replenishment',id,{before,after:body});
    return {id};
  }
  function requests(user,query={page:0}) {
    requireRole(user,readRoles);
    const count=get('SELECT COUNT(*) AS n FROM erp_replenishments').n;
    return {count,page:query.page,pageSize:50,rows:all(`SELECT r.*,m.sku,m.name,m.uom,COALESCE(c.name,'Майстерня') AS owner_name,u.display_name AS actor
      FROM erp_replenishments r JOIN erp_materials m ON m.id=r.material_id LEFT JOIN erp_clients c ON c.id=r.client_id JOIN users u ON u.id=r.actor_id
      ORDER BY CASE r.state WHEN 'open' THEN 0 ELSE 1 END,r.id DESC LIMIT 50 OFFSET ?`,query.page*50)};
  }
  const committedSql=`SELECT l.material_id,l.client_id,m.unit_id,
    SUM((CASE WHEN m.to_location IN ('workbench','installed') THEN m.quantity ELSE 0 END-CASE WHEN m.from_location IN ('workbench','installed') THEN m.quantity ELSE 0 END)*(1000/l.quantity_scale)) AS qty
    FROM erp_stock_moves m JOIN erp_stock_lots l ON l.id=m.lot_id
    WHERE l.material_id IS NOT NULL AND m.unit_id IS NOT NULL AND l.condition IN ('new','good') GROUP BY l.material_id,l.client_id,m.unit_id`;
  function planning(user) {
    requireRole(user,readRoles);
    const materials=catalogue(),byId=new Map(materials.map(m=>[m.id,m]));
    const groups=new Map();
    const group=(materialId,clientId)=>{
      const k=key(materialId,clientId);
      if(!groups.has(k))groups.set(k,{materialId,clientId,warehouseMilli:0,demandMilli:0,requestedMilli:0,orderCount:0});
      return groups.get(k);
    };
    for(const material of materials)group(material.id,null);
    for(const row of all(`SELECT l.material_id,l.client_id,SUM((CASE WHEN m.to_location='warehouse' THEN m.quantity ELSE 0 END-CASE WHEN m.from_location='warehouse' THEN m.quantity ELSE 0 END)*(1000/l.quantity_scale)) AS qty
      FROM erp_stock_lots l JOIN erp_stock_moves m ON m.lot_id=l.id WHERE l.material_id IS NOT NULL AND l.condition IN ('new','good') GROUP BY l.material_id,l.client_id`))group(row.material_id,row.client_id).warehouseMilli=row.qty;
    const demand=all(`WITH committed AS (${committedSql}), requirements AS (
      SELECT u.id AS unit_id,u.order_id,json_extract(j.value,'$.materialId') AS material_id,
        CASE json_extract(j.value,'$.source') WHEN 'client' THEN u.client_id ELSE NULL END AS client_id,json_extract(j.value,'$.quantityMilli') AS qty
      FROM erp_material_specs s JOIN erp_units u ON u.order_id=s.order_id JOIN json_each(s.lines_json) j
      WHERE u.state IN ('received','working','quality'))
      SELECT r.material_id,r.client_id,SUM(MAX(0,r.qty-MAX(0,COALESCE(c.qty,0)))) AS qty,COUNT(DISTINCT r.order_id) AS orders
      FROM requirements r LEFT JOIN committed c ON c.unit_id=r.unit_id AND c.material_id=r.material_id AND c.client_id IS r.client_id GROUP BY r.material_id,r.client_id`);
    for(const row of demand){const g=group(row.material_id,row.client_id);g.demandMilli=row.qty;g.orderCount=row.orders;}
    for(const request of all("SELECT * FROM erp_replenishments WHERE state='open'")){const g=group(request.material_id,request.client_id);g.requestedMilli=request.quantity_milli-request.received_milli;g.requestId=request.id;}
    const clientNames=new Map(all('SELECT id,name FROM erp_clients').map(c=>[c.id,c.name]));
    const rows=[...groups.values()].map(g=>{
      const material=byId.get(g.materialId);
      const minimum=g.clientId?0:material.minimum_milli,target=g.clientId?0:material.target_milli;
      const projected=g.warehouseMilli-g.demandMilli;
      const shortage=Math.max(0,-projected);
      const low=shortage>0||(target>projected&&projected<=minimum);
      return {...g,sku:material.sku,name:material.name,uom:material.uom,ownerName:g.clientId?clientNames.get(g.clientId):'Майстерня',minimumMilli:minimum,targetMilli:target,
        projectedMilli:projected,shortageMilli:shortage,low,suggestedMilli:low?Math.max(0,target-projected-g.requestedMilli):0};
    }).sort((a,b)=>Number(b.low)-Number(a.low)||b.shortageMilli-a.shortageMilli||a.name.localeCompare(b.name,'uk'));
    return {rows,alertCount:rows.filter(r=>r.low).length,unlinkedLots:get('SELECT COUNT(*) AS n FROM erp_stock_lots WHERE material_id IS NULL').n};
  }
  function orderNeeds(id) {
    const order=entity('erp_orders',id),plan=spec('order',id);
    const units=all("SELECT * FROM erp_units WHERE order_id=? AND state IN ('received','working','quality')",id);
    const committed=new Map(all(`SELECT * FROM (${committedSql}) WHERE unit_id IN (SELECT id FROM erp_units WHERE order_id=?)`,id).map(r=>[`${r.unit_id}:${key(r.material_id,r.client_id)}`,r.qty]));
    return {...plan,openUnits:units.length,lines:plan.lines.map(line=>{
      const owner=line.source==='client'?order.client_id:null;
      const remaining=units.reduce((n,u)=>n+Math.max(0,line.quantityMilli-Math.max(0,committed.get(`${u.id}:${key(line.materialId,owner)}`)??0)),0);
      return {...line,plannedMilli:line.quantityMilli*units.length,remainingMilli:remaining};
    })};
  }
  function consume(user,id,body) {
    requireRole(user,stockRoles);
    const order=entity('erp_orders',id),plan=spec('order',id);version(plan,body.specVersion);
    if(!plan.lines.length)fail(409,'Спочатку задайте норми витрат замовлення');
    if(body.units.length*plan.lines.length>2000)fail(400,'За одне проведення — до 2000 рядків норм. Оберіть менше виробів');
    for(const selected of body.units){const unit=entity('erp_units',selected.id);version(unit,selected.version);if(unit.order_id!==id||['ready','delivered'].includes(unit.state))fail(409,'Оберіть неперевірені вироби цього замовлення');}
    let totalMoves=0;
    for(const selected of body.units)for(const line of plan.lines) {
      const owner=line.source==='client'?order.client_id:null;
      const lots=all(`SELECT l.*,
        COALESCE(SUM(CASE WHEN m.unit_id=? THEN CASE WHEN m.to_location='installed' THEN m.quantity WHEN m.from_location='installed' THEN -m.quantity ELSE 0 END ELSE 0 END),0)*(1000/l.quantity_scale) AS installed_milli,
        COALESCE(SUM(CASE WHEN m.unit_id=? THEN CASE WHEN m.to_location='workbench' THEN m.quantity WHEN m.from_location='workbench' THEN -m.quantity ELSE 0 END ELSE 0 END),0)*(1000/l.quantity_scale) AS workbench_milli,
        COALESCE(SUM(CASE WHEN m.to_location='warehouse' THEN m.quantity WHEN m.from_location='warehouse' THEN -m.quantity ELSE 0 END),0)*(1000/l.quantity_scale) AS warehouse_milli
        FROM erp_stock_lots l LEFT JOIN erp_stock_moves m ON m.lot_id=l.id WHERE l.material_id=? AND l.client_id IS ? AND l.condition IN ('new','good') GROUP BY l.id ORDER BY l.created_at,l.id`,selected.id,selected.id,line.materialId,owner);
      let need=Math.max(0,line.quantityMilli-lots.reduce((sum,lot)=>sum+lot.installed_milli,0));
      if(!need)continue;
      if(lots.reduce((sum,l)=>sum+l.workbench_milli+l.warehouse_milli,0)<need)fail(409,`Бракує ${line.sku} для LB-${String(selected.id).padStart(6,'0')}. Жодних часткових списань не зроблено`);
      const note=`Витрата за нормою замовлення ${id}, версія ${plan.version}: ${body.note}`.slice(0,500);
      // First use material already issued to this exact unit, then FIFO eligible warehouse lots.
      for(const lot of lots){const amount=Math.min(need,lot.workbench_milli);if(amount){moveStock(user,lot.id,{from:'workbench',to:'installed',unitId:selected.id,quantity:amount/1000,note});totalMoves++;need-=amount;}}
      for(const lot of lots){const amount=Math.min(need,lot.warehouse_milli);if(amount){moveStock(user,lot.id,{from:'warehouse',to:'workbench',unitId:selected.id,quantity:amount/1000,note});moveStock(user,lot.id,{from:'workbench',to:'installed',unitId:selected.id,quantity:amount/1000,note});totalMoves+=2;need-=amount;}}
    }
    if(!totalMoves)fail(409,'За цими нормами витрату вже враховано. Для додаткової фактичної витрати використайте окремий складський рух');
    event(user,'materials.consumed','order',id,{units:body.units.map(u=>u.id),specVersion:plan.version,note:body.note});
    return {id,units:body.units.length,moves:totalMoves};
  }
  function previewConsumption(user,id,unitIds) {
    requireRole(user,stockRoles);
    const order=entity('erp_orders',id),plan=spec('order',id);
    if(!plan.lines.length)fail(409,'Спочатку задайте норми витрат замовлення');
    if(unitIds.length*plan.lines.length>2000)fail(400,'За одне проведення — до 2000 рядків норм. Оберіть менше виробів');
    const units=unitIds.map(unitId=>{const unit=entity('erp_units',unitId);if(unit.order_id!==id||['ready','delivered'].includes(unit.state))fail(409,'Оберіть неперевірені вироби цього замовлення');return {id:unit.id,version:unit.version};});
    const balances=all(`SELECT l.material_id,l.client_id,m.unit_id,
      SUM((CASE WHEN m.to_location='installed' THEN m.quantity WHEN m.from_location='installed' THEN -m.quantity ELSE 0 END)*(1000/l.quantity_scale)) AS installed,
      SUM((CASE WHEN m.to_location='workbench' THEN m.quantity WHEN m.from_location='workbench' THEN -m.quantity ELSE 0 END)*(1000/l.quantity_scale)) AS workbench
      FROM erp_stock_moves m JOIN erp_stock_lots l ON l.id=m.lot_id WHERE l.material_id IS NOT NULL AND l.condition IN ('new','good') AND m.unit_id IN (${unitIds.map(()=>'?').join(',')}) GROUP BY l.material_id,l.client_id,m.unit_id`,...unitIds);
    const byUnit=new Map(balances.map(r=>[`${r.unit_id}:${key(r.material_id,r.client_id)}`,r]));
    const warehouseRows=all(`SELECT l.material_id,l.client_id,SUM((CASE WHEN m.to_location='warehouse' THEN m.quantity WHEN m.from_location='warehouse' THEN -m.quantity ELSE 0 END)*(1000/l.quantity_scale)) AS qty
      FROM erp_stock_moves m JOIN erp_stock_lots l ON l.id=m.lot_id WHERE l.material_id IS NOT NULL AND l.condition IN ('new','good') GROUP BY l.material_id,l.client_id`);
    const stock=new Map(warehouseRows.map(r=>[key(r.material_id,r.client_id),r.qty]));
    const lines=plan.lines.map(line=>{
      const owner=line.source==='client'?order.client_id:null;
      let consumeMilli=0,workbenchMilli=0;
      for(const unit of units){const balance=byUnit.get(`${unit.id}:${key(line.materialId,owner)}`)??{installed:0,workbench:0};const need=Math.max(0,line.quantityMilli-balance.installed);consumeMilli+=need;workbenchMilli+=Math.min(need,Math.max(0,balance.workbench));}
      const warehouseRequiredMilli=consumeMilli-workbenchMilli,warehouseMilli=stock.get(key(line.materialId,owner))??0;
      return {...line,consumeMilli,workbenchMilli,warehouseRequiredMilli,warehouseMilli,shortageMilli:Math.max(0,warehouseRequiredMilli-warehouseMilli)};
    });
    return {specVersion:plan.version,units,lines,canConsume:lines.some(l=>l.consumeMilli>0)&&lines.every(l=>l.shortageMilli===0)};
  }
  return {catalogue,spec,saveMaterial,saveSpec,copyTemplate,linkLot,receiptInfo,receiveReplenishment,saveReplenishment,requests,planning,orderNeeds,consume,previewConsumption};
}
