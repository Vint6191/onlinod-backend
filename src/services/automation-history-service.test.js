"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAutomationDelivery, groupDeliveriesForArchive, compactAutomationDeliveries } = require("./automation-history-service");

test("semantic counters classify automation actions", () => {
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SEND_MESSAGE", result: { replied: true } }).sent, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SEND_MESSAGE", result: { replied: true } }).replied, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "FOLLOW_BACK" }).followed, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SFS_UNFOLLOW_TARGET" }).unfollowed, 1);
  assert.equal(classifyAutomationDelivery({ status: "FAILED", actionType: "LIKE_POST" }).failed, 1);
});

test("archive groups are separated by creator module action and month", () => {
  const rows = [
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", finishedAt: new Date("2026-01-02T00:00:00Z") },
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "FAILED", finishedAt: new Date("2026-01-03T00:00:00Z") },
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", finishedAt: new Date("2026-02-03T00:00:00Z") },
  ];
  const groups = groupDeliveriesForArchive(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].total, 2);
  assert.equal(groups[0].completed, 1);
  assert.equal(groups[0].failed, 1);
});

const { archiveAutomationDeliveryBatch, getAutomationMetrics } = require("./automation-history-service");
const { archiveAdminDeliveries } = require("./admin-delivery-archive-command-service");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { randomUUID } = require("node:crypto");
const { lockRetentionCommit } = require("./retention-commit-guard-service");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const at = new Date("2025-01-01T00:00:00Z"), olderThan = new Date("2026-01-01T00:00:00Z");
function fixture(options = {}) {
  const m = createMemoryDb(options);
  m.state.deliveries.push({ id: "d1", agencyId: "agency-a", creatorId: "creator-a", originKind: "AUTOMATION", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", result: {}, updatedAt: at, createdAt: at, finishedAt: at });
  return m;
}
function request(m, changes = {}) { return { db: m.db, actor, commandId: randomUUID(), creatorId: "creator-a", payload: { agencyId: "agency-a", reason: "terminal archive", olderThan: olderThan.toISOString(), items: [{ id: "d1", expectedUpdatedAt: at.toISOString() }] }, ...changes }; }
async function batch(m, rows = structuredClone(m.state.deliveries), extra = {}) { return m.db.$transaction(tx => archiveAutomationDeliveryBatch({ tx, rows, olderThan, ...extra })); }
test("one command atomically archives, audits and replays without incrementing twice", async () => {
  const m = fixture(), req = request(m);
  const first = await archiveAdminDeliveries(req), replay = await archiveAdminDeliveries(req);
  assert.equal(first.body.archived, 1); assert.equal(replay.replayed, true);
  assert.equal(m.state.deliveries.length, 0); assert.equal(m.state.aggregates[0].total, 1); assert.equal(m.state.audit.length, 1);
  const different = await archiveAdminDeliveries(request(m)); assert.equal(different.statusCode, 409); assert.equal(m.state.aggregates[0].total, 1);
});
test("another process already deleted the selected row: absence contributes zero", async () => {
  const m = fixture(), stale = structuredClone(m.state.deliveries);
  await batch(m, stale); const result = await batch(m, stale);
  assert.equal(result.archived, 0); assert.equal(m.state.aggregates[0].total, 1);
});
for (const fail of ["failAggregate", "failAudit"]) test(`${fail} rolls back delivery, aggregate and command`, async () => {
  const m = fixture({ [fail]: true }); await assert.rejects(archiveAdminDeliveries(request(m)));
  assert.equal(m.state.deliveries.length, 1); assert.equal(m.state.aggregates.length, 0); assert.equal(m.state.commands.length, 0); assert.equal(m.state.audit.length, 0);
});
for (const [name, patch] of Object.entries({
  programmatic: { originKind: "PROGRAMMATIC" }, live: { status: "PENDING" }, unfinished: {finishedAt:null}, recent: {finishedAt:new Date("2026-05-01")},
  unresolved: {failureCode:"outcome_unresolved_do_not_retry"}, remote: {remoteLifecycleState:"PENDING"}, mass: {actionType:"MASS_QUEUE_CREATE",intentAcknowledgedAt:null},
})) test(`${name} row survives at deletion predicate`, async () => {
  const m = fixture({beforeArchiveDelete: rows => Object.assign(rows[0], patch)});
  assert.equal((await batch(m)).archived,0); assert.equal(m.state.deliveries.length,1); assert.equal(m.state.aggregates.length,0);
});
test("settled acknowledged MASS row may archive", async () => {
  const m=fixture(); Object.assign(m.state.deliveries[0],{actionType:"MASS_QUEUE_CREATE",intentAcknowledgedAt:at,remoteLifecycleState:"SETTLED"}); assert.equal((await batch(m)).archived,1);
});
for (const name of ["updated", "agency", "creator", "retired"]) test(`${name} selection cannot cross scope or revision`, async () => {
  const m=fixture(), rows=structuredClone(m.state.deliveries);
  if(name==="updated")m.state.deliveries[0].updatedAt=new Date("2025-02-01");
  if(name==="agency")m.state.deliveries[0].agencyId="agency-b";
  if(name==="creator")m.state.creators[0].agencyId="agency-b";
  if(name==="retired")m.state.agencies[0].deletedAt=at;
  assert.equal((await batch(m,rows)).archived,0);assert.equal(m.state.aggregates.length,0);
});
test("strict command rejects a mixed selection atomically",async()=>{
 const m=fixture();m.state.deliveries.push({...m.state.deliveries[0],id:"d2",status:"PENDING"});const req=request(m);req.payload.items.push({id:"d2",expectedUpdatedAt:at.toISOString()});
 const res=await archiveAdminDeliveries(req);assert.equal(res.statusCode,409);assert.equal(m.state.deliveries.length,2);assert.equal(m.state.aggregates.length,0);assert.equal(m.state.audit[0].event,"REJECTED");
});
for(const mode of ["missing","active","complete"])test(`SFS proof ${mode}`,async()=>{
 const m=fixture();Object.assign(m.state.deliveries[0],{moduleKey:"sfs",actionType:"SFS_FOLLOW_TARGET",payload:{candidateId:"s1"},generation:1});
 if(mode!=="missing")m.state.candidates.push({id:"s1",state:mode==="complete"?"COMPLETED":"UNFOLLOW_DUE",generation:1});
 assert.equal((await batch(m)).archived,mode==="complete"?1:0);
});
test("support role and revoked session cannot archive",async()=>{
 for(const field of ["role","session"]){const m=fixture();if(field==="role")m.state.admins[0].role="SUPPORT";else m.state.sessions[0].revokedAt=at;await assert.rejects(archiveAdminDeliveries(request(m)));assert.equal(m.state.deliveries.length,1);}
});
test("duplicate, wildcard and oversized manifests are rejected before mutation",async()=>{
 for(const mutate of [p=>p.items.push(p.items[0]),p=>p.items=Array.from({length:101},(_,i)=>({id:String(i),expectedUpdatedAt:at.toISOString()})),p=>delete p.agencyId,p=>p.statuses=["pending_reply"]]){const m=fixture(),req=request(m);mutate(req.payload);await assert.rejects(archiveAdminDeliveries(req));assert.equal(m.state.commands.length,0);}
});
test("compaction uses common owner and bounded page",async()=>{const m=fixture();assert.equal((await compactAutomationDeliveries({db:m.db,olderThan,batchSize:999999})).archived,1);});
test("lease loss before archive rolls back all effects",async()=>{const m=fixture();await assert.rejects(batch(m,undefined,{commitGuard:async()=>{throw Error("lease lost");}}));assert.equal(m.state.deliveries.length,1);});
test("retention commit guard rejects expired, replaced and completed owner",async()=>{
 for(const change of [{ownerToken:"new"},{leaseUntil:at},{completedAt:at}]){const tx={$queryRawUnsafe:async sql=>sql.includes("clock_timestamp")?[{authorityNow:olderThan}]:[{ownerToken:"owner",leaseUntil:new Date("2027-01-01"),completedAt:null,...change}]};await assert.rejects(lockRetentionCommit({tx,ownerToken:"owner"}),{code:"RETENTION_LEASE_LOST"});}
});
test("metrics reads live and archive within one repeatable snapshot",async()=>{
 let options;const db={$transaction:async(fn,opt)=>{options=opt;return fn({automationMonthlyAggregate:{findMany:async()=>[]},automationDelivery:{findMany:async()=>[],groupBy:async()=>[]}});}};
 assert.equal((await getAutomationMetrics({db,agencyId:"agency-a",creatorId:"creator-a"})).summary.total,0);assert.equal(options.isolationLevel,"RepeatableRead");
});
