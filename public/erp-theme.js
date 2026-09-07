// Only a non-sensitive display preference is stored. Production data never enters storage.
(() => {
  const key='laba.theme';
  let theme='dark';
  try { if(localStorage.getItem(key)==='light')theme='light'; } catch {}
  function apply(value) {
    theme=value==='light'?'light':'dark';
    document.documentElement.dataset.theme=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#0e1113':'#f3f4f5');
    const toggle=document.querySelector('#theme-toggle');
    if(toggle) {
      const label=theme==='dark'?'Увімкнути світлу тему':'Увімкнути темну тему';
      toggle.setAttribute('aria-label',label);toggle.title=label;
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
      const shapes=theme==='dark'
        ? ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0','M12 2v2','M12 20v2','M2 12h2','M20 12h2','m4.9 4.9 1.4 1.4','m17.7 17.7 1.4 1.4','m4.9 19.1 1.4-1.4','m17.7 6.3 1.4-1.4']
        : ['M20.8 13a9 9 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13'];
      for(const d of shapes){const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',d);svg.append(p);}
      toggle.replaceChildren(svg);
    }
  }
  apply(theme);
  document.addEventListener('DOMContentLoaded',()=>{
    apply(theme);
    document.querySelector('#theme-toggle')?.addEventListener('click',()=>{
      apply(theme==='dark'?'light':'dark');
      try { localStorage.setItem(key,theme); } catch {}
    });
  });
  window.addEventListener('storage',event=>{if(event.key===key)apply(event.newValue);});
})();
