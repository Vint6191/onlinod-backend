"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient } = require("./range-service");
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

async function buildTeamOverview({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const [snapshot, members, devices] = await Promise.all([
    getLatestPayload({ agencyId, scope: "team_overview", rangeKey: range.key }),
    getMembersShell(agencyId),
    prisma.workerDevice.findMany({ where: { agencyId }, orderBy: { lastSeenAt: "desc" } }),
  ]);

  const now = Date.now();
  const onlineDevices = devices.filter((d) => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000).length;
  const overview = unwrapSnapshot(snapshot, "overview", {});

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    overview: {
      totalMessages: Number(overview.totalMessages || 0),
      messagesSent: Number(overview.messagesSent || 0),
      massMessages: Number(overview.massMessages || 0),
      postsCreated: Number(overview.postsCreated || 0),
      storiesCreated: Number(overview.storiesCreated || 0),
      chatOpened: Number(overview.chatOpened || 0),
      activeMembers: Number(overview.activeMembers || 0),
      membersCount: members.length,
      devicesOnline: onlineDevices,
      eventsCount: Number(overview.eventsCount || 0),
      revenueAttributedCents: Number(overview.revenueAttributedCents || 0),
      dollarsPerMessageCents: Number(overview.dollarsPerMessageCents || 0),
      slaReply15mPct: overview.slaReply15mPct ?? null,
      source: snapshot ? "analytics_snapshot" : "snapshot_missing",
    },
  };
}

async function buildTeamMembers({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const [snapshot, members] = await Promise.all([
    getLatestPayload({ agencyId, scope: "team_members", rangeKey: range.key }),
    getMembersShell(agencyId),
  ]);

  const snapshotMembers = Array.isArray(snapshot?.payload?.members) ? snapshot.payload.members : [];
  const byId = new Map(snapshotMembers.map((row) => [String(row.member?.id || row.memberId || row.id || ""), row]));

  const rows = members.map((member) => {
    const shell = memberShell(member);
    const snap = byId.get(String(member.id)) || {};
    return {
      member: { ...shell, ...(snap.member || {}) },
      metrics: {
        messagesSent: 0,
        massMessages: 0,
        totalMessages: 0,
        postsCreated: 0,
        storiesCreated: 0,
        chatOpened: 0,
        uniqueFans: 0,
        creatorCoverage: 0,
        activeEvents: 0,
        revenueAttributedCents: 0,
        dollarsPerMessageCents: 0,
        avgResponseSeconds: null,
        slaReply15mPct: null,
        ...(snap.metrics || {}),
      },
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
