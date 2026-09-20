"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { withPhase3PostgresFixtureAuthority } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
const {
  enqueueUniqueCampaignFanRefreshes,
  finalizeCampaignFanRefreshJob,
  recordCampaignFanRefreshJobFailure,
  recoverFailedCampaignFanRefreshDemands,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
  recordCampaignFanRefreshChunk,
} = require("./campaign-fan-refresh-queue-service");
const { projectFanObservationBatch } = require("./fan-data-authority-service");

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
    await tx.agency.create({ data: { id: scope.agencyId, name: `A20.5 ${scope.agencyId}` } });
    await tx.creatorAccount.create({ data: { id: scope.creatorId, agencyId: scope.agencyId, displayName: "A20.5 Creator" } });
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
  for (const id of [scope.campaignJobA, ...(secondCampaignJob ? [scope.campaignJobB] : [])]) {
    await db.jobInstance.create({
      data: {
        id,
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

function candidates(scope, count) {
  return Array.from({ length: count }, (_, index) => ({ onlyFansUserId: `fan-${scope.nonce}-${String(index + 1).padStart(4, "0")}` }));
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
    data: values.map((row) => ({ agencyId: scope.agencyId, creatorId: scope.creatorId, onlyFansUserId: row.onlyFansUserId })),
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
      availability: row.availability || "AVAILABLE",
      source: "A20_5_POSTGRES_PROOF",
    })),
    skipDuplicates: true,
  });
}

async function queue(db, scope, count, { runId = "run-current", campaignJobId = null, scanStartedAt = new Date("2040-03-01T00:00:00.000Z") } = {}) {
  return db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
    db: tx,
    job: {
      id: campaignJobId || scope.campaignJobA,
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      priority: 80,
      params: { campaignFreshnessCoverageVersion: 1 },
    },
    scanRunId: runId,
    scanStartedAt,
    candidates: candidates(scope, count),
    now: new Date(scanStartedAt.getTime() + 1000),
    planner: prismaPlanner,
    collectorVersion: "campaigns-v13",
  }));
}

function refreshJob(scope, id) {
  return { id, jobKey: "fan_data_point_refresh", agencyId: scope.agencyId, creatorId: scope.creatorId, priority: 85 };
}

for (const count of [1, 20, 50]) {
  test(`A20.5 PostgreSQL: terminal finalize is bounded and exact for ${count} demands`, { skip: !enabled, timeout: 120_000 }, async () => {
    const { PrismaClient } = require("@prisma/client");
    const db = new PrismaClient();
    const scope = ids(`a205-finalize-${count}`);
    try {
      await createScope(db, scope);
      const queued = await queue(db, scope, count);
      const counter = { queryRaw: 0, executeRaw: 0 };
      const started = performance.now();
      const result = await db.$transaction((tx) => finalizeCampaignFanRefreshJob({
        db: instrumentRaw(tx, counter),
        job: refreshJob(scope, queued.refreshJobId),
        result: {},
      }));
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      console.log(`# A20_5_POSTGRES_TERMINAL_SCALE_POINT ${JSON.stringify({ count, queryRaw: counter.queryRaw, executeRaw: counter.executeRaw, durationMs })}`);
      assert.equal(result.applied, count);
      assert.equal(result.topology, "set_based_v1");
      assert.equal(counter.queryRaw, 3, "lock + DB clock + terminal CTE must remain constant");
      assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "FAILED" } }), count);
      assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "FAILED" } }), count);
      const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
      assert.equal(state.fanValueOutstanding, 0);
      assert.equal(state.fanValueFailed, count);
      assert.equal(state.fanValueFreshnessStatus, "PARTIAL");
    } finally {
      await cleanupScope(db, scope).catch(() => {});
      await db.$disconnect();
    }
  });
}

test("A20.5 PostgreSQL: partial 25/50 canonical success plus terminal finalize converges exactly", { skip: !enabled, timeout: 150_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a205-partial");
  try {
    await createScope(db, scope);
    const base = new Date("2040-03-02T00:00:00.000Z");
    const queued = await queue(db, scope, 50, { scanStartedAt: base });
    const fanIds = candidates(scope, 50).map((row) => row.onlyFansUserId);
    const successIds = fanIds.slice(0, 25);
    const observedAt = new Date(base.getTime() + 60_000);
    await createCanonicalValues(db, scope, successIds.map((onlyFansUserId) => ({ onlyFansUserId, availability: "AVAILABLE" })), observedAt);
    const healed = await db.$transaction((tx) => reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
      db: tx,
      creatorId: scope.creatorId,
      fanIds: successIds,
      now: new Date(observedAt.getTime() + 1000),
    }));
    assert.equal(healed.healed, 25);
    const finalized = await db.$transaction((tx) => finalizeCampaignFanRefreshJob({ db: tx, job: refreshJob(scope, queued.refreshJobId), result: {} }));
    assert.equal(finalized.applied, 25);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "SUCCEEDED" } }), 25);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "FAILED" } }), 25);
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.fanValueOutstanding, 0);
    assert.equal(state.fanValueSucceeded, 25);
    assert.equal(state.fanValueFailed, 25);
    assert.equal(state.fanValueFreshnessStatus, "PARTIAL");
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.7 PostgreSQL: canonical point-refresh projection plus chunk hook is idempotent and bounded", { skip: !enabled, timeout: 150_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a207-chunk-authority");
  try {
    await createScope(db, scope);
    const base = new Date("2040-03-02T12:00:00.000Z");
    const queued = await queue(db, scope, 50, { scanStartedAt: base });
    const fanIds = candidates(scope, 50).map((row) => row.onlyFansUserId);
    const valueItems = fanIds.map((onlyFansUserId) => ({
      onlyFansUserId,
      value: { source: "USER_PROFILE", availability: "AVAILABLE", totalSpentCents: 0 },
    }));
    const observedAt = new Date(base.getTime() + 60_000);
    const projection = await db.$transaction((tx) => projectFanObservationBatch(tx, {
      agencyId: scope.agencyId,
      creatorId: scope.creatorId,
      sourceJobId: queued.refreshJobId,
      items: valueItems,
      allowedSources: ["USER_PROFILE"],
      observedAtPolicy: "SERVER_GENERATION",
      causalObservedAt: observedAt,
      receivedAt: new Date(observedAt.getTime() + 1000),
    }));
    assert.equal(projection.valueProjected, 50);
    const before = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(before.fanValueOutstanding, 0);
    assert.equal(before.fanValueSucceeded, 50);

    const counter = { queryRaw: 0, executeRaw: 0 };
    const started = performance.now();
    const receipt = await db.$transaction((tx) => recordCampaignFanRefreshChunk({
      db: instrumentRaw(tx, counter),
      job: refreshJob(scope, queued.refreshJobId),
      chunkResult: { items: valueItems },
      applied: { type: "fan_data_point_refresh", ...projection },
    }));
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    console.log(`# A20_7_POSTGRES_CHUNK_POST_PROJECTION ${JSON.stringify({ count: 50, queryRaw: counter.queryRaw, executeRaw: counter.executeRaw, durationMs })}`);
    assert.equal(receipt.topology, "canonical_projection_v1");
    assert.equal(receipt.applied, 0, "canonical projection already satisfied every demand");
    assert.equal(counter.queryRaw, 0, "canonical projection already reconciled every value-bearing item; chunk hook must add no DB read/write");
    assert.equal(counter.executeRaw, 0);
    assert.equal(await db.creatorFanRefreshDemand.count({ where: { creatorId: scope.creatorId, status: "COMPLETE" } }), 50);
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "SUCCEEDED" } }), 50);
    const after = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(after.fanValueOutstanding, 0);
    assert.equal(after.fanValueSucceeded, 50, "chunk hook must not double-increment coverage");
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.5 PostgreSQL: current and historical work fail once from one terminal demand", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a205-history");
  try {
    await createScope(db, scope, { secondCampaignJob: true });
    const base = new Date("2040-03-03T00:00:00.000Z");
    const first = await queue(db, scope, 1, { runId: "run-old", campaignJobId: scope.campaignJobA, scanStartedAt: base });
    await queue(db, scope, 1, { runId: "run-current", campaignJobId: scope.campaignJobB, scanStartedAt: base });
    const demand = await db.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId } });
    assert.equal(demand.requestedRevision, 1, "same cutoff should not manufacture a superseding revision");
    await db.$transaction((tx) => recordCampaignFanRefreshJobFailure({
      db: tx,
      job: refreshJob(scope, first.refreshJobId),
      error: new Error("terminal-provider-error"),
      terminal: true,
    }));
    assert.equal(await db.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "FAILED" } }), 2);
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.fanValueCoverageScanRunId, "run-current");
    assert.equal(state.fanValueOutstanding, 0);
    assert.equal(state.fanValueFailed, 1, "historical work must not double-count current generation counters");
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.5 PostgreSQL: retry attempt 4 -> 5 quarantines atomically", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a205-quarantine");
  try {
    await createScope(db, scope);
    const queued = await queue(db, scope, 1);
    await db.creatorFanRefreshDemand.updateMany({ where: { creatorId: scope.creatorId }, data: { retryAttempts: 4 } });
    await db.$transaction((tx) => recordCampaignFanRefreshJobFailure({
      db: tx,
      job: refreshJob(scope, queued.refreshJobId),
      error: "fifth terminal failure",
      terminal: true,
    }));
    const demand = await db.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId } });
    assert.equal(demand.retryAttempts, 5);
    assert.equal(demand.nextRetryAt, null);
    assert.ok(demand.quarantinedAt instanceof Date);
    assert.equal(demand.lastOutcome, "QUARANTINED");
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.5 PostgreSQL: two replicas terminalizing the same refresh job cannot double-decrement coverage", { skip: !enabled, timeout: 150_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const a = new PrismaClient();
  const b = new PrismaClient();
  const scope = ids("a205-two-replica");
  try {
    await createScope(a, scope);
    const queued = await queue(a, scope, 20);
    const job = refreshJob(scope, queued.refreshJobId);
    const results = await Promise.all([
      a.$transaction((tx) => finalizeCampaignFanRefreshJob({ db: tx, job, result: {} })),
      b.$transaction((tx) => finalizeCampaignFanRefreshJob({ db: tx, job, result: {} })),
    ]);
    assert.equal(results.reduce((sum, row) => sum + Number(row?.applied || 0), 0), 20);
    const state = await a.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(state.fanValueOutstanding, 0);
    assert.equal(state.fanValueFailed, 20);
    assert.equal(await a.creatorCampaignFanRefreshWork.count({ where: { creatorId: scope.creatorId, status: "FAILED" } }), 20);
  } finally {
    await cleanupScope(a, scope).catch(() => {});
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  }
});

test("A20.5 PostgreSQL: terminal failure racing canonical healing converges to one successful terminal state", { skip: !enabled, timeout: 150_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const a = new PrismaClient();
  const b = new PrismaClient();
  const scope = ids("a205-heal-race");
  try {
    await createScope(a, scope);
    const base = new Date("2040-03-04T00:00:00.000Z");
    const queued = await queue(a, scope, 1, { scanStartedAt: base });
    const onlyFansUserId = candidates(scope, 1)[0].onlyFansUserId;
    const observedAt = new Date(base.getTime() + 60_000);
    await createCanonicalValues(a, scope, [{ onlyFansUserId, availability: "AVAILABLE" }], observedAt);
    await Promise.all([
      a.$transaction((tx) => recordCampaignFanRefreshJobFailure({ db: tx, job: refreshJob(scope, queued.refreshJobId), error: "race-failure", terminal: true })),
      b.$transaction((tx) => reconcileCampaignFanRefreshDemandsFromCanonicalObservations({ db: tx, creatorId: scope.creatorId, fanIds: [onlyFansUserId], now: new Date(observedAt.getTime() + 1000) })),
    ]);
    const demand = await a.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId } });
    const work = await a.creatorCampaignFanRefreshWork.findFirst({ where: { creatorId: scope.creatorId } });
    const state = await a.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(demand.status, "COMPLETE");
    assert.equal(work.status, "SUCCEEDED");
    assert.equal(state.fanValueOutstanding, 0);
    assert.equal(state.fanValueSucceeded, 1);
    assert.equal(state.fanValueFailed, 0);
  } finally {
    await cleanupScope(a, scope).catch(() => {});
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  }
});

test("A20.5 PostgreSQL: current counter mismatch rolls back terminal demand/work mutations", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const scope = ids("a205-rollback");
  try {
    await createScope(db, scope);
    const queued = await queue(db, scope, 1);
    await db.creatorCampaignCollectionState.update({ where: { creatorId: scope.creatorId }, data: { fanValueOutstanding: 0, fanValueFailed: 0 } });
    await assert.rejects(
      () => db.$transaction((tx) => finalizeCampaignFanRefreshJob({ db: tx, job: refreshJob(scope, queued.refreshJobId), result: {} })),
      /CAMPAIGN_FAN_REFRESH_TERMINAL_COVERAGE_TRANSITION_LOST/,
    );
    const demand = await db.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId } });
    const work = await db.creatorCampaignFanRefreshWork.findFirst({ where: { creatorId: scope.creatorId } });
    assert.equal(demand.status, "QUEUED");
    assert.equal(demand.activeRefreshJobId, queued.refreshJobId);
    assert.equal(work.status, "QUEUED");
    assert.equal(work.refreshJobId, queued.refreshJobId);
  } finally {
    await cleanupScope(db, scope).catch(() => {});
    await db.$disconnect();
  }
});

test("A20.5 PostgreSQL: terminal failure followed by concurrent retry recovery and duplicate failure stays single-transition", { skip: !enabled, timeout: 150_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const a = new PrismaClient();
  const b = new PrismaClient();
  const scope = ids("a205-recovery-race");
  try {
    await createScope(a, scope);
    const queued = await queue(a, scope, 1);
    const job = refreshJob(scope, queued.refreshJobId);
    await a.$transaction((tx) => recordCampaignFanRefreshJobFailure({ db: tx, job, error: "first-terminal", terminal: true }));
    const failedAt = new Date("2040-03-05T00:10:00.000Z");
    await a.creatorFanRefreshDemand.updateMany({ where: { creatorId: scope.creatorId }, data: { nextRetryAt: new Date(failedAt.getTime() - 1000) } });
    await Promise.all([
      a.$transaction((tx) => recoverFailedCampaignFanRefreshDemands({ db: tx, now: failedAt, maxDemands: 20 })),
      b.$transaction((tx) => recordCampaignFanRefreshJobFailure({ db: tx, job, error: "duplicate-terminal", terminal: true })),
    ]);
    const demand = await a.creatorFanRefreshDemand.findFirst({ where: { creatorId: scope.creatorId } });
    const work = await a.creatorCampaignFanRefreshWork.findFirst({ where: { creatorId: scope.creatorId } });
    const state = await a.creatorCampaignCollectionState.findUnique({ where: { creatorId: scope.creatorId } });
    assert.equal(demand.status, "QUEUED");
    assert.equal(work.status, "QUEUED");
    assert.equal(state.fanValueFailed, 0);
    assert.equal(state.fanValueOutstanding, 1);
  } finally {
    await cleanupScope(a, scope).catch(() => {});
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  }
});
