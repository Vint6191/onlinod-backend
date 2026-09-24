"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { projectTipProjectionFact, projectSubscriptionProjectionFact } = require("./team-observation-service");
const { projectCanonicalSubscriptionCompatibility } = require("./traffic-service");
test("daily aggregate waits for its scoped transaction lock before reading ledger totals", async () => {
  const { recomputeTrafficDailyAggregate } = require("./traffic-service"), calls = [];
  const db = {
    $executeRawUnsafe: async (sql,key) => { assert.match(sql,/pg_advisory_xact_lock/); assert.match(key,/a.*c.*source.*2026-09-24/); calls.push("lock"); },
    creatorSubscriptionLedger: { aggregate: async () => { assert.equal(calls[0],"lock"); calls.push("read"); return {_count:{_all:2},_sum:{amountCents:300}}; } },
    trafficSource: { findUnique: async () => ({costCents:10}) },
    trafficDailyAggregate: { upsert: async value => { calls.push("write"); assert.equal(value.update.grossCents,300); return value; } },
  };
  await recomputeTrafficDailyAggregate(db,{agencyId:"a",creatorId:"c",sourceId:"source",day:new Date("2026-09-24T18:00:00Z")});
  assert.deepEqual(calls,["lock","read","write"]);
});
test("nonpayment repair cannot delete foreign or legacy receipts", async () => {
  let selector;
  const db = {creatorSubscriptionLedger:{findFirst:async ({where}) => {selector=where; return null;},deleteMany:async()=>assert.fail("no matching canonical receipt")}};
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
    const result = await projectCanonicalSubscriptionCompatibility({ db: {}, job: {}, fact: { fanId: "123", eventType, amountCents: 100 } });
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
test("several subscriptions for the same source/day collect one aggregate recomputation target", async () => {
  const targets = new Map(), day = new Date("2026-09-24T10:00:00Z");
  const db = { trafficSourceMember: { findFirst: async () => ({sourceId:"source"}), updateMany: async () => ({count:1}) },
    creatorSubscriptionLedger: { upsert: async ({create}) => ({id:"row",...create}) } };
  for(let n=0;n<3;n++) await projectCanonicalSubscriptionCompatibility({db,job:{agencyId:"a",creatorId:"c"},
    fact:{fanId:"123",eventType:"paid_subscribed",amountCents:100,eventHash:"fact-"+n,occurredAt:day},deferredAggregates:targets});
  assert.equal(targets.size,1); assert.equal([...targets.values()][0].day.toISOString(),"2026-09-24T00:00:00.000Z");
});
