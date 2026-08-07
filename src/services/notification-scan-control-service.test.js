"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const prismaPath = require.resolve("../prisma");
const schedulerPath = require.resolve("./job-scheduler");
const syncPath = require.resolve("./notification-sync-state-service");
const servicePath = require.resolve("./notification-scan-control-service");

let scheduledInput = null;
let syncState = null;
cacheModule(prismaPath, {});
cacheModule(schedulerPath, {
  async scheduleJobNow(input) {
    scheduledInput = input;
    return {
      reason: "created",
      job: {
        id: "manual-job-new",
        creatorId: input.creatorId,
        agencyId: input.agencyId,
        jobKey: input.jobKey,
        status: "SCHEDULED",
        params: input.params,
        createdAt: input.now,
        scheduledAt: input.now,
      },
    };
  },
});
cacheModule(syncPath, {
  async loadNotificationSyncState() { return syncState; },
  buildNotificationScanParams({ state }) {
    return {
      from: "2016-01-01T00:00:00.000Z",
      to: "2026-08-07T14:00:00.000Z",
      types: ["purchases", "tips", "subscriptions", "likes", "comments"],
      notificationMode: state?.fullBackfillVerifiedAt ? "catchup" : "full",
      pageLimit: 10,
      analyticsRangeKey: "all",
    };
  },
});
delete require.cache[servicePath];
const {
  startManualNotificationScan,
  stopManualNotificationScan,
  recordNotificationScanItems,
  readManualNotificationScan,
} = require("./notification-scan-control-service");

const creator = { id: "creator-1", agencyId: "agency-1" };

function manualJob(overrides = {}) {
  return {
    id: "manual-job-1",
    creatorId: creator.id,
    agencyId: creator.agencyId,
    jobKey: "catchup_notifications_scan",
    status: "DONE",
    params: { manualNotificationScan: true, manualNotificationScanVersion: 1, notificationMode: "full" },
    createdAt: new Date("2026-08-07T10:00:00.000Z"),
    scheduledAt: new Date("2026-08-07T10:00:00.000Z"),
    startedAt: new Date("2026-08-07T10:01:00.000Z"),
    completedAt: new Date("2026-08-07T10:05:00.000Z"),
    progress: { current: 55, message: "done" },
    ...overrides,
  };
}

test("manual start schedules only the existing notification JobInstance lane", async () => {
  scheduledInput = null;
  syncState = null;
  const db = { jobInstance: { async findMany() { return []; } } };
  const result = await startManualNotificationScan({ db, creator, requestedByUserId: "user-1", now: new Date("2026-08-07T12:00:00.000Z") });
  assert.equal(result.action, "created");
  assert.equal(scheduledInput.jobKey, "catchup_notifications_scan");
  assert.equal(scheduledInput.creatorId, creator.id);
  assert.equal(scheduledInput.params.manualNotificationScan, true);
  assert.equal(scheduledInput.params.manualNotificationScanVersion, 1);
  assert.equal(scheduledInput.params.notificationMode, "full");
  assert.equal(scheduledInput.params.analyticsRangeKey, "all");
});

test("manual start resumes the same paused JobInstance without clearing its cursor", async () => {
  const paused = manualJob({
    status: "PAUSED",
    continuation: { driverPhase: "execute", jobContinuation: { schemaVersion: 4, scanRunId: "scan-run-1234", fromId: "n-100", page: 7 } },
    progress: { current: 7, message: "page 7" },
    leaseRevision: 4,
  });
  let updateData = null;
  const db = {
    jobInstance: {
      async findMany() { return [paused]; },
      async update({ data }) { updateData = data; return { ...paused, ...data, status: "SCHEDULED" }; },
    },
  };
  const result = await startManualNotificationScan({ db, creator, now: new Date("2026-08-07T12:00:00.000Z") });
  assert.equal(result.action, "resumed");
  assert.equal(result.job.id, paused.id);
  assert.equal(updateData.status, "SCHEDULED");
  assert.equal("continuation" in updateData, false);
  assert.equal("progress" in updateData, false);
  assert.deepEqual(paused.continuation.jobContinuation, { schemaVersion: 4, scanRunId: "scan-run-1234", fromId: "n-100", page: 7 });
});

test("manual stop fences a claimed lease but preserves progress and continuation", async () => {
  const current = manualJob({
    status: "CLAIMED",
    continuation: { driverPhase: "execute", jobContinuation: { fromId: "n-100", page: 7 } },
    progress: { current: 7, message: "page 7" },
    leaseRevision: 4,
    lastProgressAt: new Date("2026-08-07T12:00:00.000Z"),
  });
  let updateData = null;
  const db = {
    jobInstance: {
      async findMany() { return [current]; },
      async updateMany({ data }) { updateData = data; return { count: 1 }; },
      async findUnique() { return { ...current, ...updateData, status: "PAUSED" }; },
    },
  };
  const result = await stopManualNotificationScan({ db, creatorId: creator.id });
  assert.equal(result.action, "paused");
  assert.equal(updateData.status, "PAUSED");
  assert.deepEqual(current.continuation.jobContinuation, { fromId: "n-100", page: 7 });
  assert.equal("continuation" in updateData, false);
  assert.equal("progress" in updateData, false);
  assert.deepEqual(updateData.leaseRevision, { increment: 1 });
});

test("page audit stores typed relational columns only and remains idempotent", async () => {
  let inserted = null;
  const db = {
    creatorNotificationScanItem: {
      async createMany(input) { inserted = input; return { count: input.data.length }; },
    },
  };
  const result = await recordNotificationScanItems({
    db,
    job: manualJob(),
    chunk: {
      scanRunId: "scan-run-1234",
      auditItems: [
        {
          page: 3, ordinal: 0, notificationId: "n-1", sourceType: "favorited", sourceSubType: "new_favorite",
          factType: "LIKE", occurredAt: "2026-08-07T10:00:00.000Z", fanOnlyFansUserId: "fan-1", postId: "post-1",
          commentId: null, messageId: null, amountCents: null, currency: null, outcome: "ACCEPTED", reasonCode: null,
        },
        {
          page: 3, ordinal: 1, notificationId: "n-2", sourceType: "message", sourceSubType: "promoreg_for_expired",
          factType: null, occurredAt: "2026-08-07T09:00:00.000Z", fanOnlyFansUserId: "fan-2", postId: null,
          commentId: null, messageId: null, amountCents: null, currency: null, outcome: "IGNORED", reasonCode: "UNSUPPORTED_NOTIFICATION_TYPE",
        },
      ],
    },
  });
  assert.deepEqual(result, { received: 2, stored: 2 });
  assert.equal(inserted.skipDuplicates, true);
  assert.equal(inserted.data[0].sourceJobId, "manual-job-1");
  assert.equal(inserted.data[0].scanRunId, "scan-run-1234");
  assert.equal(inserted.data[0].factType, "LIKE");
  for (const row of inserted.data) {
    assert.equal("payload" in row, false);
    assert.equal("raw" in row, false);
    assert.equal("json" in row, false);
    assert.equal("text" in row, false);
  }
});

test("scanner read never presents stale legacy sync state as the current manual job", async () => {
  const job = manualJob({ status: "SCHEDULED", progress: null, startedAt: null, completedAt: null });
  syncState = {
    sourceJobId: "old-auto-job",
    status: "FAILED",
    mode: "full",
    pagesScanned: 0,
    eventsAccepted: 0,
    eventsRejected: 0,
    ignoredEvents: 0,
    lastErrorCode: "OF_REQUEST_FAILED",
    lastErrorMessage: "old type=all failure",
    updatedAt: new Date("2026-08-07T09:00:00.000Z"),
  };
  const db = {
    jobInstance: { async findMany() { return [job]; } },
    creatorNotificationScanItem: {
      async findMany() { return []; },
      async count() { return 0; },
      async groupBy() { return []; },
    },
    deviceCreatorBinding: { async count() { return 1; } },
  };
  const result = await readManualNotificationScan({ db, creator, outcome: "ALL", limit: 100, offset: 0 });
  assert.equal(result.status, "QUEUED");
  assert.equal(result.pagesScanned, 0);
  assert.equal(result.lastErrorMessage, null);
  assert.equal(result.legacySummary.lastErrorMessage, "old type=all failure");
});
