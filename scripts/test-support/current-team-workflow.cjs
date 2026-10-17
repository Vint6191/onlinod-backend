"use strict";
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {createRequire} = require('node:module');

// Native window/IPC and provider observations are controlled boundaries. React,
// Desktop services, command journals, SQLite outbox, HTTP server and SQL are real.
exports.runTeam = async function runTeam(f) {
  const {modules:m, desktop, scratch, output, auth, api, agencyId, deviceId, creatorId:c, creatorIds, must, pass, results} = f;
  const load = createRequire(path.join(desktop,'package.json'));
  const runtime = createRequire(path.join(process.env.ONLINOD_BROWSER_RUNTIME || process.env.ONLINOD_SQL_PROOF_RUNTIME,'package.json'));
  const logs=[], calls=[], errors=[], requests=[], findings=[];
  const baseline = process.env.ONLINOD_TEAM_BASELINE === '1';
  const check = (condition, label) => { if (!condition) findings.push(label); if (!baseline) assert.ok(condition,label); };
  const log = Object.fromEntries(['debug','info','warn','error'].map(level=>[level,(...args)=>logs.push({level,args:args.map(x=>x instanceof Error?{message:x.message,code:x.code}:x)})]));
  const authStore = {...auth, readSession:()=>({...auth.readSession(),deviceId}), getDeviceId:()=>deviceId,
    getAuthorizationScopeHash:()=>agencyId+':'+deviceId, getActiveCreatorId:()=>c, onSessionChanged:()=>()=>{}};
  const authService = {ensureSession:async()=>({authenticated:true,session:authStore.readSession()})};
  const state = await must('GET','/api/team/state');
  const permissions = state.roles.find(r=>r.key==='owner').permissions;
  const catalog = await f.withDatabase((db,backendLoad)=>backendLoad('./src/services/creator-human-management-authority-service').currentCreatorCatalogGeneration({db,agencyId}));
  const authority = new m.DesktopCurrentAuthorizationAuthorityService({log,authStore,
    accessRuntime:{currentAuthorityProof:()=>({accessEpoch:1,creatorCatalogGeneration:catalog}),allowedCreatorIdsSnapshot:()=>creatorIds}});
  const publishAuthority = () => authority.publish({accessEpoch:1,creatorCatalogGeneration:catalog,role:'OWNER',roleKey:'owner',effectivePermissions:permissions,
    allowedCreatorIds:creatorIds,observedAt:Date.now(),observedAtMono:performance.now(),
    billing:{version:1,validForMs:90000,creators:creatorIds.map(creatorId=>({creatorId,allowed:true,validForMs:90000,reason:'TRIAL'}))}},'billing authority refresh',{renewUnchanged:true});
  publishAuthority();
  let loseAction=null, held=null, failRead=null;
  const serviceApi = {...api, request:async(url,options)=>{
    const result=await api.request(url,options);
    requests.push({url,action:options?.body?.action});
    if(loseAction && options?.body?.action===loseAction){loseAction=null;throw Object.assign(Error('Controlled response loss after commit'),{code:'NETWORK_ERROR'});}
    return result;
  }};
  const teamPath=path.join(scratch,'team-commands.json'), managementPath=path.join(scratch,'team-management.json');
  let teamCommands, managementCommands, admin, schedule, claims;
  const reopenCommands=()=>{
    teamCommands=new m.TeamCommandTransport(serviceApi,authStore,teamPath,async()=>f.actorProof,()=>{});
    managementCommands=new m.ManagementCommandTransport(serviceApi,authStore,managementPath,authority,()=>{});
    admin=new m.TeamAdministrationService(serviceApi,{ownerManagementProof:async()=>f.actorProof},authority,teamCommands);
    schedule=new m.TeamScheduleService(serviceApi,authority,teamCommands);
    claims=new m.TeamClaimsService(serviceApi,authority,managementCommands);
  };
  reopenCommands();
  const outboxPath=path.join(scratch,'team-outbox.sqlite');
  let analytics=new m.TeamAnalyticsService({log,authStore,authService,authorization:authority,outbox:new m.TeamActivityOutbox(outboxPath)});
  const unavailable=new Proxy({}, {get:(_target,key)=>()=>{throw Error('Unexpected external capability '+String(key));}});
  const customs=new m.CustomOrdersService(serviceApi,unavailable,unavailable,deviceId,{authorization:authority,
    ...Object.fromEntries(['telegramDeliveryDatabasePath','vaultDestinationIntentDatabasePath','deliveryConfirmationDatabasePath','nativeMassSettlementDatabasePath','pageWriteSettlementDatabasePath'].map(key=>[key,path.join(scratch,key+'.sqlite')]))});
  const handlers=()=>({...m.createTeamAdministrationHandlers(admin),...m.createTeamScheduleHandlers(schedule),...m.createTeamClaimsHandlers(claims),...m.createTeamAnalyticsHandlers(analytics,authority),
    'customOrders.getReferenceRecoveryQueue':input=>customs.getReferenceRecoveryQueue(input),
    'teamCommands.listPending':()=>teamCommands.listPending(),'teamCommands.acknowledge':i=>teamCommands.acknowledge(i.commandId),'teamCommands.retry':i=>teamCommands.retry(i.commandId),'teamCommands.cancel':i=>teamCommands.cancel(i.commandId),
    'managementCommands.listPending':()=>managementCommands.listPending(),'managementCommands.acknowledge':i=>managementCommands.acknowledge(i.commandId),'managementCommands.retry':i=>managementCommands.retry(i.commandId),'managementCommands.cancel':i=>managementCommands.cancel(i.commandId)});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(fn,label,timeout=30000)=>{const end=Date.now()+timeout;for(;;){try{if(await fn())return;}catch(error){if(!/DESKTOP_AUTHORIZATION_PERMIT_STALE/.test(error.code||error.message))throw error;}if(Date.now()>end)throw Error(label+'\n'+JSON.stringify({logs:logs.slice(-4),calls:calls.slice(-8)}));await wait(500);}};
  const hold=(method,match=()=>true)=>{let enter,release;const entered=new Promise(r=>enter=r),promise=new Promise(r=>release=r);held={method,match,enter,promise};return {entered,release};};
  let server,browser,page,renewal;
  try {
    renewal=setInterval(publishAuthority,30000);
    const renderer=path.join(desktop,'apps/desktop/renderer/src'),entry=path.join(scratch,'team-renderer.tsx'),script=path.join(scratch,'team-renderer.js');
    fs.writeFileSync(entry,`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{TeamAnalyticsWorkspace}from ${JSON.stringify(path.join(renderer,'features/team-analytics/TeamAnalyticsWorkspace.tsx'))};
import{acceptRendererAuthorizationProjection}from ${JSON.stringify(path.join(renderer,'shared/rpc/authorization-scope.ts'))};
import ${JSON.stringify(path.join(renderer,'styles.css'))};
let root,update;function App({input}){const[s,set]=useState(input);update=set;return <TeamAnalyticsWorkspace session={s.session}/>;}
export function mount(input){window.nod={events:{onDesktopAuthorizationEvent:()=>()=>{},onCreatorRuntimeEvent:()=>()=>{}},rpc:{call:async(method,payload)=>{const r=await window.actualRpc(method,payload);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result;}}};acceptRendererAuthorizationProjection(input.projection);root=createRoot(document.getElementById('root'));root.render(<React.StrictMode><App input={input}/></React.StrictMode>);}
export function context(input){acceptRendererAuthorizationProjection(input.projection);update(input);}
export function notify(domain){window.dispatchEvent(new Event(domain==='team'?'nod-team-pending-changed':'nod-management-pending-changed'));}`);
    await load('esbuild').build({entryPoints:[entry],outfile:script,bundle:true,platform:'browser',format:'iife',globalName:'ActualTeam',jsx:'automatic',nodePaths:[path.join(desktop,'node_modules')],alias:{'@nod/shared':path.join(desktop,'packages/shared/src/index.ts')},loader:{'.css':'css','.png':'dataurl','.svg':'dataurl'},define:{'process.env.NODE_ENV':'"development"'}});
    server=http.createServer((req,res)=>{const file=req.url==='/app.js'?script:req.url==='/app.css'?script.replace(/js$/,'css'):null;res.setHeader('Content-Type',file?file.endsWith('.js')?'application/javascript':'text/css':'text/html');res.end(file?fs.readFileSync(file):'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const chromiumModule=runtime('@sparticuz/chromium');
    const chromium=chromiumModule.default||chromiumModule;
    browser=await runtime('playwright').chromium.launch({executablePath:process.env.ONLINOD_CHROMIUM_PATH||await chromium.executablePath(),args:chromium.args,headless:true});
    page=await browser.newPage({viewport:{width:1536,height:1050}});page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.exposeFunction('actualRpc',async(method,input)=>{calls.push({method,input});try{
      if(failRead===method){failRead=null;throw Error('Controlled read unavailable');}
      const fn=handlers()[method];assert.ok(fn,'Unexpected RPC '+method);const result=await fn(input);
      if(held&&held.method===method&&held.match(input)){const gate=held;held=null;gate.enter();await gate.promise;}
      return{result};
    }catch(e){return{error:{message:e.message,code:e.code}};}});
    const input={session:{...authStore.readSession(),accessToken:undefined,refreshToken:undefined,permissions},projection:{ok:true,authenticated:true,current:true,quarantineState:'CURRENT',localAuthorizationRevision:1,session:{...authStore.readSession(),accessToken:undefined,refreshToken:undefined},creators:state.creators,activeCreatorId:c}};
    await page.goto(origin);await page.evaluate(i=>window.ActualTeam.mount(i),input);
    const view=name=>page.getByRole('navigation',{name:'Team Analytics views'}).getByRole('button',{name:new RegExp('^'+name+'(?: |$)')}).click();
    const tab=name=>page.locator('.taa-toolbar nav').getByRole('button',{name:new RegExp('^'+name,'i')}).click();
    await page.locator('.ta-hero').waitFor();await view('Team');await page.locator('.taa-member-row').waitFor();
    pass('Whole Team workspace mounts through current React, IPC, Desktop authority and actual server');

    // Invite created in the real UI, then actual registration/verification in the local server.
    await page.getByRole('button',{name:'＋ INVITE MEMBER',exact:true}).click();
    const invite=page.getByRole('dialog');
    await invite.getByPlaceholder('name@example.com').fill('team-member@example.test');await invite.getByPlaceholder('Marina').fill('Team member');
    await invite.locator('select').first().selectOption('chatter');
    await invite.getByText('model_one',{exact:true}).click();
    loseAction='invitation.create';await invite.getByRole('button',{name:'CREATE & COPY LINK',exact:true}).click();
    await page.getByText('Controlled response loss after commit',{exact:true}).waitFor();
    assert.equal(teamCommands.listPending().length,1);reopenCommands();
    await invite.getByRole('button',{name:'CANCEL',exact:true}).click();
    await page.getByRole('region',{name:'Pending actions'}).getByRole('button',{name:'Recover',exact:true}).click();
    const url=await page.getByLabel('Recovered invitation link').inputValue();assert.ok(url);assert.equal(teamCommands.listPending().length,0);
    const current=await admin.getState();assert.equal(current.invitations.length,1);
    const token=new URL(url,'https://local.invalid').searchParams.get('token')||url.split('/').at(-1);
    const email='team-member@example.test';
    await must('POST','/api/auth/register',{email,password:f.password,name:'Team member',inviteToken:token},201);
    const mail=JSON.parse(fs.readFileSync(f.mailbox,'utf8').trim().split('\n').at(-1));
    await must('POST','/api/auth/verify-email',{email,code:/Or use this code: (\d+)/.exec(mail.payload.text)[1]});
    let memberLogin=await must('POST','/api/auth/login',{email,password:f.password,deviceId:'team-member-device',authorizationScopeIncarnation:'team-member-session'});
    const memberId=memberLogin.activeMemberId,memberHeaders={Authorization:`Bearer ${memberLogin.accessToken}`};
    await must('GET',`/api/creators/${c}`,undefined,200,memberHeaders);await must('GET',`/api/creators/${creatorIds[1]}`,undefined,403,memberHeaders);
    await view('Overview');await view('Team');await page.locator('.taa-member-row').filter({hasText:email}).waitFor();
    pass('Invitation response loss -> journal reopened -> real Recover returns the same invite; member joins with one-creator scope');

    // Schedule mutation acknowledgement must not discard edits made during save.
    await view('Schedule');await page.getByRole('button',{name:'+ ADD SHIFT',exact:true}).click();
    let editor=page.getByRole('complementary',{name:'Create planned shift'});
    await editor.locator('select').selectOption(memberId);await editor.locator('.ts-creator-picker label').first().click();
    await editor.getByPlaceholder('Shift note…').fill('Team acceptance shift');
    const gate=hold('teamSchedule.createShift');await editor.getByRole('button',{name:'CREATE SHIFT',exact:true}).click();await gate.entered;
    check(await editor.getByPlaceholder('Shift note…').isDisabled(),'SHIFT_FIELDS_EDITABLE_DURING_COMMIT');
    if(baseline)await editor.getByPlaceholder('Shift note…').fill('New note while saving');
    gate.release();await editor.waitFor({state:'hidden'});
    const savedSchedule=await schedule.getWorkspace({rangeKey:'7d'});assert.equal(savedSchedule.shifts.length,1);results.shift=savedSchedule.shifts[0];
    assert.equal(results.shift.fulfillment,'UPCOMING');assert.equal(savedSchedule.summary.plannedSeconds,0,'A future shift must not reduce actual plan coverage');
    assert.ok(new Date(savedSchedule.planningRange.endAt)>new Date(results.shift.startsAt));
    if(baseline){findings.push('SHIFT_ACK_CLOSED_FORM_WITH_UNSUBMITTED_EDIT');results.baselineFindings=findings;return;}
    pass('Schedule create commits one revision and prevents unsaved input loss during delayed acknowledgement');

    const teamRun=async(action,target,payload)=>{const r=await teamCommands.execute(action,target,payload);teamCommands.acknowledge(r.commandId);return r;};
    const olderStart=new Date(Date.now()-14*86400000),olderEnd=new Date(+olderStart+3600000);
    await teamRun('shift.create','',{memberId,creatorIds:[c],startsAt:olderStart.toISOString(),endsAt:olderEnd.toISOString(),timezone:'UTC',note:'Older acceptance shift'});
    const period=key=>page.getByLabel('Performance analytics period').getByRole('button',{name:({'7D':'7 DAYS','30D':'30 DAYS'})[key]||key,exact:true}).click();
    const cancelGate=hold('teamSchedule.cancelShift');
    await page.getByTitle('Cancel shift',{exact:true}).click();await cancelGate.entered;
    await period('30D');await until(async()=>await page.locator('.ts-shift-row.cancelled').count()===1,'30-day schedule not loaded');
    const readCount=calls.filter(r=>r.method==='teamSchedule.getWorkspace').length;cancelGate.release();
    await until(()=>calls.filter(r=>r.method==='teamSchedule.getWorkspace').length>readCount,'Post-mutation reload missing');
    await until(async()=>await page.locator('.ts-shift-row.cancelled').count()===1,'Late cancellation replaced current schedule');
    assert.equal(calls.filter(r=>r.method==='teamSchedule.getWorkspace').at(-1).input.rangeKey,'30d');
    const current30d=await schedule.getWorkspace({rangeKey:'30d'});
    assert.equal(current30d.shifts.find(r=>r.id===results.shift.id).revision,2);
    await period('7D');await until(async()=>await page.locator('.ts-shift-row').count()===1,'Seven day schedule did not settle');
    failRead='teamSchedule.getWorkspace';await period('30D');await page.getByText('Schedule is unavailable',{exact:true}).waitFor();
    assert.equal(await page.locator('.ts-shift-row').count(),0,'Failed new period must not present old-period rows');
    await page.getByRole('button',{name:'TRY AGAIN',exact:true}).click();await until(async()=>await page.locator('.ts-shift-row').count()===current30d.shifts.length,'Schedule retry must restore the current retained range');
    pass('Shift cancel during period change reloads the current 30-day period; failed reads never relabel older-period rows');

    await f.withDatabase(async(db,backendLoad)=>{
      const {buildTeamSchedule}=backendLoad('./src/services/team-schedule-service');
      const now=new Date(),startsAt=new Date(+now-2*3600000),endsAt=new Date(+now-3600000);
      const previousCoverage=await db.teamProjectionCoverage.findUnique({where:{agencyId}});
      const detailFrom=new Date(+now-3*86400000);
      await db.teamProjectionCoverage.update({where:{agencyId},data:{responseCoverageFrom:detailFrom,dialogCoverageFrom:detailFrom}});
      const ownerId=authStore.readSession().activeMemberId;
      const ids=Array.from({length:1001},(_,i)=>'schedule-history-proof-'+i);
      const scopedId='schedule-scope-proof',upcomingId='schedule-upcoming-proof';
      const coverageId='schedule-hidden-coverage-proof';
      try {
        await db.teamShift.createMany({data:ids.map(id=>({id,agencyId,memberId,startsAt,endsAt,timezone:'UTC'}))});
        await db.teamShiftCreator.createMany({data:ids.map(shiftId=>({shiftId,creatorId:c,creatorRefId:c}))});
        await db.teamShift.create({data:{id:upcomingId,agencyId,memberId,startsAt:new Date(+now+3600000),endsAt:new Date(+now+2*3600000),creators:{create:{creatorId:c,creatorRefId:c}}}});
        const bounded=await buildTeamSchedule({db,agencyId,rangeKey:'7d',allowedCreatorIds:[c]});
        assert.equal(bounded.shifts.length,1000);assert.equal(bounded.detailCoverage.complete,false);
        assert.ok(bounded.shifts.some(row=>row.id===upcomingId),'Past detail limit must not hide upcoming work');
        assert.equal(bounded.summary.plannedShifts,1002,'Summary remains exact beyond the detail limit');
        await db.teamShift.deleteMany({where:{agencyId,id:{in:ids}}});
        await db.teamShift.create({data:{id:scopedId,agencyId,memberId:ownerId,startsAt,endsAt,creators:{create:creatorIds.map(creatorId=>({creatorId,creatorRefId:creatorId}))}}});
        await db.teamCoverageSession.create({data:{agencyId,creatorId:creatorIds[1],memberId:ownerId,coverageId,startedAt:startsAt,endedAt:endsAt,durationSeconds:3600}});
        const scoped=await buildTeamSchedule({db,agencyId,rangeKey:'7d',allowedCreatorIds:[c]});
        const all=await buildTeamSchedule({db,agencyId,rangeKey:'7d',allowedCreatorIds:null});
        assert.equal(scoped.shifts.find(row=>row.id===scopedId).actualPresenceSeconds,0,'Hidden creator coverage must not leak into a visible shift');
        assert.equal(scoped.summary.actualAgainstPlanSeconds,0);
        assert.equal(all.shifts.find(row=>row.id===scopedId).actualPresenceSeconds,3600);
        assert.equal(all.summary.actualAgainstPlanSeconds,3600);
      } finally {
        await db.teamCoverageSession.deleteMany({where:{agencyId,coverageId}});
        await db.teamShift.deleteMany({where:{agencyId,id:{in:[...ids,scopedId,upcomingId]}}});
        await db.teamProjectionCoverage.update({where:{agencyId},data:{responseCoverageFrom:previousCoverage.responseCoverageFrom,dialogCoverageFrom:previousCoverage.dialogCoverageFrom}});
      }
    });
    pass('SQL Schedule keeps upcoming work visible beyond 1000 historical shifts and excludes hidden creator coverage from detail and summary');

    await view('Team');await tab('ROLES');await page.locator('.taa-role-rail-head button').click();
    await page.getByPlaceholder('Senior Chatter').fill('Acceptance role');await page.locator('.taa-small-modal select').selectOption('chatter');
    await page.getByRole('button',{name:'CREATE ROLE',exact:true}).click();await page.locator('.taa-role-editor h2').getByText('Acceptance role',{exact:true}).waitFor();
    let adminState=await admin.getState(),role=adminState.roles.find(r=>r.label==='Acceptance role');assert.ok(role);
    const permission=adminState.permissionZones.flatMap(z=>z.permissions).find(p=>p.key==='money.claim');assert.ok(permission);
    const permissionRow=page.locator('.taa-permission-row').filter({has:page.getByText(permission.label,{exact:true})});
    const oldPending=hold('teamCommands.listPending');await page.evaluate(()=>window.ActualTeam.notify('team'));await oldPending.entered;
    loseAction='role.permission';await permissionRow.getByRole('button',{name:'DENY',exact:true}).click();
    await page.getByText('Controlled response loss after commit',{exact:true}).waitFor();
    await page.getByRole('region',{name:'Pending actions'}).getByRole('button',{name:'Recover',exact:true}).waitFor();
    oldPending.release();await wait(100);
    assert.equal(await page.getByRole('region',{name:'Pending actions'}).getByRole('button',{name:'Recover',exact:true}).count(),1,'Late empty pending read hid a committed command');
    assert.equal(errors.length,0,'Role errors must remain handled by the UI');reopenCommands();
    await page.getByRole('region',{name:'Pending actions'}).getByRole('button',{name:'Recover',exact:true}).click();
    await until(async()=>!(await admin.getState()).roles.find(r=>r.key===role.key).permissions['money.claim'],'Role denial did not persist');
    await tab('MEMBERS');await page.locator('.taa-member-row').filter({hasText:email}).click();
    const memberDrawer=page.locator('.taa-drawer');await memberDrawer.locator('select').selectOption(role.key);
    await memberDrawer.getByRole('button',{name:'SAVE CHANGES',exact:true}).click();await memberDrawer.waitFor({state:'hidden'});
    const changedContext=await must('GET','/api/team/claims/context',undefined,200,memberHeaders);
    assert.equal(changedContext.capabilities.claimOwn,false,'An existing token must use the new role permissions');
    await must('GET',`/api/creators/${creatorIds[1]}`,undefined,403,memberHeaders);
    memberLogin=await must('POST','/api/auth/login',{email,password:f.password,deviceId:'team-member-device',authorizationScopeIncarnation:'team-member-session-2'});
    memberHeaders.Authorization=`Bearer ${memberLogin.accessToken}`;
    const memberContext=await must('GET','/api/team/claims/context',undefined,200,memberHeaders);assert.equal(memberContext.capabilities.claimOwn,false);
    await must('POST','/api/team/commands/v2',f.command('role.permission',role.key,{permissionKey:'money.claim',value:true}),403,memberHeaders);
    pass('Role created and edited in UI; lost reply recovers, existing sessions receive current permissions and scope, member cannot elevate the role');

    // Main-process Team observations use an actual authorization permit and SQLite
    // outbox. Their physical provider/window provenance is a controlled boundary.
    const capture=authority.capturePermit('LOCAL_PROCESS',{creatorId:c});
    const human={version:1,creatorId:c,actorAgencyId:agencyId,actorMemberId:authStore.readSession().activeMemberId,actorUserId:authStore.readSession().user.id,
      authorizationScopeIncarnation:capture.authorizationScopeIncarnation,accessEpoch:capture.accessEpoch,creatorCatalogGeneration:capture.creatorCatalogGeneration,localAuthorizationRevision:capture.localAuthorizationRevision};
    const sentAt=new Date().toISOString();
    analytics.setWorkspaceCoverage(c,'acceptance_native_boundary');
    const action={kind:'MANUAL_MESSAGE_SEND_CONFIRMED',creatorId:c,fanId:'21001',dialogId:'21001',messageId:'99001',occurredAt:sentAt,priceCents:0,currency:'USD',mediaCount:0,mediaIds:[],webContentsId:1,requestId:'team-acceptance-send',authorizationCapture:human};
    analytics.handleNetworkAction(action);analytics.handleNetworkAction(action);await analytics.flush();
    analytics.endWorkspaceCoverage('acceptance_closed');await analytics.flush();
    await until(async()=>{results.teamSnapshot=await analytics.getSnapshot({rangeKey:'30d'});return results.teamSnapshot.overview.manualMessages===1;},'Manual message projection did not converge',60000);
    await view('Overview');await page.getByTitle('Refresh Team Analytics',{exact:true}).click();
    await until(async()=>await page.locator('.ta-hero-kpi').count()===0||await page.locator('.ta-hero').innerText().then(t=>t.includes('MANUAL MESSAGES')),'Team overview absent');
    await view('Chatters');await page.locator('.ta-chatter-cards').waitFor();
    await view('Content');await page.locator('.ta-team-content-page').waitFor();
    await until(()=>calls.some(r=>r.method==='teamAnalytics.getCustomReviewQueue')&&calls.some(r=>r.method==='teamAnalytics.getTelegramInboundReviewQueue'),'Content review reads missing');
    pass('Real SQLite Team outbox -> authorized ingest -> one manual contribution after duplicate observation; Overview, Chatters and Content read current server projections');

    // Canonical tips originate in a current financial job, not direct claim rows.
    await must('POST','/api/devices/heartbeat',{deviceId,accounts:[{creatorId:c,remoteId:'100001',status:'READY',accessEpoch:1,sessionReadReady:true,sessionWriteReady:true,sessionProofEpoch:1,canonicalRevision:1,networkRevision:0,runtimeReady:true}]});
    const operation=await managementCommands.executeOperation('financial',c,'start',{});managementCommands.acknowledge(operation.commandId);
    const claim=await must('POST','/api/jobs/claim',{deviceId,leaseMs:180000,jobKeys:['financial_transactions_scan'],capabilities:{creatorEventDrivenSyncV2:true,legacyStorageRetirementV1:true,financialWindowReceiptsV1:true,financialMoneyResolutionV1:true}});
    assert.ok(claim.job,JSON.stringify(claim));const job=claim.job;let continuation=job.continuation||{driverPhase:'execute',jobContinuation:null};
    const rawTransactions=[{id:'team-tip-one',descriptionDetails:{type:'tip'},amount:25,net:20,fee:5,currency:'USD',status:'done',createdAt:new Date(Date.parse(job.params.endDate)-1000).toISOString(),user:{id:'21001',username:'tip_fan'}}];
    const providerCalls=[];
    const ofApi={request:async input=>{assert.equal(input.endpoint.method,'GET');providerCalls.push(input.source);if(input.source.endsWith('.payouts'))return{ok:true,status:200,data:{list:rawTransactions,hasMore:false}};
      const category=input.source.split('.').at(-1),key=category==='messages'?'chat_messages':category,matched=category==='total'||category==='tips';return{ok:true,status:200,data:{[key]:{gross:matched?25:0,total:matched?20:0,count:matched?1:0}}};}};
    for(let step=0;step<10;step++){
      const chunk=await m.financialTransactionsHandler.runChunk({job,creatorId:c,continuation:continuation.jobContinuation,signal:new AbortController().signal,ofApi});
      const next=chunk.outcome==='done'?{driverPhase:'complete',result:chunk.result,progress:chunk.progress}:{driverPhase:'execute',jobContinuation:chunk.continuation};
      const response=await must('POST',`/api/jobs/${job.id}/progress`,{deviceId,leaseToken:job.leaseToken,leaseRevision:job.leaseRevision,expectedContinuation:continuation,continuation:next,chunkResult:chunk.chunkResult,progress:chunk.progress});
      continuation=response.lease.continuation;
      if(continuation.driverPhase==='complete'){await must('POST',`/api/jobs/${job.id}/complete`,{deviceId,leaseToken:job.leaseToken,leaseRevision:job.leaseRevision,result:continuation.result,progress:continuation.progress});break;}
    }
    assert.equal(continuation.driverPhase,'complete');results.financialProviderCalls=providerCalls;
    await until(async()=>{results.claimWorkspace=await claims.getWorkspace();return results.claimWorkspace.tips.length===1;},'Canonical tip reconciliation did not converge',60000);
    const tip=results.claimWorkspace.tips[0];assert.equal(tip.amountCents,2500);assert.equal(tip.status,'unresolved');
    await view('Claims');await page.locator('.tc-table tbody tr').filter({hasText:'$25.00'}).getByRole('button',{name:'REVIEW →',exact:true}).click();
    const claimDrawer=page.getByRole('complementary',{name:'Claim evidence and resolution'});
    await claimDrawer.getByLabel('ASSIGN TO').selectOption(memberId);await claimDrawer.getByPlaceholder('Required. Explain the evidence used for this decision.').fill('Acceptance evidence approved by owner');
    const oldManagementPending=hold('managementCommands.listPending');await page.evaluate(()=>window.ActualTeam.notify('management'));await oldManagementPending.entered;
    loseAction='claims.tip';await claimDrawer.getByRole('button',{name:'RESOLVE & WRITE AUDIT',exact:true}).click();
    await claimDrawer.getByText('Controlled response loss after commit',{exact:true}).waitFor();assert.equal(managementCommands.listPending().length,1);
    await page.getByRole('region',{name:'Pending management actions'}).getByRole('button',{name:'Recover',exact:true}).waitFor();oldManagementPending.release();await wait(100);
    assert.equal(await page.getByRole('region',{name:'Pending management actions'}).getByRole('button',{name:'Recover',exact:true}).count(),1);
    reopenCommands();await claimDrawer.getByRole('button',{name:'×',exact:true}).click();
    await page.getByRole('region',{name:'Pending management actions'}).getByRole('button',{name:'Recover',exact:true}).click();
    await until(()=>managementCommands.listPending().length===0,'Tip receipt not acknowledged');
    let audit=(await claims.getTipAudit({eventHash:tip.eventHash})).attribution;assert.equal(audit.attributedToMemberId,memberId);
    results.tipAudit=audit;
    await page.getByRole('button',{name:'ATTRIBUTED',exact:true}).click();await page.locator('.tc-table tbody tr').filter({hasText:'Team member'}).waitFor();
    const stale=f.command('claims.tip',tip.eventHash,{expectedUpdatedAt:tip.updatedAt,action:'manager_override',targetMemberId:null,reason:'Stale concurrent write'});
    await must('POST','/api/management/commands/v1',stale,409);
    pass('Actual financial handler and receipt job publish $25 tip; Claims assigns it through durable command, lost reply recovers once, stale version is rejected');

    const notificationStop=await managementCommands.executeOperation('notification',c,'stop',{});managementCommands.acknowledge(notificationStop.commandId);
    const notificationOp=await managementCommands.executeOperation('notification',c,'start',{});managementCommands.acknowledge(notificationOp.commandId);
    const notificationClaim=await must('POST','/api/jobs/claim',{deviceId,leaseMs:180000,jobKeys:['catchup_notifications_scan'],capabilities:{creatorEventDrivenSyncV2:true,legacyStorageRetirementV1:true}});
    assert.ok(notificationClaim.job,JSON.stringify(notificationClaim));const njob=notificationClaim.job;let nc=njob.continuation||{driverPhase:'execute',jobContinuation:null};
    const purchase={id:'notification-team-purchase',type:'purchased_message',messageId:'99002',amount:30,currency:'USD',createdAt:new Date(Date.parse(njob.params.to)-1000).toISOString(),user:{id:'21002',username:'ppv_fan'}};
    analytics.handleNetworkAction({...action,fanId:'21002',dialogId:'21002',messageId:'99002',requestId:'team-acceptance-ppv',priceCents:3000,mediaCount:1,mediaIds:['55001'],occurredAt:new Date(Date.parse(purchase.createdAt)-1000).toISOString()});await analytics.flush();
    const notificationProvider={request:async input=>{assert.equal(input.endpoint.method,'GET');const q=new URL(input.endpoint.path,'https://provider.invalid').searchParams;
      const type=q.get('type');const rows=(!type||type==='all'||/purchase|paid|earnings/i.test(type))&&!q.get('fromId')?[purchase]:[];return{ok:true,status:200,data:{list:rows,hasMore:false}};}};
    for(let step=0;step<12;step++){
      const chunk=await m.notificationsCatchupHandler.runChunk({job:njob,creatorId:c,continuation:nc.jobContinuation,signal:new AbortController().signal,ofApi:notificationProvider});
      const next=chunk.outcome==='done'?{driverPhase:'complete',result:chunk.result,progress:chunk.progress}:{driverPhase:'execute',jobContinuation:chunk.continuation};
      const response=await must('POST',`/api/jobs/${njob.id}/progress`,{deviceId,leaseToken:njob.leaseToken,leaseRevision:njob.leaseRevision,expectedContinuation:nc,continuation:next,chunkResult:chunk.chunkResult,progress:chunk.progress});nc=response.lease.continuation;
      if(nc.driverPhase==='complete'){await must('POST',`/api/jobs/${njob.id}/complete`,{deviceId,leaseToken:njob.leaseToken,leaseRevision:njob.leaseRevision,result:nc.result,progress:nc.progress});break;}
    }
    assert.equal(nc.driverPhase,'complete');
    await until(async()=>{results.ppvWorkspace=await claims.getWorkspace();return results.ppvWorkspace.ppv.length===1;},'Canonical PPV claim not reconciled',60000);
    await view('Overview');await view('Claims');await page.locator('.tc-filter-group.secondary').getByRole('button',{name:'ALL',exact:true}).click();await page.locator('.tc-table tbody tr').filter({hasText:'$30.00'}).getByRole('button',{name:'REVIEW →',exact:true}).click();
    await claimDrawer.getByRole('button',{name:'REOPEN CLAIM',exact:true}).click();await claimDrawer.waitFor({state:'hidden'});
    await page.locator('.tc-table tbody tr').filter({hasText:'$30.00'}).getByRole('button',{name:'REVIEW →',exact:true}).click();
    await claimDrawer.getByLabel('TEAM MEMBER').selectOption(memberId);await claimDrawer.getByPlaceholder('What did you verify, and why does this resolution follow the evidence?').fill('Purchase and team evidence checked');
    failRead='managementCommands.acknowledge';await claimDrawer.getByRole('button',{name:'RESOLVE & WRITE AUDIT',exact:true}).click();await claimDrawer.waitFor({state:'hidden'});
    assert.equal(managementCommands.listPending().length,1,'Lost local ACK must leave the committed result recoverable');
    await page.getByRole('region',{name:'Pending management actions'}).getByRole('button',{name:'Recover',exact:true}).click();await until(()=>managementCommands.listPending().length===0,'PPV acknowledgement did not recover');
    const ppv=(await claims.getWorkspace()).ppv[0];assert.equal(ppv.resolvedByMemberId,memberId);assert.equal(ppv.jobStatus,'resolved');assert.equal(ppv.audit.filter(row=>row.action==='assign').length,1);results.ppv=ppv;
    pass('Actual notification handler -> canonical PPV -> reopen and manager assignment in Claims; lost local acknowledgement recovers the same result');

    // Existing access must be removed while history and committed attribution stay.
    await view('Team');await page.locator('.taa-member-row').filter({hasText:email}).click();
    await page.locator('.taa-drawer').getByRole('button',{name:'DEACTIVATE',exact:true}).click();
    await page.locator('.taa-confirm-modal').getByRole('button',{name:'DEACTIVATE',exact:true}).click();
    await until(async()=>(await admin.getState()).members.find(r=>r.id===memberId).status==='deactivated','Member remained active');
    await must('GET',`/api/creators/${c}`,undefined,401,memberHeaders);await must('GET','/api/team/claims/context',undefined,401,memberHeaders);
    await must('POST','/api/team/commands/v2',f.command('shift.create','',{memberId,creatorIds:[c],startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),timezone:'UTC'}),401,memberHeaders);
    await f.stop('SIGKILL');await f.boot();reopenCommands();
    audit=(await claims.getTipAudit({eventHash:tip.eventHash})).attribution;assert.equal(audit.attributedToMemberId,memberId);
    assert.equal((await admin.getState()).members.find(r=>r.id===memberId).status,'deactivated');
    assert.equal((await schedule.getWorkspace({rangeKey:'30d'})).shifts.length,0,'Inactive member must leave the current operational schedule');
    results.retainedHistory=await f.withDatabase(async db=>({shifts:await db.teamShift.findMany({where:{agencyId,memberId},select:{id:true,status:true,revision:true}}),tip:await db.teamTipLedger.findFirst({where:{agencyId,eventHash:tip.eventHash},select:{attributedMemberId:true}})}));
    assert.equal(results.retainedHistory.shifts.length,2);assert.equal(results.retainedHistory.shifts.find(row=>row.id===results.shift.id).status,'CANCELLED');
    assert.equal(results.retainedHistory.tip.attributedMemberId,memberId);
    results.recovery={backendSIGKILL:true,teamJournalReopened:true,managementJournalReopened:true,tipAttributionPreserved:true};
    pass('UI deactivation denies old-token reads and writes immediately; server SIGKILL/restart retains attribution, audit, schedule and revocation');
    await page.screenshot({path:path.join(output,'team-administration.png'),fullPage:true});
    await view('Claims');await page.getByRole('button',{name:'ATTRIBUTED',exact:true}).click();await page.locator('.tc-table tbody tr').filter({hasText:'Team member'}).first().waitFor();
    await page.screenshot({path:path.join(output,'team-claims.png'),fullPage:true});
    await view('Team');await page.locator('.taa-member-row').first().waitFor();
    const staleAdmin=hold('teamAdmin.getState');await page.locator('.taa-toolbar .taa-icon-button').click();await staleAdmin.entered;
    clearInterval(renewal);authority.quarantine('Acceptance logout boundary');
    await page.evaluate(i=>window.ActualTeam.context(i),{session:null,projection:{ok:true,authenticated:false,current:false,quarantineState:'UNAUTHENTICATED',localAuthorizationRevision:100,session:null,creators:[],activeCreatorId:null}});
    await page.getByText('Team administration unavailable',{exact:true}).waitFor();staleAdmin.release();await wait(100);
    assert.equal(await page.locator('.taa-member-row').count(),0,'A late read restored old-principal administration');
    pass('Authorization context replacement clears Administration; a held old-principal read cannot restore members or access controls');
    results.memberId=memberId;results.memberEmail=email;
    assert.equal(errors.length,0,errors.join('\n'));
  } catch(error) {
    if(page&&!page.isClosed()) {
      results.failedUi=await page.locator('body').innerText().catch(()=>null);
      await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
    }
    throw error;
  } finally {
    clearInterval(renewal);await analytics.destroy();await customs.destroy();await browser?.close();if(server)await new Promise(r=>server.close(r));
    results.rendererRpcCalls=calls.length;results.rendererErrors=errors;results.desktopRequests=requests.length;
    fs.writeFileSync(path.join(output,'renderer.json'),JSON.stringify({calls,errors,findings,requests,logs},null,2));
  }
};
