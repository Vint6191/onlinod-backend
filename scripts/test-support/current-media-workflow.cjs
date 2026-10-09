"use strict";
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {createRequire} = require('node:module'), {pathToFileURL} = require('node:url');
exports.runMedia = async function(f) {
 const {modules:m, desktop,scratch,output,auth,api,agencyId,deviceId,creatorId:c,creatorIds,must,pass,results}=f;
 const load=createRequire(path.join(desktop,'package.json'));
 const runtime=createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME,'package.json'));
 const logs=[],requests=[],calls=[],errors=[],providerCalls=[];
 const log=Object.fromEntries(['debug','info','warn','error'].map(level=>[level,(...args)=>logs.push({level,args:JSON.parse(JSON.stringify(args,(_k,v)=>v instanceof Error?{message:v.message,code:v.code}:v))})]));
 const authStore={...auth,readSession:()=>({...auth.readSession(),deviceId}),getDeviceId:()=>deviceId,
  getAuthorizationScopeHash:()=>agencyId+':'+deviceId,getActiveCreatorId:()=>c,setActiveCreatorId(){},onSessionChanged:()=>()=>{}};
 const authService={ensureSession:async()=>({authenticated:true,session:authStore.readSession()})};
 const permissions=Object.fromEntries(['content.manage_vault','content.manage_message_library','messageLibrary.manage','content.delete_posts','money.view_earnings'].map(k=>[k,true]));
 const authority=new m.DesktopCurrentAuthorizationAuthorityService({log,authStore,accessRuntime:{currentAuthorityProof:()=>({accessEpoch:1,creatorCatalogGeneration:1}),allowedCreatorIdsSnapshot:()=>creatorIds}});
 const publish=()=>authority.publish({accessEpoch:1,creatorCatalogGeneration:1,role:'OWNER',roleKey:'owner',effectivePermissions:permissions,allowedCreatorIds:creatorIds,observedAt:Date.now(),observedAtMono:performance.now(),billing:{version:1,validForMs:90000,creators:creatorIds.map(creatorId=>({creatorId,allowed:true,validForMs:90000,reason:'TRIAL'}))}});publish();
 const coordinator=new m.WorkCoordinatorService({log,databasePath:path.join(scratch,'media-work.sqlite')});
 const capabilities={canRun:()=>({allowed:true}),onChanged:()=>()=>{},get:creatorId=>({api:{readReady:true,writeReady:true},browser:{pageLocalReady:true,materialized:true,presentable:true},identity:{state:'VERIFIED',platformUserId:creatorId===c?'100001':'100002',sessionProofEpoch:1},access:{accessEpoch:1},session:{partition:'persist:acceptance:'+creatorId,sessionEpoch:1,canonicalRevision:1,networkRevision:0,runtimeGeneration:1},realtime:{ready:true,lastInboundFrameAt:new Date().toISOString()}})};
 coordinator.setCapabilityResolver((...args)=>capabilities.canRun(...args));
 coordinator.setAuthorizationResolver(({item,authorizationClass,provenance})=>authorizationClass==='HUMAN_COMMAND'?authority.evaluateHumanCommandProvenance(provenance):authorizationClass==='CURRENT_DATA_PROCESS'?authority.evaluateCurrentDataProcess(item.creatorId):{allowed:true});
 coordinator.setControlAuthorizationResolver({allowedCreatorIds:()=>{authority.capturePermit('CONTROL');return creatorIds;},authorizeCreator:creatorId=>{try{authority.capturePermit('CONTROL',{creatorId});return{allowed:true};}catch(e){return{allowed:false,reason:e.message};}}});
 const commands=new m.ManagementCommandTransport(api,authStore,path.join(scratch,'media-management.json'),authority,()=>{});
 let loseSave=false;
 const nativeFetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input)); assert.equal(url.origin,api.apiBase,'Only the isolated Backend may be contacted');
  const response=await nativeFetch(input,options); requests.push({method:options?.method||'GET',path:url.pathname,status:response.status});
  if(loseSave && url.pathname.endsWith('/message-library/commands/v3') && response.ok){loseSave=false;await response.clone().text();results.lostSaveReply=true;throw Error('Controlled lost reply after SQL commit');}
  return response;
 };
 const commandOptions={actions:['save','duplicate','trash','restore','permanent','block.trash','block.restore'],endpoint:'/api/server/content/message-library/commands/v3',domain:'Message Library',maxPayloadBytes:2*1024*1024,allowMediaUrls:true,label:(action,payload)=>action+' script '+(payload.title||''),slot:(_a,target,payload)=>JSON.stringify([payload.creatorId,target])};
 let libraryCommands,library;
 const openLibrary=()=>{
  libraryCommands=new m.DurableCommandTransport(new m.BackendApiClient(authStore,authService),authStore,path.join(scratch,'message-library.json'),null,null,commandOptions);
  library=new m.MessageLibraryService({log,authStore,authService,authorization:authority,commands:libraryCommands});
 };openLibrary();
 const mediaLibrary=new m.MediaLibraryService({log,authStore,authService,authorization:authority,coordinator,managementCommands:commands});
 mediaLibrary.bindUsageSourceProvider({listMediaLibraryUsageSources:async()=>[]});
 const directory=new m.VaultDirectoryBackendService(authStore,authService,mediaLibrary,undefined,commands);
 let mediaGeneration=1;const transfers=[],relays=[];
 const sourceMedia=Array.from({length:45},(_,i)=>({id:String(90001+i),type:i===1?'video':'photo',duration:i===1?25:0,createdAt:new Date().toISOString(),lists:i<2?[{id:'101',hasMedia:true}]:[],files:{thumb:{url:`https://fixture.invalid/thumb-${i}`},preview:{url:`https://fixture.invalid/preview-${i}`},full:{url:`https://fixture.invalid/current-${i}-v1`}}}));
 const folders=[{id:'messages',name:'Messages',type:'messages',count:sourceMedia.length},...Array.from({length:102},(_,i)=>({id:String(101+i),name:'Collection '+String(i+1).padStart(3,'0'),type:'custom',count:i===0?2:0,canDelete:true,canUpdate:true}))];
 const ofApi={getStatus:()=>({status:{rulesReady:true,hasAppToken:true,hasXBc:true,hasUserId:true}}),async uploadLocalMedia(input){assert.ok(fs.statSync(input.filePath).size>0);transfers.push(input.preparationId);return{ok:true,descriptor:{extra:'controlled-extra',host:'fixture.invalid',name:'upload.jpg',processId:'controlled-upload'},uploadedBytes:16,totalBytes:16};},async request(input){
  providerCalls.push({creatorId:input.creatorId,source:input.source,endpoint:input.endpoint});
  const u=new URL(input.endpoint.path,'https://onlyfans.com'),offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100);
  const success=data=>({ok:true,status:200,data});
  if(input.source==='vault.localUpload.resolveRecipient')return success({id:900001,username:'fixture_relay'});
  if(input.source==='vault.relay.preflight.me')return success({id:100001});
  if(['vault.relay.preflight.messages','vault.relay.reconcile.messages'].includes(input.source))return success({list:relays,hasMore:false});
  if(input.source==='vault.localUpload.relay.commit'){
    assert.equal(input.writeAuthorityContext.authorityKind,'PROGRAMMATIC_OF_WRITE');
    assert.equal(input.endpoint.body.mediaFiles[0].processId,'controlled-upload');
    const item={id:'90100',type:'photo',isReady:true,lists:[],createdAt:new Date().toISOString(),files:{thumb:{url:'https://fixture.invalid/upload-thumb'},preview:{url:'https://fixture.invalid/upload-preview'},full:{url:'https://fixture.invalid/upload-v1'}}};
    sourceMedia.push(item);const row={id:'910001',media:[item],fromUser:{id:100001},toUser:{id:900001},createdAt:new Date().toISOString()};relays.push(row);return success(row);
  }
  if(input.source==='vault.localUpload.batchMove'){
    const folderId=u.pathname.match(/lists\/([^/]+)\/media/)[1];for(const id of input.endpoint.body.mediaIds)sourceMedia.find(row=>row.id===id).lists=[{id:folderId,hasMedia:true}];return success({success:true});
  }
  if(u.pathname.includes('/vault/lists')&&!u.pathname.endsWith('/media')) return success({all:{count:sourceMedia.length},list:input.creatorId===c?folders.slice(offset,offset+limit):[],hasMore:input.creatorId===c&&offset+limit<folders.length,canCreateVaultLists:true});
  if(u.pathname.includes('/vault/media')||u.pathname.endsWith('/media')) {
    const listId=u.searchParams.get('list')||u.searchParams.get('listId')||u.pathname.match(/lists\/([^/]+)\/media/)?.[1];
    let rows=input.creatorId===c?sourceMedia:[];
    if(listId && !['all','messages'].includes(listId)) rows=rows.filter(row=>row.lists.some(list=>list.id===listId));
    return success({list:rows.slice(offset,offset+limit).map(row=>({...row,files:{...row.files,full:{url:row.files.full.url.replace('v1','v'+mediaGeneration)}}})),hasMore:offset+limit<rows.length});
  }
  throw Error('UNEXPECTED_PROVIDER_REQUEST '+JSON.stringify(input));
 }};
 const salesService=new m.VaultSalesService(authStore,authService,{},mediaLibrary,authority,commands);
 const writes=new m.ProgrammaticOfWriteClient(authStore,authService);
 const vault=new m.VaultService({log,ofApi,writes,authorization:authority,coordinator,directoryBackend:directory,mediaLibrary,getMainWindow:()=>null});
 const custom=new m.CustomOrdersService(api,{},vault,deviceId,{authorization:authority,managementCommands:commands,...Object.fromEntries(["vaultDestinationIntentDatabasePath","telegramDeliveryDatabasePath","deliveryConfirmationDatabasePath","nativeMassSettlementDatabasePath","pageWriteSettlementDatabasePath"].map(key=>[key,path.join(scratch,key+".sqlite")]))});
 const campaigns=new m.CampaignsService({log,ofApi,vault,programmaticWrites:writes,customOrders:custom,authorization:authority,audienceProfiles:{},computeWorker:{},workCoordinator:coordinator});
 const data=new m.DialogMediaPickerDataService({vault,mediaLibrary,customMediaAvailability:custom,
  dialogMessages:{getDialogMediaState:async()=>({ok:true,snapshot:{creatorId:c,dialogId:'422411209',items:[]}})}});
 const pickerContext={sessionId:'media-session-1',creatorId:c,accountId:c,dialogId:'422411209',tabId:'tab-a'};data.startSession(pickerContext);
 const creatorService=m.createCreatorService(authStore,authService);
 const worker=new m.BackendReadonlyJobWorker({log,authStore,authService,creatorService,capabilities,creatorRuntime:{getVerifiedIdentity:id=>({platformUserId:id===c?'100001':'100002'}),getState:()=>({attached:true,websocket:{connected:true}}),on:()=>()=>{}},coordinator,ofApi,
  accessRuntime:{captureAuthorizationScopePermit:()=>({}),isAuthorizationScopePermitCurrent:()=>true,revokeCreator(){throw Error('UNEXPECTED_REVOKE');}},apiRuntime:{getAll:()=>({})},backgroundRuntime:{isBackground:()=>true},events:{emit(){}},sessionReconcile:{reconcileDurableAccessCatalog:async()=>{},observeCanonicalManifests(){},observeNetworkManifests(){},hardRevokeCreator(){throw Error('UNEXPECTED_REVOKE');},hardRevokeAll(){throw Error('UNEXPECTED_LOGOUT');}}});
 let browser,browserContext,server,page,composerPage,pickerPage,sidecarPage,sidecar,renewal;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(fn,label,timeout=30000)=>{const end=Date.now()+timeout;while(!await fn()){if(Date.now()>end)throw Error(label+' '+JSON.stringify(logs.slice(-5)));await wait(80);}};
 const handlers=()=>({...m.createMessageLibraryHandlers(library),...m.createMediaLibraryHandlers(mediaLibrary),...m.createVaultHandlers(vault),...m.createVaultSalesHandlers(salesService),
  'messageLibraryCommands.listPending':()=>libraryCommands.listPending(),'messageLibraryCommands.retry':i=>library.retryCommand(i.commandId),'messageLibraryCommands.acknowledge':i=>libraryCommands.acknowledge(i.commandId),'messageLibraryCommands.cancel':i=>libraryCommands.cancel(i.commandId),
  'campaigns.loadVaultMedia':i=>campaigns.loadVaultMedia(i),'workCoordinator.list':i=>coordinator.listControlled(i),'managementCommands.listPending':()=>commands.listPending(),'managementCommands.acknowledge':i=>commands.acknowledge(i.commandId),'managementCommands.retry':i=>commands.retry(i.commandId)});
 try {
  renewal=setInterval(publish,30000);
  const creators=await Promise.all(creatorIds.map(async id=>(await must('GET',`/api/creators/${id}`)).creator));
  const renderer=path.join(desktop,'apps/desktop/renderer/src'), pageRuntime=path.join(desktop,'apps/desktop/electron/page-runtimes');
  const entry=path.join(scratch,'media-renderer.tsx'),script=path.join(scratch,'media-renderer.js');
  fs.writeFileSync(entry,`import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{MessageLibraryWorkspace}from ${JSON.stringify(path.join(renderer,'features/message-library/MessageLibraryWorkspace.tsx'))};
import{VaultDashboard}from ${JSON.stringify(path.join(renderer,'features/vault/VaultDashboard.tsx'))};
import{DialogMediaPickerApp}from ${JSON.stringify(path.join(renderer,'dialog-media-picker/DialogMediaPickerApp.tsx'))};
import{MessageLibrarySidecarRuntime}from ${JSON.stringify(path.join(renderer,'tool-sidecar/modules/scripts/runtime.ts'))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer,'shared/rpc/authorization-scope.ts'))};
import ${JSON.stringify(path.join(renderer,'features/media-picker/media-picker.ts'))};
import ${JSON.stringify(path.join(renderer,'styles.css'))};import ${JSON.stringify(path.join(renderer,'dialog-media-picker/picker.css'))};
let root;const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
export async function rpc(method,payload){const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}
export function mount(input){window.onlinod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:rpc}};acceptRendererAuthorizationProjection(input.projection);root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><QueryClientProvider client={client}><MessageLibraryWorkspace session={input.session} creators={input.creators} activeCreator={input.creators[0]}/></QueryClientProvider></React.StrictMode>);}
export function picker(){window.onlinodDialogMediaPicker={bootstrap:i=>window.actualPicker('bootstrap',i),loadLists:i=>window.actualPicker('loadLists',i),loadMedia:i=>window.actualPicker('loadMedia',i),searchMedia:i=>window.actualPicker('searchMedia',i),attachDraft:i=>window.actualPicker('attachDraft',i),close:async()=>({ok:true}),setPresentationMode:async i=>({ok:true,mode:i.mode}),moveBy(){},onSessionChanged:()=>()=>{}};root=createRoot(document.getElementById('root'));root.render(<DialogMediaPickerApp/>);}
export async function scripts(context){window.__ONLINOD_TOOL_SIDECAR_CONTEXT__=context;window.onlinodToolSidecar={applyMessageDraft:message=>window.actualApply(message),copyText:async()=>({ok:true}),setSurfaceState(){}};window.onlinodMessageLibrary={listScripts:i=>rpc('messageLibrary.listScripts',{...i,creatorId:context.creatorId}),recordUsage:i=>rpc('messageLibrary.recordUsage',{...i,creatorId:context.creatorId})};const runtime=new MessageLibrarySidecarRuntime();window.scriptsRuntime=runtime;await runtime.refresh(true);runtime.state.open=true;runtime.render();}
export function vault(input){root?.unmount();root=createRoot(document.getElementById('root'));root.render(<VaultDashboard creators={input.creators} activeCreator={input.creators[0]}/>);}
export function unmount(){root?.unmount();client.clear();}`);
  await load('esbuild').build({entryPoints:[entry],outfile:script,bundle:true,platform:'browser',format:'iife',globalName:'ActualMedia',jsx:'automatic',nodePaths:[path.join(desktop,'node_modules')],loader:{'.css':'css','.png':'dataurl','.svg':'dataurl'},define:{'process.env.NODE_ENV':'"development"'}});
  const nativeEntry=path.join(scratch,'composer.ts'),nativeBundle=path.join(scratch,'composer.js');
  fs.writeFileSync(nativeEntry,`export{DialogMediaPageRuntime}from ${JSON.stringify(path.join(pageRuntime,'dialog-media-page/lifecycle.ts'))};export{ToolSidecarComposerBridge}from ${JSON.stringify(path.join(pageRuntime,'tool-sidecar-page-bridge/composer-bridge.ts'))};`);
  await load('esbuild').build({entryPoints:[nativeEntry],outfile:nativeBundle,bundle:true,platform:'browser',format:'iife',globalName:'ActualComposer'});
  server=http.createServer((req,res)=>{const file=req.url==='/app.js'?script:req.url==='/app.css'?script.replace(/js$/,'css'):null;res.setHeader('Content-Type',file?file.endsWith('js')?'application/javascript':'text/css':'text/html');res.end(file?fs.readFileSync(file):'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {default:chromium}=await import(pathToFileURL(runtime.resolve('@sparticuz/chromium')).href);
  browser=await runtime('playwright').chromium.launch({executablePath:process.env.ONLINOD_CHROMIUM_PATH||await chromium.executablePath(),args:chromium.args,headless:true});
  browserContext=await browser.newContext({viewport:{width:1440,height:1050}});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const newPage=async()=>{const p=await browserContext.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('console',e=>{if(e.type()==='error'&&/same key|React/.test(e.text()))errors.push(e.text());});await p.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());await p.exposeFunction('actualRpc',async(method,input)=>{calls.push({method,input});try{assert.ok(handlers()[method],'Unexpected RPC '+method);return{result:await handlers()[method](input)};}catch(e){return{error:{message:e.message,code:e.code}};}});p.setDefaultTimeout(15000);await p.goto(origin);return p;};
  page=await newPage();
  const mount={creators,session:{...authStore.readSession(),permissions},projection:{ok:true,authenticated:true,current:true,quarantineState:'CURRENT',localAuthorizationRevision:1,session:{...authStore.readSession(),accessToken:undefined,refreshToken:undefined},creators,activeCreatorId:c}};
  await page.evaluate(i=>ActualMedia.mount(i),mount);
  await page.getByText('No scripts yet.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'New script',exact:true}).first().click();
  await page.getByLabel('Script title',{exact:true}).fill('Media acceptance chain');
  await page.getByLabel('Message 1 text',{exact:true}).fill('Paid library message\nSecond line');
  await page.getByLabel('Message 1 price',{exact:true}).fill('12.50');
  await page.getByLabel('Locked text',{exact:true}).check();
  await page.getByRole('button',{name:'Add from Vault',exact:true}).click();
  await until(async()=>await page.locator('[data-mpk-pick]').count()>0,'Universal picker did not load');
  await page.screenshot({path:path.join(output,'01-library-picker.png')});
  // Continue the same actual interface below.
  await page.locator('[data-mpk-pick]').first().click();
  await page.locator('[data-mpk-pick]').nth(1).click();
  await page.getByRole('button',{name:'ADD TO MESSAGE',exact:true}).click();
  await page.getByRole('button',{name:'Add message',exact:true}).click();
  await page.getByLabel('Message 2 text',{exact:true}).fill('Free follow-up');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByText('Saved script',{exact:true}).waitFor();
  const stored=(await library.listScripts({creatorId:c,includeTrash:true})).items[0];
  assert.equal(stored.messages.length,2);assert.equal(stored.messages[0].media.length,2);assert.equal(stored.messages[0].price,12.5);
  results.script=stored;await page.screenshot({path:path.join(output,'02-library-saved.png')});
  pass('Actual HQ editor and universal Vault picker save a two-block priced script through Desktop journal and SQL');
  // Real page adapter on a controlled native Vue composer contract. No live OF.
  composerPage=await browserContext.newPage();console.log('READY controlled composer page');
  await composerPage.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div class="b-chat__message-form"><textarea aria-label="Composer">Previous local text</textarea></div>'}));
  await composerPage.goto('https://onlyfans.com/my/chats/chat/422411209/');
  await composerPage.addScriptTag({content:fs.readFileSync(nativeBundle,'utf8')});
  await composerPage.evaluate(async()=>{
   const target={text:'Previous local text',lockedText:false,price:0,mediaIndex:{},previewsOrder:[],uploadedFiles:[],unlockedMedia:[],uploads:{keep:'active-upload'},removedUploadedFiles:['keep-removal'],releaseFormsIds:['keep-release'],
    getMediaData(files){const items=files.map(file=>({...file,orderId:'native-'+file.id}));for(const item of items)this.mediaIndex[item.id]=item.orderId;return [...this.uploadedFiles,...items];},
    setUnlockedMedia(ids){if(window.failFree)throw Error('controlled native failure');this.unlockedMedia=ids.map(id=>this.mediaIndex[id]);}};
   document.querySelector('.b-chat__message-form').__vueParentComponent={proxy:target};window.nativeComposer=target;
   const runtime=new ActualComposer.DialogMediaPageRuntime({openPicker:async()=>({ok:true})});await runtime.mount();window.nativeRuntime=runtime;
   window.__ONLINOD_TOOL_SIDECAR_PAGE_BRIDGE__=new ActualComposer.ToolSidecarComposerBridge({});
  });
  const pageContext={webContentsId:101,tabId:'tab-a',creatorId:c,accountId:c,partition:'persist:fixture',url:composerPage.url()};
  const sidecarContents={id:99,mainFrame:{},isDestroyed:()=>false,send(){},close(){}};
  m.fixture.target={id:101,isDestroyed:()=>false,executeJavaScript:expression=>composerPage.evaluate(expression)};
  sidecar=new m.ToolSidecarService({log,getMainWindow:()=>null,browser:{getBounds:()=>null,getForegroundOnlyFansPageContext:()=>pageContext,isWebContentsForeground:()=>true},customOrders:custom,vault,authorization:authority,handlers:handlers()});
  const attachSidecar=()=>{sidecar.view={webContents:sidecarContents,setBounds(){}};sidecar.attached=true;};attachSidecar();
  const apply=async(message)=>{
   attachSidecar();const response=await m.fixture.handlers.get('onlinod:tool-sidecar:page-action')({sender:sidecarContents,senderFrame:sidecarContents.mainFrame},
    {id:'library-apply-'+require('node:crypto').randomUUID(),action:'applyMessageDraft',input:{message},scope:sidecar.publicContext(pageContext)});
   if(!response.ok)throw Object.assign(Error(response.error.message),{code:response.error.code});return response.result;
  };
  const composerSnapshot=()=>composerPage.evaluate(()=>({text:document.querySelector('textarea')?.value ?? document.querySelector('[contenteditable]').innerText,lockedText:nativeComposer.lockedText,price:nativeComposer.price,mediaIndex:nativeComposer.mediaIndex,
   media:nativeComposer.uploadedFiles.map(row=>({id:row.id,orderId:row.orderId,url:row.files.full.url})),free:nativeComposer.unlockedMedia,uploads:nativeComposer.uploads,removed:nativeComposer.removedUploadedFiles,releases:nativeComposer.releaseFormsIds}));
  mediaGeneration=2;
  sidecarPage=await newPage();await sidecarPage.exposeFunction('actualApply',apply);
  await sidecarPage.evaluate(context=>ActualMedia.scripts(context),pageContext);
  console.log('READY Scripts surface');await sidecarPage.locator('[data-ml-apply]').first().click();
  await until(async()=>(await sidecarPage.locator('.on-ml-status').textContent()).includes('draft inserted'),'Scripts did not confirm native composer');
  const paid=await composerSnapshot();assert.equal(paid.price,12.5);assert.equal(paid.text,stored.messages[0].text);assert.equal(paid.lockedText,true);
  assert.equal(paid.media.length,2);assert.deepEqual(paid.free,[]);assert.ok(paid.media.every(row=>row.orderId.startsWith('native-')&&row.url.endsWith('v2')));
  assert.deepEqual(paid.uploads,{keep:'active-upload'});assert.deepEqual(paid.removed,['keep-removal']);assert.deepEqual(paid.releases,['keep-release']);
  await until(()=>calls.some(row=>row.method==='messageLibrary.recordUsage'),'Confirmed draft usage did not reach Desktop');
  await until(async()=>requests.some(row=>row.path.endsWith('/message-library/usage/v2')&&[200,201].includes(row.status)),'Usage did not reach SQL');
  results.paidComposer=paid;await sidecarPage.screenshot({path:path.join(output,'03-scripts-composer.png')});
  pass('Real Scripts sidecar -> main provenance and current Vault resolution -> shared native composer, exact paid state and usage');
  const bad=await apply({...stored.messages[0],currency:'EUR'});assert.equal(bad.complete,false);assert.deepEqual(await composerSnapshot(),paid);
  await composerPage.evaluate(()=>{window.failFree=true;});
  const failed=await apply({...stored.messages[0],price:0,lockedText:false});assert.equal(failed.complete,false);assert.deepEqual(await composerSnapshot(),paid);
  await composerPage.evaluate(()=>{window.failFree=false;});
  await sidecarPage.locator('[data-ml-apply]').nth(1).click();
  await until(async()=>(await composerSnapshot()).text==='Free follow-up','Free follow-up was not applied');
  const free=await composerSnapshot();assert.equal(free.price,0);assert.equal(free.lockedText,false);assert.equal(free.media.length,0);assert.deepEqual(free.free,[]);
  results.freeComposer=free;
  pass('Free text replaces the paid block; incompatible currency and native attachment failure preserve the previous composer');
  await composerPage.evaluate(()=>{const area=document.querySelector('textarea'),editable=document.createElement('div');editable.contentEditable='true';editable.className='tiptap ProseMirror';editable.innerText=area.value;area.replaceWith(editable);});
  const textOnly={...stored.messages[1],text:'Locked text\nwithout media',price:4.25,lockedText:true};
  assert.equal((await apply(textOnly)).complete,true);const lockedText=await composerSnapshot();assert.equal(lockedText.price,4.25);assert.equal(lockedText.text,textOnly.text);assert.equal(lockedText.media.length,0);
  await composerPage.evaluate(()=>{nativeComposer.savedPrepare=nativeComposer.getMediaData;nativeComposer.getMediaData=function(files){const result=this.savedPrepare(files);nativeRuntime.suspend();return result;};});
  const suspended=await apply(stored.messages[0]);assert.equal(suspended.complete,false);assert.deepEqual(await composerSnapshot(),lockedText);
  await composerPage.evaluate(()=>{nativeComposer.getMediaData=nativeComposer.savedPrepare;delete nativeComposer.savedPrepare;nativeRuntime.resume();});
  assert.equal((await apply(stored.messages[1])).complete,true);
  results.lockedTextComposer=lockedText;
  pass('Contenteditable multiline and paid text-only blocks work; suspension cancels an in-flight application without changing the composer');
  // Metadata is created through the same revision-checked management commands.
  for(const [id,description,accessType] of [['90001','Sunrise portrait','free'],['90002','Sunrise video','paid']]){
   const saved=await mediaLibrary.upsertMetadata({creatorId:c,onlyfansMediaId:id,expectedAssetId:null,expectedUpdatedAt:null,mediaType:id==='90002'?'video':'photo',description,manualTags:['sunrise'],visibleBodyParts:[],accessType,minPrice:accessType==='paid'?5:0,idealPrice:accessType==='paid'?12.5:0});assert.equal(saved.ok,true);commands.acknowledge(saved.commandId);
  }
  pickerPage=await newPage();
  await pickerPage.exposeFunction('actualPicker',async(method,input)=>{
   if(method==='bootstrap')return data.bootstrap(pickerContext);
   if(method==='attachDraft'){
    const ids=[...input.draft.freeMediaIds,...input.draft.paidMediaIds];const resolved=data.resolveComposerMedia(pickerContext,ids);assert.deepEqual(resolved.missingIds,[]);
    const proof=await custom.preflightDialogComposerDraft({creatorId:c,dialogId:pickerContext.dialogId,mediaIds:ids});assert.equal(proof.allow,true);
    const command={requestId:'picker-'+require('node:crypto').randomUUID(),sessionId:pickerContext.sessionId,dialogId:pickerContext.dialogId,freeMediaIds:input.draft.freeMediaIds,paidMediaIds:input.draft.paidMediaIds,priceCents:input.draft.paidPriceCents||0,media:resolved.items.map(item=>({mediaId:item.id,mediaType:item.type,fullUrl:item.fullUrl,previewUrl:item.previewUrl,thumbUrl:item.thumbUrl,createdAt:item.createdAt}))};
    const result=await composerPage.evaluate(command=>window.__ONLINOD_DIALOG_MEDIA_COMPOSER_APPLY__(command),command);results.pickerApply=result;
    return{...result,attachedCount:ids.length,freeCount:command.freeMediaIds.length,paidCount:command.paidMediaIds.length,priceCents:command.priceCents};
   }
   assert.ok(['loadLists','loadMedia','searchMedia'].includes(method));return data[method](pickerContext,input);
  });
  await pickerPage.evaluate(()=>ActualMedia.picker());
  await pickerPage.getByRole('button',{name:'Load more folders',exact:true}).waitFor();
  await pickerPage.getByRole('button',{name:'Load more folders',exact:true}).click();
  await pickerPage.getByRole('button',{name:/Collection 102/}).waitFor();
  assert.equal(await pickerPage.getByRole('button',{name:'Load more folders',exact:true}).count(),0);
  await pickerPage.getByLabel('Find folder',{exact:true}).fill('Collection 102');assert.equal(await pickerPage.locator('.dmp-folder-row').count(),2);
  await pickerPage.getByLabel('Find folder',{exact:true}).fill('');
  await pickerPage.getByLabel('Search media',{exact:true}).fill('sunrise');
  await until(async()=>(await pickerPage.locator('.dmp-card').count())===2,'Search did not resolve metadata');
  await pickerPage.locator('[data-media-id="90001"]').getByRole('button',{name:'Select media',exact:true}).click();
  await pickerPage.locator('[data-media-id="90002"]').getByRole('button',{name:'Select media',exact:true}).click();
  await pickerPage.getByLabel('Paid message price',{exact:true}).fill('7.25');
  await pickerPage.screenshot({path:path.join(output,'04-dialog-picker.png')});
  await pickerPage.getByRole('button',{name:'ADD TO MESSAGE',exact:true}).click();
  await until(()=>Boolean(results.pickerApply),'Picker did not apply');assert.equal(results.pickerApply.ok,true,JSON.stringify(results.pickerApply));
  const mixed=await composerSnapshot();assert.equal(mixed.text,'Free follow-up');assert.equal(mixed.price,7.25);assert.equal(mixed.media.length,2);assert.deepEqual(mixed.free,['native-90001']);results.mixedComposer=mixed;
  pass('Dialog picker loads later folders, searches current metadata and applies mixed FREE/PAID through the same native composer');
  // A failed response after commit must not create a second script/version.
  await page.getByRole('button',{name:'Edit script',exact:true}).click();
  await page.getByLabel('Script title',{exact:true}).fill('Recovered media chain');loseSave=true;
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByRole('button',{name:'Recover',exact:true}).waitFor();
  const pending=libraryCommands.listPending();assert.equal(pending.length,1);openLibrary();
  await page.getByRole('button',{name:'Recover',exact:true}).click();
  await until(()=>libraryCommands.listPending().length===0,'Journal did not recover');
  await page.getByRole('button',{name:'Discard local edits',exact:true}).click();
  await page.getByRole('heading',{name:'Recovered media chain',exact:true}).waitFor();
  const after=(await library.listScripts({creatorId:c,includeTrash:true})).items;assert.equal(after.length,1);assert.equal(after[0].id,stored.id);assert.equal(after[0].title,'Recovered media chain');results.recovered=after[0];
  pass('Lost save response recovers from a reopened durable journal, preserves the current editor and creates no duplicate script');
  await page.getByRole('button',{name:'Trash message',exact:true}).first().click();
  await page.getByText('Deleted messages (1)',{exact:true}).click();await page.getByRole('button',{name:'Restore message',exact:true}).waitFor();await page.getByRole('button',{name:'Restore message',exact:true}).click();
  await until(async()=>await page.getByRole('button',{name:'Trash message',exact:true}).count()===2,'Block restore did not settle');
  await page.getByRole('button',{name:'Duplicate script',exact:true}).click();await until(async()=>(await library.listScripts({creatorId:c,includeTrash:true})).items.length===2,'Duplicate did not commit');
  await page.getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('button',{name:'Trash',exact:true}).click();await page.locator('.ml-script-row').first().click();
  await page.getByRole('button',{name:'Restore script',exact:true}).click();await page.getByText('Saved script',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('button',{name:'Trash',exact:true}).click();await page.locator('.ml-script-row').first().click();
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Delete permanently',exact:true}).click();await until(async()=>(await library.listScripts({creatorId:c,includeTrash:true})).items.length===1,'Permanent deletion did not settle');
  await page.getByLabel('Message Library model',{exact:true}).selectOption(creatorIds[1]);await page.getByRole('button',{name:'Active',exact:true}).click();await page.getByText('No scripts yet.',{exact:true}).waitFor();
  pass('Actual editor block/script trash, restore, duplicate and permanent delete; second creator has an isolated library');

  const settings=await must('GET','/api/settings/workspace');
  await f.manage('workspace.update','',{expectedRevision:settings.revision,vaultUploadRecipient:'fixture_relay'});
  const uploadPath=path.join(scratch,'controlled-upload.jpg');fs.writeFileSync(uploadPath,Buffer.alloc(16,3));
  const uploadInput={operationId:'acceptance-upload-'+require('node:crypto').randomUUID(),creatorId:c,recipient:'fixture_relay',items:[{clientMediaId:'acceptance-file-'+require('node:crypto').randomUUID(),listId:'101',listName:'Collection 001',filePath:uploadPath,fileName:'controlled-upload.jpg'}]};
  const uploaded=await vault.runLocalUploadForRenderer(uploadInput);assert.equal(uploaded.ok,true,JSON.stringify(uploaded));assert.equal(uploaded.completed,1);assert.equal(relays.length,1);assert.equal(transfers.length,1);
  const repeatedUpload=await vault.runLocalUploadForRenderer(uploadInput);assert.equal(repeatedUpload.ok,true,JSON.stringify(repeatedUpload));assert.equal(relays.length,1);assert.equal(new Set(transfers).size,1);
  results.upload={first:uploaded,repeated:repeatedUpload,preparationRequests:transfers.length,distinctPreparationIds:new Set(transfers).size,relaySends:relays.length};
  pass('Ordinary Vault upload relays and settles the requested folder once; exact retry retains preparation identity and sends no duplicate');
  // Catalog collection uses the current backend lease and SQLite worker runner.
  const heartbeat=()=>must('POST','/api/devices/heartbeat',{deviceId,accounts:creatorIds.map((creatorId,index)=>({creatorId,remoteId:String(100001+index),status:'READY',accessEpoch:1,sessionReadReady:true,sessionWriteReady:true,sessionProofEpoch:1,canonicalRevision:1,networkRevision:0,realtimeHealthy:true,wsConnected:true,lastWsFrameAt:new Date().toISOString()}))});
  await heartbeat();
  const scan=await vault.startUnsortedScan({creatorId:c,mode:'full'});assert.equal(scan.ok,true);if(scan.commandId)commands.acknowledge(scan.commandId);
  coordinator.start();worker.start();
  await until(async()=>{const state=await vault.getUnsortedState({creatorId:c});results.scan=state;return state.snapshot?.scan?.status==='COMPLETED';},'Vault scan did not publish',180000);
  const unsorted=await vault.listUnsortedMedia({creatorId:c,offset:0,limit:100});assert.equal(unsorted.ok,true);assert.equal(unsorted.total,43);results.unsorted=unsorted;
  pass('Actual Vault readonly worker scans every folder page and publishes the complete catalog with 43 unsorted media');
  // Controlled local usage snapshot: aggregate facts only, no raw chat history.
  const source={sourceKey:'opaque-local-dialog',sourceRevision:'2026-10-10T01:00:00.000Z',capturedAt:'2026-10-10T01:00:00.000Z',items:[{mediaId:'90002',sentCount:2,soldCount:1,notOpenedCount:1,freeCount:0,revenueCents:725,uniqueBuyers:1,lastSoldAt:'2026-10-10T01:00:00.000Z'}]};
  assert.equal((await mediaLibrary.replaceUsageSources(c,[source])).ok,true);
  assert.equal((await mediaLibrary.replaceUsageSources(c,[source])).ok,true);
  const sales=await mediaLibrary.getSalesSummary(c);assert.equal(sales.revenueCents,725);results.sales=sales;
  const otherSales=await mediaLibrary.getSalesSummary(creatorIds[1]);assert.equal(otherSales.revenueCents,0);
  const intelligence=await vault.getDirectoryIntelligence({creatorId:c,mediaIds:['90001','90002']});assert.equal(intelligence.ok,true);results.intelligence=intelligence;
  await page.evaluate(i=>ActualMedia.vault(i),mount);
  await until(async()=>await page.locator('.hq-vault-asset').count()>0,'Vault Dashboard did not display collected media');
  await page.getByRole('button',{name:'Load more folders',exact:true}).click();
  await page.getByRole('button',{name:/Collection 102/}).waitFor();
  await page.locator('.hq-vault-perf-row').filter({hasText:'asset sales'}).getByText('$7.25',{exact:true}).waitFor();
  results.vaultUiRevenue='$7.25';
  await page.screenshot({path:path.join(output,'05-vault-dashboard.png')});
  await page.getByRole('button',{name:/Edit info for/}).first().click();
  await page.locator('.hq-vault-editor-description').fill('Sunrise portrait updated in Vault');
  await page.getByRole('button',{name:'Save info',exact:true}).click();
  await until(async()=>{const row=(await mediaLibrary.getManyByMediaIds({creatorId:c,onlyfansMediaIds:['90001']})).items[0];return row?.description==='Sunrise portrait updated in Vault';},'Vault metadata editor did not commit');
  pass('Usage replay stays idempotent and creator-scoped; actual Vault Dashboard edits shared metadata with revision checks');
  await worker.stop();
  const killed=await f.stop('SIGKILL');assert.equal(killed.signal,'SIGKILL');await f.boot();publish();openLibrary();
  const recoveredLibrary=(await library.listScripts({creatorId:c,includeTrash:true})).items;assert.equal(recoveredLibrary.length,1);assert.equal(recoveredLibrary[0].title,'Recovered media chain');
  const recoveredSales=await mediaLibrary.getSalesSummary(c);assert.equal(recoveredSales.revenueCents,725);
  const afterRestart=await vault.getUnsortedState({creatorId:c});assert.equal(afterRestart.snapshot.scan.status,'COMPLETED');results.afterRestart={library:recoveredLibrary,sales:recoveredSales,scan:afterRestart};
  await page.evaluate(()=>ActualMedia.unmount());await page.evaluate(i=>ActualMedia.mount(i),mount);await page.getByRole('button',{name:/Recovered media chain/}).waitFor();
  pass('Backend SIGKILL and reopened command journal retain the script, catalog, metadata and aggregate sales');

  results.renderer={errors,calls,requests};results.provider={calls:providerCalls,externalWrites:0};
  assert.deepEqual(errors,[]);
 } finally {
  clearInterval(renewal);if(page)await page.screenshot({path:path.join(output,'last-screen.png')}).catch(()=>{});
  results.renderer={errors,calls,requests};results.provider={calls:providerCalls,externalWrites:0};
  if(sidecarPage){results.sidecarStatus=await sidecarPage.locator('.on-ml-status').textContent().catch(()=>null);await sidecarPage.screenshot({path:path.join(output,'last-sidecar.png')}).catch(()=>{});}
  if(composerPage)results.lastComposer=await composerPage.evaluate(()=>JSON.stringify(window.nativeComposer)).catch(()=>null);
  sidecar?.destroy();await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await worker.stop();await campaigns.prepareShutdown();await mediaLibrary.destroy();await vault.destroy();custom.destroy();await coordinator.destroy();
  globalThis.fetch=nativeFetch;fs.writeFileSync(path.join(output,'desktop-log.json'),JSON.stringify(logs,null,2));
 }
};
