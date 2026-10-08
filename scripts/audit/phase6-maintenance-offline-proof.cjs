"use strict";
// Offline only. PostgreSQL WASM memory/file fixtures; never reads DATABASE_URL.
// ONLINOD_PGLITE_MODULE=/path/to/@electric-sql/pglite node --test scripts/audit/phase6-maintenance-offline-proof.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PGlite } = require(process.env.ONLINOD_PGLITE_MODULE || '@electric-sql/pglite');
const admission = require('../../src/services/phase2-maintenance-admission-service');
const lanes = admission.MAINTENANCE_LANE_NAMES;
const ROOT = path.resolve(__dirname,'../..');
const migration = fs.readFileSync(path.join(ROOT,'prisma/migrations/20260929154000_phase6_maintenance_progress_v1/migration.sql'),'utf8')
  + ['20261001000000_analytics_publication_authority_v1','20261001113000_campaign_read_projection_v1'].map(name => {
    const sql=fs.readFileSync(path.join(ROOT,'prisma/migrations',name,'migration.sql'),'utf8');
    return '\nBEGIN;\n'+sql.slice(sql.indexOf('INSERT INTO "MaintenanceAdmissionClassState"'));
  }).join('\n')
  + fs.readFileSync(path.join(ROOT,'prisma/migrations/20261004220000_maintenance_registry_v4/migration.sql'),'utf8')
  + fs.readFileSync(path.join(ROOT,'prisma/migrations/20261005001000_external_delivery_maintenance_v5/migration.sql'),'utf8');
const scheduler = fs.readFileSync(path.join(ROOT,'src/services/job-scheduler.js'),'utf8');
function adapter(pg,{rollback=false}={}) {
 let transactionOpen=false;const trace=[];
 const db={$transaction:async(work)=>pg.transaction(async(client)=>{
   transactionOpen=true;
   const tx={
    $executeRawUnsafe:async(sql,...params)=>{trace.push(sql);return (await client.query(sql,params)).affectedRows||0;},
    $queryRawUnsafe:async(sql,...params)=>{trace.push(sql);return (await client.query(sql,params)).rows;},
   };
   try{const r=await work(tx);if(rollback)throw Error('controlled rollback after SQL advance');return r;}
   finally{transactionOpen=false;}
 })};
 return {db,trace,get transactionOpen(){return transactionOpen;}};
}
async function fixture(t) {
 const pg=new PGlite();await pg.waitReady;t.after(()=>pg.close());await pg.exec(migration);
 const fx=adapter(pg);
 return {pg,...fx,adapter:fx,select:(extra={})=>admission.selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes,...extra}),counts:async()=>(await pg.query('SELECT "laneName","turnCount" FROM "MaintenanceAdmissionClassState" WHERE generation=\'phase6_maintenance_registry_v5\' ORDER BY "ordinal"')).rows};
}
function pumpHarness(db,invoke) {
 require.cache[path.join(ROOT,'src/prisma.js')]={exports:db};
 const registry=require('../../src/services/maintenance-lane-registry');
 const {createRequire}=require('node:module');
 const load=createRequire(path.join(ROOT,'src/services/maintenance-lane-registry.js'));
 registry.resolveMaintenanceLanes({db}); // Real exports must exist before stubbing business effects.
 const pump=require('../../src/services/job-scheduler').runPhase2MaintenancePump;
 return args=>{
   const restore=[];
   try {
     for(const lane of registry.MAINTENANCE_LANES){
       const module=load(lane.module),original=module[lane.method];
       restore.push(()=>{module[lane.method]=original;});
       module[lane.method]=()=>invoke(lane.name);
     }
     return pump(args); // The actual resolver binds every callback before its first await.
   } finally {restore.reverse().forEach(run=>run());}
 };
}
async function restartWorker() {
 const directory=process.argv[3], initialize=process.argv[4]==='initialize';
 if(!directory||!path.isAbsolute(directory))throw Error('absolute disposable fixture directory required');
 const pg=new PGlite(directory);await pg.waitReady;
 try{
  if(initialize)await pg.exec(migration);
  const fx=adapter(pg);const r=await admission.selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes});
  process.stdout.write(JSON.stringify({selected:r.selected,turns:r.turns}));
 }finally{await pg.close();}
}
function registerTests(){
 test('C1 SQL + actual pump: a failed class stays degraded across other batches until its own retry succeeds',async(t)=>{
  const fx=await fixture(t);let failed=false;
  const pump=pumpHarness(fx.db,async name=>{
   if(name==='notificationHistoryRepair'&&!failed){failed=true;throw Object.assign(Error('controlled repair failure'),{code:'NOTIFICATION_HISTORY_CURSOR_INVALID'});}
   return{ok:true};
  });
  const scheduler=require('../../src/services/job-scheduler');
  for(let i=0;i<Math.ceil(lanes.length/5);i++){
   const result=await pump({db:fx.db});scheduler._test.handleMaintenanceTickResult(result);
   assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.status,'DEGRADED');
   assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.lastReason,'notificationHistoryRepair:NOTIFICATION_HISTORY_CURSOR_INVALID');
  }
  const retry=await pump({db:fx.db});assert.equal(retry.notificationHistoryRepair.ok,true);
  scheduler._test.handleMaintenanceTickResult(retry);
  assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.status,'HEALTHY');
 });
 test('C1 SQL: same timestamp and 55s alias cannot starve every registered class',async(t)=>{
  const fx=await fixture(t);const seen=new Set();
  for(let i=0;i<100;i++){
   const r=await fx.select({now:new Date(i%2?0:i*55000),intervalMs:5000});
   assert.equal(r.selected.length,5);assert.equal(new Set(r.selected).size,5);
   r.selected.forEach(n=>seen.add(n));if(i===Math.ceil(lanes.length/5)-1)assert.equal(seen.size,lanes.length);
  }
  const counts=(await fx.counts()).map(r=>Number(r.turnCount));
  assert.equal(seen.size,lanes.length);assert.equal(counts.reduce((a,b)=>a+b,0),500);assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
  const diagnostics=await admission.readMaintenanceAdmissionProgress({db:{$queryRawUnsafe:async(sql,...params)=>(await fx.pg.query(sql,params)).rows}});
  assert.equal(diagnostics.minimumTurns,String(Math.floor(500/lanes.length)));assert.equal(diagnostics.maximumTurns,String(Math.ceil(500/lanes.length)));assert.equal(diagnostics.spread,'1');assert.equal(diagnostics.readOnly,true);

 });
 test('C1 SQL: 100 fresh client wrappers share progress (serialized WASM backend)',async(t)=>{
  const fx=await fixture(t);const all=await Promise.all(Array.from({length:100},()=>{
   const client=adapter(fx.pg);return admission.selectPhase2MaintenanceLanes({db:client.db,laneNames:lanes});
  }));
  assert.equal(new Set(all.flatMap(r=>r.selected)).size,lanes.length);
  assert.ok(all.every(r=>r.selected.length===5&&new Set(r.selected).size===5));
  assert.equal((await fx.counts()).reduce((n,r)=>n+Number(r.turnCount),0),500);
 });
 test('C1 SQL: process restart continues file-backed committed progress',async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'onlinod-phase6-c1-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const run=promisify(execFile);const first=JSON.parse((await run(process.execPath,[__filename,'--restart-worker',directory,'initialize'],{env:process.env,maxBuffer:1024*1024})).stdout);
  const second=JSON.parse((await run(process.execPath,[__filename,'--restart-worker',directory,'continue'],{env:process.env,maxBuffer:1024*1024})).stdout);
  assert.deepEqual(first.selected,lanes.slice(0,5));assert.deepEqual(second.selected,lanes.slice(5,10));
 });
 test('C1 SQL: rollback after advancing rows restores the same next offers',async(t)=>{
  const fx=await fixture(t);const bad=adapter(fx.pg,{rollback:true});
  await assert.rejects(admission.selectPhase2MaintenanceLanes({db:bad.db,laneNames:lanes}),/controlled rollback/);
  assert.ok((await fx.counts()).every(r=>Number(r.turnCount)===0));assert.deepEqual((await fx.select()).selected,lanes.slice(0,5));
 });
 test('C1 SQL: an abandoned committed offer does not suppress a class forever',async(t)=>{
  const fx=await fixture(t);const abandoned=await fx.select();const seen=new Set();
  for(let i=0;i<9;i++)(await fx.select()).selected.forEach(n=>seen.add(n));
  assert.ok(abandoned.selected.every(n=>seen.has(n)));assert.equal(seen.size,lanes.length);
 });
 test('C1 actual pump: callback executes after admission transaction; failure does not reset fairness',async(t)=>{
  const fx=await fixture(t);const called=[];
  const pump=pumpHarness(fx.db,async(name)=>{assert.equal(fx.adapter.transactionOpen,false);called.push(name);throw Error('controlled lane failure');});
  for(let i=0;i<Math.ceil(lanes.length/5);i++){const r=await pump({db:fx.db,now:new Date(i*55000)});assert.equal(r.ok,false);assert.equal(r.admission.selected.length,5);}
  assert.equal(new Set(called).size,lanes.length);assert.equal(called.length,Math.ceil(lanes.length/5)*5);
 });
 test('C1 actual pump: local overlap skips; a separate replica still advances progress',async(t)=>{
  const fx=await fixture(t);let started,finish;
  const entered=new Promise(r=>{started=r;});const held=new Promise(r=>{finish=r;});let first=true;const called=[];
  const pump=pumpHarness(fx.db,async(name)=>{called.push(name);if(first){first=false;started();await held;}return{ok:true};});
  const running=pump({db:fx.db});await entered;
  const overlap=await pump({db:fx.db});assert.equal(overlap.reason,'local_overlap');
  const replica=await fx.select();assert.deepEqual(replica.selected,lanes.slice(5,10));
  finish();assert.equal((await running).ok,true);assert.deepEqual(called,lanes.slice(0,5));
 });
 test('C1 actual pump: catalog failure invokes no work and releases local overlap guard',async(t)=>{
  const fx=await fixture(t);let called=0;const pump=pumpHarness(fx.db,async()=>{called++;return{ok:true};});
  await fx.pg.query('DELETE FROM "MaintenanceAdmissionClassState" WHERE "laneName"=$1',[lanes[0]]);
  await assert.rejects(pump({db:fx.db}),{code:'MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH'});assert.equal(called,0);
  await fx.pg.query('INSERT INTO "MaintenanceAdmissionClassState" (generation,"laneName",ordinal) VALUES ($1,$2,0)',[admission.MAINTENANCE_ADMISSION_GENERATION,lanes[0]]);
  assert.equal((await pump({db:fx.db})).ok,true);assert.equal(called,5);
 });
 test('C1 SQL: counts above Number.MAX_SAFE_INTEGER retain exact fairness and JSON diagnostics',async(t)=>{
  const fx=await fixture(t);await fx.pg.exec('UPDATE "MaintenanceAdmissionClassState" SET "turnCount"=9007199254740993');
  const r=await fx.select();assert.deepEqual(r.selected,lanes.slice(0,5));assert.equal(r.turns[0].turn,'9007199254740994');assert.doesNotThrow(()=>JSON.stringify(r));
  assert.deepEqual((await fx.select()).selected,lanes.slice(5,10));
 });
 test('C1 SQL: bounded progress selection has an indexed path; schema catalog matches code',async(t)=>{
  const fx=await fixture(t);await fx.pg.exec('SET enable_seqscan=off');
  const plan=await fx.pg.query(`EXPLAIN (FORMAT JSON) SELECT "laneName" FROM "MaintenanceAdmissionClassState" WHERE generation=$1 ORDER BY "turnCount",ordinal LIMIT 5 FOR UPDATE SKIP LOCKED`,[admission.MAINTENANCE_ADMISSION_GENERATION]);
  assert.match(JSON.stringify(plan.rows),/MaintenanceAdmissionClassState_turn_idx/);
  assert.deepEqual((await fx.counts()).map(r=>r.laneName),lanes);
  assert.ok(!fx.adapter.trace.some(sql=>/DomainWorkItem|JobInstance|MaintenanceLaneState/.test(sql)));
 });
}
if(process.argv[2]==='--restart-worker')restartWorker().catch(e=>{console.error(e);process.exitCode=1;});else registerTests();
