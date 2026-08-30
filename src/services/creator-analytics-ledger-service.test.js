"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.endsWith("creator-analytics-ledger-service.js")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {
  ingestEarningsChunk,
  completeEarningsScan,
  ingestCampaignChunk,
  ingestCampaignFanValueChunk,
  ingestCampaignFanValuesBatchChunk,
  completeCampaignScan,
  upsertMessagesDaily,
  readCreatorLedgerOverview,
  readCreatorCoverage,
  readCampaignFans,
  rangeBounds,
} = require("./creator-analytics-ledger-service");
Module._load = originalLoad;

const job = { id: "job-1", agencyId: "agency-1", creatorId: "creator-1", params: {} };

function transactional(tx) {
  return { ...tx, $transaction: async (callback) => callback(tx) };
}

function batchHarness(options = {}) {
  const created = [];
  const updated = [];
  const coverage = [];
  const coverageUpdates = [];
  const existing = options.existingBatch || null;
  const tx = {
    analyticsIngestBatch: {
      findFirst: async () => options.latestBatch || null,
      findUnique: async () => existing,
      create: async ({ data }) => {
        const row = { id: "batch-new", status: "RECEIVED", ...data };
        created.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { id: where.id, ...data };
        updated.push(row);
        return row;
      },
      findMany: async () => options.pageBatches || [],
    },
    analyticsCoverage: {
      findFirst: async () => options.latestCoverage || null,
      findUnique: async () => options.existingCoverage || null,
      upsert: async (args) => {
        coverage.push(args);
        return args.create;
      },
      updateMany: async (args) => { coverageUpdates.push(args); return { count: 1 }; },
    },
  };
  return { tx, db: transactional(tx), created, updated, coverage, coverageUpdates };
}

test("rangeBounds uses inclusive calendar-day windows", () => {
  const now = new Date("2026-08-06T12:34:56.000Z");
  assert.equal(rangeBounds("24h", now).start.toISOString(), "2026-08-06T00:00:00.000Z");
  assert.equal(rangeBounds("7d", now).dayStart.toISOString(), "2026-07-31T00:00:00.000Z");
  assert.equal(rangeBounds("30d", now).dayStart.toISOString(), "2026-07-08T00:00:00.000Z");
  const previous = rangeBounds("prev_year", now);
  assert.equal(previous.start.toISOString(), "2025-01-01T00:00:00.000Z");
  assert.equal(previous.end.toISOString(), "2025-12-31T23:59:59.999Z");
});

test("earnings pages use protocol v4 and remain pending until completion proof", async () => {
  const harness = batchHarness();
  const dailyUpserts = [];
  harness.tx.creatorEarningsDaily = {
    findUnique: async () => null,
    upsert: async (args) => { dailyUpserts.push(args); return args.create; },
  };
  const result = await ingestEarningsChunk({
    db: harness.db,
    job,
    deviceId: "device-1",
    chunk: {
      kind: "earnings_daily_page",
      schemaVersion: 4,
      collectorVersion: "earnings-v4",
      scanRunId: "run-earnings-1",
      observedAt: "2026-08-06T12:00:00.000Z",
      batchKey: "run:run-earnings-1:daily:page-1",
      scannerRejected: 0,
      rows: [
        { date: "2026-08-05", sourceTimezone: "UTC", totalCents: 1000, currency: "USD" },
        { date: "2026-08-06", sourceTimezone: "UTC", totalCents: 500, currency: "USD" },
      ],
    },
  });
  assert.equal(result.rejected, 0);
  assert.equal(dailyUpserts.length, 2);
  assert.equal(dailyUpserts[0].create.sourceScanRunId, "run-earnings-1");
  assert.deepEqual(harness.coverage.map((entry) => entry.create.status), ["PARTIAL", "PARTIAL"]);
  assert.equal(harness.coverage[0].create.lastErrorCode, "EARNINGS_SCAN_PENDING");
  assert.equal(harness.coverage[1].create.lastErrorCode, "EARNINGS_DAY_IN_PROGRESS");
  assert.equal(harness.updated.at(-1).status, "COMMITTED");
  assert.equal(harness.updated.at(-1).receivedRows, 2);
  assert.equal(harness.updated.at(-1).insertedRows, 2);

  await assert.rejects(
    ingestEarningsChunk({ db: harness.db, job, chunk: { schemaVersion: 3, collectorVersion: "earnings-v3" } }),
    /Invalid earnings page contract/,
  );
});

test("earnings completion proves every page and promotes only historical coverage", async () => {
  const harness = batchHarness({
    pageBatches: [
      { id: "page-a", status: "COMMITTED", receivedRows: 7, rejectedRows: 0 },
    ],
  });
  harness.tx.creatorEarningsDaily = { count: async () => 7 };
  const payload = {
    schemaVersion: 4,
    collectorVersion: "earnings-v4",
    scanRunId: "run-earnings-2",
    observedAt: "2026-08-06T12:00:00.000Z",
    range: { startDate: "2026-07-31", endDate: "2026-08-06" },
    dailyBatchCount: 1,
    dailyCount: 7,
    scannerRejected: 0,
    chartComplete: true,
    dailyComplete: true,
  };
  const result = await completeEarningsScan({ db: harness.db, job, deviceId: "device-1", result: payload });
  assert.equal(result.complete, true);
  assert.equal(harness.updated.at(-1).status, "COMMITTED");
  assert.equal(harness.updated.at(-1).receivedRows, 7);
  assert.equal(harness.updated.at(-1).unchangedRows, 7);
  assert.equal(harness.coverageUpdates.length, 1);
  assert.deepEqual(harness.coverageUpdates[0].where.ingestBatchId.in, ["page-a"]);
  assert.equal(harness.coverageUpdates[0].data.status, "COMPLETE");
});

test("earnings completion stays partial when page proof or daily proof is incomplete", async () => {
  const harness = batchHarness({ pageBatches: [] });
  harness.tx.creatorEarningsDaily = { count: async () => 0 };
  const result = await completeEarningsScan({
    db: harness.db,
    job,
    result: {
      schemaVersion: 4,
      collectorVersion: "earnings-v4",
      scanRunId: "run-earnings-3",
      observedAt: "2026-08-06T12:00:00.000Z",
      range: { startDate: "2026-07-31", endDate: "2026-08-06" },
      dailyBatchCount: 1,
      dailyCount: 7,
      scannerRejected: 0,
      chartComplete: true,
      dailyComplete: false,
    },
  });
  assert.equal(result.complete, false);
  assert.equal(harness.updated.at(-1).status, "PARTIAL");
  assert.equal(harness.coverageUpdates.length, 0);
});

test("campaign completion proves every page batch before closing coverage", async () => {
  const completeHarness = batchHarness({
    pageBatches: [
      { idempotencyKey: "campaigns:job-1:run:scan-1:campaigns:a", status: "COMMITTED", rejectedRows: 0 },
      { idempotencyKey: "campaigns:job-1:run:scan-1:claimers:b", status: "COMMITTED", rejectedRows: 0 },
    ],
  });
  let inactiveWhere = null;
  completeHarness.tx.creatorCampaign = {
    count: async () => 1,
    updateMany: async ({ where }) => { inactiveWhere = where; return { count: 2 }; },
  };
  const payload = {
    schemaVersion: 4,
    collectorVersion: "campaigns-v6",
    scanRunId: "scan-1",
    scanStartedAt: "2026-08-06T11:00:00.000Z",
    observedAt: "2026-08-06T12:00:00.000Z",
    campaignPagesComplete: true,
    claimersComplete: true,
    truncated: false,
    campaignCount: 1,
    campaignBatchCount: 1,
    claimerBatchCount: 1,
    fanValuesRequested: 0,
    fanValuesFetched: 0,
    fanValuesUnavailable: 0,
    fanValuesComplete: true,
  };
  const complete = await completeCampaignScan({ db: completeHarness.db, job, result: payload });
  assert.equal(complete.complete, true);
  assert.equal(completeHarness.updated.at(-1).status, "COMMITTED");
  assert.ok(inactiveWhere, "stale campaigns are deactivated only after complete proof");
  assert.equal(completeHarness.coverage[0].create.status, "COMPLETE");

  const partialHarness = batchHarness({ pageBatches: completeHarness.tx.analyticsIngestBatch.findMany ? [
    { idempotencyKey: "campaigns:job-1:run:scan-1:campaigns:a", status: "COMMITTED", rejectedRows: 0 },
  ] : [] });
  let deactivated = false;
  partialHarness.tx.creatorCampaign = { count: async () => 1, updateMany: async () => { deactivated = true; return { count: 1 }; } };
  const partial = await completeCampaignScan({ db: partialHarness.db, job, result: payload });
  assert.equal(partial.complete, false);
  assert.equal(deactivated, false);
  assert.equal(partialHarness.updated.at(-1).status, "PARTIAL");
  assert.equal(partialHarness.coverage[0].create.status, "PARTIAL");
});

test("campaign completion replay can promote a formerly partial audit batch", async () => {
  const existingBatch = {
    id: "completion-batch",
    status: "PARTIAL",
    payloadChecksum: null,
  };
  const payload = {
    schemaVersion: 4,
    collectorVersion: "campaigns-v6",
    scanRunId: "scan-2",
    scanStartedAt: "2026-08-06T11:00:00.000Z",
    observedAt: "2026-08-06T12:00:00.000Z",
    campaignPagesComplete: true,
    claimersComplete: true,
    truncated: false,
    campaignCount: 1,
    campaignBatchCount: 1,
    claimerBatchCount: 0,
    fanValuesRequested: 0,
    fanValuesFetched: 0,
    fanValuesUnavailable: 0,
    fanValuesComplete: true,
  };
  const crypto = require("node:crypto");
  existingBatch.payloadChecksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const harness = batchHarness({
    existingBatch,
    pageBatches: [{ idempotencyKey: "campaigns:job-1:run:scan-2:campaigns:a", status: "COMMITTED", rejectedRows: 0 }],
  });
  harness.tx.creatorCampaign = { count: async () => 1, updateMany: async () => ({ count: 0 }) };
  const result = await completeCampaignScan({ db: harness.db, job, result: payload });
  assert.equal(result.complete, true);
  assert.equal(result.replay, true);
  assert.equal(harness.updated.at(-1).status, "COMMITTED");
});

test("campaign fan attribution keeps the earliest confirmed attribution date", async () => {
  const harness = batchHarness();
  let updateData = null;
  harness.tx.creatorCampaign = { findUnique: async () => ({ id: "campaign-db-1" }) };
  harness.tx.creatorCampaignFan = {
    findUnique: async () => ({ id: "membership-1", sourceScanStartedAt: new Date("2026-08-05T00:00:00.000Z"), externalClaimerId: "claim-old", attributedAt: new Date("2026-07-01T00:00:00.000Z") }),
    upsert: async ({ update }) => { updateData = update; return {}; },
  };
  harness.tx.creatorFan = {
    findUnique: async () => ({ id: "fan-db-1", lastSeenAt: new Date("2026-07-01T00:00:00.000Z") }),
    update: async () => ({ id: "fan-db-1" }),
  };
  await ingestCampaignChunk({
    db: harness.db, job,
    chunk: {
      kind: "campaign_claimers_page", schemaVersion: 4, collectorVersion: "campaigns-v6",
      scanRunId: "scan-earliest", scanStartedAt: "2026-08-06T11:00:00.000Z", observedAt: "2026-08-06T12:00:00.000Z",
      batchKey: "run:scan-earliest:claimers:1", externalCampaignId: "campaign-1", campaignComplete: true, scannerRejected: 0,
      claimers: [{ user: { id: "fan-1" }, id: "claim-new", attributedAt: "2026-08-01T00:00:00.000Z" }],
    },
  });
  assert.equal(updateData.attributedAt.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("campaign fan attribution is historical and is never pruned by a later empty page", async () => {
  const run = async (scannerRejected) => {
    const harness = batchHarness();
    let pruneCalls = 0;
    harness.tx.creatorCampaign = { findUnique: async () => ({ id: "campaign-db-1" }) };
    harness.tx.creatorCampaignFan = {
      findUnique: async () => null,
      upsert: async () => ({}),
      deleteMany: async () => { pruneCalls += 1; return { count: 3 }; },
    };
    harness.tx.creatorFan = { findUnique: async () => null, create: async () => ({ id: "fan-db-1" }), update: async () => ({ id: "fan-db-1" }) };
    const result = await ingestCampaignChunk({
      db: harness.db,
      job,
      chunk: {
        kind: "campaign_claimers_page",
        schemaVersion: 4,
        collectorVersion: "campaigns-v6",
        scanRunId: "scan-history",
        scanStartedAt: "2026-08-06T11:00:00.000Z",
        observedAt: "2026-08-06T12:00:00.000Z",
        batchKey: `run:scan-history:claimers:${scannerRejected}`,
        externalCampaignId: "campaign-1",
        campaignComplete: true,
        scannerRejected,
        claimers: [],
      },
    });
    return { result, pruneCalls };
  };
  assert.equal((await run(0)).pruneCalls, 0);
  assert.equal((await run(1)).pruneCalls, 0);
});


test("campaign fan value current snapshot stores fresh OF subscriber totals and preserves cents exactly", async () => {
  let upsertData = null;
  const db = {
    $executeRawUnsafe: async () => 1,
    creatorFan: {
      findUnique: async () => ({ id: "fan-db-1" }),
      update: async () => ({ id: "fan-db-1" }),
    },
    creatorFanValueCurrent: {
      findUnique: async () => null,
      upsert: async ({ create }) => { upsertData = create; return create; },
    },
  };
  const result = await ingestCampaignFanValueChunk({
    db, job, deviceId: "device-1",
    chunk: {
      kind: "campaign_fan_value",
      schemaVersion: 4,
      collectorVersion: "campaigns-v6",
      scanRunId: "fan-value-run",
      scanStartedAt: "2026-08-08T18:00:00.000Z",
      observedAt: "2026-08-08T18:01:00.000Z",
      batchKey: "run:fan-value-run:fan-value:abc",
      fanOnlyFansUserId: "211347786",
      available: true,
      username: "u211347786",
      displayName: "Benjamin",
      totalNetCents: 187920,
      messagesNetCents: 118480,
      subscriptionsNetCents: 0,
      tipsNetCents: 69440,
      postsNetCents: 0,
      streamsNetCents: 0,
      lastActivityAt: "2025-05-16T16:01:25.000Z",
    },
  });
  assert.equal(result.available, true);
  assert.equal(upsertData.platformReportedTotalSpendCents, 187920n);
  assert.equal(upsertData.messagesSpentCents, 118480n);
  assert.equal(upsertData.tipsSpentCents, 69440n);
  assert.equal(upsertData.source, "USER_PROFILE");
});


test("campaign fan value batch applies multiple current snapshots under one analytics lock", async () => {
  let locks = 0;
  const upserts = [];
  const db = {
    $executeRawUnsafe: async () => { locks += 1; return 1; },
    creatorFan: {
      findUnique: async ({ where }) => ({ id: `fan-${where.creatorId_onlyFansUserId.onlyFansUserId}` }),
      update: async () => ({}),
    },
    creatorFanValueCurrent: {
      findUnique: async () => null,
      upsert: async ({ create }) => { upserts.push(create); return create; },
    },
  };
  const result = await ingestCampaignFanValuesBatchChunk({
    db, job, deviceId: "device-1",
    chunk: {
      kind: "campaign_fan_values_batch",
      schemaVersion: 4, collectorVersion: "campaigns-v6",
      scanRunId: "batch-run", scanStartedAt: "2026-08-08T18:00:00.000Z", observedAt: "2026-08-08T18:01:00.000Z",
      batchKey: "run:batch-run:fan-values:abc",
      values: [
        { fanOnlyFansUserId: "1", available: true, observedAt: "2026-08-08T18:01:00.000Z", totalNetCents: 100, messagesNetCents: 0, subscriptionsNetCents: 0, tipsNetCents: 0, postsNetCents: 0, streamsNetCents: 0 },
        { fanOnlyFansUserId: "2", available: true, observedAt: "2026-08-08T18:01:00.000Z", totalNetCents: 250, messagesNetCents: 0, subscriptionsNetCents: 0, tipsNetCents: 0, postsNetCents: 0, streamsNetCents: 0 },
      ],
    },
  });
  assert.equal(result.received, 2);
  assert.equal(result.available, 2);
  assert.equal(locks, 1);
  assert.equal(upserts.length, 2);
  assert.deepEqual(upserts.map((row) => row.platformReportedTotalSpendCents), [100n, 250n]);
});

test("message-day sync records the reporting device and never closes the current UTC day", async () => {
  const harness = batchHarness();
  const upserts = [];
  harness.tx.creatorMessagesDaily = {
    findUnique: async () => null,
    upsert: async (args) => { upserts.push(args); return args.create; },
  };
  const result = await upsertMessagesDaily({
    db: harness.db,
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-1",
    localCoverage: { complete: true, knownDialogs: 2, incompleteDialogs: 0, messagesIndexed: 12, oldestMessageAt: "2026-08-01T00:00:00.000Z", newestMessageAt: "2026-08-06T17:00:00.000Z" },
    syncId: "6b9704f5-f5dc-42bd-976c-8f7c1873652f",
    observedAt: "2026-08-06T18:00:00.000Z",
    rows: [
      { date: "2026-08-05", sourceTimezone: "UTC", incomingMessages: 1, outgoingMessages: 2, totalMessages: 3, uniqueDialogs: 1, uniqueIncomingFans: 1, uniqueOutgoingFans: 1 },
      { date: "2026-08-06", sourceTimezone: "UTC", incomingMessages: 4, outgoingMessages: 5, totalMessages: 9, uniqueDialogs: 2, uniqueIncomingFans: 2, uniqueOutgoingFans: 2 },
    ],
  });
  assert.equal(result.accepted, 2);
  assert.equal(upserts[0].create.sourceDeviceId, "device-1");
  assert.deepEqual(harness.coverage.map((entry) => entry.create.status), ["COMPLETE", "PARTIAL"]);
  assert.equal(harness.coverage[1].create.lastErrorCode, "MESSAGES_DAY_IN_PROGRESS");
});




test("message-day sync commits primary facts even when disposable daily cache rebuild fails", async () => {
  const harness = batchHarness();
  harness.tx.creatorMessagesDaily = {
    findUnique: async () => null,
    upsert: async (args) => args.create,
  };
  harness.db.creatorDailyMetrics = { upsert: async () => { throw new Error("cache write should not be reached"); } };
  harness.db.$queryRawUnsafe = async () => { throw new Error("simulated cache SQL failure"); };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await upsertMessagesDaily({
      db: harness.db, agencyId: "agency-1", creatorId: "creator-1", sourceDeviceId: "device-1",
      localCoverage: { complete: true, knownDialogs: 1, incompleteDialogs: 0, messagesIndexed: 3, oldestMessageAt: "2026-08-05T00:00:00.000Z", newestMessageAt: "2026-08-05T12:00:00.000Z" },
      syncId: "11a15e3c-0e71-467b-85f3-4da2112fc6f4", observedAt: "2026-08-06T18:00:00.000Z",
      rows: [{ date: "2026-08-05", sourceTimezone: "UTC", incomingMessages: 1, outgoingMessages: 2, totalMessages: 3, uniqueDialogs: 1, uniqueIncomingFans: 1, uniqueOutgoingFans: 1 }],
    });
    assert.equal(result.accepted, 1);
    assert.equal(harness.updated.at(-1).status, "COMMITTED");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /daily metrics projection failed after messages ingest/);
  } finally {
    console.warn = originalWarn;
  }
});

test("message-day sync keeps every day partial while local history is incomplete", async () => {
  const harness = batchHarness();
  harness.tx.creatorMessagesDaily = {
    findUnique: async () => null,
    upsert: async (args) => args.create,
  };
  const result = await upsertMessagesDaily({
    db: harness.db, agencyId: "agency-1", creatorId: "creator-1", sourceDeviceId: "device-1",
    localCoverage: { complete: false, knownDialogs: 3, incompleteDialogs: 1, messagesIndexed: 9, oldestMessageAt: "2026-08-01T00:00:00.000Z", newestMessageAt: "2026-08-06T17:00:00.000Z" },
    syncId: "2e8d315e-2ea0-44ad-965d-f350643786ac", observedAt: "2026-08-06T18:00:00.000Z",
    rows: [{ date: "2026-08-05", sourceTimezone: "UTC", incomingMessages: 1, outgoingMessages: 1, totalMessages: 2, uniqueDialogs: 1, uniqueIncomingFans: 1, uniqueOutgoingFans: 1 }],
  });
  assert.equal(result.localCoverageComplete, false);
  assert.equal(harness.coverage[0].create.status, "PARTIAL");
  assert.equal(harness.coverage[0].create.lastErrorCode, "LOCAL_MESSAGE_HISTORY_INCOMPLETE");
});

test("ledger overview preserves nullable earnings categories and counts only complete coverage days", async () => {
  const date = new Date("2026-08-05T00:00:00.000Z");
  const db = {
    creatorEarningsDaily: { findMany: async () => [{ date, totalCents: 1000, subscriptionsCents: null, messagesCents: null, tipsCents: null, postsCents: null, streamsCents: null, referralsCents: null }] },
    creatorMessagesDaily: { findMany: async () => [{ date, incomingMessages: 2, outgoingMessages: 3, totalMessages: 5, uniqueDialogs: 2, uniqueIncomingFans: 1, uniqueOutgoingFans: 2 }] },
    creatorPostLike: { groupBy: async () => [{ onlyFansPostId: "post-1", _count: { _all: 4 } }], count: async () => 4 },
    creatorPostComment: { groupBy: async () => [{ onlyFansPostId: "post-1", _count: { _all: 2 } }], count: async () => 2 },
    creatorSale: { aggregate: async () => ({ _sum: { amountCents: 700 }, _count: { _all: 1 } }) },
    creatorTip: { aggregate: async () => ({ _sum: { amountCents: 300 }, _count: { _all: 1 } }) },
    creatorSubscriptionEvent: { groupBy: async () => [] },
    creatorCampaign: { findMany: async () => [{ id: "campaign-1", name: "A", isActive: true, collectedAt: date, _count: { fans: 2 } }] },
    creatorCampaignFan: { groupBy: async () => [{ campaignId: "campaign-1", _count: { _all: 1 } }] },
    creatorNotificationSyncState: {
      findUnique: async () => ({
        status: "COMPLETE", mode: "full", pagesScanned: 100, eventsAccepted: 1000, eventsRejected: 0, ignoredEvents: 0,
        fullBackfillCompletedAt: new Date("2026-08-06T11:00:00.000Z"),
        fullBackfillVerifiedAt: new Date("2026-08-06T11:05:00.000Z"),
        oldestOccurredAt: new Date("2026-02-05T08:00:00.000Z"),
        newestOccurredAt: new Date("2026-08-05T22:00:00.000Z"),
        lastCatchupCompletedAt: new Date("2026-08-06T10:00:00.000Z"),
        lastSocketEventAt: new Date("2026-08-06T11:30:00.000Z"),
        lastErrorCode: null, lastErrorMessage: null,
      }),
    },
    analyticsCoverage: {
      findMany: async () => [{ dataType: "EARNINGS", coverageDate: date, status: "COMPLETE" }],
      count: async ({ where }) => !where.dataType ? 1 : where.dataType === "EARNINGS" && where.status === "COMPLETE" ? 1 : 0,
    },
    $queryRaw: async () => [{ campaignId: "campaign-1", totalRevenueCents: 1000n, salesRevenueCents: 700n, tipsRevenueCents: 300n, subscriptionRevenueCents: 0n, transactionsCount: 2n }],
  };
  const result = await readCreatorLedgerOverview({ db, creatorId: "creator-1", rangeKey: "7d", now: new Date("2026-08-06T12:00:00.000Z") });
  assert.equal(result.totals.totalCents, 1000);
  assert.equal(result.totals.subscriptionsCents, null);
  assert.equal(result.verification.earningsDays, 1);
  assert.equal(result.verification.officialEarnings, false);
  assert.equal(result.verification.messageDays, 0);
  assert.equal(result.totals.likesCount, 4);
  assert.equal(result.totals.commentsCount, 2);
  assert.equal(result.coveragePagination.total, 1);
  assert.equal(result.coveragePagination.hasMore, false);
  assert.equal(result.campaigns[0].totalRevenueCents, 1000);
  assert.equal(result.campaigns[0].unknownAttributionFans, 1);
  assert.equal(result.campaigns[0].revenueVerified, false);
  assert.equal(result.availability.activityFromAt.toISOString(), "2026-02-05T08:00:00.000Z");
  assert.equal(result.availability.activityToAt.toISOString(), "2026-08-06T11:30:00.000Z");
  assert.equal(result.availability.activityAvailableDays, 183);
});



test("today earnings are official only when the row and in-progress proof both exist", async () => {
  const date = new Date("2026-08-06T00:00:00.000Z");
  const db = {
    creatorEarningsDaily: { findMany: async () => [{ date, totalCents: 500, subscriptionsCents: null, messagesCents: null, tipsCents: null, postsCents: null, streamsCents: null, referralsCents: null }] },
    creatorMessagesDaily: { findMany: async () => [] },
    creatorPostLike: { groupBy: async () => [], count: async () => 0 }, creatorPostComment: { groupBy: async () => [], count: async () => 0 },
    creatorSale: { aggregate: async () => ({ _sum: { amountCents: null }, _count: { _all: 0 } }) },
    creatorTip: { aggregate: async () => ({ _sum: { amountCents: null }, _count: { _all: 0 } }) },
    creatorSubscriptionEvent: { groupBy: async () => [] }, creatorCampaign: { findMany: async () => [] },
    creatorCampaignFan: { groupBy: async () => [] },
    analyticsCoverage: {
      findMany: async () => [{ dataType: "EARNINGS", coverageDate: date, sourceTimezone: "UTC", status: "PARTIAL", lastErrorCode: "EARNINGS_DAY_IN_PROGRESS" }],
      count: async ({ where }) => !where.dataType ? 1 : where.dataType === "EARNINGS" && where.status === "PARTIAL" ? 1 : 0,
    },
    $queryRaw: async () => [],
  };
  const result = await readCreatorLedgerOverview({ db, creatorId: "creator-1", rangeKey: "24h", now: new Date("2026-08-06T12:00:00.000Z") });
  assert.equal(result.verification.officialEarnings, true);
  assert.equal(result.verification.earningsDays, 1);
  assert.equal(result.totals.totalCents, 500);
});

test("campaign fan reader scopes the campaign to the creator and pages concrete fan identities", async () => {
  const db = {
    creatorCampaign: { findFirst: async ({ where }) => where.creatorId === "creator-1" ? { id: "campaign-1", externalCampaignId: "of-campaign", name: "Link A", isActive: true } : null },
    creatorCampaignFan: {
      findMany: async () => [
        { id: "link-1", externalClaimerId: "claim-1", attributedAt: new Date("2026-08-01T00:00:00.000Z"), collectedAt: new Date("2026-08-02T00:00:00.000Z"), fan: { id: "fan-1", onlyFansUserId: "123", username: "alice", displayName: "Alice", firstSeenAt: new Date("2026-08-01T00:00:00.000Z"), lastSeenAt: new Date("2026-08-02T00:00:00.000Z") } },
        { id: "link-2", externalClaimerId: null, attributedAt: null, collectedAt: new Date("2026-08-02T00:00:00.000Z"), fan: { id: "fan-2", onlyFansUserId: "456", username: null, displayName: null, firstSeenAt: new Date("2026-08-01T00:00:00.000Z"), lastSeenAt: new Date("2026-08-02T00:00:00.000Z") } },
      ],
    },
  };
  const result = await readCampaignFans({ db, creatorId: "creator-1", campaignId: "campaign-1", limit: 1, offset: 0 });
  assert.equal(result.campaign.name, "Link A");
  assert.equal(result.fans.length, 1);
  assert.equal(result.fans[0].fan.onlyFansUserId, "123");
  assert.equal(result.pagination.hasMore, true);
  assert.equal(await readCampaignFans({ db, creatorId: "other", campaignId: "campaign-1" }), null);
});

test("chunk ingesters run inside the fenced Prisma transaction client without nesting transactions", async () => {
  const earningsHarness = batchHarness();
  earningsHarness.tx.creatorEarningsDaily = {
    findUnique: async () => null,
    upsert: async (args) => args.create,
  };
  const earnings = await ingestEarningsChunk({
    db: earningsHarness.tx,
    job,
    deviceId: "device-1",
    chunk: {
      kind: "earnings_daily_page",
      schemaVersion: 4,
      collectorVersion: "earnings-v4",
      scanRunId: "run-fenced-earnings",
      observedAt: "2026-08-06T12:00:00.000Z",
      batchKey: "run:run-fenced-earnings:daily:page-1",
      scannerRejected: 0,
      rows: [{ date: "2026-08-05", sourceTimezone: "UTC", totalCents: 100, currency: "USD" }],
    },
  });
  assert.equal(earnings.inserted, 1);

  const campaignHarness = batchHarness();
  campaignHarness.tx.creatorCampaign = {
    findUnique: async () => null,
    upsert: async (args) => args.create,
  };
  const campaigns = await ingestCampaignChunk({
    db: campaignHarness.tx,
    job,
    deviceId: "device-1",
    chunk: {
      kind: "campaigns_page",
      schemaVersion: 4,
      collectorVersion: "campaigns-v6",
      scanRunId: "run-fenced-campaigns",
    scanStartedAt: "2026-08-06T11:00:00.000Z",
      observedAt: "2026-08-06T12:00:00.000Z",
      batchKey: "run:run-fenced-campaigns:campaigns:page-1",
      scannerRejected: 0,
      campaigns: [{ id: "campaign-1", name: "Campaign one", is_active: true }],
    },
  });
  assert.equal(campaigns.inserted, 1);
});

test("earnings pages and completion are fenced to the claimed job range", async () => {
  const harness = batchHarness();
  harness.tx.creatorEarningsDaily = {
    findUnique: async () => null,
    upsert: async (args) => args.create,
    count: async () => 0,
  };
  await assert.rejects(
    ingestEarningsChunk({
      db: harness.db,
      job,
      chunk: {
        kind: "earnings_daily_page",
        schemaVersion: 4,
        collectorVersion: "earnings-v4",
        scanRunId: "run-outside-range",
        observedAt: "2026-08-06T12:00:00.000Z",
        batchKey: "run:run-outside-range:daily:page-1",
        scannerRejected: 0,
        rows: [{ date: "2026-07-30", sourceTimezone: "UTC", totalCents: 100, currency: "USD" }],
      },
    }),
    /outside the job range/,
  );
  await assert.rejects(
    completeEarningsScan({
      db: harness.db,
      job,
      result: {
        schemaVersion: 4,
        collectorVersion: "earnings-v4",
        scanRunId: "run-wrong-range",
        observedAt: "2026-08-06T12:00:00.000Z",
        range: { startDate: "2026-08-01", endDate: "2026-08-06" },
        dailyBatchCount: 1,
        dailyCount: 6,
        scannerRejected: 0,
        chartComplete: true,
        dailyComplete: true,
      },
    }),
    /does not match the claimed job/,
  );
});


test("older campaign pages are superseded once a newer generation has reached ingest", async () => {
  const harness = batchHarness({ latestBatch: { rangeFrom: new Date("2026-08-06T12:00:00.000Z") } });
  let touchedCampaigns = false;
  harness.tx.creatorCampaign = {
    findUnique: async () => { touchedCampaigns = true; return null; },
    upsert: async () => { touchedCampaigns = true; return {}; },
  };
  const result = await ingestCampaignChunk({
    db: harness.db,
    job,
    deviceId: "device-1",
    chunk: {
      kind: "campaigns_page",
      schemaVersion: 4,
      collectorVersion: "campaigns-v6",
      scanRunId: "older-run",
      scanStartedAt: "2026-08-06T11:00:00.000Z",
      observedAt: "2026-08-06T13:00:00.000Z",
      batchKey: "run:older-run:campaigns:page-1",
      scannerRejected: 0,
      campaigns: [{ id: "campaign-old", name: "Old scan campaign", is_active: true }],
    },
  });
  assert.equal(result.superseded, true);
  assert.equal(result.unchanged, 1);
  assert.equal(touchedCampaigns, false);
  assert.equal(harness.updated.at(-1).status, "COMMITTED");
});

test("older campaign completion cannot deactivate or overwrite coverage after a newer generation starts", async () => {
  const harness = batchHarness({ latestBatch: { rangeFrom: new Date("2026-08-06T12:00:00.000Z") } });
  let deactivated = false;
  harness.tx.creatorCampaign = {
    count: async () => 1,
    updateMany: async () => { deactivated = true; return { count: 1 }; },
  };
  const result = await completeCampaignScan({
    db: harness.db,
    job,
    deviceId: "device-1",
    result: {
      schemaVersion: 4,
      collectorVersion: "campaigns-v6",
      scanRunId: "older-run",
      scanStartedAt: "2026-08-06T11:00:00.000Z",
      observedAt: "2026-08-06T13:00:00.000Z",
      campaignPagesComplete: true,
      claimersComplete: true,
      truncated: false,
      campaignCount: 1,
      campaignBatchCount: 1,
      claimerBatchCount: 0,
    },
  });
  assert.equal(result.superseded, true);
  assert.equal(result.complete, true);
  assert.equal(deactivated, false);
  assert.equal(harness.coverage.length, 0);
});

test("campaign ingest takes a transaction-scoped advisory lock before reading generation state", async () => {
  const calls = [];
  const harness = batchHarness();
  harness.tx.$executeRawUnsafe = async (sql, value) => { calls.push([sql, value]); return 1; };
  harness.tx.creatorCampaign = { findUnique: async () => null, upsert: async (args) => args.create };
  await ingestCampaignChunk({
    db: harness.db,
    job,
    chunk: {
      kind: "campaigns_page",
      schemaVersion: 4,
      collectorVersion: "campaigns-v6",
      scanRunId: "lock-run",
      scanStartedAt: "2026-08-06T11:00:00.000Z",
      observedAt: "2026-08-06T12:00:00.000Z",
      batchKey: "run:lock-run:campaigns:page-1",
      scannerRejected: 0,
      campaigns: [],
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /pg_advisory_xact_lock/);
  assert.match(calls[0][1], /^-?\d+$/);
});


test("coverage reader pages on the server and reports the real total", async () => {
  const date = new Date("2026-08-05T00:00:00.000Z");
  const calls = [];
  const db = {
    analyticsCoverage: {
      findMany: async (args) => { calls.push(args); return [
        { dataType: "EARNINGS", coverageDate: date, status: "COMPLETE" },
        { dataType: "MESSAGES_DAILY", coverageDate: date, status: "COMPLETE" },
      ]; },
      count: async () => 7,
    },
  };
  const page = await readCreatorCoverage({ db, creatorId: "creator-1", rangeKey: "7d", limit: 1, offset: 2, now: new Date("2026-08-06T12:00:00.000Z") });
  assert.equal(calls[0].skip, 2);
  assert.equal(calls[0].take, 2);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].coverageDate, "2026-08-05");
  assert.deepEqual(page.pagination, { limit: 1, offset: 2, returned: 1, total: 7, hasMore: true });
});

test("earnings ingest serializes writers and never lets an older observation overwrite a newer day", async () => {
  const harness = batchHarness();
  const locks = [];
  let writes = 0;
  harness.tx.$executeRawUnsafe = async (sql, value) => { locks.push({ sql, value }); return 1; };
  harness.tx.creatorEarningsDaily = {
    findUnique: async () => ({ id: "daily-newer", collectedAt: new Date("2026-08-06T13:00:00.000Z") }),
    upsert: async () => { writes += 1; },
  };
  const result = await ingestEarningsChunk({
    db: harness.db,
    job,
    deviceId: "device-1",
    chunk: {
      kind: "earnings_daily_page",
      schemaVersion: 4,
      collectorVersion: "earnings-v4",
      scanRunId: "run-older",
      observedAt: "2026-08-06T12:00:00.000Z",
      batchKey: "run:run-older:daily:page-1",
      scannerRejected: 0,
      rows: [{ date: "2026-08-05", sourceTimezone: "UTC", totalCents: 100, currency: "USD" }],
    },
  });
  assert.equal(locks.length, 1);
  assert.match(locks[0].sql, /pg_advisory_xact_lock/);
  assert.equal(writes, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(harness.coverage.length, 0);
  assert.equal(harness.updated.at(-1).unchangedRows, 1);
});

test("earnings completion accepts rows preserved or superseded by another overlapping range", async () => {
  const harness = batchHarness({ pageBatches: [{ id: "page-a", status: "COMMITTED", receivedRows: 7, rejectedRows: 0 }] });
  let countWhere = null;
  harness.tx.creatorEarningsDaily = {
    count: async ({ where }) => { countWhere = where; return 7; },
  };
  const result = await completeEarningsScan({
    db: harness.db,
    job,
    result: {
      schemaVersion: 4,
      collectorVersion: "earnings-v4",
      scanRunId: "run-overlap",
      observedAt: "2026-08-06T12:00:00.000Z",
      range: { startDate: "2026-07-31", endDate: "2026-08-06" },
      dailyBatchCount: 1,
      dailyCount: 7,
      scannerRejected: 0,
      chartComplete: true,
      dailyComplete: true,
    },
  });
  assert.equal(result.complete, true);
  assert.equal(Object.hasOwn(countWhere, "sourceScanRunId"), false);
  assert.deepEqual(Object.keys(countWhere).sort(), ["creatorId", "date"]);
});

test("an incomplete message ledger cannot downgrade a complete day from another device", async () => {
  const harness = batchHarness({ existingCoverage: { status: "COMPLETE" } });
  const locks = [];
  let writes = 0;
  harness.tx.$executeRawUnsafe = async (sql, value) => { locks.push({ sql, value }); return 1; };
  harness.tx.creatorMessagesDaily = {
    findUnique: async () => ({ id: "messages-complete", collectedAt: new Date("2026-08-05T10:00:00.000Z") }),
    upsert: async () => { writes += 1; },
  };
  const result = await upsertMessagesDaily({
    db: harness.db,
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-partial",
    localCoverage: { complete: false, knownDialogs: 10, incompleteDialogs: 1, messagesIndexed: 100, oldestMessageAt: "2026-07-01T00:00:00.000Z", newestMessageAt: "2026-08-06T11:00:00.000Z" },
    syncId: "4c7df5b9-05c3-41cd-bbb7-8f793d3b255a",
    observedAt: "2026-08-06T12:00:00.000Z",
    rows: [{ date: "2026-08-05", sourceTimezone: "UTC", incomingMessages: 1, outgoingMessages: 1, totalMessages: 2, uniqueDialogs: 1, uniqueIncomingFans: 1, uniqueOutgoingFans: 1 }],
  });
  assert.equal(locks.length, 1);
  assert.equal(writes, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(harness.coverage.length, 0);
  assert.equal(harness.updated.at(-1).status, "COMMITTED");
  assert.equal(harness.updated.at(-1).unchangedRows, 1);
});

test("a complete local message proof can upgrade a newer partial row without losing the stronger evidence", async () => {
  const harness = batchHarness({ existingCoverage: { status: "PARTIAL" } });
  const upserts = [];
  harness.tx.creatorMessagesDaily = {
    findUnique: async () => ({ id: "messages-partial", collectedAt: new Date("2026-08-06T13:00:00.000Z") }),
    upsert: async (args) => { upserts.push(args); return args.update; },
  };
  const result = await upsertMessagesDaily({
    db: harness.db,
    agencyId: "agency-1",
    creatorId: "creator-1",
    sourceDeviceId: "device-complete",
    localCoverage: { complete: true, knownDialogs: 10, incompleteDialogs: 0, messagesIndexed: 120, oldestMessageAt: "2026-07-01T00:00:00.000Z", newestMessageAt: "2026-08-06T11:00:00.000Z" },
    syncId: "7bd268cf-dd83-457c-9757-17b5ca6b5716",
    observedAt: "2026-08-06T12:00:00.000Z",
    rows: [{ date: "2026-08-05", sourceTimezone: "UTC", incomingMessages: 2, outgoingMessages: 3, totalMessages: 5, uniqueDialogs: 2, uniqueIncomingFans: 1, uniqueOutgoingFans: 2 }],
  });
  assert.equal(upserts.length, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(harness.coverage[0].create.status, "COMPLETE");
});
