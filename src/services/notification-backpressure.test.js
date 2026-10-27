"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const work = require("./domain-work-authority-service");
const receipts = require("./notification-fact-receipt-service");
const service = require("./notification-consequence-service");
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");
const { classifyCommitConflict, runRootCommit } = require("./db-commit-kernel");
const { attachSchedulerFailureCause } = require("./scheduler-failure-cause");
const bumps = require("./bump-service");

function capacityFailure() {
  return Object.assign(new Error("NOTIFICATION_BUMP_PROJECTION_FAILED:FAN_DATA_REFRESH_BACKLOG_FULL", {
    cause: Object.assign(new Error("FAN_DATA_REFRESH_BACKLOG_FULL"), {
      code: "FAN_DATA_REFRESH_BACKLOG_FULL", retryable: true,
      capacity: { pendingGlobal: 4, pendingCreator: 4, maxPendingGlobal: 32, maxPendingCreator: 4 },
    }),
  }), { code: "NOTIFICATION_BUMP_PROJECTION_FAILED:FAN_DATA_REFRESH_BACKLOG_FULL" });
}

test("capacity wait survives more than eight scheduling attempts without failure or cursor acknowledgement", async () => {
  const original = { claim: work.claimDomainWorkBatch, fail: work.failDomainWorkClaim, yield: work.yieldDomainWorkClaim, page: receipts.processPage };
  const now = new Date("2026-10-27T15:00:00Z"), waits = [];
  const db = commitDatabaseFixture({ $executeRawUnsafe: async () => 1, $queryRawUnsafe: async sql => sql.includes('"authorityNow"') ? [{ authorityNow: now }] : [] });
  let selected;
  try {
    work.claimDomainWorkBatch = async () => ({ ownerToken: "private-lease", items: selected++ === 0 ? [{ id: "work", workClass: "NOTIFICATION_FACT_RECEIPTS", creatorId: "creator", agencyId: "agency" }] : [] });
    work.failDomainWorkClaim = async () => assert.fail("capacity must not spend a failure attempt");
    work.yieldDomainWorkClaim = async args => { waits.push(args); return { yielded: true, lost: false, availableAt: args.availableAt }; };
    receipts.processPage = async () => { throw capacityFailure(); };
    for (let i = 0; i < 12; i++) {
      selected = 0;
      const result = await service.runNotificationConsequenceSweep({ db });
      assert.equal(result.ok, true); assert.equal(result.waiting, 1); assert.equal(result.backpressured, 1);
      assert.equal(result.failed, 0); assert.equal(result.completed, 0); assert.equal(result.processed, 0);
      assert.equal(result.reason, "FAN_DATA_REFRESH_BACKLOG_FULL");
    }
    assert.equal(waits.length, 12);
    for (const args of waits) { assert.equal(+args.availableAt, +now + 30000); assert.equal(args.progressCursor, undefined); }
    work.yieldDomainWorkClaim = async () => ({ lost: true }); selected = 0;
    const lost = await service.runNotificationConsequenceSweep({ db });
    assert.equal(lost.waiting, 0); assert.equal(lost.lostOwnership, 1);
  } finally { work.claimDomainWorkBatch = original.claim; work.failDomainWorkClaim = original.fail; work.yieldDomainWorkClaim = original.yield; receipts.processPage = original.page; }
});

test("text resembling capacity or an unrelated rejection cannot bypass the failure policy", async () => {
  const original = { claim: work.claimDomainWorkBatch, fail: work.failDomainWorkClaim, yield: work.yieldDomainWorkClaim, page: receipts.processPage };
  let selected = 0, failures = 0;
  try {
    work.claimDomainWorkBatch = async () => ({ ownerToken: "lease", items: selected++ === 0 ? [{ id: "work", workClass: "NOTIFICATION_FACT_RECEIPTS" }] : [] });
    work.yieldDomainWorkClaim = async () => assert.fail("unclassified failure must remain visible");
    work.failDomainWorkClaim = async () => { failures++; return { state: "RECONCILE_REQUIRED", consecutiveFailures: 8 }; };
    for (const error of [Object.assign(Error("capacity text"), { code: capacityFailure().code }), Object.assign(capacityFailure(), { code: "CONTRACT_FAILURE" })]) {
      selected = 0; receipts.processPage = async () => { throw error; };
      const result = await service.runNotificationConsequenceSweep({ db: { $queryRawUnsafe: async () => [] } });
      assert.equal(result.ok, false); assert.equal(result.failed, 1); assert.equal(result.waiting, 0);
    }
    assert.equal(failures, 2);
  } finally { work.claimDomainWorkBatch = original.claim; work.failDomainWorkClaim = original.fail; work.yieldDomainWorkClaim = original.yield; receipts.processPage = original.page; }
});

test("capacity waits and later transitions cannot hide a hard failure in the sweep report", async () => {
  const original = { claim: work.claimDomainWorkBatch, fail: work.failDomainWorkClaim, yield: work.yieldDomainWorkClaim, page: receipts.processPage };
  const db = commitDatabaseFixture({ $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async sql => sql.includes('"authorityNow"') ? [{ authorityNow: new Date() }] : [] });
  let claims = 0, pages = 0;
  try {
    work.claimDomainWorkBatch = async () => {
      claims++;
      if (claims <= 2) return { ownerToken: "lease", items: [{ id: `work${claims}`, workClass: "NOTIFICATION_FACT_RECEIPTS" }] };
      return { skipped: true, reason: "domain_work_dependency_wake_bridge_transition", items: [] };
    };
    receipts.processPage = async () => {
      if (pages++ === 0) throw capacityFailure();
      throw Object.assign(Error("contract failed"), { code: "CONTRACT_FAILURE" });
    };
    work.yieldDomainWorkClaim = async args => ({ yielded: true, lost: false, availableAt: args.availableAt });
    work.failDomainWorkClaim = async () => ({ state: "RETRY_WAIT", consecutiveFailures: 1 });
    const result = await service.runNotificationConsequenceSweep({ db });
    assert.equal(result.ok, false); assert.equal(result.failed, 1); assert.equal(result.backpressured, 1);
    assert.equal(result.reason, "CONTRACT_FAILURE"); assert.equal(result.errorDetails[0].code, "CONTRACT_FAILURE");
  } finally { work.claimDomainWorkBatch = original.claim; work.failDomainWorkClaim = original.fail; work.yieldDomainWorkClaim = original.yield; receipts.processPage = original.page; }
});

test("projection preserves the actual SQL cause for root retry without serializing it into the result", async () => {
  const original = bumps.processRuntimeEvents;
  const cause = Object.assign(new Error("private SQL and row contents"), { code: "P2010", meta: { code: "40001" } });
  const dto = attachSchedulerFailureCause({ code: "P2010" }, cause);
  assert.doesNotMatch(JSON.stringify(dto), /private|40001/);
  bumps.processRuntimeEvents = async () => ({ errors: [dto] });
  const db = commitDatabaseFixture({ $executeRawUnsafe: async () => 1,
    creatorSubscriptionLedger: { deleteMany: async () => ({ count: 0 }) } });
  try {
    await assert.rejects(runRootCommit(db, ({ tx }) => service.projectFacts({ db: tx, job: { agencyId: "a", creatorId: "c" }, table: 2,
      rows: [{ eventType: "SUBSCRIBED_FREE", fanOnlyFansUserIdAtEvent: "123", eventFingerprint: "fixture", occurredAt: new Date() }] }), { maxAttempts: 1 }), error => {
      assert.equal(error.cause, cause); assert.equal(classifyCommitConflict(error).sqlState, "40001"); return true;
    });
  } finally { bumps.processRuntimeEvents = original; }
});
