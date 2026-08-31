"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}

function fresh(request) {
  const id = require.resolve(request);
  delete require.cache[id];
  return require(request);
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "increment")) row[key] = Number(row[key] || 0) + Number(value.increment || 0);
    else if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "decrement")) row[key] = Number(row[key] || 0) - Number(value.decrement || 0);
    else row[key] = value;
  }
}

function scalarMatches(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
    if (Object.hasOwn(expected, "in") && !expected.in.includes(actual)) return false;
    if (Object.hasOwn(expected, "not") && actual === expected.not) return false;
    if (Object.hasOwn(expected, "lte") && !(actual <= expected.lte)) return false;
    if (Object.hasOwn(expected, "lt") && !(actual < expected.lt)) return false;
    if (Object.hasOwn(expected, "gte") && !(actual >= expected.gte)) return false;
    if (Object.hasOwn(expected, "gt") && !(actual > expected.gt)) return false;
    return true;
  }
  return actual === expected;
}

function rowMatches(row, where = {}) {
  if (Array.isArray(where.OR) && !where.OR.some((branch) => rowMatches(row, branch))) return false;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") continue;
    if (!scalarMatches(row[key], expected)) return false;
  }
  return true;
}

function loadPlanningServices(rootDb) {
  cacheModule("../prisma", rootDb);
  cacheModule("./automation-control-service", {
    BUMPS_MODULE_KEY: "bumps",
    FOLLOW_BACK_MODULE_KEY: "follow_back",
    LIKES_MODULE_KEY: "likes",
    SFS_MODULE_KEY: "sfs",
    requireCreator: async () => ({ id: "creator-1" }),
    assertAutomationEnabled: async ({ moduleKey }) => ({
      effective: { likesEnabled: true, followBackEnabled: true, workspaceEnabled: true, creatorEnabled: true },
      workspace: { settings: { globalWriteMinIntervalMs: 0, globalWriteMaxIntervalMs: 0, randomJitter: false } },
      modules: {
        likes: { settings: {} },
        bumps: { settings: { onlineEnabled: true, hiddenOnlineEnabled: true, paidSubscribersEnabled: true, freeSubscribersEnabled: true, subscriptionEventsEnabled: true, candidateBatchSize: 20, dailyLimit: 100, maxAttempts: 3 } },
        sfs: { settings: { huntingEnabled: true, dailyLimit: 0 } },
        follow_back: { settings: {} },
      },
    }),
    getAutomationControlSnapshot: async () => ({
      effective: { likesEnabled: false, workspaceEnabled: true, creatorEnabled: true },
      workspace: { settings: {} },
      modules: { likes: { settings: {} }, bumps: { settings: {} }, sfs: { settings: {} }, follow_back: { settings: {} } },
    }),
    normalizeLikesSettings: (value) => ({ dailyLimit: 100, contentMaxAgeDays: 30, onlyUnliked: true, postsPerFanMin: 1, postsPerFanMax: 1, maxAttempts: 3, ...value }),
    normalizeFollowBackSettings: (value) => ({ ...value }),
    normalizeSfsSettings: (value) => ({ huntingEnabled: true, dailyLimit: 0, maxAttempts: 3, ...value }),
  });
  cacheModule("./automation-pacing-service", {
    nextAutomationWriteSlot: async () => new Date(),
    claimPacingRetryAt: async () => null,
  });
  cacheModule("./job-planning-repository", {
    ensurePlannedJob: async () => ({ created: false, job: null }),
    createPlannedJobIfAbsent: async () => ({ created: false, job: { id: "job-x" } }),
  });
  return {
    likes: fresh("./likes-service"),
    sfs: fresh("./sfs-service"),
    bumps: fresh("./bump-service"),
  };
}

test("Closure2 TransactionClient without $transaction supports SFS completion and Likes/SFS/Bumps planning", async () => {
  const tx = {
    $queryRawUnsafe: async () => [],
    subscriberDirectoryState: { findFirst: async () => null },
    sfsTargetCandidate: { findFirst: async () => null, findMany: async () => [] },
    automationDelivery: { count: async () => 0, findFirst: async () => null },
    automationTask: { findMany: async () => [] },
  };
  const { likes, sfs, bumps } = loadPlanningServices({});

  const sfsCompletion = await sfs.applySfsTargetScanCompletion({
    db: tx,
    job: { id: "sfs-old", agencyId: "agency-1", creatorId: "creator-1", params: { candidateId: "cand-1", candidateGeneration: 1 } },
    result: { posts: [] },
  });
  assert.equal(sfsCompletion.sideEffect, "STALE_NOOP");

  const likesPlan = await likes.planLikes({ db: tx, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(likesPlan.reason, "snapshot_not_ready");

  // The SFS daily-limit return happens inside withDbAdvisoryXactLock using this
  // TransactionClient directly; any nested db.$transaction call would throw.
  const sfsPlan = await sfs.planSfsTargets({ db: tx, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(sfsPlan.reason, "daily_limit");

  const bumpsPlan = await bumps.planBumps({ db: tx, agencyId: "agency-1", creatorId: "creator-1" });
  assert.equal(bumpsPlan.skipped[0].code, "no_template");
  assert.equal(typeof tx.$transaction, "undefined");
});

function loadActionService(db) {
  cacheModule("../prisma", db);
  cacheModule("./team-access-control", {
    canUsePermission: async () => true,
    isOwner: () => true,
    normalizeAssignedCreators: () => ({ mode: "all", creatorIds: [] }),
  });
  class TestExecutionAccessFenceError extends Error {}
  cacheModule("./execution-access-fence-service", {
    ExecutionAccessFenceError: TestExecutionAccessFenceError,
    assertExecutionAccessFence: async () => ({ ok: true }),
  });
  const control = {
    effective: { workspaceEnabled: true, creatorEnabled: true },
    workspace: { settings: { globalWriteMinIntervalMs: 0, globalWriteMaxIntervalMs: 0, randomJitter: false } },
    modules: {
      bumps: { settings: {} }, follow_back: { settings: {} }, likes: { settings: {} }, follow: { settings: {} }, sfs: { settings: {} },
    },
  };
  cacheModule("./automation-control-service", {
    assertAutomationEnabled: async () => control,
    getAutomationControlSnapshot: async () => control,
  });
  cacheModule("./automation-write-commit-fence-service", { lockAutomationWriteCommitFence: async () => ({ ok: true }) });
  cacheModule("./automation-pacing-service", { claimPacingRetryAt: async () => null });
  cacheModule("./bump-service", {
    validateBumpDelivery: async () => ({ ok: true }), finalizeBumpSend: async () => null, finalizeBumpDelete: async () => null,
    finalizeBumpFailure: async () => null, finalizeBumpTerminal: async () => null, prepareBumpRetry: async () => null,
  });
  cacheModule("./likes-service", {
    validateLikeDelivery: async () => ({ ok: true }), finalizeLikeSuccess: async () => null, finalizeLikeFailure: async () => null,
    finalizeLikeTerminal: async () => null, prepareLikeRetry: async () => null,
  });
  cacheModule("./follow-automation-service", {
    validateFollowAutomationDelivery: async () => ({ ok: true }), finalizeFollowAutomationSuccess: async () => null,
    finalizeFollowAutomationFailure: async () => null, finalizeFollowAutomationTerminal: async () => null, prepareFollowAutomationRetry: async () => null,
  });
  cacheModule("./sfs-service", {
    validateSfsDelivery: async () => ({ ok: true }), finalizeSfsSuccess: async () => null, finalizeSfsFailure: async () => null,
    finalizeSfsTerminal: async () => null, prepareSfsRetry: async () => null,
  });
  return fresh("./automation-action-delivery-service");
}

function actionFixture() {
  const now = new Date();
  const rows = [
    {
      id: "A", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "other", actionType: "SEND_MESSAGE", targetId: "fan-a", fanId: "fan-a",
      status: "COMMITTING", notBefore: new Date(now.getTime() - 60_000), priority: 100, attempts: 1, maxAttempts: 4,
      leaseRevision: 4, claimUntil: new Date(now.getTime() - 5_000), claimedByDeviceId: "device-1", leaseTokenHash: hashToken("old-token"),
      leaseMemberId: "member-1", leaseAccessEpoch: 7, result: {}, writeCommitRevision: 1, writeCommitAt: new Date(now.getTime() - 30_000),
      createdAt: new Date(now.getTime() - 120_000), claimedAt: new Date(now.getTime() - 60_000), generation: 1,
    },
    {
      id: "B", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "other", actionType: "LIKE_POST", targetId: "post-b", fanId: "fan-b",
      status: "QUEUED", notBefore: new Date(now.getTime() - 60_000), priority: 50, attempts: 0, maxAttempts: 4,
      leaseRevision: 1, claimUntil: null, claimedByDeviceId: null, leaseTokenHash: null, leaseMemberId: null, leaseAccessEpoch: null,
      result: {}, writeCommitRevision: 0, writeCommitAt: null, createdAt: new Date(now.getTime() - 90_000), generation: 1,
    },
  ];
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1", lastSeenAt: new Date() }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", agencyId: "agency-1", accessEpoch: 7, role: "OWNER", assignedCreators: "all" }) },
    creatorAccount: { findMany: async () => [{ id: "creator-1" }] },
    deviceCreatorBinding: { findMany: async () => [{ creatorId: "creator-1" }] },
    automationDelivery: {
      findMany: async ({ where }) => rows.filter((row) => rowMatches(row, where)),
      groupBy: async () => [],
      findFirst: async ({ where }) => rows.find((row) => rowMatches(row, where)) || null,
      findUnique: async ({ where }) => rows.find((row) => row.id === where.id) || null,
      updateMany: async ({ where, data }) => {
        const matches = rows.filter((row) => rowMatches(row, where));
        for (const row of matches) applyData(row, data);
        return { count: matches.length };
      },
      update: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row) throw new Error("not found");
        applyData(row, data); return row;
      },
    },
    followBackCandidate: { updateMany: async () => ({ count: 0 }) },
    automationContentCandidate: { updateMany: async () => ({ count: 0 }) },
    followAutomationCandidate: { updateMany: async () => ({ count: 0 }) },
    sfsTargetCandidate: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (work) => work(db),
  };
  return { rows, db };
}

test("Closure2 COMMITTING expiry and reconciliation-worker crash retain creator lane until proven no-effect", async () => {
  const { rows, db } = actionFixture();
  const service = loadActionService(db);

  assert.equal(await service.sweepExpiredActionLeases(new Date()), 1);
  assert.equal(rows[0].status, "RECONCILE_REQUIRED");

  const blocked = await service.claimActionDelivery({ userId: "user-1", deviceId: "device-1", actionTypes: ["LIKE_POST"] });
  assert.equal(blocked.reason, "no_work");
  assert.equal(rows[1].status, "QUEUED");

  rows[0].notBefore = new Date(Date.now() - 1_000);
  let recon = await service.claimActionDelivery({ userId: "user-1", deviceId: "device-1", actionTypes: ["SEND_MESSAGE"] });
  assert.equal(recon.reason, "claimed");
  assert.equal(recon.delivery.reconciliationRequired, true);
  assert.equal(rows[0].attempts, 1, "reconciliation claim must not consume another external-write attempt");

  // Reconciliation worker itself dies before readback completes.
  rows[0].claimUntil = new Date(Date.now() - 1_000);
  assert.equal(await service.sweepExpiredActionLeases(new Date()), 1);
  assert.equal(rows[0].status, "RECONCILE_REQUIRED");
  assert.equal((await service.claimActionDelivery({ userId: "user-1", deviceId: "device-1", actionTypes: ["LIKE_POST"] })).reason, "no_work");

  rows[0].notBefore = new Date(Date.now() - 1_000);
  recon = await service.claimActionDelivery({ userId: "user-1", deviceId: "device-1", actionTypes: ["SEND_MESSAGE"] });
  const lease = recon.delivery;
  await service.startActionDelivery({ deliveryId: "A", userId: "user-1", deviceId: "device-1", leaseToken: lease.leaseToken, leaseRevision: lease.leaseRevision });
  assert.equal(rows[0].status, "RUNNING");
  assert.equal(rows[0].result.outcomeState, "RECONCILE_REQUIRED");

  await service.failActionDelivery({
    deliveryId: "A", userId: "user-1", deviceId: "device-1", leaseToken: lease.leaseToken, leaseRevision: lease.leaseRevision,
    failureCode: "send_reconcile_no_effect", error: "readback proved no effect",
    result: { outcomeState: "PROVEN_NO_EFFECT", provenNoEffect: true, readbackCovered: true },
  });
  assert.equal(rows[0].status, "RETRY_SCHEDULED");
  assert.equal(rows[0].result.outcomeState, "PROVEN_NO_EFFECT");

  const afterProof = await service.claimActionDelivery({ userId: "user-1", deviceId: "device-1", actionTypes: ["LIKE_POST"] });
  assert.equal(afterProof.reason, "claimed");
  assert.equal(afterProof.delivery.id, "B");
});

function loadFollowBackForFence(db) {
  cacheModule("../prisma", db);
  cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() });
  cacheModule("./automation-write-commit-fence-service", { runWithAutomationWriteCommitFence: async ({ work }) => work(db) });
  cacheModule("./automation-control-service", {
    FOLLOW_BACK_MODULE_KEY: "follow_back", getAutomationControlSnapshot: async () => ({}), assertAutomationEnabled: async () => ({}),
    normalizeFollowBackSettings: (x) => x, requireCreator: async () => ({}),
  });
  cacheModule("./automation-action-delivery-service", { listActionDeliveries: async () => ({}), retryActionDelivery: async () => ({}) });
  cacheModule("./fan-data-authority-service", { readFanCurrent: async () => null });
  return fresh("./follow-back-service");
}

test("Closure2 FollowBack ignore cannot cancel a COMMITTING delivery", async () => {
  const delivery = { id: "d1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "follow_back", targetId: "fan-1", status: "COMMITTING", leaseRevision: 9 };
  const candidate = { id: "c1", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", creatorFollowsFan: false };
  const db = {
    followBackCandidate: { findFirst: async () => candidate, update: async ({ data }) => Object.assign(candidate, data) },
    automationDelivery: {
      updateMany: async ({ where, data }) => {
        if (where.status?.in?.includes(delivery.status)) { applyData(delivery, data); return { count: 1 }; }
        return { count: 0 };
      },
    },
  };
  const { setCandidateState } = loadFollowBackForFence(db);
  await setCandidateState({ agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", action: "ignore" });
  assert.equal(delivery.status, "COMMITTING");
  assert.equal(candidate.state, "IGNORED");
});

function loadBumpForFence(db) {
  cacheModule("../prisma", db);
  cacheModule("./automation-write-commit-fence-service", { runWithAutomationWriteCommitFence: async ({ work }) => work(db) });
  cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() });
  cacheModule("./automation-control-service", {
    BUMPS_MODULE_KEY: "bumps", assertAutomationEnabled: async () => ({}), getAutomationControlSnapshot: async () => ({}), requireCreator: async () => ({}),
  });
  return fresh("./bump-service");
}

test("Closure2 Bump reply annotates COMMITTING delete without SKIPPED divergence", async () => {
  const at = new Date();
  const state = { id: "state-1", pendingMessageId: "msg-1", pendingDeliveryId: "send-1", counters: {} };
  const cancel = { id: "delete-1", agencyId: "agency-1", creatorId: "creator-1", moduleKey: "bumps", actionType: "DELETE_MESSAGE", targetId: "msg-1", status: "COMMITTING", leaseRevision: 3, result: {}, payload: {} };
  const send = { id: "send-1", payload: { afterReplyCooldownMs: 10_000, template: { id: "tpl-1" } }, result: {} };
  const db = {
    automationBumpFanState: {
      findUnique: async () => state,
      updateMany: async ({ data }) => { applyData(state, data); return { count: 1 }; },
    },
    automationDelivery: {
      findFirst: async () => cancel,
      findUnique: async ({ where }) => where.id === "send-1" ? send : cancel,
      updateMany: async ({ where, data }) => { if (where.id === cancel.id) { applyData(cancel, data); return { count: 1 }; } return { count: 0 }; },
      update: async ({ where, data }) => { const row = where.id === send.id ? send : cancel; applyData(row, data); return row; },
    },
    bumpDeliveryStat: { upsert: async () => ({}) },
  };
  const { markBumpReply } = loadBumpForFence(db);
  const result = await markBumpReply({ agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", messageId: "reply-1", repliedAt: at, db });
  assert.equal(result.replyObservedDuringCommit, true);
  assert.equal(cancel.status, "COMMITTING");
  assert.equal(cancel.result.replyObservedDuringCommit, true);
});

function loadGenerationServices(db) {
  const planning = loadPlanningServices(db);
  return planning;
}

test("Closure2 Likes S1 completion/failure cannot overwrite current S2", async () => {
  let writes = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    subscriberDirectoryState: { findFirst: async () => ({ currentRunId: "S2" }) },
    automationContentCandidate: { updateMany: async () => { writes += 1; return { count: 1 }; } },
    automationContentDiscoveryState: { updateMany: async () => { writes += 1; return { count: 1 }; }, upsert: async () => { writes += 1; }, findUnique: async () => null },
  };
  const { likes } = loadGenerationServices({});
  const job = { id: "likes-S1", agencyId: "agency-1", creatorId: "creator-1", params: { snapshotRunId: "S1", fans: [{ fanId: "fan-1" }] } };
  const completed = await likes.applyLikesDiscoveryCompletion({ db: tx, job, result: { snapshotRunId: "S1" } });
  const failed = await likes.recordLikesDiscoveryFailure({ db: tx, job, error: new Error("late S1") });
  assert.equal(completed.sideEffect, "STALE_NOOP");
  assert.equal(failed.sideEffect, "STALE_NOOP");
  assert.equal(writes, 0);
});

test("Closure2 delayed SFS generation 1 scan is a no-op after candidate advances to generation 2", async () => {
  let deliveryCreates = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    sfsTargetCandidate: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    automationDelivery: { create: async () => { deliveryCreates += 1; } },
  };
  const { sfs } = loadGenerationServices({});
  const job = { id: "scan-g1", jobKey: "sfs_target_scan", agencyId: "agency-1", creatorId: "creator-1", params: { candidateId: "cand-1", candidateGeneration: 1 } };
  const result = await sfs.applySfsTargetScanCompletion({ db: tx, job, result: { posts: [{ id: "p1" }] } });
  const failure = await sfs.recordSfsJobFailure({ db: tx, job, error: "late failure" });
  assert.equal(result.sideEffect, "STALE_NOOP");
  assert.equal(failure.sideEffect, "STALE_NOOP");
  assert.equal(deliveryCreates, 0);
});

function loadJobResultForTraffic(db, upsertTrafficSourceScan) {
  cacheModule("../prisma", db);
  const stubs = {
    "./team-observation-service": { CATCHUP_JOB_KEY: "catchup", applyCatchupJobResult: async () => ({}), recordCatchupJobFailure: async () => ({}) },
    "./notification-facts-service": { ingestNotificationFacts: async () => ({}) },
    "./notification-sync-state-service": { recordNotificationPageProgress: async () => ({}) },
    "./notification-scan-control-service": { recordNotificationScanItems: async () => ({}) },
    "./financial-transactions-service": { JOB_KEY: "financial", ingestFinancialTransactionsChunk: async () => ({}), ingestFinancialChartChunk: async () => ({}), completeFinancialTransactionsScan: async () => ({}) },
    "./traffic-service": { TRAFFIC_SOURCES_SCAN_JOB_KEY: "traffic_sources_scan", upsertTrafficSourceScan },
    "./fan-data-authority-service": { FAN_DATA_POINT_REFRESH_JOB_KEY: "fan_data", applyFanDataPointRefreshChunk: async () => ({}) },
    "./creator-analytics-ledger-service": { ingestEarningsChunk: async () => ({}), completeEarningsScan: async () => ({}), ingestCampaignChunk: async () => ({}), ingestCampaignFanValueChunk: async () => ({}), ingestCampaignFanValuesBatchChunk: async () => ({}), completeCampaignScan: async () => ({}) },
    "./likes-service": { LIKES_DISCOVERY_JOB_KEY: "likes", applyLikesDiscoveryChunk: async () => ({}), applyLikesDiscoveryCompletion: async () => ({}), recordLikesDiscoveryFailure: async () => ({}) },
    "./sfs-service": { SFS_DISCOVERY_JOB_KEY: "sfs", SFS_TARGET_SCAN_JOB_KEY: "sfs_scan", applySfsDiscoveryChunk: async () => ({}), applySfsDiscoveryCompletion: async () => ({}), applySfsTargetScanCompletion: async () => ({}), recordSfsJobFailure: async () => ({}) },
    "./subscriber-directory-service": { SUBSCRIBER_DIRECTORY_JOB_KEY: "subs", applySubscriberScanChunk: async () => ({}), applySubscriberScanCompletion: async () => ({}), recordSubscriberScanFailure: async () => ({}), cleanupSubscriberScanHistory: async () => ({}) },
    "./vault-unsorted-service": { VAULT_UNSORTED_JOB_KEY: "vault", applyVaultUnsortedChunk: async () => ({}), applyVaultUnsortedCompletion: async () => ({}), recordVaultUnsortedFailure: async () => ({}) },
    "./dialog-intelligence-service": { DIALOG_INTELLIGENCE_JOB_KEY: "dialog", applyDialogIntelligenceChunk: async () => ({}), applyPurchaseSignalsChunk: async () => ({}), completeDialogIntelligenceJob: async () => ({}), recordDialogIntelligenceFailure: async () => ({}) },
  };
  for (const [request, exports] of Object.entries(stubs)) cacheModule(request, exports);
  return fresh("./job-result-service");
}

test("Closure2 delayed Traffic T1 cannot replace a newer T2 projection", async () => {
  let writes = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    jobInstance: { findMany: async () => [{ id: "T2", result: { scanStartedAt: "2026-08-31T10:02:00.000Z" }, createdAt: new Date("2026-08-31T10:01:00.000Z") }] },
  };
  const service = loadJobResultForTraffic({}, async () => { writes += 1; return { ok: true }; });
  const result = await service.applyJobResult({
    db: tx,
    job: { id: "T1", jobKey: "traffic_sources_scan", agencyId: "agency-1", creatorId: "creator-1", createdAt: new Date("2026-08-31T10:00:00.000Z") },
    deviceId: "device-1", userId: "user-1",
    result: { scanStartedAt: "2026-08-31T10:00:30.000Z", sources: [] },
  });
  assert.equal(result.sideEffect, "STALE_NOOP");
  assert.equal(result.newerJobId, "T2");
  assert.equal(writes, 0);
});

function commitRaceDb({ moduleKey, targetId, actionType }) {
  const token = "race-token";
  const delivery = {
    id: `race-${moduleKey}`, agencyId: "agency-1", creatorId: "creator-1", moduleKey, actionType, targetId, fanId: targetId,
    status: "RUNNING", notBefore: new Date(Date.now() - 1_000), priority: 50, attempts: 1, maxAttempts: 3,
    leaseRevision: 2, claimUntil: new Date(Date.now() + 60_000), claimedByDeviceId: "device-1", leaseTokenHash: hashToken(token),
    leaseMemberId: "member-1", leaseAccessEpoch: 7, result: {}, writeCommitRevision: 0, writeCommitAt: null,
    createdAt: new Date(Date.now() - 10_000), generation: 1,
  };
  const db = {
    workerDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", agencyId: "agency-1", lastSeenAt: new Date() }) },
    agencyMember: { findFirst: async () => ({ id: "member-1", agencyId: "agency-1", accessEpoch: 7, role: "OWNER", assignedCreators: "all" }) },
    automationDelivery: {
      findUnique: async ({ where }) => where.id === delivery.id ? delivery : null,
      updateMany: async ({ where, data }) => {
        if (!rowMatches(delivery, where)) return { count: 0 };
        applyData(delivery, data); return { count: 1 };
      },
    },
    followBackCandidate: { updateMany: async () => ({ count: 0 }) },
    automationContentCandidate: { updateMany: async () => ({ count: 0 }) },
    followAutomationCandidate: { updateMany: async () => ({ count: 0 }) },
    sfsTargetCandidate: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (work) => work(db),
  };
  return { db, delivery, token };
}

test("Closure2 FollowBack ignore vs prepareWrite has one fence winner", async () => {
  // Control wins first: cancellation invalidates the lease before prepareWrite.
  {
    const { db, delivery, token } = commitRaceDb({ moduleKey: "follow_back", targetId: "fan-1", actionType: "FOLLOW_BACK" });
    const candidate = { id: "fc-1", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", creatorFollowsFan: false };
    db.followBackCandidate.findFirst = async () => candidate;
    db.followBackCandidate.update = async ({ data }) => Object.assign(candidate, data);
    const action = loadActionService(db);
    const follow = loadFollowBackForFence(db);
    await follow.setCandidateState({ agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", action: "ignore" });
    assert.equal(delivery.status, "CANCELED");
    await assert.rejects(
      action.prepareWriteActionDelivery({ deliveryId: delivery.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 2 }),
      (error) => error?.code === "DELIVERY_NOT_CLAIMED",
    );
    assert.notEqual(delivery.status, "COMMITTING");
  }

  // prepareWrite wins first: domain ignore may update the candidate fact, but
  // cannot rewrite the already commit-granted delivery.
  {
    const { db, delivery, token } = commitRaceDb({ moduleKey: "follow_back", targetId: "fan-1", actionType: "FOLLOW_BACK" });
    const candidate = { id: "fc-2", agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", creatorFollowsFan: false };
    db.followBackCandidate.findFirst = async () => candidate;
    db.followBackCandidate.update = async ({ data }) => Object.assign(candidate, data);
    const action = loadActionService(db);
    const follow = loadFollowBackForFence(db);
    await action.prepareWriteActionDelivery({ deliveryId: delivery.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 2 });
    assert.equal(delivery.status, "COMMITTING");
    await follow.setCandidateState({ agencyId: "agency-1", creatorId: "creator-1", fanId: "fan-1", action: "ignore" });
    assert.equal(delivery.status, "COMMITTING");
  }
});

function loadLikesForFence(db) {
  cacheModule("../prisma", db);
  cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() });
  cacheModule("./job-planning-repository", { ensurePlannedJob: async () => ({ created: false, job: null }) });
  cacheModule("./automation-write-commit-fence-service", { runWithAutomationWriteCommitFence: async ({ work }) => work(db) });
  cacheModule("./automation-control-service", {
    LIKES_MODULE_KEY: "likes", getAutomationControlSnapshot: async () => ({}), assertAutomationEnabled: async () => ({}),
    normalizeLikesSettings: (x) => ({ dailyLimit: 100, contentMaxAgeDays: 30, onlyUnliked: true, postsPerFanMin: 1, postsPerFanMax: 1, maxAttempts: 3, ...x }), requireCreator: async () => ({}),
  });
  return fresh("./likes-service");
}

test("Closure2 Likes ignore vs prepareWrite has one fence winner", async () => {
  for (const winner of ["control", "prepare"]) {
    const { db, delivery, token } = commitRaceDb({ moduleKey: "likes", targetId: "post-1", actionType: "LIKE_POST" });
    const candidate = { id: `lc-${winner}`, agencyId: "agency-1", creatorId: "creator-1", contentId: "post-1", isFavorite: false };
    db.automationContentCandidate.findFirst = async () => candidate;
    db.automationContentCandidate.update = async ({ data }) => Object.assign(candidate, data);
    const action = loadActionService(db);
    const likes = loadLikesForFence(db);
    if (winner === "control") {
      await likes.setLikeCandidateState({ db, agencyId: "agency-1", creatorId: "creator-1", candidateId: candidate.id, action: "ignore" });
      assert.equal(delivery.status, "CANCELED");
      await assert.rejects(
        action.prepareWriteActionDelivery({ deliveryId: delivery.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 2 }),
        (error) => error?.code === "DELIVERY_NOT_CLAIMED",
      );
    } else {
      await action.prepareWriteActionDelivery({ deliveryId: delivery.id, userId: "user-1", deviceId: "device-1", leaseToken: token, leaseRevision: 2 });
      assert.equal(delivery.status, "COMMITTING");
      await likes.setLikeCandidateState({ db, agencyId: "agency-1", creatorId: "creator-1", candidateId: candidate.id, action: "ignore" });
      assert.equal(delivery.status, "COMMITTING");
    }
  }
});
