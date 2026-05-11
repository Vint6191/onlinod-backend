
"use strict";

const prisma = require("../prisma");

const SNAPSHOT_TTL_MS = Number(process.env.ONLINOD_PRESENCE_SNAPSHOT_TTL_MS) || 15 * 60 * 1000;

function toDate(value, fallback = new Date()) {
  if (value === null) return null;
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : fallback;
}

function cleanString(value, max = 512) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function fanIdOf(value) {
  const raw = cleanString(value, 80);
  return /^\d{3,30}$/.test(raw || "") ? raw : null;
}

function centsFrom(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) < 1000000 && !Number.isInteger(n)) return Math.round(n * 100);
  return Math.round(n);
}

function normalizePresenceUser(raw = {}) {
  const fanId = fanIdOf(raw.fanId || raw.id || raw.userId || raw.remoteId);
  if (!fanId) return null;

  const totalSpentCents = raw.totalSpentCents !== undefined
    ? centsFrom(raw.totalSpentCents)
    : centsFrom(raw.totalSpent ?? raw.total_spent ?? raw.totalSumm ?? 0);

  return {
    fanId,
    username: cleanString(raw.username, 160)?.replace(/^@/, "") || `u${fanId}`,
    name: cleanString(raw.name || raw.displayName || raw.username, 240) || `u${fanId}`,
    avatarUrl: cleanString(raw.avatarUrl || raw.avatar, 1200),
    totalSpentCents,
    subscribeAt: raw.subscribeAt || raw.subscribe_at ? toDate(raw.subscribeAt || raw.subscribe_at, null) : null,
    duration: cleanString(raw.duration, 80),
    metadata: raw.rawUser && typeof raw.rawUser === "object" ? { rawUser: raw.rawUser } : {},
  };
}

function serializeUser(row) {
  return {
    id: row.fanId,
    fanId: row.fanId,
    username: row.username,
    name: row.name,
    avatar: row.avatarUrl,
    avatarUrl: row.avatarUrl,
    totalSpent: Math.round(Number(row.totalSpentCents || 0)) / 100,
    totalSpentCents: row.totalSpentCents || 0,
    subscribeAt: row.subscribeAt,
    duration: row.duration,
    status: row.status,
    source: row.source,
    lastOnlineAt: row.lastOnlineAt ? row.lastOnlineAt.getTime() : null,
    lastOfflineAt: row.lastOfflineAt ? row.lastOfflineAt.getTime() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.getTime() : null,
    lastSnapshotAt: row.lastSnapshotAt ? row.lastSnapshotAt.getTime() : null,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : null,
  };
}

function snapshotFreshness(snapshot) {
  if (!snapshot) {
    return { state: "missing", isFresh: false, isMissing: true, isStale: false, ageMs: null };
  }

  const now = Date.now();
  const captured = snapshot.capturedAt ? new Date(snapshot.capturedAt).getTime() : 0;
  const expires = snapshot.expiresAt ? new Date(snapshot.expiresAt).getTime() : 0;
  const ageMs = captured ? Math.max(0, now - captured) : null;

  if (snapshot.status === "REFRESHING") {
    const stillFresh = expires ? expires > now : captured ? ageMs <= SNAPSHOT_TTL_MS : false;
    return {
      state: stillFresh ? "refreshing" : "stale",
      isFresh: stillFresh,
      isMissing: false,
      isStale: !stillFresh,
      ageMs,
    };
  }

  const fresh = expires ? expires > now : captured ? ageMs <= SNAPSHOT_TTL_MS : false;
  return {
    state: fresh ? "fresh" : "stale",
    isFresh: fresh,
    isMissing: false,
    isStale: !fresh,
    ageMs,
  };
}

async function assertCreatorAccess({ agencyId, creatorId }) {
  return prisma.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, displayName: true, username: true, remoteId: true },
  });
}

async function recomputeSnapshotCounts({ agencyId, creatorId, capturedAt = new Date(), source = "backend", deviceId = null, metadata = {} }) {
  const onlineCount = await prisma.creatorPresenceUser.count({ where: { agencyId, creatorId, status: "online" } });
  // v5: no stale/offline rows are kept in the online-users module. Fields remain
  // for DB/API compatibility, but they are always zeroed by recompute.
  const staleCount = 0;
  const offlineCount = 0;

  const progressive = metadata?.progressive === true;
  const done = metadata?.done === true;
  const status = progressive && !done ? "REFRESHING" : (onlineCount ? "FRESH" : "EMPTY");
  const expiresAt = new Date(capturedAt.getTime() + SNAPSHOT_TTL_MS);

  return prisma.creatorPresenceSnapshot.upsert({
    where: { agencyId_creatorId: { agencyId, creatorId } },
    create: {
      agencyId,
      creatorId,
      status,
      onlineCount,
      staleCount,
      offlineCount,
      capturedAt,
      expiresAt,
      source,
      updatedByDeviceId: deviceId,
      metadata,
    },
    update: {
      status,
      onlineCount,
      staleCount,
      offlineCount,
      capturedAt,
      expiresAt,
      source,
      updatedByDeviceId: deviceId,
      metadata,
    },
  });
}

async function upsertPresenceRows({ agencyId, creatorId, deviceId, users, at, source, metadata = {} }) {
  const normalized = [];
  const seenIds = new Set();

  for (const item of Array.isArray(users) ? users : []) {
    const row = normalizePresenceUser(item);
    if (!row || seenIds.has(row.fanId)) continue;
    seenIds.add(row.fanId);
    normalized.push(row);
  }

  for (const row of normalized) {
    await prisma.creatorPresenceUser.upsert({
      where: { creatorId_fanId: { creatorId, fanId: row.fanId } },
      create: {
        agencyId,
        creatorId,
        fanId: row.fanId,
        username: row.username,
        name: row.name,
        avatarUrl: row.avatarUrl,
        totalSpentCents: row.totalSpentCents,
        subscribeAt: row.subscribeAt,
        duration: row.duration,
        status: "online",
        source,
        lastOnlineAt: at,
        lastCheckedAt: at,
        lastSnapshotAt: at,
        updatedByDeviceId: deviceId,
        metadata: { ...(row.metadata || {}), ...metadata },
      },
      update: {
        username: row.username,
        name: row.name,
        avatarUrl: row.avatarUrl,
        totalSpentCents: row.totalSpentCents,
        subscribeAt: row.subscribeAt,
        duration: row.duration,
        status: "online",
        source,
        lastOnlineAt: at,
        lastCheckedAt: at,
        lastSnapshotAt: at,
        updatedByDeviceId: deviceId,
        metadata: { ...(row.metadata || {}), ...metadata },
      },
    });
  }

  return { normalized, seenIds };
}

async function applyPresenceSnapshot({ agencyId, creatorId, deviceId = null, users = [], capturedAt = new Date(), source = "api_snapshot", metadata = {}, markAbsentOffline = true }) {
  const creator = await assertCreatorAccess({ agencyId, creatorId });
  if (!creator) return { ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" };

  const at = toDate(capturedAt, new Date());
  const { normalized, seenIds } = await upsertPresenceRows({ agencyId, creatorId, deviceId, users, at, source, metadata });

  let removedAbsent = 0;
  if (markAbsentOffline) {
    const deleted = await prisma.creatorPresenceUser.deleteMany({
      where: {
        agencyId,
        creatorId,
        ...(seenIds.size ? { fanId: { notIn: Array.from(seenIds) } } : {}),
      },
    });
    removedAbsent = deleted.count;
  }

  const snapshot = await recomputeSnapshotCounts({ agencyId, creatorId, capturedAt: at, source, deviceId, metadata: { ...metadata, loaded: normalized.length, removedAbsent } });
  return { ok: true, creator, snapshot, loaded: normalized.length, removedAbsent, markedOffline: 0 };
}

async function applyPresenceSnapshotProgressive({
  agencyId,
  creatorId,
  deviceId = null,
  users = [],
  capturedAt = new Date(),
  source = "api_snapshot_progressive",
  refreshId = null,
  refreshStartedAt = null,
  page = null,
  done = false,
  metadata = {},
}) {
  const creator = await assertCreatorAccess({ agencyId, creatorId });
  if (!creator) return { ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" };

  const at = toDate(capturedAt, new Date());
  const startedAt = toDate(refreshStartedAt, at) || at;
  const pageNumber = Number(page || 0);
  const meta = { ...metadata, progressive: true, done: !!done, refreshId, page: pageNumber || null, refreshStartedAt: startedAt.toISOString() };

  // v5: no stale phase. The first progressive packet clears old rows;
  // following packets append confirmed online users.
  if (!done && (pageNumber <= 1 || metadata?.mode === "append_first")) {
    await prisma.creatorPresenceUser.deleteMany({ where: { agencyId, creatorId } });
  }

  const { normalized } = await upsertPresenceRows({
    agencyId,
    creatorId,
    deviceId,
    users,
    at,
    source,
    metadata: meta,
  });

  let removedAbsent = 0;
  if (done) {
    const deleted = await prisma.creatorPresenceUser.deleteMany({
      where: {
        agencyId,
        creatorId,
        OR: [
          { lastSnapshotAt: null },
          { lastSnapshotAt: { lt: startedAt } },
        ],
      },
    });
    removedAbsent = deleted.count;
  }

  const snapshot = await recomputeSnapshotCounts({
    agencyId,
    creatorId,
    capturedAt: at,
    source,
    deviceId,
    metadata: { ...meta, loaded: normalized.length, removedAbsent },
  });

  return { ok: true, creator, snapshot, loaded: normalized.length, removedAbsent, markedOffline: 0, done: !!done };
}


async function markPresenceRefreshQueued({ agencyId, creatorId, deviceId = null, reason = "manual_presence_refresh", refreshId = null }) {
  const creator = await assertCreatorAccess({ agencyId, creatorId });
  if (!creator) return { ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" };

  const at = new Date();

  // v5: queued refresh clears visible rows instead of turning them into stale.
  await prisma.creatorPresenceUser.deleteMany({ where: { agencyId, creatorId } });

  const snapshot = await recomputeSnapshotCounts({
    agencyId,
    creatorId,
    capturedAt: at,
    source: "presence_refresh_queued",
    deviceId,
    metadata: {
      progressive: true,
      done: false,
      queued: true,
      reason,
      refreshId,
    },
  });

  return { ok: true, creator, snapshot, queued: true };
}

async function applyPresenceEvents({ agencyId, creatorId, deviceId = null, events = [] }) {
  const creator = await assertCreatorAccess({ agencyId, creatorId });
  if (!creator) return { ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" };

  let online = 0;
  let offline = 0;
  const input = Array.isArray(events) ? events : [];

  for (const event of input) {
    const type = cleanString(event?.type, 100);
    const at = toDate(event?.ts || event?.createdAt, new Date());

    if (type === "presence_online") {
      const ids = event.onlineIds || event.fanIds || event.ids || [];
      for (const rawId of ids) {
        const fanId = fanIdOf(rawId);
        if (!fanId) continue;
        await prisma.creatorPresenceUser.upsert({
          where: { creatorId_fanId: { creatorId, fanId } },
          create: { agencyId, creatorId, fanId, username: `u${fanId}`, name: `u${fanId}`, status: "online", source: "ws_presence", lastOnlineAt: at, lastCheckedAt: at, updatedByDeviceId: deviceId, metadata: {} },
          update: { status: "online", source: "ws_presence", lastOnlineAt: at, lastCheckedAt: at, updatedByDeviceId: deviceId },
        });
        online += 1;
      }
    }

    if (type === "presence_offline_checked") {
      const onlineIds = event.onlineIds || [];
      const offlineIds = event.offlineIds || [];

      for (const rawId of onlineIds) {
        const fanId = fanIdOf(rawId);
        if (!fanId) continue;
        await prisma.creatorPresenceUser.upsert({
          where: { creatorId_fanId: { creatorId, fanId } },
          create: { agencyId, creatorId, fanId, username: `u${fanId}`, name: `u${fanId}`, status: "online", source: "presence_check", lastOnlineAt: at, lastCheckedAt: at, updatedByDeviceId: deviceId, metadata: {} },
          update: { status: "online", source: "presence_check", lastOnlineAt: at, lastCheckedAt: at, updatedByDeviceId: deviceId },
        });
        online += 1;
      }

      for (const rawId of offlineIds) {
        const fanId = fanIdOf(rawId);
        if (!fanId) continue;
        await prisma.creatorPresenceUser.deleteMany({ where: { agencyId, creatorId, fanId } });
        offline += 1;
      }
    }
  }

  const snapshot = await recomputeSnapshotCounts({ agencyId, creatorId, capturedAt: new Date(), source: "ws_presence", deviceId, metadata: { online, offline, events: input.length } });
  return { ok: true, creator, snapshot, online, offline, received: input.length };
}

async function listPresence({ agencyId, creatorId, status = "visible", limit = 500 }) {
  const creator = await assertCreatorAccess({ agencyId, creatorId });
  if (!creator) return { ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" };

  const snapshot = await prisma.creatorPresenceSnapshot.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
  const freshness = snapshotFreshness(snapshot);

  // Do not show old snapshot as truth. Missing/stale returns empty users;
  // client should queue/await refresh. REFRESHING is considered fresh because
  // progressive pages are current and should be shown immediately.
  // v5 never exposes stale/offline rows to the online list.
  if (!freshness.isFresh) {
    return { ok: true, creator, snapshot, freshness, users: [] };
  }

  const where = { agencyId, creatorId };
  if (status === "online") where.status = "online";
  else if (status === "offline") where.status = "offline";
  else if (status === "visible") where.status = "online";

  const users = await prisma.creatorPresenceUser.findMany({
    where,
    orderBy: [{ totalSpentCents: "desc" }, { lastOnlineAt: "desc" }],
    take: Math.min(2000, Math.max(1, Number(limit || 500))),
  });

  return { ok: true, creator, snapshot, freshness, users: users.map(serializeUser) };
}

async function applyPresenceJobResult({ job, deviceId, result }) {
  if (!job?.creatorId || !job?.agencyId) return { ok: false, code: "JOB_SCOPE_INVALID" };

  if (result?.progressive === true || result?.reportOnly === true) {
    // Progressive pages were already written through /presence/:creatorId/snapshot.
    // Job report is only an acknowledgement; do not overwrite rows with users: [].
    const snapshot = await prisma.creatorPresenceSnapshot.findUnique({
      where: { agencyId_creatorId: { agencyId: job.agencyId, creatorId: job.creatorId } },
    });

    return {
      ok: true,
      snapshot,
      loaded: result?.onlineCount || 0,
      pages: result?.pages || 0,
      reportOnly: true,
    };
  }

  const users = Array.isArray(result?.users) ? result.users : Array.isArray(result?.onlineUsers) ? result.onlineUsers : [];
  return applyPresenceSnapshot({
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    deviceId,
    users,
    capturedAt: result?.capturedAt || new Date(),
    source: "scheduled_api_snapshot",
    metadata: { jobId: job.id, pages: result?.pages || null, reason: result?.reason || null },
    markAbsentOffline: true,
  });
}

module.exports = {
  SNAPSHOT_TTL_MS,
  applyPresenceSnapshot,
  applyPresenceSnapshotProgressive,
  applyPresenceEvents,
  markPresenceRefreshQueued,
  listPresence,
  recomputeSnapshotCounts,
  applyPresenceJobResult,
};
