"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function inject(id, exports) {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function pagedModel(rows, calls) {
  return {
    async findMany(args) {
      calls.push(args);
      assert.deepEqual(args.where, { creatorId: "creator-1", sourceJobId: "job-1" });
      let start = 0;
      if (args.cursor?.id) start = rows.findIndex((row) => row.id === args.cursor.id) + Number(args.skip || 0);
      return rows.slice(start, start + args.take);
    },
  };
}

function loadProjection({ sales = [], tips, subscriptions, ingestAssertion, ingestResult = {}, trafficError = false }) {
  const calls = { subscriptions: [], saleQueries: [], tipQueries: [], subscriptionQueries: [], state: null, bump: [], trafficDirty: [], sync: [] };
  const db = {
    creatorSale: pagedModel(sales, calls.saleQueries),
    creatorTip: pagedModel(tips, calls.tipQueries),
    creatorSubscriptionEvent: pagedModel(subscriptions, calls.subscriptionQueries),
    teamObservationState: { upsert: async (args) => { calls.state = args; return args.update; } },
  };
  inject("../prisma", db);
  inject("./job-idempotency", { buildJobIdempotencyKey: () => "key" });
  inject("./traffic-service", {
    ingestSubscriptionEvent: async (args) => { calls.subscriptions.push(args); return { ok: true }; },
    markTrafficFanValueDirty: async (args) => {
      calls.trafficDirty.push(args);
      if (trafficError) throw new Error("traffic compatibility failed");
      return { ok: true, matched: 1 };
    },
  });
  inject("./bump-service", {
    processRuntimeEvents: async (args) => { calls.bump.push(args); return { planned: args.events.length, errors: [] }; },
  });
  inject("./notification-facts-service", {
    ingestNotificationFacts: async (args) => {
      ingestAssertion?.(args);
      return {
        batchId: "batch-1", status: "COMMITTED", inserted: 0, updated: 0,
        unchanged: sales.length + tips.length + subscriptions.length, rejected: 0,
        coverageComplete: true,
        coverageByType: { tips: "complete", subscriptions: "complete" }, replayed: false,
        ...ingestResult,
      };
    },
  });
  inject("./notification-sync-state-service", {
    assertNotificationCollectionResult() { return true; },
    async completeNotificationSync(args) {
      calls.sync.push(args);
      return { id: "sync-1", status: args.successful ? "COMPLETE" : "PARTIAL" };
    },
    async recordNotificationSyncFailure() { return null; },
  });
  delete require.cache[require.resolve("./team-observation-service")];
  const { applyCatchupJobResult } = require("./team-observation-service");
  return { applyCatchupJobResult, calls, db };
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
    id: "job-1", agencyId: "agency-1", creatorId: "creator-1",
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

test("completion preserves the collector run key and projects current-job facts", async () => {
  const at = new Date("2026-08-05T12:00:00.000Z");
  const tips = [{
    id: "tip-1", eventFingerprint: "f".repeat(64), externalNotificationId: "tip-notification",
    externalTransactionId: null, messageId: "message-1", amountCents: 500, currency: "USD", tippedAt: at,
    fan: { onlyFansUserId: "fan-1", username: "fan_one", displayName: "Fan One" },
  }];
  const subscriptions = [{
    id: "subscription-1", eventFingerprint: "e".repeat(64), externalNotificationId: "subscription-notification",
    externalTransactionId: "subscription-transaction", eventType: "RENEWED", observedPriceCents: 1000,
    currency: "USD", occurredAt: at,
    fan: { onlyFansUserId: "fan-2", username: "fan_two", displayName: "Fan Two" },
  }];
  const result = completionResult(2);
  const { applyCatchupJobResult, calls, db } = loadProjection({
    tips, subscriptions,
    ingestAssertion: ({ result: supplied }) => {
      assert.equal(supplied.batchKey, result.batchKey);
      assert.equal(supplied.scanRunId, result.scanRunId);
      assert.equal(supplied.schemaVersion, 4);
    },
  });

  const applied = await applyCatchupJobResult({ db, job: scopedJob(), deviceId: "device-1", userId: "user-1", result });
  assert.equal(applied.ok, true);
  assert.equal(applied.summary.compatibilityCandidates, 2);
  assert.equal(applied.summary.compatibilityProcessed, 2);
  assert.equal(applied.summary.compatibilityTruncated, false);
  assert.equal(calls.trafficDirty.length, 1, "canonical tip may dirty Traffic but must not write Team money again");
  assert.equal(calls.subscriptions.length, 1);
  assert.equal(calls.tipQueries[0].where.sourceJobId, "job-1");
  assert.equal(calls.subscriptionQueries[0].where.sourceJobId, "job-1");
  assert.equal(calls.state.update.currentScanStatus, "idle");
});

test("typed canonical non-money projection paginates beyond 2000 facts without truncation", async () => {
  const at = new Date("2026-08-05T12:00:00.000Z");
  const tips = Array.from({ length: 2101 }, (_, index) => ({
    id: `tip-${String(index).padStart(5, "0")}`,
    eventFingerprint: `tip-fingerprint-${index}`,
    externalNotificationId: `tip-notification-${index}`,
    externalTransactionId: null,
    messageId: null,
    amountCents: 100,
    currency: "USD",
    tippedAt: at,
    fan: { onlyFansUserId: `fan-${index}`, username: null, displayName: null },
  }));
  const { applyCatchupJobResult, calls, db } = loadProjection({ tips, subscriptions: [] });
  const applied = await applyCatchupJobResult({
    db, job: scopedJob(), deviceId: "device-1", userId: "user-1", result: completionResult(tips.length),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.summary.compatibilityCandidates, 2101);
  assert.equal(applied.summary.compatibilityProcessed, 2101);
  assert.equal(applied.summary.compatibilityTruncated, false);
  assert.equal(calls.trafficDirty.length, 2101);
  assert.ok(calls.tipQueries.length >= 5);
});

test("typed subscription projection keeps refund only in the relational ledger and never inflates old paid revenue", async () => {
  const at = new Date("2026-08-05T12:00:00.000Z");
  const subscriptions = [
    {
      id: "sub-paid", eventFingerprint: "paid-fingerprint", externalNotificationId: null,
      externalTransactionId: "shared-transaction", eventType: "SUBSCRIBED_PAID", observedPriceCents: 1000,
      currency: "USD", occurredAt: at,
      fan: { onlyFansUserId: "fan-1", username: null, displayName: null },
    },
    {
      id: "sub-refund", eventFingerprint: "refund-fingerprint", externalNotificationId: null,
      externalTransactionId: "shared-transaction", eventType: "REFUNDED", observedPriceCents: 1000,
      currency: "USD", occurredAt: new Date("2026-08-05T13:00:00.000Z"),
      fan: { onlyFansUserId: "fan-1", username: null, displayName: null },
    },
  ];
  const { applyCatchupJobResult, calls, db } = loadProjection({ tips: [], subscriptions });
  const applied = await applyCatchupJobResult({
    db, job: scopedJob(), deviceId: "device-1", userId: "user-1", result: completionResult(2),
  });
  assert.equal(applied.ok, true);
  assert.equal(calls.subscriptions.length, 1);
  assert.deepEqual(calls.subscriptions.map((call) => call.event.eventType), ["paid_subscribed"]);
  assert.equal(applied.summary.subscriptionRefundIgnored, 1);
  assert.equal(applied.summary.skipped, 1);
});


test("compatibility projection failure cannot invalidate a proven notification collection", async () => {
  const tips = [{
    id: "tip-compat", eventFingerprint: "c".repeat(64), externalNotificationId: "tip-compat-notification",
    externalTransactionId: null, messageId: null, amountCents: 500, currency: "USD",
    tippedAt: new Date("2026-08-05T12:00:00.000Z"),
    fan: { onlyFansUserId: "fan-compat", username: null, displayName: null },
  }];
  const { applyCatchupJobResult, calls, db } = loadProjection({ tips, subscriptions: [], trafficError: true });
  const applied = await applyCatchupJobResult({
    db, job: scopedJob(), deviceId: "device-1", userId: "user-1", result: completionResult(1),
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.verified, true);
  assert.equal(applied.compatibilityComplete, false);
  assert.equal(applied.summary.errors, 1);
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].successful, true, "canonical proof must ignore compatibility-only failures");
  assert.equal(calls.state.update.currentScanStatus, "error", "compatibility failure remains visible in Team activity");
});

test("source-exhausted rejected notification facts remain PARTIAL and enter job retry semantics", async () => {
  const { applyCatchupJobResult, calls, db } = loadProjection({
    tips: [], subscriptions: [],
    ingestResult: {
      status: "PARTIAL",
      rejected: 1,
      coverageComplete: false,
      coverageByType: { tips: "partial", subscriptions: "complete" },
    },
  });
  const applied = await applyCatchupJobResult({
    db, job: scopedJob(), deviceId: "device-1", userId: "user-1", result: completionResult(0),
  });

  assert.equal(applied.sourceTraversalComplete, true);
  assert.equal(applied.ok, false);
  assert.equal(applied.verified, false);
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].successful, false);
});
