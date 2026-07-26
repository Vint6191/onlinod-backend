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
