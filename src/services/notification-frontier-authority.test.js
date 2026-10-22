"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const frontier = require("./notification-frontier-authority");
const requestedAt = "2026-10-22T12:00:00.000Z";
const job = { id:"job",creatorId:"creator",agencyId:"agency",params:{notificationMode:"catchup",
  notificationFrontierVersion:3,collectionGeneration:"generation",collectionRequestedAt:requestedAt,
  recoveryTargetAt:requestedAt,recoveryGapFrom:"2026-10-21T12:00:00.000Z"} };
function store() {
  const pages = [];
  return { pages,
    $queryRawUnsafe: async (sql,creatorId,generation,value) => pages.filter(row => row.creatorId === creatorId
      && row.generation === generation && (sql.startsWith("SELECT digest") ? row.page === value : row.cursorStart === value)),
    $executeRawUnsafe: async (_sql,creatorId,agencyId,generation,page,cursorStart,cursorEnd,digest) => {
      pages.push({creatorId,agencyId,generation,page,cursorStart,cursorEnd,digest}); return 1;
    } };
}
function chunk(page, {complete = true, hasMore = true} = {}) {
  return { page,sourcePhase:"all",cursorStart:page === 1 ? null : `id-${page-1}`,cursorEnd:`id-${page}`,
    observations:[{notificationId:`id-${page}`}],sourceHasMore:hasMore,providerPageComplete:complete,
    sourceExhausted:!hasMore,stopReason:hasMore ? null : "source_exhausted" };
}
test("three persisted unchanged full pages finish; a correction resets the streak across a restart",async()=>{
  const db=store(); let state=null;
  for (let page=1;page<=6;page++) {
    state=await frontier.commitPage(db,job,chunk(page),JSON.parse(JSON.stringify(state)),{unchanged:page!==3,pastGap:true});
    assert.equal(frontier.completed(job,state),page===6);
  }
  assert.equal(state.boundaryPage,4); assert.equal(state.overlapPage,6); assert.equal(state.unchangedPages,3);
  const replay=await frontier.commitPage(db,job,chunk(6),state,{unchanged:true,pastGap:true});
  assert.deepEqual(replay,state); assert.equal(db.pages.length,6);
  await assert.rejects(frontier.commitPage(db,job,{...chunk(6),cursorEnd:"changed"},state),{code:"NOTIFICATION_FRONTIER_PAYLOAD_CONFLICT"});
});
test("known IDs, rows added by this recovery, rejected facts and corrections are not pre-run unchanged evidence",()=>{
  const row={identityKey:"notification:id",sourceChecksum:"digest",disposition:"FACT",occurredAt:new Date("2026-10-20T12:00:00Z")};
  const prior={...row,firstObservedAt:new Date("2026-10-19T12:00:00Z"),persistenceStatus:"FACT_COMMITTED",canonicalFactId:"fact"};
  const assess=change=>frontier.assessPage(job,[row],new Map([[row.identityKey,{...prior,...change}]]),new Map([[row.identityKey,{status:"FACT_COMMITTED",canonicalFactId:"fact"}]]));
  assert.deepEqual(assess({}),{unchanged:true,pastGap:true});
  assert.equal(assess({firstObservedAt:new Date(requestedAt)}).unchanged,false);
  assert.equal(assess({sourceChecksum:"prior-revision"}).unchanged,false);
  assert.equal(assess({persistenceStatus:"REJECTED"}).unchanged,false);
  assert.equal(frontier.assessPage(job,[row],new Map()).unchanged,false);
});
test("truncated provider pages and known pages within the missing period cannot complete recovery",async()=>{
  const db=store();let state=null;
  for(let page=1;page<=5;page++) {
    state=await frontier.commitPage(db,job,chunk(page,{complete:page!==3}),state,{unchanged:true,pastGap:page!==1});
    assert.equal(frontier.completed(job,state),false);
  }
  state=await frontier.commitPage(db,job,chunk(6,{hasMore:false}),state,{unchanged:false,pastGap:false});
  assert.equal(frontier.completed(job,state),true); assert.equal(state.exhausted,true);
});
test("server completion checkpoint is durable and page replay cannot rewind it",async()=>{
  const db=store();let state=null;
  for(let page=1;page<=3;page++) state=await frontier.commitPage(db,job,chunk(page),state,{unchanged:true,pastGap:true});
  const requested={driverPhase:"execute",jobContinuation:{schemaVersion:9,scanRunId:"generation",page:3,fromId:"id-3",observedRows:30}};
  const committed=frontier.attachContinuation(job,requested,{notificationFrontier:state});
  assert.equal(committed.jobContinuation.sourceExhausted,true);
  assert.equal(committed.jobContinuation.stopReason,"known_boundary_reached");
  assert.equal(committed.jobContinuation.observedRows,30);
  assert.deepEqual(frontier.attachContinuation({...job,continuation:committed},requested,{notificationFrontier:state,replayed:true}),committed);
});
test("cursor cycles and premature client completion cannot produce successful recovery",async()=>{
  const db=store();const state=await frontier.commitPage(db,job,chunk(1),null,{unchanged:true,pastGap:true});
  await assert.rejects(frontier.commitPage(db,job,{...chunk(2),cursorEnd:"id-1",observations:[{notificationId:"id-1"}]},state,{unchanged:true,pastGap:true}),{code:"NOTIFICATION_FRONTIER_CURSOR_STALLED"});
  await assert.rejects(frontier.commitPage(db,job,{...chunk(2),sourceExhausted:true,stopReason:"known_boundary_reached"},state,{unchanged:true,pastGap:true}),{code:"NOTIFICATION_FRONTIER_COMPLETION_INVALID"});
  assert.equal(frontier.enabled({...job,params:{...job.params,notificationMode:"full"}}),false);
});
