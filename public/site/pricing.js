/* Read-only pricing design, no API calls or payment. */
(async () => {
'use strict';
let DATA;
try { DATA = await NODWeb.request('/api/site/pricing'); document.body.dataset.pricingReady='true'; }
catch (_) {
 const banner=document.createElement('p');banner.className='p-live-error';banner.setAttribute('role','status');
 banner.textContent=new URLSearchParams(location.search).get('lang')==='ru'?'Не удалось загрузить цены. Обнови страницу позже.':'Pricing is unavailable. Please reload later.';
 document.querySelector('main').prepend(banner); return;
}
const COPY = {"en": {"skip": "Skip to pricing", "hero": "Your operation.<br><em>A price that fits.</em>", "intro": "One core workspace. Four revenue-based tiers.<br> Each creator is priced separately, not against the agency’s total.", "calcJump": "See what your models would cost", "trialEyebrow": "START WITH THE WORK", "trialDays": "days<br>to explore NOD", "trialScope": "Trial for a newly registered agency.", "trialCta": "Create your agency", "trialSeed": "Current policy for new agencies.", "levelsEyebrow": "PER CREATOR · MONTHLY · USD", "levelsTitle": "Same core tools. Your revenue tier.", "sourceBadge": "SOURCE PRICING PREVIEW", "calcExample": "CALCULATOR EXAMPLE", "perMonth": "/ creator / month", "revenueLabel": "CREATOR REVENUE · PREVIOUS 30 FULL DAYS", "coreIn": "NOD core workspace", "tryLevel": "Show a calculation", "autoLevel": "Your tier is calculated automatically. It is not a manual plan selection.", "levelDetails": "How it works", "sourceTitle": "Prices and trial shown here come from the supplied Backend, not a live billing connection.", "sourceBody": "This design uses the source defaults: Starter $20, Growth $30, Pro $50, Elite $150; outreach $29; a 14-day trial. The administrator can change the commercial policy. The published site must read the current policy before displaying a live quote. This preview creates no payment or subscription.", "includedLabel": "THE CORE WORKSPACE", "includedTitle": "Built around the work.<br><em>At every tier.</em>", "includedBody": "Revenue determines the core price. These four tiers are not four different sets of basic features.", "tool0": "Vault & content", "tooldesc0": "Unsorted media, sales history and library management.", "tool1": "Content-aware campaigns", "tooldesc1": "Audience selection from CRM context, with a review before sending.", "tool2": "Team & analytics", "tooldesc2": "Replies, unanswered conversations, posts and stories.", "tool3": "Bumps & follow workflows", "tooldesc3": "Templates, intervals, reply pauses and activity history.", "calcEyebrow": "NO GUESSWORK", "calcTitle": "Your models.<br><em>Your monthly estimate.</em>", "calcIntro": "Enter each creator’s revenue for the previous 30 completed UTC days. Add outreach only where you need it.", "estimateLabel": "LOCAL CALCULATOR", "addModel": "Add another creator", "reset": "Reset", "calcFoot": "Use an amount for one creator per row. No account data is requested or stored.", "estimate": "MONTHLY ESTIMATE", "perPeriod": "/ month", "baseCost": "Core access", "startCta": "Start with the trial", "notQuote": "An estimate, not an invoice. Actual pricing uses the current server policy and verified revenue. Individual overrides are not included.", "addonsLabel": "OPTIONAL MODULES", "addonsTitle": "Extend where you need it.", "addonsDesc": "Separate from core pricing. Applied to the selected creator, not every account in the agency.", "outreachDesc": "Find candidates, review activity and run configured promotion actions with limits and a history.", "outreachExample": "Add to the first creator’s estimate", "addonPerMonth": "/ creator / month", "planned": "PLANNED", "aiDesc": "A separate module in the billing catalog. Not advertised as released and not included in this estimate.", "aiNote": "Availability is shown in the app.", "futurePrice": "catalog amount<br>/ creator / month", "everyday": "EVERYDAY TOOLS", "freeTitle": "Less switching.<br><em>No separate module fee.</em>", "freeDesc": "We plan to make CRM, the translator and custom orders free. Access terms and AI-resource requirements will be specified at launch.", "freeNote": "Launch plan. This is not a claim that the entire NOD workspace is free after the trial.", "freeTag": "PLANNED FREE", "translator": "Translator", "customOrders": "Custom orders", "rules": "CLEAR RULES", "howTitle": "Revenue sets the tier.<br><em>Not the whole agency.</em>", "rule0": "30 completed days", "ruledesc0": "Verified revenue from the previous 30 completed UTC days. Today’s partial day is not included.", "rule1": "One monthly period", "ruledesc1": "A calendar-month subscription, priced at purchase or renewal. Not a percentage deducted from every sale.", "rule2": "No missing-data shortcuts", "ruledesc2": "When verified revenue is unavailable, pricing must wait for data — not silently assign the cheapest tier.", "faqTitle": "A direct price.<br><em>Direct answers.</em>", "q0": "Can I select Starter for any creator?", "a0": "No. The standard tier follows that creator’s verified revenue. $1,000 enters Growth, $5,000 enters Pro and $15,000 enters Elite. The calculator is only an estimate; actual pricing is server-side.", "q1": "Is the trial for each new creator?", "a1": "A trial starts when an agency is created. Adding creators or accepting an invitation does not create another agency trial.", "q2": "What happens when the trial ends?", "a2": "Creator operations require an active paid entitlement after the trial. Access to billing is separate so the owner can restore access. Planned free-module terms still need to be finalised.", "q3": "Does topping up activate every creator?", "a3": "No. The agency balance is shared, but creator subscriptions are separate. A confirmed balance top-up and a subscription purchase are different steps.", "q4": "What if I disable auto-renewal?", "a4": "The already paid period stays active until its end. Disabling renewal does not cancel that period immediately.", "q5": "Where do these prices come from?", "a5": "Prices and trial duration are loaded from the current NOD commercial policy. Your creator price is calculated by the server from confirmed earnings when a subscription is purchased or renewed.", "closing": "The next step?<br><em>Make it yours.</em>", "closingCta": "Create your agency", "prototypeFooter": "NOD / PRICING", "backHome": "Back to the homepage", "sourceLabel": "CURRENT PRICING"}, "ru": {"skip": "Перейти к ценам", "hero": "Понятная цена.<br><em>На каждую модель.</em>", "intro": "Одно рабочее пространство. Четыре уровня по доходу.<br> Стоимость определяется для каждой модели, а не по обороту агентства.", "calcJump": "Посчитать стоимость для своих моделей", "trialEyebrow": "НАЧНИТЕ С САМОЙ РАБОТЫ", "trialDays": "дней<br>попробовать NOD", "trialScope": "Пробный доступ для нового агентства после регистрации.", "trialCta": "Создать агентство", "trialSeed": "Действующие условия для новых агентств.", "levelsEyebrow": "ЗА МОДЕЛЬ · В МЕСЯЦ · USD", "levelsTitle": "Те же инструменты. Ваш уровень дохода.", "sourceBadge": "ПРАЙС ИЗ КОДА · МАКЕТ", "calcExample": "ПРИМЕР ИЗ РАСЧЁТА", "perMonth": "/ модель / месяц", "revenueLabel": "ДОХОД МОДЕЛИ · 30 ПОЛНЫХ ДНЕЙ", "coreIn": "Основные инструменты NOD", "tryLevel": "Пример расчёта", "autoLevel": "Уровень рассчитывается автоматически по доходу модели, а не выбирается вручную.", "levelDetails": "Как это считается", "sourceTitle": "Цены загружаются из действующих настроек NOD. Оплата и подписки моделей доступны в приложении.", "sourceBody": "Цены загружаются из действующих настроек NOD. Оплата и подписки моделей доступны в приложении.", "includedLabel": "БАЗОВОЕ ПРОСТРАНСТВО", "includedTitle": "Вокруг вашей работы.<br><em>На каждом уровне.</em>", "includedBody": "Доход определяет базовую цену. Четыре уровня — не четыре урезанных набора основных функций.", "tool0": "Vault и контент", "tooldesc0": "Неразобранный контент, история продаж и управление библиотекой.", "tool1": "Рассылки по интересам", "tooldesc1": "Подбор аудитории по контексту CRM с проверкой перед отправкой.", "tool2": "Команда и статистика", "tooldesc2": "Время ответа, неотвеченные диалоги, посты и истории.", "tool3": "Бампы и автоматизация", "tooldesc3": "Шаблоны, интервалы, паузы после ответа и история действий.", "calcEyebrow": "БЕЗ ПРИКИДОК НА ГЛАЗ", "calcTitle": "Ваши модели.<br><em>Ваш расчёт на месяц.</em>", "calcIntro": "Укажите доход каждой модели за предыдущие 30 завершённых дней UTC. Добавьте продвижение только там, где оно нужно.", "estimateLabel": "ЛОКАЛЬНЫЙ КАЛЬКУЛЯТОР", "addModel": "Добавить ещё модель", "reset": "Сбросить", "calcFoot": "В каждой строке — доход одной модели. Данные аккаунтов не запрашиваются и не сохраняются.", "estimate": "ОРИЕНТИР НА МЕСЯЦ", "perPeriod": "/ месяц", "baseCost": "Базовый доступ", "startCta": "Начать с пробного доступа", "notQuote": "Это ориентир, не счёт. Итог рассчитывает сервер по актуальной политике и подтверждённому доходу. Индивидуальные условия здесь не учтены.", "addonsLabel": "ДОПОЛНИТЕЛЬНЫЕ МОДУЛИ", "addonsTitle": "Расширяйте там, где нужно.", "addonsDesc": "Отдельно от базовой цены. Для выбранной модели, а не сразу для всех аккаунтов агентства.", "outreachDesc": "Поиск кандидатов, проверка активности и действия для продвижения — с настройками, лимитами и историей.", "outreachExample": "Добавить к первой модели в расчёте", "addonPerMonth": "/ модель / месяц", "planned": "ПЛАНИРУЕТСЯ", "aiDesc": "Отдельный модуль в платёжном каталоге. Не выдаётся за готовую функцию и не включается в этот расчёт.", "aiNote": "Доступность модуля указана в приложении.", "futurePrice": "сумма в каталоге<br>/ модель / месяц", "everyday": "ЕЖЕДНЕВНЫЕ ИНСТРУМЕНТЫ", "freeTitle": "Меньше переключений.<br><em>Без доплат за каждый модуль.</em>", "freeDesc": "CRM, переводчик и кастомы планируем сделать бесплатными. Условия доступа и требования к AI-ресурсам уточним при запуске.", "freeNote": "План запуска. Это не означает, что весь NOD останется бесплатным после trial.", "freeTag": "ПЛАНИРУЕТСЯ БЕСПЛАТНО", "translator": "Переводчик", "customOrders": "Кастомы", "rules": "ПОНЯТНЫЕ ПРАВИЛА", "howTitle": "Доход определяет уровень.<br><em>Для каждой модели отдельно.</em>", "rule0": "30 полных дней", "ruledesc0": "Подтверждённый доход за предыдущие 30 завершённых дней UTC. Незавершённый текущий день не входит.", "rule1": "Один месячный период", "ruledesc1": "Подписка на календарный месяц. Цена определяется при покупке или продлении, а не вычитается процентом из каждой продажи.", "rule2": "Без догадок вместо данных", "ruledesc2": "Если подтверждённого дохода нет, нужно дождаться данных, а не молча назначать самый дешёвый уровень.", "faqTitle": "Прямой вопрос.<br><em>Понятный ответ.</em>", "q0": "Можно выбрать Starter для любой модели?", "a0": "Нет. Обычный уровень зависит от подтверждённого дохода модели. С $1,000 начинается Growth, с $5,000 — Pro, с $15,000 — Elite. Калькулятор — только ориентир; рабочую цену определяет сервер.", "q1": "Пробный период выдаётся каждой новой модели?", "a1": "Пробный период начинается при создании агентства. Добавление моделей и принятие приглашения не запускают его заново.", "q2": "Что будет после окончания пробного периода?", "a2": "После trial для работы с моделью нужен активный оплаченный доступ. Раздел оплаты остаётся отдельным, чтобы владелец мог восстановить работу. Условия планируемых бесплатных модулей ещё нужно закрепить.", "q3": "Пополнение включает сразу все модели?", "a3": "Нет. Баланс общий для агентства, но подписки оформляются по моделям. Подтверждённое пополнение и покупка периода подписки — разные действия.", "q4": "Что будет, если отключить автопродление?", "a4": "Уже оплаченный период действует до окончания. Отключение автопродления не обрывает его сразу.", "q5": "Откуда берутся эти цены?", "a5": "Цены и срок trial загружаются из действующей политики NOD. При покупке и продлении сервер рассчитывает тариф модели по подтверждённому доходу.", "closing": "Следующий шаг?<br><em>Начните своё.</em>", "closingCta": "Создать агентство", "prototypeFooter": "NOD / ТАРИФЫ", "backHome": "На главную", "sourceLabel": "АКТУАЛЬНЫЕ ЦЕНЫ"}};
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const actualUrl=()=>/^(http|https|file):$/.test(location.protocol)?new URL(location.href):new URL('https://nod-preview.invalid/pricing.html');
let lang=(document.body.dataset.initialLang||actualUrl().searchParams.get('lang'))==='ru'?'ru':'en';
let serial=1,rows=[{id:1,revenue:'2500',outreach:false}];
const wording=(en,ru)=>lang==='ru'?ru:en;
const currency=c=>new Intl.NumberFormat(lang==='ru'?'en-US':'en-US',{style:'currency',currency:'USD',maximumFractionDigits:c%100?2:0}).format(c/100);
const icon=name=>`<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
function parseRevenue(value){
 const v=String(value).trim().replace(',','.');
 if(!/^\d+(?:\.\d{0,2})?$/.test(v))return null;
 const [whole,fraction='']=v.split('.');
 const c=Number(whole)*100+Number((fraction+'00').slice(0,2));
 return Number.isSafeInteger(c)&&c>=0&&c<=2147483647?c:null;
}
function priceRow(row){
 const cents=parseRevenue(row.revenue);
 if(cents===null)return null;
 const tier=DATA.tiers.find(t=>t.max===null||cents<t.max);
 const addon=row.outreach?DATA.settings.outreachPriceCents:0;
 return {tier,core:tier.cents,addon,total:tier.cents+addon};
}
function renderRows(){
 const box=$('#model-list');box.replaceChildren();
 rows.forEach((row,i)=>{
  const art=document.createElement('article');art.className='p-model-row';art.dataset.row=String(row.id);
  art.innerHTML=`<div class="p-model-top"><h3 class="p-model-name"><i>${String(i+1).padStart(2,'0')}</i><span>${wording('Creator','Модель')} ${i+1}</span></h3><div class="p-model-meta"><span class="p-tier-pill" data-row-tier></span><button class="p-remove-model" type="button" aria-label="${wording('Remove creator','Удалить модель')} ${i+1}" ${rows.length===1?'hidden':''}>${icon('x')}</button></div></div><div class="p-model-fields"><div class="p-input-group"><label for="revenue-${row.id}">${wording('Revenue · 30 full days','Доход · 30 полных дней')}</label><div class="p-money-input"><span>$</span><input id="revenue-${row.id}" type="number" inputmode="decimal" min="0" max="21474836.47" step="0.01" placeholder="2500" autocomplete="off" aria-describedby="revenue-note-${row.id}"></div><p class="p-input-note" id="revenue-note-${row.id}"></p></div><label class="p-outreach-check"><input type="checkbox" data-row-outreach><span><strong>SFS + Comment Bot</strong><small>+${currency(DATA.settings.outreachPriceCents)} ${wording('/ month','/ месяц')}</small></span></label></div><div class="p-row-total"><span>${wording('For this creator','За эту модель')}</span><b data-row-total></b></div>`;
  const input=$('input[type=number]',art);input.value=row.revenue;
  input.addEventListener('input',()=>{row.revenue=input.value;updateEstimate();});
  const chk=$('[data-row-outreach]',art);chk.checked=row.outreach;
  chk.addEventListener('change',()=>{row.outreach=chk.checked;updateEstimate();});
  $('.p-remove-model',art).addEventListener('click',()=>{rows=rows.filter(r=>r.id!==row.id);renderRows();updateEstimate();$('#add-model').focus();});
  box.append(art);
 });
 $('#add-model').disabled=rows.length>=8;
 updateEstimate();
}
function updateEstimate(){
 let core=0,addons=0,valid=true;
 rows.forEach(row=>{
  const result=priceRow(row),art=$(`[data-row="${row.id}"]`);
  const input=$('input[type=number]',art);
  input.setAttribute('aria-invalid',String(!result));
  $('.p-money-input',art).classList.toggle('invalid',!result);
  $('[data-row-tier]',art).textContent=result?result.tier.label:wording('Need revenue','Нужен доход');
  $('[data-row-total]',art).textContent=result?currency(result.total):'—';
  $('.p-input-note',art).textContent=result?wording('USD · completed days, not today','USD · завершённые дни, без текущего'):wording('Enter 0–21,474,836.47, with up to 2 decimals.','Укажите сумму от 0 до 21 474 836,47, до 2 знаков после запятой.');
  if(!result){valid=false;return;} core+=result.core;addons+=result.addon;
 });
 $('#estimate-total').textContent=valid?currency(core+addons):'—';
 $('#core-total').textContent=valid?currency(core):'—';
 $('#outreach-total').textContent=valid?currency(addons):'—';
 $('#estimate-context').textContent=wording(`${rows.length} ${rows.length===1?'creator':'creators'} · 1 calendar month`,`${rows.length} ${rows.length===1?'модель':rows.length<5?'модели':'моделей'} · 1 календарный месяц`);
 $('#estimate-status').textContent=valid?wording('Estimate from current prices. The server confirms your creator price.','Расчёт по текущим ценам. Тариф конкретной модели подтверждает сервер.'):wording('Fill in every creator’s revenue to calculate a total. Unknown revenue is not zero.','Заполните доход всех моделей. Неизвестный доход — не ноль.');
 const first=priceRow(rows[0]);
 $$('[data-tier-card]').forEach(c=>c.classList.toggle('is-current',!!first&&c.dataset.tierCard===first.tier.key));
}
function setLanguage(next){
 lang=next==='ru'?'ru':'en';document.documentElement.lang=lang;
 $$('[data-p]').forEach(el=>{if(COPY[lang][el.dataset.p]!==undefined)el.innerHTML=COPY[lang][el.dataset.p];});
 $$('[data-i18n="login"]').forEach(el=>el.textContent=wording('Log in','Войти'));
 $$('[data-i18n="getStarted"]').forEach(el=>el.textContent=wording('Get Started','Начать'));
 $('#lang-en').classList.toggle('active',lang==='en');$('#lang-ru').classList.toggle('active',lang==='ru');
 $('#language-toggle').setAttribute('aria-label',wording('Switch to Russian','Переключить на английский'));
 document.title=wording('NOD — Pricing · Nudes · Operation · Dollars','NOD — Цены · Nudes · Operation · Dollars');
 renderRows();
 $('.p-trial-number b').textContent=DATA.settings.trialDays;
 DATA.tiers.forEach(t=>{const e=document.querySelector('[data-tier-card="'+t.key+'"] .p-price strong');if(e)e.textContent=new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(t.cents/100);});
 $$('.p-addon-price').forEach((e,i)=>{const amount=i===0?DATA.settings.outreachPriceCents:DATA.settings.aiChatterPriceCents;e.childNodes[0].textContent=(i===0?'+':'')+currency(amount);});
 if(window.parent!==window)window.parent.postMessage({type:'nod:state',page:'pricing',lang},'*');
}
$('#language-toggle').addEventListener('click',()=>setLanguage(lang==='ru'?'en':'ru'));
$('#add-model').addEventListener('click',()=>{
 if(rows.length>=8)return;
 rows.push({id:++serial,revenue:'',outreach:false});renderRows();
 $(`#revenue-${serial}`).focus();
});
$('#reset-calculator').addEventListener('click',()=>{rows=[{id:++serial,revenue:'2500',outreach:false}];renderRows();});
$$('[data-example]').forEach(b=>b.addEventListener('click',()=>{rows[0].revenue=b.dataset.example;renderRows();$('#calculator').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});}));
$('#include-outreach').addEventListener('click',()=>{rows[0].outreach=true;renderRows();$('#calculator').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});});
const menu=$('#main-nav'),menuButton=$('#menu-toggle');
if(menuButton){menuButton.addEventListener('click',()=>{const expanded=menuButton.getAttribute('aria-expanded')==='true';menuButton.setAttribute('aria-expanded',String(!expanded));menu.classList.toggle('open',!expanded);});}
function closeMenu(){if(menuButton)menuButton.setAttribute('aria-expanded','false');menu.classList.remove('open');}
$$('#main-nav a').forEach(a=>a.addEventListener('click',closeMenu));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();}});
const dialog=$('#pricing-info');
$$('[data-pricing-info]').forEach(a=>a.addEventListener('click',e=>{
 e.preventDefault();const download=a.dataset.pricingInfo==='download';
 $('#info-title').textContent=download?wording('NOD for desktop.','NOD для компьютера.'):wording('Pricing, explained.','О ценах и доступе.');
 $('#info-body').textContent=download?wording('Open Download to see published builds and their release details.','Открой страницу загрузки, чтобы посмотреть опубликованные сборки и сведения о выпуске.'):wording('The calculator estimates the cost using current pricing. Review the questions below for revenue tiers, the agency trial and per-creator subscriptions. No real payment is processed here.','Калькулятор оценивает стоимость по текущим тарифам. В Questions есть ответы про уровни дохода, пробный период агентства и подписку каждой модели. Реальная оплата здесь не проводится.');
 dialog.showModal();
}));
$('#info-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
function navigation(link,page,view){link.addEventListener('click',e=>{
 if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
 if(window.parent!==window){e.preventDefault();window.parent.postMessage({type:'nod:navigate',page,view,lang},'*');}
 else{const url=new URL(page==='auth'?'auth.html':'index.html',actualUrl());url.searchParams.set('lang',lang);if(view)url.hash=view;link.href=url.href;}
});}
$$('[data-home]').forEach(a=>navigation(a,'home'));
$$('[data-auth-route]').forEach(a=>navigation(a,'auth',a.dataset.authRoute));
setLanguage(lang);
})();
