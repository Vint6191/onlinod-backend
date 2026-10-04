"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectPhase2MaintenanceLanes, validateMaintenanceLaneNames, MAINTENANCE_LANE_NAMES: lanes, MAINTENANCE_ADMISSION_GENERATION } = require("./phase2-maintenance-admission-service");

// Query-boundary fixture, not a PostgreSQL contention emulator. Real SQL lives
// in scripts/audit/phase6-maintenance-offline-proof.cjs.
function fixture({catalog = lanes.map((laneName,ordinal)=>({laneName,ordinal})), selected = null}={}) {
 const calls=[];let committed=false;let advanced=false;
 const tx={
  async $executeRawUnsafe(){return 1;},
  async $queryRawUnsafe(sql,...params){
   calls.push({sql,params});
   if(/SELECT "laneName","ordinal"/.test(sql))return catalog;
   if(/WITH candidates/.test(sql)){advanced=true;return selected ?? lanes.slice(0,params[1]).map((laneName,ordinal)=>({laneName,ordinal,turnCount:1n,lastAdmittedAt:new Date(0)}));}
   throw Error('unexpected query');
  },
 };
 const db={async $transaction(work){const r=await work(tx);committed=true;return r;}};
 return {db,calls,get committed(){return committed;},get advanced(){return advanced;}};
}

test("C1 admission has a hard per-pump budget and stable registered catalog",async()=>{
 const fx=fixture();const r=await selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes,lanesPerTick:1000000});
 assert.equal(r.selected.length,5);assert.equal(r.lanesPerTick,5);assert.equal(r.totalLanes,lanes.length);assert.equal(r.generation,MAINTENANCE_ADMISSION_GENERATION);assert.equal(fx.committed,true);
 assert.equal(fx.calls[0].params[1],65);assert.equal(fx.calls[1].params[1],5);
});
test("C1 admission does not require or use wall-clock phase",async()=>{
 const fx=fixture();const r=await selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes,now:new Date(NaN),intervalMs:0});
 assert.equal(r.selected.length,5);assert.deepEqual(fx.calls[1].params,[MAINTENANCE_ADMISSION_GENERATION,5]);
});
test("C1 runtime catalog mismatch rejects before opening a transaction",async()=>{
 let opened=false;const db={$transaction:async()=>{opened=true;}};
 await assert.rejects(selectPhase2MaintenanceLanes({db,laneNames:lanes.slice(1)}),{code:'MAINTENANCE_ADMISSION_CATALOG_MISMATCH'});assert.equal(opened,false);
 assert.throws(()=>validateMaintenanceLaneNames([...lanes.slice(1),lanes[1]]),{code:'MAINTENANCE_ADMISSION_CATALOG_MISMATCH'});
});
test("C1 database catalog drift fails closed without advancing or a time fallback",async()=>{
 const fx=fixture({catalog:lanes.slice(1).map((laneName,ordinal)=>({laneName,ordinal}))});
 await assert.rejects(selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes}),{code:'MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH'});assert.equal(fx.advanced,false);assert.equal(fx.committed,false);
});
test("C1 ordinals are versioned and cannot silently reorder equal-turn classes",async()=>{
 const fx=fixture({catalog:lanes.map((laneName,ordinal)=>({laneName,ordinal:ordinal+1}))});
 await assert.rejects(selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes}),{code:'MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH'});
});
test("C1 skipped locked catalog returns bounded contention rather than a duplicate fallback",async()=>{
 const fx=fixture({selected:[]});const r=await selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes});
 assert.equal(r.ok,true);assert.equal(r.skipped,true);assert.equal(r.reason,'maintenance_admission_contended');assert.equal(r.contended,5);assert.deepEqual(r.selected,[]);
});
test("C1 partial admission uses only available rows; result remains JSON serializable",async()=>{
 const fx=fixture({selected:[{laneName:lanes[0],turnCount:9007199254740993n,lastAdmittedAt:new Date(0)}]});
 const r=await selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes});assert.equal(r.contended,4);assert.equal(r.turns[0].turn,'9007199254740993');assert.doesNotThrow(()=>JSON.stringify(r));
});
test("C1 invalid driver result cannot leak an unknown or repeated work class",async()=>{
 const fx=fixture({selected:[{laneName:lanes[0]},{laneName:lanes[0]}]});
 await assert.rejects(selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes}),{code:'MAINTENANCE_ADMISSION_RESULT_INVALID'});assert.equal(fx.committed,false);
});
test("C1 a commit error cannot return a successful dispatch",async()=>{
 const fx=fixture();const base=fx.db.$transaction;fx.db.$transaction=async(work)=>{await base(work);throw Object.assign(Error('commit outcome unknown'),{code:'08006'});};
 await assert.rejects(selectPhase2MaintenanceLanes({db:fx.db,laneNames:lanes}),/commit outcome unknown/);
 assert.equal(fx.calls.filter(c=>/WITH candidates/.test(c.sql)).length,1,'unknown commit must not be retried');
});
test("C1 order of the caller list does not reset persisted ordinal authority",async()=>{
 const fx=fixture();const r=await selectPhase2MaintenanceLanes({db:fx.db,laneNames:[...lanes].reverse(),lanesPerTick:1});
 assert.deepEqual(r.selected,[lanes[0]]);
});

test("C1 read-only diagnostics count opportunities without advancing progress",async()=>{
 const {readMaintenanceAdmissionProgress}=require('./phase2-maintenance-admission-service');let calls=0;
 const db={$queryRawUnsafe:async(sql,...params)=>{
  calls++;assert.match(sql,/^SELECT/);assert.equal(params[1],65);
  return lanes.map((laneName,ordinal)=>({laneName,ordinal,turnCount:ordinal?9007199254740993n:9007199254740994n,lastAdmittedAt:null}));
 }};
 const result=await readMaintenanceAdmissionProgress({db});assert.equal(calls,1);assert.equal(result.readOnly,true);assert.equal(result.spread,'1');assert.equal(result.minimumTurns,'9007199254740993');assert.equal(result.lanes.length,lanes.length);assert.doesNotThrow(()=>JSON.stringify(result));
});

test("C1 admission cannot join business transaction and retain class locks across execution",async()=>{
 const {runRootCommit}=require('./db-commit-kernel');const fx=fixture();
 await runRootCommit(fx.db,async({tx})=>{
  await assert.rejects(selectPhase2MaintenanceLanes({db:tx,laneNames:lanes}),{code:'DB_COMMIT_NESTED_ROOT_FORBIDDEN'});
 });
 assert.equal(fx.advanced,false);
});
