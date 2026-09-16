"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_ACTUAL60_REFRESHSESSION_RETENTION_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

test("Actual60 PostgreSQL retention: old raw rotations compact into durable lineage boundary before purge", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { purgeRefreshSessionHistoryBatch } = require("./retention-service");
  const db = new PrismaClient();
  const userId = token("a60_ret_user");
  const agencyId = token("a60_ret_agency");
  const deviceId = token("a60_ret_device");
  const lineage = token("a60_ret_lineage");
  const now = new Date();
  const oldExpiry = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const recentExpiry = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oldLineagedId = token("a60_ret_old_lineaged");
  const oldLegacyId = token("a60_ret_old_legacy");
  const recentId = token("a60_ret_recent");
  const sameLineageRecentId = token("a60_ret_same_lineage_recent");
  const activeLineage = token("a60_ret_active_lineage");
  const activeOldId = token("a60_ret_active_old");
  const activeFutureId = token("a60_ret_active_future");
  const futureExpiry = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

  try {
    await db.user.create({ data: {
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "integration",
      emailVerifiedAt: now,
    } });
    await db.refreshSession.createMany({ data: [
      {
        id: oldLineagedId, userId, agencyId, deviceId,
        tokenHash: token("a60_ret_hash_lineaged"), authorizationSessionId: lineage,
        rememberDevice: true, createdAt: new Date(oldExpiry.getTime() - 1000),
        expiresAt: oldExpiry, revokedAt: new Date(oldExpiry.getTime() - 500),
      },
      {
        id: oldLegacyId, userId, agencyId, deviceId,
        tokenHash: token("a60_ret_hash_legacy"), authorizationSessionId: null,
        rememberDevice: true, createdAt: new Date(oldExpiry.getTime() - 1000),
        expiresAt: oldExpiry, revokedAt: new Date(oldExpiry.getTime() - 500),
      },
      {
        id: recentId, userId, agencyId, deviceId,
        tokenHash: token("a60_ret_hash_recent"), authorizationSessionId: token("a60_ret_recent_lineage"),
        rememberDevice: true, createdAt: new Date(recentExpiry.getTime() - 1000),
        expiresAt: recentExpiry, revokedAt: new Date(recentExpiry.getTime() - 500),
      },
      {
        id: sameLineageRecentId, userId, agencyId, deviceId,
        tokenHash: token("a60_ret_hash_same_lineage_recent"), authorizationSessionId: lineage,
        rememberDevice: true, createdAt: new Date(recentExpiry.getTime() - 1000),
        expiresAt: recentExpiry, revokedAt: new Date(recentExpiry.getTime() - 500),
      },
      {
        id: activeOldId, userId, agencyId, deviceId,
        tokenHash: token("a60_ret_hash_active_old"), authorizationSessionId: activeLineage,
        rememberDevice: true, createdAt: new Date(oldExpiry.getTime() - 1000),
        expiresAt: oldExpiry, revokedAt: new Date(oldExpiry.getTime() - 500),
      },
      {
        id: activeFutureId, userId, agencyId, deviceId,
        tokenHash: token("a60_ret_hash_active_future"), authorizationSessionId: activeLineage,
        rememberDevice: true, createdAt: now,
        expiresAt: futureExpiry, revokedAt: null,
      },
    ] });

    const result = await purgeRefreshSessionHistoryBatch({ db, cutoff, batchSize: 100 });
    assert.ok(result.deleted >= 2, `expected at least the two old fixture rows to purge, got ${result.deleted}`);

    const [oldLineaged, oldLegacy, recent, sameLineageRecent, activeOld, activeFuture, boundary, activeBoundary] = await Promise.all([
      db.refreshSession.findUnique({ where: { id: oldLineagedId } }),
      db.refreshSession.findUnique({ where: { id: oldLegacyId } }),
      db.refreshSession.findUnique({ where: { id: recentId } }),
      db.refreshSession.findUnique({ where: { id: sameLineageRecentId } }),
      db.refreshSession.findUnique({ where: { id: activeOldId } }),
      db.refreshSession.findUnique({ where: { id: activeFutureId } }),
      db.authorizationSessionBoundary.findUnique({ where: { authorizationSessionId: lineage } }),
      db.authorizationSessionBoundary.findUnique({ where: { authorizationSessionId: activeLineage } }),
    ]);
    assert.equal(oldLineaged, null, "expired lineaged raw rotation must be purged after retention horizon");
    assert.equal(oldLegacy, null, "expired legacy raw token must be purgeable after reuse/security horizon");
    assert.ok(recent, "recent expired raw token must remain inside retention horizon");
    assert.ok(sameLineageRecent, "recent expired row in the same lineage must remain inside retention horizon");
    assert.equal(activeOld, null, "old rotation of an otherwise-active lineage may be purged after its security horizon");
    assert.ok(activeFuture, "future/live row of active lineage must remain");
    assert.equal(activeBoundary, null, "active lineage must not be terminalized merely because one old rotation was purged");
    assert.ok(boundary, "lineaged raw purge must leave compact durable terminal identity");
    assert.equal(boundary.userId, userId);
    assert.equal(boundary.agencyId, agencyId);
    assert.equal(boundary.deviceId, deviceId);
    assert.equal(new Date(boundary.endedAt).getTime(), recentExpiry.getTime(), "natural-expiry compaction must preserve the latest authoritative expiry across the whole lineage, not just purge candidates");
  } finally {
    try { await db.refreshSession.deleteMany({ where: { userId } }); } catch (_) {}
    try { await db.authorizationSessionBoundary.deleteMany({ where: { userId } }); } catch (_) {}
    try { await db.user.delete({ where: { id: userId } }); } catch (_) {}
    await db.$disconnect();
  }
});

test("Actual60 PostgreSQL retention: configured max-batches cannot reduce catch-up below the source drain floor", { skip: !enabled, timeout: 120_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const { runRefreshSessionRetentionSweep } = require("./retention-service");
  const db = new PrismaClient();
  const userId = token("a60_ret_floor_user");
  const agencyId = token("a60_ret_floor_agency");
  const deviceId = token("a60_ret_floor_device");
  const now = new Date();
  const oldExpiry = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const previousMaxBatches = process.env.ONLINOD_REFRESH_SESSION_RETENTION_MAX_BATCHES;

  try {
    await db.user.create({ data: {
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "integration",
      emailVerifiedAt: now,
    } });
    const rows = Array.from({ length: 250 }, (_, index) => ({
      id: token(`a60_ret_floor_${index}`),
      userId,
      agencyId,
      deviceId,
      tokenHash: token(`a60_ret_floor_hash_${index}`),
      authorizationSessionId: null,
      rememberDevice: true,
      createdAt: new Date(oldExpiry.getTime() - 1000 - index),
      expiresAt: oldExpiry,
      revokedAt: new Date(oldExpiry.getTime() - 500),
    }));
    await db.refreshSession.createMany({ data: rows });

    process.env.ONLINOD_REFRESH_SESSION_RETENTION_MAX_BATCHES = "1";
    const result = await runRefreshSessionRetentionSweep({
      db,
      now,
      batchSize: 100,
      refreshSessionRawHistoryDays: 30,
    });
    const item = result.items?.[0] || {};
    assert.equal(result.totalDeleted, 250);
    assert.equal(item.maxBatches, 100, "unsafe operator override must be raised to the non-bypassable drain floor");
    assert.equal(item.workBudgetRows, 10_000);
    assert.equal(item.hasMore, false);
    assert.equal(await db.refreshSession.count({ where: { userId } }), 0);
  } finally {
    if (previousMaxBatches === undefined) delete process.env.ONLINOD_REFRESH_SESSION_RETENTION_MAX_BATCHES;
    else process.env.ONLINOD_REFRESH_SESSION_RETENTION_MAX_BATCHES = previousMaxBatches;
    try { await db.refreshSession.deleteMany({ where: { userId } }); } catch (_) {}
    try { await db.authorizationSessionBoundary.deleteMany({ where: { userId } }); } catch (_) {}
    try { await db.user.delete({ where: { id: userId } }); } catch (_) {}
    await db.$disconnect();
  }
});
