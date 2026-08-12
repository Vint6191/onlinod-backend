"use strict";

const prisma = require("../prisma");

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

async function repairStaleLegacyBootstrapPending({ agencyId, allowedCreatorIds = null, now = new Date(), db = prisma } = {}) {
  if (!db.teamPendingDialogState?.findMany || !db.teamPendingDialogState?.updateMany || !db.teamActivityEvent?.findMany) {
    return { scanned: 0, cleared: 0 };
  }
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const cutoff = new Date(nowDate.getTime() - LEGACY_BOOTSTRAP_MAX_AGE_MS);
  const candidates = await db.teamPendingDialogState.findMany({
    where: {
      agencyId,
      status: "PENDING",
      lastIncomingAt: { lte: cutoff },
      ...creatorScopeWhere(allowedCreatorIds),
    },
    select: { id: true, lastIncomingEventId: true, lastIncomingAt: true },
    orderBy: [{ lastIncomingAt: "asc" }, { id: "asc" }],
    take: 1000,
  });
  const eventIds = Array.from(new Set((candidates || []).map((row) => clean(row?.lastIncomingEventId, 220)).filter(Boolean)));
  if (!eventIds.length) return { scanned: (candidates || []).length, cleared: 0 };
  const events = await db.teamActivityEvent.findMany({
    where: { agencyId, id: { in: eventIds } },
    select: { id: true, ts: true, extra: true },
  });
  const byId = new Map((events || []).map((event) => [event.id, event]));
  const staleIds = [];
  for (const row of candidates || []) {
    const eventId = clean(row?.lastIncomingEventId, 220);
    const event = eventId ? byId.get(eventId) : null;
    if (!event || extraSourceDetail(event) !== LEGACY_BOOTSTRAP_SOURCE) continue;
    const eventAt = new Date(event.ts || row?.lastIncomingAt || 0);
    if (!Number.isFinite(eventAt.getTime()) || eventAt > cutoff) continue;
    staleIds.push(row.id);
  }
  if (!staleIds.length) return { scanned: (candidates || []).length, cleared: 0 };
  const result = await db.teamPendingDialogState.updateMany({
    where: { agencyId, id: { in: staleIds }, status: "PENDING" },
    data: { status: "CLEAR", derivationVersion: "team_pending_v1_legacy_bootstrap_repaired" },
  });
  return { scanned: (candidates || []).length, cleared: Number(result?.count || staleIds.length) };
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

  const [creators, fans, followBack, followAutomation] = await Promise.all([
    creatorIds.length && db.creatorAccount?.findMany
      ? db.creatorAccount.findMany({ where: { agencyId, id: { in: creatorIds }, deletedAt: null }, select: { id: true, displayName: true, username: true, avatarUrl: true } })
      : Promise.resolve([]),
    pairs.length && db.creatorFan?.findMany
      ? db.creatorFan.findMany({ where: { agencyId, OR: pairs.map((pair) => ({ creatorId: pair.creatorId, onlyFansUserId: pair.fanId })) }, select: { creatorId: true, onlyFansUserId: true, username: true, displayName: true } })
      : Promise.resolve([]),
    pairs.length && db.followBackCandidate?.findMany
      ? db.followBackCandidate.findMany({ where: { agencyId, OR: pairs.map((pair) => ({ creatorId: pair.creatorId, fanId: pair.fanId })) }, select: { creatorId: true, fanId: true, username: true, displayName: true, avatarUrl: true, updatedAt: true } })
      : Promise.resolve([]),
    pairs.length && db.followAutomationCandidate?.findMany
      ? db.followAutomationCandidate.findMany({ where: { agencyId, OR: pairs.map((pair) => ({ creatorId: pair.creatorId, fanId: pair.fanId })) }, select: { creatorId: true, fanId: true, username: true, displayName: true, avatarUrl: true, updatedAt: true } })
      : Promise.resolve([]),
  ]);

  const creatorMap = new Map((creators || []).map((row) => [row.id, row]));
  const fanMap = new Map();
  for (const fan of fans || []) {
    fanMap.set(pairKey(fan.creatorId, fan.onlyFansUserId), {
      displayName: clean(fan.displayName, 240),
      username: clean(fan.username, 160)?.replace(/^@+/, "") || null,
      avatarUrl: null,
      updatedAt: 0,
    });
  }
  for (const candidate of [...(followBack || []), ...(followAutomation || [])]) {
    const key = pairKey(candidate.creatorId, candidate.fanId);
    const current = fanMap.get(key) || { displayName: null, username: null, avatarUrl: null, updatedAt: 0 };
    const updatedAt = new Date(candidate.updatedAt || 0).getTime() || 0;
    fanMap.set(key, {
      displayName: current.displayName || clean(candidate.displayName, 240),
      username: current.username || clean(candidate.username, 160)?.replace(/^@+/, "") || null,
      avatarUrl: (updatedAt >= Number(current.updatedAt || 0) ? clean(candidate.avatarUrl, 2000) : current.avatarUrl) || current.avatarUrl || clean(candidate.avatarUrl, 2000),
      updatedAt: Math.max(Number(current.updatedAt || 0), updatedAt),
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
  const where = {
    agencyId,
    status: "PENDING",
    ...creatorScopeWhere(allowedCreatorIds),
    ...(normalizedMemberId ? { ownerMemberId: normalizedMemberId } : {}),
    ...(!normalizedMemberId && normalizedOwnership === "unassigned" ? { ownerMemberId: null } : {}),
  };
  await repairStaleLegacyBootstrapPending({ agencyId, allowedCreatorIds, now, db });
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
      fanDisplayName: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.displayName || null,
      fanUsername: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.username || null,
      fanAvatarUrl: identities.fanMap.get(pairKey(row.creatorId, row.fanId || row.dialogId))?.avatarUrl || null,
      derivationVersion: row.derivationVersion,
    })),
  };
}

module.exports = {
  creatorScopeWhere,
  secondsSince,
  summarizePendingRows,
  summarizePendingWhere,
  listTeamPendingDialogs,
  repairStaleLegacyBootstrapPending,
  pendingIdentityMaps,
};
