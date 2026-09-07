// Synthetic fixtures for local visual QA only. Never runs against a production database.
import { config } from '../src/config.mjs';
if (config.nodeEnv === 'production' || config.authMode !== 'development' || !config.dbPath.endsWith('erp-development.db')) {
  throw new Error('Demo requires AUTH_MODE=development and a DB_PATH ending in erp-development.db');
}
const { db } = await import('../src/database.mjs');
const { createErp } = await import('../src/erp-database.mjs');
const erp = createErp(db);
if (db.prepare('SELECT COUNT(*) AS n FROM erp_clients').get().n) throw new Error('Demo database is not empty; existing data was preserved');
const admin=db.prepare('SELECT * FROM users WHERE role=?').get('admin');
const user=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
db.transaction(()=>{
  const a=erp.createMember(admin,{name:'Олена Коваль',email:'olena@example.test',role:'technician'}).id;
  const b=erp.createMember(admin,{name:'Андрій Мельник',email:'andrii@example.test',role:'technician'}).id;
  const c=erp.createMember(admin,{name:'Марко Савчук',email:'marko@example.test',role:'technician'}).id;
  const client=erp.createClient(admin,{name:'Аеротех · демо',contact:'Умовний клієнт',notes:'Тестові дані для перевірки інтерфейсу'}).id;
  const client2=erp.createClient(admin,{name:'Технолаб · демо',contact:'',notes:'Умовний клієнт'}).id;
  const steps=[{title:'Вхідний огляд',instructions:'Перевірте серійний номер і комплектність за актом прийомки.',plannedMinutes:5},{title:'Роботи за замовленням',instructions:'Виконайте погоджені роботи та зафіксуйте використані матеріали.',plannedMinutes:20},{title:'Самоперевірка',instructions:'Перевірте комплектність перед передачею контролеру якості.',plannedMinutes:5}];
  erp.createTemplate(admin,{name:'Планове обслуговування · v1',steps});
  const order=erp.createOrder(admin,{clientId:client,title:'Модернізація партії · вересень',model:'FPV 10',kind:'upgrade',priority:'high',dueDate:'2026-09-18',notes:'Демонстраційна партія. Реального майна в цій базі немає.',steps,serials:Array.from({length:149},(_,i)=>`DEMO-${String(i+1).padStart(4,'0')}`),unnumbered:1,reference:'ДЕМО-АКТ-001'}).id;
  const order2=erp.createOrder(admin,{clientId:client2,title:'Діагностика та відновлення',model:'FPV 7',kind:'repair',priority:'normal',dueDate:'2026-09-22',notes:'',steps,serials:Array.from({length:12},(_,i)=>`TEST-${i+1}`),unnumbered:0,reference:'ДЕМО-АКТ-002'}).id;
  const tasks=db.prepare('SELECT * FROM erp_tasks WHERE unit_id IN (SELECT id FROM erp_units WHERE order_id=?) ORDER BY unit_id,sequence').all(order);
  for (const [index,member] of [a,b,c].entries()) erp.assign(admin,{userId:member,tasks:tasks.slice(index*150,(index+1)*150).map(t=>({id:t.id,version:t.version}))});
  const tasks2=db.prepare('SELECT * FROM erp_tasks WHERE unit_id IN (SELECT id FROM erp_units WHERE order_id=?)').all(order2);
  erp.assign(admin,{userId:c,tasks:tasks2.map(t=>({id:t.id,version:t.version}))});
  erp.shiftAction(user(a),{action:'start'});
  for(const unit of db.prepare('SELECT id FROM erp_units WHERE order_id=? LIMIT 12').all(order)) {
    for(const t of db.prepare('SELECT * FROM erp_tasks WHERE unit_id=? ORDER BY sequence').all(unit.id)) {
      erp.taskAction(user(a),t.id,{action:'start',version:t.version,note:''});
      erp.taskAction(user(a),t.id,{action:'complete',version:t.version+1,note:''});
    }
    if(unit.id<=8)erp.quality(admin,unit.id,{result:'pass',version:db.prepare('SELECT version FROM erp_units WHERE id=?').get(unit.id).version,note:'Демонстраційна перевірка'});
  }
  const ready=db.prepare("SELECT id,version FROM erp_units WHERE state='ready' LIMIT 5").all();
  erp.deliver(admin,order,{reference:'ДЕМО-ВИДАЧА-01',recipient:'Умовний представник',units:ready});
  for(const [member,unitId] of [[a,13],[b,51],[c,101]]) {
    if(member!==a)erp.shiftAction(user(member),{action:'start'});
    const t=db.prepare('SELECT * FROM erp_tasks WHERE unit_id=? ORDER BY sequence LIMIT 1').get(unitId);
    erp.taskAction(user(member),t.id,{action:'start',version:t.version,note:''});
  }
  const blocked=db.prepare('SELECT * FROM erp_tasks WHERE unit_id=52 AND sequence=0').get();
  erp.taskAction(user(b),blocked.id,{action:'block',version:blocked.version,note:'Очікую уточнення комплектності від клієнта.'});
  for(const [sku,name,clientId,quantity,shelf] of [['KIT-A','Комплект обслуговування',client,150,'A-01'],['FAST-01','Кріплення M3',null,400,'B-02'],['CASE-A','Захисні елементи',client2,24,'A-03']])erp.receiveStock(admin,{sku,name,clientId,condition:'new',quantity,shelf,reference:'ДЕМО-ПОСТАВКА',originUnitId:null});
})();
console.log('Synthetic ERP demo ready: 162 units, 3 technicians; no production data used.');
db.close();
