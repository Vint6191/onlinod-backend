"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const { getLatestPayload } = require("./analytics-snapshot-service");

async function getMembersShell(agencyId) {
  return prisma.agencyMember.findMany({
    where: { agencyId, deletedAt: null },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

function memberShell(member) {
  return {
    id: member.id,
    userId: member.userId,
    name: member.displayName || member.user?.name || member.user?.email || "member",
    email: member.user?.email || null,
    roleKey: member.roleKey || String(member.role || "").toLowerCase(),
    assignedCreators: member.assignedCreators ?? "all",
  };
}

function unwrapSnapshot(snapshot, key, fallback) {
  const payload = snapshot?.payload || {};
  const value = payload[key];
  return value === undefined || value === null ? fallback : value;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value) {
  const n = nullableNum(value);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTopDialogSessions(value) {
  return safeArray(value)
    .map((item) => ({
      fanId: item?.fanId ? String(item.fanId) : null,
      accountId: item?.accountId ? String(item.accountId) : null,
      sessions: num(item?.sessions, 0),
      dwellSeconds: num(item?.dwellSeconds, 0),
      dwellMinutes: num(item?.dwellMinutes, 0),
    }))
    .filter((item) => item.fanId || item.accountId || item.dwellSeconds > 0)
    .slice(0, 10);
}

function normalizeMemberMetrics(raw = {}) {
  const messagesSent = num(raw.messagesSent, 0);
  const massMessages = num(raw.massMessages, 0);
  const totalMessages = num(raw.totalMessages, messagesSent + massMessages);
  const revenueAttributedCents = num(raw.revenueAttributedCents, 0);
  const dollarsPerMessageCents = num(
    raw.dollarsPerMessageCents,
    totalMessages > 0 ? Math.round(revenueAttributedCents / totalMessages) : 0
  );

  return {
    messagesSent,
    massMessages,
    totalMessages,
    postsCreated: num(raw.postsCreated, 0),
    storiesCreated: num(raw.storiesCreated, 0),
    chatOpened: num(raw.chatOpened, 0),
    uniqueFans: num(raw.uniqueFans, 0),
    creatorCoverage: num(raw.creatorCoverage, 0),
    activeEvents: num(raw.activeEvents, 0),
    activeMinutes: num(raw.activeMinutes, 0),
    idleGapsCount: num(raw.idleGapsCount, 0),
    longestIdleMin: num(raw.longestIdleMin, 0),

    // Old proxy fields kept so older renderer builds do not break.
    replyProxyAvgMin: nullableNum(raw.replyProxyAvgMin),
    replyProxyMedianMin: nullableNum(raw.replyProxyMedianMin),
    replyProxySamples: num(raw.replyProxySamples, 0),

    // Real response metrics from Electron v2:
    // incoming_message -> first message_sent by operator to the same fan/account.
    avgResponseSeconds: nullableNum(raw.avgResponseSeconds),
    medianResponseSeconds: nullableNum(raw.medianResponseSeconds),
    p90ResponseSeconds: nullableNum(raw.p90ResponseSeconds),
    responseSamples: num(raw.responseSamples, 0),
    incomingMessages: num(raw.incomingMessages, 0),
    unansweredIncomingCount: num(raw.unansweredIncomingCount, 0),
    slaReply5mPct: pct(raw.slaReply5mPct),
    slaReply15mPct: pct(raw.slaReply15mPct),

    // Dialog dwell metrics from Electron v2.
    dialogDwellSeconds: num(raw.dialogDwellSeconds, 0),
    dialogDwellMinutes: num(raw.dialogDwellMinutes, 0),
    avgDialogDwellSeconds: nullableNum(raw.avgDialogDwellSeconds),
    dialogSessionsCount: num(raw.dialogSessionsCount, 0),
    topDialogSessions: normalizeTopDialogSessions(raw.topDialogSessions),

    // Money attribution placeholder/ready fields.
    revenueAttributedCents,
    dollarsPerMessageCents,
  };
}


async function getMoneyRevenueTotal({ agencyId, range }) {
  try {
    const result = await prisma.moneyAttribution.aggregate({
      where: {
        agencyId,
        attributedToMemberId: { not: null },
        ...whereForRange("occurredAt", range),
      },
      _sum: { amountCents: true },
    });
    return num(result?._sum?.amountCents, 0);
  } catch (_) {
    return 0;
  }
}

async function getMoneyRevenueByMember({ agencyId, range }) {
  try {
    const rows = await prisma.moneyAttribution.groupBy({
      by: ["attributedToMemberId"],
      where: {
        agencyId,
        attributedToMemberId: { not: null },
        ...whereForRange("occurredAt", range),
      },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      if (row.attributedToMemberId) {
        map.set(String(row.attributedToMemberId), num(row?._sum?.amountCents, 0));
      }
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

function normalizeOverview(raw = {}, membersCount = 0, devicesOnline = 0) {
  const messagesSent = num(raw.messagesSent, 0);
  const massMessages = num(raw.massMessages, 0);
  const botMessages = num(raw.botMessages, 0);
  const totalMessages = num(raw.totalMessages, messagesSent + massMessages + botMessages);
  const revenueAttributedCents = num(raw.revenueAttributedCents, 0);

  return {
    totalMessages,
    messagesSent,
    massMessages,
    botMessages,
    postsCreated: num(raw.postsCreated, 0),
    storiesCreated: num(raw.storiesCreated, 0),
    chatOpened: num(raw.chatOpened, 0),
    incomingMessages: num(raw.incomingMessages, 0),
    uniqueFans: num(raw.uniqueFans, 0),
    activeCreators: num(raw.activeCreators, 0),
    activeMembers: num(raw.activeMembers, 0),
    membersCount,
    devicesOnline,
    eventsCount: num(raw.eventsCount, 0),
    revenueAttributedCents,
    dollarsPerMessageCents: num(
      raw.dollarsPerMessageCents,
      totalMessages > 0 ? Math.round(revenueAttributedCents / totalMessages) : 0
    ),
    avgResponseSeconds: nullableNum(raw.avgResponseSeconds),
    slaReply15mPct: pct(raw.slaReply15mPct),
    source: raw.source || "electron_local_compute",
  };
}

async function buildTeamOverview({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const [snapshot, members, devices, moneyRevenueCents] = await Promise.all([
    getLatestPayload({ agencyId, scope: "team_overview", rangeKey: range.key }),
    getMembersShell(agencyId),
    prisma.workerDevice.findMany({ where: { agencyId }, orderBy: { lastSeenAt: "desc" } }),
    getMoneyRevenueTotal({ agencyId, range }),
  ]);

  const now = Date.now();
  const onlineDevices = devices.filter((d) => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000).length;
  const overview = normalizeOverview(unwrapSnapshot(snapshot, "overview", {}), members.length, onlineDevices);
  if (moneyRevenueCents > 0) {
    overview.revenueAttributedCents = moneyRevenueCents;
    overview.dollarsPerMessageCents = overview.totalMessages > 0
      ? Math.round(moneyRevenueCents / overview.totalMessages)
      : 0;
    overview.moneySource = "money_attribution";
  }

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    overview: {
      ...overview,
      source: snapshot ? "analytics_snapshot" : "snapshot_missing",
    },
  };
}

async function buildTeamMembers({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const [snapshot, members, revenueByMember] = await Promise.all([
    getLatestPayload({ agencyId, scope: "team_members", rangeKey: range.key }),
    getMembersShell(agencyId),
    getMoneyRevenueByMember({ agencyId, range }),
  ]);

  const snapshotMembers = Array.isArray(snapshot?.payload?.members) ? snapshot.payload.members : [];
  const byId = new Map(snapshotMembers.map((row) => [String(row.member?.id || row.memberId || row.id || ""), row]));

  const rows = members.map((member) => {
    const shell = memberShell(member);
    const snap = byId.get(String(member.id)) || {};
    const metrics = normalizeMemberMetrics(snap.metrics || {});
    const claimRevenueCents = revenueByMember.get(String(member.id)) || 0;
    if (claimRevenueCents > 0) {
      metrics.revenueAttributedCents = claimRevenueCents;
      metrics.dollarsPerMessageCents = metrics.totalMessages > 0
        ? Math.round(claimRevenueCents / metrics.totalMessages)
        : 0;
      metrics.moneySource = "money_attribution";
    }
    return {
      member: { ...shell, ...(snap.member || {}) },
      metrics,
      rawSummary: snap.rawSummary || null,
    };
  });

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    members: rows,
    source: snapshot ? "analytics_snapshot" : "snapshot_missing",
  };
}

async function buildTeamAlerts({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const snapshot = await getLatestPayload({ agencyId, scope: "team_alerts", rangeKey: range.key });
  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    alerts: Array.isArray(snapshot?.payload?.alerts) ? snapshot.payload.alerts : [],
    source: snapshot ? "analytics_snapshot" : "snapshot_missing",
  };
}

async function buildTeamFlags({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const snapshot = await getLatestPayload({ agencyId, scope: "team_flags", rangeKey: range.key });
  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    flags: Array.isArray(snapshot?.payload?.flags) ? snapshot.payload.flags : [],
    source: snapshot ? "analytics_snapshot" : "snapshot_missing",
  };
}

module.exports = {
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
};
