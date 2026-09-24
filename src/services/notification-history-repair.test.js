"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { projectTipProjectionFact, projectSubscriptionProjectionFact } = require("./team-observation-service");
const { projectCanonicalSubscriptionCompatibility } = require("./traffic-service");
function receiptDb() {
  const rows = new Map(), calls = [];
  const db = { trafficSourceMember: { findFirst: async () => ({sourceId:"source"}), updateMany: async () => ({count:1}) },
    creatorSubscriptionLedger: {
      createMany: async ({data}) => { const row=data[0]; const duplicate=rows.has(row.eventHash); if(!duplicate) rows.set(row.eventHash,row); calls.push("insert"); return {count:duplicate?0:1}; },
      findUnique: async ({where}) => { calls.push("identity"); return rows.get(where.agencyId_eventHash.eventHash); },
      aggregate: async () => assert.fail("receipt must not scan daily history"),
    }, trafficDailyAggregate: {upsert:async()=>assert.fail("retired aggregate must not be written")} };
  return {db,rows,calls};
}
test("a canonical paid receipt does not query or write the retired daily aggregate", async () => {
  const {db,rows}=receiptDb();
  const result=await projectCanonicalSubscriptionCompatibility({db,job:{agencyId:"a",creatorId:"c"},
    fact:{fanId:"123",eventType:"paid_subscribed",amountCents:100,eventHash:"fact",occurredAt:new Date()}});
  assert.equal(result.ignored,false); assert.equal(rows.size,1);
});
test("nonpayment repair cannot delete foreign or legacy receipts", async () => {
  let selector;
  const db = {creatorSubscriptionLedger:{deleteMany:async ({where}) => {selector=where; return {count:0};}}};
  await projectCanonicalSubscriptionCompatibility({db,job:{agencyId:"a",creatorId:"c"},fact:{eventType:"subscription_expired",eventHash:"event"}});
  assert.deepEqual(selector,{agencyId:"a",creatorId:"c",eventHash:"event",source:"canonical_subscription_fact"});
});
for (const project of [projectTipProjectionFact, projectSubscriptionProjectionFact]) {
  test(`${project.name}: retained event identity survives missing fan relation`, () => {
    assert.equal(project({ fanOnlyFansUserIdAtEvent: "123", fan: null }).fanId, "123");
    assert.equal(project({ fanOnlyFansUserIdAtEvent: "123", fan: { onlyFansUserId: "456" } }).fanId, "123");
    assert.equal(project({ fan: { onlyFansUserId: "456" } }).fanId, "456");
  });
}
for (const eventType of ["subscription_expired", "auto_renew_enabled", "auto_renew_disabled", "subscription_refunded", "free_subscribed", "subscribed_unknown"]) {
  test(`${eventType} with positive display price cannot become a paid ledger fact`, async () => {
    const result = await projectCanonicalSubscriptionCompatibility({ db: {}, job: {agencyId:"a",creatorId:"c"}, fact: { fanId: "123", eventType, amountCents: 100 } });
    assert.equal(result.ignored, true);
  });
}
test("historical subscription repair schedules current reconciliation without altering workflow metadata or planning writes", async () => {
  const Module = require("node:module"), original = Module._load;
  let requested = null;
  const servicePath = require.resolve("./bump-service"), before = require.cache[servicePath];
  Module._load = function(name, parent, main) {
    if (parent?.filename === servicePath && name === "./fan-data-authority-service") return {
      FAN_DATA_OBSERVATION_BATCH_MAX: 500,
      scheduleFanDataPointRefresh: async input => { requested = input; return { requested: 1, durable: true }; },
    };
    if (parent?.filename === servicePath && name === "./automation-control-service") return {
      requireCreator: async () => assert.fail("history must not enter workflow observation"),
      getAutomationControlSnapshot: async () => assert.fail("history must not plan sends"),
    };
    return original.call(this,name,parent,main);
  };
  let service;
  try { delete require.cache[servicePath]; service = require(servicePath); }
  finally { Module._load = original; if (before) require.cache[servicePath] = before; else delete require.cache[servicePath]; }
  const db = { $queryRawUnsafe: async () => [{ authorityNow: new Date() }] };
  const result = await service.processRuntimeEvents({ db, agencyId: "a", creatorId: "c", reconcileOnly: true,
    events: [{ type: "subscription_created", fanId: "123", createdAt: "2020-01-01T00:00:00Z", providerEventId: "old" }] });
  assert.equal(result.errors.length,0); assert.equal(result.planned,0);
  assert.deepEqual(requested.onlyFansUserIds,["123"]); assert.equal(requested.db,db);
});
test("paid receipt replay returns the same identity without duplicating money or scanning history", async () => {
  const {db,rows,calls}=receiptDb(); const ids=[];
  for(let n=0;n<3;n++) {
    const result=await projectCanonicalSubscriptionCompatibility({db,job:{agencyId:"a",creatorId:"c"},
      fact:{fanId:"123",eventType:"paid_subscribed",amountCents:100,eventHash:"same",occurredAt:new Date("2026-09-24")}});
    ids.push(result.ledgerId); assert.equal(result.duplicate,n>0);
  }
  assert.equal(rows.size,1); assert.equal(new Set(ids).size,1); assert.deepEqual(calls,["insert","identity","insert","identity","insert","identity"]);
});
