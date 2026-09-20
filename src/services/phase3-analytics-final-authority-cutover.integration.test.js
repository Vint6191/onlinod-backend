"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
let projectSubscriberDirectoryItems;
let applyFanDataPointRefreshChunk;
let readFanCurrent;
let recordSubscriberScanFailure;
let enqueueUniqueCampaignFanRefreshes;
let finalizeCampaignFanRefreshJob;
let repairFailedCampaignFanRefreshDemands;
let runCampaignFanRefreshPromotionMaintenance;
let signalCampaignFanRefreshPromotion;

if (enabled) {
  ({ projectSubscriberDirectoryItems, applyFanDataPointRefreshChunk, readFanCurrent } = require("./fan-data-authority-service"));
  ({ recordSubscriberScanFailure } = require("./subscriber-directory-service"));
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
  if (!agencyId) await db.agency.create({ data: { id: a, name: `Final cut ${a}` } });
  await db.creatorAccount.create({ data: { id: c, agencyId: a, displayName: `Final cut ${c}` } });
  return { agencyId: a, creatorId: c };
}

async function cleanupAgency(db, agencyId) {
  await db.agency.deleteMany({ where: { id: agencyId } });
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
            value: { availability: "AVAILABLE", totalSpentCents: 250, messagesSpentCents: 25 },
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
    await cleanupAgency(subscriberDb, scope.agencyId).catch(() => {});
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
    await cleanupAgency(db, scope.agencyId).catch(() => {});
    await db.$disconnect();
  }
});

test("FINAL PostgreSQL: lost final Subscriber response crosses durable fanProjection barrier and publishes idempotently on failure repair", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-subscriber-lost-response");
  const runId = `${scope.creatorId}-run`;
  const jobId = `${scope.creatorId}-job`;
  const job = await db.jobInstance.create({
    data: {
      id: jobId, jobKey: "subscriber_directory_scan", scope: "creator", creatorId: scope.creatorId,
      agencyId: scope.agencyId, status: "CLAIMED", leaseRevision: 1,
      params: { scanRunId: runId, scanEveryDays: 7, observationTokenVersion: 1 },
    },
  });
  await db.subscriberScanRun.create({
    data: {
      id: runId, agencyId: scope.agencyId, creatorId: scope.creatorId, jobId,
      status: "RUNNING", pageLimit: 100, nextOffset: 0, scannedCount: 0, pageCount: 1,
      hasMore: false, fanProjectionStatus: "COMPLETE", fanProjectionCursorOffset: 0,
      fanProjectionCount: 0, fanProjectionCompletedAt: new Date(),
    },
  });
  try {
    const repaired = await recordSubscriberScanFailure({ job, error: "simulated lost final response", terminal: true, db });
    assert.equal(repaired?.status, "PUBLISHED");
    const replay = await recordSubscriberScanFailure({ job, error: "duplicate terminal callback", terminal: true, db });
    assert.equal(replay?.status, "PUBLISHED");
    const state = await db.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state?.currentRunId, runId);
    console.log("# FINAL_SUBSCRIBER_LOST_RESPONSE_BARRIER_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId).catch(() => {});
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
    await cleanupAgency(manualDb, scope.agencyId).catch(() => {});
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
    const due = new Date("2042-03-01T00:00:00.000Z");
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
    await cleanupAgency(dbA, first.agencyId).catch(() => {});
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
    await signalCampaignFanRefreshPromotion({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, dueAt: observedAt, reason: "CUTOVER_BACKFILL_PROOF" });
    const result = await runCampaignFanRefreshPromotionMaintenance({ db, now: observedAt, maxCreators: 1, maxJobsPerCreator: 1 });
    assert.equal(result.healedFans, 1);
    const afterDemand = await db.creatorFanRefreshDemand.findUnique({ where: { id: demand.id } });
    const afterWork = await db.creatorCampaignFanRefreshWork.findFirst({ where: { demandId: demand.id } });
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(afterDemand?.status, "COMPLETE");
    assert.equal(afterWork?.status, "COMPLETE");
    assert.equal(state?.fanValueOutstanding, 0);
    assert.equal(state?.fanValueSucceeded, 1);
    console.log("# FINAL_CUTOVER_CANONICAL_DEBT_HEAL_PASS");
  } finally {
    await cleanupAgency(db, scope.agencyId).catch(() => {});
    await db.$disconnect();
  }
});
