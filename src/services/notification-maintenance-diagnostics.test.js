"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createRequire } = require("node:module");
function service(file, mocks) {
  const filename = path.join(__dirname, file), original = createRequire(filename), module = { exports: {} };
  new Function("require", "module", "exports", fs.readFileSync(filename, "utf8"))(name => Object.hasOwn(mocks, name) ? mocks[name] : original(name), module, module.exports);
  return module.exports;
}
test("orphan sale and tip keep their canonical facts without inventing a fan projection", async () => {
  const dirty = [];
  const s = service("notification-consequence-service.js", { "./traffic-service": {
    markTrafficFanValueDirty: async x => { dirty.push(x); }, projectCanonicalSubscriptionCompatibility: async () => ({ ignored: true }),
  } });
  for (const table of [0, 1]) {
    await s.projectFacts({ db: {}, job: { agencyId: "a", creatorId: "c" }, table, rows: [
      { fan: null }, { fanOnlyFansUserIdAtEvent: "at-event", fan: null }, { fan: { onlyFansUserId: "relation" } },
    ], historical: true });
  }
  assert.deepEqual(dirty.map(x => x.fanId), ["at-event", "relation", "at-event", "relation"]);
});
function sweepFixture({ skipped, skipAfterFailure, failure, lost = false, poison = false } = {}) {
  let claimed = 0;
  const s = service("notification-history-repair-service.js", {
    "./notification-identity-recovery-service": { recoverNotificationIdentityWork: async () => ({ resumed: 0 }) },
    "./db-commit-kernel": { runRootCommit: async (_db, _fn, options) => {
      if (options.authority.kind === "NOTIFICATION_HISTORY_ENUMERATION") return { ok: true, complete: true };
      throw failure || Object.assign(new Error("private SQL detail"), { code: "BAD_TRAFFIC_DIRTY_INPUT" });
    } },
    "./domain-work-authority-service": { WORK_CLASS: { NOTIFICATION_HISTORY_REPAIR: "NOTIFICATION_HISTORY_REPAIR", NOTIFICATION_RECEIPT_REPAIR: "NOTIFICATION_RECEIPT_REPAIR" },
      claimDomainWorkBatch: async () => skipped || (claimed && skipAfterFailure)
        ? { skipped: true, reason: skipped || skipAfterFailure }
        : { items: claimed++ ? [] : [{ id: "work", agencyId: "a", creatorId: "c", objectId: "c", objectType: "CreatorAccount", workClass: "NOTIFICATION_HISTORY_REPAIR", progressCursor: { table: 1 } }] },
      failDomainWorkClaim: async () => ({ lost, state: poison ? "RECONCILE_REQUIRED" : "READY", reconcileRequired: poison, consecutiveFailures: poison ? 8 : 1 }),
    },
  });
  return s.runNotificationHistoryRepairSweep({ db: {}, maxRuntimeMs: 10000 });
}
test("history error report exposes the actual failure and poison state without SQL text", async () => {
  const r = await sweepFixture({ poison: true });
  assert.equal(r.ok, false); assert.equal(r.failed, 1); assert.equal(r.reason, "BAD_TRAFFIC_DIRTY_INPUT"); assert.equal(r.poisonedSignals, 1);
  assert.equal(r.errorDetails[0].workId, "work"); assert.equal(r.errorDetails[0].table, 1); assert.doesNotMatch(JSON.stringify(r), /private SQL detail/);
});
test("lost work ownership is contention, not a fabricated processing failure", async () => {
  const r = await sweepFixture({ lost: true }); assert.equal(r.ok, true); assert.equal(r.contended, 1); assert.equal(r.failed, 0);
});
test("a later bridge transition cannot erase the actual page failure", async () => {
  const r = await sweepFixture({ skipAfterFailure: "domain_work_dependency_wake_bridge_transition" });
  assert.equal(r.ok, false); assert.equal(r.failed, 1); assert.equal(r.reason, "BAD_TRAFFIC_DIRTY_INPUT");
});
for (const [reason, ok] of [["domain_work_dependency_wake_bridge_transition", true], ["domain_work_claim_topology_building", false], ["unsupported_domain_work_generation", false]]) {
  test(`history claim gate preserves reason ${reason}`, async () => { const r = await sweepFixture({ skipped: reason }); assert.equal(r.ok, ok); assert.equal(r.skipped, true); assert.equal(r.reason, reason); });
}
test("scheduler log and health retain failed/reason even when errors=0", () => {
  require.cache[require.resolve("../prisma")] = { exports: {} };
  const scheduler = require("./job-scheduler");
  const result = { ok: false, notificationHistoryRepair: { ok: false, failed: 1, reason: "BAD_TRAFFIC_DIRTY_INPUT", errorDetails: Array(10).fill({ code: "BAD_TRAFFIC_DIRTY_INPUT" }) } };
  const summary = scheduler._test.maintenanceDegradedDetails(result).notificationHistoryRepair;
  assert.equal(summary.errors, 0); assert.equal(summary.failed, 1); assert.equal(summary.reason, "BAD_TRAFFIC_DIRTY_INPUT"); assert.equal(summary.errorDetails.length, 5);
  scheduler._test.handleMaintenanceTickResult(result);
  assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.lastReason, "notificationHistoryRepair:BAD_TRAFFIC_DIRTY_INPUT");
  scheduler._test.handleMaintenanceTickResult({ ok: true }); assert.equal(scheduler.getRecurringSchedulerHealthSnapshot().maintenance.lastReason, null);
});
