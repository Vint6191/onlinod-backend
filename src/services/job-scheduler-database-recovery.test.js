"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { domainWorkFailureOutcome } = require("./domain-work-failure-policy");
function cache(name, exports) { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
const temporary = () => Object.assign(new Error("controlled database outage"), { code: "P2024" });
let failures = {}, settlement;
const healthy = { ok: true, created: false, reason: "fresh" };
function result(kind, fallback = healthy) {
  if (failures[kind] instanceof Error) throw failures[kind];
  return failures[kind] || fallback;
}
const db = { creatorAccount: { findFirst: async () => ({ id: "creator", agencyId: "agency", status: "READY" }) } };
// These scheduling fixtures model stages that have already released independent work.
cache("./initial-collection-readiness-service", {
  loadInitialCollectionAdmission: async ({ creatorIds }) => new Map(creatorIds.map(id => [id, { financialReleased: true, campaignsReleased: true }])),
  initialCollectionAdmission: () => ({ admitted: true }),
});
cache("../prisma", db);
cache("./analytics-recurring-planning-service", { planRecurringCreatorAnalytics: async () => result("analytics", { created: 0, skipped: 0 }) });
cache("./creator-analytics-sync-orchestrator", { creatorAnalyticsInitialSyncReady: async () => result("bootstrap", true) });
cache("./subscriber-directory-service", { ensureSubscriberScanDue: async () => result("subscriber") });
cache("./follow-back-service", { ensureAutomaticFollowBack: async () => result("followBack") });
cache("./bump-service", { ensureAutomaticBumps: async () => healthy });
cache("./likes-service", { ensureAutomaticLikes: async () => healthy });
cache("./follow-automation-service", { ensureAutomaticFollowAutomation: async () => healthy });
cache("./sfs-service", { ensureAutomaticSfs: async () => healthy });
cache("./vault-intelligence-daily-service", { ensureDailyVaultIntelligenceCycle: async () => result("daily") });
cache("./domain-work-authority-service", {
  WORK_CLASS: { CREATOR_RECURRING_PLANNING: "CREATOR_RECURRING_PLANNING" },
  claimDomainWorkBatch: async () => ({ ownerToken: "owner", authorityNow: new Date(),
    items: [{ id: "work", agencyId: "agency", creatorId: "creator", objectId: "creator" }] }),
  heartbeatDomainWorkClaim: async () => ({ renewed: true, authorityNow: new Date() }),
  failDomainWorkClaim: async ({ error }) => {
    settlement = { error, policy: domainWorkFailureOutcome({ error, workClass: "CREATOR_RECURRING_PLANNING", consecutiveFailures: 12 }) };
    return { failed: true };
  },
  yieldDomainWorkClaim: async () => ({ yielded: true }),
});
delete require.cache[require.resolve("./job-scheduler")];
const scheduler = require("./job-scheduler");

test("recurring planner retains actual database causes through bootstrap and derived-consumer result wrappers", async () => {
  for (const which of ["analytics", "bootstrap", "subscriber", "followBack", "daily"]) {
    failures = { [which]: temporary() }; settlement = null;
    const run = await scheduler.runRecurringCreatorWork({ db });
    assert.equal(run.ok, false, which); assert(settlement, which);
    assert.equal(settlement.policy.state, "READY", which);
    assert.equal(settlement.policy.errorClass, "TRANSIENT_DATABASE", which);
    assert.equal(settlement.error.errors[0], failures[which], which);
    assert.doesNotMatch(JSON.stringify(run), /schedulerFailureCause|\"stack\"/);
  }
  failures = { analytics: temporary(), subscriber: temporary(), daily: temporary() };
  await scheduler.runRecurringCreatorWork({ db });
  assert.equal(settlement.error.errors.length, 3);
  assert.equal(settlement.policy.state, "READY");
});

test("one broken or untyped planner substep still exhausts the bounded poison budget", async () => {
  for (const bad of [new TypeError("invalid consumer contract"),
    { ok: false, created: false, reason: "P2024" },
    { ok: false, created: false, reason: "fan_refresh_debt_not_durable" }]) {
    failures = { analytics: temporary(), followBack: bad }; settlement = null;
    await scheduler.runRecurringCreatorWork({ db });
    assert.equal(settlement.policy.state, "RECONCILE_REQUIRED");
    assert.notEqual(settlement.policy.errorClass, "TRANSIENT_DATABASE");
  }
});

test("terminal collector is visible without quarantining independent shared planning work", async () => {
  failures = { analytics: { created: 1, skipped: 2,
    skipReasons: ["campaigns:failed_terminal", "notifications:already_in_flight"],
    blocked: [{ stream: "campaigns", reason: "failed_terminal", code: "BAD_SCAN_PROOF" }],
  } };
  settlement = null;
  const run = await scheduler.runRecurringCreatorWork({ db });
  assert.equal(run.ok, false);
  assert.deepEqual(run.blockedCollectors, ["campaigns"]);
  assert.equal(run.totalCreated, 1);
  assert.equal(run.planningReasons["campaigns:failed_terminal"], 1);
  assert.equal(run.planningReasons["notifications:already_in_flight"], 1);
  assert.equal(run.degradedCreators[0].issues[0].code, "BAD_SCAN_PROOF");
  assert.equal(run.yielded, 1);
  assert.equal(run.retried, 0);
  assert.equal(settlement, null, "recorded domain failure must not consume shared planning retry budget");
});
