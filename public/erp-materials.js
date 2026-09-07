export const materialUnits={pcs:'шт.',m:'м',g:'г',ml:'мл'};
const fmt=n=>Number(n||0).toLocaleString('uk-UA',{maximumFractionDigits:3});
export const materialQuantity=(quantity,uom='pcs')=>`${fmt(quantity)} ${materialUnits[uom]||uom}`;
const milli=(quantity,uom)=>materialQuantity(quantity/1000,uom);

export function createMaterialUI({getData,el,button,actions,icon,heading,panel,table,empty,field,select,form,openDialog,dialog,manager,warehouse,api,mutate,notify,date,searchToolbar,match,go,load,openOrder,clientOptions}) {
  let requestPage=0,requestData={rows:[],count:0,page:0,pageSize:50};
  const data=()=>getData();
  const sourceName=source=>source==='client'?'Комплектуючі клієнта':'Власність майстерні';
  const materialOptions=()=>data().materials.map(m=>[m.id,`${m.sku} · ${m.name} (${materialUnits[m.uom]})`]);
  const materialById=id=>data().materials.find(m=>m.id===Number(id));
  function materialDialog(material) {
    form(material?'Налаштування матеріалу':'Новий матеріал','Оберіть базову одиницю один раз. Мінімум і цільовий запас стосуються власності майстерні; майно клієнтів рахується окремо.',[
      field('Назва матеріалу','name','text',{required:true,maxLength:160,value:material?.name||''}),
      field('Артикул матеріалу','sku','text',{required:true,maxLength:100,value:material?.sku||'',readOnly:!!material}),
      select('Одиниця обліку','uom',Object.entries(materialUnits)),
      el('div',{class:'form-grid'},field('Мінімальний запас','minimum','number',{required:true,min:0,max:1000000,step:0.001,value:(material?.minimum_milli||0)/1000}),field('Поповнювати до','target','number',{required:true,min:0,max:1000000,step:0.001,value:(material?.target_milli||0)/1000}))
    ],material?'Зберегти налаштування':'Створити матеріал',values=>mutate(material?`materials/${material.id}`:'materials',{...values,minimum:Number(values.minimum),target:Number(values.target),...(material?{version:material.version}:{})}));
    const uom=dialog.querySelector('[name="uom"]');
    if(material){uom.value=material.uom;uom.addEventListener('change',()=>{uom.value=material.uom;notify('Одиниця існуючої позиції незмінна',true);});}
  }
  function materialsView() {
    const materials=data().materials.filter(match);
    return [heading('Матеріали та норми','Номенклатура, одиниці обліку й мінімальний запас.',manager()?button('Додати матеріал',()=>materialDialog(),'primary','plus'):null),
      el('div',{class:'status-callout neutral'},icon('stock'),el('div',{},el('strong',{},'Один артикул — одна одиниця обліку'),el('p',{},'Для кожного типу ремонту задайте перелік і кількість матеріалів у «Шаблони робіт» → «Норми витрат». Нове замовлення отримає окрему копію норм.'),data().me.role!=='warehouse'?button('До шаблонів робіт',()=>go('templates'),'small quiet'):null)),
      searchToolbar('Назва або артикул матеріалу'),panel(`Номенклатура · ${data().materials.length}`,materials.length?table(['МАТЕРІАЛ','ОДИНИЦЯ','МІНІМУМ / ЦІЛЬ',''],materials.map(m=>[
        el('div',{},el('strong',{},m.name),el('span',{class:'table-sub'},m.sku)),materialUnits[m.uom],`${milli(m.minimum_milli,m.uom)} / ${milli(m.target_milli,m.uom)}`,
        actions(manager()?button('Налаштувати',()=>materialDialog(m),'small'):null,warehouse()?button('Прийняти',()=>receiveDialog({materialId:m.id}),'small quiet'):null)
      ])):empty('Додайте витратні матеріали','Наприклад: кріплення — у штуках, провід — у метрах, припій — у грамах. Точність до 0,001 для м/г/мл.',manager()?button('Новий матеріал',()=>materialDialog(),'primary'):null,'stock'))];
  }
  function specDialog(kind,record) {
    if(!data().materials.length){notify('Спочатку додайте матеріали в номенклатуру',true);return;}
    const spec=record.materialSpec||{version:0,lines:[]},rows=el('div',{class:'material-editor'});
    const add=(line={})=>{
      if(rows.children.length>=40){notify('До 40 рядків норм на процедуру',true);return;}
      const row=el('div',{class:'material-editor-row'},select('Матеріал','norm-material',materialOptions()),field('На один виріб','norm-quantity','number',{min:0.001,max:1000000,step:0.001,required:true,value:line.quantityMilli?line.quantityMilli/1000:1}),select('Джерело комплектуючих','norm-source',[['workshop','Майстерня'],['client','Клієнт замовлення']]),button('Прибрати норму',()=>row.remove(),'small quiet','close'));
      if(line.materialId)row.querySelector('[name="norm-material"]').value=line.materialId;
      if(line.source)row.querySelector('[name="norm-source"]').value=line.source;
      rows.append(row);
    };
    spec.lines.forEach(add);if(!spec.lines.length)add();
    form('Норми витрат',`${record.name||record.title}. Кількість на один виріб за весь маршрут, не на кожного майстра. ${kind==='template'?'Зміна шаблону не змінює вже створені замовлення.':'Зміна плану не виконує списання; після першого успішного QC норми зафіксовані.'}`,[rows,button('Додати рядок норми',()=>add(),'','plus')],'Зберегти норми',()=>{
      const lines=[...rows.children].map(row=>({materialId:Number(row.querySelector('[name="norm-material"]').value),quantity:Number(row.querySelector('[name="norm-quantity"]').value),source:row.querySelector('[name="norm-source"]').value}));
      mutate(`${kind==='template'?'templates':'orders'}/${record.id}/materials`,{version:spec.version,lines},kind==='order'?()=>openOrder(record.id):undefined);
    });
  }
  function orderPanel(order) {
    const spec=order.materialSpec;
    return panel('Матеріали за нормою',spec.lines.length?el('div',{},
      el('p',{class:'mobile-hint material-spec-note'},`Версія ${spec.version} · ${spec.openUnits} виробів до завершення контролю. Потреба не є складським резервом і не списує залишок.`),
      table(['МАТЕРІАЛ / ВЛАСНИК','НА ОДИН','ПЛАН ВІДКРИТИХ ВИРОБІВ','ЩЕ ПОТРІБНО ЗІ СКЛАДУ'],spec.lines.map(l=>[el('div',{},el('strong',{},l.name),el('span',{class:'table-sub'},`${l.sku} · ${sourceName(l.source)}`)),milli(l.quantityMilli,l.uom),milli(l.plannedMilli,l.uom),milli(l.remainingMilli,l.uom)]))
    ):el('p',{class:'task-context material-spec-note'},'Норми ще не задані. Їх можна скопіювати зі шаблону при створенні замовлення або задати тут.'),manager()?button('Норми витрат',()=>specDialog('order',order),'small quiet'):null);
  }
  async function consumeDialog(order,units) {
    if(!units.length){notify('Спочатку оберіть вироби',true);return;}
    try {
      const quote=await api(`orders/${order.id}/material-preview?units=${units.map(u=>u.id).join(',')}`);
      const quantities=table(['МАТЕРІАЛ / ДЖЕРЕЛО','ФАКТИЧНО ВИТРАТИТИ','УЖЕ ВИДАНО','ЗІ СКЛАДУ','БРАКУЄ'],quote.lines.map(l=>[`${l.name} · ${sourceName(l.source)}`,milli(l.consumeMilli,l.uom),milli(l.workbenchMilli,l.uom),milli(l.warehouseRequiredMilli,l.uom),milli(l.shortageMilli,l.uom)]));
      form('Підтвердити витрату за нормою',`${units.length} виробів · ${order.code}. Підтверджуйте лише фактично використані матеріали. Уже враховане не списується повторно; спочатку використовується видане на ці вироби, потім складські партії за чергою надходження.`,[
        quantities,!quote.canConsume?el('p',{class:'material-warning',role:'alert'},quote.lines.some(l=>l.shortageMilli)?'Матеріалів недостатньо. Поповніть склад або оберіть менше виробів. Жодних часткових списань не буде.':'Норму вже враховано для цих виробів. Додаткові витрати проведіть окремим складським рухом.'):null,
        field('Документ / підтвердження фактичного використання','note','textarea',{required:true,maxLength:400})
      ],'Провести витрату',v=>mutate(`orders/${order.id}/consume-materials`,{specVersion:quote.specVersion,units:quote.units,note:v.note},()=>openOrder(order.id)));
      dialog.querySelector('[type="submit"]').disabled=!quote.canConsume;
    }catch(error){notify(error.message,true);}
  }
  function receiveDialog(options={}) {
    if(!data().materials.length){notify('Спочатку додайте позиції в «Матеріали» або скористайтесь старою формою прийомки',true);return;}
    const request=options.request;
    form(request?'Надходження за заявкою':'Прийняти матеріали',request?`Заявка RQ-${request.id}. Часткове надходження зменшить очікувану кількість; заявка закриється після повної прийомки.`:'Матеріал із каталогу враховується в потребах і повідомленнях. Власність клієнтів ведеться окремо.',[
      select('Матеріал','materialId',materialOptions()),select('Власник матеріалу','clientId',clientOptions()),
      select('Стан матеріалу','condition',[['new','Нова / придатна'],['good','Справна'],...(!request?[['unknown','Потребує перевірки'],['defective','Несправна']]:[])]),
      field('Кількість у вибраній одиниці','quantity','number',{required:true,min:0.001,max:1000000,step:0.001,value:request?(request.quantity_milli-request.received_milli)/1000:1}),
      field('Комірка / місце зберігання','shelf','text',{maxLength:100}),field('Документ прийомки','reference','text',{required:true,maxLength:160}),
      !request?field('Виріб-джерело знятих деталей, необов’язково','originUnitId','text',{placeholder:'LB-000001'}):null
    ],'Підтвердити надходження',v=>{
      const material=materialById(v.materialId);
      mutate('stock',{materialId:material.id,sku:material.sku,name:material.name,replenishmentId:request?.id??null,clientId:v.clientId?Number(v.clientId):null,condition:v.condition,quantity:Number(v.quantity),shelf:v.shelf,reference:v.reference,originUnitId:v.originUnitId?Number(v.originUnitId.replace(/^LB-/i,'')):null});
    });
    dialog.querySelector('[name="materialId"]').value=request?.material_id??options.materialId??data().materials[0].id;
    dialog.querySelector('[name="clientId"]').value=request?.client_id??'';
    if(request)for(const [name,value] of [['materialId',request.material_id],['clientId',request.client_id??'']])dialog.querySelector(`[name="${name}"]`).addEventListener('change',event=>{event.target.value=value;notify('Матеріал і власник задані заявкою',true);});
  }
  function linkLot(lot) {
    const sku=lot.sku.normalize('NFKC').trim().toLocaleUpperCase('uk-UA');
    const candidates=data().materials.filter(m=>m.sku===sku&&m.uom==='pcs');
    if(!candidates.length){notify(`Спочатку створіть артикул ${sku} в одиниці «шт.» у «Матеріали». Стару партію не буде змінено автоматично.`,true);return;}
    form('Зв’язати стару партію',`${lot.sku} · ${lot.name}. Кількість, рухи й власник залишаться незмінними; партія почне враховуватися в потребах.`,select('Позиція номенклатури','materialId',candidates.map(m=>[m.id,m.name])),'Зв’язати',v=>mutate(`stock/${lot.id}/link-material`,{materialId:Number(v.materialId)}));
  }
  function requestDialog(row,request) {
    if(request) {
      form('Уточнити заявку',`${request.name} · ${request.owner_name}. Отримано ${milli(request.received_milli,request.uom)}; фактичні надходження залишаються в обліку.`,[
        field('Загальна кількість заявки','quantity','number',{required:true,min:Math.max(request.received_milli/1000,0.001),max:1000000,step:0.001,value:request.quantity_milli/1000}),
        select('Дія із залишком заявки','cancel',[['false','Залишити / уточнити'],['true','Скасувати невиконаний залишок']]),field('Підстава / примітка','note','textarea',{required:true,maxLength:500,value:request.note})
      ],'Зберегти заявку',v=>mutate(`replenishments/${request.id}`,{version:request.version,quantity:Number(v.quantity),cancel:v.cancel==='true',note:v.note}));
    } else {
      form('Заявка на поповнення',`${row.name} · ${row.ownerName}. Це внутрішня заявка: вона не надсилається постачальнику й не збільшує фактичний залишок.`,[
        field(`Кількість, ${materialUnits[row.uom]}`,'quantity','number',{required:true,min:row.uom==='pcs'?1:0.001,max:1000000,step:row.uom==='pcs'?1:0.001,value:row.suggestedMilli/1000||1}),field('Підстава / примітка','note','textarea',{required:true,maxLength:500,value:`Поповнення ${row.sku}; відкритих замовлень: ${row.orderCount}`})
      ],'Створити заявку',v=>mutate('replenishments',{materialId:row.materialId,clientId:row.clientId,quantity:Number(v.quantity),note:v.note}));
    }
  }
  function warning() {
    const plan=data().materialPlanning;
    if(!plan?.alertCount)return null;
    return el('div',{class:'material-alert',role:'status'},icon('alert'),el('div',{},el('strong',{},`Поповнення запасів · ${plan.alertCount} позицій потребують уваги`),el('p',{},'Є дефіцит під відкриті замовлення або досягнуто мінімального залишку. Уже подані заявки враховані окремо.')),button('Перевірити потреби',()=>go('replenishment'),'small'));
  }
  function replenishmentView() {
    const plan=data().materialPlanning,rows=plan.rows.filter(match),short=plan.rows.filter(r=>r.shortageMilli>0).length;
    const open=requestData.rows.filter(r=>r.state==='open');
    return [heading('Потреби та поповнення','Прогноз для відкритих замовлень і внутрішні заявки на надходження.'),
      el('div',{class:'material-summary'},panel('Потребують уваги',el('strong',{class:'material-number'},plan.alertCount)),panel('Дефіцит під замовлення',el('strong',{class:'material-number'},short)),panel('Фактичний залишок ≠ заявка',el('p',{},'Прийомка змінює склад; створення заявки — тільки очікувану кількість.'))),
      el('p',{class:'mobile-hint'},'Після плану = придатне на складі − ще не забезпечена потреба. Видане на конкретний виріб враховане в його забезпеченні. Це прогноз, не жорстке резервування партій.'),
      plan.unlinkedLots?el('div',{class:'material-warning'},`${plan.unlinkedLots} старих партій ще не пов’язані з каталогом і не входять у розрахунок. `,button('До складу',()=>go('stock'),'small quiet')):null,
      searchToolbar('Пошук матеріалу або власника'),
      panel('Розрахунок потреб',rows.length?el('div',{class:'material-needs'},rows.map(row=>el('article',{class:`material-need${row.low?' low':''}`},
        el('div',{class:'material-need-title'},el('div',{},el('h3',{},row.name),el('p',{class:'task-context'},`${row.sku} · ${row.ownerName}`)),el('span',{class:`badge ${row.shortageMilli?'blocked':row.low?'paused':'ready'}`},row.shortageMilli?'Бракує для робіт':row.low?'Мінімальний запас':'Достатньо')),
        el('dl',{class:'material-values'},[['На складі',row.warehouseMilli],['Потрібно на роботи',row.demandMilli],['Після плану',row.projectedMilli],['Мінімум / поріг',row.minimumMilli],['Вже заявлено',row.requestedMilli],['Рекомендовано запросити',row.suggestedMilli]].map(([label,value])=>el('div',{},el('dt',{},label),el('dd',{},milli(value,row.uom))))),
        el('p',{class:'task-context'},`${row.orderCount} відкритих замовлень · цільовий запас ${milli(row.targetMilli,row.uom)}`),
        actions(warehouse()&&!row.requestId?button('Створити заявку',()=>requestDialog(row),row.low?'primary':'small'):null,row.requestId?el('span',{class:'task-context'},`Є відкрита заявка RQ-${row.requestId}`):null)
      ))):empty('Потреби з’являться після налаштування','Додайте номенклатуру, мінімальні запаси та норми на типові роботи.',button('Матеріали',()=>go('materials'),'primary'),'stock')),
      panel(`Заявки на поповнення · ${requestData.count}`,requestData.rows.length?table(['ЗАЯВКА / МАТЕРІАЛ','ЗАЯВЛЕНО / ОТРИМАНО','СТАН',''],requestData.rows.map(r=>[
        el('div',{},el('strong',{},`RQ-${r.id} · ${r.name}`),el('span',{class:'table-sub'},`${r.owner_name} · ${date(r.created_at,true)}`),el('span',{class:'table-sub'},r.note)),`${milli(r.quantity_milli,r.uom)} / ${milli(r.received_milli,r.uom)}`,
        el('span',{class:`badge ${r.state==='open'?'paused':r.state==='received'?'ready':'closed'}`},r.state==='open'?'Заявлено':r.state==='received'?'Отримано':'Скасовано'),
        warehouse()&&r.state==='open'?actions(button('Прийняти за заявкою',()=>receiveDialog({request:r}),'small primary'),button('Уточнити',()=>requestDialog(null,r),'small quiet')):null
      ])):empty('Заявок ще немає','Створіть внутрішню заявку для потрібного матеріалу. Після реального надходження проведіть прийомку.',null,'stock')),
      requestData.count>50?el('div',{class:'toolbar'},el('span',{},`Сторінка ${requestPage+1} з ${Math.ceil(requestData.count/50)}`),actions(requestPage?button('Попередні заявки',()=>{requestPage--;load().catch(e=>notify(e.message,true));}):null,(requestPage+1)*50<requestData.count?button('Наступні заявки',()=>{requestPage++;load().catch(e=>notify(e.message,true));}):null)):null,
      open.length?el('p',{class:'mobile-hint'},'Заявки не є покупкою чи повідомленням постачальнику. Надходження з невизначеним/несправним станом не закривають заявку.'):null];
  }
  return {materialsView,replenishmentView,materialDialog,specDialog,orderPanel,consumeDialog,receiveDialog,linkLot,warning,
    fetchState:section=>section==='replenishment'?api(`replenishments?page=${requestPage}`):null,
    acceptState:value=>{if(value)requestData=value;}};
}
