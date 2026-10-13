/* Published release metadata is supplied by the Backend. Missing releases remain unavailable. */
(()=>{
'use strict';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const COPY={en:{},ru:{
 skip:'Перейти к загрузке',login:'Войти',getStarted:'Начать',
 heroTitle:'Твоя работа.<br><em>На твоём компьютере.</em>',
 heroBody:'Меньше переключений. Больше дела.<br>Контент, переписки и команда —<br>в одном рабочем пространстве NOD.',
 chats:'Переписки',team:'Команда',analytics:'Аналитика',firstTime:'Впервые здесь? Начни с трёх шагов',
 previewTag:'NOD / DOWNLOAD',oneWorkspace:'Вся работа — в одном пространстве.',
 releaseDisclaimer:'Установщик для выбранной системы ещё не опубликован. Загрузка появится после публикации сборки.',
 buildInfo:'Информация о сборке',versionLabel:'Версия',fileSizeLabel:'Размер файла',systemLabel:'Системные требования',
 buildInfoNote:'Перед установкой проверь версию, систему и контрольную сумму файла.',
 alreadyRegistered:'Уже есть аккаунт?',railTitle:'Рабочее пространство на ПК. Не ещё одна вкладка.',comparePlans:'Тарифы и условия доступа',
 startLabel:'ПЕРВЫЕ ШАГИ',startTitle:'От установки<br><em>к первой рабочей смене.</em>',chooseRole:'С чего начинается твоя работа?',roleOwner:'Владелец агентства',roleMember:'Сотрудник',
 step1Title:'Установи NOD',step1Sub:'Начни на своём компьютере.',
 installLabel:'УСТАНОВКА',installTitle:'Место для работы.<br>На твоём компьютере.',
 installBody:'Выбери опубликованную сборку для своей системы, сохрани установщик и следуй его инструкциям. После установки открой NOD.',
 installNote:'Если сборка для твоей системы опубликована, скачай установщик выше.',
 backDownload:'Вернуться к загрузке',interfacePreview:'ПРИМЕР ИНТЕРФЕЙСА',setupVisual:'Здесь начинается твоя работа.',illustrationOnly:'Схема установки · установка не выполняется',
 accountLabel:'АККАУНТ',verificationNote:'Используй почту своего аккаунта и пройди её подтверждение, когда это потребуется. Вход в NOD и вход в OnlyFans модели — разные действия.',
 emailLabel:'Электронная почта',passwordLabel:'Пароль',accessIllustrationNote:'Это иллюстрация. Пароль здесь не запрашивается.',
 workspaceLabel:'РАБОЧЕЕ ПРОСТРАНСТВО',seeWorkspace:'Посмотреть рабочее пространство',exampleData:'ДЕМО-ДАННЫЕ',exampleTag:'ПРИМЕР',connectionLabel:'Подключение OnlyFans',accessLabel:'Доступ к NOD',separateState:'Проверяется отдельно',
 stepFooter:'Одно приложение. Доступ — по твоей роли.',beforeLabel:'ПЕРЕД НАЧАЛОМ',beforeTitle:'Всё необходимое.<br><em>Без догадок.</em>',
 internetTitle:'Подключение к интернету',internetBody:'Вход, подключённые аккаунты и серверные функции требуют соединения. Десктоп — не обещание полностью автономной работы.',
 accountTitle:'Правильный аккаунт NOD',accountBody:'Владелец создаёт агентство. Сотрудник принимает приглашение и получает назначенный доступ — без второго агентства.',
 aiTitle:'AI настраивается отдельно',aiBody:'AI-помощь в CRM и перевод требуют настроенной и доступной модели. Одна установка NOD не включает эти возможности автоматически.',
 hardwareNote:'Версии ОС, архитектура, требования к памяти и диску появятся вместе с проверенными сборками. ',
 faqLabel:'ВОПРОСЫ О ЗАГРУЗКЕ',faqTitle:'Меньше вопросов.<br><em>Ближе к работе.</em>',needHelp:'Нужна помощь с первым запуском?',
 q1:'Почему загрузка пока не начинается?',a1:'Кнопка доступна после публикации сборки для выбранной системы. Если сборка ещё не опубликована, на странице указан её статус.',
 q2:'Сотруднику нужно создавать ещё одно агентство?',a2:'Нет. Получи приглашение владельца и используй свой аккаунт NOD. В рабочем пространстве будут доступны назначенные модели и действия в пределах твоих прав.',
 q3:'Загрузка приложения активирует подписку?',a3:'Нет. Установка, подключение аккаунта OnlyFans и активный доступ к NOD — отдельные шаги. Условия доступа описаны на странице Pricing.',
 q4:'Можно работать в десктопе с телефона?',a4:'Эта страница предназначена для загрузки приложения на компьютер. С телефона можно смотреть сайт и примеры интерфейса; мобильный клиент NOD здесь не предлагается.',
 q5:'Где посмотреть версию и условия обновления?',a5:'Версия, размер и информация для проверки файла относятся к опубликованной сборке и показаны выше.',
 closingTitle:'Следующий шаг —<br><em>за тобой.</em>',backDownloadShort:'Скачать NOD Desktop',needAccount:'Нет аккаунта? Создать',footerNote:'NOD / DOWNLOAD',close:'Закрыть'
}};
$$('[data-d]').forEach(el=>COPY.en[el.dataset.d]=el.innerHTML);
Object.assign(COPY.en,{previewTag:'NOD / DOWNLOAD',releaseDisclaimer:'The installer for this system has not been published yet. The download will appear when a build is available.',buildInfoNote:'Check the version, system and file checksum before installing.',installNote:'Download the installer above if a build is available for your system.',hardwareNote:'System requirements are published with each build.',a1:'Downloads become available when a release is published for the selected system. Otherwise, the page shows its current status.',a5:'Version, size and file integrity details are shown above for the published build.',footerNote:'NOD / DOWNLOAD'});
COPY.en.heroBody=COPY.en.heroBody.replace(/<br\s*\/?>/g,'<br> ');COPY.ru.heroBody=COPY.ru.heroBody.replace(/<br\s*\/?>/g,'<br> ');
const rootConfig={releases:{}};
NODWeb.request('/api/site/config').then(data=>{rootConfig.releases=data.releases;renderRelease();}).catch(()=>{$('#release-state').textContent=words('Unable to load releases. Reload later.','Не удалось загрузить список сборок. Обнови страницу позже.');});
const parsedUrl=new URL(/^(https?|file):$/.test(location.protocol)?location.href:'https://nod-preview.invalid/download.html');
let lang=document.body.dataset.initialLang==='ru'||parsedUrl.searchParams.get('lang')==='ru'?'ru':'en';
let platform=document.body.dataset.initialPlatform||parsedUrl.searchParams.get('platform')||'windows';
if(!['windows','macos'].includes(platform))platform='windows';
let role='owner',step=1,currentDialog=null;
const words=(en,ru)=>lang==='ru'?ru:en;
const dialog=$('#download-dialog');
function release(){return rootConfig.releases?.[platform]||{label:platform==='windows'?'Windows':'macOS'};}
function verifiedUrl(r){
 if(r.confirmed!==true||typeof r.version!=='string'||!r.version.trim()||typeof r.url!=='string')return null;
 try{const u=new URL(r.url);return u.protocol==='https:'&&!u.username&&!u.password?u:null;}catch{return null;}
}
function publishState(){
 if(window.parent!==window)window.parent.postMessage({type:'nod:state',page:'download',lang,platform},'*');
 else{try{const u=new URL(location.href);u.searchParams.set('lang',lang);u.searchParams.set('platform',platform);history.replaceState({},'',u);}catch{/* File preview may deny history changes. */}}
}
function renderRelease(){
 const r=release(),url=verifiedUrl(r),ready=!!url;
 $$('[data-platform]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.platform===platform)));
 const name=platform==='windows'?'Windows':'macOS';
 $('#download-label').textContent=words('Download for '+name,'Скачать для '+name);
 $('#release-state').textContent=ready?words('Published build · '+r.version,'Опубликованная сборка · '+r.version):platform==='windows'?words('Installer link not connected yet','Ссылка на установщик ещё не подключена'):words('macOS build availability is not confirmed','Доступность сборки macOS не подтверждена');
 $('#release-state').classList.toggle('is-available',ready);
 $('#download-disclaimer').textContent=ready?words('This link opens the configured release file. Check the build information before installing.','Ссылка ведёт на настроенный файл релиза. Перед установкой проверь информацию о сборке.'):COPY[lang].releaseDisclaimer;
 $('#release-version').textContent=ready?r.version:words('Not published','Не опубликована');
 $('#release-size').textContent=ready&&Number.isFinite(r.sizeBytes)&&r.sizeBytes>0?new Intl.NumberFormat(lang==='ru'?'ru-RU':'en-US',{maximumFractionDigits:1}).format(r.sizeBytes/1048576)+' MB':words('Not published','Не опубликован');
 $('#release-system').textContent=ready&&r.minimumOS?r.minimumOS:words('To be confirmed','Уточняются к релизу');
 $('#release-hash').textContent=ready&&/^[a-f0-9]{64}$/i.test(r.sha256||'')?r.sha256:words('Not published','Не опубликован');
 $('#platform-selector').setAttribute('aria-label',words('Choose a platform','Выбрать платформу'));
}
function renderRole(){
 $$('[data-role]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.role===role)));
 const owner=role==='owner';
 $('#step2-title').textContent=owner?words('Create your account','Создай аккаунт'):words('Accept the invitation','Прими приглашение');
 $('#step2-sub').textContent=owner?words('Your agency starts here.','Начни своё агентство.'):words('Join the existing team.','Присоединись к команде.');
 $('#step3-title').textContent=owner?words('Connect a creator','Подключи модель'):words('Open your workspace','Открой рабочее место');
 $('#step3-sub').textContent=owner?words('Bring the work together.','Собери работу воедино.'):words('Use your assigned access.','Работай с назначенным доступом.');
 $('#account-step-title').innerHTML=owner?words('Your account.<br>Your agency.','Твой аккаунт.<br>Твоё агентство.'):words('Your account.<br>The team’s workspace.','Твой аккаунт.<br>Общее пространство.');
 $('#account-step-body').textContent=owner?words('Create the owner account and your agency, then sign in to the desktop with the same NOD credentials. Already registered? There is no need to create another account.','Создай аккаунт владельца и агентство, затем войди в десктоп с теми же данными NOD. Уже зарегистрирован? Второй аккаунт создавать не нужно.'):words('Use the invitation from your agency and sign in with your own NOD account. Do not register another agency just to join a team.','Используй приглашение агентства и войди в свой аккаунт NOD. Не регистрируй второе агентство, чтобы присоединиться к команде.');
 $('#setup-auth-link').dataset.view=owner?'register':'invite';$('#setup-auth-link').href='auth.html'+(lang==='ru'?'?lang=ru':'')+'#'+(owner?'register':'invite');
 $('#setup-auth-label').textContent=owner?words('Create an owner account','Создать аккаунт владельца'):words('Open invitation form','Открыть форму приглашения');
 $('#access-preview-title').textContent=owner?words('Your agency starts here.','Начни своё агентство.'):words('Your team is already here.','Твоя команда уже здесь.');
 $('#workspace-step-title').innerHTML=owner?words('Connect the creator.<br>Keep access in view.','Подключи модель.<br>Проверь доступ.'):words('The right models.<br>The right permissions.','Нужные модели.<br>Назначенные права.');
 $('#workspace-step-body').textContent=owner?words('In the desktop, add the creator’s internal name and expected OnlyFans username. Open the connection flow and complete sign-in for that account.','В десктопе укажи внутреннее имя модели и ожидаемый username OnlyFans. Открой подключение и заверши вход в нужный аккаунт.'):words('Open the workspace after accepting your invitation. Work with the creators and tools assigned to you by the agency.','После принятия приглашения открой рабочее пространство. Работай с моделями и инструментами, к которым агентство предоставило доступ.');
 $('#workspace-step-note').textContent=owner?words('Connection and NOD access are separate states. An installed app is not proof of a connected account or an active subscription.','Подключение и доступ NOD — разные состояния. Установленное приложение ещё не означает подключённый аккаунт или активную подписку.'):words('If a creator is missing, ask the owner to check your assignment. Avoid creating a duplicate creator or another agency to bypass access.','Если модели нет в списке, попроси владельца проверить назначение. Не создавай дубликат модели или другое агентство ради доступа.');
 $('#demo-connection').textContent=owner?words('Requires connection','Нужно подключить'):words('Agency-managed','Управляет агентство');
 $('#model-demo-note').textContent=owner?words('Illustrative state. Account login happens in the desktop, not in this website preview.','Пример состояния. Вход в аккаунт модели выполняется в десктопе, а не в макете сайта.'):words('Illustrative assignment only. The backend, not this preview, controls real account access.','Назначение показано для примера. Реальные права контролирует сервер, а не макет.');
}
function selectStep(next,focus=false){
 step=Math.max(1,Math.min(3,Number(next)||1));
 $$('[data-step]').forEach(b=>{const active=Number(b.dataset.step)===step;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});
 $$('.d-step-panel').forEach((p,i)=>p.hidden=(i+1)!==step);
 $('#next-step-label').textContent=step===3?words('Back to step 1','К первому шагу'):words('Next step','Следующий шаг');
 if(focus)$('#step-tab-'+step).focus({preventScroll:true});
}
function updateRouteLinks(){
 $$('[data-page]').forEach(a=>{const file={home:'index.html',auth:'auth.html',pricing:'pricing.html'}[a.dataset.page];if(!file)return;const u=new URL(file,parsedUrl);u.searchParams.set('lang',lang);if(a.dataset.view)u.hash=a.dataset.view;a.href=u.href;});
}
function setLanguage(next){
 lang=next==='ru'?'ru':'en';document.documentElement.lang=lang;
 $$('[data-d]').forEach(el=>{if(COPY[lang][el.dataset.d]!==undefined)el.innerHTML=COPY[lang][el.dataset.d];});
 $('#lang-en').classList.toggle('active',lang==='en');$('#lang-ru').classList.toggle('active',lang==='ru');
 $('#language-toggle').setAttribute('aria-label',words('Switch to Russian','Переключить на английский'));
 $('#dialog-close').setAttribute('aria-label',words('Close dialog','Закрыть окно'));
 $('#menu-toggle').setAttribute('aria-label',words('Toggle navigation','Открыть или закрыть меню'));
 document.title=words('NOD — Download · Nudes · Operation · Dollars','NOD — Скачать · Nudes · Operation · Dollars');
 renderRelease();renderRole();selectStep(step);updateRouteLinks();if(dialog.open)renderDialog();publishState();
}
function scrollTo(id){$(id).scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});}
function renderDialog(){
 const help=currentDialog==='help';
 $('#dialog-category').textContent=help?'FIRST STEPS':'DOWNLOAD';
 $('#dialog-title').textContent=help?words('Start with your role.','Начни со своей роли.'):platform==='macos'?words('macOS is not confirmed yet.','Сборка macOS пока не подтверждена.'):words('The installer isn’t connected yet.','Установщик ещё не подключён.');
 $('#dialog-body').textContent=help?words('An owner creates an agency and connects creators. A team member accepts an invitation. Choose your role in the walkthrough to see the right steps.','Владелец создаёт агентство и подключает моделей. Сотрудник принимает приглашение. Выбери свою роль в инструкции — шаги будут соответствовать ей.'):words('No published '+(platform==='windows'?'Windows':'macOS')+' release URL has been supplied. No installer download has started.','Ссылка на опубликованную сборку '+(platform==='windows'?'Windows':'macOS')+' ещё не указана. Загрузка установщика не запускалась.');
 $('#dialog-note').textContent=help?words('This is a local setup guide, not a connected support chat. No request or personal information is sent.','Это локальная инструкция, не подключённый чат поддержки. Обращение и персональные данные не отправляются.'):words('A published version, system requirements and verified file link are needed before this action can become a real download.','Для настоящей загрузки нужны опубликованная версия, системные требования и проверенная ссылка на файл.');
 $('#dialog-action-label').textContent=words('See the setup steps','Посмотреть первые шаги');
}
function openDialog(mode){currentDialog=mode;renderDialog();if(!dialog.open)dialog.showModal();}
$('#download-button').addEventListener('click',()=>{const url=verifiedUrl(release());if(!url){openDialog('release');return;}
 // This branch is reachable only after an operator configures a confirmed HTTPS release.
 const a=document.createElement('a');a.href=url.href;a.rel='noopener noreferrer';a.target='_blank';a.click();
});
$$('[data-platform]').forEach(b=>b.addEventListener('click',()=>{platform=b.dataset.platform;renderRelease();publishState();}));
$$('[data-role]').forEach(b=>b.addEventListener('click',()=>{role=b.dataset.role;renderRole();updateRouteLinks();}));
$$('[data-step]').forEach(b=>{
 b.addEventListener('click',()=>selectStep(b.dataset.step));
 b.addEventListener('keydown',e=>{let next=null;if(e.key==='ArrowRight')next=step%3+1;if(e.key==='ArrowLeft')next=(step+1)%3+1;if(e.key==='Home')next=1;if(e.key==='End')next=3;if(next!==null){e.preventDefault();selectStep(next,true);}});
});
$('#next-step').addEventListener('click',()=>selectStep(step%3+1,true));
$('#language-toggle').addEventListener('click',()=>setLanguage(lang==='ru'?'en':'ru'));
$$('[data-open-help]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();closeMenu();openDialog('help');}));
$('#dialog-primary').addEventListener('click',()=>{dialog.close();currentDialog=null;scrollTo('#getting-started');$('#step-tab-'+step).focus({preventScroll:true});});
[$('#dialog-close'),$('#dialog-dismiss')].forEach(b=>b.addEventListener('click',()=>dialog.close()));
dialog.addEventListener('close',()=>currentDialog=null);
dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
const menu=$('#main-nav'),menuButton=$('#menu-toggle');
function closeMenu(){menuButton.setAttribute('aria-expanded','false');menu.classList.remove('open');}
menuButton.addEventListener('click',()=>{const active=menuButton.getAttribute('aria-expanded')!=='true';menuButton.setAttribute('aria-expanded',String(active));menu.classList.toggle('open',active);});
$$('#main-nav a').forEach(a=>a.addEventListener('click',closeMenu));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&menu.classList.contains('open')){closeMenu();menuButton.focus();}});
$$('[data-page]').forEach(a=>a.addEventListener('click',e=>{if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
 if(window.parent!==window){e.preventDefault();window.parent.postMessage({type:'nod:navigate',page:a.dataset.page,view:a.dataset.view||'login',lang},'*');}
}));
// Local anchors must not reload the enclosing self-contained bundle.
$$('a[href^="#"]').forEach(a=>a.addEventListener('click',e=>{
 if(a.hasAttribute('data-open-help')||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
 const target=document.getElementById(a.getAttribute('href').slice(1));
 if(!target)return;e.preventDefault();target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});
}));
$$('[data-demo-home]').forEach(b=>b.addEventListener('click',()=>{if(window.parent!==window)window.parent.postMessage({type:'nod:navigate',page:'home',demo:true,lang},'*');else{const u=new URL('index.html',parsedUrl);u.searchParams.set('demo','overview');u.searchParams.set('lang',lang);location.href=u.href;}}));
setLanguage(lang);
})();
