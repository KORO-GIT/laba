import {createMaterialUI,materialQuantity,materialUnits} from './erp-materials.js?v=0.26.0';
import {createGuideUI} from './erp-guides.js?v=0.27.0';
const content = document.querySelector('#content');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
const navigation = document.querySelector('#navigation');
let data;
let busy = false;
let section = location.hash.slice(1) || '';
let search = '';
let taskFilter = 'open';
let taskPage = 0;
let searchTimer;
let loadRevision = 0;
let toastTimer;
let crewId = null;
let crewQueue = null;
const pendingRequests = new Map();
const icons = {
  guides: ['M12 5v16','M12 5C8 2 4 3 2 4v16c3-2 6-2 10 1','M12 5c4-3 8-2 10-1v16c-3-2-6-2-10 1'],
  overview: ['M3 3h7v7H3z','M14 3h7v7h-7z','M3 14h7v7H3z','M14 14h7v7h-7z'],
  orders: ['M8 4H5v17h14V4h-3','M8 2h8v5H8z','M8 12h8','M8 16h5'],
  stock: ['m3 7 9-5 9 5v10l-9 5-9-5z','m3 7 9 5 9-5','M12 12v10','m7 4 10 6'],
  team: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2','M16 3a4 4 0 0 1 0 8','M22 21v-2a4 4 0 0 0-3-3.87','M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  my: ['m9 11 3 3L22 4','M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8','M3 3v5h5','M12 7v5l3 2'],
  plus: ['M12 5v14','M5 12h14'],
  arrow: ['M5 12h14','m13 6 6 6-6 6'],
  close: ['m6 6 12 12','M6 18 18 6'],
  play: ['m8 4 13 8-13 8z'],
  pause: ['M8 4v16','M16 4v16'],
  check: ['m5 12 4 4L20 5'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0','M12 7v5l3 2'],
  alert: ['m12 3 10 18H2z','M12 9v5','M12 17h.01'],
  clients: ['M21 21H3V3h14v18','M17 9h4v12','M7 7h2','M12 7h1','M7 11h2','M12 11h1','M8 21v-6h4v6'],
  templates: ['M4 4h6v6H4z','M14 4h6v6h-6z','M4 14h6v6H4z','M14 17h6','M17 14v6']
};
const labels = { received:'Прийнято', working:'У роботі', quality:'Контроль якості', ready:'Готово', delivered:'Видано', pending:'У черзі', in_progress:'Виконується', paused:'На паузі', blocked:'Заблоковано', done:'Завершено', active:'На зміні', closed:'Зміну закрито', normal:'Звичайний', high:'Високий', urgent:'Терміново', admin:'Адміністратор', manager:'Керівник', warehouse:'Комірник', technician:'Майстер', inspector:'Контролер якості', observer:'Спостерігач', none:'Без доступу', new:'Нова', good:'Справна', unknown:'Потребує перевірки', defective:'Несправна', external:'Надходження', workbench:'У роботі', installed:'Встановлено', returned:'Повернено', scrap:'Списано' };
icons.crews = icons.team;
const titles = { overview:'Огляд виробництва', orders:'Замовлення', stock:'Склад',materials:'Матеріали',replenishment:'Поповнення', team:'Команда', crews:'Робочі команди', my:'Моя робота', history:'Мої зміни', clients:'Клієнти', templates:'Шаблони робіт' };
titles.guides='Інструкції';
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key in node && !key.startsWith('aria-')) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
  for (const value of icons[name] || (name==='materials'?icons.stock:name==='replenishment'?icons.alert:icons.overview)) { const p = document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',value);svg.append(p); }
  return svg;
}
const button = (label, action, kind = '', glyph) => el('button',{type:'button',class:`button ${kind}`,onclick:action,'aria-label':label},glyph ? icon(glyph) : null,label);
const badge = (state) => el('span',{class:`badge ${state}`},labels[state] || state);
const avatar = (name) => el('span',{class:'avatar'},String(name).split(/[\s@.]+/).slice(0,2).map(n=>n[0]).join('').toUpperCase());
const actions = (...items) => el('div',{class:'actions'},items);
const manager = () => ['admin','manager'].includes(data.me.role);
const warehouse = () => ['admin','manager','warehouse'].includes(data.me.role);
const quality = () => ['admin','manager','inspector'].includes(data.me.role);
const worker = () => ['admin','manager','technician'].includes(data.me.role);
const date = (time, full = false) => time ? new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'short',...(full ? {hour:'2-digit',minute:'2-digit'} : {})}).format(new Date(typeof time==='string' && /^\d{4}-\d{2}-\d{2}$/.test(time) ? `${time}T12:00:00Z` : time)) : 'Без терміну';
const duration = (ms) => `${Math.floor(ms/3600000)} год ${Math.floor(ms/60000)%60} хв`;
const number = (n) => Number(n || 0).toLocaleString('uk-UA');
const match = (row) => JSON.stringify(row).toLocaleLowerCase('uk-UA').includes(search.toLocaleLowerCase('uk-UA'));
// A modal dialog lives in the browser top layer; body toasts cannot out-rank its backdrop.
function placeToast() {
  const host=dialog.open?dialog.querySelector('.dialog-header'):document.body;
  if(toast.parentElement!==host)host.append(toast);
}
function notify(message, error = false) {
  placeToast();
  toast.setAttribute('role',error?'alert':'status');
  toast.setAttribute('aria-live',error?'assertive':'polite');
  toast.textContent=message;toast.className=`show${error?' error':''}`;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.className='',5500);
}
function clearDialogError() {
  if(toast.classList.contains('error')){clearTimeout(toastTimer);toast.className='';toast.textContent='';}
}
dialog.addEventListener('close',()=>{if(!dialog.open){clearDialogError();placeToast();}});

async function api(path, body) {
  const key = `${path}:${JSON.stringify(body)}`;
  const headers={Accept:'application/json'};
  if (body !== undefined) {
    if (!navigator.onLine) throw new Error('Немає мережі. Дію ще не збережено. Повторіть після відновлення зв’язку.');
    if (!pendingRequests.has(key)) pendingRequests.set(key,crypto.randomUUID());
    Object.assign(headers,{'Content-Type':'application/json','X-Portal-Request':'1','X-Erp-Request-Id':pendingRequests.get(key)});
  }
  const response=await fetch(`/api/erp/${path}`,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Сеанс входу завершився. Оновіть сторінку та увійдіть знову.');
  const result=await response.json();
  if (!response.ok) {
    if (response.status<500) pendingRequests.delete(key);
    throw Object.assign(new Error(result.error || `Помилка ${response.status}`),{status:response.status});
  }
  pendingRequests.delete(key);
  return result;
}
async function mutate(path, body, after) {
  if (busy) return;
  busy=true;
  const controls=[...document.querySelectorAll('button:not(:disabled)')];controls.forEach(b=>b.disabled=true);
  try {
    const result=await api(path,body);
    if (dialog.open) dialog.close();
    try { await load(); } catch { notify('Дію збережено. Оновити список не вдалося — оновіть сторінку.',true);return result; }
    notify('Збережено в обліку');
    if (after) await after(result);
    return result;
  } catch(error) {
    if(error.status===409&&!dialog.open)try{await load();}catch{}
    notify(error.message,true);
  } finally {busy=false;controls.forEach(b=>b.disabled=false);}
}
function navSections() {
  if (data.me.role==='technician') return ['my','guides',...(data.crews.length?['crews']:[]),'history'];
  if (data.me.role==='warehouse') return ['overview','orders','stock','materials','replenishment','guides'];
  if (data.me.role==='inspector') return ['overview','orders','guides'];
  return ['overview','orders','stock','materials','replenishment','team','crews',...(worker()?['my','history']:[]),'clients','templates','guides'];
}
function go(key) { section=key;search='';taskPage=0;guideUI.resetPage();location.hash=key;if(['my','crews','replenishment','guides'].includes(key))load().catch(error=>notify(error.message,true));else render(); }
function heading(title,subtitle,action) { return el('div',{class:'page-heading'},el('div',{},el('p',{class:'eyebrow'},'LABA / ВИРОБНИЦТВО'),el('h1',{},title),el('p',{class:'subtitle'},subtitle)),action); }
function panel(title,body,action,description) { return el('section',{class:'panel'},el('div',{class:'panel-header'},el('div',{},el('h2',{},title),description?el('p',{},description):null),action),body); }
function empty(title,description,action,glyph='orders') { return el('div',{class:'empty-state'},icon(glyph),el('h3',{},title),el('p',{},description),action); }
function metric(title,value,note,glyph,highlight=false) { return el('article',{class:`metric${highlight?' highlight':''}`},el('div',{class:'metric-label'},title,icon(glyph)),el('div',{class:'metric-value'},number(value)),el('small',{},note)); }
function table(headers,rows) {return el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},headers.map(h=>el('th',{},h)))),el('tbody',{},rows.map(row=>el('tr',{},row.map(cell=>el('td',{},cell)))))));}
function progress(done,total) {return el('div',{class:'progress-block'},el('div',{class:'progress-label'},el('span',{},`${done} / ${total}`),el('span',{},`${total?Math.round(done/total*100):0}%`)),el('progress',{max:Math.max(total,1),value:done,'aria-label':`Готово ${done} із ${total}`}));}
function ordersTable(orders,compact=false) {
  if (!orders.length) return empty('Перша партія починається тут','Створіть клієнта, прийміть вироби за номерами та призначте маршрут робіт.',manager()?button('Прийняти партію',newOrder,'primary','plus'):null);
  return table(['ЗАМОВЛЕННЯ','ГОТОВНІСТЬ',...(compact?[]:['СТАН']),'ТЕРМІН',''],orders.map(o=>[
    el('div',{},el('span',{class:'code'},o.code),el('span',{class:'table-title'},o.title),el('span',{class:'table-sub'},`${o.client_name} · ${o.model}`)),
    progress(Number(o.ready)+Number(o.delivered),o.received),
    ...(compact?[]:[el('div',{},badge(o.delivered===o.received&&o.received?'delivered':o.quality?'quality':o.working?'working':'received'),el('small',{class:'table-sub'},`Видано ${o.delivered||0} · очікують ${o.waiting||0}`))]),
    el('div',{},el('span',{class:'nowrap'},date(o.due_date)),o.priority!=='normal'?el('div',{class:'spaced'},badge(o.priority)):null),
    button('Відкрити',()=>openOrder(o.id),'small')
  ]));
}
function overview() {
  const totals=data.totals;
  const ongoing=data.orders.filter(o=>o.received>o.delivered);
  const working=(data.team||[]).filter(u=>u.current);
  const blocked=(data.team||[]).reduce((sum,u)=>sum+u.blocked,0);
  const teamRows=(data.team||[]).filter(u=>u.enabled&&u.erp_role!=='none').slice(0,6);
  return [heading('Виробництво під контролем',`${date(Date.now())} · Замовлення, люди й комплектуючі в одному просторі.`,manager()?button('Прийняти партію',newOrder,'primary','plus'):null),materialUI.warning(),
    el('div',{class:'metrics'},metric('У майстерні',totals.received-totals.delivered,'прийнято, ще не видано','orders',true),metric('На контролі',totals.quality,'очікують перевірки якості','my'),metric('Готові до видачі',totals.ready,'перевірені вироби','stock'),metric('Видано клієнтам',totals.delivered,'за весь час обліку','arrow')),
    el('div',{class:'grid-two'},el('div',{},panel('Активні замовлення',ordersTable(ongoing.slice(0,6),true),el('a',{href:'#orders',onclick:()=>go('orders'),class:'section-link'},'Усі замовлення →'),`${ongoing.length} у поточному списку`),
      blocked?el('div',{class:'status-callout'},icon('alert'),el('div',{},el('strong',{},`${blocked} операцій потребують уваги`),el('p',{},'Майстри вказали причини блокування. Перевірте деталі, щоб відновити роботу.'))):null),
      el('div',{},data.team?panel('Команда зараз',teamRows.length?el('div',{},teamRows.map(u=>el('div',{class:'team-row'},avatar(u.display_name||u.email),el('div',{class:'team-info'},el('strong',{},u.display_name||u.email),el('p',{},u.current?`${u.current.title} · ${u.current.serial||u.current.unit_code}`:u.shift?'На зміні · немає активної операції':'Поза зміною')),badge(u.current?'in_progress':u.shift?.state||'closed')))):empty('Команда ще не налаштована','Додайте майстрів і призначте доступ до виробництва.',null,'team'),el('a',{href:'#team',onclick:()=>go('team'),class:'section-link'},'Команда →'),`${working.length} майстрів виконують операції`):null,
      el('div',{class:'status-callout neutral'},icon('my'),el('div',{},el('strong',{},'Від прийомки до повернення'),el('p',{},'Кожен виріб має свій номер, історію робіт і власника. Готовність та видача обліковуються окремо.')))))];
}
function searchToolbar(placeholder,extra) {const input=el('input',{class:'search',type:'search',placeholder,value:search,maxLength:120,'aria-label':placeholder});input.addEventListener('input',()=>{search=input.value;const start=input.selectionStart;const refresh=()=>{const next=document.querySelector('.search');next?.focus();next?.setSelectionRange(start,start);};if(section==='my'||section==='guides'||(section==='crews'&&crewId)){taskPage=0;guideUI.resetPage();clearTimeout(searchTimer);searchTimer=setTimeout(()=>load().then(refresh).catch(error=>notify(error.message,true)),300);}else{render();refresh();}});return el('div',{class:'toolbar'},input,extra);}
function ordersView() {return [heading('Замовлення','Партії клієнтів, серійні номери та готовність до видачі.',manager()?button('Прийняти партію',newOrder,'primary','plus'):null),searchToolbar('Пошук замовлення або клієнта'),panel(`Замовлення · ${data.orderCount}`,ordersTable(data.orders.filter(match))),data.orderCount>200?el('p',{class:'mobile-hint'},'Показано останні 200 замовлень.'):null];}
function myView() {
  const shift=data.shifts.find(s=>!s.ended_at);
  const expired=shift&&Date.now()-shift.started_at>16*3600000;
  const tasks=data.myTasks;
  return [heading('Моя робота','Ваші операції, поточна зміна та зафіксований результат.',data.crews.some(c=>!c.archived)?button('Роботи моїх команд',()=>go('crews'),'','team'):null),
    el('div',{class:'shift-banner'},el('div',{},el('div',{class:'shift-title'},shift?expired?'Зміну потрібно закрити':shift.state==='paused'?'Ви на перерві':'Зміна триває':'Готові до нової зміни?'),el('p',{class:'shift-meta'},shift?`${duration(shift.elapsed_ms)} без перерв · початок ${date(shift.started_at,true)}`:'Почніть зміну перед виконанням першої операції.')),
      actions(!shift?button('Почати зміну',()=>mutate('shifts/action',{action:'start'}),'primary','play'):null,shift&&!expired?button(shift.state==='active'?'Перерва':'Продовжити зміну',()=>mutate('shifts/action',{action:shift.state==='active'?'pause':'resume',version:shift.version}),'',shift.state==='active'?'pause':'play'):null,shift?button('Завершити зміну',()=>confirmAction('Завершити зміну?','Активна робота буде призупинена. Облік часу зупиниться.',()=>mutate('shifts/action',{action:'end',version:shift.version})),'quiet'):null)),
    searchToolbar('Номер виробу або назва операції',el('div',{class:'filters'},[['open',`До виконання · ${data.myTaskCounts.open}`],['blocked',`Блокування · ${data.myTaskCounts.blocked}`],['done',`Завершені · ${data.myTaskCounts.done}`]].map(([key,label])=>el('button',{class:`filter${taskFilter===key?' active':''}`,onclick:()=>{taskFilter=key;taskPage=0;load().catch(error=>notify(error.message,true));}},label)))),
    tasks.length?el('div',{class:'task-grid'},tasks.map(task=>taskCard(task,shift,expired))):panel('Мої операції',empty(taskFilter==='done'?'Ще немає завершених операцій':'Черга вільна',taskFilter==='done'?'Виконані роботи з’являться тут.':'Керівник призначить вам вироби й операції. Оновлення з’являться автоматично.',null,'my')),
    data.myTaskCount>50?el('div',{class:'toolbar spaced'},el('span',{class:'muted'},`Сторінка ${taskPage+1} з ${Math.ceil(data.myTaskCount/50)} · ${data.myTaskCount} операцій`),actions(taskPage?button('Попередня',()=>{taskPage--;load().catch(error=>notify(error.message,true));}):null,(taskPage+1)*50<data.myTaskCount?button('Наступна',()=>{taskPage++;load().catch(error=>notify(error.message,true));}):null)):null,
    el('p',{class:'mobile-hint'},'Додайте цю сторінку на головний екран телефона через меню браузера. Дія вважається виконаною лише після підтвердження «Збережено в обліку».')];
}
function taskCard(t,shift,expired) {
  const controls=[];
  const shared=t.work_mode==='shared';
  const part=t.contributors?.find(p=>p.user_id===data.me.id);
  const mayWork=t.can_start;
  const startButton=(label)=>{
    const start=button(label,()=>mutate(`tasks/${t.id}/action`,{action:'start',version:t.version}),'primary','play');
    start.disabled=!!t.waiting_for||!shift||shift.state!=='active'||expired;
    return start;
  };
  if (shared&&t.state!=='done') {
    if(mayWork) {
      if(t.my_active)controls.push(button('Пауза',()=>mutate(`tasks/${t.id}/action`,{action:'pause',version:t.version}),'','pause'));
      else controls.push(startButton(part?.state==='finished'?'Продовжити внесок':part?'Продовжити':'Долучитися'));
      if(part&&part.state!=='finished')controls.push(button('Мій внесок готовий',()=>confirmAction('Завершити свій внесок?',`${t.title}. Ваш таймер зупиниться; інші учасники продовжать роботу.`,()=>mutate(`tasks/${t.id}/action`,{action:'finish_part',version:t.version})),'primary','check'));
    }
    if(t.can_finalize) {
      const finish=button('Завершити спільну операцію',()=>confirmAction('Завершити роботу команди?',`${t.title}. Усі учасники підтвердили свій внесок. Далі — наступна операція або незалежний контроль.`,()=>mutate(`tasks/${t.id}/action`,{action:'complete',version:t.version})),'','check');
      finish.disabled=!t.contributors.length||t.contributors.some(p=>p.state!=='finished');controls.push(finish);
    }
  } else if (!shared&&t.my_active) {
    controls.push(button('Пауза',()=>mutate(`tasks/${t.id}/action`,{action:'pause',version:t.version}),'','pause'));
    controls.push(button('Готово',()=>confirmAction('Завершити операцію?',`${t.title} · ${t.serial||t.unit_code}. Підтвердіть, що роботу виконано повністю.`,()=>mutate(`tasks/${t.id}/action`,{action:'complete',version:t.version})),'primary','check'));
  } else if (!shared&&mayWork&&t.state!=='done') {
    controls.push(startButton(t.work_mode==='pool'&&t.assigned_to===null?'Взяти в роботу':t.state==='pending'?'Почати':'Продовжити'));
  }
  if (mayWork&&t.state!=='done'&&t.state!=='blocked'&&(shared?part&&part.state!=='finished':t.assigned_to===data.me.id)) controls.push(button('Перешкода',()=>noteAction('Що заважає роботі?','Зупиниться лише ваш таймер. Причина буде видима команді та керівнику.',note=>mutate(`tasks/${t.id}/action`,{action:'block',version:t.version,note})),'quiet','alert'));
  return el('article',{class:`task-card${t.my_active?' running':''}`,'data-task-id':t.id},el('div',{class:'task-top'},el('span',{class:'code'},`${t.unit_code} · ${t.order_code}`),badge(t.state)),el('p',{class:'task-context'},`${t.model} · ${t.serial||'Без заводського номера'}`),el('h3',{},t.title),el('p',{class:'task-context'},t.order_title),t.crew_name?el('p',{class:'crew-tag'},icon('team'),`${t.crew_name} · ${shared?'Спільна операція':'Черга команди'}`):null,t.work_mode==='pool'&&t.assigned_to?el('p',{class:'task-context'},`Виконавець: ${t.assignee}`):null,t.instructions?el('p',{class:'task-instructions'},t.instructions):null,t.note?el('p',{class:'task-note'},t.note):null,
    shared?el('div',{class:'crew-contributors'},t.contributors.length?t.contributors.map(p=>el('div',{},el('strong',{},p.name||`Майстер #${p.user_id}`),el('span',{},p.state==='active'?'Працює':p.state==='finished'?'Внесок готовий':'На паузі'),p.note?el('small',{},p.note):null)):el('p',{class:'task-context'},'Перший учасник може долучитися після початку зміни.')):null,
    shared&&part?.state==='finished'?el('p',{class:'task-context'},'Ваш внесок завершено. Спільну операцію закриває старший або керівник.'):null,
    t.waiting_for?el('p',{class:'task-context spaced'},`Очікує попередні операції: ${t.waiting_for}`):null,el('div',{class:'task-bottom'},el('span',{class:'task-timer'},`Ваш час: ${duration(t.my_elapsed_ms)}`,shared?` · Сумарний час учасників: ${duration(t.elapsed_ms)}`:t.planned_minutes?` / план ${t.planned_minutes} хв`:''),actions(controls)));
}
function teamView() {
  const members=data.team.filter(match);
  return [heading('Команда','Призначені операції, облік часу та поточна робота.',data.me.role==='admin'?button('Додати майстра',newMember,'primary','plus'):null),searchToolbar('Ім’я майстра або e-mail'),panel('Люди та навантаження',table(['МАЙСТЕР','ЗАРАЗ','ОПЕРАЦІЇ','ОБЛІК ЧАСУ','ДОСТУП'],members.map(u=>[
    el('div',{class:'actions'},avatar(u.display_name||u.email),el('div',{},el('span',{class:'table-title'},u.display_name||u.email),el('span',{class:'table-sub'},u.email),!u.enabled?badge('none'):null)),
    u.current?el('div',{},badge('in_progress'),el('span',{class:'table-sub spaced'},`${u.current.title} · ${u.current.serial||u.current.unit_code}`),el('span',{class:'table-sub'},duration(u.current.elapsed_ms))):badge(u.shift?.state||'closed'),
    el('div',{},el('span',{class:'table-title'},`${u.assigned} персональних у черзі`),el('span',{class:'table-sub'},`${u.completed} закрито · ${u.contributions} спільних внесків · ${u.blocked} заблоковано`)),
    el('div',{},el('span',{class:'table-title'},duration(u.work_ms)),el('span',{class:'table-sub'},'операції · за весь час'),manager()?button('Зміни',()=>showMemberShifts(u),'small quiet'):null,manager()&&u.shift?button('Закрити зміну',()=>closeMemberShift(u),'small quiet'):null),
    data.me.role==='admin'&&u.portal_role!=='admin'?button(labels[u.erp_role],()=>editMember(u),'small'):badge(u.erp_role)
  ]))),el('p',{class:'mobile-hint'},'Час рахується за активними операціями, а не за відкритою вкладкою. Перерви виключені. Після 16 годин облік відкритої зміни обмежується; майстер має закрити її.')];
}
function stockView() {return [heading('Склад комплектуючих','Власник, стан і кожне переміщення зберігаються в обліку.',warehouse()?button('Прийняти деталі',newStock,'primary','plus'):null),materialUI.warning(),searchToolbar('Назва, артикул або власник'),panel('Залишки за партіями',data.stock.length?table(['КОМПЛЕКТУЮЧІ / ВЛАСНИК','НА СКЛАДІ','У РОБОТІ','ВСТАНОВЛЕНО / ВИТРАЧЕНО','ПОВЕРНЕНО',''],data.stock.filter(match).map(l=>[
    el('div',{},el('span',{class:'table-title'},l.name),el('span',{class:'table-sub'},`${l.sku} · ${l.owner_name}`),el('span',{class:'table-sub'},`${labels[l.condition]} · ${l.shelf||'Місце не вказано'} · партія ${l.id} · ${materialUnits[l.uom]}${!l.material_id?' · не пов’язано з нормами':''}`)),
    el('strong',{class:'tabular'},number(l.warehouse)),number(l.workbench),number(l.installed),el('div',{},number(l.returned),l.scrap?el('span',{class:'table-sub'},`Списано ${l.scrap}`):null),
    actions(warehouse()?button('Рух',()=>stockMove(l),'small'):null,button('Історія',()=>showStockHistory(l),'small quiet'),manager()&&!l.material_id?button('Зв’язати з каталогом',()=>materialUI.linkLot(l),'small quiet'):null)
  ])):empty('Склад готовий до прийомки','Приймайте власні деталі та комплектуючі клієнтів окремими партіями. Залишки формуються лише з рухів.',null,'stock')),
  data.stockCount>500?el('p',{class:'mobile-hint'},'Показано останні 500 складських партій; розрахунок потреб використовує всі пов’язані партії.'):null,
  el('div',{class:'status-callout neutral'},icon('stock'),el('div',{},el('strong',{},'Ім’я власника завжди зберігається'),el('p',{},'Видане майстру ще не означає встановлене або витрачене. Зняті з виробу деталі приймайте окремою партією з посиланням на виріб.'))),warehouse()&&data.materials.length?button('Стара прийомка без номенклатури',legacyStock,'small quiet'):null];}
function clientsView() {return [heading('Клієнти','Замовники та майно, яке вони передали майстерні.',manager()?button('Додати клієнта',newClient,'primary','plus'):null),searchToolbar('Назва клієнта'),panel('Клієнтський облік',data.clients.length?table(['КЛІЄНТ','КОНТАКТ','ПРИМІТКА'],data.clients.filter(match).map(c=>[el('span',{class:'table-title'},c.name),c.contact||'—',c.notes||'—'])):empty('Додайте першого клієнта','Його можна буде обрати під час прийомки виробів і комплектуючих.',manager()?button('Додати клієнта',newClient,'primary','plus'):null,'clients'))];}
function templatesView() {return [heading('Шаблони робіт','Маршрут і норми копіюються в нове замовлення. Старі замовлення не змінюються.',manager()?button('Новий шаблон',newTemplate,'primary','plus'):null),panel('Маршрути виробництва',data.templates.length?table(['НАЗВА','ОПЕРАЦІЇ','НОРМИ ВИТРАТ','СТВОРЕНО'],data.templates.map(t=>[el('span',{class:'table-title'},t.name),el('div',{},t.steps.map((s,i)=>el('p',{class:'task-context'},`${i+1}. ${s.title}`))),el('div',{},el('p',{class:'task-context'},`${t.materialSpec.lines.length} матеріалів · версія ${t.materialSpec.version}`),manager()?button('Норми витрат',()=>materialUI.specDialog('template',t),'small'):null),date(t.created_at)])):empty('Повторювані роботи — один шаблон','Опишіть послідовність операцій для ремонту або модернізації. Кожен прийнятий виріб отримає власний маршрут.',manager()?button('Створити шаблон',newTemplate,'primary','plus'):null,'templates'))];}
function shiftTable(shifts) {return table(['ПОЧАТОК','ЗАВЕРШЕННЯ','БЕЗ ПЕРЕРВ','СТАН'],shifts.map(s=>[date(s.started_at,true),s.ended_at?date(s.ended_at,true):'Триває',duration(s.elapsed_ms),badge(s.state)]));}
function historyView() {return [heading('Мої зміни','Зафіксовані початок, перерви та завершення. Час — за Києвом.'),panel('Останні 60 змін',data.shifts.length?shiftTable(data.shifts):empty('Перша зміна попереду','Перейдіть у «Моя робота» та почніть зміну.',button('До моєї роботи',()=>go('my'),'primary'),'clock'))];}
function render() {
  if (!data) return;
  const available=navSections();if (!available.includes(section)) section=data.me.role==='technician'?'my':'overview';
  navigation.replaceChildren(...available.map(key=>el('a',{class:`nav-link${section===key?' active':''}`,href:`#${key}`,onclick:()=>go(key),'aria-current':section===key?'page':'false'},icon(key),titles[key],key==='my'&&data.myTaskCounts.open?el('span',{class:'nav-count'},data.myTaskCounts.open):key==='replenishment'&&data.materialPlanning?.alertCount?el('span',{class:'nav-count'},data.materialPlanning.alertCount):null)));
  document.querySelector('#breadcrumb').textContent=titles[section];
  document.querySelector('#identity').replaceChildren(avatar(data.me.name),el('span',{},data.me.name));
  const views={overview,orders:ordersView,my:myView,team:teamView,crews:crewsView,stock:stockView,materials:materialUI.materialsView,replenishment:materialUI.replenishmentView,clients:clientsView,templates:templatesView,history:historyView,guides:guideUI.view};
  const alertCount=data.materialPlanning?.alertCount||0;
  document.querySelector('#material-notification').replaceChildren(...(alertCount?[button(`${alertCount}`,()=>go('replenishment'),'quiet','alert')]:[]));
  const alertButton=document.querySelector('#material-notification button');if(alertButton){alertButton.setAttribute('aria-label',`Поповнення запасів: ${alertCount} позицій`);alertButton.title=`Поповнення запасів: ${alertCount} позицій`;}
  content.replaceChildren(...views[section]().filter(Boolean));
}
function openDialog(title,...body) {
  // Preserve the single live region when replacing an already-open dialog (e.g. after save).
  clearDialogError();
  document.body.append(toast);
  if (dialog.open) dialog.close();
  dialog.replaceChildren(el('div',{class:'dialog-header'},el('h2',{id:'dialog-title'},title),el('button',{class:'close-button',type:'button',onclick:()=>dialog.close(),'aria-label':'Закрити'},icon('close'))),el('div',{class:'dialog-body'},body));
  dialog.showModal();
  placeToast();
}
function field(label,name,type='text',options={}) {const input=type==='textarea'?el('textarea',{name,...options}):el('input',{name,type,...options});return el('label',{class:'field'},label,input);}
function select(label,name,items,options={}) {return el('label',{class:'field'},label,el('select',{name,'aria-label':label,...options},items.map(([value,title])=>el('option',{value},title))));}
const clientOptions=()=>[['','Власність майстерні'],...data.clients.map(c=>[c.id,c.name])];
function form(title,description,fields,submitLabel,handler) {
  const node=el('form',{},el('p',{class:'dialog-description'},description),fields,el('div',{class:'form-actions'},button('Скасувати',()=>dialog.close()),el('button',{type:'submit',class:'button primary'},submitLabel)));
  node.addEventListener('submit',event=>{event.preventDefault();if(!busy) handler(Object.fromEntries(new FormData(node)),node);});
  openDialog(title,node);
}
function confirmAction(title,description,handler) {form(title,description,[],'Підтвердити',handler);}
function noteAction(title,description,handler) {form(title,description,field('Причина','note','textarea',{required:true,maxLength:2000}),'Зберегти',values=>handler(values.note));}
function newClient(after) {form('Новий клієнт','Вкажіть назву організації або ім’я замовника.',[field('Назва клієнта','name','text',{required:true,maxLength:160}),field('Контакт','contact','text',{maxLength:200}),field('Примітка','notes','textarea',{maxLength:2000})],'Створити',v=>mutate('clients',v,typeof after==='function'?after:undefined));}
const parseSteps=value=>value.split('\n').map(s=>s.trim()).filter(Boolean).map(title=>({title,instructions:'',plannedMinutes:0}));
function newTemplate() {
  const rows=el('div',{class:'step-editor'});
  const add=(title='')=>{
    if(rows.children.length>=20){notify('До 20 операцій у маршруті',true);return;}
    const row=el('div',{class:'step-editor-row'},field('Назва операції','step-title','text',{required:true,maxLength:120,value:title}),field('Плановий час, хвилин','step-minutes','number',{min:0,max:1440,value:0}),field('Інструкція для майстра','step-instructions','textarea',{maxLength:2000}),button('Прибрати операцію',()=>{if(rows.children.length>1)row.remove();else notify('Маршрут має містити хоча б одну операцію',true);},'small quiet'));
    rows.append(row);
  };
  add('Вхідний огляд');add('Виконання робіт');add('Самоперевірка');
  form('Шаблон робіт','Опишіть операції у порядку виконання. Нульовий плановий час означає «не нормується». Після маршруту — незалежний контроль якості.',[field('Назва маршруту','name','text',{required:true,maxLength:160}),rows,button('Додати операцію',()=>add(),'','plus')],'Створити',v=>mutate('templates',{name:v.name,steps:[...rows.children].map(row=>({title:row.querySelector('[name="step-title"]').value,plannedMinutes:Number(row.querySelector('[name="step-minutes"]').value),instructions:row.querySelector('[name="step-instructions"]').value}))}));
}
function receiptFields() {return [field('Документ / номер прийомки','reference','text',{required:true,maxLength:160,placeholder:'Акт прийомки №…'}),field('Заводські номери — по одному на рядок','serials','textarea',{placeholder:'SN-001\nSN-002\nSN-003',maxLength:61000}),field('Кількість виробів без заводського номера','unnumbered','number',{min:0,max:500,value:0}),el('p',{class:'mobile-hint'},'До 500 виробів за одну прийомку. Для кожного згенерується внутрішній номер LB. Повторний номер тієї самої моделі й клієнта, який уже перебуває в майстерні, не приймається.')];}
const receiptBody=v=>({reference:v.reference,serials:v.serials.split('\n').map(s=>s.trim()).filter(Boolean),unnumbered:Number(v.unnumbered)});
function newOrder() {
  if (!data.clients.length) {newClient(()=>newOrder());return;}
  form('Прийняти партію','Створюємо замовлення, акт прийомки та маршрут для кожного виробу. Норми обраного шаблону копіюються окремо; склад не списується.',[
    el('div',{class:'form-grid'},select('Клієнт','clientId',data.clients.map(c=>[c.id,c.name])),field('Назва замовлення','title','text',{required:true,maxLength:160,placeholder:'Модернізація партії'}),field('Модель / тип виробу','model','text',{required:true,maxLength:120}),select('Тип робіт','kind',[['upgrade','Модернізація'],['repair','Ремонт'],['service','Обслуговування']]),field('Бажаний термін','dueDate','date'),select('Пріоритет','priority',[['normal','Звичайний'],['high','Високий'],['urgent','Терміново']])),
    select('Маршрут','templateId',[['','Власний маршрут нижче'],...data.templates.map(t=>[t.id,t.name])]),field('Власні операції — по одному на рядок','steps','textarea',{value:'Вхідний огляд\nВиконання робіт за замовленням\nСамоперевірка комплектності'}),
    receiptFields(),field('Примітка до замовлення','notes','textarea',{maxLength:2000})
  ],'Прийняти в облік',v=>mutate('orders',{clientId:Number(v.clientId),title:v.title,model:v.model,kind:v.kind,priority:v.priority,dueDate:v.dueDate||null,notes:v.notes,templateId:v.templateId?Number(v.templateId):null,steps:parseSteps(v.steps),...receiptBody(v)},result=>openOrder(result.id)));
}
async function openOrder(id) {
  try {
    const order=await api(`orders/${id}`);
    const selected=new Set();
    const checkboxes=[];
    const counter=el('span',{class:'muted'},'Обрано 0');
    const unitList=el('div',{class:'unit-list'},order.units.map(u=>{
      const check=el('input',{type:'checkbox',class:'checkbox','aria-label':`Обрати ${u.serial||u.code}`,onchange:()=>{if(check.checked)selected.add(u.id);else selected.delete(u.id);counter.textContent=`Обрано ${selected.size}`;}});checkboxes.push(check);
      const tasks=order.tasks.filter(t=>t.unit_id===u.id);
      const active=tasks.find(t=>t.state!=='done');
      return el('div',{class:'unit-row'},check,el('div',{class:'unit-info'},el('strong',{},u.serial||u.code),el('small',{},`${u.code} · ${tasks.filter(t=>t.state==='done').length}/${tasks.length} операцій`),active?el('small',{},`${active.title} · ${active.assignee}`):null),badge(u.state),actions(quality()&&u.state==='quality'?button('Перевірити',()=>qualityDialog(order,u),'small'):null,button('Історія',()=>unitDetail(order,u),'small quiet')));
    }));
    const allBox=el('input',{type:'checkbox',class:'checkbox','aria-label':'Обрати всі вироби',onchange:()=>{selected.clear();order.units.forEach((u,i)=>{checkboxes[i].checked=allBox.checked;if(allBox.checked)selected.add(u.id);});counter.textContent=`Обрано ${selected.size}`;}});
    const pick=()=>order.units.filter(u=>selected.has(u.id));
    openDialog(`${order.code} · ${order.title}`,
      el('p',{class:'dialog-description'},`${order.client_name} · ${order.model} · термін ${date(order.due_date)}${order.notes?` · ${order.notes}`:''}`),manager()?button('Змінити термін / пріоритет',()=>editOrder(order),'small quiet'):null,
      el('div',{class:'detail-stats'},[['Прийнято',order.units.length],['На контролі',order.units.filter(u=>u.state==='quality').length],['Готово',order.units.filter(u=>u.state==='ready').length],['Видано',order.units.filter(u=>u.state==='delivered').length]].map(([label,value])=>el('div',{class:'detail-stat'},el('strong',{},value),el('small',{},label)))),
      materialUI.orderPanel(order),warehouse()&&order.materialSpec.lines.length?button('Витрата за нормою для обраних',()=>materialUI.consumeDialog(order,pick()),'small'):null,
      el('div',{class:'toolbar detail-toolbar'},el('label',{class:'actions'},allBox,'Обрати всі',counter),actions(manager()?button('Призначити',()=>selected.size?assignDialog(order,pick()):notify('Спочатку оберіть вироби',true),'small'):null,manager()?button('Призначити команді',()=>selected.size?assignCrewDialog(order,pick()):notify('Спочатку оберіть вироби',true),'small'):null,warehouse()?button('Видати',()=>selected.size?deliveryDialog(order,pick()):notify('Спочатку оберіть вироби',true),'small primary'):null)),unitList,
      warehouse()?el('div',{class:'spaced'},button('Додаткова прийомка',()=>form('Прийняти ще вироби',`Додаткова прийомка до ${order.code}. Маршрут робіт буде той самий.`,receiptFields(),'Прийняти',v=>mutate(`orders/${id}/receive`,receiptBody(v),()=>openOrder(id))),'','plus')):null,
      el('h3',{class:'spaced'},'Документи руху'),el('div',{},order.receipts.map(r=>el('p',{class:'task-context'},`${date(r.created_at,true)} · Прийнято ${r.quantity} · ${r.reference}`)),order.deliveries.map(d=>el('p',{class:'task-context'},`${date(d.created_at,true)} · Видано ${d.quantity} · ${d.reference} · ${d.recipient}`)))
    );
  } catch(error) {notify(error.message,true);}
}
function assignDialog(order,units) {
  const candidates=data.team.filter(u=>u.enabled&&['admin','manager','technician'].includes(u.erp_role));
  if (!candidates.length) {notify('Спочатку додайте майстра до команди',true);return;}
  form('Призначити роботу',`${units.length} виробів із ${order.code}. Активні та завершені операції не перепризначаються.`,[
    select('Майстер','userId',candidates.map(u=>[u.id,u.display_name||u.email])),select('Операція','sequence',[['all','Усі незавершені операції'],...order.steps.map((s,i)=>[i,`${i+1}. ${s.title}`])])
  ],'Призначити',v=>{
    const tasks=order.tasks.filter(t=>units.some(u=>u.id===t.unit_id)&&!['in_progress','done'].includes(t.state)&&(v.sequence==='all'||t.sequence===Number(v.sequence))).map(t=>({id:t.id,version:t.version}));
    if(!tasks.length){notify('Немає операцій для призначення',true);return;}
    if(tasks.length>500){notify('Оберіть одну операцію або менше виробів — до 500 операцій за раз',true);return;}
    mutate('assign',{userId:Number(v.userId),tasks},()=>openOrder(order.id));
  });
}
function qualityDialog(order,unit) {
  form('Контроль якості',`${unit.serial||unit.code} · перевірку виконує інша людина, ніж виконавець робіт.`,[
    select('Результат','result',[['pass','Перевірено — готово до видачі'],['rework','Повернути на доопрацювання']]),select('Операція для повторення, якщо є зауваження','taskId',order.tasks.filter(t=>t.unit_id===unit.id).map(t=>[t.id,t.title])),field('Результат перевірки / зауваження','note','textarea',{maxLength:2000})
  ],'Зберегти перевірку',v=>mutate(`units/${unit.id}/quality`,{result:v.result,note:v.note,taskId:Number(v.taskId),version:unit.version},()=>openOrder(order.id)));
}
function deliveryDialog(order,units) {
  if(units.some(u=>u.state!=='ready')){notify('Оберіть лише вироби зі статусом «Готово»',true);return;}
  form('Видати клієнту',`${units.length} перевірених виробів · ${order.client_name}. Видача закриває їх перебування у майстерні.`,[field('Документ / номер акта видачі','reference','text',{required:true,maxLength:160}),field('Хто отримав','recipient','text',{required:true,maxLength:160})],'Підтвердити видачу',v=>mutate(`orders/${order.id}/deliver`,{...v,units:units.map(u=>({id:u.id,version:u.version}))},()=>openOrder(order.id)));
}
function unitDetail(order,unit) {
  const tasks=order.tasks.filter(t=>t.unit_id===unit.id);
  openDialog(`${unit.serial||unit.code} · маршрут робіт`,el('p',{class:'dialog-description'},`${unit.code} · ${order.code}`),...tasks.map(t=>el('div',{class:'activity'},el('span',{class:'activity-dot'}),el('div',{},el('h3',{},t.title),el('p',{},`${t.assignee} · ${duration(t.elapsed_ms)}${t.note?` · ${t.note}`:''}`),badge(t.state),button('Внесок майстрів',()=>contributionHistory(order,unit,t),'small quiet')))),...order.quality.filter(q=>q.unit_id===unit.id).map(q=>el('p',{class:'task-context spaced'},`${date(q.created_at,true)} · ${q.actor} · ${q.result==='pass'?'Перевірено':'Доопрацювання'} · ${q.note}`)),el('div',{class:'spaced'},button('До замовлення',()=>openOrder(order.id))));
}
function newStock() {if(data.materials.length)materialUI.receiveDialog();else legacyStock();}
function legacyStock() {form('Прийняти комплектуючі','Стара прийомка в штуках без зв’язку з нормами. Для автоматичних потреб використовуйте номенклатуру «Матеріали». Власник і рухи зберігаються.',[
  el('div',{class:'form-grid'},field('Назва','name','text',{required:true,maxLength:160}),field('Артикул','sku','text',{required:true,maxLength:100}),select('Власник','clientId',clientOptions()),select('Стан','condition',[['new','Нова'],['good','Справна'],['unknown','Потребує перевірки'],['defective','Несправна']]),field('Кількість, шт.','quantity','number',{min:1,max:1000000,required:true,value:1}),field('Комірка / місце зберігання','shelf','text',{maxLength:100})),field('Документ прийомки / підстава','reference','text',{required:true,maxLength:160}),field('Внутрішній номер виробу, якщо деталі зняті з нього','originUnitId','text',{placeholder:'LB-000001 · залиште порожнім для нових надходжень'})
],'Прийняти',v=>mutate('stock',{...v,quantity:Number(v.quantity),clientId:v.clientId?Number(v.clientId):null,originUnitId:v.originUnitId?Number(v.originUnitId.replace(/^LB-/i,'')):null}));}
function stockMove(lot) {
  form('Рух комплектуючих',`${lot.name} · ${lot.owner_name}. На складі ${materialQuantity(lot.warehouse,lot.uom)}, у роботі ${materialQuantity(lot.workbench,lot.uom)}.`,[
    select('Дія','move',[['warehouse:workbench','Видати зі складу на виріб'],['workbench:installed','Підтвердити встановлення / витрату'],['workbench:warehouse','Повернути невикористане на склад'],['installed:warehouse','Повернути фактично зняте / невитрачене'],['warehouse:returned','Повернути залишок клієнту'],...(manager()?[['warehouse:scrap','Списати з причиною']]:[])]),
    field(`Кількість, ${materialUnits[lot.uom]}`,'quantity','number',{min:lot.uom==='pcs'?1:0.001,step:lot.uom==='pcs'?1:0.001,max:1000000,required:true,value:1}),field('Внутрішній номер виробу','unitId','text',{placeholder:'LB-000001'}),field('Документ / причина / примітка','note','textarea',{required:true,maxLength:500})
  ],'Провести рух',v=>{const [from,to]=v.move.split(':');mutate(`stock/${lot.id}/move`,{from,to,quantity:Number(v.quantity),unitId:v.unitId?Number(v.unitId.replace(/^LB-/i,'')):null,note:v.note});});
}
async function showStockHistory(lot) {try{const rows=await api(`stock/${lot.id}/history`);const place={...labels,warehouse:'Склад',installed:'Встановлено / витрачено'};openDialog(`${lot.name} · рухи`,table(['КОЛИ','РУХ','КІЛЬКІСТЬ','ПІДСТАВА'],rows.map(r=>[date(r.created_at,true),`${place[r.from_location]||r.from_location} → ${place[r.to_location]||r.to_location}`,materialQuantity(r.quantity,r.uom),el('div',{},r.note,el('span',{class:'table-sub'},`${r.actor}${r.unit_id?` · LB-${String(r.unit_id).padStart(6,'0')}`:''}`))])));}catch(error){notify(error.message,true);}}
function editMember(member) {form('Доступ до виробництва',member.display_name||member.email,select('Роль','role',Object.entries(labels).filter(([k])=>['none','manager','warehouse','technician','inspector','observer'].includes(k))),'Зберегти',v=>mutate(`members/${member.id}`,v));dialog.querySelector('select').value=member.erp_role;}
function newMember() {form('Додати майстра','Власний e-mail для входу через Cloudflare. Доступ до інших розділів LABA не призначається автоматично.',[field('Ім’я','name','text',{required:true,maxLength:120}),field('E-mail','email','email',{required:true,maxLength:254}),select('Роль','role',[['technician','Майстер'],['manager','Керівник'],['warehouse','Комірник'],['inspector','Контролер якості'],['observer','Спостерігач']])],'Додати',v=>mutate('members',v));}
async function showMemberShifts(member) {try {const response=await api(`members/${member.id}/shifts`);openDialog(`Зміни · ${member.display_name||member.email}`,shiftTable(response));}catch(error){notify(error.message,true);}}
function closeMemberShift(member) {form('Закрити зміну майстра',`${member.display_name||member.email}. Активна робота буде призупинена. Час закриття — поточний, дія та причина залишаться в журналі.`,field('Причина закриття керівником','reason','textarea',{required:true,maxLength:500}),'Закрити зміну',v=>mutate(`members/${member.id}/close-shift`,{version:member.shift.version,endedAt:Date.now(),reason:v.reason}));}
function editOrder(order) {
  form('Змінити замовлення',`${order.code}. Клієнт, прийняті номери та історія залишаються незмінними.`,[
    field('Назва','title','text',{required:true,maxLength:160,value:order.title}),field('Термін','dueDate','date',{value:order.due_date||''}),select('Пріоритет','priority',[['normal','Звичайний'],['high','Високий'],['urgent','Терміново']]),field('Примітка','notes','textarea',{maxLength:2000,value:order.notes})
  ],'Зберегти',v=>mutate(`orders/${order.id}/update`,{...v,dueDate:v.dueDate||null,version:order.version},()=>openOrder(order.id)));
  dialog.querySelector('select').value=order.priority;
}

function openCrew(id) {crewId=id;crewQueue=null;taskPage=0;search='';taskFilter='open';section='crews';location.hash='crews';load().catch(error=>notify(error.message,true));}
function crewsView() {
  const crew=data.crews.find(c=>c.id===crewId);
  if(!crew) {
    const cards=data.crews.filter(match).map(c=>panel(c.name,
      el('div',{class:'crew-body'},
        el('p',{},c.description||'Робоча команда'),
        el('p',{class:'task-context'},`Старший: ${c.lead_name||'Не вказано'}${c.archived?' · Архів':''}`),
        el('div',{class:'crew-members'},c.members.map(m=>el('span',{class:'crew-chip'},m.display_name||`Майстер #${m.id}`,!m.enabled?' · доступ вимкнено':''))),
        el('p',{class:'task-context'},`${c.open_tasks} у черзі · ${c.done_tasks} завершено · ${c.active_people} працюють`),
        el('p',{class:'task-context'},`Сумарний час учасників: ${duration(c.work_ms)}`),
        actions(button('Роботи команди',()=>openCrew(c.id),'primary'),manager()?button('Склад команди',()=>crewDialog(c)):null)
      )
    ));
    return [heading('Робочі команди','Об’єднуйте майстрів для складного виробу або великої партії.',manager()?button('Створити команду',()=>crewDialog(),'primary','plus'):null),
      cards.length?el('div',{class:'crew-grid'},cards):empty('Створіть першу команду','Додайте людей у розділі «Команда», потім об’єднайте їх у робочу групу.',manager()?button('Створити команду',()=>crewDialog(),'primary'):null,'team')];
  }
  const shift=data.shifts.find(s=>!s.ended_at);
  const expired=shift&&Date.now()-shift.started_at>=16*3600000;
  const queue=crewQueue||{tasks:[],count:0};
  return [heading(crew.name,`Старший: ${crew.lead_name||'Не вказано'} · ${crew.members.length} учасників`,button('Усі команди',()=>{crewId=null;search='';render();},'','team')),
    el('p',{class:'mobile-hint'},'Черга партії: одна операція — один виконавець. Спільна операція: окремий внесок кожного, фінальне завершення старшим або керівником.'),
    worker()?el('div',{class:'status-callout neutral'},icon('clock'),el('div',{},el('strong',{},shift&&!expired&&shift.state==='active'?'Ваша зміна активна':'Для початку роботи відкрийте активну зміну'),button('Моя робота та зміна',()=>go('my'),'small quiet'))):null,
    searchToolbar('Пошук у роботах команди',el('div',{class:'filters'},[['open','У роботі та черзі'],['done','Завершені']].map(([value,title])=>button(title,()=>{taskFilter=value;taskPage=0;load().catch(error=>notify(error.message,true));},taskFilter===value?'small primary':'small')))),
    el('p',{class:'task-context'},`${queue.count} операцій · сторінка ${taskPage+1} з ${Math.max(1,Math.ceil(queue.count/50))}`),
    queue.tasks.length?el('div',{class:'task-grid'},queue.tasks.map(task=>taskCard(task,shift,expired))):panel('Роботи команди',empty('Робіт ще немає','Керівник обирає вироби в замовленні та натискає «Призначити команді».',null,'team')),
    el('div',{class:'toolbar spaced'},taskPage?button('Попередня',()=>{taskPage--;load().catch(error=>notify(error.message,true));}):null,(taskPage+1)*50<queue.count?button('Наступна',()=>{taskPage++;load().catch(error=>notify(error.message,true));}):null)];
}
function crewDialog(crew) {
  const candidates=data.team.filter(u=>u.enabled&&['admin','manager','technician'].includes(u.erp_role));
  if(!candidates.length){notify('Спочатку додайте майстрів у розділі «Команда»',true);return;}
  const selected=new Set(crew?.members.map(m=>m.id)||[]);
  const members=el('fieldset',{class:'crew-picker'},el('legend',{},'Учасники команди'),candidates.map(u=>el('label',{},el('input',{type:'checkbox',name:'crew-member',value:u.id,checked:selected.has(u.id)}),el('span',{},u.display_name||u.email))));
  form(crew?'Склад робочої команди':'Створити команду','Одна людина може входити до кількох команд, але мати лише один активний таймер. Старший має бути учасником команди.',[
    field('Назва команди','name','text',{required:true,maxLength:100,value:crew?.name||''}),field('Опис / спеціалізація','description','textarea',{maxLength:2000,value:crew?.description||''}),members,
    select('Старший команди','leadId',candidates.map(u=>[u.id,u.display_name||u.email])),crew?select('Стан команди','archived',[['false','Активна'],['true','Архів — лише після завершення робіт']]):null
  ],crew?'Зберегти склад':'Створити',(values,node)=>{
    const members=[...node.querySelectorAll('[name="crew-member"]:checked')].map(input=>Number(input.value));
    if(!members.length){notify('Оберіть хоча б одного учасника',true);return;}
    if(!members.includes(Number(values.leadId))){notify('Додайте старшого до учасників команди',true);return;}
    mutate(crew?`crews/${crew.id}`:'crews',{name:values.name,description:values.description,leadId:Number(values.leadId),members,...(crew?{version:crew.version,archived:values.archived==='true'}:{})});
  });
  if(crew){dialog.querySelector('[name="leadId"]').value=crew.lead_id;dialog.querySelector('[name="archived"]').value=String(Boolean(crew.archived));}
}
function assignCrewDialog(order,units) {
  const candidates=data.crews.filter(c=>!c.archived);
  if(!candidates.length){notify('Спочатку створіть робочу команду',true);return;}
  form('Призначити команді',`${units.length} виробів із ${order.code}. Історія попередніх виконавців зберігається. Активні й завершені операції пропускаються.`,[
    select('Робоча команда','crewId',candidates.map(c=>[c.id,c.name])),
    select('Режим роботи','mode',[['pool','Партія — майстри беруть окремі операції'],['shared','Спільна операція — кілька майстрів одночасно']]),
    select('Операція','sequence',[['all','Усі незавершені операції'],...order.steps.map((s,i)=>[i,`${i+1}. ${s.title}`])])
  ],'Призначити',values=>{
    const selectedIds=new Set(units.map(unit=>unit.id));
    const tasks=order.tasks.filter(t=>selectedIds.has(t.unit_id)&&!['in_progress','done'].includes(t.state)&&(values.sequence==='all'||t.sequence===Number(values.sequence))).map(t=>({id:t.id,version:t.version}));
    if(!tasks.length||tasks.length>500){notify('Оберіть від 1 до 500 незавершених операцій; за потреби призначайте по одному етапу.',true);return;}
    mutate('assign-crew',{crewId:Number(values.crewId),mode:values.mode,tasks},()=>openOrder(order.id));
  });
  dialog.querySelector('[name="mode"]').value=units.length===1?'shared':'pool';
}
async function contributionHistory(order,unit,task) {
  try {
    const rows=await api(`tasks/${task.id}/work-history`);
    openDialog(`Внесок майстрів · ${task.title}`,el('p',{class:'dialog-description'},`${unit.serial||unit.code} · сумарний час — людино-години, не тривалість ремонту.`),
      rows.length?table(['МАЙСТЕР','КОМАНДА / ЦИКЛ','ЧАС'],rows.map(row=>[row.name||`Майстер #${row.user_id}`,`${row.crew_name||'Індивідуально'} · ${row.work_round}`,`${duration(row.elapsed_ms)}${row.active?' · працює':''}`])):empty('Час ще не зафіксований','Інтервали з’являться після початку робіт.'),button('До виробу',()=>unitDetail(order,unit)));
  }catch(error){notify(error.message,true);}
}

const materialUI=createMaterialUI({getData:()=>data,el,button,actions,icon,heading,panel,table,empty,field,select,form,openDialog,dialog,manager,warehouse,api,mutate,notify,date,searchToolbar,match,go,load,openOrder,clientOptions});
const guideUI=createGuideUI({getData:()=>data,el,button,actions,icon,heading,empty,field,openDialog,dialog,api,notify,date,load,searchToolbar,getSearch:()=>search});
async function load() {
  const revision=++loadRevision;
  const next=await api(`context?taskState=${taskFilter}&page=${taskPage}&q=${encodeURIComponent(section==='my'?search:'')}`);
  const selectedCrew=next.crews.some(c=>c.id===crewId)?crewId:null;
  const nextQueue=section==='crews'&&selectedCrew?await api(`crews/${selectedCrew}/tasks?taskState=${taskFilter}&page=${taskPage}&q=${encodeURIComponent(search)}`):null;
  const nextMaterials=await materialUI.fetchState(next.materialPlanning?section:null);
  const nextGuides=await guideUI.fetchState(section,next.me.role);
  if(revision!==loadRevision)return;
  crewId=selectedCrew;crewQueue=nextQueue;
  materialUI.acceptState(nextMaterials);
  guideUI.acceptState(nextGuides);
  data=next;
  document.querySelector('#connection').textContent='Облік актуальний';document.querySelector('#connection').classList.remove('offline');
  document.querySelector('#updated-at').textContent=`Оновлено ${date(next.serverTime,true)} · Київ`;
  render();
}
window.addEventListener('hashchange',()=>{if(location.hash.slice(1)!==section){section=location.hash.slice(1);search='';taskPage=0;load().catch(error=>notify(error.message,true));}});
window.addEventListener('offline',()=>{document.querySelector('#connection').textContent='Немає мережі';document.querySelector('#connection').classList.add('offline');notify('Немає мережі. Зміни тимчасово недоступні.',true);});
window.addEventListener('online',()=>load().catch(error=>notify(error.message,true)));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!dialog.open&&!busy)load().catch(()=>{});});
setInterval(async()=>{if(document.hidden||dialog.open||busy||document.activeElement?.matches('input,textarea,select'))return;try{await load();}catch{document.querySelector('#connection').textContent='Не вдалося оновити';document.querySelector('#connection').classList.add('offline');}},15000);
load().catch(error=>{content.replaceChildren(empty('Не вдалося відкрити виробництво',error.message,button('Повторити',()=>location.reload(),'primary'),'alert'));document.querySelector('#connection').textContent='Немає підключення';});
