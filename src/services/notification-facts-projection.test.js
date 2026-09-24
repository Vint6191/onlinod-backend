"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
function inject(id, exports) {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function loadProjection({ receivedRows = 0, badReceipt = false, intentError = false, ingestResult = {}, ingestAssertion } = {}) {
  const calls = { facts: 0, receipts: [], intents: [], sync: [], state: null };
  const noInlineHistory = { async findMany() { calls.facts++; throw new Error("completion must not iterate canonical history"); } };
  const db = {
    creatorSale: noInlineHistory, creatorTip: noInlineHistory, creatorSubscriptionEvent: noInlineHistory,
    analyticsIngestBatch: {
      async aggregate(args) {
        calls.receipts.push(args);
        assert.deepEqual(args.where, { agencyId: "agency-1", creatorId: "creator-1", sourceJobId: "job-1",
          dataType: "NOTIFICATIONS", idempotencyKey: { contains: ":run:scan-run-projection-0001:page:" } });
        return { _sum: { receivedRows }, _count: { _all: receivedRows ? Math.ceil(receivedRows / 500) : 0 } };
      },
      async findFirst(args) { assert.equal(args.where.sourceJobId, "job-1"); return badReceipt ? { id: "failed-page" } : null; },
    },
    teamObservationState: { async upsert(args) { calls.state = args; return args.update; } },
  };
  inject("../prisma", db);
  inject("./job-idempotency", { buildJobIdempotencyKey: () => "key" });
  inject("./notification-facts-service", { async ingestNotificationFacts(args) {
    ingestAssertion?.(args);
    return { batchId: "batch-1", status: "COMMITTED", inserted: 0, updated: 0, unchanged: 0, rejected: 0,
      coverageComplete: true, coverageByType: { tips: "complete", subscriptions: "complete" }, replayed: false, ...ingestResult };
  } });
  inject("./notification-consequence-service", { async publishNotificationConsequences(args) {
    calls.intents.push(args); if (intentError) throw Object.assign(new Error("required intent failed"), { code: "TEST_INTENT_FAILURE" });
    return { published: true };
  } });
  inject("./notification-sync-state-service", {
    assertNotificationCollectionResult() { return true; },
    async completeNotificationSync(args) { calls.sync.push(args); return { status: args.successful ? "COMPLETE" : "PARTIAL" }; },
    async recordNotificationSyncFailure() { return null; },
  });
  delete require.cache[require.resolve("./team-observation-service")];
  return { ...require("./team-observation-service"), calls, db };
}
async function complete(fx, count) {
  return fx.applyCatchupJobResult({ db: fx.db, job: scopedJob(), deviceId: "device-1", userId: "user-1", result: completionResult(count) });
}
function completionResult(totalAcceptedEvents) {
  const scanRunId = "scan-run-projection-0001";
  return {
    collectorVersion: "notifications-catchup-v4",
    schemaVersion: 4,
    notificationMode: "full",
    sourceExhausted: true,
    allSourceExhausted: true,
    sourceTimezone: "UTC",
    scanRunId,
    batchKey: `run:${scanRunId}:completion`,
    finalizeCoverage: true,
    totalAcceptedEvents,
    events: [],
    coverage: {
      tips: { status: "complete", reason: "source_exhausted", pages: 1, events: totalAcceptedEvents, rejected: 0 },
      subscriptions: { status: "complete", reason: "source_exhausted", pages: 1, events: 0, rejected: 0 },
    },
  };
}

function scopedJob() {
  const scanRunId = "scan-run-projection-0001";
  return {
    id: "job-1", jobKey: "catchup_notifications_scan", agencyId: "agency-1", creatorId: "creator-1",
    params: {
      accountId: "account-1",
      from: "2026-08-05T00:00:00.000Z",
      to: "2026-08-05T23:59:59.999Z",
      types: ["tips", "subscriptions"],
      notificationMode: "full",
      collectionContractVersion: 1,
      collectionType: "NOTIFICATIONS",
      collectionMode: "full",
      collectionGeneration: scanRunId,
      collectionRequestedAt: "2026-08-05T00:00:00.000Z",
      collectionReason: "test_projection",
    },
  };
}

test("full completion preserves collector identity and publishes required durable work on the same client", async () => {
  const result = completionResult(2);
  const fx = loadProjection({ receivedRows: 2, ingestAssertion: ({ result: supplied }) => {
    assert.equal(supplied.batchKey, result.batchKey); assert.equal(supplied.scanRunId, result.scanRunId); assert.equal(supplied.schemaVersion, 4);
  } });
  const applied = await complete(fx, 2);
  assert.equal(applied.ok, true); assert.equal(applied.verified, true);
  assert.equal(applied.compatibilityComplete, false); assert.equal(applied.summary.compatibilityDeferred, true);
  assert.equal(fx.calls.intents.length, 1); assert.equal(fx.calls.intents[0].db, fx.db);
  assert.equal(fx.calls.intents[0].job.id, "job-1"); assert.equal(fx.calls.state.update.currentScanStatus, "idle");
});

test("full completion beyond 2000 facts performs receipt aggregation without synchronous history traversal", async () => {
  const fx = loadProjection({ receivedRows: 2101 });
  const applied = await complete(fx, 2101);
  assert.equal(applied.verified, true); assert.equal(fx.calls.facts, 0); assert.equal(fx.calls.receipts.length, 1);
  assert.equal(applied.summary.pageProof.receivedRows, 2101); assert.equal(applied.summary.compatibilityProcessed, 0);
});

test("a full scan cannot mark omitted canonical page receipts as successful", async () => {
  const fx = loadProjection({ receivedRows: 1 });
  const applied = await complete(fx, 2);
  assert.equal(applied.verified, false); assert.equal(applied.summary.pageProof.reason, "backend_page_receipt_count_mismatch");
  assert.equal(Object.hasOwn(fx.calls.state.update, "lastTipScanTo"), false, "unproved pages cannot advance a per-type legacy frontier either");
  assert.equal(fx.calls.sync[0].successful, false); assert.equal(fx.calls.state.update.currentScanStatus, "error");
});

test("required intent failure propagates before collection freshness is published", async () => {
  const fx = loadProjection({ intentError: true });
  await assert.rejects(complete(fx, 0), { code: "TEST_INTENT_FAILURE" });
  assert.equal(fx.calls.sync.length, 0); assert.equal(fx.calls.state, null);
});

test("source-exhausted rejected canonical facts remain PARTIAL and enter job retry semantics", async () => {
  const fx = loadProjection({ ingestResult: { status: "PARTIAL", rejected: 1, coverageComplete: false, coverageByType: { tips: "partial", subscriptions: "complete" } } });
  const applied = await complete(fx, 0);
  assert.equal(applied.sourceTraversalComplete, true); assert.equal(applied.ok, false); assert.equal(applied.verified, false);
  assert.equal(fx.calls.sync[0].successful, false);
});

test("a rejected persisted page prevents success despite clean collector completion flags", async () => {
  const fx = loadProjection({ receivedRows: 2, badReceipt: true });
  const applied = await complete(fx, 2);
  assert.equal(applied.verified, false); assert.equal(applied.summary.pageProof.reason, "backend_page_receipt_partial");
  assert.equal(fx.calls.sync[0].successful, false);
});
