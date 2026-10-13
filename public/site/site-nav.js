/* NOD unified preview: one route contract. No credentials or support text in URLs. */
(() => {
  'use strict';
  const page = document.body.dataset.sitePage || 'home';
  const filenames = {home:'index.html',auth:'auth.html',pricing:'pricing.html',download:'download.html',questions:'questions.html',help:'help.html'};
  const embedded = parent !== window;
  const id = v => typeof v === 'string' && /^[a-z0-9_-]{1,80}$/.test(v) ? v : '';
  const language = () => document.documentElement.lang === 'ru' ? 'ru' : 'en';
  const base = () => /^(https?|file):$/.test(location.protocol) ? location.href : 'https://nod-preview.invalid/'+filenames[page];
  const send = (type, values = {}) => { if (embedded) parent.postMessage({type,page,lang:language(),...values}, '*'); };
  function routeFor(el) {
    if (!el) return null;
    if (el.matches('[data-help-route],[data-open-help],[data-dialog="help"]')) return {page:'help'};
    const raw = el.getAttribute('href') || '';
    if (raw.startsWith('#') && !el.dataset.page) return null;
    const explicit = el.dataset.page || (el.hasAttribute('data-home-link') || el.hasAttribute('data-home') ? 'home' : '');
    if(!explicit && (el.tagName !== 'A' || !raw)) return null;
    let url;
    try { url = new URL(raw || filenames[explicit] || '', base()); } catch { return null; }
    const filename = url.pathname.split('/').pop();
    const target = filenames[explicit] ? explicit : Object.keys(filenames).find(k => filenames[k] === filename);
    if (!target || (url.origin !== new URL(base()).origin && !explicit)) return null;
    const hash = decodeURIComponent(url.hash.slice(1));
    return {page:target,view:el.dataset.view||el.dataset.authRoute||(target==='auth'?hash:undefined),anchor:el.dataset.anchor||(target!=='auth'?hash:undefined),feature:el.dataset.featureTarget||url.searchParams.get('feature')||undefined,demo:el.hasAttribute('data-home-demo')||url.searchParams.get('demo')==='overview',category:url.searchParams.get('category')||undefined,article:target==='questions'&&hash.startsWith('answer-')?hash.slice(7):undefined};
  }
  function navigate(route) {
    const next = {...route,lang:language()};
    if (embedded) send('nod:navigate',next);
    else {
      const routes={home:'/',auth:'/login',pricing:'/pricing',download:'/download',questions:'/questions',help:'/help'};const u = new URL(routes[next.page],base());u.searchParams.set('lang',next.lang);
      if (next.view) u.hash=id(next.view); else if (next.anchor) u.hash=id(next.anchor);
      if(next.feature)u.searchParams.set('feature',id(next.feature));
      if(next.demo)u.searchParams.set('demo','overview');
      location.href=u.href;
    }
  }
  function closeMenu(){document.getElementById('main-nav')?.classList.remove('open');document.getElementById('menu-toggle')?.setAttribute('aria-expanded','false');}
  function goAnchor(anchor){const target=document.getElementById(id(anchor));if(!target)return false;closeMenu();target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});send('nod:state',{anchor});return true;}
  document.addEventListener('click', event => {
    const el=event.target.closest?.('a,button');if(!el)return;
    const route=routeFor(el);
    if(route){
      if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey){
        if(el.tagName==='A'&&embedded){try { const u=new URL(parent.location.href);const q=new URLSearchParams({page:route.page,lang:language()});for(const k of ['view','anchor','feature'])if(id(route[k]))q.set(k,route[k]);el.href=u.href.split('#')[0]+'#'+q.toString(); } catch{} }
        return;
      }
      event.preventDefault();event.stopImmediatePropagation();closeMenu();
      if(route.page===page&&page!=='auth'){goAnchor(route.anchor||({home:'home',help:'contact',questions:'answers',pricing:'prices',download:'download'}[page]));return;}
      navigate(route);return;
    }
    // A srcdoc document must not follow fragments into its parent wrapper.
    if(embedded&&el.tagName==='A'&&el.getAttribute('href')?.startsWith('#')&&!el.hasAttribute('data-route')&&!el.hasAttribute('data-info')&&!el.hasAttribute('data-pricing-info')){
      let anchor;try{anchor=decodeURIComponent(el.getAttribute('href').slice(1));}catch{return;}
      if(document.getElementById(anchor)){event.preventDefault();event.stopImmediatePropagation();goAnchor(anchor);}
    }
  },true);
  function publish(){send('nod:state',page==='auth'?{view:['login','register','recovery','invite'].includes(document.body.dataset.view)?document.body.dataset.view:undefined}:{});}
  new MutationObserver(publish).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  if(page==='auth')new MutationObserver(publish).observe(document.body,{attributes:true,attributeFilter:['view']});
  window.addEventListener('load',()=>{
    const u=new URL(base());const feature=id(document.body.dataset.initialFeature||u.searchParams.get('feature'));
    if(feature)document.querySelector('[data-feature="'+feature+'"]')?.click();
    const anchor=id(document.body.dataset.initialAnchor||decodeURIComponent(location.hash.slice(1)));
    if(anchor&&page!=='auth')requestAnimationFrame(()=>document.getElementById(anchor)?.scrollIntoView({behavior:'instant',block:'start'}));
    document.querySelectorAll('#main-nav a').forEach(a=>{const r=routeFor(a);if(r?.page===page)a.setAttribute('aria-current','page');});
    publish();send('nod:ready');
  },{once:true});
  window.NODSite=Object.freeze({navigate,page,mode:'connected'});
})();
