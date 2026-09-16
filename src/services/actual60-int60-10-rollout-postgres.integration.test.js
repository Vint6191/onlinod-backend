"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const rollout = require("./actual60-authorization-history-rollout-service");

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function snapshotRelease(db) {
  const rows = await db.$queryRawUnsafe(
    `SELECT "requiredGeneration","activationState","drainStartedAt","activatedAt","activationConfirmedAt"
       FROM "Phase2ReleaseCompatibilityAuthority"
      WHERE "scope"=$1`,
    rollout.AUTH_HISTORY_PURGE_SCOPE,
  );
  return rows[0] || null;
}

async function setReleaseState(db, state) {
  await db.$executeRawUnsafe(
    `UPDATE "Phase2ReleaseCompatibilityAuthority"
        SET "requiredGeneration"=$2,
            "activationState"=$3,
            "updatedAt"=clock_timestamp()
      WHERE "scope"=$1`,
    rollout.AUTH_HISTORY_PURGE_SCOPE,
    rollout.AUTH_HISTORY_PUBLISHER_GENERATION,
    state,
  );
}

async function restoreRelease(db, before) {
  if (!before) return;
  await db.$executeRawUnsafe(
    `UPDATE "Phase2ReleaseCompatibilityAuthority"
        SET "requiredGeneration"=$2,
            "activationState"=$3,
            "drainStartedAt"=$4,
            "activatedAt"=$5,
            "activationConfirmedAt"=$6,
            "updatedAt"=clock_timestamp()
      WHERE "scope"=$1`,
    rollout.AUTH_HISTORY_PURGE_SCOPE,
    before.requiredGeneration,
    before.activationState,
    before.drainStartedAt,
    before.activatedAt,
    before.activationConfirmedAt,
  );
}

async function seedUser(db, userId) {
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, passwordHash: "integration" } });
}

async function cleanup(db, userId, lineage) {
  try { await db.refreshSession.deleteMany({ where: { userId } }); } catch (_) {}
  try { await db.authorizationSessionBoundary.deleteMany({ where: { authorizationSessionId: lineage } }); } catch (_) {}
  try { await db.user.delete({ where: { id: userId } }); } catch (_) {}
}

test("Actual60 PostgreSQL rolling: DRAINING remains backward compatible with a tombstone-unaware lineaged publisher", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const before = await snapshotRelease(db);
  const userId = token("a60_roll_user");
  const lineage = token("a60_roll_lineage");
  try {
    await setReleaseState(db, "DRAINING");
    await seedUser(db, userId);
    const row = await db.refreshSession.create({
      data: {
        userId, agencyId: "roll-agency", tokenHash: token("hash"), expiresAt: new Date(Date.now() + 60_000),
        deviceId: "device-a", authorizationSessionId: lineage,
      },
    });
    assert.equal(row.authorizationSessionId, lineage);
  } finally {
    await cleanup(db, userId, lineage);
    await restoreRelease(db, before);
    await db.$disconnect();
  }
});

test("Actual60 PostgreSQL rolling: ACTIVE physically fences an old publisher and admits the current generation marker", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const before = await snapshotRelease(db);
  const userId = token("a60_fence_user");
  const oldLineage = token("a60_old_lineage");
  const newLineage = token("a60_new_lineage");
  try {
    await setReleaseState(db, "ACTIVE");
    await seedUser(db, userId);
    await assert.rejects(
      () => db.refreshSession.create({
        data: { userId, agencyId: "roll-agency", tokenHash: token("oldhash"), expiresAt: new Date(Date.now() + 60_000), deviceId: "device-a", authorizationSessionId: oldLineage },
      }),
      (error) => String(error?.message || error).includes("ACTUAL60_INCOMPATIBLE_AUTH_HISTORY_PUBLISHER"),
    );

    await db.$transaction(async (tx) => {
      await rollout.authorizeAuthorizationHistoryPublisher(tx);
      await tx.refreshSession.create({
        data: { userId, agencyId: "roll-agency", tokenHash: token("newhash"), expiresAt: new Date(Date.now() + 60_000), deviceId: "device-a", authorizationSessionId: newLineage },
      });
    });
    const current = await db.refreshSession.findFirst({ where: { userId, authorizationSessionId: newLineage } });
    assert.ok(current);
  } finally {
    await cleanup(db, userId, oldLineage);
    await cleanup(db, userId, newLineage);
    await restoreRelease(db, before);
    await db.$disconnect();
  }
});

test("Actual60 PostgreSQL rolling: after raw history is compacted, ACTIVE still fences a tombstone-unaware reused incarnation publisher", { skip: !enabled }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const before = await snapshotRelease(db);
  const userId = token("a60_tomb_user");
  const lineage = token("a60_tomb_lineage");
  try {
    await setReleaseState(db, "ACTIVE");
    await seedUser(db, userId);
    await db.authorizationSessionBoundary.create({
      data: { authorizationSessionId: lineage, userId, agencyId: "roll-agency", deviceId: "device-a", endedAt: new Date(Date.now() - 60_000) },
    });
    assert.equal(await db.refreshSession.count({ where: { authorizationSessionId: lineage } }), 0);
    await assert.rejects(
      () => db.refreshSession.create({
        data: { userId, agencyId: "roll-agency", tokenHash: token("reusehash"), expiresAt: new Date(Date.now() + 60_000), deviceId: "device-a", authorizationSessionId: lineage },
      }),
      (error) => String(error?.message || error).includes("ACTUAL60_INCOMPATIBLE_AUTH_HISTORY_PUBLISHER"),
    );
  } finally {
    await cleanup(db, userId, lineage);
    await restoreRelease(db, before);
    await db.$disconnect();
  }
});
