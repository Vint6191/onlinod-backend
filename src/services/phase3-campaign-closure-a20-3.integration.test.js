"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { withPhase3PostgresFixtureAuthority } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
const {
  enqueueUniqueCampaignFanRefreshes,
  recoverFailedCampaignFanRefreshDemands,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
} = require("./campaign-fan-refresh-queue-service");

function ids(prefix) {
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    agencyId: `${prefix}-agency-${nonce}`,
    creatorId: `${prefix}-creator-${nonce}`,
    campaignJobA: `${prefix}-campaign-a-${nonce}`,
    campaignJobB: `${prefix}-campaign-b-${nonce}`,
  };
}

async function createScope(db, scope, { secondCampaignJob = false } = {}) {
  await withPhase3PostgresFixtureAuthority(db, async (tx) => {
    await tx.agency.create({ data: { id: scope.agencyId, name: `A20.3 ${scope.agencyId}` } });
    await tx.creatorAccount.create({ data: { id: scope.creatorId, agencyId: scope.agencyId, displayName: "A20.3 Creator" } });
  });
  await db.creatorCampaignCollectionState.create({
    data: {
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      status: "PARTIAL",
      mode: "catchup",
      membershipCoverageStatus: "COMPLETE",
      campaignFrontierFreshnessStatus: "COMPLETE",
    },
  });
  await db.jobInstance.create({
    data: {
      id: scope.campaignJobA,
      jobKey: "fetch_campaigns",
      scope: "creator",
      creatorId: scope.creatorId,
      agencyId: scope.agencyId,
      status: "CLAIMED",
      params: { campaignFreshnessCoverageVersion: 1 },
    },
  });
  if (secondCampaignJob) {
    await db.jobInstance.create({
      data: {
        id: scope.campaignJobB,
        jobKey: "fetch_campaigns",
        scope: "creator",
        creatorId: scope.creatorId,
        agencyId: scope.agencyId,
        status: "CLAIMED",
        params: { campaignFreshnessCoverageVersion: 1 },
      },
    });
  }
}

async function cleanupScope(db, scope) {
  await withPhase3PostgresFixtureAuthority(db, (tx) => tx.agency.deleteMany({ where: { id: scope.agencyId } }));
}

async function prismaPlanner(input) {
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

function staleCandidates(count) {
  return Array.from({ length: count }, (_, index) => ({ onlyFansUserId: `fan-${String(index + 1).padStart(3, "0")}` }));
}

async function markCampaignRefreshFailed(db, creatorId, { now, expectedCurrentRunFailed }) {
  await db.creatorCampaignFanRefreshWork.updateMany({
    where: { creatorId, status: "QUEUED" },
    data: { status: "FAILED", outcome: "FAILED", completedAt: now, refreshJobId: null, lastError: "integration-failure" },
  });
  await db.creatorFanRefreshDemand.updateMany({
    where: { creatorId },
    data: {
      status: "FAILED",
      activeRefreshJobId: null,
      activeRefreshRevision: null,
      lastFailedAt: now,
      retryAttempts: 1,
      nextRetryAt: new Date(now.getTime() - 1000),
      quarantinedAt: null,
      lastOutcome: "RETRY_BACKOFF",
      lastError: "integration-failure",
    },
  });
  await db.creatorCampaignCollectionState.update({
    where: { creatorId },
    data: {
      fanValueFailed: expectedCurrentRunFailed,
      fanValueOutstanding: 0,
      fanValueFreshnessStatus: "PARTIAL",
      status: "PARTIAL",
    },
  });
}

test("A20.3 PostgreSQL: real set-based queue and failed recovery execute with bounded semantics", { skip: !enabled, timeout: 90_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a203-seq");
  try {
    await createScope(db, scope);
    const now = new Date("2040-01-03T00:00:00.000Z");
    const queue = await db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
      db: tx,
      job: { id: scope.campaignJobA, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
      scanRunId: "run-seq",
      scanStartedAt: now,
      candidates: staleCandidates(20),
      now: new Date(now.getTime() + 1000),
      planner: prismaPlanner,
      collectorVersion: "campaigns-v13",
    }));
    assert.equal(queue.queued, 20);
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId } }), 20);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, scanRunId: "run-seq", status: "QUEUED" } }), 20);
    assert.equal(await db.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh", status: "SCHEDULED" } }), 1);

    const failedAt = new Date(now.getTime() + 5000);
    await markCampaignRefreshFailed(db, scope.creatorId, { now: failedAt, expectedCurrentRunFailed: 20 });
    const recovered = await db.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({
      db: tx,
      now: new Date(failedAt.getTime() + 2000),
      maxDemands: 200,
    }));
    assert.equal(recovered.recovered, 20);
    assert.equal(recovered.requeuedWork, 20);
    assert.equal(recovered.topology, "set_based_v1");
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "QUEUED" } }), 20);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "QUEUED" } }), 20);
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.fanValueFailed, 0);
    assert.equal(state.fanValueOutstanding, 20);

    const quarantineAt = new Date(failedAt.getTime() + 3000);
    const one = await db.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId }, orderBy: { id: "asc" } });
    await db.creatorCampaignFanRefreshWork.updateMany({
      where: { demandId: one.id, status: "QUEUED" },
      data: { status: "FAILED", outcome: "FAILED", completedAt: quarantineAt, lastError: "quarantined" },
    });
    await db.creatorFanRefreshDemand.update({
      where: { id: one.id },
      data: { status: "FAILED", retryAttempts: 5, nextRetryAt: null, quarantinedAt: quarantineAt, lastError: "quarantined" },
    });
    await db.creatorCampaignCollectionState.update({
      where: { creatorId: scope.creatorId },
      data: { fanValueFailed: 1, fanValueOutstanding: 19, fanValueFreshnessStatus: "PARTIAL" },
    });
    const repaired = await db.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({
      db: tx,
      creatorId: scope.creatorId,
      force: true,
      now: new Date(quarantineAt.getTime() + 1000),
      maxDemands: 1,
    }));
    assert.equal(repaired.recovered, 1);
    const repairedDemand = await db.creatorFanRefreshDemand.findUnique({ where: { id: one.id } });
    assert.equal(repairedDemand.status, "QUEUED");
    assert.equal(repairedDemand.retryAttempts, 0);
    assert.equal(repairedDemand.quarantinedAt, null);
    assert.equal(repairedDemand.lastOutcome, "MANUAL_REPAIR_QUEUED");
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.3 PostgreSQL: two clients coalesce overlapping queue work and recovery cannot double-transition", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const scope = ids("a203-concurrent");
  try {
    await createScope(db1, scope, { secondCampaignJob: true });
    const candidates = staleCandidates(20);
    const base = new Date("2040-01-04T00:00:00.000Z");
    await Promise.all([
      db1.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
        db: tx,
        job: { id: scope.campaignJobA, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
        scanRunId: "run-a",
        scanStartedAt: base,
        candidates,
        now: new Date(base.getTime() + 1000),
        planner: prismaPlanner,
        collectorVersion: "campaigns-v13",
      })),
      db2.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
        db: tx,
        job: { id: scope.campaignJobB, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
        scanRunId: "run-b",
        scanStartedAt: new Date(base.getTime() + 60_000),
        candidates,
        now: new Date(base.getTime() + 61_000),
        planner: prismaPlanner,
        collectorVersion: "campaigns-v13",
      })),
    ]);
    assert.equal(await db1.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId } }), 20);
    assert.equal(await db1.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId } }), 40);
    assert.equal(await db1.jobInstance.count({ where: { creatorId: scope.creatorId, jobKey: "fan_data_point_refresh", status: "SCHEDULED" } }), 1);

    const stateBeforeFail = await db1.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    const currentRun = stateBeforeFail.fanValueCoverageScanRunId;
    assert.ok(["run-a", "run-b"].includes(currentRun));
    const currentRunWork = await db1.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, scanRunId: currentRun } });
    assert.equal(currentRunWork, 20);
    const failedAt = new Date(base.getTime() + 120_000);
    await markCampaignRefreshFailed(db1, scope.creatorId, { now: failedAt, expectedCurrentRunFailed: currentRunWork });

    const [left, right] = await Promise.all([
      db1.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({ db: tx, now: new Date(failedAt.getTime() + 2000), maxDemands: 20 })),
      db2.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({ db: tx, now: new Date(failedAt.getTime() + 2000), maxDemands: 20 })),
    ]);
    assert.equal(left.recovered + right.recovered, 20);
    assert.equal(left.requeuedWork + right.requeuedWork, 40);
    assert.equal(await db1.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "QUEUED" } }), 20);
    assert.equal(await db1.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "QUEUED" } }), 40);
    const state = await db1.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.fanValueFailed, 0);
    assert.equal(state.fanValueOutstanding, 20);
  } finally {
    await cleanupScope(db1, scope).catch(() => {});
    await Promise.all([db1.$disconnect(), db2.$disconnect()]);
  }
});

test("A20.3 PostgreSQL: canonical observation racing failed recovery converges without double decrement", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const scope = ids("a203-race");
  try {
    await createScope(db1, scope);
    const candidates = staleCandidates(20);
    const base = new Date("2040-01-05T00:00:00.000Z");
    await db1.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
      db: tx,
      job: { id: scope.campaignJobA, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
      scanRunId: "run-race",
      scanStartedAt: base,
      candidates,
      now: new Date(base.getTime() + 1000),
      planner: prismaPlanner,
      collectorVersion: "campaigns-v13",
    }));
    const failedAt = new Date(base.getTime() + 10_000);
    await markCampaignRefreshFailed(db1, scope.creatorId, { now: failedAt, expectedCurrentRunFailed: 20 });

    await db1.creatorFan.createMany({
      data: candidates.map((row) => ({ agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserId: row.onlyFansUserId })),
      skipDuplicates: true,
    });
    const fanRows = await db1.creatorFan.findMany({ where: { creatorId: scope.creatorId }, select: { id: true, onlyFansUserId: true } });
    const observedAt = new Date(base.getTime() + 20_000);
    await db1.creatorFanValueCurrent.createMany({
      data: fanRows.map((fan) => ({
        agencyId: scope.agencyId,
        creatorId: scope.creatorId,
        fanRecordId: fan.id,
        valueObservedAt: observedAt,
        availability: "AVAILABLE",
        source: "A20_3_POSTGRES_PROOF",
      })),
      skipDuplicates: true,
    });
    const fanIds = candidates.map((row) => row.onlyFansUserId);
    await Promise.all([
      db1.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({ db: tx, now: new Date(observedAt.getTime() + 1000), maxDemands: 20 })),
      db2.$transaction((tx) => reconcileCampaignFanRefreshDemandsFromCanonicalObservations({ db: tx, creatorId: scope.creatorId, fanIds, now: new Date(observedAt.getTime() + 1000) })),
    ]);

    assert.equal(await db1.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "COMPLETE" } }), 20);
    assert.equal(await db1.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "SUCCEEDED" } }), 20);
    const state = await db1.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.fanValueFailed, 0);
    assert.equal(state.fanValueOutstanding, 0);
    assert.equal(state.fanValueSucceeded, 20);
  } finally {
    await cleanupScope(db1, scope).catch(() => {});
    await Promise.all([db1.$disconnect(), db2.$disconnect()]);
  }
});
