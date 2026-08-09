"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FULL_HISTORY_FROM,
  buildNotificationScanParams,
  recordNotificationPageProgress,
  completeNotificationSync,
  recordNotificationSocketEvent,
} = require("./notification-sync-state-service");

function fakeDb(initial = null) {
  let state = initial ? { ...initial } : null;
  return {
    creatorNotificationSyncState: {
      async findUnique() { return state ? { ...state } : null; },
      async upsert({ create, update }) {
        state = state ? { ...state, ...update } : { id: "sync-1", ...create };
        return { ...state };
      },
    },
    read() { return state ? { ...state } : null; },
  };
}

const job = { id: "job-1", agencyId: "agency-1", creatorId: "creator-1" };

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

test("after source traversal the next scan is a short ALL catch-up to the previous head", () => {
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
  assert.equal(params.from, "2026-08-06T18:00:00.000Z");
  assert.equal(params.stopAtNotificationId, "notification-head-1");
});

test("a legacy completed traversal is adopted as the historical baseline instead of replaying full history", () => {
  const params = buildNotificationScanParams({
    state: {
      fullBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
      fullBackfillVerifiedAt: null,
      newestOccurredAt: new Date("2026-08-06T20:00:00.000Z"),
      headNotificationId: "notification-head-1",
    },
    now: new Date("2026-08-06T21:00:00.000Z"),
  });
  assert.equal(params.notificationMode, "catchup");
  assert.equal(params.from, "2026-08-06T18:00:00.000Z");
  assert.equal(params.stopAtNotificationId, "notification-head-1");
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
    db, job, deviceId: "device-1",
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
  assert.equal(state.fullBackfillVerifiedAt, null);
  assert.equal(state.nextCursor, null);

  const completedAt = state.fullBackfillCompletedAt;
  await new Promise((resolve) => setTimeout(resolve, 2));
  await completeNotificationSync({
    db, job, deviceId: "device-1", successful: true,
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

test("old full completion without ALL exhaustion cannot certify the six-source backfill", async () => {
  const oldVerifiedAt = new Date("2026-08-01T00:00:00.000Z");
  const db = fakeDb({
    id: "sync-1", agencyId: "agency-1", creatorId: "creator-1",
    scanRunId: "legacy-v6-run", fullBackfillCompletedAt: oldVerifiedAt, fullBackfillVerifiedAt: oldVerifiedAt,
  });
  await completeNotificationSync({
    db, job, deviceId: "device-1", successful: true,
    result: {
      notificationMode: "full", sourceExhausted: true, scanRunId: "legacy-v6-run",
      headNotificationId: "head-v6", tailNotificationId: "tail-v6",
      coverage: { purchases: { pages: 20 } },
    },
  });
  const state = db.read();
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.fullBackfillVerifiedAt, null);
  assert.equal(state.nextCursor, "tail-v6");
  assert.equal(state.lastErrorCode, "NOTIFICATION_SCAN_PARTIAL");
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
