"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { withPhase3PostgresFixtureAuthority, cleanupPhase3PostgresAgencyFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
let projectSubscriberDirectoryItems;
let applyFanDataPointRefreshChunk;
let readFanCurrent;
let scheduleFanDataPointRefresh;
let scheduleDurableFanDataRefreshDebt;
let recordSubscriberScanFailure;
let applySubscriberScanChunk;
let scheduleSubscriberScan;
let repairSubscriberDirectoryStateGeneration;
let recoverSubscriberPublicationDebt;
let cleanupSubscriberScanHistory;
let runSubscriberDirectoryMaintenance;
let signalSubscriberDirectoryMaintenance;
let claimSubscriberDirectoryMaintenanceSignal;
let ackSubscriberDirectoryMaintenanceSignal;
let subscriberMaintenanceClaimCurrent;
let withSubscriberMaintenanceClaimFence;
let listPoisonedSubscriberMaintenanceSignals;
let requeuePoisonedSubscriberMaintenanceSignal;
let releaseSubscriberDirectoryMaintenanceSignal;
let SUBSCRIBER_MAINTENANCE_KIND;
let setAutomationControl;
let subscriberTest;
let enqueueUniqueCampaignFanRefreshes;
let finalizeCampaignFanRefreshJob;
let repairFailedCampaignFanRefreshDemands;
let runCampaignFanRefreshPromotionMaintenance;
let signalCampaignFanRefreshPromotion;

if (enabled) {
  ({ projectSubscriberDirectoryItems, applyFanDataPointRefreshChunk, readFanCurrent, scheduleFanDataPointRefresh, scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service"));
  ({
    recordSubscriberScanFailure,
    applySubscriberScanChunk,
    scheduleSubscriberScan,
    repairSubscriberDirectoryStateGeneration,
    recoverSubscriberPublicationDebt,
    cleanupSubscriberScanHistory,
    _test: subscriberTest,
  } = require("./subscriber-directory-service"));
  ({ runSubscriberDirectoryMaintenance } = require("./subscriber-directory-maintenance-service"));
  ({
    signalSubscriberDirectoryMaintenance,
    claimSubscriberDirectoryMaintenanceSignal,
    ackSubscriberDirectoryMaintenanceSignal,
    subscriberMaintenanceClaimCurrent,
    withSubscriberMaintenanceClaimFence,
    listPoisonedSubscriberMaintenanceSignals,
    requeuePoisonedSubscriberMaintenanceSignal,
    releaseSubscriberDirectoryMaintenanceSignal,
    SUBSCRIBER_MAINTENANCE_KIND,
  } = require("./subscriber-directory-maintenance-signal-service"));
  ({ setAutomationControl } = require("./automation-control-service"));
  ({
    enqueueUniqueCampaignFanRefreshes,
    finalizeCampaignFanRefreshJob,
    repairFailedCampaignFanRefreshDemands,
    runCampaignFanRefreshPromotionMaintenance,
    signalCampaignFanRefreshPromotion,
  } = require("./campaign-fan-refresh-queue-service"));
}

function nonce(prefix) {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

async function createAgencyCreator(db, prefix, { agencyId = null } = {}) {
  const n = nonce(prefix);
  const a = agencyId || `${n}-agency`;
  const c = `${n}-creator`;
  await withPhase3PostgresFixtureAuthority(db, async (tx) => {
    if (!agencyId) await tx.agency.create({ data: { id: a, name: `Final cut ${a}` } });
    await tx.creatorAccount.create({ data: { id: c, agencyId: a, displayName: `Final cut ${c}` } });
  });
  return { agencyId: a, creatorId: c };
}

async function cleanupAgency(db, agencyId) {
  await cleanupPhase3PostgresAgencyFixture(db, agencyId);
}

async function databaseNow(db) {
  const rows = await db.$queryRawUnsafe('SELECT clock_timestamp() AS "now"');
  const value = Array.isArray(rows) ? rows[0]?.now : null;
  const now = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(now.getTime())) throw new Error("PostgreSQL authority clock unavailable");
  return now;
}

async function configureA32DerivedPlanningModules(db, scope) {
  const moduleSettings = [
    ["follow_back", {
      enabled: true, automatic: true, activeSubscribers: true, expiredSubscribers: true,
      freeSubscribers: true, paidSubscribers: true, dailyLimit: 1000,
    }],
    ["follow", {
      enabled: true, automatic: true, refollowEnabled: true, dailyLimit: 1000, maxNudgesPerFan: 2,
    }],
    ["bumps", {
      enabled: true, automatic: true, hiddenOnlineEnabled: false, paidSubscribersEnabled: true,
      freeSubscribersEnabled: false, subscriptionEventsEnabled: false, onlineEnabled: false,
      dailyLimit: 1000, candidateBatchSize: 500,
    }],
  ];
  for (const [moduleKey, settings] of moduleSettings) {
    await setAutomationControl({
      agencyId: scope.agencyId, creatorId: scope.creatorId, userId: null,
      scope: "module", moduleKey, enabled: true, settings, db,
    });
  }
}

async function seedA32DerivedPlanningDebt(db, scope, { prefix = nonce("a32-derived"), fanCount = 500, generation = 77 } = {}) {
  const runId = `${prefix}-run`;
  const jobId = `${prefix}-subscriber-job`;
  const now = await databaseNow(db);
  const fanIds = Array.from({ length: fanCount }, (_, index) => `${scope.creatorId}-a32-fan-${String(index).padStart(4, "0")}`);

  await db.jobInstance.create({
    data: {
      id: jobId, jobKey: "subscriber_directory_scan", scope: "creator", creatorId: scope.creatorId, agencyId: scope.agencyId,
      status: "FAILED", leaseRevision: 1, lastError: "a32 derived planning proof",
      params: { scanRunId: runId, scanEveryDays: 7 },
    },
  });
  await db.subscriberScanRun.create({
    data: {
      id: runId, agencyId: scope.agencyId, creatorId: scope.creatorId, jobId, status: "PUBLISHED",
      hasMore: false, scannedCount: fanCount, fanProjectionStatus: "COMPLETE", fanProjectionCount: fanCount,
      fanProjectionCompletedAt: now, publicationStatus: "COMPLETE", publicationGeneration: generation,
      publicationStartedAt: now, publicationCompletedAt: now, publishedAt: now, completedAt: now, summary: { fanCount },
    },
  });
  await db.subscriberDirectoryState.create({
    data: {
      agencyId: scope.agencyId, creatorId: scope.creatorId, currentRunId: runId, lastJobId: jobId, status: "READY",
      totalCount: fanCount, publicationGeneration: generation, publishedGeneration: generation, publishedAt: now,
    },
  });

  const subscriberItems = fanIds.map((fanId, index) => ({
    id: `${prefix}-scan-${String(index).padStart(4, "0")}`, runId, agencyId: scope.agencyId, creatorId: scope.creatorId,
    fanId, dialogId: `${fanId}-dialog`, username: `fan_${index}`, name: `Fan ${index}`,
    subscriptionType: "paid", isActive: true, valueAvailability: "NOT_FETCHED",
    contentHash: `${prefix}-hash-${index}`, metadata: {}, observedAt: now,
  }));
  const followBack = fanIds.map((fanId, index) => ({
    id: `${prefix}-fb-${String(index).padStart(4, "0")}`, agencyId: scope.agencyId, creatorId: scope.creatorId, fanId,
    dialogId: `${fanId}-dialog`, username: `fan_${index}`, displayName: `Fan ${index}`, snapshotRunId: runId,
    state: "CANDIDATE", generation: 1, ignored: false, blocked: false, discoveredAt: now,
  }));
  const followAutomation = fanIds.map((fanId, index) => ({
    id: `${prefix}-fa-${String(index).padStart(4, "0")}`, agencyId: scope.agencyId, creatorId: scope.creatorId, fanId,
    dialogId: `${fanId}-dialog`, username: `fan_${index}`, displayName: `Fan ${index}`, snapshotRunId: runId,
    state: "CANDIDATE", phase: "IDLE", generation: 0, ignored: false, blocked: false, discoveredAt: now,
  }));
  await db.subscriberScanItem.createMany({ data: subscriberItems });
  await db.followBackCandidate.createMany({ data: followBack });
  await db.followAutomationCandidate.createMany({ data: followAutomation });
  await db.automationTask.create({
    data: {
      id: `${prefix}-bump-template`, agencyId: scope.agencyId, creatorId: scope.creatorId, type: "bump_online",
      title: "A32 derived planning proof", enabled: true, status: "active",
      config: { messageText: "A32 proof bump" }, triggers: { subscriber: true }, rules: {}, schedule: {}, stats: {}, metadata: {},
    },
  });
  await configureA32DerivedPlanningModules(db, scope);
  return { runId, jobId, fanIds, generation, now };
}

async function planner(input) {
  const existing = await input.db.jobInstance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { job: existing, created: false, reason: "idempotency_reused" };
  try {
    const job = await input.db.jobInstance.create({
      data: {
        jobKey: input.jobKey,
        scope: input.scope,
        creatorId: input.creatorId,
        agencyId: input.agencyId,
        idempotencyKey: input.idempotencyKey,
        params: input.params,
        priority: input.priority,
        scheduledAt: input.scheduledAt,
        nextRunAt: input.nextRunAt,
        status: "SCHEDULED",
      },
    });
    return { job, created: true, reason: "created" };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const job = await input.db.jobInstance.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (!job) throw error;
    return { job, created: false, reason: "idempotency_reused" };
  }
}

function subscriberItem({ fanId, observedAt, totalSpentCents, username = "subscriber_fan" }) {
  return {
    fanId,
    username,
    name: username,
    avatarUrl: null,
    observedAt,
    totalSpentCents,
    valueAvailability: "AVAILABLE",
    metadata: {
      fanDataObservedFields: {
        identity: ["username", "platformDisplayName"],
        relationship: [],
        value: ["totalSpentCents"],
      },
    },
  };
}

async function createCampaignScope(db, scope, { runId = "final-cut-run", fanId = null } = {}) {
  const campaignJobId = `${scope.creatorId}-campaign-job`;
  await db.creatorCampaignCollectionState.create({
    data: {
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      status: "PARTIAL",
      mode: "full",
      membershipCoverageStatus: "COMPLETE",
      campaignFrontierFreshnessStatus: "COMPLETE",
    },
  });
  const job = await db.jobInstance.create({
    data: {
      id: campaignJobId,
      jobKey: "fetch_campaigns",
      scope: "creator",
      creatorId: scope.creatorId,
      agencyId: scope.agencyId,
      status: "CLAIMED",
      leaseRevision: 1,
      params: { campaignFreshnessCoverageVersion: 1 },
    },
  });
  if (!fanId) return { job };
  const startedAt = new Date("2042-02-01T00:00:00.000Z");
  const queued = await db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
    db: tx,
    job,
    scanRunId: runId,
    scanStartedAt: startedAt,
    candidates: [{ onlyFansUserId: fanId }],
    now: new Date(startedAt.getTime() + 1000),
    planner,
    collectorVersion: "campaigns-final-cut-v1",
  }), { maxWait: 30_000, timeout: 60_000 });
  return { job, queued, startedAt };
}

test("FINAL PostgreSQL: Subscriber canonical publish and point-refresh share one commitFanFacts authority and latest chronology wins", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const subscriberDb = new PrismaClient();
  const refreshDb = new PrismaClient();
  const scope = await createAgencyCreator(subscriberDb, "final-subscriber-race");
  const fanId = `${scope.creatorId}-fan`;
  const subscriberAt = new Date("2042-01-01T00:00:00.000Z");
  const refreshAt = new Date("2042-01-02T00:00:00.000Z");
  const refreshJob = await subscriberDb.jobInstance.create({
    data: {
      id: `${scope.creatorId}-refresh-job`, jobKey: "fan_data_point_refresh", scope: "creator",
      creatorId: scope.creatorId, agencyId: scope.agencyId, status: "CLAIMED", leaseRevision: 1,
      createdAt: refreshAt, params: { fanIds: [fanId], observationTokenVersion: 0 },
    },
  });
  try {
    await Promise.all([
      projectSubscriberDirectoryItems(subscriberDb, {
        items: [subscriberItem({ fanId, observedAt: subscriberAt, totalSpentCents: 100 })],
        agencyId: scope.agencyId, creatorId: scope.creatorId, runId: `${scope.creatorId}-subscriber-run`,
      }),
      applyFanDataPointRefreshChunk({
        db: refreshDb,
        job: refreshJob,
        deviceId: null,
        chunkResult: {
          kind: "fan_data_point_refresh",
          items: [{
            onlyFansUserId: fanId,
            value: { source: "USER_PROFILE", availability: "AVAILABLE", totalSpentCents: 250, messagesSpentCents: 25 },
          }],
        },
      }),
    ]);
    const current = await readFanCurrent(subscriberDb, { agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserIds: [fanId] });
    assert.equal(current.length, 1);
    assert.equal(current[0].value?.source, "USER_PROFILE");
    assert.equal(current[0].value?.platformReportedTotalSpendCents, 250);
    assert.equal(current[0].value?.observedAt?.toISOString(), refreshAt.toISOString());
    console.log("# FINAL_SUBSCRIBER_POINT_REFRESH_RACE_PASS");
  } finally {
    await cleanupAgency(subscriberDb, scope.agencyId);
    await subscriberDb.$disconnect();
    await refreshDb.$disconnect();
  }
});

test("FINAL PostgreSQL: Subscriber persisted same-generation contradiction fails closed under shared canonical authority", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-subscriber-conflict");
  const fanId = `${scope.creatorId}-fan`;
  const observedAt = new Date("2042-01-03T00:00:00.000Z");
  try {
    await projectSubscriberDirectoryItems(db, {
      items: [subscriberItem({ fanId, observedAt, totalSpentCents: 100 })],
      agencyId: scope.agencyId, creatorId: scope.creatorId, runId: `${scope.creatorId}-run-a`,
    });
    await assert.rejects(
      () => projectSubscriberDirectoryItems(db, {
        items: [subscriberItem({ fanId, observedAt, totalSpentCents: 101 })],
        agencyId: scope.agencyId, creatorId: scope.creatorId, runId: `${scope.creatorId}-run-b`,
      }),
      (error) => error?.code === "FAN_DATA_SAME_GENERATION_CONFLICT",
    );
    console.log("# FINAL_SUBSCRIBER_PERSISTED_CONFLICT_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("FINAL PostgreSQL: lost final Subscriber response crosses durable fanProjection barrier and publishes idempotently on failure repair", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-subscriber-lost-response");
  const scheduled = await scheduleSubscriberScan({
    agencyId: scope.agencyId,
    creatorId: scope.creatorId,
    manual: true,
    force: true,
    reason: "FINAL_LOST_RESPONSE_PROOF",
  });
  const runId = scheduled?.run?.id;
  const jobId = scheduled?.job?.id;
  assert.ok(runId && jobId, "production Subscriber allocator must create run/job generation");
  const job = await db.jobInstance.update({
    where: { id: jobId },
    data: { status: "CLAIMED", leaseRevision: 1 },
  });
  await db.subscriberScanRun.update({
    where: { id: runId },
    data: {
      status: "RUNNING", nextOffset: 0, scannedCount: 0, pageCount: 1,
      hasMore: false, fanProjectionStatus: "COMPLETE", fanProjectionCursorOffset: 0,
      fanProjectionCount: 0, fanProjectionCompletedAt: new Date(),
    },
  });
  try {
    const repaired = await recordSubscriberScanFailure({ job, error: "simulated lost final response", terminal: true, db });
    assert.equal(repaired?.status, "RUNNING");
    assert.equal(repaired?.publicationRecoveryPending, true);
    assert.equal(await db.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: scope.creatorId, kind: "RECOVERY" } }), 1);

    const maintenanceNow = await databaseNow(db);
    const maintenance = await runSubscriberDirectoryMaintenance({
      db,
      now: maintenanceNow,
      maxSignals: 4,
      concurrency: 1,
      maxRuntimeMs: 10_000,
      recoveryStepsPerRun: 8,
    });
    assert.equal(maintenance.errors, 0, JSON.stringify(maintenance.errorDetails || []));
    const after = await db.subscriberScanRun.findUnique({ where: { id: runId } });
    const afterJob = await db.jobInstance.findUnique({ where: { id: jobId } });
    assert.equal(after?.status, "PUBLISHED");
    assert.ok(after?.publicationJobReconciledAt instanceof Date);
    assert.equal(afterJob?.status, "DONE");
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state?.currentRunId, runId);

    const replay = await recordSubscriberScanFailure({ job: afterJob, error: "duplicate terminal callback", terminal: true, db });
    assert.equal(replay?.status, "PUBLISHED");
    const afterReplay = await db.subscriberScanRun.findUnique({ where: { id: runId } });
    assert.equal(afterReplay?.publicationJobReconciledAt?.getTime?.(), after?.publicationJobReconciledAt?.getTime?.());
    console.log("# FINAL_SUBSCRIBER_LOST_RESPONSE_BARRIER_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("FINAL PostgreSQL: manual repair and durable maintenance overlap without creator->global lock inversion", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const manualDb = new PrismaClient();
  const maintenanceDb = new PrismaClient();
  const scope = await createAgencyCreator(manualDb, "final-manual-maintenance");
  const fanId = `${scope.creatorId}-fan`;
  try {
    const { queued } = await createCampaignScope(manualDb, scope, { fanId });
    assert.ok(queued?.refreshJobId);
    await finalizeCampaignFanRefreshJob({
      db: manualDb,
      job: { id: queued.refreshJobId, jobKey: "fan_data_point_refresh", creatorId: scope.creatorId, agencyId: scope.agencyId },
      result: {},
    });
    const later = new Date("2042-02-01T00:20:00.000Z");
    const [manual, maintenance] = await Promise.all([
      repairFailedCampaignFanRefreshDemands({ db: manualDb, creatorId: scope.creatorId, now: later, maxDemands: 50 }),
      runCampaignFanRefreshPromotionMaintenance({ db: maintenanceDb, now: later, maxCreators: 1, maxJobsPerCreator: 1 }),
    ]);
    assert.ok(Number(manual?.recovered || 0) >= 0);
    assert.ok(Number(maintenance?.processedCreators || 0) >= 0);
    const demand = await manualDb.creatorFanRefreshDemand.findUnique({ where: { creatorId_onlyFansUserId: { creatorId: scope.creatorId, onlyFansUserId: fanId } } });
    assert.notEqual(demand?.status, "FAILED");
    const signalCount = await manualDb.campaignFanRefreshPromotionSignal.count({ where: { creatorId: scope.creatorId } });
    assert.ok(signalCount <= 1);
    console.log("# FINAL_MANUAL_MAINTENANCE_OVERLAP_PASS");
  } finally {
    await cleanupAgency(manualDb, scope.agencyId);
    await manualDb.$disconnect();
    await maintenanceDb.$disconnect();
  }
});

test("FINAL PostgreSQL: two maintenance replicas claim bounded creator signals without duplicate processing", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const first = await createAgencyCreator(dbA, "final-maint-a");
  const second = await createAgencyCreator(dbA, "final-maint-b", { agencyId: first.agencyId });
  try {
    const due = await databaseNow(dbA);
    await signalCampaignFanRefreshPromotion({ db: dbA, agencyId: first.agencyId, creatorId: first.creatorId, dueAt: due, reason: "FINAL_PROOF" });
    await signalCampaignFanRefreshPromotion({ db: dbA, agencyId: second.agencyId, creatorId: second.creatorId, dueAt: due, reason: "FINAL_PROOF" });
    const [a, b] = await Promise.all([
      runCampaignFanRefreshPromotionMaintenance({ db: dbA, now: due, maxCreators: 2, maxJobsPerCreator: 1 }),
      runCampaignFanRefreshPromotionMaintenance({ db: dbB, now: due, maxCreators: 2, maxJobsPerCreator: 1 }),
    ]);
    assert.equal(Number(a.processedCreators || 0) + Number(b.processedCreators || 0), 2);
    assert.equal(await dbA.campaignFanRefreshPromotionSignal.count({ where: { creatorId: { in: [first.creatorId, second.creatorId] } } }), 0);
    console.log("# FINAL_TWO_REPLICA_PROMOTION_SIGNAL_PASS");
  } finally {
    await cleanupAgency(dbA, first.agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("FINAL PostgreSQL: cutover signal heals queued Campaign debt already satisfied by canonical FanData", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-cutover-heal");
  const fanId = `${scope.creatorId}-fan`;
  const runId = `${scope.creatorId}-run`;
  const cutoff = new Date("2042-04-01T00:00:00.000Z");
  const observedAt = new Date("2042-04-01T00:01:00.000Z");
  try {
    await db.creatorCampaignCollectionState.create({
      data: {
        agencyId: scope.agencyId, creatorId: scope.creatorId, status: "PARTIAL", mode: "full",
        fanValueCoverageScanRunId: runId, fanValueFreshnessStatus: "QUEUED",
        fanValueExpected: 1, fanValueQueued: 1, fanValueOutstanding: 1,
      },
    });
    const campaignJob = await db.jobInstance.create({
      data: { jobKey: "fetch_campaigns", scope: "creator", creatorId: scope.creatorId, agencyId: scope.agencyId, status: "DONE" },
    });
    const fan = await db.creatorFan.create({ data: { agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserId: fanId } });
    await db.creatorFanValueCurrent.create({
      data: {
        agencyId: scope.agencyId, creatorId: scope.creatorId, fanRecordId: fan.id,
        valueObservedAt: observedAt, availability: "AVAILABLE", source: "CUTOVER_EXISTING_CANONICAL",
      },
    });
    const demand = await db.creatorFanRefreshDemand.create({
      data: {
        agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserId: fanId,
        requestedFreshnessCutoffAt: cutoff, status: "QUEUED", requestedRevision: 1,
      },
    });
    await db.creatorCampaignFanRefreshWork.create({
      data: {
        agencyId: scope.agencyId, creatorId: scope.creatorId, scanRunId: runId, scanStartedAt: cutoff,
        onlyFansUserId: fanId, campaignJobId: campaignJob.id, demandId: demand.id,
        requestedRevision: 1, freshnessCutoffAt: cutoff, status: "QUEUED", scheduledAt: cutoff,
      },
    });
    const due = await databaseNow(db);
    await signalCampaignFanRefreshPromotion({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, dueAt: due, reason: "CUTOVER_BACKFILL_PROOF" });
    const result = await runCampaignFanRefreshPromotionMaintenance({ db, now: due, maxCreators: 1, maxJobsPerCreator: 1 });
    assert.equal(result.healedFans, 1);
    const afterDemand = await db.creatorFanRefreshDemand.findUnique({ where: { id: demand.id } });
    const afterWork = await db.creatorCampaignFanRefreshWork.findFirst({ where: { demandId: demand.id } });
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(afterDemand?.status, "COMPLETE");
    assert.equal(afterWork?.status, "SUCCEEDED");
    assert.equal(state?.fanValueOutstanding, 0);
    assert.equal(state?.fanValueSucceeded, 1);
    console.log("# FINAL_CUTOVER_CANONICAL_DEBT_HEAL_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});


test("FINAL PostgreSQL: Subscriber NOT_FETCHED cannot overwrite AVAILABLE canonical value or satisfy active Campaign debt", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-subscriber-not-fetched");
  const fanId = `${scope.creatorId}-fan`;
  const initialAt = new Date("2042-01-31T23:59:00.000Z");
  try {
    await projectSubscriberDirectoryItems(db, {
      items: [subscriberItem({ fanId, observedAt: initialAt, totalSpentCents: 777 })],
      agencyId: scope.agencyId, creatorId: scope.creatorId, runId: `${scope.creatorId}-initial-run`,
    });
    const { queued } = await createCampaignScope(db, scope, { runId: `${scope.creatorId}-campaign-run`, fanId });
    assert.ok(Number(queued?.queued || 0) >= 1, "campaign debt must be outstanding before NOT_FETCHED proof");

    await projectSubscriberDirectoryItems(db, {
      items: [{
        fanId,
        username: "subscriber_fan",
        name: "subscriber_fan",
        observedAt: new Date("2042-02-02T00:00:00.000Z"),
        valueAvailability: "NOT_FETCHED",
        metadata: { fanDataObservedFields: { identity: ["username", "platformDisplayName"], relationship: [], value: [] } },
      }],
      agencyId: scope.agencyId, creatorId: scope.creatorId, runId: `${scope.creatorId}-not-fetched-run`,
    });

    const current = await readFanCurrent(db, { agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserIds: [fanId] });
    assert.equal(current.length, 1);
    assert.equal(current[0].value?.availability, "AVAILABLE");
    assert.equal(Number(current[0].value?.platformReportedTotalSpendCents), 777);
    const demand = await db.creatorFanRefreshDemand.findUnique({ where: { creatorId_onlyFansUserId: { creatorId: scope.creatorId, onlyFansUserId: fanId } } });
    assert.notEqual(demand?.status, "COMPLETE");
    const work = await db.creatorCampaignFanRefreshWork.findFirst({ where: { demandId: demand.id } });
    assert.notEqual(work?.status, "COMPLETE");
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.ok(Number(state?.fanValueOutstanding || 0) >= 1);
    console.log("# FINAL_SUBSCRIBER_NOT_FETCHED_CAMPAIGN_DEBT_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("FINAL PostgreSQL: concurrent Subscriber pages serialize on the durable cursor and conflicting replay fails closed", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const scope = await createAgencyCreator(dbA, "final-subscriber-concurrent-page");
  const jobId = `${scope.creatorId}-subscriber-job`;
  const runId = `${scope.creatorId}-subscriber-run`;
  const createdAt = new Date("2042-05-01T00:00:00.000Z");
  const job = await dbA.jobInstance.create({
    data: {
      id: jobId, jobKey: "subscriber_directory_scan", scope: "creator", creatorId: scope.creatorId,
      agencyId: scope.agencyId, status: "CLAIMED", leaseRevision: 1, createdAt,
      params: { scanRunId: runId, scanEveryDays: 7, observationTokenVersion: 0 },
    },
  });
  await dbA.subscriberScanRun.create({
    data: {
      id: runId, agencyId: scope.agencyId, creatorId: scope.creatorId, jobId,
      status: "RUNNING", pageLimit: 100, nextOffset: 0, scannedCount: 0, pageCount: 0,
      hasMore: true, createdAt, fanProjectionStatus: "PENDING", fanProjectionCursorOffset: 0, fanProjectionCount: 0,
    },
  });
  const page = (fanId) => ({
    kind: "subscriber_directory_page", scanRunId: runId, offset: 0, nextOffset: 1, hasMore: true,
    items: [{ fanId, username: fanId, name: fanId, valueAvailability: "NOT_FETCHED", metadata: {} }],
  });
  try {
    const settled = await Promise.allSettled([
      dbA.$transaction((tx) => applySubscriberScanChunk({ db: tx, job, deviceId: "device-a", chunkResult: page(`${scope.creatorId}-fan-a`) }), { maxWait: 30_000, timeout: 60_000 }),
      dbB.$transaction((tx) => applySubscriberScanChunk({ db: tx, job, deviceId: "device-b", chunkResult: page(`${scope.creatorId}-fan-b`) }), { maxWait: 30_000, timeout: 60_000 }),
    ]);
    assert.equal(settled.filter((row) => row.status === "fulfilled").length, 1);
    const rejected = settled.find((row) => row.status === "rejected");
    assert.ok(["SUBSCRIBER_SCAN_REPLAY_CONFLICT", "SUBSCRIBER_SCAN_REWIND", "SUBSCRIBER_SCAN_CURSOR_CONFLICT"].includes(rejected?.reason?.code));
    const durable = await dbA.subscriberScanRun.findUnique({ where: { id: runId } });
    assert.equal(durable?.nextOffset, 1);
    assert.equal(durable?.scannedCount, 1);
    assert.equal(await dbA.subscriberScanPage.count({ where: { runId } }), 1);
    assert.equal(await dbA.subscriberScanItem.count({ where: { runId } }), 1);
    console.log("# FINAL_SUBSCRIBER_CONCURRENT_CURSOR_PASS");
  } finally {
    await cleanupAgency(dbA, scope.agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("FINAL PostgreSQL: multi-creator/multi-agency Campaign hot paths are bounded and every intended index is planner-eligible", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-hot-plan");
  const noise = await createAgencyCreator(db, "final-hot-plan-noise");
  const prefix = `${scope.creatorId}-plan`;
  const noisePrefix = `${noise.creatorId}-plan-noise`;
  const campaignJobId = `${scope.creatorId}-plan-job`;
  const now = new Date("2042-06-01T00:00:00.000Z");
  const targetDebtRows = 400;
  const targetQueuedRows = 200;
  const sameAgencyNoiseCreators = 999;
  const crossAgencyNoiseCreators = 199;
  try {
    await db.jobInstance.create({ data: { id: campaignJobId, jobKey: "fetch_campaigns", scope: "creator", creatorId: scope.creatorId, agencyId: scope.agencyId, status: "DONE" } });
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFanRefreshDemand" (
        "id","agencyId","creatorId","onlyFansUserId","requestedFreshnessCutoffAt","status",
        "lastRequestedAt","lastFailedAt","nextRetryAt","createdAt","updatedAt"
      )
      SELECT $1 || '-d-' || g::text, $2, $3, $1 || '-fan-' || g::text, $4,
             CASE WHEN g <= $5 THEN 'QUEUED' ELSE 'FAILED' END,
             $4 - (g * INTERVAL '1 second'),
             CASE WHEN g > $5 THEN $4 - (g * INTERVAL '1 second') ELSE NULL END,
             CASE WHEN g > $5 THEN $4 - INTERVAL '1 minute' ELSE NULL END,
             $4 - INTERVAL '1 day', $4 - (g * INTERVAL '1 second')
      FROM generate_series(1, $6::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, targetQueuedRows, targetDebtRows);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorCampaignFanRefreshWork" (
        "id","agencyId","creatorId","scanRunId","scanStartedAt","onlyFansUserId","campaignJobId","demandId",
        "requestedRevision","freshnessCutoffAt","status","scheduledAt","createdAt","updatedAt"
      )
      SELECT $1 || '-w-' || g::text, $2, $3, $1 || '-run', $4, $1 || '-fan-' || g::text, $5,
             $1 || '-d-' || g::text, 1, $4, 'QUEUED', $4, $4, $4
      FROM generate_series(1, $6::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, campaignJobId, targetQueuedRows);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFan" ("id","agencyId","creatorId","onlyFansUserId","firstSeenAt","lastSeenAt","createdAt","updatedAt")
      SELECT $1 || '-f-' || g::text, $2, $3, $1 || '-fan-' || g::text, $4, $4, $4, $4
      FROM generate_series(1, $5::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, targetDebtRows);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFanValueCurrent" ("id","agencyId","creatorId","fanId","fetchedAt","availability","source","createdAt","updatedAt")
      SELECT $1 || '-v-' || g::text, $2, $3, $1 || '-f-' || g::text, $4 + INTERVAL '1 minute', 'AVAILABLE', 'PLAN_PROOF', $4, $4
      FROM generate_series(1, $5::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, targetDebtRows);

    await withPhase3PostgresFixtureAuthority(db, async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "CreatorAccount" ("id","agencyId","displayName","createdAt","updatedAt")
        SELECT $1 || '-creator-' || g::text, $2, 'plan-signal-' || g::text, $3, $3
        FROM generate_series(1, $4::integer) AS g
      `, prefix, scope.agencyId, now, sameAgencyNoiseCreators);
      await tx.$executeRawUnsafe(`
        INSERT INTO "CreatorAccount" ("id","agencyId","displayName","createdAt","updatedAt")
        SELECT $1 || '-creator-' || g::text, $2, 'plan-noise-' || g::text, $3, $3
        FROM generate_series(1, $4::integer) AS g
      `, noisePrefix, noise.agencyId, now, crossAgencyNoiseCreators);
    });

    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFanRefreshDemand" (
        "id","agencyId","creatorId","onlyFansUserId","requestedFreshnessCutoffAt","status",
        "lastRequestedAt","createdAt","updatedAt"
      )
      SELECT $1 || '-noise-d-' || g::text, $2, $1 || '-creator-' || g::text,
             $1 || '-noise-fan-' || g::text, $3, 'QUEUED', $3, $3, $3
      FROM generate_series(1, $4::integer) AS g
    `, prefix, scope.agencyId, now, sameAgencyNoiseCreators);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFanRefreshDemand" (
        "id","agencyId","creatorId","onlyFansUserId","requestedFreshnessCutoffAt","status",
        "lastRequestedAt","createdAt","updatedAt"
      )
      SELECT $1 || '-d-' || g::text, $2, $1 || '-creator-' || g::text,
             $1 || '-fan-' || g::text, $3, 'QUEUED', $3, $3, $3
      FROM generate_series(1, $4::integer) AS g
    `, noisePrefix, noise.agencyId, now, crossAgencyNoiseCreators);

    await db.$executeRawUnsafe(`
      INSERT INTO "CampaignFanRefreshPromotionSignal" ("id","agencyId","creatorId","dueAt","reason","createdAt","updatedAt")
      SELECT $1 || '-sig-' || g::text, $2,
             CASE WHEN g = $5 THEN $3 ELSE $1 || '-creator-' || g::text END,
             $4 - (g * INTERVAL '1 millisecond'), 'PLAN_PROOF', $4, $4
      FROM generate_series(1, $5::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, sameAgencyNoiseCreators + 1);
    await db.$executeRawUnsafe(`
      INSERT INTO "SubscriberDirectoryMaintenanceSignal" ("id","agencyId","creatorId","kind","dueAt","reason","revision","attempts","createdAt","updatedAt")
      SELECT $1 || '-subsig-' || g::text, $2,
             CASE WHEN g = $5 THEN $3 ELSE $1 || '-creator-' || g::text END,
             'RECOVERY', $4 - (g * INTERVAL '1 millisecond'), 'PLAN_PROOF', 1, 0, $4, $4
      FROM generate_series(1, $5::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, sameAgencyNoiseCreators + 1);

    for (const table of [
      "CreatorFanRefreshDemand", "CreatorCampaignFanRefreshWork", "CreatorFan",
      "CreatorFanValueCurrent", "CampaignFanRefreshPromotionSignal", "SubscriberDirectoryMaintenanceSignal",
    ]) await db.$executeRawUnsafe(`ANALYZE "${table}"`);

    const analyzed = async (sql, ...args) => {
      const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ...args);
      const payload = rows?.[0]?.["QUERY PLAN"] || rows || [];
      const root = Array.isArray(payload) ? payload[0] : payload;
      return { root, text: JSON.stringify(payload) };
    };
    const assertIndexReady = async (indexName, tableName) => {
      const rows = await db.$queryRawUnsafe(`
        SELECT i.indisvalid AS "valid", i.indisready AS "ready", am.amname AS "method"
        FROM pg_class idx
        JOIN pg_index i ON i.indexrelid=idx.oid
        JOIN pg_class tbl ON tbl.oid=i.indrelid
        JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
        JOIN pg_am am ON am.oid=idx.relam
        WHERE ns.nspname=current_schema() AND idx.relname=$1 AND tbl.relname=$2
      `, indexName, tableName);
      assert.equal(rows.length, 1, `${indexName} missing from current schema`);
      assert.equal(rows[0].valid, true, `${indexName} is not valid`);
      assert.equal(rows[0].ready, true, `${indexName} is not ready`);
      assert.equal(rows[0].method, "btree", `${indexName} is not btree`);
    };
    const assertAnyIndexEligible = async (label, sql, ...args) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const rows = await tx.$queryRawUnsafe(`EXPLAIN (COSTS OFF, FORMAT JSON) ${sql}`, ...args);
      const payload = rows?.[0]?.["QUERY PLAN"] || rows || [];
      const text = JSON.stringify(payload);
      assert.match(text, /Index (?:Only )?Scan|Bitmap Index Scan/, `${label} has no index path when seqscan is disabled: ${text}`);
      return text;
    }, { maxWait: 10_000, timeout: 30_000 });
    const bounded = (label, plan, { maxMs = 500, maxBlocks = 30_000 } = {}) => {
      const executionMs = Number(plan.root?.["Execution Time"] || 0);
      const p = plan.root?.Plan || {};
      const blocks = Number(p["Shared Hit Blocks"] || 0) + Number(p["Shared Read Blocks"] || 0);
      assert.ok(executionMs >= 0 && executionMs <= maxMs, `${label} execution ${executionMs}ms exceeded ${maxMs}ms`);
      assert.ok(blocks <= maxBlocks, `${label} shared blocks ${blocks} exceeded ${maxBlocks}`);
      assert.equal(Number(p["Temp Read Blocks"] || 0) + Number(p["Temp Written Blocks"] || 0), 0, `${label} spilled to temp`);
      return { executionMs, blocks };
    };

    const promoterSql = `
      SELECT d."id" FROM "CreatorFanRefreshDemand" d
      WHERE d."creatorId" = $1 AND d."status" = 'QUEUED' AND d."activeRefreshJobId" IS NULL
        AND EXISTS (SELECT 1 FROM "CreatorCampaignFanRefreshWork" w WHERE w."demandId" = d."id" AND w."status" = 'QUEUED')
      ORDER BY d."lastRequestedAt" ASC, d."id" ASC LIMIT 500`;
    const recoverySql = `
      SELECT d."id" FROM "CreatorFanRefreshDemand" d
      WHERE d."creatorId" = $1 AND d."status" = 'FAILED' AND d."activeRefreshJobId" IS NULL
        AND d."quarantinedAt" IS NULL AND d."nextRetryAt" IS NOT NULL AND d."nextRetryAt" <= $2
      ORDER BY COALESCE(d."nextRetryAt", d."lastFailedAt", d."updatedAt") ASC, d."id" ASC LIMIT 500`;
    const healSql = `
      SELECT d."onlyFansUserId"
      FROM "CreatorFanRefreshDemand" d
      JOIN "CreatorFan" f ON f."creatorId" = d."creatorId" AND f."onlyFansUserId" = d."onlyFansUserId"
      JOIN "CreatorFanValueCurrent" v ON v."creatorId" = f."creatorId" AND v."fanId" = f."id"
      WHERE d."creatorId" = $1 AND d."status" IN ('QUEUED','FAILED')
        AND v."fetchedAt" IS NOT NULL AND v."fetchedAt" >= d."requestedFreshnessCutoffAt"
      ORDER BY d."updatedAt" ASC, d."id" ASC LIMIT 500`;
    const signalSql = `
      SELECT s."id" FROM "CampaignFanRefreshPromotionSignal" s
      WHERE s."dueAt" <= $1 AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
      ORDER BY s."dueAt" ASC, s."creatorId" ASC LIMIT 20`;
    const subscriberSql = `
      SELECT s."id" FROM "SubscriberDirectoryMaintenanceSignal" s
      WHERE s."dueAt" <= $1 AND s."attempts" < 100
        AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
      ORDER BY s."dueAt" ASC, s."creatorId" ASC, s."kind" ASC LIMIT 1`;

    const promoter = await analyzed(promoterSql, scope.creatorId);
    const recovery = await analyzed(recoverySql, scope.creatorId, now);
    const heal = await analyzed(healSql, scope.creatorId);
    const signal = await analyzed(signalSql, now);
    const subscriberMaintenance = await analyzed(subscriberSql, now);
    const stats = {
      promoter: bounded("promoter", promoter),
      recovery: bounded("recovery", recovery),
      heal: bounded("heal", heal),
      campaignSignal: bounded("campaign-signal", signal),
      subscriberSignal: bounded("subscriber-signal", subscriberMaintenance),
    };
    const promoterEligibilitySql = `
      SELECT d."id" FROM "CreatorFanRefreshDemand" d
      WHERE d."creatorId" = $1 AND d."status" = 'QUEUED' AND d."activeRefreshJobId" IS NULL
      ORDER BY d."lastRequestedAt" ASC, d."id" ASC LIMIT 500`;
    const healEligibilitySql = `
      SELECT d."id" FROM "CreatorFanRefreshDemand" d
      WHERE d."creatorId" = $1 AND d."status" IN ('QUEUED','FAILED')
      ORDER BY d."updatedAt" ASC, d."id" ASC LIMIT 500`;
    await assertIndexReady("CreatorFanRefreshDemand_promoter_ready_idx", "CreatorFanRefreshDemand");
    await assertIndexReady("CreatorFanRefreshDemand_recovery_order_idx", "CreatorFanRefreshDemand");
    await assertIndexReady("CreatorFanRefreshDemand_canonical_heal_idx", "CreatorFanRefreshDemand");
    await assertIndexReady("CampaignFanRefreshPromotionSignal_claim_due_idx", "CampaignFanRefreshPromotionSignal");
    await assertIndexReady("SubscriberDirectoryMaintenanceSignal_due_claim_idx", "SubscriberDirectoryMaintenanceSignal");
    await assertAnyIndexEligible("promoter", promoterEligibilitySql, scope.creatorId);
    await assertAnyIndexEligible("recovery", recoverySql, scope.creatorId, now);
    await assertAnyIndexEligible("canonical-heal", healEligibilitySql, scope.creatorId);
    await assertAnyIndexEligible("campaign-signal", signalSql, now);
    await assertAnyIndexEligible("subscriber-signal", subscriberSql, now);

    console.log(`FINAL_HOT_QUERY_PLAN_PROOF ${JSON.stringify({
      targetDebtRows,
      sameAgencyNoiseCreators,
      crossAgencyNoiseCreators,
      stats,
      indexEligibility: true,
    })}`);
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await cleanupAgency(db, noise.agencyId);
    await db.$disconnect();
  }
});

test("FINAL PostgreSQL: 4000-run Subscriber history has bounded reconciliation and retention without cross-creator deletion", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-subscriber-reconcile-plan");
  const sibling = await createAgencyCreator(db, "final-subscriber-reconcile-sibling", { agencyId: scope.agencyId });
  const prefix = `${scope.creatorId}-reconcile-plan`;
  const now = new Date("2042-07-01T00:00:00.000Z");
  try {
    await db.$executeRawUnsafe(`
      INSERT INTO "SubscriberScanRun" (
        "id","agencyId","creatorId","status","publicationGeneration","hasMore","fanProjectionStatus","publicationStatus",
        "publicationJobReconciledAt","summary","createdAt","updatedAt"
      )
      SELECT $1 || '-run-' || g::text, $2, $3,
             CASE WHEN g % 2 = 0 THEN 'PUBLISHED' ELSE 'SUPERSEDED' END,
             g, false, 'COMPLETE', 'COMPLETE',
             CASE WHEN g <= 200 THEN NULL ELSE $4 END,
             '{}'::jsonb, $4 - INTERVAL '1 day', $4 - (g * INTERVAL '1 second')
      FROM generate_series(1, 4000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now);
    await db.subscriberScanRun.create({
      data: {
        id: `${sibling.creatorId}-safe-run`, agencyId: sibling.agencyId, creatorId: sibling.creatorId,
        status: "FAILED", publicationGeneration: 1, hasMore: false, fanProjectionStatus: "COMPLETE",
        publicationStatus: "COMPLETE", publicationJobReconciledAt: now, summary: {},
      },
    });
    await db.$executeRawUnsafe('ANALYZE "SubscriberScanRun"');

    const generationRepairStarted = Date.now();
    const generationRepair = await repairSubscriberDirectoryStateGeneration({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
    });
    const generationRepairMs = Date.now() - generationRepairStarted;
    assert.equal(generationRepair.maxGeneration, 4000);
    assert.equal(generationRepair.maxPublishedGeneration, 4000);
    assert.ok(generationRepairMs <= 1_000, `Subscriber generation repair ${generationRepairMs}ms exceeded 1000ms`);
    const repairedState = await db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(repairedState.publicationGeneration, 4000);
    assert.equal(repairedState.publishedGeneration, 4000);

    const generationLookup = `
      SELECT r."publicationGeneration"
      FROM "SubscriberScanRun" r
      WHERE r."agencyId"=$1 AND r."creatorId"=$2
        AND r."status" IN ('PUBLISHED','SUPERSEDED')
        AND r."publicationStatus"='COMPLETE'
      ORDER BY r."publicationGeneration" DESC, r."id" DESC
      LIMIT 1`;
    const publishedIndex = await db.$queryRawUnsafe(`
      SELECT i.indisvalid AS "valid", i.indisready AS "ready"
      FROM pg_class idx
      JOIN pg_index i ON i.indexrelid=idx.oid
      JOIN pg_class tbl ON tbl.oid=i.indrelid
      JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
      WHERE ns.nspname=current_schema()
        AND idx.relname='SubscriberScanRun_creator_published_generation_idx'
        AND tbl.relname='SubscriberScanRun'
    `);
    assert.equal(publishedIndex.length, 1);
    assert.equal(publishedIndex[0].valid, true);
    assert.equal(publishedIndex[0].ready, true);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const planRows = await tx.$queryRawUnsafe(`EXPLAIN (COSTS OFF, FORMAT JSON) ${generationLookup}`, scope.agencyId, scope.creatorId);
      const planText = JSON.stringify(planRows?.[0]?.["QUERY PLAN"] || planRows || []);
      assert.match(planText, /Index (?:Only )?Scan|Bitmap Index Scan/, `published-generation query has no index path: ${planText}`);
    });

    const query = `
      SELECT r."id"
      FROM "SubscriberScanRun" r
      WHERE r."status" IN ('PUBLISHED','SUPERSEDED')
        AND r."publicationStatus" = 'COMPLETE'
        AND r."publicationJobReconciledAt" IS NULL
      ORDER BY r."updatedAt" ASC, r."id" ASC
      LIMIT 8`;
    const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
    const payload = rows?.[0]?.["QUERY PLAN"] || rows || [];
    const root = Array.isArray(payload) ? payload[0] : payload;
    const executionMs = Number(root?.["Execution Time"] || 0);
    const blocks = Number(root?.Plan?.["Shared Hit Blocks"] || 0) + Number(root?.Plan?.["Shared Read Blocks"] || 0);
    assert.ok(executionMs <= 500, `Subscriber reconcile execution ${executionMs}ms exceeded 500ms`);
    assert.ok(blocks <= 30_000, `Subscriber reconcile blocks ${blocks} exceeded 30000`);
    const reconcileIndex = await db.$queryRawUnsafe(`
      SELECT i.indisvalid AS "valid", i.indisready AS "ready"
      FROM pg_class idx
      JOIN pg_index i ON i.indexrelid=idx.oid
      JOIN pg_class tbl ON tbl.oid=i.indrelid
      JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
      WHERE ns.nspname=current_schema()
        AND idx.relname='SubscriberScanRun_publication_job_reconcile_idx'
        AND tbl.relname='SubscriberScanRun'
    `);
    assert.equal(reconcileIndex.length, 1);
    assert.equal(reconcileIndex[0].valid, true);
    assert.equal(reconcileIndex[0].ready, true);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const eligibilityRows = await tx.$queryRawUnsafe(`EXPLAIN (COSTS OFF, FORMAT JSON) ${query}`);
      const text = JSON.stringify(eligibilityRows?.[0]?.["QUERY PLAN"] || eligibilityRows || []);
      assert.match(text, /Index (?:Only )?Scan|Bitmap Index Scan/, `reconcile query has no index path: ${text}`);
    });

    // COMPLETE but unreconciled is canonical publication debt: retention must not delete.
    const blocked = await cleanupSubscriberScanHistory({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, keep: 2, maxRuns: 50 });
    assert.equal(blocked.blockedByPublicationDebt, true);
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: scope.creatorId } }), 4000);

    await db.subscriberScanRun.updateMany({
      where: { creatorId: scope.creatorId, publicationStatus: "COMPLETE" },
      data: { publicationJobReconciledAt: now },
    });
    const retained = await cleanupSubscriberScanHistory({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, keep: 2, maxRuns: 50 });
    assert.equal(retained.blockedByPublicationDebt, false);
    assert.ok(retained.deletedRuns > 0 && retained.deletedRuns <= 50);
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: sibling.creatorId } }), 1, "retention crossed creator boundary");
    console.log(`FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF ${JSON.stringify({
      historyRows: 4000, debtRows: 200, executionMs, blocks, deletedRuns: retained.deletedRuns,
      generationRepairMs, generationRepairIndex: "SubscriberScanRun_creator_published_generation_idx",
    })}`);
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("A29 PostgreSQL: generation repair is monotonic and COMPLETE/unreconciled debt blocks scheduling and retention", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a29-generation-debt");
  const now = await databaseNow(db);
  try {
    await db.subscriberDirectoryState.create({
      data: {
        agencyId: scope.agencyId, creatorId: scope.creatorId, status: "READY",
        publicationGeneration: 10, publishedGeneration: 2, summary: {},
      },
    });
    await db.subscriberScanRun.create({
      data: {
        id: `${scope.creatorId}-published-8`, agencyId: scope.agencyId, creatorId: scope.creatorId,
        status: "PUBLISHED", publicationGeneration: 8, hasMore: false, fanProjectionStatus: "COMPLETE",
        publicationStatus: "COMPLETE", publicationJobReconciledAt: null, summary: {},
      },
    });
    const repaired = await repairSubscriberDirectoryStateGeneration({ db, agencyId: scope.agencyId, creatorId: scope.creatorId });
    assert.equal(repaired.repaired, true);
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.publicationGeneration, 10, "repair lowered publicationGeneration");
    assert.equal(state.publishedGeneration, 8, "repair did not advance publishedGeneration");

    const scheduled = await scheduleSubscriberScan({
      agencyId: scope.agencyId, creatorId: scope.creatorId, manual: true, force: true, reason: "A29_COMPLETE_UNRECONCILED_DEBT",
    });
    assert.equal(scheduled.created, false);
    assert.equal(scheduled.reason, "publication_recovery_in_progress");
    const cleanup = await cleanupSubscriberScanHistory({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, keep: 0, maxRuns: 50 });
    assert.equal(cleanup.blockedByPublicationDebt, true);
    assert.equal(await db.subscriberScanRun.count({ where: { creatorId: scope.creatorId } }), 1);
    console.log("# A29_GENERATION_DEBT_AUTHORITY_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("A31 PostgreSQL: maintenance lock order is deterministic and never signal-row -> creator", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const dbC = new PrismaClient();
  const scope = await createAgencyCreator(dbA, "a31-lock-order");
  const clock = await databaseNow(dbA);
  let releaseA;
  const holdA = new Promise((resolve) => { releaseA = resolve; });
  let enteredA;
  const aEntered = new Promise((resolve) => { enteredA = resolve; });
  let enteredB = false;
  try {
    const recoverySignalResult = await signalSubscriberDirectoryMaintenance({
      db: dbA, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: clock, reason: "A31_LOCK_ORDER_RECOVERY",
    });
    const retentionSignalResult = await signalSubscriberDirectoryMaintenance({
      db: dbA, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RETENTION, dueAt: clock, reason: "A31_LOCK_ORDER_RETENTION",
    });
    const claimUntil = new Date(clock.getTime() + 60_000);
    const recoverySignal = await dbA.subscriberDirectoryMaintenanceSignal.update({
      where: { id: recoverySignalResult.signal.id },
      data: { claimToken: `a31-a-${Date.now()}`, claimUntil },
    });
    const retentionSignal = await dbA.subscriberDirectoryMaintenanceSignal.update({
      where: { id: retentionSignalResult.signal.id },
      data: { claimToken: `a31-b-${Date.now()}`, claimUntil },
    });

    const txA = subscriberTest.publicationTransaction(dbA, scope.agencyId, scope.creatorId, async () => {
      enteredA();
      await holdA;
      return "a";
    }, { maintenanceSignal: recoverySignal, maxWaitMs: 5_000, timeoutMs: 20_000 });
    await aEntered;

    const txB = subscriberTest.publicationTransaction(dbB, scope.agencyId, scope.creatorId, async () => {
      enteredB = true;
      return "b";
    }, { maintenanceSignal: retentionSignal, maxWaitMs: 10_000, timeoutMs: 20_000 });

    // Give B time to reach the canonical agency/creator lock wait. It must NOT
    // own the retention signal row while blocked behind A.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(enteredB, false, "second transaction bypassed creator serialization");
    const rowLockProbe = await dbC.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`
        SELECT "id" FROM "SubscriberDirectoryMaintenanceSignal"
        WHERE "id"=$1 FOR UPDATE NOWAIT
      `, retentionSignal.id);
      return rows?.[0]?.id || null;
    }, { maxWait: 2_000, timeout: 5_000 });
    assert.equal(rowLockProbe, retentionSignal.id, "waiting maintenance transaction locked signal row before creator authority");

    releaseA();
    const [aResult, bResult] = await Promise.all([txA, txB]);
    assert.equal(aResult, "a");
    assert.equal(bResult, "b");
    assert.equal(enteredB, true);
    console.log("# A31_CANONICAL_LOCK_ORDER_PASS");
  } finally {
    releaseA?.();
    await cleanupAgency(dbA, scope.agencyId);
    await Promise.all([dbA.$disconnect(), dbB.$disconnect(), dbC.$disconnect()]);
  }
});

test("A31 PostgreSQL: expired real Subscriber recovery cannot mutate generation, run, projections, or jobs", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a31-real-stale-recovery");
  const clock = await databaseNow(db);
  try {
    await db.subscriberDirectoryState.create({
      data: {
        agencyId: scope.agencyId, creatorId: scope.creatorId, status: "READY",
        publicationGeneration: 1, publishedGeneration: 0, summary: {},
      },
    });
    const runId = `${scope.creatorId}-published-3`;
    await db.subscriberScanRun.create({
      data: {
        id: runId, agencyId: scope.agencyId, creatorId: scope.creatorId,
        status: "PUBLISHED", publicationGeneration: 3, hasMore: false, fanProjectionStatus: "COMPLETE",
        publicationStatus: "COMPLETE", publicationJobReconciledAt: null, summary: {},
      },
    });
    await signalSubscriberDirectoryMaintenance({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: clock, reason: "A31_REAL_STALE_RECOVERY",
    });
    const claim = await claimSubscriberDirectoryMaintenanceSignal({ db, now: clock });
    assert.ok(claim?.claimToken);
    await db.subscriberDirectoryMaintenanceSignal.update({
      where: { id: claim.id }, data: { claimUntil: new Date(clock.getTime() - 1_000) },
    });

    const before = {
      state: await db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } }),
      run: await db.subscriberScanRun.findUnique({ where: { id: runId } }),
      jobs: await db.jobInstance.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }),
      fanValues: await db.creatorFanValueCurrent.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }),
      fanRelationships: await db.creatorFanRelationshipCurrent.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }),
    };

    await assert.rejects(
      () => recoverSubscriberPublicationDebt({
        db, agencyId: scope.agencyId, creatorId: scope.creatorId, maintenanceSignal: claim, maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 2_000,
      }),
      (error) => error?.code === "SUBSCRIBER_MAINTENANCE_CLAIM_STALE",
    );

    const after = {
      state: await db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } }),
      run: await db.subscriberScanRun.findUnique({ where: { id: runId } }),
      jobs: await db.jobInstance.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }),
      fanValues: await db.creatorFanValueCurrent.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }),
      fanRelationships: await db.creatorFanRelationshipCurrent.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }),
    };
    assert.equal(after.state.publicationGeneration, before.state.publicationGeneration, "stale recovery repaired generation before lease fence");
    assert.equal(after.state.publishedGeneration, before.state.publishedGeneration, "stale recovery repaired published generation before lease fence");
    assert.equal(after.run.publicationJobReconciledAt?.getTime?.() || null, before.run.publicationJobReconciledAt?.getTime?.() || null);
    assert.equal(after.run.status, before.run.status);
    assert.equal(after.jobs, before.jobs, "stale recovery created a JobInstance");
    assert.equal(after.fanValues, before.fanValues, "stale recovery changed fan values");
    assert.equal(after.fanRelationships, before.fanRelationships, "stale recovery changed fan relationships");
    console.log("# A31_REAL_STALE_RECOVERY_FENCE_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("A29 PostgreSQL: expired Subscriber maintenance lease cannot commit fenced work and takeover/poison requeue are durable", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const dbA = new PrismaClient();
  const dbB = new PrismaClient();
  const scope = await createAgencyCreator(dbA, "a29-maintenance-lease");
  const clock = await databaseNow(dbA);
  try {
    await signalSubscriberDirectoryMaintenance({
      db: dbA, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: clock, reason: "A29_LEASE_PROOF",
    });
    const first = await claimSubscriberDirectoryMaintenanceSignal({ db: dbA, now: clock });
    assert.ok(first?.claimToken);
    await dbA.subscriberDirectoryMaintenanceSignal.update({
      where: { id: first.id },
      data: { claimUntil: new Date(clock.getTime() - 1_000) },
    });
    let staleWorkExecuted = false;
    const staleFence = await withSubscriberMaintenanceClaimFence({
      db: dbA, signal: first,
      work: async () => { staleWorkExecuted = true; return { impossible: true }; },
    });
    assert.equal(staleFence.current, false);
    assert.equal(staleWorkExecuted, false);
    assert.equal(await subscriberMaintenanceClaimCurrent({ db: dbA, signal: first }), false);

    const second = await claimSubscriberDirectoryMaintenanceSignal({ db: dbB, now: new Date(clock.getTime() + 1_000) });
    assert.ok(second?.claimToken && second.claimToken !== first.claimToken, "expired claim was not taken over");
    let takeoverWorked = false;
    const currentFence = await withSubscriberMaintenanceClaimFence({
      db: dbB, signal: second,
      work: async () => { takeoverWorked = true; return { ok: true }; },
    });
    assert.equal(currentFence.current, true);
    assert.equal(takeoverWorked, true);
    await ackSubscriberDirectoryMaintenanceSignal({ db: dbB, signal: second });

    const poisoned = await signalSubscriberDirectoryMaintenance({
      db: dbA, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RETENTION, dueAt: clock, reason: "A29_POISON_PROOF",
    });
    await dbA.subscriberDirectoryMaintenanceSignal.update({ where: { id: poisoned.signal.id }, data: { attempts: 100 } });
    const listed = await listPoisonedSubscriberMaintenanceSignals({ db: dbA, limit: 10 });
    assert.ok(listed.some((row) => row.id === poisoned.signal.id));
    const requeued = await requeuePoisonedSubscriberMaintenanceSignal({ db: dbA, signalId: poisoned.signal.id });
    assert.equal(requeued.requeued, true);
    const claimedAgain = await claimSubscriberDirectoryMaintenanceSignal({ db: dbB, now: new Date(clock.getTime() + 2_000) });
    assert.equal(claimedAgain?.id, poisoned.signal.id);
    await ackSubscriberDirectoryMaintenanceSignal({ db: dbB, signal: claimedAgain });
    console.log("# A29_MAINTENANCE_LEASE_POISON_PASS");
  } finally {
    await cleanupAgency(dbA, scope.agencyId);
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});


test("A32 PostgreSQL: fenced 500-fan refresh intent is transaction-atomic, bounded and retryable", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a32-fenced-refresh-intent");
  const fanIds = Array.from({ length: 500 }, (_, index) => `${scope.creatorId}-fan-${String(index).padStart(4, "0")}`);
  const now = await databaseNow(db);
  const common = {
    agencyId: scope.agencyId,
    creatorId: scope.creatorId,
    onlyFansUserIds: fanIds,
    reason: "subscriber_derived_a32_scale",
    priority: 95,
    now,
    params: {
      consumer: "subscriber_derived_a32",
      trigger: "physical_scale_retry",
      causalBarrierKey: `${scope.creatorId}:publication:77`,
    },
  };
  try {
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        const decision = await scheduleFanDataPointRefresh({ db: tx, ...common });
        assert.equal(decision.created, true);
        const inside = await tx.jobInstance.findUnique({ where: { id: decision.jobId } });
        assert.equal(inside?.status, "SCHEDULED");
        assert.equal(Array.isArray(inside?.params?.fanIds) ? inside.params.fanIds.length : 0, 500);
        throw Object.assign(new Error("A32 forced planning rollback"), { code: "A32_FORCED_ROLLBACK" });
      }, { maxWait: 10_000, timeout: 30_000 }),
      (error) => error?.code === "A32_FORCED_ROLLBACK",
    );
    assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } }), 0,
      "rolled-back fenced planning leaked a refresh JobInstance");

    const started = Date.now();
    const committed = await db.$transaction((tx) => scheduleFanDataPointRefresh({ db: tx, ...common }), { maxWait: 10_000, timeout: 30_000 });
    const commitMs = Date.now() - started;
    assert.equal(committed.created, true);
    assert.ok(commitMs <= 1_000, `500-fan fenced refresh scheduling ${commitMs}ms exceeded 1000ms`);
    const stored = await db.jobInstance.findUnique({ where: { id: committed.jobId } });
    assert.equal(stored?.status, "SCHEDULED");
    assert.equal(Array.isArray(stored?.params?.fanIds) ? stored.params.fanIds.length : 0, 500);

    const replay = await db.$transaction((tx) => scheduleFanDataPointRefresh({ db: tx, ...common }), { maxWait: 10_000, timeout: 30_000 });
    assert.equal(replay.created, false);
    assert.ok(["already_in_flight", "idempotency_race"].includes(String(replay.reason || "")), JSON.stringify(replay));
    assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } }), 1);
    console.log(`A32_DERIVED_PLANNING_SCALE_PROOF ${JSON.stringify({ fanIds: 500, commitMs, atomicRollback: true, replayReason: replay.reason })}`);
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("A32 PostgreSQL: full fenced derived planning lane converges 500 refresh candidates across Follow Back, Follow Automation and Bumps", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a32-full-derived-planning");
  try {
    const fixture = await seedA32DerivedPlanningDebt(db, scope, { fanCount: 500, generation: 88 });
    await signalSubscriberDirectoryMaintenance({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: new Date(0), reason: "A32_FULL_DERIVED_PLANNING_SCALE",
    });
    const claim = await claimSubscriberDirectoryMaintenanceSignal({ db, now: await databaseNow(db) });
    assert.ok(claim?.claimToken, "recovery signal must be claimed before fenced planning");

    const started = Date.now();
    const recovered = await recoverSubscriberPublicationDebt({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 15_000, maintenanceSignal: claim,
    });
    const elapsedMs = Date.now() - started;
    assert.equal(recovered.reconciledJobs, 1, JSON.stringify(recovered));
    assert.equal(recovered.planningRuns, 1, JSON.stringify(recovered));
    assert.ok(elapsedMs < 15_000, `full fenced derived planning held authority for ${elapsedMs}ms`);

    const run = await db.subscriberScanRun.findUnique({ where: { id: fixture.runId } });
    const subscriberJob = await db.jobInstance.findUnique({ where: { id: fixture.jobId } });
    assert.ok(run?.publicationJobReconciledAt instanceof Date);
    assert.equal(subscriberJob?.status, "DONE");
    assert.equal(subscriberJob?.result?.followBackPlanning?.ok, true, JSON.stringify(subscriberJob?.result?.followBackPlanning));
    assert.equal(subscriberJob?.result?.followAutomationPlanning?.ok, true, JSON.stringify(subscriberJob?.result?.followAutomationPlanning));
    assert.equal(subscriberJob?.result?.bumpPlanning?.ok, true, JSON.stringify(subscriberJob?.result?.bumpPlanning));

    const refreshJobs = await db.jobInstance.findMany({
      where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" },
      orderBy: { id: "asc" },
    });
    assert.equal(refreshJobs.length, 3, `expected one durable refresh intent per derived consumer: ${JSON.stringify(refreshJobs.map((row) => row.params))}`);
    assert.deepEqual(new Set(refreshJobs.map((row) => String(row?.params?.consumer || ""))), new Set(["follow_back", "follow_automation", "bumps"]));
    for (const job of refreshJobs) {
      assert.equal(job.status, "SCHEDULED");
      assert.equal(Array.isArray(job?.params?.fanIds) ? job.params.fanIds.length : 0, 500);
      assert.equal(job?.params?.subscriberRunId, fixture.runId);
      assert.equal(Number(job?.params?.subscriberPublicationGeneration || 0), fixture.generation);
    }
    assert.equal(await db.automationDelivery.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId } }), 0,
      "unknown canonical FanData must create refresh debt, not executable delivery writes");
    await ackSubscriberDirectoryMaintenanceSignal({ db, signal: claim });
    console.log(`A32_FULL_DERIVED_PLANNING_SCALE ${JSON.stringify({ fanCount: 500, consumers: 3, refreshJobs: refreshJobs.length, elapsedMs })}`);
  } finally {
    await db.automationTask.deleteMany({ where: { agencyId: scope.agencyId } }).catch(() => null);
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("A32 PostgreSQL: transient derived refresh scheduler failure preserves publication debt and retry converges without duplicate intents", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a32-derived-planning-retry");
  try {
    const fixture = await seedA32DerivedPlanningDebt(db, scope, { fanCount: 50, generation: 89 });
    await signalSubscriberDirectoryMaintenance({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: new Date(0), reason: "A32_TRANSIENT_PLANNING_FAILURE",
    });
    const firstClaim = await claimSubscriberDirectoryMaintenanceSignal({ db, now: await databaseNow(db) });
    assert.ok(firstClaim?.claimToken);
    let injectedCalls = 0;
    const first = await recoverSubscriberPublicationDebt({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 10_000, maintenanceSignal: firstClaim,
      scheduleFanRefresh: async () => {
        injectedCalls += 1;
        const error = new Error("A32 transient FanData scheduler failure");
        error.code = "A32_TRANSIENT_REFRESH_SCHEDULER";
        throw error;
      },
    });
    assert.ok(injectedCalls >= 3, `all derived consumers must encounter the transient scheduler failure: ${injectedCalls}`);
    assert.equal(first.reconciledJobs, 0, JSON.stringify(first));
    const failedRun = await db.subscriberScanRun.findUnique({ where: { id: fixture.runId } });
    const failedJob = await db.jobInstance.findUnique({ where: { id: fixture.jobId } });
    assert.equal(failedRun?.publicationJobReconciledAt, null);
    assert.equal(failedJob?.status, "FAILED");
    assert.equal(await db.jobInstance.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } }), 0);
    await releaseSubscriberDirectoryMaintenanceSignal({
      db, signal: firstClaim, now: await databaseNow(db), retryMs: 1_000,
      error: Object.assign(new Error("transient derived planning failure"), { code: "A32_TRANSIENT_REFRESH_SCHEDULER" }),
    });
    const released = await db.subscriberDirectoryMaintenanceSignal.findUnique({ where: { id: firstClaim.id } });
    assert.equal(released?.attempts, 1);
    assert.equal(released?.claimToken, null);

    await signalSubscriberDirectoryMaintenance({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: new Date(0), reason: "A32_TRANSIENT_RETRY_NOW",
    });
    const secondClaim = await claimSubscriberDirectoryMaintenanceSignal({ db, now: await databaseNow(db) });
    assert.ok(secondClaim?.claimToken);
    assert.ok(Number(secondClaim.revision) > Number(firstClaim.revision));
    const second = await recoverSubscriberPublicationDebt({
      db, agencyId: scope.agencyId, creatorId: scope.creatorId,
      maxRuns: 1, maxStepsPerRun: 1, maxRuntimeMs: 15_000, maintenanceSignal: secondClaim,
    });
    assert.equal(second.reconciledJobs, 1, JSON.stringify(second));
    const convergedRun = await db.subscriberScanRun.findUnique({ where: { id: fixture.runId } });
    const convergedJob = await db.jobInstance.findUnique({ where: { id: fixture.jobId } });
    assert.ok(convergedRun?.publicationJobReconciledAt instanceof Date);
    assert.equal(convergedJob?.status, "DONE");
    assert.equal(await db.jobInstance.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } }), 3);
    await ackSubscriberDirectoryMaintenanceSignal({ db, signal: secondClaim });
    console.log(`A32_DERIVED_PLANNING_RETRY_PROOF ${JSON.stringify({ firstReconciled: first.reconciledJobs, secondReconciled: second.reconciledJobs, injectedCalls })}`);
  } finally {
    await db.automationTask.deleteMany({ where: { agencyId: scope.agencyId } }).catch(() => null);
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});

test("A21 PostgreSQL: large cross-run Subscriber history uses the exact runId+id publication cursor index for CURRENT and PREVIOUS", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "a21-subscriber-cursor-plan");
  const prefix = `${scope.creatorId}-cursor-plan`;
  const runCount = 42;
  const rowsPerRun = 1000;
  try {
    await db.$executeRawUnsafe(`
      INSERT INTO "SubscriberScanRun" (
        "id", "agencyId", "creatorId", "status", "publicationGeneration", "summary", "createdAt", "updatedAt"
      )
      SELECT $1 || '-run-' || LPAD(r::text, 3, '0'), $2, $3, 'FAILED', r, '{}'::jsonb,
             clock_timestamp() - INTERVAL '2 days', clock_timestamp() - INTERVAL '1 day'
      FROM generate_series(1, $4::integer) AS r
    `, prefix, scope.agencyId, scope.creatorId, runCount);

    await db.$executeRawUnsafe(`
      INSERT INTO "SubscriberScanItem" (
        "id", "runId", "agencyId", "creatorId", "fanId", "contentHash", "metadata", "observedAt"
      )
      SELECT
        $1 || '-item-' || LPAD(g::text, 5, '0') || '-r-' || LPAD(r::text, 3, '0'),
        $1 || '-run-' || LPAD(r::text, 3, '0'),
        $2,
        $3,
        'fan-' || LPAD(g::text, 5, '0') || '-r-' || LPAD(r::text, 3, '0'),
        md5(g::text || ':' || r::text),
        '{}'::jsonb,
        clock_timestamp()
      FROM generate_series(1, $4::integer) AS r
      CROSS JOIN generate_series(1, $5::integer) AS g
    `, prefix, scope.agencyId, scope.creatorId, runCount, rowsPerRun);

    await db.$executeRawUnsafe('ANALYZE "SubscriberScanItem"');

    async function explain(runNumber) {
      const runId = `${prefix}-run-${String(runNumber).padStart(3, "0")}`;
      const cursorId = `${prefix}-item-00500-r-${String(runNumber).padStart(3, "0")}`;
      const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT i."id", i."fanId"
        FROM "SubscriberScanItem" i
        WHERE i."runId" = $1 AND i."id" > $2
        ORDER BY i."id" ASC
        LIMIT 500
      `, runId, cursorId);
      return JSON.stringify(rows?.[0]?.["QUERY PLAN"] || rows || []);
    }

    const currentPlan = await explain(1);
    const previousPlan = await explain(2);
    const indexName = "SubscriberScanItem_run_id_cursor_idx";
    assert.ok(currentPlan.includes(indexName), `${indexName} missing from CURRENT EXPLAIN ANALYZE plan: ${currentPlan}`);
    assert.ok(previousPlan.includes(indexName), `${indexName} missing from PREVIOUS EXPLAIN ANALYZE plan: ${previousPlan}`);
    console.log(`FINAL_SUBSCRIBER_CURSOR_PLAN_PROOF ${JSON.stringify({ historyRuns: runCount, rowsPerRun, totalRows: runCount * rowsPerRun, index: indexName, phases: ["CURRENT", "PREVIOUS"] })}`);
  } finally {
    await cleanupAgency(db, scope.agencyId);
    await db.$disconnect();
  }
});


test("A21 PostgreSQL: two Subscriber recovery replicas serialize one FAILED publication generation and converge monotonically", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const scope = await createAgencyCreator(db1, "a21-subscriber-recovery-replicas");
  const runId = `${scope.creatorId}-failed-publication`;
  try {
    await db1.subscriberDirectoryState.create({
      data: {
        agencyId: scope.agencyId,
        creatorId: scope.creatorId,
        status: "SCANNING",
        publicationGeneration: 1,
        publishedGeneration: 0,
      },
    });
    await db1.subscriberScanRun.create({
      data: {
        id: runId,
        agencyId: scope.agencyId,
        creatorId: scope.creatorId,
        status: "FAILED",
        hasMore: false,
        nextOffset: 0,
        scannedCount: 0,
        fanProjectionStatus: "COMPLETE",
        fanProjectionCursorOffset: 0,
        fanProjectionCount: 0,
        publicationStatus: "FINALIZE",
        publicationGeneration: 1,
        summary: {},
      },
    });

    await signalSubscriberDirectoryMaintenance({
      db: db1, agencyId: scope.agencyId, creatorId: scope.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RETENTION, dueAt: new Date(0), reason: "A26_RETENTION_DEBT_PROOF",
    });
    const retentionFirst = await runSubscriberDirectoryMaintenance({ db: db1, maxSignals: 1, concurrency: 1, maxRuntimeMs: 4_000 });
    assert.equal(await db1.subscriberScanRun.count({ where: { id: runId } }), 1, "retention must not delete unfinished publication debt");
    assert.ok(retentionFirst.processedSignals >= 1);
    assert.equal(await db1.subscriberDirectoryMaintenanceSignal.count({ where: { creatorId: scope.creatorId, kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY } }), 1);

    const [left, right] = await Promise.all([
      runSubscriberDirectoryMaintenance({ db: db1, maxSignals: 2, concurrency: 1, maxRuntimeMs: 15_000 }),
      runSubscriberDirectoryMaintenance({ db: db2, maxSignals: 2, concurrency: 1, maxRuntimeMs: 15_000 }),
    ]);

    const run = await db1.subscriberScanRun.findUnique({ where: { id: runId } });
    const state = await db1.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(run.status, "PUBLISHED");
    assert.equal(run.publicationStatus, "COMPLETE");
    assert.equal(run.publicationGeneration, 1);
    assert.equal(state.currentRunId, runId);
    assert.equal(state.publicationGeneration, 1);
    assert.equal(state.publishedGeneration, 1);
    assert.ok(Number(left.recoveredRuns || 0) + Number(right.recoveredRuns || 0) >= 1);
    assert.equal(Number(left.errors || 0) + Number(right.errors || 0), 0);
    assert.ok(Number(left.processedSignals || 0) + Number(right.processedSignals || 0) >= 1);

    const extraA = await createAgencyCreator(db1, "a26-fair-a", { agencyId: scope.agencyId });
    const extraB = await createAgencyCreator(db1, "a26-fair-b", { agencyId: scope.agencyId });
    const clock = await databaseNow(db1);
    await signalSubscriberDirectoryMaintenance({ db: db1, agencyId: scope.agencyId, creatorId: extraA.creatorId, kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: new Date(clock.getTime() - 20_000), reason: "A26_FAIR_OLDEST" });
    await signalSubscriberDirectoryMaintenance({ db: db1, agencyId: scope.agencyId, creatorId: extraB.creatorId, kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY, dueAt: new Date(clock.getTime() - 10_000), reason: "A26_FAIR_SECOND" });
    const firstClaim = await claimSubscriberDirectoryMaintenanceSignal({ db: db1, now: clock });
    const secondClaim = await claimSubscriberDirectoryMaintenanceSignal({ db: db2, now: clock });
    assert.equal(firstClaim.creatorId, extraA.creatorId, "global maintenance claim must be oldest-due first across creators");
    assert.equal(secondClaim.creatorId, extraB.creatorId, "second replica must claim a different creator without duplicate planning");
    assert.notEqual(firstClaim.id, secondClaim.id);
    await ackSubscriberDirectoryMaintenanceSignal({ db: db1, signal: firstClaim });
    await ackSubscriberDirectoryMaintenanceSignal({ db: db2, signal: secondClaim });
  } finally {
    await cleanupAgency(db1, scope.agencyId);
    await db1.$disconnect();
    await db2.$disconnect();
  }
});


test("A33 PostgreSQL: 500-candidate Likes/SFS refresh debt is durable, consumer-specific, race-safe and terminal-failure visible", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const scope = await createAgencyCreator(db1, "a33-derived-refresh");
  const now = await databaseNow(db1);
  const fanIds = Array.from({ length: 500 }, (_, index) => `${scope.creatorId}-a33-fan-${String(index).padStart(4, "0")}`);
  const scheduleWith = (db) => (input) => scheduleFanDataPointRefresh({ db, ...input, now });
  try {
    const [left, right] = await Promise.all([
      scheduleDurableFanDataRefreshDebt({
        agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "likes", reason: "likes_current_unknown",
        refreshFields: ["fanSubscriptionActive", "fanSubscriptionType"], scheduleFanRefresh: scheduleWith(db1),
      }),
      scheduleDurableFanDataRefreshDebt({
        agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "likes", reason: "likes_current_unknown",
        refreshFields: ["fanSubscriptionType", "fanSubscriptionActive"], scheduleFanRefresh: scheduleWith(db2),
      }),
    ]);
    assert.equal(left.durable, true);
    assert.equal(right.durable, true);
    assert.equal(left.requested, 500);
    assert.equal(right.requested, 500);

    const likesJobs = await db1.jobInstance.findMany({
      where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(likesJobs.length, 1, "replicas must converge on one exact Likes refresh intent");
    assert.equal(likesJobs[0].params?.consumer, "likes");
    assert.deepEqual(likesJobs[0].params?.refreshFields, ["fanSubscriptionActive", "fanSubscriptionType"]);

    const sfs = await scheduleDurableFanDataRefreshDebt({
      agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "sfs", reason: "sfs_planning_current_refresh_required",
      refreshFields: ["fanSubscriptionActive", "fanSubscriptionType"], scheduleFanRefresh: scheduleWith(db2),
    });
    assert.equal(sfs.durable, true);
    assert.equal(sfs.requested, 500);
    const allJobs = await db1.jobInstance.findMany({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } });
    assert.equal(allJobs.length, 2, "Likes and SFS must own distinct durable consumer identities");

    await db1.jobInstance.update({ where: { id: likesJobs[0].id }, data: { status: "FAILED", lastError: "A33 terminal same-bucket proof" } });
    const failedReplay = await scheduleDurableFanDataRefreshDebt({
      agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "likes", reason: "likes_current_unknown",
      refreshFields: ["fanSubscriptionActive", "fanSubscriptionType"], scheduleFanRefresh: scheduleWith(db2),
    });
    assert.equal(failedReplay.requested, 500);
    assert.equal(failedReplay.durable, false);
    assert.match(String(failedReplay.error || ""), /same_bucket_failed/);
    assert.equal(await db1.jobInstance.count({ where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" } }), 2);
  } finally {
    await cleanupAgency(db1, scope.agencyId);
    await db1.$disconnect();
    await db2.$disconnect();
  }
});

test("A33 PostgreSQL: terminal refresh debt retries after restart in the next bucket and converges without duplicates", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  let dbRestarted = null;
  const scope = await createAgencyCreator(db1, "a33-derived-refresh-restart");
  const firstNow = await databaseNow(db1);
  const retryNow = new Date(firstNow.getTime() + (2 * 60 * 1000) + 1_000);
  const fanIds = Array.from({ length: 500 }, (_, index) => `${scope.creatorId}-a33-retry-fan-${String(index).padStart(4, "0")}`);
  try {
    const first = await scheduleDurableFanDataRefreshDebt({
      agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "likes", reason: "likes_current_unknown",
      refreshFields: ["fanSubscriptionActive", "fanSubscriptionType"],
      scheduleFanRefresh: (input) => scheduleFanDataPointRefresh({ db: db1, ...input, now: firstNow }),
    });
    assert.equal(first.durable, true);
    assert.equal(first.requested, 500);
    const firstJobId = first.decision?.jobId;
    assert.ok(firstJobId);

    await db1.jobInstance.update({
      where: { id: firstJobId },
      data: { status: "FAILED", lastError: "A33 transient scheduler/worker failure before restart" },
    });

    const sameBucket = await scheduleDurableFanDataRefreshDebt({
      agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "likes", reason: "likes_current_unknown",
      refreshFields: ["fanSubscriptionType", "fanSubscriptionActive"],
      scheduleFanRefresh: (input) => scheduleFanDataPointRefresh({ db: db1, ...input, now: firstNow }),
    });
    assert.equal(sameBucket.requested, 500);
    assert.equal(sameBucket.durable, false);
    assert.match(String(sameBucket.error || ""), /same_bucket_failed/);

    // Simulate a Backend process restart by dropping the original Prisma client
    // and retrying from a fresh client after the scheduler's two-minute bucket.
    await db1.$disconnect();
    dbRestarted = new PrismaClient();

    const afterRestart = await scheduleDurableFanDataRefreshDebt({
      agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds: [...fanIds].reverse(), consumer: "likes", reason: "likes_current_unknown",
      refreshFields: ["fanSubscriptionActive", "fanSubscriptionType"],
      scheduleFanRefresh: (input) => scheduleFanDataPointRefresh({ db: dbRestarted, ...input, now: retryNow }),
    });
    assert.equal(afterRestart.durable, true);
    assert.equal(afterRestart.requested, 500);
    assert.ok(afterRestart.decision?.jobId);
    assert.notEqual(afterRestart.decision.jobId, firstJobId, "next bucket retry must own a new durable job after terminal failure");

    const replay = await scheduleDurableFanDataRefreshDebt({
      agencyId: scope.agencyId, creatorId: scope.creatorId, fanIds, consumer: "likes", reason: "likes_current_unknown",
      refreshFields: ["fanSubscriptionType", "fanSubscriptionActive"],
      scheduleFanRefresh: (input) => scheduleFanDataPointRefresh({ db: dbRestarted, ...input, now: retryNow }),
    });
    assert.equal(replay.durable, true);
    assert.equal(replay.decision?.jobId, afterRestart.decision.jobId);
    assert.equal(replay.decision?.reason, "already_in_flight");

    const jobs = await dbRestarted.jobInstance.findMany({
      where: { agencyId: scope.agencyId, creatorId: scope.creatorId, jobKey: "fan_data_point_refresh" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(jobs.length, 2, "terminal old bucket plus one retry bucket is the complete durable history");
    assert.equal(jobs.filter((job) => ["SCHEDULED", "CLAIMED"].includes(job.status)).length, 1, "restart/replay must converge on exactly one claimable retry intent");
    assert.equal(jobs.filter((job) => job.status === "FAILED").length, 1);
  } finally {
    const cleanupDb = dbRestarted || db1;
    await cleanupAgency(cleanupDb, scope.agencyId);
    if (dbRestarted) await dbRestarted.$disconnect();
    else await db1.$disconnect();
  }
});

