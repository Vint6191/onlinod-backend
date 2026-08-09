"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function loadService(fixture) {
  const prismaModule = require.resolve("../prisma");
  const resultModule = require.resolve("./job-result-service");
  const catalogModule = require.resolve("./job-catalog");
  const fenceModule = require.resolve("./dialog-job-completion-fence");
  const dailyModule = require.resolve("./vault-intelligence-daily-service");
  const notificationSyncModule = require.resolve("./notification-sync-state-service");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: fixture.db };
  require.cache[resultModule] = {
    id: resultModule, filename: resultModule, loaded: true,
    exports: {
      applyJobChunk: fixture.applyJobChunk || (async () => ({})),
      applyJobResult: fixture.applyJobResult || (async () => ({})),
      recordJobFailure: async () => ({}),
    },
  };
  require.cache[catalogModule] = {
    id: catalogModule, filename: catalogModule, loaded: true,
    exports: { filterClaimableDesktopJobKeys: (keys) => keys || [] },
  };
  require.cache[fenceModule] = {
    id: fenceModule, filename: fenceModule, loaded: true,
    exports: { completeDialogJobFenced: async () => ({}) },
  };
  require.cache[dailyModule] = {
    id: dailyModule, filename: dailyModule, loaded: true,
    exports: {
      ensureDailyVaultIntelligenceCycle: fixture.ensureDailyVaultIntelligenceCycle
        || (async () => ({ ok: true, created: 0, reason: "not_due" })),
    },
  };
  require.cache[notificationSyncModule] = {
    id: notificationSyncModule, filename: notificationSyncModule, loaded: true,
    exports: {
      completeNotificationSync: fixture.completeNotificationSync
        || (async () => ({ id: "notification-sync-state" })),
    },
  };
  delete require.cache[require.resolve("./job-lease-service")];
  return require("./job-lease-service");
}

function fixture() {
  const token = "lease-token";
  const job = {
    id: "job-1", agencyId: "agency-1", status: "CLAIMED", claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token), leaseRevision: 3, leaseUntil: new Date(Date.now() + 60_000),
    attempts: 2, progress: { current: 4, total: 10 }, workId: "work-old",
  };
  let update = null;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { update = args; return { count: 1 }; },
    },
  };
  return { db, job, token, update: () => update };
}

test("creator context release preserves attempts and records a non-error wait diagnostic", async () => {
  const item = fixture();
  const { releaseJob } = loadService(item);
  const before = Date.now();
  const result = await releaseJob({
    jobId: item.job.id, userId: "user-1", deviceId: "device-1", leaseToken: item.token,
    leaseRevision: 3, workId: "work-new",
    reason: "Creator execution context unavailable during chunk: CREATOR_PAGE_NOT_READY",
    runAfterMs: 5_000,
  });
  const update = item.update();
  assert.equal(result.status, "SCHEDULED");
  assert.equal(result.attempts, 2);
  assert.equal(update.data.status, "SCHEDULED");
  assert.equal(update.data.lastError, null);
  assert.equal(update.data.progress.waitKind, "creator_context");
  assert.match(update.data.progress.waitReason, /CREATOR_PAGE_NOT_READY/);
  assert.equal(Object.hasOwn(update.data, "attempts"), false);
  const delay = new Date(update.data.nextRunAt).getTime() - before;
  assert.ok(delay >= 4_500 && delay <= 6_500, `unexpected delay ${delay}`);
});

test("claim clears stale wait diagnostics before a worker resumes the job", async () => {
  const now = new Date();
  const candidate = {
    id: "job-claim", jobKey: "dialog_intelligence_scan", scope: "creator", creatorId: "creator-1", agencyId: "agency-1",
    idempotencyKey: "claim-key", params: { dialogId: "dialog-1" }, priority: 60, attempts: 0,
    leaseRevision: 1, startedAt: null, workId: null, continuation: null,
    progress: { current: 2, total: 10, waitKind: "creator_context", waitReason: "old wait", waitingSince: now.toISOString(), retryAt: now.toISOString() },
  };
  let updateData = null;
  const claimed = {
    ...candidate,
    status: "CLAIMED", claimedAt: now, claimedByDeviceId: "device-1", leaseUntil: new Date(now.getTime() + 60_000),
    leaseRevision: 2, progress: { current: 2, total: 10 }, creator: { id: "creator-1" },
  };
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1", lastSeenAt: now }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", role: "OWNER", roleKey: "owner", assignedCreators: "all" }) },
    creatorAccount: { findMany: async () => [{ id: "creator-1" }] },
    deviceCreatorBinding: { findMany: async () => [{ creatorId: "creator-1" }] },
    jobInstance: {
      updateMany: async ({ data }) => { updateData = data; return { count: 1 }; },
      findFirst: async () => candidate,
      findUnique: async () => claimed,
    },
  };
  const { claimJob } = loadService({ db });
  const result = await claimJob({
    userId: "user-1", deviceId: "device-1", leaseMs: 60_000,
    jobKeys: ["dialog_intelligence_scan"],
  });
  assert.equal(result.reason, "claimed");
  assert.equal(updateData.progress.current, 2);
  assert.equal(updateData.progress.total, 10);
  assert.equal(Object.hasOwn(updateData.progress, "waitKind"), false);
  assert.equal(Object.hasOwn(updateData.progress, "waitReason"), false);
});

test("lease-only renew does not rewrite progress or continuation JSON", async () => {
  const item = fixture();
  item.job.continuation = { driverPhase: "execute", jobContinuation: { mode: "initial", page: 7 } };
  const { renewLease } = loadService(item);
  await renewLease({
    jobId: item.job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: item.token,
    leaseRevision: 3,
    leaseMs: 60_000,
  });
  const update = item.update();
  assert.equal(Object.hasOwn(update.data, "continuation"), false);
  assert.equal(Object.hasOwn(update.data, "progress"), false);
  assert.equal(Object.hasOwn(update.data, "lastProgressAt"), false);
  assert.ok(update.data.leaseUntil instanceof Date);
});

test("renew flattens a legacy deeply nested driver continuation", async () => {
  const item = fixture();
  const domain = { stage: "DIALOG_SCAN", mode: "initial", dialogId: "dialog-1", page: 12, cursor: "m-500" };
  let nested = domain;
  for (let index = 0; index < 2_000; index += 1) {
    nested = { driverPhase: "execute", jobContinuation: nested };
  }
  const { renewLease } = loadService(item);
  await renewLease({
    jobId: item.job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: item.token,
    leaseRevision: 3,
    leaseMs: 60_000,
    continuation: nested,
  });
  const saved = item.update().data.continuation;
  assert.deepEqual(saved, { driverPhase: "execute", jobContinuation: domain });
  assert.doesNotThrow(() => JSON.stringify(saved));
});

test("claim allows another device workflow for the same creator and honors only caller exclusions", async () => {
  const now = new Date();
  const candidate = {
    id: "job-creator-2", jobKey: "dialog_intelligence_scan", scope: "creator", creatorId: "creator-2", agencyId: "agency-1",
    idempotencyKey: "claim-2", params: { dialogId: "dialog-2" }, priority: 60, attempts: 0,
    leaseRevision: 1, startedAt: null, workId: null, continuation: null, progress: null,
  };
  let candidateWhere = null;
  let legacyLiveLeaseQueryCalled = false;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1", lastSeenAt: now }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", role: "OWNER", roleKey: "owner", assignedCreators: "all" }) },
    creatorAccount: { findMany: async () => [{ id: "creator-1" }, { id: "creator-2" }] },
    deviceCreatorBinding: { findMany: async () => [{ creatorId: "creator-1" }, { creatorId: "creator-2" }] },
    jobInstance: {
      findMany: async () => { legacyLiveLeaseQueryCalled = true; return [{ creatorId: "creator-1" }]; },
      findFirst: async ({ where }) => { candidateWhere = where; return candidate; },
      updateMany: async ({ where }) => where?.id === candidate.id ? { count: 1 } : { count: 0 },
      findUnique: async () => ({
        ...candidate, status: "CLAIMED", claimedAt: now, claimedByDeviceId: "device-1",
        leaseUntil: new Date(now.getTime() + 60_000), leaseRevision: 2, creator: { id: "creator-2" },
      }),
    },
  };
  const { claimJob } = loadService({ db });
  const result = await claimJob({
    userId: "user-1", deviceId: "device-1", leaseMs: 60_000,
    jobKeys: ["dialog_intelligence_scan"],
    excludedCreatorIds: ["creator-1"],
  });
  assert.equal(result.job.creatorId, "creator-2");
  assert.deepEqual(candidateWhere.creatorId.in, ["creator-2"]);
  assert.equal(legacyLiveLeaseQueryCalled, false, "server must not globally lock a creator because another device owns a different workflow");
});

test("live progress preserves dialog diagnostics without rewriting continuation", async () => {
  const item = fixture();
  const { renewLease } = loadService(item);
  await renewLease({
    jobId: item.job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: item.token,
    leaseRevision: 3,
    leaseMs: 60_000,
    progress: {
      percent: 7,
      message: "Full dialog page 7",
      pages: 7,
      messages: 350,
      localUncheckpointedMessages: 50,
      dialogId: "dialog-1",
      storage: "local_sqlite",
      live: true,
    },
  });
  const update = item.update();
  assert.equal(update.data.progress.pages, 7);
  assert.equal(update.data.progress.messages, 350);
  assert.equal(update.data.progress.localUncheckpointedMessages, 50);
  assert.equal(update.data.progress.dialogId, "dialog-1");
  assert.equal(update.data.progress.storage, "local_sqlite");
  assert.equal(update.data.progress.live, true);
  assert.equal(Object.hasOwn(update.data, "continuation"), false);
});


test("progress checkpoint uses bounded transaction options and reuses update result", async () => {
  const token = "lease-token";
  const now = new Date();
  const job = {
    id: "job-progress", agencyId: "agency-1", creatorId: "creator-1", jobKey: "vault_unsorted_scan",
    status: "CLAIMED", claimedByDeviceId: "device-1", leaseTokenHash: tokenHash(token), leaseRevision: 4,
    leaseUntil: new Date(now.getTime() + 60_000), attempts: 0, progress: { current: 40 },
    continuation: { driverPhase: "execute", jobContinuation: { offset: 40 } }, workId: "work-old",
  };
  let transactionOptions = null;
  let findUniqueCalls = 0;
  let updateCalls = 0;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => { findUniqueCalls += 1; return job; },
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }) => {
        updateCalls += 1;
        return {
          ...job,
          leaseUntil: new Date(now.getTime() + 120_000),
          progress: { current: 80 },
          continuation: data.continuation,
        };
      },
    },
    $transaction: async (callback, options) => {
      transactionOptions = options;
      return callback(db);
    },
  };
  const { progressJob } = loadService({
    db,
    applyJobChunk: async () => ({ jobContinuationOverride: { offset: 80 } }),
  });
  const result = await progressJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 4,
    leaseMs: 60_000,
    workId: "work-next",
    progress: { current: 80 },
    continuation: { driverPhase: "execute", jobContinuation: { offset: 80 } },
    chunkResult: { kind: "vault_unsorted_media_page" },
  });
  assert.deepEqual(transactionOptions, { maxWait: 10_000, timeout: 30_000 });
  assert.equal(findUniqueCalls, 1, "requireLease is the only job read");
  assert.equal(updateCalls, 1, "the continuation update result is reused as the response row");
  assert.deepEqual(result.continuation, { driverPhase: "execute", jobContinuation: { offset: 80 } });
});


test("vault completion keeps publication fenced with a longer bounded transaction", async () => {
  const token = "lease-token";
  const now = new Date();
  const job = {
    id: "job-complete", agencyId: "agency-1", creatorId: "creator-1", jobKey: "vault_unsorted_scan",
    status: "CLAIMED", claimedByDeviceId: "device-1", leaseTokenHash: tokenHash(token), leaseRevision: 5,
    leaseUntil: new Date(now.getTime() + 60_000), attempts: 0, progress: { current: 800 },
    continuation: { driverPhase: "complete" }, workId: "work-complete",
  };
  let transactionOptions = null;
  let appliedInsideTransaction = false;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (callback, options) => {
      transactionOptions = options;
      return callback(db);
    },
  };
  const { completeJob } = loadService({
    db,
    applyJobResult: async ({ db: transactionDb }) => {
      appliedInsideTransaction = transactionDb === db;
      return { type: "vault_unsorted" };
    },
  });
  const result = await completeJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 5,
    workId: "work-complete",
    progress: { current: 800, percent: 100 },
    result: { mode: "full", scanned: 800 },
  });
  assert.deepEqual(transactionOptions, { maxWait: 10_000, timeout: 60_000 });
  assert.equal(appliedInsideTransaction, true);
  assert.equal(result.job.status, "DONE");
});

test("daily catalog completion does not auto-start dialog discovery", async () => {
  const token = "lease-token";
  const now = new Date();
  const job = {
    id: "daily-catalog-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    jobKey: "vault_unsorted_scan",
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token),
    leaseRevision: 6,
    leaseUntil: new Date(now.getTime() + 60_000),
    attempts: 0,
    params: { mode: "full", source: "daily_vault_intelligence" },
    progress: { current: 2_017 },
    continuation: { driverPhase: "complete" },
    workId: "daily-work",
  };
  let dailyCalls = 0;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (callback) => callback(db),
  };
  const { completeJob } = loadService({
    db,
    applyJobResult: async () => ({ type: "vault_unsorted", publicationMode: "merge" }),
    ensureDailyVaultIntelligenceCycle: async () => {
      dailyCalls += 1;
      return { ok: true, created: 1 };
    },
  });
  const result = await completeJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 6,
    workId: "daily-work",
    result: { mode: "full", scanned: 2_017 },
    progress: { current: 2_017, percent: 100 },
  });
  assert.equal(dailyCalls, 0);
  assert.equal(Object.hasOwn(result, "dailyContinuation"), false);
});

test("discovery-only claim fences the shared dialog job key to the discovery sentinel", async () => {
  const now = new Date();
  const candidate = {
    id: "job-discovery", jobKey: "dialog_intelligence_scan", scope: "creator",
    creatorId: "creator-1", agencyId: "agency-1", idempotencyKey: "discovery-key",
    params: { dialogId: "__dialog_discovery__", scanRunId: "run-discovery", mode: "discovery" },
    priority: 70, attempts: 0, leaseRevision: 1, startedAt: null, workId: null,
    continuation: null, progress: null,
  };
  let selectedWhere = null;
  let fencedWhere = null;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1", lastSeenAt: now }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", role: "OWNER", roleKey: "owner", assignedCreators: "all" }) },
    creatorAccount: { findMany: async () => [{ id: "creator-1" }] },
    deviceCreatorBinding: { findMany: async () => [{ creatorId: "creator-1" }] },
    jobInstance: {
      findFirst: async ({ where }) => { selectedWhere = where; return candidate; },
      updateMany: async ({ where }) => {
        if (where?.id === candidate.id) fencedWhere = where;
        return { count: 1 };
      },
      findUnique: async () => ({
        ...candidate,
        status: "CLAIMED",
        claimedAt: now,
        claimedByDeviceId: "device-1",
        leaseUntil: new Date(now.getTime() + 60_000),
        leaseRevision: 2,
        creator: { id: "creator-1" },
      }),
    },
  };
  const { claimJob } = loadService({ db });
  const result = await claimJob({
    userId: "user-1",
    deviceId: "device-1",
    leaseMs: 60_000,
    jobKeys: ["fetch_earnings", "dialog_intelligence_scan"],
    dialogDiscoveryOnly: true,
  });

  assert.equal(result.reason, "claimed");
  const expectedConstraint = {
    OR: [
      { jobKey: { not: "dialog_intelligence_scan" } },
      {
        jobKey: "dialog_intelligence_scan",
        params: { path: ["dialogId"], equals: "__dialog_discovery__" },
      },
    ],
  };
  assert.deepEqual(selectedWhere.AND, [expectedConstraint]);
  assert.deepEqual(fencedWhere.AND, [expectedConstraint]);
  assert.deepEqual(selectedWhere.jobKey.in, ["fetch_earnings", "dialog_intelligence_scan"]);
  assert.deepEqual(fencedWhere.jobKey.in, ["fetch_earnings", "dialog_intelligence_scan"]);
});

test("notification completion reserves a new lease revision before durable side effects", async () => {
  const token = "notification-lease-token";
  const now = new Date();
  const job = {
    id: "notification-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token),
    leaseRevision: 7,
    leaseUntil: new Date(now.getTime() + 60_000),
    attempts: 0,
    params: {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      types: ["purchases", "tips", "subscriptions"],
    },
    progress: { current: 3, total: 3 },
    continuation: { driverPhase: "complete" },
    workId: "notification-work",
  };
  const order = [];
  const updates = [];
  const db = {
    workerDevice: {
      findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }),
    },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => {
        updates.push(args);
        if (updates.length === 1) order.push("reserved");
        if (updates.length === 2) order.push("completed");
        return { count: 1 };
      },
    },
  };
  const { completeJob } = loadService({
    db,
    applyJobResult: async ({ db: suppliedDb }) => {
      assert.equal(suppliedDb, undefined, "notification side effects intentionally run after the short reservation update");
      order.push("side-effect");
      return { type: "catchup_notifications", ok: true };
    },
  });

  const result = await completeJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 7,
    workId: "notification-work",
    result: { collectorVersion: "notifications-catchup-v3", totalAcceptedEvents: 0 },
    progress: { current: 3, total: 3, percent: 100 },
  });

  assert.deepEqual(order, ["reserved", "side-effect", "completed"]);
  assert.deepEqual(updates[0].where, {
    id: job.id,
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token),
    leaseRevision: 7,
    leaseUntil: { gt: updates[0].where.leaseUntil.gt },
  });
  assert.deepEqual(updates[0].data.leaseRevision, { increment: 1 });
  assert.equal(updates[1].where.leaseRevision, 8);
  assert.equal(updates[1].data.status, "DONE");
  assert.equal(result.job.status, "DONE");
});

test("bounded notification catch-up marks DONE before deferred compatibility projection", async () => {
  const token = "bounded-notification-token";
  const now = new Date();
  const job = {
    id: "bounded-notification-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token),
    leaseRevision: 5,
    leaseUntil: new Date(now.getTime() + 60_000),
    attempts: 0,
    params: {
      notificationMode: "catchup",
      from: "2026-08-09T12:00:00.000Z",
      to: "2026-08-09T14:00:00.000Z",
      types: ["purchases", "tips", "subscriptions", "likes", "comments"],
    },
    progress: { current: 1, total: 1 },
    continuation: { driverPhase: "complete" },
    workId: "bounded-notification-work",
  };
  const updates = [];
  const order = [];
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { updates.push(args); order.push("done-fence"); return { count: 1 }; },
    },
    $transaction: async (callback) => callback(db),
  };
  const { completeJob } = loadService({
    db,
    completeNotificationSync: async ({ db: suppliedDb, successful }) => {
      assert.equal(suppliedDb, db);
      assert.equal(successful, true);
      order.push("sync-finalized");
      return { id: "sync-1" };
    },
    applyJobResult: async () => {
      order.push("compatibility");
      return { type: "catchup_notifications", ok: true };
    },
  });

  const result = await completeJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 5,
    workId: job.workId,
    result: {
      notificationMode: "catchup",
      schemaVersion: 5,
      sourceExhausted: true,
      coverage: {
        purchases: { status: "complete", rejected: 0 },
        tips: { status: "complete", rejected: 0 },
        subscriptions: { status: "complete", rejected: 0 },
        likes: { status: "complete", rejected: 0 },
        comments: { status: "complete", rejected: 0 },
      },
    },
    progress: { current: 1, total: 1, percent: 100 },
  });

  assert.equal(result.job.status, "DONE");
  assert.equal(result.sideEffect.compatibilityDeferred, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, "DONE");
  assert.deepEqual(order.slice(0, 2), ["done-fence", "sync-finalized"]);
  assert.equal(order.includes("compatibility"), false, "compatibility must not block completion response");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.includes("compatibility"), true);
});

test("partial notification completion is rescheduled instead of being marked DONE", async () => {
  const token = "notification-partial-token";
  const now = new Date();
  const job = {
    id: "notification-partial-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token),
    leaseRevision: 3,
    leaseUntil: new Date(now.getTime() + 60_000),
    attempts: 0,
    params: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z", types: ["tips"] },
    progress: { current: 1, total: 1 },
    continuation: { driverPhase: "complete" },
    workId: "notification-partial-work",
  };
  const updates = [];
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
    },
  };
  const { completeJob } = loadService({
    db,
    applyJobResult: async () => ({
      type: "catchup_notifications",
      ok: false,
      summary: {
        analyticsCoverageComplete: false,
        requestedTypes: ["purchases", "tips"],
        analyticsCoverageByType: { purchases: "complete", tips: "partial" },
      },
    }),
  });

  const result = await completeJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 3,
    workId: job.workId,
    result: {
      collectorVersion: "notifications-catchup-v3",
      scanRunId: "run-partial-1",
      coverage: {
        purchases: { status: "complete", reason: "source_exhausted", rejected: 0 },
        tips: { status: "partial", reason: "page_limit", rejected: 0, cursorEnd: "tip-cursor-200" },
      },
    },
    progress: { current: 1, total: 1, percent: 100 },
  });

  assert.equal(updates.length, 2);
  assert.equal(updates[1].where.leaseRevision, 4);
  assert.equal(updates[1].data.status, "SCHEDULED");
  assert.equal(updates[1].data.attempts, 0);
  assert.equal(updates[1].data.continuation, null);
  assert.equal(updates[1].data.claimedByDeviceId, null);
  assert.equal(updates[1].data.lastError, "notification_scan_partial");
  assert.deepEqual(updates[1].data.params.types, ["tips"]);
  assert.deepEqual(updates[1].data.params.resumeCursors, { tips: "tip-cursor-200" });
  assert.equal(updates[1].data.params.notificationRepairPass, 1);
  assert.ok(updates[1].data.nextRunAt instanceof Date);
  assert.equal(result.job.status, "SCHEDULED");
});

test("fifth non-resumable partial notification attempt becomes FAILED instead of looping forever", async () => {
  const token = "notification-terminal-token";
  const now = new Date();
  const job = {
    id: "notification-terminal-job",
    agencyId: "agency-1",
    creatorId: "creator-1",
    jobKey: "catchup_notifications_scan",
    status: "CLAIMED",
    claimedByDeviceId: "device-1",
    leaseTokenHash: tokenHash(token),
    leaseRevision: 11,
    leaseUntil: new Date(now.getTime() + 60_000),
    attempts: 4,
    params: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z", types: ["tips"] },
    progress: { current: 1, total: 1 },
    continuation: { driverPhase: "complete" },
    workId: "notification-terminal-work",
  };
  const updates = [];
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
    },
  };
  const { completeJob } = loadService({
    db,
    applyJobResult: async () => ({
      ok: false,
      summary: { requestedTypes: ["tips"], analyticsCoverageByType: { tips: "partial" } },
    }),
  });

  const result = await completeJob({
    jobId: job.id,
    userId: "user-1",
    deviceId: "device-1",
    leaseToken: token,
    leaseRevision: 11,
    workId: job.workId,
    result: { coverage: { tips: { status: "partial", reason: "cursor_stalled", rejected: 0, cursorEnd: "same" } } },
    progress: { current: 1, total: 1, percent: 100 },
  });

  assert.equal(updates[1].data.status, "FAILED");
  assert.equal(updates[1].data.attempts, 5);
  assert.equal(updates[1].data.nextRunAt, undefined);
  assert.equal(result.job.status, "FAILED");
  assert.equal(result.job.retryAt, null);
});

test("earnings completion reserves lease ownership before relational projection", async () => {
  const token = "earnings-fence-token";
  const now = new Date();
  const job = {
    id: "earnings-fence-job", agencyId: "agency-1", creatorId: "creator-1", jobKey: "fetch_earnings",
    status: "CLAIMED", claimedByDeviceId: "device-1", leaseTokenHash: tokenHash(token), leaseRevision: 9,
    leaseUntil: new Date(now.getTime() + 60_000), attempts: 0, params: { rangeKey: "7d" },
    continuation: { driverPhase: "complete" }, workId: "earnings-work",
  };
  const order = [];
  const updates = [];
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { updates.push(args); order.push(updates.length === 1 ? "reserved" : "completed"); return { count: 1 }; },
    },
  };
  const { completeJob } = loadService({
    db,
    applyJobResult: async () => { order.push("projection"); return { ok: true, type: "earnings" }; },
  });
  const result = await completeJob({
    jobId: job.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 9,
    workId: job.workId, result: { schemaVersion: 3 }, progress: { percent: 100 },
  });
  assert.deepEqual(order, ["reserved", "projection", "completed"]);
  assert.deepEqual(updates[0].data.leaseRevision, { increment: 1 });
  assert.equal(updates[1].where.leaseRevision, 10);
  assert.equal(updates[1].data.status, "DONE");
  assert.equal(result.job.status, "DONE");
});

test("partial campaign proof is rescheduled instead of publishing DONE", async () => {
  const token = "campaign-partial-token";
  const now = new Date();
  const job = {
    id: "campaign-partial-job", agencyId: "agency-1", creatorId: "creator-1", jobKey: "fetch_campaigns",
    status: "CLAIMED", claimedByDeviceId: "device-1", leaseTokenHash: tokenHash(token), leaseRevision: 4,
    leaseUntil: new Date(now.getTime() + 60_000), attempts: 1, params: { rangeKey: "30d" },
    continuation: { driverPhase: "complete" }, workId: "campaign-work",
  };
  const updates = [];
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
    },
  };
  const { completeJob } = loadService({ db, applyJobResult: async () => ({ ok: false, type: "campaigns", completion: { complete: false } }) });
  const result = await completeJob({
    jobId: job.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 4,
    workId: job.workId, result: { scanRunId: "scan-partial" }, progress: { percent: 100 },
  });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].where.leaseRevision, 5);
  assert.equal(updates[1].data.status, "SCHEDULED");
  assert.equal(updates[1].data.attempts, 2);
  assert.equal(updates[1].data.continuation, null);
  assert.equal(updates[1].data.lastError, "fetch_campaigns_partial");
  assert.equal(result.job.status, "SCHEDULED");
});

test("claim fence cancels a legacy no-mode notification FULL once historical baseline exists", async () => {
  const now = new Date();
  const candidate = {
    id: "legacy-no-mode-full", jobKey: "catchup_notifications_scan", scope: "creator", creatorId: "creator-1", agencyId: "agency-1",
    idempotencyKey: "legacy-no-mode", params: { reason: "legacy_pre_mode_build" }, priority: 100, attempts: 0,
    leaseRevision: 1, startedAt: null, workId: null, continuation: null, progress: null,
  };
  let candidateReads = 0;
  let cancellation = null;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1", lastSeenAt: now }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", role: "OWNER", roleKey: "owner", assignedCreators: "all" }) },
    creatorAccount: { findMany: async () => [{ id: "creator-1" }] },
    deviceCreatorBinding: { findMany: async () => [{ creatorId: "creator-1" }] },
    creatorNotificationSyncState: { findUnique: async () => ({ fullBackfillCompletedAt: new Date("2026-08-08T00:00:00.000Z"), fullBackfillVerifiedAt: null }) },
    jobInstance: {
      findFirst: async () => (candidateReads++ === 0 ? candidate : null),
      updateMany: async (args) => {
        if (args.where?.id === candidate.id) { cancellation = args; return { count: 1 }; }
        return { count: 0 };
      },
    },
  };
  const { claimJob } = loadService({ db });
  const result = await claimJob({ userId: "user-1", deviceId: "device-1", leaseMs: 60_000, jobKeys: ["catchup_notifications_scan"] });
  assert.equal(result.job, null);
  assert.equal(result.reason, "no-work");
  assert.equal(cancellation.data.status, "CANCELLED");
  assert.equal(cancellation.data.lastError, "superseded_by_existing_notification_history");
});

test("renew fence kills an already claimed legacy no-mode notification FULL after baseline appears", async () => {
  const token = "legacy-no-mode-renew-token";
  const now = new Date();
  const job = {
    id: "legacy-no-mode-renew", agencyId: "agency-1", creatorId: "creator-1", jobKey: "catchup_notifications_scan",
    status: "CLAIMED", claimedByDeviceId: "device-1", leaseTokenHash: tokenHash(token), leaseRevision: 5,
    leaseUntil: new Date(now.getTime() + 60_000), params: { reason: "legacy_pre_mode_build" }, continuation: null, progress: null,
  };
  let cancellation = null;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    creatorNotificationSyncState: { findUnique: async () => ({ fullBackfillCompletedAt: new Date("2026-08-08T00:00:00.000Z"), fullBackfillVerifiedAt: null }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { cancellation = args; return { count: 1 }; },
    },
  };
  const { renewLease } = loadService({ db });
  await assert.rejects(
    renewLease({ jobId: job.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 5, leaseMs: 60_000 }),
    (error) => error?.code === "JOB_SUPERSEDED" && error?.status === 409,
  );
  assert.equal(cancellation.data.status, "CANCELLED");
  assert.equal(cancellation.data.lastError, "superseded_by_existing_notification_history");
});

test("explicitly forced notification FULL is exempt from the legacy-mode lease fence", async () => {
  const token = "forced-full-token";
  const now = new Date();
  const job = {
    id: "forced-full-renew", agencyId: "agency-1", creatorId: "creator-1", jobKey: "catchup_notifications_scan",
    status: "CLAIMED", claimedByDeviceId: "device-1", leaseTokenHash: tokenHash(token), leaseRevision: 2,
    leaseUntil: new Date(now.getTime() + 60_000), params: { forceNotificationFullRebuild: true }, continuation: null, progress: null,
  };
  let update = null;
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1" }) },
    agencyMember: { findFirst: async () => ({ id: "member-1" }) },
    creatorNotificationSyncState: { findUnique: async () => ({ fullBackfillVerifiedAt: new Date("2026-08-08T00:00:00.000Z") }) },
    jobInstance: {
      findUnique: async () => job,
      updateMany: async (args) => { update = args; return { count: 1 }; },
    },
  };
  const { renewLease } = loadService({ db });
  const result = await renewLease({ jobId: job.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 2, leaseMs: 60_000 });
  assert.equal(result.status, "CLAIMED");
  assert.ok(update.data.leaseUntil instanceof Date);
  assert.equal(update.data.status, undefined);
});
