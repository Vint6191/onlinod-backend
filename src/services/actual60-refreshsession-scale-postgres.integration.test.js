"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_ACTUAL60_REFRESHSESSION_SCALE_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function collectIndexNames(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node["Index Name"] === "string") out.push(node["Index Name"]);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => collectIndexNames(item, out));
    else if (value && typeof value === "object") collectIndexNames(value, out);
  }
  return out;
}

function collectPlanNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node["Node Type"] === "string") out.push(node);
  const plans = Array.isArray(node.Plans) ? node.Plans : [];
  for (const plan of plans) collectPlanNodes(plan, out);
  return out;
}

function assertBoundedLookupPlan(plan, label, { maxRowsRemoved = 4, maxBufferBlocks = 64, maxReturned = 2 } = {}) {
  assert.ok(plan, `${label} must return an EXPLAIN plan`);
  const nodes = collectPlanNodes(plan);
  const refreshNodes = nodes.filter((node) => String(node["Relation Name"] || "") === "RefreshSession");
  assert.ok(refreshNodes.length > 0, `${label} must touch RefreshSession`);
  assert.equal(
    refreshNodes.some((node) => String(node["Node Type"] || "").includes("Seq Scan")),
    false,
    `${label} must not sequential-scan RefreshSession: ${JSON.stringify(refreshNodes)}`,
  );
  const removed = refreshNodes.reduce((sum, node) => sum + Number(node["Rows Removed by Filter"] || 0), 0);
  assert.ok(removed <= maxRowsRemoved, `${label} examined too many non-matching rows removed=${removed}`);
  const returned = refreshNodes.reduce((sum, node) => sum + Number(node["Actual Rows"] || 0) * Number(node["Actual Loops"] || 1), 0);
  assert.ok(returned <= maxReturned, `${label} returned too many RefreshSession rows returned=${returned} max=${maxReturned}`);
  const bufferBlocks = refreshNodes.reduce((sum, node) => sum
    + Number(node["Shared Hit Blocks"] || 0)
    + Number(node["Shared Read Blocks"] || 0)
    + Number(node["Shared Dirtied Blocks"] || 0)
    + Number(node["Shared Written Blocks"] || 0), 0);
  assert.ok(bufferBlocks <= maxBufferBlocks, `${label} touched too many RefreshSession buffer blocks=${bufferBlocks}`);
}

async function explainJson(db, sql, ...params) {
  const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ...params);
  const payload = rows?.[0]?.["QUERY PLAN"];
  return Array.isArray(payload) ? payload[0]?.Plan : null;
}

test("Actual60 PostgreSQL scale: large rotation history stays off live authorization lookup and terminal expiry uses ordered history index", { skip: !enabled, timeout: 180_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const userId = token("a60_hist_user");
  const agencyId = token("a60_hist_agency");
  const deviceId = token("a60_hist_device");
  const lineage = token("a60_hist_lineage");
  const historyRows = Math.max(1000, Math.min(50_000, Number(process.env.ONLINOD_ACTUAL60_REFRESHSESSION_HISTORY_ROWS || 10_000)));
  const expiredUnrevokedRows = Math.max(500, Math.min(20_000, Number(process.env.ONLINOD_ACTUAL60_REFRESHSESSION_EXPIRED_UNREVOKED_ROWS || 5_000)));
  try {
    await db.user.create({ data: {
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "integration",
      emailVerifiedAt: new Date(),
    } });

    const base = Date.now() - historyRows * 60_000;
    const batch = [];
    for (let i = 0; i < historyRows; i += 1) {
      batch.push({
        id: token(`a60_hist_${i}`),
        userId,
        agencyId,
        tokenHash: token(`a60_hash_${i}`),
        deviceId,
        authorizationSessionId: lineage,
        rememberDevice: true,
        createdAt: new Date(base + i * 60_000),
        expiresAt: new Date(base + (i + 1) * 60_000),
        revokedAt: new Date(base + (i + 1) * 60_000 - 500),
      });
      if (batch.length === 500) {
        await db.refreshSession.createMany({ data: batch });
        batch.length = 0;
      }
    }
    if (batch.length) await db.refreshSession.createMany({ data: batch });

    const expiredBatch = [];
    for (let i = 0; i < expiredUnrevokedRows; i += 1) {
      expiredBatch.push({
        id: token(`a60_expired_${i}`),
        userId,
        agencyId,
        tokenHash: token(`a60_expired_hash_${i}`),
        deviceId: token(`a60_expired_device_${i}`),
        authorizationSessionId: token(`a60_expired_lineage_${i}`),
        rememberDevice: true,
        createdAt: new Date(base - (i + 2) * 60_000),
        expiresAt: new Date(base - (i + 1) * 60_000),
        revokedAt: null,
      });
      if (expiredBatch.length === 500) {
        await db.refreshSession.createMany({ data: expiredBatch });
        expiredBatch.length = 0;
      }
    }
    if (expiredBatch.length) await db.refreshSession.createMany({ data: expiredBatch });

    await db.refreshSession.create({ data: {
      id: token("a60_live"),
      userId,
      agencyId,
      tokenHash: token("a60_live_hash"),
      deviceId,
      authorizationSessionId: lineage,
      rememberDevice: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    await db.$executeRawUnsafe(`ANALYZE "RefreshSession"`);

    const livePlan = await explainJson(db,
      `SELECT "id", "authorizationSessionId"
         FROM "RefreshSession"
        WHERE "userId"=$1
          AND "agencyId"=$2
          AND "deviceId"=$3
          AND "authorizationSessionId"=$4
          AND "revokedAt" IS NULL
          AND "expiresAt" > clock_timestamp()
        LIMIT 1`,
      userId, agencyId, deviceId, lineage,
    );
    const liveIndexes = collectIndexNames(livePlan);
    assert.ok(
      liveIndexes.includes("RefreshSession_live_lineage_lookup_idx")
        || liveIndexes.includes("RefreshSession_live_authorization_lookup_idx"),
      `live authorization plan must use a partial current-state index; got ${JSON.stringify(liveIndexes)}`,
    );
    assertBoundedLookupPlan(livePlan, "live authorization");

    const legacyDeviceId = token("a60_legacy_device");
    await db.refreshSession.create({ data: {
      id: token("a60_legacy_live"),
      userId,
      agencyId,
      tokenHash: token("a60_legacy_hash"),
      deviceId: legacyDeviceId,
      authorizationSessionId: null,
      rememberDevice: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    await db.$executeRawUnsafe(`ANALYZE "RefreshSession"`);
    const legacyPlan = await explainJson(db,
      `SELECT "id"
         FROM "RefreshSession"
        WHERE "userId"=$1
          AND "agencyId"=$2
          AND "deviceId"=$3
          AND "authorizationSessionId" IS NULL
          AND "revokedAt" IS NULL
          AND "expiresAt" > clock_timestamp()
        LIMIT 1`,
      userId, agencyId, legacyDeviceId,
    );
    const legacyIndexes = collectIndexNames(legacyPlan);
    assert.ok(legacyIndexes.includes("RefreshSession_live_authorization_lookup_idx"),
      `legacy current-device lookup must use device-first partial live index; got ${JSON.stringify(legacyIndexes)}`);
    assertBoundedLookupPlan(legacyPlan, "legacy current-device");

    const userLivePlan = await explainJson(db,
      `SELECT "id", "deviceId", "authorizationSessionId", "expiresAt", "lastUsedAt", "createdAt"
         FROM "RefreshSession"
        WHERE "userId"=$1
          AND "revokedAt" IS NULL
          AND "expiresAt" > clock_timestamp()
        ORDER BY "lastUsedAt" DESC NULLS LAST, "createdAt" DESC`,
      userId,
    );
    const userLiveIndexes = collectIndexNames(userLivePlan);
    assert.ok(userLiveIndexes.includes("RefreshSession_live_user_lookup_idx"),
      `current user session listing must use user-live partial index; got ${JSON.stringify(userLiveIndexes)}`);
    assertBoundedLookupPlan(userLivePlan, "current user session listing", { maxRowsRemoved: 8 });

    const agencyLivePlan = await explainJson(db,
      `SELECT "id"
         FROM "RefreshSession"
        WHERE "agencyId"=$1
          AND "revokedAt" IS NULL
          AND "expiresAt" > clock_timestamp()
        ORDER BY "expiresAt" DESC
        LIMIT 100`,
      agencyId,
    );
    const agencyLiveIndexes = collectIndexNames(agencyLivePlan);
    assert.ok(agencyLiveIndexes.includes("RefreshSession_live_agency_lookup_idx"),
      `agency-wide current lifecycle lookup must use agency-live partial index; got ${JSON.stringify(agencyLiveIndexes)}`);
    assertBoundedLookupPlan(agencyLivePlan, "agency current lifecycle", { maxRowsRemoved: 8, maxReturned: 8 });

    const userHistoryPlan = await explainJson(db,
      `SELECT "id", "createdAt"
         FROM "RefreshSession"
        WHERE "userId"=$1
        ORDER BY "createdAt" DESC
        LIMIT 30`,
      userId,
    );
    const userHistoryIndexes = collectIndexNames(userHistoryPlan);
    assert.ok(userHistoryIndexes.includes("RefreshSession_user_history_created_idx"),
      `user session history must use ordered user-history index; got ${JSON.stringify(userHistoryIndexes)}`);
    assertBoundedLookupPlan(userHistoryPlan, "user session history", { maxRowsRemoved: 4, maxBufferBlocks: 96, maxReturned: 30 });

    const historyPlan = await explainJson(db,
      `SELECT r."expiresAt"
         FROM "RefreshSession" r
        WHERE r."authorizationSessionId"=$1
          AND r."agencyId"=$2
          AND r."userId"=$3
        ORDER BY r."expiresAt" DESC
        LIMIT 1`,
      lineage, agencyId, userId,
    );
    const historyIndexes = collectIndexNames(historyPlan);
    assert.ok(historyIndexes.includes("RefreshSession_authorization_history_idx"),
      `terminal history plan must use ordered lineage history index; got ${JSON.stringify(historyIndexes)}`);
    assertBoundedLookupPlan(historyPlan, "terminal lineage history");

    const retentionPlan = await explainJson(db,
      `SELECT r."id", r."authorizationSessionId"
         FROM "RefreshSession" r
        WHERE r."expiresAt" < $1
        ORDER BY r."expiresAt" ASC, r."id" ASC
        LIMIT 2000`,
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    const retentionIndexes = collectIndexNames(retentionPlan);
    assert.ok(retentionIndexes.includes("RefreshSession_expiresAt_idx"),
      `retention candidate scan must use the expiry index rather than raw history scan; got ${JSON.stringify(retentionIndexes)}`);
    assertBoundedLookupPlan(retentionPlan, "retention expiry candidate scan", { maxRowsRemoved: 4, maxBufferBlocks: 512, maxReturned: 2000 });

    console.log(`# ACTUAL60_REFRESHSESSION_SCALE historyRows=${historyRows} expiredUnrevokedRows=${expiredUnrevokedRows} liveIndexes=${liveIndexes.join(",")} legacyIndexes=${legacyIndexes.join(",")} userLiveIndexes=${userLiveIndexes.join(",")} agencyLiveIndexes=${agencyLiveIndexes.join(",")} userHistoryIndexes=${userHistoryIndexes.join(",")} historyIndexes=${historyIndexes.join(",")} retentionIndexes=${retentionIndexes.join(",")}`);
  } finally {
    try { await db.user.delete({ where: { id: userId } }); } catch (_) {}
    await db.$disconnect();
  }
});
