export function createGuideUI({getData,el,button,actions,icon,heading,empty,field,openDialog,dialog,api,notify,date,load,searchToolbar,getSearch}) {
  let list={items:[],count:0,page:0,pageSize:24},page=0,scope='published';
  let editor=null;
  const admin=()=>getData()?.me.role==='admin';
  const imageUrl=(guideId,imageId)=>`/api/erp/guides/${guideId}/images/${imageId}`;
  const states={published:'Опубліковано',draft:'Чернетка',archived:'В архіві'};
  const safe=handler=>async()=>{try{await handler();}catch(error){notify(error.message,true);}};
  const discard=()=>!editor?.dirty||window.confirm('Закрити без збереження текстових змін?');
  dialog.addEventListener('cancel',event=>{if(editor?.saving||!discard())event.preventDefault();});
  dialog.addEventListener('close',()=>{if(!dialog.open){editor=null;dialog.classList.remove('guide-dialog');}});
  window.addEventListener('beforeunload',event=>{if(editor?.dirty||editor?.saving){event.preventDefault();event.returnValue='';}});

  async function fetchState(section,role) {
    return section==='guides'?api(`guides?q=${encodeURIComponent(getSearch())}&scope=${role==='admin'?scope:'published'}&page=${page}`):null;
  }
  function view() {
    const previous=button('Назад',safe(async()=>{page=Math.max(0,page-1);await load();}),'small');previous.disabled=page===0;
    const next=button('Далі',safe(async()=>{page++;await load();}),'small');next.disabled=(page+1)*24>=list.count;
    const filters=admin()?el('div',{class:'filters guide-filters'},[['published','Опубліковані'],['draft','Чернетки'],['archived','Архів'],['all','Усі']].map(([key,label])=>button(label,safe(async()=>{scope=key;page=0;await load();}),`small ${scope===key?'primary':''}`))):null;
    return [heading('Корисні матеріали','Перевірені інструкції майстерні — крок за кроком, завжди під рукою.',admin()?button('Нова інструкція',()=>edit(),'primary','plus'):null),
      el('div',{class:'guide-callout'},icon('guides'),el('div',{},el('strong',{},'Бібліотека майстерні'),el('p',{},admin()?'Підготуйте чернетку, додайте фотографії та опублікуйте готову інструкцію.':'Знайдіть потрібну процедуру за назвою, моделлю або текстом.'))),
      searchToolbar('Пошук інструкції, моделі або категорії',filters),
      list.items.length?el('div',{class:'guide-grid'},list.items.map(item=>el('article',{class:'guide-card'},
        el('div',{class:'guide-card-top'},el('span',{class:'guide-symbol'},icon('guides')),el('span',{class:`badge ${item.status==='published'?'done':'paused'}`},states[item.status])),
        el('div',{class:'guide-tags'},item.category?el('span',{},item.category):null,item.model?el('span',{},item.model):null),
        el('h2',{},item.title),el('p',{class:'guide-summary'},item.summary||'Покрокова інструкція майстерні.'),
        el('div',{class:'guide-card-meta'},`${item.steps} кроків · ${item.photos} фото`,admin()&&item.hasChanges&&item.status==='published'?el('span',{},'Є неопубліковані зміни'):null),
        actions(item.status==='published'?button('Читати',safe(()=>read(item.id)),'primary','arrow'):null,admin()?button(item.status==='archived'?'Переглянути':'Редагувати',safe(()=>editExisting(item.id)),'quiet'):null)
      ))):empty(getSearch()?'Нічого не знайдено':'Тут будуть інструкції',getSearch()?'Спробуйте іншу назву або модель.':admin()?'Створіть першу інструкцію та опублікуйте її для майстрів.':'Адміністратор ще не опублікував матеріали.',null,'guides'),
      el('div',{class:'guide-pagination'},previous,el('span',{},`${list.count} матеріалів · сторінка ${list.page+1}`),next),
      admin()?el('p',{class:'mobile-hint'},`Фото: ${((list.imageBytes||0)/1048576).toFixed(1)} / ${Math.round((list.imageLimit||268435456)/1048576)} МБ. Чернетки та архів видимі тільки адміністраторам.`):null];
  }
  function readerBody(item,preview=false) {
    const document=item.document;
    return el('article',{class:'guide-reader'},el('div',{class:'guide-tags'},document.category?el('span',{},document.category):null,document.model?el('span',{},document.model):null),
      el('p',{class:'guide-intro'},document.summary),
      el('p',{class:'guide-reader-meta'},preview?'Попередній перегляд · ще не опубліковано':`Оновлено ${date(item.publishedAt,true)} · ${document.steps.length} кроків`),
      el('nav',{class:'guide-contents','aria-label':'Кроки інструкції'},document.steps.map((step,index)=>button(`${index+1}. ${step.title||'Крок'}`,()=>dialog.querySelector(`[data-guide-step="${index}"]`)?.scrollIntoView({block:'start'}),'quiet small'))),
      ...document.steps.map((step,index)=>el('section',{class:'guide-step','data-guide-step':index},
        el('div',{class:'guide-step-heading'},el('span',{class:'guide-step-number'},String(index+1).padStart(2,'0')),el('h3',{},step.title)),
        step.text?el('p',{class:'guide-step-text'},step.text):null,
        step.imageId?el('figure',{},el('a',{href:imageUrl(item.id,step.imageId),target:'_blank',rel:'noopener','aria-label':`Відкрити фото: ${step.caption||step.title}`},el('img',{src:imageUrl(item.id,step.imageId),alt:step.caption||step.title,loading:'lazy',decoding:'async'})),step.caption?el('figcaption',{},step.caption):null):null
      )));
  }
  async function read(id) {
    const item=await api(`guides/${id}`);openDialog(item.document.title,readerBody(item),admin()?button('Редагувати чернетку',safe(()=>editExisting(id)),'quiet'):null);dialog.classList.add('guide-dialog');
  }
  async function editExisting(id){edit(await api(`guides/${id}?draft=1`));}
  function edit(item=null) {
    const document=item?.document||{title:'',summary:'',category:'',model:'',steps:[{title:'',text:'',imageId:null,caption:''}]};
    const state={id:item?.id,version:item?.version,dirty:false,saving:false,images:item?.images||[],archived:item?.status==='archived'};
    const form=el('form',{class:'guide-editor'}),steps=el('div',{class:'guide-editor-steps'}),status=el('p',{class:'guide-save-status','aria-live':'polite'},item?'Чернетку завантажено':'Спочатку збережіть чернетку — після цього можна додати фото.');
    form.append(field('Назва інструкції','guide-title','text',{required:true,maxLength:160,value:document.title}),
      el('div',{class:'form-grid'},field('Категорія','guide-category','text',{maxLength:80,value:document.category,placeholder:'Наприклад, обслуговування'}),field('Модель / обладнання','guide-model','text',{maxLength:120,value:document.model})),
      field('Короткий опис','guide-summary','textarea',{maxLength:500,value:document.summary}),
      el('p',{class:'mobile-hint'},'До 30 кроків. Одне фото на крок: JPG, PNG або WebP до 6 МБ і 16 Мп. Знімок буде оптимізовано до 2000 px. Натисніть фото у готовій інструкції, щоб відкрити його окремо.'),steps);
    function markDirty(){state.dirty=true;status.textContent='Є незбережені зміни';}
    form.addEventListener('input',markDirty);
    function refreshNumbers(){[...steps.children].forEach((row,index)=>row.querySelector('.guide-step-label').textContent=`Крок ${index+1}`);}
    function addStep(step={title:'',text:'',imageId:null,caption:''}) {
      if(steps.children.length>=30){notify('Максимум 30 кроків',true);return;}
      const row=el('section',{class:'guide-editor-step'}),photo=el('div',{class:'guide-editor-photo'});
      const library=el('div',{class:'guide-photo-library hidden'});
      row.dataset.imageId=step.imageId||'';
      function showPhoto(){photo.replaceChildren(row.dataset.imageId?el('img',{src:imageUrl(state.id,row.dataset.imageId),alt:'Фото кроку',loading:'lazy'}):el('span',{},'Фото не додано'));}
      const file=el('input',{type:'file',accept:'image/jpeg,image/png,image/webp',disabled:!state.id||state.archived,'aria-label':'Додати або замінити фото'});
      file.addEventListener('change',async()=>{
        const selected=file.files[0];if(!selected||state.saving)return;
        if(selected.size>6*1024*1024){notify('Фото більше 6 МБ. Зменште розмір перед завантаженням.',true);file.value='';return;}
        lock(true);status.textContent='Перевіряємо й оптимізуємо фото…';
        try {
          const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Не вдалося прочитати файл'));reader.readAsDataURL(selected);});
          const image=await api(`guides/${state.id}/images`,{version:state.version,filename:selected.name,data:encoded});
          state.images.push(image);row.dataset.imageId=image.id;showPhoto();markDirty();status.textContent='Фото додано. Збережіть чернетку або опублікуйте зміни.';
        }catch(error){notify(error.message,true);status.textContent='Фото не додано. Текстові зміни збережені у формі.';}
        finally{file.value='';lock(false);}
      });
      row.append(el('div',{class:'guide-step-editor-head'},el('strong',{class:'guide-step-label'}),actions(
        button('Вище',()=>{if(row.previousElementSibling){steps.insertBefore(row,row.previousElementSibling);refreshNumbers();markDirty();}},'quiet small'),
        button('Нижче',()=>{if(row.nextElementSibling){steps.insertBefore(row.nextElementSibling,row);refreshNumbers();markDirty();}},'quiet small'),
        button('Прибрати крок',()=>{if(steps.children.length===1){notify('Залиште хоча б один крок',true);return;}if(window.confirm('Прибрати цей крок із чернетки? Опублікована версія не зміниться до публікації.')){row.remove();refreshNumbers();markDirty();}},'quiet small'))),
        field('Назва кроку','step-title','text',{maxLength:120,value:step.title}),field('Що зробити','step-text','textarea',{maxLength:6000,value:step.text}),photo,
        el('label',{class:'guide-upload'},el('span',{class:'guide-upload-label'},state.id?'Додати / замінити фото':'Фото — після збереження чернетки'),file),
        button('Раніше додані фото',()=>{
          library.replaceChildren(...state.images.map((image,index)=>{
            const choose=button(`Фото ${index+1}`,()=>{row.dataset.imageId=image.id;showPhoto();markDirty();library.classList.add('hidden');},'quiet');
            choose.prepend(el('img',{src:imageUrl(state.id,image.id),alt:'',loading:'lazy'}));return choose;
          }));
          if(!state.images.length)library.append(el('p',{},'Ще немає завантажених фото.'));
          library.classList.toggle('hidden');
        },'quiet small'),library,
        button('Прибрати фото з кроку',()=>{row.dataset.imageId='';showPhoto();markDirty();},'quiet small'),
        field('Підпис до фото','step-caption','text',{maxLength:300,value:step.caption}));
      steps.append(row);showPhoto();refreshNumbers();
    }
    document.steps.forEach(addStep);
    function payload(){return {title:form.querySelector('[name="guide-title"]').value.trim(),category:form.querySelector('[name="guide-category"]').value.trim(),model:form.querySelector('[name="guide-model"]').value.trim(),summary:form.querySelector('[name="guide-summary"]').value.trim(),steps:[...steps.children].map(row=>({title:row.querySelector('[name="step-title"]').value.trim(),text:row.querySelector('[name="step-text"]').value.trim(),imageId:row.dataset.imageId||null,caption:row.querySelector('[name="step-caption"]').value.trim()}))};}
    function lock(value){state.saving=value;form.querySelectorAll('button,input,textarea,select').forEach(control=>control.disabled=value||state.archived||(control.type==='file'&&!state.id));dialog.querySelector('.close-button').disabled=value;}
    async function save(publish) {
      if(state.saving||!form.reportValidity())return;
      const body={...payload(),publish,...(state.id?{version:state.version}:{})};lock(true);
      try {
        const result=await api(state.id?`guides/${state.id}`:'guides',body);
        state.id=result.id;state.version=result.version;state.dirty=false;
        form.querySelectorAll('.guide-upload-label').forEach(label=>label.textContent='Додати / замінити фото');
        status.textContent=publish?'Опубліковано: майстри бачать цю версію.':'Чернетку збережено. Тепер можна додавати фото.';
        scope=publish?'published':'draft';notify(publish?'Інструкцію опубліковано':'Чернетку збережено');
        await load().catch(()=>{notify('Збережено. Список оновиться після перезавантаження.',true);});
      } catch(error) {notify(error.message,true);status.textContent=error.status===409?'Інший адміністратор змінив інструкцію. Ваш текст залишився у формі — скопіюйте його перед оновленням.':'Не збережено. Перевірте повідомлення та повторіть.';}
      finally{lock(false);}
    }
    const preview=el('div',{class:'guide-preview hidden'});
    form.append(button('Додати крок',()=>{addStep();markDirty();},'quiet','plus'),status,
      el('div',{class:'guide-editor-actions'},button('Попередній перегляд',()=>{preview.replaceChildren(readerBody({id:state.id,document:payload()},true));preview.classList.toggle('hidden');},'quiet'),
        button('Зберегти чернетку',()=>save(false)),button('Опублікувати',()=>save(true),'primary')),preview);
    form.addEventListener('submit',event=>{event.preventDefault();save(false);});
    const archive=item?button(state.archived?'Повернути з архіву':'До архіву',safe(async()=>{
      if(state.saving||!discard())return;
      if(!window.confirm(state.archived?'Повернути інструкцію з архіву? Опублікована версія знову стане доступною майстрам.':'Приховати інструкцію від майстрів? Текст і фото залишаться в архіві.'))return;
      lock(true);archive.disabled=true;
      try{await api(`guides/${state.id}/archive`,{version:state.version,archived:!state.archived});state.dirty=false;dialog.close();await load();notify(state.archived?'Інструкцію повернуто':'Інструкцію переміщено до архіву');}
      finally{lock(false);archive.disabled=false;}
    }),'quiet'):null;
    openDialog(item?'Редактор інструкції':'Нова інструкція',el('p',{class:'dialog-description'},state.archived?'Архівна інструкція. Поверніть її, щоб редагувати.':'Майстри бачать тільки опубліковану версію. Збереження чернетки не змінює її.'),form,archive);
    editor=state;dialog.classList.add('guide-dialog');
    const close=dialog.querySelector('.close-button');close.replaceWith(button('Закрити',()=>{if(!state.saving&&discard())dialog.close();},'close-button','close'));
    if(state.archived)form.querySelectorAll('input,textarea,button').forEach(control=>control.disabled=true);
  }
  return {fetchState,acceptState:value=>{if(value)list=value;},view,resetPage:()=>{page=0;}};
}
