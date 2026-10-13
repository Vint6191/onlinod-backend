/* NOD Questions. Local bilingual search only: no accounts, API calls, analytics,
   external support requests, cookies or persistence of search text. */
(()=>{
'use strict';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const DATA=window.NOD_QUESTIONS;if(!DATA?.items?.length)return;
const items=DATA.items, byId=new Map(items.map(x=>[x.id,x]));
const categories=DATA.categories, validCategories=new Set(['popular','all',...categories.map(x=>x.id)]);
const initialUrl=new URL(/^(https?|file):$/.test(location.protocol)?location.href:'https://nod-preview.invalid/questions.html');
const params=initialUrl.searchParams;
let lang=document.body.dataset.initialLang||params.get('lang')||'en';lang=lang==='ru'?'ru':'en';
let category=document.body.dataset.initialCategory||params.get('category')||'popular';if(!validCategories.has(category))category='popular';
let currentAnswer=document.body.dataset.initialArticle||params.get('answer')||location.hash.replace(/^#answer-/,'');
if(!byId.has(currentAnswer))currentAnswer=null;
let query='',modalMode='help',shareId=null,searchTimer=null,rendering=false;
const COPY={en:{},ru:{
 skip:'Перейти к ответам',login:'Войти',getStarted:'Начать',
 heroTitle:'Есть вопросы.<br><em>Есть ответы.</em>',heroBody:'Доступ, тарифы и работа за кадром.<br> Разберись в деталях перед следующим шагом.',
 searchLabel:'Поиск по вопросам',searchHint:'Поиск по ответам. Не по вашим аккаунтам или перепискам.',oftenAsked:'НАЧАТЬ ЗДЕСЬ',quickTrial:'Пробный период',quickTeam:'Вход в команду',quickBoundaries:'Границы модели',
 routeEyebrow:'ОДНО ПРОСТРАНСТВО. РАЗНЫЕ РОЛИ.',routeTitle:'Твоё агентство?<br><em>Или новая смена?</em>',routeBody:'Владелец создаёт агентство.<br>Сотрудник принимает приглашение.<br>Без лишних рабочих пространств.',routeCta:'В чём разница',
 byTopic:'ВЫБЕРИ СВОЮ ТЕМУ',categoryLabel:'Категория',sideTitle:'Её границы.<br>Не общий фильтр.',sideBody:'Личные услуги и ограничения модели — там, где начинается обещание.',sideCta:'Как это будет работать',
 collapseAll:'Свернуть ответы',planned:'Планируется',shareAnswer:'Ссылка на ответ',emptyTitle:'По этому запросу ответа не нашлось.',emptyBody:'Попробуй более короткую фразу, другую тему или все вопросы. Поиск работает на русском и английском.',showAll:'Показать все вопросы',
 libraryNote:'Ответы по переданному коду продукта и согласованным планам запуска.',browseAll:'Посмотреть все 28 вопросов',
 nextEyebrow:'ОТ ОТВЕТОВ К ДЕЙСТВИЯМ',nextTitle:'Следующий шаг —<br><em>уже понятнее.</em>',nextBody:'Хороший ответ помогает двигаться дальше.<br> Выбери, с чего начать.',nextPrice:'Разобраться с ценой',nextPriceDesc:'Уровни для каждой модели и расчёт.',nextSetup:'Подготовить первую смену',nextSetupDesc:'Установка, твоя роль и доступ.',nextHelp:'Нужна помощь?',nextHelpDesc:'Форма обращения и чат с NOD.',
 previewNote:'Макет сайта: установщики, реальные платежи и поддержка не подключены. Планируемые функции отмечены отдельно.',footerNote:'МАКЕТ САЙТА / 01',
 helpTitle:'Полезный следующий шаг.',helpBody:'Открой раздел, который поможет с твоей задачей.',helpSetup:'Установка и первые шаги',helpAccess:'Восстановление доступа',helpPrice:'Тарифы и условия пробного доступа',helpNote:'Полный Help — следующая отдельная страница. Эти переходы уже работают; это не подключённый чат поддержки, обращение не отправляется.',
 shareTitle:'Вернуться к этому ответу.',shareField:'Ссылка на вопрос',copyLink:'Скопировать ссылку',shareNote:'Локальная ссылка работает там, где доступен этот HTML-файл. Для публичной ссылки сайт нужно опубликовать.'
}};
$$('[data-q]').forEach(el=>{if(!(el.dataset.q in COPY.en))COPY.en[el.dataset.q]=el.innerHTML;});
const words=(en,ru)=>lang==='ru'?ru:en;
const txt=k=>COPY[lang][k]??COPY.en[k]??k;
const icon=n=>`<svg class="icon" aria-hidden="true"><use href="#i-${n}"></use></svg>`;
const norm=s=>String(s).toLocaleLowerCase().replace(/ё/g,'е').replace(/[\s\u00a0]+/g,' ').trim();
const plain=html=>{const t=document.createElement('template');t.innerHTML=html;return t.content.textContent||'';};
const searchIndex=new Map(items.map(x=>[x.id,norm(x.en.question+' '+plain(x.en.answer)+' '+x.ru.question+' '+plain(x.ru.answer)+' '+x.keywords)]));
function tokens(){return norm(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,20);}
function matches(item){const terms=tokens();return !terms.length||terms.every(t=>searchIndex.get(item.id).includes(t));}
function setUrl(push=false){
 const state={type:'nod:state',page:'questions',lang,category,article:currentAnswer};
 if(window.parent!==window){window.parent.postMessage(state,'*');return;}
 if(!/^(https?|file):$/.test(location.protocol))return;
 const u=new URL(location.href);u.searchParams.set('lang',lang);
 if(category==='popular')u.searchParams.delete('category');else u.searchParams.set('category',category);
 u.searchParams.delete('answer');u.hash=currentAnswer?'answer-'+currentAnswer:'';
 try{history[push?'pushState':'replaceState']({},'',u.href);}catch{/* Readable without History API. */}
}
function actualTarget(route){
 const files={home:'index.html',auth:'auth.html',pricing:'pricing.html',download:'download.html',questions:'questions.html'};
 const u=new URL(files[route.page]||'questions.html',initialUrl);u.searchParams.set('lang',lang);
 if(route.view)u.hash=route.view;else if(route.anchor)u.hash=route.anchor;
 return u.href;
}
function navigate(route,event){
 if(!['home','auth','pricing','download','questions'].includes(route.page))return;
 if(event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.altKey)return;
 event?.preventDefault();
 if(route.page==='questions'){resetAll();$('#answers').scrollIntoView({behavior:'smooth'});return;}
 if(window.parent!==window)window.parent.postMessage({type:'nod:navigate',page:route.page,view:route.view,anchor:route.anchor,lang},'*');
 else location.href=actualTarget(route);
}
function categoryTitle(id){return id==='popular'?words('Popular questions.','Частые вопросы.'):id==='all'?words('All questions.','Все вопросы.'):categories.find(c=>c.id===id)?.[lang]||'';}
function resultLabel(n){return lang==='en'?`${n} ${n===1?'answer':'answers'}`:`${n} ${n%10===1&&n%100!==11?'ответ':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'ответа':'ответов'}`;}
function updateCategories(){
 const focusId=document.activeElement?.dataset.category;
 const entries=[{id:'popular',icon:'star',en:'Popular questions',ru:'Частые вопросы'},{id:'all',icon:'search',en:'All questions',ru:'Все вопросы'},...categories];
 const wrap=$('#category-list');wrap.replaceChildren();const select=$('#category-select');select.replaceChildren();
 entries.forEach(c=>{
 const pool=c.id==='popular'?DATA.popular.map(id=>byId.get(id)):c.id==='all'?items:items.filter(x=>x.category===c.id);
 const count=pool.filter(matches).length;
 const b=document.createElement('button');b.type='button';b.className='q-category';b.dataset.category=c.id;b.setAttribute('aria-pressed',String(c.id===category));
 // Fall back to the approved grid glyph for the popular shortcut.
 b.innerHTML=icon(c.icon==='star'?'grid':c.icon)+'<span></span><span class="q-category-count"></span>';
 $('span',b).textContent=c[lang];$('.q-category-count',b).textContent=count;wrap.append(b);
 const o=document.createElement('option');o.value=c.id;o.textContent=`${c[lang]} (${count})`;select.append(o);
 });
 select.value=category;if(focusId)wrap.querySelector(`[data-category="${focusId}"]`)?.focus({preventScroll:true});
 wrap.setAttribute('aria-label',words('Question categories','Категории вопросов'));
}
function updateContent(){
 items.forEach(item=>{
 const d=$(`[data-article="${item.id}"]`);$('.q-question-text',d).textContent=item[lang].question;
 $('.q-answer-copy',d).innerHTML=item[lang].answer;
 const related=$('.q-related',d);related.replaceChildren();related.hidden=!item.related.length;
 if(item.related.length){const hint=document.createElement('span');hint.textContent=words('RELATED','ПО ТЕМЕ');related.append(hint);item.related.forEach(id=>{const b=document.createElement('button');b.type='button';b.dataset.answer=id;b.textContent=byId.get(id)[lang].question;related.append(b);});}
 const route=$('.q-answer-route',d);if(route&&item.route){route.innerHTML='';route.append(document.createTextNode(item.route[lang]));route.insertAdjacentHTML('beforeend',icon('arrow'));route.href=actualTarget(item.route);}
 });
 $$('[data-page]').forEach(a=>{if(a.tagName==='A')a.href=actualTarget(a.dataset);});
}
function render(){
 rendering=true;
 const pool=(category==='popular'?DATA.popular.map(id=>byId.get(id)):items.filter(x=>category==='all'||x.category===category)).filter(matches);
 if(tokens().length){pool.sort((a,b)=>{const score=x=>tokens().filter(t=>norm(x[lang].question).includes(t)).length;return score(b)-score(a);});}
 const ids=new Set(pool.map(x=>x.id));const list=$('#faq-list');
 items.forEach(item=>{const d=$(`[data-article="${item.id}"]`);d.hidden=!ids.has(item.id);if(d.hidden)d.open=false;});
 pool.forEach(item=>list.append($(`[data-article="${item.id}"]`)));
 $('#answers-title').textContent=query.trim()?words('Search results.','Результаты поиска.'):categoryTitle(category);
 $('#result-eyebrow').textContent=query.trim()?words('SEARCH / EN + RU','ПОИСК / RU + EN'):'QUESTIONS / '+(category==='popular'?'01':category==='all'?'ALL':String(categories.findIndex(c=>c.id===category)+1).padStart(2,'0'));
 $('#result-count').textContent=resultLabel(pool.length);
 $('#empty-results').hidden=!!pool.length;$('#collapse-all').disabled=!pool.length;
 $('#view-all').hidden=category==='all'&&!query.trim();
 $('#clear-search').hidden=!query;$('.q-search kbd').hidden=!!query;
 updateCategories();rendering=false;
}
function resetAll(){query='';$('#question-search').value='';category='all';currentAnswer=null;render();setUrl();}
function closeOthers(id){$$('[data-article]').forEach(d=>{if(d.dataset.article!==id)d.open=false;});}
function openAnswer(id,{scroll=true,write=true,focus=true}={}){
 if(!byId.has(id))return;
 const wasVisible=!$(`[data-article="${id}"]`).hidden;
 if(!wasVisible||query){query='';$('#question-search').value='';category=byId.get(id).category;}
 render();closeOthers(id);const d=$(`[data-article="${id}"]`);d.hidden=false;d.open=true;currentAnswer=id;
 if(write)setUrl(true);
 if(scroll)requestAnimationFrame(()=>{d.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});if(focus)$('summary',d).focus({preventScroll:true});});
}
function setLanguage(next){
 lang=next==='ru'?'ru':'en';document.documentElement.lang=lang;
 $$('[data-q]').forEach(el=>{el.innerHTML=txt(el.dataset.q);});
 $('#question-search').placeholder=words('Try “trial”, “Vault” or “creator boundaries”','Например: «кастомы», «пробный период»');
 $('#clear-search').setAttribute('aria-label',words('Clear search','Очистить поиск'));
 $('#language-toggle').setAttribute('aria-label',words('Switch to Russian','Переключить на английский'));
 $('#menu-toggle').setAttribute('aria-label',words('Toggle navigation','Открыть или закрыть меню'));
 $('#q-dialog-close').setAttribute('aria-label',words('Close dialog','Закрыть окно'));
 $('#lang-en').classList.toggle('active',lang==='en');$('#lang-ru').classList.toggle('active',lang==='ru');
 updateContent();render();
 if(currentAnswer&&!$(`[data-article="${currentAnswer}"]`).hidden)$(`[data-article="${currentAnswer}"]`).open=true;
 if($('#q-dialog').open&&modalMode==='share')prepareShare(shareId);
 document.title=words('NOD — Questions · Nudes · Operation · Dollars','NOD — Вопросы · Nudes · Operation · Dollars');setUrl();
}
const dialog=$('#q-dialog');
function openHelp(){modalMode='help';$('#help-dialog-content').hidden=false;$('#share-dialog-content').hidden=true;dialog.setAttribute('aria-labelledby','q-dialog-title');if(!dialog.open)dialog.showModal();}
function answerUrl(id){
 let raw=initialUrl;
 if(window.parent!==window){try{raw=new URL(window.parent.location.href);}catch{}}
 const u=new URL(raw);
 if(window.parent!==window){u.hash=new URLSearchParams({page:'questions',lang,category:byId.get(id).category,article:id}).toString();}
 else{u.searchParams.set('lang',lang);u.searchParams.set('category',byId.get(id).category);u.searchParams.delete('answer');u.hash='answer-'+id;}
 if(!/^(https?|file):$/.test(u.protocol))return u.hash;
 return u.href;
}
function prepareShare(id){if(!byId.has(id))return;shareId=id;$('#share-question').textContent=byId.get(id)[lang].question;$('#answer-link').value=answerUrl(id);$('#copy-status').textContent='';}
function openShare(id){if(!byId.has(id))return;modalMode='share';$('#help-dialog-content').hidden=true;$('#share-dialog-content').hidden=false;prepareShare(id);dialog.setAttribute('aria-labelledby','share-title');dialog.showModal();$('#answer-link').focus();$('#answer-link').select();}
$('#copy-answer-link').addEventListener('click',async()=>{
 const input=$('#answer-link');let ok=false;input.focus();input.select();
 try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(input.value);ok=true;}}catch{/* Local files or iframe policies may disallow clipboard. */}
 if(!ok){try{ok=document.execCommand('copy');}catch{}}
 $('#copy-status').textContent=ok?words('Link copied.','Ссылка скопирована.'):words('The link is selected. Copy it with Ctrl+C or your device’s Copy action.','Ссылка выделена. Скопируй её через Ctrl+C или команду копирования на устройстве.');
});
$('#q-dialog-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
$('#question-search').addEventListener('input',()=>{clearTimeout(searchTimer);query=$('#question-search').value.slice(0,120);category='all';currentAnswer=null;render();setUrl();});
$('#clear-search').addEventListener('click',()=>{query='';$('#question-search').value='';category='popular';currentAnswer=null;render();setUrl();$('#question-search').focus();});
$('#search-form').addEventListener('submit',e=>{e.preventDefault();$('#answers').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});$('#answers-title').focus({preventScroll:true});});
$('#category-select').addEventListener('change',e=>{category=e.target.value;currentAnswer=null;render();setUrl();});
$('#reset-results').addEventListener('click',()=>{resetAll();$('#question-search').focus({preventScroll:true});});
$('#view-all').addEventListener('click',()=>{resetAll();$('#answers').scrollIntoView({behavior:'smooth'});$('#answers-title').focus({preventScroll:true});});
$('#collapse-all').addEventListener('click',()=>{closeOthers(null);currentAnswer=null;setUrl();});
$$('[data-article]').forEach(d=>d.addEventListener('toggle',()=>{
 if(rendering||d.hidden)return;
 if(d.open){closeOthers(d.dataset.article);currentAnswer=d.dataset.article;setUrl();}
 else if(currentAnswer===d.dataset.article){currentAnswer=null;setUrl();}
}));
const menu=$('#main-nav'),menuButton=$('#menu-toggle');
function closeMenu(){menu.classList.remove('open');menuButton.setAttribute('aria-expanded','false');}
menuButton.addEventListener('click',()=>{const open=menuButton.getAttribute('aria-expanded')!=='true';menuButton.setAttribute('aria-expanded',String(open));menu.classList.toggle('open',open);});
$('#language-toggle').addEventListener('click',()=>setLanguage(lang==='ru'?'en':'ru'));
document.addEventListener('click',e=>{
 const answer=e.target.closest('[data-answer]');if(answer){e.preventDefault();openAnswer(answer.dataset.answer);return;}
 const cat=e.target.closest('[data-category]');if(cat){category=cat.dataset.category;currentAnswer=null;render();setUrl();return;}
 const share=e.target.closest('[data-share]');if(share){openShare(share.dataset.share);return;}
 const help=e.target.closest('[data-open-help]');if(help){e.preventDefault();closeMenu();openHelp();return;}
 const route=e.target.closest('[data-page]');if(route){closeMenu();navigate(route.dataset,e);return;}
 const skip=e.target.closest('.skip-link');if(skip){e.preventDefault();$('#answers').scrollIntoView();$('#answers-title').focus({preventScroll:true});}
});
document.addEventListener('keydown',e=>{
 const input=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)||e.target.isContentEditable;
 if(e.key==='/'&&!input&&!dialog.open&&!e.ctrlKey&&!e.metaKey){e.preventDefault();$('#question-search').focus();}
 if(e.key==='Escape'&&menu.classList.contains('open')){closeMenu();menuButton.focus();}
});
window.addEventListener('popstate',()=>{
 if(window.parent!==window)return;
 const u=new URL(location.href);category=validCategories.has(u.searchParams.get('category'))?u.searchParams.get('category'):'popular';
 currentAnswer=u.hash.replace(/^#answer-/,'');if(!byId.has(currentAnswer))currentAnswer=null;
 setLanguage(u.searchParams.get('lang'));if(currentAnswer)openAnswer(currentAnswer,{write:false});
});
const requested=currentAnswer;
setLanguage(lang);
if(requested)openAnswer(requested,{scroll:true,write:false,focus:false});
else if(category==='popular'){openAnswer(DATA.popular[0],{scroll:false,write:false,focus:false});}
})();
