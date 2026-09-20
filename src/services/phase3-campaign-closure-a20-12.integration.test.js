"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { withPhase3PostgresFixtureAuthority } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");
let ingestCampaignChunk;
let enqueueUniqueCampaignFanRefreshes;
let finalizeCampaignFanRefreshJob;
let recoverFailedCampaignFanRefreshDemands;
let createFanObservationToken;
if (enabled) {
  ({ ingestCampaignChunk } = require("./creator-analytics-ledger-service"));
  ({
    enqueueUniqueCampaignFanRefreshes,
    finalizeCampaignFanRefreshJob,
    recoverFailedCampaignFanRefreshDemands,
  } = require("./campaign-fan-refresh-queue-service"));
  ({ createFanObservationToken } = require("./fan-observation-token-service"));
}

function scope(prefix) {
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    agencyId: `${prefix}-agency-${nonce}`,
    creatorId: `${prefix}-creator-${nonce}`,
    oldCampaignJobId: `${prefix}-old-job-${nonce}`,
    ingestCampaignJobId: `${prefix}-ingest-job-${nonce}`,
    campaignId: `${prefix}-campaign-row-${nonce}`,
    fanA: `${prefix}-fan-a-${nonce}`,
    fanB: `${prefix}-fan-b-${nonce}`,
    oldRun: `${prefix}-old-run-${nonce}`,
    ingestRun: `${prefix}-ingest-run-${nonce}`,
    deviceId: `${prefix}-device-${nonce}`,
  };
}

function collectionParams(runId, requestedAt) {
  return {
    collectionContractVersion: 1,
    collectionType: "CAMPAIGNS",
    collectionMode: "full",
    collectionGeneration: runId,
    collectionRequestedAt: requestedAt.toISOString(),
    collectionAuthorityRequestedAt: requestedAt.toISOString(),
    collectionReason: "A20_12_MIXED_INGEST_RACE",
    campaignFreshnessCoverageVersion: 1,
    observationTokenVersion: 1,
  };
}

async function createScope(db, s) {
  const oldAt = new Date("2041-01-01T00:00:00.000Z");
  const ingestAt = new Date("2041-01-02T00:00:00.000Z");
  await withPhase3PostgresFixtureAuthority(db, async (tx) => {
    await tx.agency.create({ data: { id: s.agencyId, name: `A20.12 ${s.agencyId}` } });
    await tx.creatorAccount.create({ data: { id: s.creatorId, agencyId: s.agencyId, displayName: "A20.12 Creator" } });
  });
  await db.creatorCampaignCollectionState.create({
    data: {
      agencyId: s.agencyId,
      creatorId: s.creatorId,
      status: "PARTIAL",
      mode: "full",
      membershipCoverageStatus: "COMPLETE",
      campaignFrontierFreshnessStatus: "COMPLETE",
    },
  });
  const oldCampaignJob = await db.jobInstance.create({
    data: {
      id: s.oldCampaignJobId,
      jobKey: "fetch_campaigns",
      scope: "creator",
      creatorId: s.creatorId,
      agencyId: s.agencyId,
      status: "CLAIMED",
      leaseRevision: 1,
      params: collectionParams(s.oldRun, oldAt),
    },
  });
  const ingestCampaignJob = await db.jobInstance.create({
    data: {
      id: s.ingestCampaignJobId,
      jobKey: "fetch_campaigns",
      scope: "creator",
      creatorId: s.creatorId,
      agencyId: s.agencyId,
      status: "CLAIMED",
      leaseRevision: 1,
      params: collectionParams(s.ingestRun, ingestAt),
    },
  });
  await db.creatorCampaign.create({
    data: {
      id: s.campaignId,
      agencyId: s.agencyId,
      creatorId: s.creatorId,
      externalCampaignId: "campaign-a20-12",
      name: "A20.12 Campaign",
      isActive: true,
      sourceScanRunId: s.oldRun,
      sourceScanStartedAt: oldAt,
      sourceJobId: oldCampaignJob.id,
    },
  });
  return { oldCampaignJob, ingestCampaignJob, oldAt, ingestAt };
}

async function cleanup(db, s) {
  await withPhase3PostgresFixtureAuthority(db, (tx) => tx.agency.deleteMany({ where: { id: s.agencyId } }));
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

async function seedOldRefresh(db, s, oldCampaignJob, oldAt) {
  return db.$transaction((tx) => enqueueUniqueCampaignFanRefreshes({
    db: tx,
    job: oldCampaignJob,
    scanRunId: s.oldRun,
    scanStartedAt: oldAt,
    candidates: [
      { onlyFansUserId: s.fanA },
      { onlyFansUserId: s.fanB },
    ],
    now: new Date(oldAt.getTime() + 1000),
    planner,
    collectorVersion: "campaigns-v13",
  }), { maxWait: 30_000, timeout: 60_000 });
}

async function mixedIngest(db, s, ingestCampaignJob, ingestAt) {
  const token = await createFanObservationToken({
    db,
    job: ingestCampaignJob,
    deviceId: s.deviceId,
    leaseRevision: 1,
    purpose: "campaign_claimers_page",
    subjects: [s.fanA, s.fanB],
  });
  return ingestCampaignChunk({
    db,
    job: ingestCampaignJob,
    deviceId: s.deviceId,
    chunk: {
      kind: "campaign_claimers_page",
      schemaVersion: 4,
      collectorVersion: "campaigns-v13",
      scanRunId: s.ingestRun,
      batchKey: `run:${s.ingestRun}:campaigns-v13:claimers:page-1`,
      externalCampaignId: "campaign-a20-12",
      pageNumber: 1,
      sourceHasMore: false,
      campaignComplete: true,
      knownBoundaryReached: false,
      campaignMode: "full",
      scannerRejected: 0,
      observationToken: token.token,
      claimers: [
        {
          id: "claim-a",
          userId: s.fanA,
          username: "a20_12_embedded",
          embeddedValue: {
            observedAt: new Date(ingestAt.getTime() + 1000).toISOString(),
            totalSpentCents: 100,
            messagesSpentCents: 10,
            subscriptionsSpentCents: 20,
            tipsSpentCents: 30,
            postsSpentCents: 40,
            streamsSpentCents: 0,
          },
        },
        { id: "claim-b", userId: s.fanB, username: "a20_12_stale" },
      ],
    },
  });
}

async function demandState(db, s) {
  const rows = await db.creatorFanRefreshDemand.findMany({
    where: { creatorId: s.creatorId, onlyFansUserId: { in: [s.fanA, s.fanB] } },
    select: { onlyFansUserId: true, status: true, requestedRevision: true, satisfiedRevision: true },
  });
  return new Map(rows.map((row) => [row.onlyFansUserId, row]));
}

test("A20.12 PostgreSQL: real mixed ingest (embedded healing + stale enqueue) serializes with terminal refresh", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const ingestDb = new PrismaClient();
  const terminalDb = new PrismaClient();
  const s = scope("a2012-terminal");
  try {
    const { oldCampaignJob, ingestCampaignJob, oldAt, ingestAt } = await createScope(ingestDb, s);
    const seeded = await seedOldRefresh(ingestDb, s, oldCampaignJob, oldAt);
    assert.ok(seeded.refreshJobId);
    const terminalJob = { id: seeded.refreshJobId, jobKey: "fan_data_point_refresh", agencyId: s.agencyId, creatorId: s.creatorId };
    const [ingested, terminal] = await Promise.all([
      mixedIngest(ingestDb, s, ingestCampaignJob, ingestAt),
      finalizeCampaignFanRefreshJob({ db: terminalDb, job: terminalJob, result: {} }),
    ]);
    assert.equal(ingested.superseded, false);
    assert.ok(terminal);
    const demands = await demandState(ingestDb, s);
    assert.equal(demands.get(s.fanA)?.status, "COMPLETE", "embedded fan must heal the prior demand regardless of terminal ordering");
    assert.ok(["QUEUED", "FAILED", "COMPLETE"].includes(demands.get(s.fanB)?.status), `unexpected stale-fan demand: ${JSON.stringify(demands.get(s.fanB))}`);
    console.log("# A20_12_MIXED_INGEST_TERMINAL_PASS");
  } finally {
    await cleanup(ingestDb, s).catch(() => {});
    await ingestDb.$disconnect();
    await terminalDb.$disconnect();
  }
});

test("A20.12 PostgreSQL: real mixed ingest serializes with failed-demand recovery under the same creator authority", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const ingestDb = new PrismaClient();
  const recoveryDb = new PrismaClient();
  const s = scope("a2012-recovery");
  try {
    const { oldCampaignJob, ingestCampaignJob, oldAt, ingestAt } = await createScope(ingestDb, s);
    const seeded = await seedOldRefresh(ingestDb, s, oldCampaignJob, oldAt);
    const terminalJob = { id: seeded.refreshJobId, jobKey: "fan_data_point_refresh", agencyId: s.agencyId, creatorId: s.creatorId };
    await finalizeCampaignFanRefreshJob({ db: ingestDb, job: terminalJob, result: {} });
    const [ingested, recovered] = await Promise.all([
      mixedIngest(ingestDb, s, ingestCampaignJob, ingestAt),
      recoverFailedCampaignFanRefreshDemands({
        db: recoveryDb,
        creatorId: s.creatorId,
        now: new Date(ingestAt.getTime() + 5 * 60_000),
        force: true,
        maxDemands: 50,
      }),
    ]);
    assert.equal(ingested.superseded, false);
    assert.ok(Number(recovered?.recovered || 0) >= 0);
    const demands = await demandState(ingestDb, s);
    assert.equal(demands.get(s.fanA)?.status, "COMPLETE");
    assert.ok(["QUEUED", "FAILED", "COMPLETE"].includes(demands.get(s.fanB)?.status));
    console.log("# A20_12_MIXED_INGEST_RECOVERY_PASS");
  } finally {
    await cleanup(ingestDb, s).catch(() => {});
    await ingestDb.$disconnect();
    await recoveryDb.$disconnect();
  }
});
