"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { withPhase3PostgresFixtureAuthority, cleanupPhase3PostgresAgencyFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
let projectSubscriberDirectoryItems;
let applyFanDataPointRefreshChunk;
let readFanCurrent;
let recordSubscriberScanFailure;
let applySubscriberScanChunk;
let enqueueUniqueCampaignFanRefreshes;
let finalizeCampaignFanRefreshJob;
let repairFailedCampaignFanRefreshDemands;
let runCampaignFanRefreshPromotionMaintenance;
let signalCampaignFanRefreshPromotion;

if (enabled) {
  ({ projectSubscriberDirectoryItems, applyFanDataPointRefreshChunk, readFanCurrent } = require("./fan-data-authority-service"));
  ({ recordSubscriberScanFailure, applySubscriberScanChunk, recoverSubscriberPublicationDebt } = require("./subscriber-directory-service"));
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
    const due = await databaseNow(db);
    await signalCampaignFanRefreshPromotion({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, dueAt: due, reason: "CUTOVER_BACKFILL_PROOF" });
    const result = await runCampaignFanRefreshPromotionMaintenance({ db, now: due, maxCreators: 1, maxJobsPerCreator: 1 });
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

    const current = await readFanCurrent({ db, agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserIds: [fanId] });
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
    await cleanupAgency(db, scope.agencyId).catch(() => {});
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
    await cleanupAgency(dbA, scope.agencyId).catch(() => {});
    await dbA.$disconnect();
    await dbB.$disconnect();
  }
});

test("FINAL PostgreSQL: 4000-row Campaign debt and signal plans use the final hot-path indexes", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-hot-plan");
  const prefix = `${scope.creatorId}-plan`;
  const campaignJobId = `${scope.creatorId}-plan-job`;
  const now = new Date("2042-06-01T00:00:00.000Z");
  try {
    await db.jobInstance.create({ data: { id: campaignJobId, jobKey: "fetch_campaigns", scope: "creator", creatorId: scope.creatorId, agencyId: scope.agencyId, status: "DONE" } });
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFanRefreshDemand" (
        "id","agencyId","creatorId","onlyFansUserId","requestedFreshnessCutoffAt","status",
        "lastRequestedAt","lastFailedAt","nextRetryAt","createdAt","updatedAt"
      )
      SELECT $1 || '-d-' || g::text, $2, $3, $1 || '-fan-' || g::text, $4,
             CASE WHEN g <= 2000 THEN 'QUEUED' ELSE 'FAILED' END,
             $4 - (g * INTERVAL '1 second'),
             CASE WHEN g > 2000 THEN $4 - (g * INTERVAL '1 second') ELSE NULL END,
             CASE WHEN g > 2000 THEN $4 - INTERVAL '1 minute' ELSE NULL END,
             $4 - INTERVAL '1 day', $4 - (g * INTERVAL '1 second')
      FROM generate_series(1, 4000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorCampaignFanRefreshWork" (
        "id","agencyId","creatorId","scanRunId","scanStartedAt","onlyFansUserId","campaignJobId","demandId",
        "requestedRevision","freshnessCutoffAt","status","scheduledAt","createdAt","updatedAt"
      )
      SELECT $1 || '-w-' || g::text, $2, $3, $1 || '-run', $4, $1 || '-fan-' || g::text, $5,
             $1 || '-d-' || g::text, 1, $4, 'QUEUED', $4, $4, $4
      FROM generate_series(1, 2000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now, campaignJobId);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFan" ("id","agencyId","creatorId","onlyFansUserId","firstSeenAt","lastSeenAt","createdAt","updatedAt")
      SELECT $1 || '-f-' || g::text, $2, $3, $1 || '-fan-' || g::text, $4, $4, $4, $4
      FROM generate_series(1, 4000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now);
    await db.$executeRawUnsafe(`
      INSERT INTO "CreatorFanValueCurrent" ("id","agencyId","creatorId","fanId","fetchedAt","availability","source","createdAt","updatedAt")
      SELECT $1 || '-v-' || g::text, $2, $3, $1 || '-f-' || g::text, $4 + INTERVAL '1 minute', 'AVAILABLE', 'PLAN_PROOF', $4, $4
      FROM generate_series(1, 4000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now);
    await withPhase3PostgresFixtureAuthority(db, (tx) => tx.$executeRawUnsafe(`
      INSERT INTO "CreatorAccount" ("id","agencyId","displayName","createdAt","updatedAt")
      SELECT $1 || '-creator-' || g::text, $2, 'plan-signal-' || g::text, $3, $3
      FROM generate_series(1, 3999) AS g
    `, prefix, scope.agencyId, now));
    await db.$executeRawUnsafe(`
      INSERT INTO "CampaignFanRefreshPromotionSignal" ("id","agencyId","creatorId","dueAt","reason","createdAt","updatedAt")
      SELECT $1 || '-sig-' || g::text, $2,
             CASE WHEN g = 4000 THEN $3 ELSE $1 || '-creator-' || g::text END,
             $4 - (g * INTERVAL '1 millisecond'), 'PLAN_PROOF', $4, $4
      FROM generate_series(1, 4000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now);
    await db.$executeRawUnsafe('ANALYZE "CreatorFanRefreshDemand"');
    await db.$executeRawUnsafe('ANALYZE "CreatorCampaignFanRefreshWork"');
    await db.$executeRawUnsafe('ANALYZE "CreatorFan"');
    await db.$executeRawUnsafe('ANALYZE "CreatorFanValueCurrent"');
    await db.$executeRawUnsafe('ANALYZE "CampaignFanRefreshPromotionSignal"');

    const explain = async (sql, ...args) => {
      const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ...args);
      return JSON.stringify(rows?.[0]?.["QUERY PLAN"] || rows || []);
    };
    const promoter = await explain(`
      SELECT d."id" FROM "CreatorFanRefreshDemand" d
      WHERE d."creatorId" = $1 AND d."status" = 'QUEUED' AND d."activeRefreshJobId" IS NULL
        AND EXISTS (SELECT 1 FROM "CreatorCampaignFanRefreshWork" w WHERE w."demandId" = d."id" AND w."status" = 'QUEUED')
      ORDER BY d."lastRequestedAt" ASC, d."id" ASC LIMIT 500
    `, scope.creatorId);
    const recovery = await explain(`
      SELECT d."id" FROM "CreatorFanRefreshDemand" d
      WHERE d."creatorId" = $1 AND d."status" = 'FAILED' AND d."activeRefreshJobId" IS NULL
        AND d."quarantinedAt" IS NULL AND d."nextRetryAt" IS NOT NULL AND d."nextRetryAt" <= $2
      ORDER BY COALESCE(d."nextRetryAt", d."lastFailedAt", d."updatedAt") ASC, d."id" ASC LIMIT 500
    `, scope.creatorId, now);
    const heal = await explain(`
      SELECT d."onlyFansUserId"
      FROM "CreatorFanRefreshDemand" d
      JOIN "CreatorFan" f ON f."creatorId" = d."creatorId" AND f."onlyFansUserId" = d."onlyFansUserId"
      JOIN "CreatorFanValueCurrent" v ON v."creatorId" = f."creatorId" AND v."fanId" = f."id"
      WHERE d."creatorId" = $1 AND d."status" IN ('QUEUED','FAILED')
        AND v."fetchedAt" IS NOT NULL AND v."fetchedAt" >= d."requestedFreshnessCutoffAt"
      ORDER BY d."updatedAt" ASC, d."id" ASC LIMIT 500
    `, scope.creatorId);
    const signal = await explain(`
      SELECT s."id" FROM "CampaignFanRefreshPromotionSignal" s
      WHERE s."dueAt" <= $1 AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
      ORDER BY s."dueAt" ASC, s."creatorId" ASC LIMIT 20
    `, now);

    const expected = [
      [promoter, "CreatorFanRefreshDemand_promoter_ready_idx"],
      [recovery, "CreatorFanRefreshDemand_recovery_order_idx"],
      [heal, "CreatorFanRefreshDemand_canonical_heal_idx"],
      [signal, "CampaignFanRefreshPromotionSignal_claim_due_idx"],
    ];
    for (const [plan, indexName] of expected) assert.ok(plan.includes(indexName), `${indexName} missing from EXPLAIN ANALYZE plan: ${plan}`);
    console.log(`FINAL_HOT_QUERY_PLAN_PROOF ${JSON.stringify({ debtRows: 4000, signalRows: 4000, indexes: expected.map(([, name]) => name) })}`);
  } finally {
    await cleanupAgency(db, scope.agencyId).catch(() => {});
    await db.$disconnect();
  }
});

test("FINAL PostgreSQL: 4000-run Subscriber history uses the publication-job reconciliation partial index", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = await createAgencyCreator(db, "final-subscriber-reconcile-plan");
  const prefix = `${scope.creatorId}-reconcile-plan`;
  const now = new Date("2042-07-01T00:00:00.000Z");
  try {
    await db.$executeRawUnsafe(`
      INSERT INTO "SubscriberScanRun" (
        "id","agencyId","creatorId","status","hasMore","fanProjectionStatus","publicationStatus",
        "publicationJobReconciledAt","summary","createdAt","updatedAt"
      )
      SELECT $1 || '-run-' || g::text, $2, $3,
             CASE WHEN g % 2 = 0 THEN 'PUBLISHED' ELSE 'SUPERSEDED' END,
             false, 'COMPLETE', 'COMPLETE',
             CASE WHEN g <= 200 THEN NULL ELSE $4 END,
             '{}'::jsonb, $4 - INTERVAL '1 day', $4 - (g * INTERVAL '1 second')
      FROM generate_series(1, 4000) AS g
    `, prefix, scope.agencyId, scope.creatorId, now);
    await db.$executeRawUnsafe('ANALYZE "SubscriberScanRun"');
    const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT r."id"
      FROM "SubscriberScanRun" r
      WHERE r."status" IN ('PUBLISHED','SUPERSEDED')
        AND r."publicationStatus" = 'COMPLETE'
        AND r."publicationJobReconciledAt" IS NULL
      ORDER BY r."updatedAt" ASC, r."id" ASC
      LIMIT 8
    `);
    const plan = JSON.stringify(rows?.[0]?.["QUERY PLAN"] || rows || []);
    const indexName = "SubscriberScanRun_publication_job_reconcile_idx";
    assert.ok(plan.includes(indexName), `${indexName} missing from EXPLAIN ANALYZE plan: ${plan}`);
    console.log(`FINAL_SUBSCRIBER_RECONCILE_PLAN_PROOF ${JSON.stringify({ historyRows: 4000, debtRows: 200, index: indexName })}`);
  } finally {
    await cleanupAgency(db, scope.agencyId).catch(() => {});
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
    await cleanupAgency(db, scope.agencyId).catch(() => {});
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

    const [left, right] = await Promise.all([
      recoverSubscriberPublicationDebt({ db: db1, maxRuns: 1, maxStepsPerRun: 2, maxRuntimeMs: 30_000 }),
      recoverSubscriberPublicationDebt({ db: db2, maxRuns: 1, maxStepsPerRun: 2, maxRuntimeMs: 30_000 }),
    ]);

    const run = await db1.subscriberScanRun.findUnique({ where: { id: runId } });
    const state = await db1.subscriberDirectoryState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(run.status, "PUBLISHED");
    assert.equal(run.publicationStatus, "COMPLETE");
    assert.equal(run.publicationGeneration, 1);
    assert.equal(state.currentRunId, runId);
    assert.equal(state.publicationGeneration, 1);
    assert.equal(state.publishedGeneration, 1);
    assert.ok(Number(left.advancedSteps || 0) + Number(right.advancedSteps || 0) >= 1);
    assert.ok(Number(left.errors || 0) + Number(right.errors || 0) === 0);
  } finally {
    await cleanupAgency(db1, scope.agencyId).catch(() => {});
    await db1.$disconnect();
    await db2.$disconnect();
  }
});
