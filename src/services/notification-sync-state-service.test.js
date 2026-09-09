"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };

const {
  FULL_HISTORY_FROM,
  buildNotificationScanParams,
  recordNotificationPageProgress,
  completeNotificationSync,
  recordNotificationSyncFailure,
  recordNotificationSocketEvent,
} = require("./notification-sync-state-service");

function fakeDb(initial = null, scanItems = []) {
  let state = initial ? { ...initial } : null;
  return {
    creatorNotificationSyncState: {
      async findUnique() { return state ? { ...state } : null; },
      async upsert({ create, update }) {
        state = state ? { ...state, ...update } : { id: "sync-1", ...create };
        return { ...state };
      },
    },
    creatorNotificationScanItem: {
      async findMany({ where }) {
        return scanItems.filter((row) => !where?.sourceJobId || row.sourceJobId === where.sourceJobId);
      },
    },
    read() { return state ? { ...state } : null; },
  };
}

function notificationJob(scanRunId, notificationMode = "full", requestedAt = "2026-08-06T21:00:00.000Z") {
  return {
    id: `job-${scanRunId}`, agencyId: "agency-1", creatorId: "creator-1",
    params: {
      collectionContractVersion: 1,
      collectionType: "NOTIFICATIONS",
      collectionMode: notificationMode,
      collectionGeneration: scanRunId,
      collectionRequestedAt: requestedAt,
      collectionReason: "test",
      notificationMode,
    },
  };
}

const job = notificationJob("scan-run-0001", "full");

test("initial notification scan is one ALL traversal from the beginning of supported history", () => {
  const now = new Date("2026-08-06T21:00:00.000Z");
  const params = buildNotificationScanParams({ state: null, now, reason: "manual", analyticsRangeKey: "30d" });
  assert.equal(params.from, FULL_HISTORY_FROM.toISOString());
  assert.equal(params.to, "2026-08-06T21:05:00.000Z");
  assert.equal(params.notificationMode, "full");
  assert.deepEqual(params.types, ["purchases", "tips", "subscriptions", "likes", "comments"]);
  assert.equal(params.pageLimit, 10);
  assert.equal("backfillWindow" in params, false);
  assert.equal("resumeCursors" in params, false);
});

test("a future-poisoned baseline timestamp cannot unlock notification catch-up", () => {
  const now = new Date("2026-08-06T21:00:00.000Z");
  const params = buildNotificationScanParams({
    state: {
      fullBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
      fullBackfillVerifiedAt: new Date("2026-08-06T22:00:00.000Z"),
      headNotificationId: "poisoned-head",
    },
    now,
  });
  assert.equal(params.notificationMode, "full");
  assert.equal(params.from, FULL_HISTORY_FROM.toISOString());
  assert.equal("stopAtNotificationId" in params, false);
});

test("after verified source traversal catch-up is bounded by the durable ID frontier, never realtime wall clock", () => {
  const params = buildNotificationScanParams({
    state: {
      fullBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
      fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      newestOccurredAt: new Date("2026-08-06T20:00:00.000Z"),
      headNotificationId: "notification-head-1",
    },
    now: new Date("2026-08-06T21:00:00.000Z"),
  });
  assert.equal(params.notificationMode, "catchup");
  assert.equal(params.from, FULL_HISTORY_FROM.toISOString());
  assert.equal(params.stopAtNotificationId, "notification-head-1");
});

test("a realtime socket event cannot move the catch-up event floor across an unverified offline gap", async () => {
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    fullBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    newestOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "notification-head-verified",
  });
  await recordNotificationSocketEvent({
    db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-1",
    occurredAt: new Date("2026-09-01T12:00:00.000Z"),
  });
  const params = buildNotificationScanParams({
    state: db.read(),
    now: new Date("2026-09-01T12:01:00.000Z"),
  });
  assert.equal(params.notificationMode, "catchup");
  assert.equal(params.from, FULL_HISTORY_FROM.toISOString());
  assert.equal(params.stopAtNotificationId, "notification-head-verified");
});

test("a completed-but-unverified traversal remains FULL repair work instead of becoming proof", () => {
  const params = buildNotificationScanParams({
    state: {
      fullBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
      fullBackfillVerifiedAt: null,
      newestOccurredAt: new Date("2026-08-06T20:00:00.000Z"),
      headNotificationId: "notification-head-1",
    },
    now: new Date("2026-08-06T21:00:00.000Z"),
  });
  assert.equal(params.notificationMode, "full");
  assert.equal(params.from, FULL_HISTORY_FROM.toISOString());
  assert.equal(params.stopAtNotificationId, undefined);
});

test("page progress is replay-idempotent and advances only to the backend-confirmed cursor", async () => {
  const db = fakeDb();
  const chunk = {
    scanRunId: "scan-run-0001",
    notificationMode: "full",
    page: 7,
    cursorEnd: "cursor-7",
    headNotificationId: "head-1",
    tailNotificationId: "cursor-7",
    sourceExhausted: false,
    totalAcceptedRows: 135,
    totalRejectedRows: 2,
    totalIgnoredRows: 11,
    batches: [{ events: [{ occurredAt: "2026-08-06T20:00:00.000Z" }] }],
  };
  await recordNotificationPageProgress({ db, job, deviceId: "device-1", chunk });
  await recordNotificationPageProgress({ db, job, deviceId: "device-1", chunk });
  const state = db.read();
  assert.equal(state.nextCursor, "cursor-7");
  assert.equal(state.pagesScanned, 7);
  assert.equal(state.eventsAccepted, 135);
  assert.equal(state.eventsRejected, 2);
  assert.equal(state.ignoredEvents, 11);
});

test("a new scan run resets run counters without losing historical time bounds", async () => {
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    scanRunId: "scan-run-old", pagesScanned: 900, eventsAccepted: 50_000,
    eventsRejected: 3, ignoredEvents: 500,
    oldestOccurredAt: new Date("2019-01-01T00:00:00.000Z"),
    newestOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  await recordNotificationPageProgress({
    db, job: notificationJob("scan-run-new", "catchup"), deviceId: "device-1",
    chunk: {
      scanRunId: "scan-run-new", notificationMode: "catchup", page: 1,
      cursorEnd: "cursor-new", headNotificationId: "head-new", tailNotificationId: "cursor-new",
      sourceExhausted: false, totalAcceptedRows: 4, totalRejectedRows: 0, totalIgnoredRows: 2,
      batches: [{ events: [{ occurredAt: "2026-08-06T20:00:00.000Z" }] }],
    },
  });
  const state = db.read();
  assert.equal(state.pagesScanned, 1);
  assert.equal(state.eventsAccepted, 4);
  assert.equal(state.eventsRejected, 0);
  assert.equal(state.ignoredEvents, 2);
  assert.equal(state.oldestOccurredAt.toISOString(), "2019-01-01T00:00:00.000Z");
  assert.equal(state.newestOccurredAt.toISOString(), "2026-08-06T20:00:00.000Z");
});

test("source exhaustion records completed traversal while verification remains separate", async () => {
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    scanRunId: "scan-run-0001", pagesScanned: 20, eventsAccepted: 500,
    eventsRejected: 1, ignoredEvents: 10,
    fullBackfillVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  await completeNotificationSync({
    db, job, deviceId: "device-1", successful: false,
    result: {
      notificationMode: "full", sourceExhausted: true, allSourceExhausted: true, scanRunId: "scan-run-0001",
      headNotificationId: "head-1", tailNotificationId: "tail-1",
      coverage: { purchases: { pages: 20 } },
    },
  });
  let state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.ok(state.fullBackfillCompletedAt instanceof Date);
  assert.equal(state.fullBackfillVerifiedAt.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(state.nextCursor, null);

  const completedAt = state.fullBackfillCompletedAt;
  await new Promise((resolve) => setTimeout(resolve, 2));
  await completeNotificationSync({
    db, job: notificationJob("scan-run-0002", "full", "2026-08-06T21:01:00.000Z"), deviceId: "device-1", successful: true,
    result: {
      notificationMode: "full", sourceExhausted: true, allSourceExhausted: true, scanRunId: "scan-run-0002",
      headNotificationId: "head-2", tailNotificationId: "tail-2",
      coverage: { purchases: { pages: 21 } },
    },
  });
  state = db.read();
  assert.equal(state.status, "COMPLETE");
  assert.equal(state.fullBackfillCompletedAt, completedAt);
  assert.ok(state.fullBackfillVerifiedAt instanceof Date);
  assert.ok(state.fullBackfillVerifiedAt.getTime() >= completedAt.getTime());
});

test("a new forced FULL failure preserves the previous verified frontier and baseline", async () => {
  const oldVerifiedAt = new Date("2026-08-01T00:00:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    status: "COMPLETE", mode: "catchup", scanRunId: "old-catchup-run",
    fullBackfillCompletedAt: oldVerifiedAt, fullBackfillVerifiedAt: oldVerifiedAt,
    headNotificationId: "verified-head-old",
    knownNotificationIds: ["verified-head-old", "verified-neighbor"],
  });
  await completeNotificationSync({
    db, job: notificationJob("forced-full-new", "full", "2026-08-06T22:00:00.000Z"), deviceId: "device-1", successful: false,
    result: {
      notificationMode: "full", sourceExhausted: true, allSourceExhausted: true, scanRunId: "forced-full-new",
      headNotificationId: "unverified-head-new", tailNotificationId: "tail-new",
      coverage: { purchases: { pages: 20 } },
    },
  });
  const state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.fullBackfillVerifiedAt, oldVerifiedAt);
  assert.equal(state.headNotificationId, "verified-head-old");
  assert.deepEqual(state.knownNotificationIds, ["verified-head-old", "verified-neighbor"]);
  assert.equal(state.lastErrorCode, "NOTIFICATION_FACTS_PARTIAL");
});

test("partial FULL cannot preserve a future-poisoned historical baseline as proof", async () => {
  const futurePoisonedAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    status: "COMPLETE", mode: "full", scanRunId: "old-poisoned-run",
    fullBackfillCompletedAt: futurePoisonedAt, fullBackfillVerifiedAt: futurePoisonedAt,
    headNotificationId: "old-head", knownNotificationIds: ["old-head"],
  });
  await completeNotificationSync({
    db, job: notificationJob("repair-full", "full"), deviceId: "device-1", successful: false,
    result: {
      notificationMode: "full", sourceExhausted: true, allSourceExhausted: true, scanRunId: "repair-full",
      headNotificationId: "repair-head", tailNotificationId: "repair-tail", coverage: { purchases: { pages: 2 } },
    },
  });
  const state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.fullBackfillVerifiedAt, null);
  assert.equal(state.lastErrorCode, "NOTIFICATION_FACTS_PARTIAL");
});

test("a partial later FULL cannot erase an already durable historical baseline", async () => {
  const oldVerifiedAt = new Date("2026-08-01T00:00:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    scanRunId: "legacy-v6-run", fullBackfillCompletedAt: oldVerifiedAt, fullBackfillVerifiedAt: oldVerifiedAt,
  });
  await completeNotificationSync({
    db, job: notificationJob("legacy-v6-run", "full"), deviceId: "device-1", successful: true,
    result: {
      notificationMode: "full", sourceExhausted: true, scanRunId: "legacy-v6-run",
      headNotificationId: "head-v6", tailNotificationId: "tail-v6",
      coverage: { purchases: { pages: 20 } },
    },
  });
  const state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.fullBackfillVerifiedAt, oldVerifiedAt);
  assert.equal(state.nextCursor, "tail-v6");
  assert.equal(state.lastErrorCode, "NOTIFICATION_SCAN_PARTIAL");
});

test("catch-up page progress cannot advance the durable verified frontier before completion proof", async () => {
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    status: "COMPLETE", mode: "catchup",
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "verified-head-old",
    knownNotificationIds: ["verified-head-old", "verified-neighbor"],
  });
  const catchupJob = notificationJob("scan-run-catchup-frontier", "catchup", "2026-08-06T21:02:00.000Z");
  await recordNotificationPageProgress({
    db, job: catchupJob, deviceId: "device-1",
    chunk: {
      scanRunId: "scan-run-catchup-frontier", notificationMode: "catchup", page: 1,
      cursorEnd: "new-tail", headNotificationId: "new-unverified-head", tailNotificationId: "new-tail",
      sourceExhausted: false, totalAcceptedRows: 2, totalRejectedRows: 1, totalIgnoredRows: 0,
      auditItems: [
        { notificationId: "new-unverified-head" },
        { notificationId: "new-unverified-neighbor" },
      ],
      batches: [{ events: [{ occurredAt: "2026-08-06T20:30:00.000Z" }] }],
    },
  });
  const state = db.read();
  assert.equal(state.status, "SCANNING");
  assert.equal(state.headNotificationId, "verified-head-old");
  assert.deepEqual(state.knownNotificationIds, ["verified-head-old", "verified-neighbor"]);
  assert.equal(state.tailNotificationId, "new-tail");
});

test("verified catch-up atomically promotes the new head and verified known-ID frontier", async () => {
  const catchupJob = notificationJob("scan-run-catchup-promote", "catchup", "2026-08-06T21:03:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    status: "SCANNING", mode: "catchup", scanRunId: "scan-run-catchup-promote",
    activeGeneration: "scan-run-catchup-promote", activeRequestedAt: new Date("2026-08-06T21:03:00.000Z"),
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "verified-head-old",
    knownNotificationIds: ["verified-head-old"],
  }, [
    { sourceJobId: catchupJob.id, notificationId: "new-head" },
    { sourceJobId: catchupJob.id, notificationId: "new-neighbor" },
    { sourceJobId: catchupJob.id, notificationId: "new-neighbor" },
  ]);
  await completeNotificationSync({
    db, job: catchupJob, deviceId: "device-1", successful: true,
    result: {
      notificationMode: "catchup", sourceExhausted: true, scanRunId: "scan-run-catchup-promote",
      headNotificationId: "new-head", tailNotificationId: "verified-head-old",
      coverage: { purchases: { pages: 1 } },
    },
  });
  const state = db.read();
  assert.equal(state.status, "COMPLETE");
  assert.equal(state.headNotificationId, "new-head");
  assert.deepEqual(state.knownNotificationIds, ["new-head", "new-neighbor"]);
  assert.ok(state.lastCatchupVerifiedAt instanceof Date);
});

test("partial catch-up preserves the previous verified frontier instead of skipping rejected facts", async () => {
  const catchupJob = notificationJob("scan-run-catchup-partial", "catchup", "2026-08-06T21:04:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    status: "SCANNING", mode: "catchup", scanRunId: "scan-run-catchup-partial",
    activeGeneration: "scan-run-catchup-partial", activeRequestedAt: new Date("2026-08-06T21:04:00.000Z"),
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    headNotificationId: "verified-head-old",
    knownNotificationIds: ["verified-head-old", "verified-neighbor"],
  }, [{ sourceJobId: catchupJob.id, notificationId: "new-unverified-head" }]);
  await completeNotificationSync({
    db, job: catchupJob, deviceId: "device-1", successful: false,
    result: {
      notificationMode: "catchup", sourceExhausted: true, scanRunId: "scan-run-catchup-partial",
      headNotificationId: "new-unverified-head", tailNotificationId: "verified-head-old",
      coverage: { purchases: { pages: 1 } },
    },
  });
  const state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.headNotificationId, "verified-head-old");
  assert.deepEqual(state.knownNotificationIds, ["verified-head-old", "verified-neighbor"]);
  assert.equal(state.lastCatchupVerifiedAt, undefined);
  assert.ok(state.lastCatchupCompletedAt instanceof Date);
});

test("notification page rejects a mismatched server collection generation before state mutation", async () => {
  const db = fakeDb();
  await assert.rejects(
    () => recordNotificationPageProgress({
      db, job: notificationJob("scan-run-authority", "full"), deviceId: "device-1",
      chunk: { scanRunId: "scan-run-stale", notificationMode: "full", page: 1, batches: [] },
    }),
    (error) => error?.code === "ANALYTICS_COLLECTION_GENERATION_MISMATCH"
  );
  assert.equal(db.read(), null);
});

test("notification completion rejects mismatched generation before durable completion state changes", async () => {
  const baseline = { id: "sync-1", agencyId: "agency-1", creatorId: "creator-1", status: "SCANNING", scanRunId: "scan-run-authority" };
  const db = fakeDb(baseline);
  await assert.rejects(
    () => completeNotificationSync({
      db, job: notificationJob("scan-run-authority", "full"), deviceId: "device-1", successful: true,
      result: { notificationMode: "full", scanRunId: "scan-run-stale", sourceExhausted: true, allSourceExhausted: true },
    }),
    (error) => error?.code === "ANALYTICS_COLLECTION_GENERATION_MISMATCH"
  );
  assert.deepEqual(db.read(), baseline);
});

test("newer notification generation cannot be rolled back by stale page or failure", async () => {
  const db = fakeDb();
  const newer = notificationJob("scan-run-newer", "catchup", "2026-08-06T21:02:00.000Z");
  await recordNotificationPageProgress({
    db, job: newer, deviceId: "device-new",
    chunk: { scanRunId: "scan-run-newer", notificationMode: "catchup", page: 1, cursorEnd: "cursor-new", batches: [] },
  });
  const before = db.read();
  const older = notificationJob("scan-run-older", "catchup", "2026-08-06T21:01:00.000Z");
  await assert.rejects(
    () => recordNotificationPageProgress({
      db, job: older, deviceId: "device-old",
      chunk: { scanRunId: "scan-run-older", notificationMode: "catchup", page: 1, cursorEnd: "cursor-old", batches: [] },
    }),
    (error) => error?.code === "ANALYTICS_COLLECTION_GENERATION_STALE"
  );
  const { recordNotificationSyncFailure } = require("./notification-sync-state-service");
  const afterFailure = await recordNotificationSyncFailure({ db, job: older, deviceId: "device-old", error: new Error("late failure") });
  assert.equal(afterFailure.activeGeneration, "scan-run-newer");
  assert.deepEqual(db.read(), before);
});

test("same notification generation replay cannot downgrade COMPLETE to SCANNING", async () => {
  const authorityJob = notificationJob("scan-run-complete", "full", "2026-08-06T21:03:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1", status: "COMPLETE", mode: "full",
    scanRunId: "scan-run-complete", activeGeneration: "scan-run-complete", activeRequestedAt: new Date("2026-08-06T21:03:00.000Z"),
    fullBackfillCompletedAt: new Date("2026-08-06T21:03:10.000Z"), fullBackfillVerifiedAt: new Date("2026-08-06T21:03:10.000Z"),
  });
  await recordNotificationPageProgress({
    db, job: authorityJob, deviceId: "device-1",
    chunk: { scanRunId: "scan-run-complete", notificationMode: "full", page: 99, cursorEnd: "late", batches: [] },
  });
  assert.equal(db.read().status, "COMPLETE");
  assert.equal(db.read().pagesScanned, undefined);
});

test("live facts cannot falsely verify an incomplete historical backfill", async () => {
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    status: "PARTIAL", mode: "full", fullBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
    fullBackfillVerifiedAt: null,
  });
  await recordNotificationSocketEvent({
    db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-1",
    occurredAt: "2026-08-06T21:00:00.000Z",
  });
  const state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.mode, "full");
  assert.equal(state.lastSocketEventAt.toISOString(), "2026-08-06T21:00:00.000Z");
});

test("notification failure persists the Job retry boundary and retry page clears DEFERRED state", async () => {
  const authorityJob = notificationJob("scan-run-retry", "catchup", "2026-08-06T21:04:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1", status: "SCANNING", mode: "catchup",
    scanRunId: "scan-run-retry", activeGeneration: "scan-run-retry", activeRequestedAt: new Date("2026-08-06T21:04:00.000Z"),
    fullBackfillVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  const retryAt = new Date("2026-08-06T21:09:00.000Z");
  await recordNotificationSyncFailure({ db, job: authorityJob, error: new Error("provider timeout"), terminal: false, retryAfterAt: retryAt });
  let state = db.read();
  assert.equal(state.status, "FAILED");
  assert.equal(state.retryAfterAt.toISOString(), retryAt.toISOString());

  await recordNotificationPageProgress({
    db, job: authorityJob, deviceId: "device-1",
    chunk: { scanRunId: "scan-run-retry", notificationMode: "catchup", page: 1, cursorEnd: "cursor-retry", batches: [] },
  });
  state = db.read();
  assert.equal(state.status, "SCANNING");
  assert.equal(state.retryAfterAt, null);
  assert.equal(state.lastErrorCode, null);
});

test("terminal notification failure is quarantined without retryAfterAt", async () => {
  const authorityJob = notificationJob("scan-run-terminal", "full", "2026-08-06T21:05:00.000Z");
  const db = fakeDb();
  await recordNotificationSyncFailure({
    db, job: authorityJob, error: Object.assign(new Error("contract rejected"), { code: "CONTRACT_REJECTED" }),
    terminal: true, retryAfterAt: new Date("2026-08-06T22:00:00.000Z"),
  });
  const state = db.read();
  assert.equal(state.status, "FAILED");
  assert.equal(state.retryAfterAt, null);
  assert.equal(state.lastErrorCode, "CONTRACT_REJECTED");
});

test("socket realtime provenance never overwrites collection-control state", async () => {
  const retryAt = new Date("2026-08-06T22:00:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1", status: "FAILED", mode: "catchup",
    activeGeneration: "scan-run-control", activeRequestedAt: new Date("2026-08-06T21:00:00.000Z"),
    retryAfterAt: retryAt, lastErrorCode: "PROVIDER_TIMEOUT", lastErrorMessage: "timeout",
  });
  await recordNotificationSocketEvent({ db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-live", occurredAt: "2026-08-06T21:30:00.000Z" });
  const state = db.read();
  assert.equal(state.status, "FAILED");
  assert.equal(state.mode, "catchup");
  assert.equal(state.activeGeneration, "scan-run-control");
  assert.equal(state.retryAfterAt.toISOString(), retryAt.toISOString());
  assert.equal(state.lastErrorCode, "PROVIDER_TIMEOUT");
  assert.equal(state.lastSocketEventAt.toISOString(), "2026-08-06T21:30:00.000Z");
});

