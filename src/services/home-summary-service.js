"use strict";

const prisma = require("../prisma");
const { resolveRange, resolvePreviousRange, rangeForClient } = require("./range-service");
const { getLatestPayload } = require("./analytics-snapshot-service");

function bigToNum(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

function pctChange(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

async function sumRevenue(agencyId, rangeKey) {
  const snaps = await prisma.creatorEarningsSnapshot.findMany({
    where: { agencyId, rangeKey },
    include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, status: true, remoteId: true } } },
    orderBy: { totalCents: "desc" },
  });

  let totalCents = 0;
  let grossCents = 0;
  let salesCount = 0;
  let uniqueFans = 0;
  const points = [];

  for (const s of snaps) {
    totalCents += bigToNum(s.totalCents);
    grossCents += bigToNum(s.grossCents);
    salesCount += Number(s.salesCount || 0);
    uniqueFans += Number(s.uniqueFans || 0);

    const raw = s.raw || {};
    const maybePoints = raw.points || raw.chart || raw.earnings?.total?.chartAmount || raw.earnings?.chartAmount || [];
    if (Array.isArray(maybePoints)) {
      maybePoints.slice(-32).forEach((item, index) => {
        let value = 0;
        let label = String(index + 1);
        if (Array.isArray(item)) {
          label = String(item[0] || label);
          value = Number(item[item.length - 1] || 0);
        } else if (item && typeof item === "object") {
          label = String(item.label || item.date || item.x || label);
          value = Number(item.value || item.amount || item.total || item.y || 0);
        } else {
          value = Number(item || 0);
        }
        if (Number.isFinite(value)) points.push({ label, valueCents: Math.round(value) });
      });
    }
  }

  return {
    totalCents,
    grossCents,
    salesCount,
    uniqueFans,
    creatorCount: snaps.length,
    points: points.length ? points.slice(-32) : [],
    creators: snaps.map((s) => ({
      id: s.creator.id,
      name: s.creator.displayName,
      username: s.creator.username,
      avatarUrl: s.creator.avatarUrl,
      status: s.creator.status,
      remoteId: s.creator.remoteId,
      revenueCents: bigToNum(s.totalCents),
      salesCount: s.salesCount,
      uniqueFans: s.uniqueFans,
      capturedAt: s.capturedAt,
      staleSeconds: Math.max(0, Math.floor((Date.now() - new Date(s.capturedAt).getTime()) / 1000)),
    })),
  };
}

function snapshotPart(snapshot, key, fallback) {
  const payload = snapshot?.payload || {};
  return payload[key] && typeof payload[key] === "object" ? payload[key] : fallback;
}

async function buildHomeSummary({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const previousRange = resolvePreviousRange(rangeKey);

  const [snapshot, agency, currentRevenue, previousRevenue, members, creators, jobs, devices, latestAudit, subscription] = await Promise.all([
    getLatestPayload({ agencyId, scope: "home", rangeKey: range.key }),
    prisma.agency.findUnique({ where: { id: agencyId } }),
    sumRevenue(agencyId, range.key),
    sumRevenue(agencyId, previousRange.key),
    prisma.agencyMember.findMany({ where: { agencyId, deletedAt: null }, select: { id: true, roleKey: true, displayName: true, user: { select: { email: true, name: true } } } }),
    prisma.creatorAccount.findMany({ where: { agencyId, deletedAt: null }, select: { id: true, displayName: true, username: true, avatarUrl: true, status: true, remoteId: true } }),
    prisma.jobInstance.groupBy({ by: ["status"], where: { agencyId }, _count: { _all: true } }).catch(() => []),
    prisma.workerDevice.findMany({ where: { agencyId }, select: { id: true, userId: true, deviceName: true, platform: true, appVersion: true, lastSeenAt: true } }),
    prisma.auditLog.findMany({ where: { agencyId }, orderBy: { createdAt: "desc" }, take: 5, include: { actor: { select: { id: true, email: true, name: true } } } }),
    prisma.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }),
  ]);

  const now = Date.now();
  const onlineDevices = devices.filter((d) => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000).length;
  const seatsLimit = subscription?.seatsLimit || null;
  const revenueById = new Map(currentRevenue.creators.map((c) => [c.id, c]));

  const creatorRows = creators.map((creator) => ({
    ...creator,
    revenueCents: revenueById.get(creator.id)?.revenueCents || 0,
    salesCount: revenueById.get(creator.id)?.salesCount || 0,
    uniqueFans: revenueById.get(creator.id)?.uniqueFans || 0,
    staleSeconds: revenueById.get(creator.id)?.staleSeconds ?? null,
  })).sort((a, b) => Number(b.revenueCents || 0) - Number(a.revenueCents || 0));

  const snapshotMessages = snapshotPart(snapshot, "messages", { total: 0, team: 0, bot: 0, source: "snapshot_missing" });
  const snapshotWorkers = snapshotPart(snapshot, "workers", {});
  const snapshotHealth = snapshotPart(snapshot, "health", {});

  return {
    ok: true,
    agency: agency ? { id: agency.id, name: agency.name, plan: agency.plan, status: agency.status } : { id: agencyId },
    range: rangeForClient(range),
    refreshedAt: new Date().toISOString(),
    snapshot: snapshot ? {
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      staleSeconds: snapshot.staleSeconds,
      source: "electron_snapshot",
    } : {
      id: null,
      capturedAt: null,
      staleSeconds: null,
      source: "snapshot_missing",
    },
    revenue: {
      totalCents: currentRevenue.totalCents,
      grossCents: currentRevenue.grossCents,
      deltaPct: pctChange(currentRevenue.totalCents, previousRevenue.totalCents),
      currency: "USD",
      salesCount: currentRevenue.salesCount,
      uniqueFans: currentRevenue.uniqueFans,
      creatorCount: currentRevenue.creatorCount,
      points: currentRevenue.points,
      source: "creator_earnings_snapshots",
    },
    messages: {
      total: Number(snapshotMessages.total || 0),
      team: Number(snapshotMessages.team || 0),
      bot: Number(snapshotMessages.bot || 0),
      source: snapshotMessages.source || "analytics_snapshot",
    },
    seats: {
      used: members.length,
      limit: seatsLimit,
      available: seatsLimit === null ? null : Math.max(0, Number(seatsLimit) - members.length),
      source: seatsLimit === null ? "members_only" : "subscription",
    },
    creators: creatorRows,
    workers: {
      totalMembers: members.length,
      onlineDevices,
      devices: devices.length,
      activeMembers: Number(snapshotWorkers.activeMembers || 0),
      ...snapshotWorkers,
    },
    health: {
      ...snapshotHealth,
      onlineDevices,
      jobs: Object.fromEntries((jobs || []).map((row) => [row.status, row._count?._all || 0])),
    },
    jobs: Object.fromEntries((jobs || []).map((row) => [row.status, row._count?._all || 0])),
    audit: latestAudit.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata || {},
      createdAt: row.createdAt,
      actor: row.actor ? { id: row.actor.id, email: row.actor.email, name: row.actor.name } : null,
    })),
  };
}

module.exports = { buildHomeSummary };
