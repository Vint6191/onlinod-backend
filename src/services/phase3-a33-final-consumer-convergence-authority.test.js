"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("A33 all five derived consumers use one durable refresh-debt authority", () => {
  const fanData = source("src/services/fan-data-authority-service.js");
  assert.match(fanData, /async function scheduleDurableFanDataRefreshDebt/);
  assert.match(fanData, /fanDataPointRefreshDecisionDurable\(decision\)/);
  assert.match(fanData, /requested: ids\.length/);
  assert.match(fanData, /durable: false/);
  assert.match(fanData, /consumer: text\(consumer/);
  assert.match(fanData, /refreshFields: fields/);
  for (const file of ["follow-back-service.js", "follow-automation-service.js", "bump-service.js", "likes-service.js", "sfs-service.js"]) {
    assert.match(source(`src/services/${file}`), /scheduleDurableFanDataRefreshDebt/);
  }
});

test("A33 Likes and SFS expose non-durable refresh debt as planner failure", () => {
  const likes = source("src/services/likes-service.js");
  const sfs = source("src/services/sfs-service.js");
  assert.match(likes, /planning\?\.fanRefresh\?\.requested > 0 && planning\.fanRefresh\.durable !== true/);
  assert.match(likes, /reason: "fan_refresh_debt_not_durable"/);
  assert.match(sfs, /planning\?\.fanRefresh\?\.requested > 0 && planning\.fanRefresh\.durable !== true/);
  assert.match(sfs, /reason: "fan_refresh_debt_not_durable"/);
  assert.match(sfs, /scheduleFanRefresh = scheduleFanDataPointRefresh/);
});

test("A33 common refresh authority preserves requested debt on scheduler throw and rejects terminal same-bucket failures", async () => {
  const { scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service");
  const failed = await scheduleDurableFanDataRefreshDebt({
    agencyId: "a", creatorId: "c", fanIds: ["2", "1", "1"], consumer: "likes", refreshFields: ["value", "identity", "value"],
    scheduleFanRefresh: async () => ({ created: false, reason: "same_bucket_failed", jobId: "dead-job" }),
  });
  assert.equal(failed.requested, 2);
  assert.equal(failed.durable, false);
  assert.deepEqual(failed.fanIds, ["1", "2"]);
  assert.match(failed.error, /same_bucket_failed/);

  const thrown = await scheduleDurableFanDataRefreshDebt({
    agencyId: "a", creatorId: "c", fanIds: ["1", "2"], consumer: "sfs",
    scheduleFanRefresh: async () => { throw Object.assign(new Error("temporary"), { code: "scheduler_down" }); },
  });
  assert.equal(thrown.requested, 2);
  assert.equal(thrown.durable, false);
  assert.equal(thrown.error, "scheduler_down");

  for (const reason of ["already_in_flight", "recently_done", "idempotency_race"]) {
    const durable = await scheduleDurableFanDataRefreshDebt({
      agencyId: "a", creatorId: "c", fanIds: ["1"], consumer: "likes",
      scheduleFanRefresh: async () => ({ created: false, reason, jobId: `job-${reason}` }),
    });
    assert.equal(durable.durable, true, reason);
  }
});

test("A33 transient scheduler failure retries to one durable intent after restart semantics", async () => {
  const { scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service");
  let attempts = 0;
  const scheduled = [];
  const scheduleFanRefresh = async (input) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("temporary scheduler outage"), { code: "scheduler_down" });
    if (!scheduled.length) {
      scheduled.push({ id: "durable-after-restart", input });
      return { created: true, jobId: "durable-after-restart" };
    }
    return { created: false, reason: "already_in_flight", jobId: scheduled[0].id };
  };

  const first = await scheduleDurableFanDataRefreshDebt({
    agencyId: "a", creatorId: "c", fanIds: ["2", "1"], consumer: "likes",
    refreshFields: ["fanSubscriptionType", "fanSubscriptionActive"], scheduleFanRefresh,
  });
  assert.equal(first.requested, 2);
  assert.equal(first.durable, false);
  assert.equal(first.error, "scheduler_down");

  // A process restart carries no in-memory success state. Re-running the same
  // durable request must create/recover exactly one DB-owned intent.
  const afterRestart = await scheduleDurableFanDataRefreshDebt({
    agencyId: "a", creatorId: "c", fanIds: ["1", "2"], consumer: "likes",
    refreshFields: ["fanSubscriptionActive", "fanSubscriptionType"], scheduleFanRefresh,
  });
  assert.equal(afterRestart.durable, true);
  assert.equal(afterRestart.decision.jobId, "durable-after-restart");

  const replay = await scheduleDurableFanDataRefreshDebt({
    agencyId: "a", creatorId: "c", fanIds: ["2", "1"], consumer: "likes",
    refreshFields: ["fanSubscriptionType", "fanSubscriptionActive"], scheduleFanRefresh,
  });
  assert.equal(replay.durable, true);
  assert.equal(replay.decision.reason, "already_in_flight");
  assert.equal(replay.decision.jobId, "durable-after-restart");
  assert.equal(scheduled.length, 1);
});

test("A33 refresh debt stays bounded to 500 and canonicalizes consumer field identity input", async () => {
  const { scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service");
  let captured = null;
  const result = await scheduleDurableFanDataRefreshDebt({
    agencyId: "a", creatorId: "c", fanIds: Array.from({ length: 700 }, (_, i) => String(i + 1)), consumer: "likes",
    refreshFields: ["value", "identity", "value"],
    scheduleFanRefresh: async (input) => { captured = input; return { created: true, jobId: "j1" }; },
  });
  assert.equal(result.requested, 500);
  assert.equal(result.durable, true);
  assert.equal(captured.onlyFansUserIds.length, 500);
  assert.deepEqual(captured.params.refreshFields, ["identity", "value"]);
  assert.equal(captured.params.consumer, "likes");
});

test("A33 Admin current Hidden Online and Follow Back routes no longer read raw legacy tables", () => {
  const admin = source("src/routes/admin-data.js");
  const hiddenStart = admin.indexOf('router.get("/hidden-online"');
  const followStart = admin.indexOf('router.get("/follow-back"');
  const vaultStart = admin.indexOf('router.get("/vault-sales"');
  const currentRoutes = admin.slice(hiddenStart, vaultStart);
  assert.match(currentRoutes, /listHiddenOnline/);
  assert.match(currentRoutes, /listFollowBack/);
  assert.match(currentRoutes, /authority: "canonical_current"/);
  assert.doesNotMatch(currentRoutes, /prisma\.hiddenOnlineUser\.findMany/);
  assert.doesNotMatch(currentRoutes, /prisma\.followBackTask\.findMany/);
  assert.match(admin, /hiddenOnlineHistoricalCompatibility/);
  assert.doesNotMatch(admin.slice(admin.indexOf('router.get("/creator/:id/overview"'), admin.indexOf('router.get("/search"')), /prisma\.hiddenOnlineUser\.count|prisma\.followBackTask\.count/);
});
