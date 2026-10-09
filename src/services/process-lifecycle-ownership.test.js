"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const root=process.env.ONLINOD_LIFECYCLE_SOURCE || path.join(__dirname,'..');
const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function load(file,ports={},extra={}) {
 const timers=new Set();const timer=(fn,ms)=>{const t={fn,ms,unref(){}};timers.add(t);return t;};
 const context={module:{exports:{}},console,process:{env:{}},Promise,Date,Error,AggregateError,Map,Set,AbortController,AbortSignal,
  setImmediate,setTimeout:timer,setInterval:timer,clearTimeout:t=>timers.delete(t),clearInterval:t=>timers.delete(t),
  require(name){if(name in ports)return ports[name];if(name.startsWith('node:'))return require(name);throw Error('Uncontrolled port '+name);},...extra};
 vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});return {service:context.module.exports,timers};
}
test('Prisma import has no independent process signal owner',()=>{
 const signals=new EventEmitter();let disconnected=0;
 load('prisma.js',{'@prisma/client':{Prisma:{dmmf:{datamodel:{models:[{name:'CreatorAccount',fields:[{name:'sessionState'},{name:'networkProfile'}]}]}}},PrismaClient:class{async $disconnect(){disconnected++;}}}}, {process:Object.assign(signals,{env:{}})});
 signals.emit('SIGTERM');assert.equal(disconnected,0);assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);
});
test('diagnostics stop joins the already-running database commit and cancels every later tick',async()=>{
 const pending=deferred();let commits=0;
 const {service,timers}=load('services/admin-diagnostics-service.js',{'./db-commit-kernel':{runRootCommit(){commits++;return pending.promise;}}});
 const stop=service.startAdminDiagnostics({db:{},log:{warn(){}}});const stale=[...timers][0].fn;
 let done=false;const stopped=Promise.resolve(stop()).then(()=>done=true);await turn();const early=done;stale();pending.resolve({ok:true});await stopped;
 assert.equal(early,false);assert.equal(commits,1);assert.equal(timers.size,0);
});
function controls(){return load('services/desktop-control-events.js',{'./db-commit-kernel':{currentCommitContext:()=>null}});}
test('disconnected Desktop long poll releases its waiter and timer immediately',async()=>{
 const {service,timers}=controls(),controller=new AbortController();
 const pending=service.waitForDesktopControlEvents({agencyId:'a',signal:controller.signal}).then(()=>null,e=>e);
 assert.equal(timers.size,1);controller.abort();await turn();assert.equal(timers.size,0);
 assert.equal((await pending)?.code,'DESKTOP_CONTROL_CANCELLED');
});
test('server drain wakes all Desktop polls and refuses new waiters',async()=>{
 const {service,timers}=controls();const pending=['a','b'].map(agencyId=>service.waitForDesktopControlEvents({agencyId}).then(()=>null,e=>e));
 service.stopDesktopControlEvents();const errors=await Promise.all(pending);assert.ok(errors.every(e=>e.code==='BACKEND_STOPPING'));assert.equal(timers.size,0);
 await assert.rejects(service.waitForDesktopControlEvents({agencyId:'a'}),{code:'BACKEND_STOPPING'});
});
function gate({access=async()=>({status:'READY'}),billing=async()=>({}),durable=false,provider={}}={}){
 const calls=[];
 const db={workerDevice:{findFirst:async()=>({id:'device',agencyId:'a',lastSeenAt:new Date()})},deviceCreatorBinding:{findFirst:async()=>({id:'binding'})}};
 if(durable){db.$transaction=()=>{};db.$queryRawUnsafe=()=>{};}
 const ports={
  '../prisma':db,'./billing-execution-access-service':{assertProviderBillingAccess:billing},
  '../middleware/automation-permissions':{requireCreatorAccess:access},'./db-time-authority-service':{dbAuthorityNow:async()=>new Date()},
  './capability-freshness-authority-service':{capabilityFreshnessWindow:()=>({gte:new Date(0),lte:new Date(Date.now()+60000)})},
  './provider-request-credit-authority-service':{PROVIDER_GATE_PERMIT_TTL_MS:10000,PROVIDER_GATE_WAITER_LEASE_MS:15000,PROVIDER_GATE_WAITER_HEARTBEAT_MS:3000,PROVIDER_GATE_FAIRNESS_GENERATION:'g',
   readProviderGateFairnessAuthority:async()=>({activationState:'ACTIVE'}),registerDurableProviderWaiter:async()=>{},
   tryAcquireDurableProviderPermit:async()=>({granted:true,grantedAt:new Date(),expiresAt:new Date(Date.now()+10000),intervalMs:700}),
   cancelDurableProviderWaiter:async()=>{calls.push('cancel-waiter');},cancelDurableProviderPermit:async()=>{calls.push('cancel-permit');},
   heartbeatDurableProviderWaiters:async()=>{},...provider},
 };
 const f=load('services/of-request-gate-service.js',ports);return {...f,calls,input:{userId:'u',agencyId:'a',member:{},deviceId:'device',creatorId:'c',capability:'read'}};
}
test('gate shutdown fences an acquire still verifying access',async()=>{
 const pending=deferred();const f=gate({access:()=>pending.promise});const acquired=f.service.acquireOfRequestSlot(f.input).then(()=>null,e=>e);
 const stopped=f.service.stopOfRequestGate();pending.resolve({status:'READY'});await stopped;assert.equal((await acquired).code,'BACKEND_STOPPING');assert.equal(f.service.getOfRequestGateSnapshot().queued,0);
});
test('cancellation during final billing recheck revokes an undelivered permit',async()=>{
 const pending=deferred();let billing=0;const controller=new AbortController();
 const f=gate({durable:true,billing:async()=>{if(++billing===2)await pending.promise;return{};}});
 const acquired=f.service.acquireOfRequestSlot({...f.input,signal:controller.signal}).then(()=>null,e=>e);await turn();await turn();
 assert.equal(billing,2);controller.abort();pending.resolve();await acquired;await turn();
 assert.equal(f.calls.includes('cancel-permit'),true);assert.equal(f.service.getOfRequestGateSnapshot().activePermit,null);
});
test('gate drain retains the late durable registration until its cancellation finishes',async()=>{
 const registered=deferred(),entered=deferred(),cancelled=deferred();let grants=0;
 const f=gate({durable:true,provider:{registerDurableProviderWaiter:()=>{entered.resolve();return registered.promise;},cancelDurableProviderWaiter:async()=>{f.calls.push('cancel-waiter');await cancelled.promise;},tryAcquireDurableProviderPermit:async()=>{grants++;return{granted:false,retryAt:new Date()};}}});
 const acquired=f.service.acquireOfRequestSlot(f.input).then(()=>null,e=>e);await entered.promise;let done=false;const stop=f.service.stopOfRequestGate().then(()=>done=true);
 registered.resolve();await turn();assert.equal(done,false);assert.equal(grants,0);assert.equal(f.calls.includes('cancel-waiter'),true);
 cancelled.resolve();await stop;assert.equal((await acquired).code,'BACKEND_STOPPING');assert.equal(f.timers.size,0);
});
test('a delivered permit is not revoked by process drain because transport may have started',async()=>{
 const f=gate({durable:true});const granted=await f.service.acquireOfRequestSlot(f.input);assert.ok(granted.permitId);
 await f.service.stopOfRequestGate();assert.equal(f.calls.includes('cancel-permit'),false);assert.equal(f.timers.size,0);
});
