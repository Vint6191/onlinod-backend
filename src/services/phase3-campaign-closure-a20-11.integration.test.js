"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const {
  enqueueUniqueCampaignFanRefreshes,
  finalizeCampaignFanRefreshJob,
  recoverFailedCampaignFanRefreshDemands,
  reconcileCampaignFanRefreshDemandsFromCanonicalObservations,
} = require("./campaign-fan-refresh-queue-service");

function scope(prefix) {
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    agencyId: `${prefix}-agency-${nonce}`,
    creatorId: `${prefix}-creator-${nonce}`,
    campaignJobA: `${prefix}-campaign-a-${nonce}`,
    campaignJobB: `${prefix}-campaign-b-${nonce}`,
    fanId: `${prefix}-fan-${nonce}`,
  };
}

async function createScope(db, s) {
  await db.agency.create({ data: { id: s.agencyId, name: `A20.11 ${s.agencyId}` } });
  await db.creatorAccount.create({ data: { id: s.creatorId, agencyId: s.agencyId, displayName: "A20.11 Creator" } });
  await db.creatorCampaignCollectionState.create({
    data: {
      agencyId: s.agencyId,
      creatorId: s.creatorId,
      status: "PARTIAL",
      mode: "catchup",
      membershipCoverageStatus: "COMPLETE",
      campaignFrontierFreshnessStatus: "COMPLETE",
    },
  });
  for (const id of [s.campaignJobA, s.campaignJobB]) {
    await db.jobInstance.create({
      data: {
        id,
        jobKey: "fetch_campaigns",
        scope: "creator",
        creatorId: s.creatorId,
        agencyId: s.agencyId,
        status: "CLAIMED",
        params: { campaignFreshnessCoverageVersion: 1 },
      },
    });
  }
}

async function cleanup(db, s) {
  await db.agency.deleteMany({ where: { id: s.agencyId } });
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

function campaignJob(s, id) {
  return {
    id,
    agencyId: s.agencyId,
    creatorId: s.creatorId,
    priority: 80,
    params: { campaignFreshnessCoverageVersion: 1 },
  };
}

async function queue(db, s, { jobId, runId, startedAt }) {
  return db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
    db: tx,
    job: campaignJob(s, jobId),
    scanRunId: runId,
    scanStartedAt: startedAt,
    candidates: [{ onlyFansUserId: s.fanId }],
    now: new Date(startedAt.getTime() + 1000),
    planner,
    collectorVersion: "campaigns-v13",
  }), { maxWait: 30_000, timeout: 60_000 });
}

async function lockDemand(tx, s) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id" FROM "CreatorFanRefreshDemand" WHERE "creatorId" = $1 AND "onlyFansUserId" = $2 FOR UPDATE`,
    s.creatorId,
    s.fanId,
  );
  assert.equal(rows.length, 1);
}

async function assertBlocked(promise, label) {
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, `${label} must be waiting on demand-first lock order before the owner reaches collection state`);
}

async function startNewGeneration(db, s, suffix) {
  const startedAt = new Date(`2040-05-${suffix}T00:00:00.000Z`);
  return queue(db, s, { jobId: s.campaignJobB, runId: `run-new-${suffix}`, startedAt });
}

async function createCanonicalValue(db, s, observedAt) {
  const fan = await db.creatorFan.create({
    data: { agencyId: s.agencyId, creatorId: s.creatorId, onlyFansUserId: s.fanId },
  });
  await db.creatorFanValueCurrent.create({
    data: {
      agencyId: s.agencyId,
      creatorId: s.creatorId,
      fanRecordId: fan.id,
      valueObservedAt: observedAt,
      availability: "AVAILABLE",
      source: "A20_11_LOCK_ORDER_PROOF",
    },
  });
}

async function seedOldGeneration(db, s) {
  const startedAt = new Date("2040-05-01T00:00:00.000Z");
  return queue(db, s, { jobId: s.campaignJobA, runId: "run-old", startedAt });
}

async function raceAgainstNewGeneration({ owner, contender, s, ownerAction, suffix }) {
  let contenderPromise;
  await owner.$transaction(async (tx) => {
    await lockDemand(tx, s);
    contenderPromise = startNewGeneration(contender, s, suffix);
    await assertBlocked(contenderPromise, `A20.11 ${suffix} contender`);
    await ownerAction(tx);
  }, { maxWait: 30_000, timeout: 60_000 });
  return contenderPromise;
}

test("A20.11 PostgreSQL: terminal transition and new Campaign generation share demand->work->state lock order", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const owner = new PrismaClient();
  const contender = new PrismaClient();
  const s = scope("a2011-terminal");
  try {
    await createScope(owner, s);
    const old = await seedOldGeneration(owner, s);
    const next = await raceAgainstNewGeneration({
      owner, contender, s, suffix: "02",
      ownerAction: (tx) => finalizeCampaignFanRefreshJob({
        db: tx,
        job: { id: old.refreshJobId, jobKey: "fan_data_point_refresh", agencyId: s.agencyId, creatorId: s.creatorId },
        result: {},
      }),
    });
    assert.equal(next.queued, 1);
    console.log("# A20_11_LOCK_ORDER_TERMINAL_PASS");
  } finally {
    await cleanup(owner, s).catch(() => {});
    await owner.$disconnect();
    await contender.$disconnect();
  }
});

test("A20.11 PostgreSQL: canonical healing and new Campaign generation cannot form state<->demand deadlock", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const owner = new PrismaClient();
  const contender = new PrismaClient();
  const s = scope("a2011-heal");
  try {
    await createScope(owner, s);
    await seedOldGeneration(owner, s);
    await createCanonicalValue(owner, s, new Date("2040-05-01T00:00:02.000Z"));
    const next = await raceAgainstNewGeneration({
      owner, contender, s, suffix: "03",
      ownerAction: async (tx) => {
        const healed = await reconcileCampaignFanRefreshDemandsFromCanonicalObservations({
          db: tx,
          creatorId: s.creatorId,
          fanIds: [s.fanId],
          now: new Date("2040-05-01T00:00:03.000Z"),
        });
        assert.equal(healed.healed, 1);
      },
    });
    assert.equal(next.queued, 1);
    console.log("# A20_11_LOCK_ORDER_HEALING_PASS");
  } finally {
    await cleanup(owner, s).catch(() => {});
    await owner.$disconnect();
    await contender.$disconnect();
  }
});

test("A20.11 PostgreSQL: failed-demand recovery and new Campaign generation cannot deadlock", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const owner = new PrismaClient();
  const contender = new PrismaClient();
  const s = scope("a2011-recovery");
  try {
    await createScope(owner, s);
    const old = await seedOldGeneration(owner, s);
    await owner.$transaction((tx) => finalizeCampaignFanRefreshJob({
      db: tx,
      job: { id: old.refreshJobId, jobKey: "fan_data_point_refresh", agencyId: s.agencyId, creatorId: s.creatorId },
      result: {},
    }), { maxWait: 30_000, timeout: 60_000 });
    const next = await raceAgainstNewGeneration({
      owner, contender, s, suffix: "04",
      ownerAction: async (tx) => {
        const recovered = await recoverFailedCampaignFanRefreshDemands({
          db: tx,
          creatorId: s.creatorId,
          now: new Date("2040-05-01T00:05:00.000Z"),
          force: true,
          maxDemands: 10,
        });
        assert.equal(recovered.recovered, 1);
      },
    });
    assert.equal(next.queued, 1);
    console.log("# A20_11_LOCK_ORDER_RECOVERY_PASS");
  } finally {
    await cleanup(owner, s).catch(() => {});
    await owner.$disconnect();
    await contender.$disconnect();
  }
});
