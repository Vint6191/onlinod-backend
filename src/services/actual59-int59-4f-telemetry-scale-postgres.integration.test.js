"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_ACTUAL59_SCALE_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function withTeamGeneration(db, workFn) {
  const release = require("./phase2-release-compatibility-authority-service");
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT set_config($1,$2,true) AS value`,
      release.TEAM_CONTROL_PLANE_DB_SETTING,
      release.TEAM_CONTROL_PLANE_GENERATION,
    );
    return workFn(tx);
  });
}

async function cleanupAgency(db, agencyId, userIds = []) {
  const work = require("./domain-work-authority-service");
  const release = require("./phase2-release-compatibility-authority-service");
  try {
    await work.publishDomainWork({
      db,
      agencyId,
      workClass: work.WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
      objectType: "Actual59ScaleAgencyDestructiveCleanup",
      objectId: agencyId,
      partitionKey: agencyId,
      availableAt: new Date(Date.now() - 1_000),
    });
    await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, agencyId);
      await tx.$queryRawUnsafe(`SELECT set_config($1,$2,true) AS value`, release.TEAM_CONTROL_PLANE_DB_SETTING, release.TEAM_CONTROL_PLANE_GENERATION);
      await tx.agency.delete({ where: { id: agencyId } });
    });
  } catch (_) {}
  for (const userId of userIds) {
    try { await db.user.delete({ where: { id: userId } }); } catch (_) {}
  }
}

async function seedWorker({ db, agencyId, creatorId, ordinal }) {
  const userId = token(`a59_scale_user_${ordinal}`);
  const memberId = token(`a59_scale_member_${ordinal}`);
  const deviceId = token(`a59_scale_device_${ordinal}`);
  const lineage = token(`a59_scale_lineage_${ordinal}`);
  await db.user.create({ data: {
    id: userId,
    email: `${userId}@example.test`,
    passwordHash: "integration",
    emailVerifiedAt: new Date(),
  } });
  await withTeamGeneration(db, (tx) => tx.agencyMember.create({ data: {
    id: memberId,
    agencyId,
    userId,
    role: "CHATTER",
    roleKey: "chatter",
    assignedCreators: [creatorId],
  } }));
  await db.workerDevice.create({ data: {
    id: deviceId,
    agencyId,
    userId,
    deviceName: `scale-${ordinal}`,
    platform: "integration",
    appVersion: "actual59-int59.4f",
  } });
  await db.refreshSession.create({ data: {
    id: token(`a59_scale_refresh_${ordinal}`),
    userId,
    agencyId,
    tokenHash: token(`a59_scale_hash_${ordinal}`),
    deviceId,
    authorizationSessionId: lineage,
    rememberDevice: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } });
  const member = await db.agencyMember.findUnique({ where: { id: memberId }, select: { accessEpoch: true } });
  return { userId, memberId, deviceId, lineage, accessEpoch: Number(member.accessEpoch) };
}

async function setupScaleFixture({ workers = 1 } = {}) {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const release = require("./phase2-release-compatibility-authority-service");
  const { currentCreatorCatalogGeneration } = require("./creator-human-management-authority-service");
  const agencyId = token("a59_scale_agency");
  const creatorId = token("a59_scale_creator");
  const username = token("a59_scale_username");
  const userIds = [];
  try {
    await withTeamGeneration(db, (tx) => tx.agency.create({ data: { id: agencyId, name: agencyId } }));
    await release.runCreatorAccountWriteTransaction(db, (tx) => tx.creatorAccount.create({ data: {
      id: creatorId,
      agencyId,
      displayName: creatorId,
      username,
    } }));
    const creatorCatalogGeneration = await currentCreatorCatalogGeneration({ db, agencyId });
    const actors = [];
    for (let i = 0; i < workers; i += 1) {
      const actor = await seedWorker({ db, agencyId, creatorId, ordinal: i + 1 });
      actors.push(actor);
      userIds.push(actor.userId);
    }
    return { db, agencyId, creatorId, creatorCatalogGeneration, actors, userIds };
  } catch (error) {
    await cleanupAgency(db, agencyId, userIds);
    await db.$disconnect();
    throw error;
  }
}

function humanEvents({ count, actor, creatorId, creatorCatalogGeneration, prefix }) {
  const capture = {
    version: 1,
    semantics: "CURRENT_HUMAN",
    authorizationScopeIncarnation: actor.lineage,
    accessEpoch: actor.accessEpoch,
    creatorCatalogGeneration,
    localAuthorizationRevision: 1,
  };
  return Array.from({ length: count }, (_, i) => ({
    telemetryVersion: "team_v13_provenance",
    source: "electron_team_v13",
    eventKind: "USER_ACTIVITY",
    actionSource: "MANUAL",
    lifecycle: "OBSERVED",
    creatorId,
    accountId: creatorId,
    actorMemberId: actor.memberId,
    actorUserId: actor.userId,
    localId: `${prefix}-${i + 1}`,
    occurredAt: new Date().toISOString(),
    metadata: { authorizationCapture: capture },
  }));
}

async function measuredIngest({ fixture, actor, count, prefix }) {
  const telemetry = require("./telemetry-ingest-service");
  const started = process.hrtime.bigint();
  const result = await telemetry.ingestTeamEvents({
    agencyId: fixture.agencyId,
    deviceId: actor.deviceId,
    userId: actor.userId,
    memberId: actor.memberId,
    admittedAccessEpoch: actor.accessEpoch,
    admittedAuthorizationSessionId: actor.lineage,
    events: humanEvents({
      count,
      actor,
      creatorId: fixture.creatorId,
      creatorCatalogGeneration: fixture.creatorCatalogGeneration,
      prefix,
    }),
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { result, elapsedMs };
}

async function withTransactionCounter(work) {
  const prisma = require("../prisma");
  const original = prisma.$transaction.bind(prisma);
  let count = 0;
  prisma.$transaction = async (...args) => {
    count += 1;
    return original(...args);
  };
  try {
    const value = await work();
    return { value, transactionCount: count };
  } finally {
    prisma.$transaction = original;
  }
}

for (const size of [100, 1000]) {
  test(`Actual59 INT59.4F PostgreSQL scale: ${size}-event CURRENT_HUMAN batch is lossless and bounded`, { skip: !enabled, timeout: 180_000 }, async () => {
    const fixture = await setupScaleFixture({ workers: 1 });
    try {
      const actor = fixture.actors[0];
      const telemetry = require("./telemetry-ingest-service");
      const expectedTransactions = Math.ceil(size / telemetry.TEAM_TELEMETRY_TX_CHUNK_SIZE);
      const counted = await withTransactionCounter(() => measuredIngest({ fixture, actor, count: size, prefix: `batch-${size}` }));
      const { result, elapsedMs } = counted.value;
      assert.equal(result.received, size);
      assert.equal(result.accepted, size);
      assert.equal(result.inserted, size);
      assert.equal(result.skipped, 0);
      assert.equal(new Set(result.acknowledgedLocalIds).size, size);
      assert.equal(counted.transactionCount, expectedTransactions,
        `transaction amplification must remain ceil(events/${telemetry.TEAM_TELEMETRY_TX_CHUNK_SIZE})`);
      console.log(`# ACTUAL59_SCALE batch=${size} accepted=${result.accepted} tx=${counted.transactionCount} elapsedMs=${elapsedMs.toFixed(2)} eventsPerSecond=${(size / (elapsedMs / 1000)).toFixed(2)}`);
    } finally {
      await cleanupAgency(fixture.db, fixture.agencyId, fixture.userIds);
      await fixture.db.$disconnect();
    }
  });
}

test("Actual59 INT59.4F PostgreSQL scale: concurrent worker streams preserve ACK uniqueness and bounded transaction amplification", { skip: !enabled, timeout: 240_000 }, async () => {
  const workers = Math.max(2, Math.min(16, Number(process.env.ONLINOD_ACTUAL59_SCALE_WORKERS || 8)));
  const eventsPerWorker = Math.max(16, Math.min(1000, Number(process.env.ONLINOD_ACTUAL59_SCALE_EVENTS_PER_WORKER || 125)));
  const fixture = await setupScaleFixture({ workers });
  try {
    const telemetry = require("./telemetry-ingest-service");
    const expectedTransactions = workers * Math.ceil(eventsPerWorker / telemetry.TEAM_TELEMETRY_TX_CHUNK_SIZE);
    const counted = await withTransactionCounter(async () => {
      const started = process.hrtime.bigint();
      const results = await Promise.all(fixture.actors.map((actor, i) => measuredIngest({
        fixture,
        actor,
        count: eventsPerWorker,
        prefix: `worker-${i + 1}`,
      })));
      const wallMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      return { results, wallMs };
    });
    const totalEvents = workers * eventsPerWorker;
    const accepted = counted.value.results.reduce((sum, entry) => sum + entry.result.accepted, 0);
    const allAcks = counted.value.results.flatMap((entry) => entry.result.acknowledgedLocalIds);
    const workerDurations = counted.value.results.map((entry) => entry.elapsedMs);
    assert.equal(accepted, totalEvents);
    assert.equal(allAcks.length, totalEvents);
    assert.equal(new Set(allAcks).size, totalEvents);
    assert.equal(counted.transactionCount, expectedTransactions);
    console.log(`# ACTUAL59_SCALE workers=${workers} eventsPerWorker=${eventsPerWorker} totalEvents=${totalEvents} accepted=${accepted} tx=${counted.transactionCount} wallMs=${counted.value.wallMs.toFixed(2)} workerP50Ms=${percentile(workerDurations, 50).toFixed(2)} workerP95Ms=${percentile(workerDurations, 95).toFixed(2)} eventsPerSecond=${(totalEvents / (counted.value.wallMs / 1000)).toFixed(2)}`);
  } finally {
    await cleanupAgency(fixture.db, fixture.agencyId, fixture.userIds);
    await fixture.db.$disconnect();
  }
});
