"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { withPhase3PostgresFixtureAuthority, cleanupPhase3PostgresAgencyFixture } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
const {
  enqueueUniqueCampaignFanRefreshes,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
} = require("./campaign-fan-refresh-queue-service");

function ids(prefix) {
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    nonce,
    agencyId: `${prefix}-agency-${nonce}`,
    creatorId: `${prefix}-creator-${nonce}`,
    campaignJobA: `${prefix}-campaign-a-${nonce}`,
    campaignJobB: `${prefix}-campaign-b-${nonce}`,
  };
}

async function createScope(db, scope, { secondCampaignJob = false } = {}) {
  await withPhase3PostgresFixtureAuthority(db, async (tx) => {
    await tx.agency.create({ data: { id: scope.agencyId, name: `A20.4 ${scope.agencyId}` } });
    await tx.creatorAccount.create({ data: { id: scope.creatorId, agencyId: scope.agencyId, displayName: "A20.4 Creator" } });
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
  for (const jobId of [scope.campaignJobA, ...(secondCampaignJob ? [scope.campaignJobB] : [])]) {
    await db.jobInstance.create({
      data: {
        id: jobId,
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
  await cleanupPhase3PostgresAgencyFixture(db, scope.agencyId);
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

function instrumentRaw(db, counter) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "$queryRawUnsafe") {
        return async (...args) => {
          counter.queryRaw += 1;
          return target.$queryRawUnsafe(...args);
        };
      }
      if (prop === "$executeRawUnsafe") {
        return async (...args) => {
          counter.executeRaw += 1;
          return target.$executeRawUnsafe(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function createCanonicalValues(db, scope, values, observedAt) {
  await db.creatorFan.createMany({
    data: values.map((row) => ({
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      onlyFansUserId: row.onlyFansUserId,
    })),
    skipDuplicates: true,
  });
  const fans = await db.creatorFan.findMany({
    where: { creatorId: scope.creatorId, onlyFansUserId: { in: values.map((row) => row.onlyFansUserId) } },
    select: { id: true, onlyFansUserId: true },
  });
  const byFan = new Map(fans.map((fan) => [String(fan.onlyFansUserId), fan.id]));
  await db.creatorFanValueCurrent.createMany({
    data: values.map((row) => ({
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      fanRecordId: byFan.get(row.onlyFansUserId),
      valueObservedAt: observedAt,
      availability: row.availability,
      source: "A20_4_POSTGRES_PROOF",
    })),
    skipDuplicates: true,
  });
}

async function seedHealingRows(db, scope, count, { runId, cutoff, observedAt }) {
  const fanIds = Array.from({ length: count }, (_, index) => `fan-${scope.nonce}-${String(index + 1).padStart(4, "0")}`);
  const demandRows = fanIds.map((fanId, index) => ({
    id: `d-${scope.nonce}-${index + 1}`,
    agencyId: scope.agencyId,
    creatorId: scope.creatorId,
    onlyFansUserId: fanId,
    requestedFreshnessCutoffAt: cutoff,
    requestedRevision: 1,
    satisfiedRevision: 0,
    status: "QUEUED",
    lastRequestedAt: cutoff,
  }));
  await db.creatorFanRefreshDemand.createMany({ data: demandRows });
  await db.creatorCampaignFanRefreshWork.createMany({
    data: demandRows.map((demand) => ({
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      scanRunId: runId,
      scanStartedAt: cutoff,
      onlyFansUserId: demand.onlyFansUserId,
      campaignJobId: scope.campaignJobA,
      demandId: demand.id,
      requestedRevision: 1,
      freshnessCutoffAt: cutoff,
      status: "QUEUED",
      scheduledAt: cutoff,
    })),
  });
  await db.creatorCampaignCollectionState.update({
    where: { creatorId: scope.creatorId },
    data: {
      fanValueCoverageScanRunId: runId,
      fanValueCoverageDelegated: true,
      fanValueCoverageOwnerKind: "automatic",
      fanValueCoverageCollectorVersion: "campaigns-v13",
      fanValueCoverageSourceJobId: scope.campaignJobA,
      fanValueFreshnessCutoffAt: cutoff,
      fanValueFreshnessStatus: "QUEUED",
      fanValueExpected: count,
      fanValueAlreadyFresh: 0,
      fanValueQueued: count,
      fanValueSucceeded: 0,
      fanValueUnavailable: 0,
      fanValueFailed: 0,
      fanValueOutstanding: count,
    },
  });
  await createCanonicalValues(
    db,
    scope,
    fanIds.map((onlyFansUserId) => ({ onlyFansUserId, availability: "AVAILABLE" })),
    observedAt,
  );
  return fanIds;
}

test("A20.4 PostgreSQL: current canonical generation heals AVAILABLE/UNAVAILABLE while superseded work stays historical-only", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a204-generation");
  try {
    await createScope(db, scope, { secondCampaignJob: true });
    const fans = [
      { onlyFansUserId: `fan-available-${scope.nonce}`, availability: "AVAILABLE" },
      { onlyFansUserId: `fan-unavailable-${scope.nonce}`, availability: "UNAVAILABLE" },
    ];
    const base = new Date("2040-02-01T00:00:00.000Z");
    await db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
      db: tx,
      job: { id: scope.campaignJobA, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
      scanRunId: "run-superseded",
      scanStartedAt: base,
      candidates: fans,
      now: new Date(base.getTime() + 1000),
      planner: prismaPlanner,
      collectorVersion: "campaigns-v13",
    }));
    await db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
      db: tx,
      job: { id: scope.campaignJobB, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
      scanRunId: "run-current",
      scanStartedAt: new Date(base.getTime() + 60_000),
      candidates: fans,
      now: new Date(base.getTime() + 61_000),
      planner: prismaPlanner,
      collectorVersion: "campaigns-v13",
    }));
    const before = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(before.fanValueCoverageScanRunId, "run-current");
    assert.equal(before.fanValueOutstanding, 2);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, scanRunId: "run-superseded", status: "QUEUED" } }), 2);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, scanRunId: "run-current", status: "QUEUED" } }), 2);

    const observedAt = new Date(base.getTime() + 120_000);
    await createCanonicalValues(db, scope, fans, observedAt);
    const healed = await db.$transaction((tx) => reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
      db: tx,
      creatorId: scope.creatorId,
      fanIds: fans.map((row) => row.onlyFansUserId),
      now: new Date(observedAt.getTime() + 1000),
    }));
    assert.equal(healed.healed, 2);
    assert.equal(healed.workTransitioned, 4, "both current and superseded durable work rows must converge from the same canonical observation");
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "COMPLETE" } }), 1);
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "UNAVAILABLE" } }), 1);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "SUCCEEDED" } }), 2);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "UNAVAILABLE" } }), 2);
    const after = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(after.fanValueCoverageScanRunId, "run-current");
    assert.equal(after.fanValueOutstanding, 0);
    assert.equal(after.fanValueSucceeded, 1);
    assert.equal(after.fanValueUnavailable, 1);
    assert.equal(after.fanValueFreshnessStatus, "COMPLETE");
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.4 PostgreSQL: current-generation counter mismatch rolls back demand/work healing", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a204-rollback");
  try {
    await createScope(db, scope);
    const onlyFansUserId = `fan-rollback-${scope.nonce}`;
    const base = new Date("2040-02-02T00:00:00.000Z");
    await db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
      db: tx,
      job: { id: scope.campaignJobA, agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 80, params: { campaignFreshnessCoverageVersion: 1 } },
      scanRunId: "run-rollback",
      scanStartedAt: base,
      candidates: [{ onlyFansUserId }],
      now: new Date(base.getTime() + 1000),
      planner: prismaPlanner,
      collectorVersion: "campaigns-v13",
    }));
    const observedAt = new Date(base.getTime() + 60_000);
    await createCanonicalValues(db, scope, [{ onlyFansUserId, availability: "AVAILABLE" }], observedAt);
    await db.creatorCampaignCollectionState.update({
      where: { creatorId: scope.creatorId },
      data: { fanValueOutstanding: 0, fanValueSucceeded: 0, fanValueUnavailable: 0 },
    });

    await assert.rejects(
      () => db.$transaction((tx) => reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
        db: tx,
        creatorId: scope.creatorId,
        fanIds: [onlyFansUserId],
        now: new Date(observedAt.getTime() + 1000),
      })),
      /CAMPAIGN_FAN_REFRESH_RECOVERY_COVERAGE_TRANSITION_LOST/,
    );

    const demand = await db.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId, onlyFansUserId } });
    const work = await db.creatorCampaignFanRefreshWork.findFirst({ where: { creatorId: scope.creatorId, onlyFansUserId, scanRunId: "run-rollback" } });
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(demand.status, "QUEUED", "data-modifying healing CTE must roll back with the thrown coverage guard error");
    assert.equal(work.status, "QUEUED", "work transition must roll back together with demand transition");
    assert.equal(state.fanValueOutstanding, 0);
    assert.equal(state.fanValueSucceeded, 0);
    assert.equal(state.fanValueUnavailable, 0);
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.4 PostgreSQL: canonical healing executes one real raw SQL round trip for 1/20/500 rows and records timing", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const metrics = [];
  try {
    for (const count of [1, 20, 500]) {
      const scope = ids(`a204-scale-${count}`);
      try {
        await createScope(db, scope);
        const cutoff = new Date("2040-02-03T00:00:00.000Z");
        const observedAt = new Date(cutoff.getTime() + 60_000);
        const runId = `run-scale-${count}`;
        const fanIds = await seedHealingRows(db, scope, count, { runId, cutoff, observedAt });
        const counter = { queryRaw: 0, executeRaw: 0 };
        const started = performance.now();
        const result = await db.$transaction(async (tx) => {
          const instrumented = instrumentRaw(tx, counter);
          return reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
            db: instrumented,
            creatorId: scope.creatorId,
            fanIds,
            now: new Date(observedAt.getTime() + 1000),
          });
        });
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        assert.equal(counter.queryRaw, 1, `real healing topology must stay one raw CTE for ${count} rows`);
        assert.equal(counter.executeRaw, 0);
        assert.equal(result.healed, count);
        assert.equal(result.workTransitioned, count);
        assert.equal(result.coverageRunsUpdated, 1);
        const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
        assert.equal(state.fanValueOutstanding, 0);
        assert.equal(state.fanValueSucceeded, count);
        assert.equal(state.fanValueFailed, 0);
        metrics.push({ count, queryRaw: counter.queryRaw, durationMs });
      } finally {
        await cleanupScope(db, scope).catch(() => {});
      }
    }
    console.log(`# A20_4_POSTGRES_HEALING_SCALE ${JSON.stringify(metrics)}`);
  } finally {
    await db.$disconnect();
  }
});
