'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function schedulerHarness(){
 const source=fs.readFileSync(path.join(__dirname,'job-scheduler.js'),'utf8');
 const timers=new Map(),cleared=[],calls=[];let id=0;
 const recurring=deferred(),maintenance=deferred(),demand=deferred(),campaign=deferred();
 const context={console:{log(){},warn(){},error(){}},Promise,Date,prisma:{},
  RECURRING_INTERVAL_MS:3600000,ANALYTICS_DEMAND_INTERVAL_MS:15000,PHASE2_MAINTENANCE_PUMP_INTERVAL_MS:5000,
  recurringSweepPromise:null,phase2MaintenancePromise:null,
  setTimeout(fn,delay){const key=++id;timers.set(key,{fn,delay,type:'initial'});return key;},
  setInterval(fn,delay){const key=++id;timers.set(key,{fn,delay,type:'interval'});return key;},
  clearTimeout(key){cleared.push(key);timers.delete(key);},clearInterval(key){cleared.push(key);timers.delete(key);},
  handleRecurringSweepTickResult(){},handleAnalyticsDemandTickResult(){},handleMaintenanceTickResult(){},
  runRecurringSweep(){calls.push('recurring');context.recurringSweepPromise=recurring.promise;return recurring.promise;},
  runPhase2MaintenancePump(){calls.push('maintenance');context.phase2MaintenancePromise=maintenance.promise;return maintenance.promise;},
  runAnalyticsCollectionDemandSweep(){calls.push('demand');return demand.promise;},
  require(name){if(name==='./maintenance-lane-registry')return{resolveMaintenanceLanes(){calls.push('validate');}};
   if(name==='./campaign-projection-executor')return{startCampaignProjectionExecutor(){return{stop(){calls.push('campaign-stop');return campaign.promise;}};}};throw Error(name);},
 };
 vm.runInNewContext(source.slice(source.indexOf('let recurringTimer = null;'),source.indexOf('\n\nmodule.exports = {'))+'\nglobalThis.start=startRecurringScheduler;globalThis.stop=stopRecurringScheduler;',context);
 return{context,timers,cleared,calls,recurring,maintenance,demand,campaign};
}
test('scheduler cancels all initial/periodic timers and rejects stale callbacks after restart',async()=>{
 const h=schedulerHarness();h.context.start();assert.equal(h.timers.size,6);const stale=[...h.timers.values()].map(t=>t.fn);
 const stopped=h.context.stop();assert.equal(h.timers.size,0);assert.equal(h.cleared.length,6);
 stale.forEach(fn=>fn());assert.deepEqual(h.calls,['validate','campaign-stop']);
 assert.throws(()=>h.context.start(),/SCHEDULER_STOPPING/);h.campaign.resolve();await stopped;
 h.context.start();stale.forEach(fn=>fn());assert.deepEqual(h.calls,['validate','campaign-stop','validate']);await h.context.stop();
});
test('scheduler stop is idempotent and drains recurring, maintenance, demand and campaign before resolving',async()=>{
 const h=schedulerHarness();h.context.start();
 for(const t of h.timers.values())if(t.type==='initial')t.fn();
 assert.deepEqual(h.calls,['validate','recurring','demand','maintenance']);
 const stopping=h.context.stop();assert.equal(h.context.stop(),stopping);let finished=false;stopping.then(()=>finished=true);
 h.recurring.resolve({ok:true});h.maintenance.resolve({ok:true});h.demand.resolve({ok:true});await Promise.resolve();await Promise.resolve();assert.equal(finished,false);
 h.campaign.resolve();await stopping;assert.equal(finished,true);
});
test('campaign executor stop waits for running commit and never schedules another round',async()=>{
 const {startCampaignProjectionExecutor}=require('./campaign-projection-executor');const work=deferred(),scheduled=[];
 const executor=startCampaignProjectionExecutor({run:()=>work.promise,schedule:fn=>{scheduled.push(fn);return scheduled.length;},cancel(){}});
 const running=scheduled[0]();let stopped=false;const stop=executor.stop().then(()=>stopped=true);
 await Promise.resolve();assert.equal(stopped,false);work.resolve({ok:true,processed:1});await running;await stop;assert.equal(scheduled.length,1);assert.equal(executor.snapshot().running,false);
});
function serverHarness({brokenStop=false,badExternal=false}={}){
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const ready=deferred(),drain=deferred(),calls=[],signals={};let close;
 const context={Promise,console:{error(...args){calls.push(['error',...args]);},warn(){}},
  process:{env:{},once(name,fn){signals[name]=fn;},exit(code){calls.push(['exit',code]);}},
  logger:{info(){},warn(){}},prisma:{$disconnect:async()=>{calls.push('disconnect');}},
  app:{listen(){calls.push('listen');return{close(fn){close=fn;calls.push('close');}};}},
  startRecurringScheduler(){calls.push('scheduler-start');return()=>{calls.push('scheduler-stop');return drain.promise;};},
  setTimeout(){return{unref(){}};},clearTimeout(){},
  require(name){
   if(name==='./services/external-delivery-runtime-contract')return{verifyExternalDeliveryRuntime:async()=>{if(badExternal)throw Error("EXTERNAL_DELIVERY_PHYSICAL_GUARD_REQUIRED");}};
   if(name==='./services/maintenance-runtime-contract')return{verifyMaintenanceRuntime(){calls.push('verify');return ready.promise;}};
   const method=name.includes('dialog-module')?'startDialogControlWorker':name.includes('auth-mail')?'startAuthMailWorker':'startAdminDiagnostics';
   return{[method](){return()=>{calls.push(method+'-stop');if(brokenStop&&method==='startAdminDiagnostics')throw Error('controlled stop failure');};}};
  },
 };
 vm.runInNewContext(source.slice(source.indexOf('const port = Number(process.env.PORT')),context);
 return{ready,drain,calls,signals,close:()=>close()};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('server does not listen or start workers until runtime verification succeeds',async()=>{
 const h=serverHarness();await turn();assert.deepEqual(h.calls,['verify']);h.ready.resolve({ready:true});await turn();assert.deepEqual(h.calls,['verify','scheduler-start','listen']);
 h.signals.SIGTERM();h.signals.SIGINT();assert.equal(h.calls.filter(x=>x==='scheduler-stop').length,1);h.close();await turn();assert.ok(!h.calls.includes('disconnect'));
 h.drain.resolve();await turn();assert.equal(h.calls.at(-2),'disconnect');assert.deepEqual(h.calls.at(-1),['exit',0]);
});
test('bad runtime catalog fails startup before listen, no maintenance loop crashes after a green start',async()=>{
 const h=serverHarness();await turn();h.ready.reject(Error('MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH'));await turn();assert.ok(!h.calls.includes('listen'));assert.ok(!h.calls.includes('scheduler-start'));assert.equal(h.calls.at(-2),'disconnect');assert.deepEqual(h.calls.at(-1),['exit',1]);
});
test('maintenance degradation appears in the actual scheduler health snapshot and recovers',()=>{
 require.cache[require.resolve('../prisma')]={exports:{}};
 const scheduler=require('./job-scheduler');scheduler._test.handleMaintenanceTickResult(null,Object.assign(Error('catalog'),{code:'MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH'}));
 assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().status,'DEGRADED');assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.status,'DEGRADED');
 scheduler._test.handleMaintenanceTickResult({ok:true});assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.status,'HEALTHY');
});

test('one synchronous worker stop failure does not prevent other drains or Prisma disconnect',async()=>{
 const h=serverHarness({brokenStop:true});h.ready.resolve({ready:true});await turn();h.signals.SIGTERM();h.close();
 assert.ok(h.calls.includes('startAuthMailWorker-stop'));assert.ok(h.calls.includes('startDialogControlWorker-stop'));
 await turn();assert.ok(!h.calls.includes('disconnect'));h.drain.resolve();await turn();
 assert.equal(h.calls.at(-2),'disconnect');assert.deepEqual(h.calls.at(-1),['exit',1]);
});

test('missing external-delivery guard fails startup before maintenance or listen',async()=>{
 const h=serverHarness({badExternal:true});await turn();assert.ok(!h.calls.includes('verify'));assert.ok(!h.calls.includes('listen'));assert.equal(h.calls.at(-2),'disconnect');assert.deepEqual(h.calls.at(-1),['exit',1]);
});
