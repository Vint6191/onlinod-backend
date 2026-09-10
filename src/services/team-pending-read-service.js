"use strict";

const prisma = require("../prisma");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { phase2CoverageStatus, FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION } = require("./phase2-work-coverage-authority-service");

const CURRENT_PENDING_DERIVATION_VERSION = "team_pending_v2";

const LEGACY_BOOTSTRAP_SOURCE = "crm_pending_bootstrap_v1";
const LEGACY_BOOTSTRAP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function clean(value, max = 180) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function clampLimit(value, fallback = 100) {
  const n = Number(value);
  return Math.max(1, Math.min(500, Number.isFinite(n) ? Math.floor(n) : fallback));
}

function creatorScopeWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const ids = Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}


function extraSourceDetail(row) {
  const extra = row?.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra : {};
  return clean(extra.sourceDetail, 120);
}

function pairKey(creatorId, fanId) {
  return `${clean(creatorId, 160) || ""}\u0000${clean(fanId, 160) || ""}`;
}

async function repairStaleLegacyBootstrapPendingBatch({ db = prisma, limit = 500, fallbackNow = new Date() } = {}) {
  if (typeof db?.$transaction !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    return { skipped: true, reason: "postgres_maintenance_client_required", selected: 0, cleared: 0, complete: false };
  }
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
  return runDbTransaction(db, async (tx) => {
    if (typeof tx?.$queryRawUnsafe !== "function") {
      return { skipped: true, reason: "postgres_maintenance_client_required", selected: 0, cleared: 0, complete: false };
    }
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow });
    const cutoff = new Date(authorityNow.getTime() - LEGACY_BOOTSTRAP_MAX_AGE_MS);
    const rows = await tx.$queryRawUnsafe(`
      SELECT p."id"
      FROM "TeamPendingDialogStateCurrent" p
      JOIN "TeamActivityEvent" e
        ON e."id" = p."lastIncomingEventId"
       AND e."agencyId" = p."agencyId"
      WHERE p."status" = 'PENDING'
        AND p."lastIncomingAt" <= $1
        AND (e."extra"->>'sourceDetail') = $2
      ORDER BY p."lastIncomingAt" ASC, p."id" ASC
      LIMIT $3
      FOR UPDATE OF p SKIP LOCKED
    `, cutoff, LEGACY_BOOTSTRAP_SOURCE, safeLimit);
    const ids = (rows || []).map((row) => clean(row?.id, 220)).filter(Boolean);
    let cleared = 0;
    if (ids.length) {
      const updated = await tx.teamPendingDialogState.updateMany({
        where: { id: { in: ids }, status: "PENDING" },
        data: { status: "CLEAR", derivationVersion: "team_pending_v1_legacy_bootstrap_repaired" },
      });
      cleared = Number(updated?.count || ids.length);
    }

    // Completion is durable only when no legacy bootstrap source remains. If a
    // recent legacy row still exists, park the lane until that exact row reaches
    // the 30-day repair boundary instead of rescanning history every hour.
    const remaining = await tx.$queryRawUnsafe(`
      SELECT MIN(p."lastIncomingAt") AS "oldestPendingAt", COUNT(*)::bigint AS "remainingCount"
      FROM "TeamPendingDialogStateCurrent" p
      JOIN "TeamActivityEvent" e
        ON e."id" = p."lastIncomingEventId"
       AND e."agencyId" = p."agencyId"
      WHERE p."status" = 'PENDING'
        AND (e."extra"->>'sourceDetail') = $1
    `, LEGACY_BOOTSTRAP_SOURCE);
    const summary = Array.isArray(remaining) ? remaining[0] : remaining;
    const remainingCount = Number(summary?.remainingCount || summary?.remainingcount || 0);
    const oldestPendingAt = summary?.oldestPendingAt || summary?.oldestpendingat;
    const oldest = oldestPendingAt ? new Date(oldestPendingAt) : null;
    const nextRunAt = remainingCount > 0 && oldest && Number.isFinite(oldest.getTime()) && oldest > cutoff
      ? new Date(oldest.getTime() + LEGACY_BOOTSTRAP_MAX_AGE_MS)
      : null;
    return {
      skipped: false,
      selected: ids.length,
      cleared,
      remaining: remainingCount,
      complete: remainingCount === 0,
      nextRunAt,
      outcome: remainingCount === 0 ? "LEGACY_PENDING_REPAIR_COMPLETE" : "LEGACY_PENDING_REPAIR_BATCH",
      progress: { selected: ids.length, cleared, remaining: remainingCount },
    };
  }, { timeout: 30_000 });
}

async function pendingIdentityMaps({ agencyId, rows, db = prisma }) {
  const creatorIds = Array.from(new Set((rows || []).map((row) => clean(row?.creatorId, 160)).filter(Boolean)));
  const pairs = [];
  const seenPairs = new Set();
  for (const row of rows || []) {
    const creatorId = clean(row?.creatorId, 160);
    const fanId = clean(row?.fanId || row?.dialogId, 160);
    const key = pairKey(creatorId, fanId);
    if (!creatorId || !fanId || seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairs.push({ creatorId, fanId });
  }

  const [creators, fans] = await Promise.all([
    creatorIds.length && db.creatorAccount?.findMany
      ? db.creatorAccount.findMany({ where: { agencyId, id: { in: creatorIds }, deletedAt: null }, select: { id: true, displayName: true, username: true, avatarUrl: true } })
      : Promise.resolve([]),
    pairs.length && db.creatorFan?.findMany
      ? db.creatorFan.findMany({
        where: { agencyId, OR: pairs.map((pair) => ({ creatorId: pair.creatorId, onlyFansUserId: pair.fanId })) },
        select: {
          creatorId: true,
          onlyFansUserId: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          identityObservedAt: true,
          identitySource: true,
          relationshipCurrent: true,
          valueCurrent: true,
        },
      })
      : Promise.resolve([]),
  ]);

  const creatorMap = new Map((creators || []).map((row) => [row.id, row]));
  const fanMap = new Map();
  for (const fan of fans || []) {
    fanMap.set(pairKey(fan.creatorId, fan.onlyFansUserId), {
      onlyFansUserId: clean(fan.onlyFansUserId, 180),
      displayName: clean(fan.displayName, 240),
      username: clean(fan.username, 160)?.replace(/^@+/, '') || null,
      avatarUrl: clean(fan.avatarUrl, 2000),
      observedAt: fan.identityObservedAt || null,
      source: clean(fan.identitySource, 80),
      relationship: fan.relationshipCurrent ? {
        fanSubscribesToCreator: fan.relationshipCurrent.fanSubscribesToCreator ?? null,
        fanSubscriptionActive: fan.relationshipCurrent.fanSubscriptionActive ?? null,
        fanSubscriptionType: clean(fan.relationshipCurrent.fanSubscriptionType, 100),
        fanSubscriptionExpiresAt: fan.relationshipCurrent.fanSubscriptionExpiresAt || null,
        creatorFollowsFan: fan.relationshipCurrent.creatorFollowsFan ?? null,
        creatorFollowExpiresAt: fan.relationshipCurrent.creatorFollowExpiresAt || null,
        canReceiveChatMessage: fan.relationshipCurrent.canReceiveChatMessage ?? null,
        blocked: fan.relationshipCurrent.blocked ?? null,
        restricted: fan.relationshipCurrent.restricted ?? null,
        performer: fan.relationshipCurrent.performer ?? null,
        lastSeenAt: fan.relationshipCurrent.lastSeenAt || null,
        subscribePriceCents: fan.relationshipCurrent.subscribePriceCents ?? null,
        observedAt: fan.relationshipCurrent.observedAt || null,
        source: clean(fan.relationshipCurrent.source, 80),
      } : null,
      value: fan.valueCurrent ? {
        platformReportedTotalSpendCents: fan.valueCurrent.platformReportedTotalSpendCents == null ? null : Number(fan.valueCurrent.platformReportedTotalSpendCents),
        messagesSpentCents: fan.valueCurrent.messagesSpentCents == null ? null : Number(fan.valueCurrent.messagesSpentCents),
        subscriptionsSpentCents: fan.valueCurrent.subscriptionsSpentCents == null ? null : Number(fan.valueCurrent.subscriptionsSpentCents),
        tipsSpentCents: fan.valueCurrent.tipsSpentCents == null ? null : Number(fan.valueCurrent.tipsSpentCents),
        postsSpentCents: fan.valueCurrent.postsSpentCents == null ? null : Number(fan.valueCurrent.postsSpentCents),
        streamsSpentCents: fan.valueCurrent.streamsSpentCents == null ? null : Number(fan.valueCurrent.streamsSpentCents),
        lastActivityAt: fan.valueCurrent.lastActivityAt || null,
        availability: clean(fan.valueCurrent.availability, 40),
        observedAt: fan.valueCurrent.valueObservedAt || null,
        source: clean(fan.valueCurrent.source, 80),
      } : null,
    });
  }
  return { creatorMap, fanMap };
}

function secondsSince(value, now) {
  if (!value) return null;
  const start = new Date(value).getTime();
  const end = now instanceof Date ? now.getTime() : new Date(now || Date.now()).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function summarizePendingRows(rows, { now = new Date() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let incomingMessages = 0;
  let unassignedDialogs = 0;
  let seenDialogs = 0;
  let olderThan15m = 0;
  let olderThan60m = 0;
  let oldestPendingSeconds = null;
  let oldestPendingAt = null;

  for (const row of list) {
    incomingMessages += Math.max(1, Number(row?.incomingCount || 1));
    if (row?.ownerMemberId) seenDialogs += 1;
    else unassignedDialogs += 1;
    const age = secondsSince(row?.firstIncomingAt, now);
    if (age !== null) {
      if (age >= 15 * 60) olderThan15m += 1;
      if (age >= 60 * 60) olderThan60m += 1;
      if (oldestPendingSeconds === null || age > oldestPendingSeconds) {
        oldestPendingSeconds = age;
        oldestPendingAt = row?.firstIncomingAt || null;
      }
    }
  }

  return {
    source: "team_pending_dialog_v1",
    pendingDialogs: list.length,
    pendingIncomingMessages: incomingMessages,
    unassignedDialogs,
    seenDialogs,
    olderThan15m,
    olderThan60m,
    oldestPendingAt,
    oldestPendingSeconds,
  };
}

async function summarizePendingWhere({ where, now = new Date(), db = prisma, fallbackRows = [] } = {}) {
  if (!db.teamPendingDialogState?.count || !db.teamPendingDialogState?.aggregate) {
    return summarizePendingRows(fallbackRows, { now });
  }
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const cutoff15m = new Date(nowDate.getTime() - 15 * 60 * 1000);
  const cutoff60m = new Date(nowDate.getTime() - 60 * 60 * 1000);
  const hasOwnerFilter = Object.prototype.hasOwnProperty.call(where || {}, "ownerMemberId");
  const ownerFilter = hasOwnerFilter ? where.ownerMemberId : undefined;
  const [pendingDialogs, aggregate, rawUnassignedDialogs, rawSeenDialogs, olderThan15m, olderThan60m] = await Promise.all([
    db.teamPendingDialogState.count({ where }),
    db.teamPendingDialogState.aggregate({ where, _sum: { incomingCount: true }, _min: { firstIncomingAt: true } }),
    hasOwnerFilter
      ? Promise.resolve(ownerFilter === null ? null : 0)
      : db.teamPendingDialogState.count({ where: { ...where, ownerMemberId: null } }),
    hasOwnerFilter
      ? Promise.resolve(ownerFilter === null ? 0 : null)
      : db.teamPendingDialogState.count({ where: { ...where, ownerMemberId: { not: null } } }),
    db.teamPendingDialogState.count({ where: { ...where, firstIncomingAt: { lte: cutoff15m } } }),
    db.teamPendingDialogState.count({ where: { ...where, firstIncomingAt: { lte: cutoff60m } } }),
  ]);
  // A member-specific read already constrains ownerMemberId. Do not override that
  // predicate while deriving seen/unassigned counters or a chatter card can show
  // a correct row list with team-wide summary counts. Reuse the exact pending
  // count for the known owner bucket instead.
  const unassignedDialogs = hasOwnerFilter
    ? (ownerFilter === null ? Number(pendingDialogs || 0) : 0)
    : Number(rawUnassignedDialogs || 0);
  const seenDialogs = hasOwnerFilter
    ? (ownerFilter === null ? 0 : Number(pendingDialogs || 0))
    : Number(rawSeenDialogs || 0);
  const oldestPendingAt = aggregate?._min?.firstIncomingAt || null;
  return {
    source: "team_pending_dialog_v1",
    pendingDialogs: Number(pendingDialogs || 0),
    pendingIncomingMessages: Number(aggregate?._sum?.incomingCount || 0),
    unassignedDialogs,
    seenDialogs,
    olderThan15m: Number(olderThan15m || 0),
    olderThan60m: Number(olderThan60m || 0),
    oldestPendingAt,
    oldestPendingSeconds: secondsSince(oldestPendingAt, nowDate),
  };
}

async function memberNamesForRows({ agencyId, rows, db = prisma }) {
  const ids = new Set();
  for (const row of rows || []) {
    for (const value of [row?.ownerMemberId, row?.firstSeenMemberId, row?.lastSeenMemberId, row?.repliedByMemberId]) {
      const id = clean(value, 160);
      if (id) ids.add(id);
    }
  }
  if (!ids.size || !db.agencyMember?.findMany) return new Map();
  const members = await db.agencyMember.findMany({
    where: { agencyId, id: { in: Array.from(ids) }, deletedAt: null },
    select: { id: true, displayName: true, user: { select: { name: true } } },
  });
  return new Map((members || []).map((member) => [member.id, member.displayName || member.user?.name || null]));
}

async function pendingProjectionAuthorityWhere({ agencyId, db = prisma } = {}) {
  try {
    const status = await phase2CoverageStatus({
      db, agencyId, family: PHASE2_COVERAGE_FAMILY.TEAM_DIALOG_PROJECTION,
      generation: PHASE2_COVERAGE_GENERATION.TEAM_DIALOG_PROJECTION,
    });
    if (!status?.ready) return {};
    return {
      derivationVersion: CURRENT_PENDING_DERIVATION_VERSION,
      projectionState: { in: ["FULL", "INCOMPLETE_HISTORY"] },
    };
  } catch (_) {
    // Coverage cannot be proven => preserve the pre-activation read contract.
    // Activation itself is the authority boundary; never infer it from binary version.
    return {};
  }
}

async function listTeamPendingDialogs({
  agencyId,
  allowedCreatorIds = null,
  memberId = null,
  ownership = "all",
  limit = 100,
  now = new Date(),
  db = prisma,
} = {}) {
  const normalizedMemberId = clean(memberId, 160);
  const normalizedOwnership = clean(ownership, 32)?.toLowerCase() || "all";
  const generationWhere = await pendingProjectionAuthorityWhere({ agencyId, db });
  const where = {
    agencyId,
    status: "PENDING",
    ...generationWhere,
    ...creatorScopeWhere(allowedCreatorIds),
    ...(normalizedMemberId ? { ownerMemberId: normalizedMemberId } : {}),
    ...(!normalizedMemberId && normalizedOwnership === "unassigned" ? { ownerMemberId: null } : {}),
  };
  const rows = await db.teamPendingDialogState.findMany({
    where,
    orderBy: [{ firstIncomingAt: "asc" }, { id: "asc" }],
    take: clampLimit(limit),
  });
  const [names, summary, identities] = await Promise.all([
    memberNamesForRows({ agencyId, rows, db }),
    summarizePendingWhere({ where, now, db, fallbackRows: rows }),
    pendingIdentityMaps({ agencyId, rows, db }),
  ]);
  return {
    ok: true,
    asOf: now,
    creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
    summary,
    rows: (rows || []).map((row) => ({
      id: row.id,
      creatorId: row.creatorId,
      dialogId: row.dialogId,
      fanId: row.fanId || null,
      status: row.status,
      episodeKey: row.episodeKey || null,
      firstIncomingMessageId: row.firstIncomingMessageId || null,
      lastIncomingMessageId: row.lastIncomingMessageId || null,
      firstIncomingAt: row.firstIncomingAt,
      lastIncomingAt: row.lastIncomingAt,
      incomingCount: Math.max(1, Number(row.incomingCount || 1)),
      firstSeenAt: row.firstSeenAt || null,
      firstSeenMemberId: row.firstSeenMemberId || null,
      firstSeenMemberName: names.get(row.firstSeenMemberId) || null,
      lastSeenAt: row.lastSeenAt || null,
      lastSeenMemberId: row.lastSeenMemberId || null,
      lastSeenMemberName: names.get(row.lastSeenMemberId) || null,
      ownerMemberId: row.ownerMemberId || null,
      ownerMemberName: names.get(row.ownerMemberId) || null,
      ownerAssignedAt: row.ownerAssignedAt || null,
      ownerReason: row.ownerReason || null,
      ageSeconds: secondsSince(row.firstIncomingAt, now),
      creatorDisplayName: identities.creatorMap.get(row.creatorId)?.displayName || null,
      creatorUsername: identities.creatorMap.get(row.creatorId)?.username || null,
      creatorAvatarUrl: identities.creatorMap.get(row.creatorId)?.avatarUrl || null,
      platformIdentity: (() => {
        const identity = identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId));
        return identity ? {
          onlyFansUserId: identity.onlyFansUserId || row.fanId || row.dialogId,
          username: identity.username || null,
          displayName: identity.displayName || null,
          avatarUrl: identity.avatarUrl || null,
          observedAt: identity.observedAt || null,
          source: identity.source || null,
        } : null;
      })(),
      relationship: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.relationship || null,
      value: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.value || null,
      fanDisplayName: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.displayName || null,
      fanUsername: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.username || null,
      fanAvatarUrl: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.avatarUrl || null,
      derivationVersion: row.derivationVersion,
    })),
  };
}

module.exports = {
  CURRENT_PENDING_DERIVATION_VERSION, pendingProjectionAuthorityWhere,
  creatorScopeWhere,
  secondsSince,
  summarizePendingRows,
  summarizePendingWhere,
  listTeamPendingDialogs,
  repairStaleLegacyBootstrapPendingBatch,
  pendingIdentityMaps,
};
