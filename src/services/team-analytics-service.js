"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");

const TEAM_TELEMETRY_VERSION = "team_v3";

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

function mean(values) {
  const list = (Array.isArray(values) ? values : []).filter((n) => Number.isFinite(Number(n)));
  if (!list.length) return null;
  return list.reduce((a, b) => a + Number(b), 0) / list.length;
}

function median(values) {
  const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[idx];
}

function eventExtra(ev) {
  return ev?.extra && typeof ev.extra === "object" ? ev.extra : {};
}

function isV3(ev) {
  const extra = eventExtra(ev);
  return extra.telemetryVersion === TEAM_TELEMETRY_VERSION || ev.source === "electron_team_v3";
}

function memberShell(member) {
  return {
    id: member.id,
    userId: member.userId,
    name: member.displayName || member.user?.name || member.user?.email || (String(member.role || "owner").toLowerCase() === "owner" ? "Owner" : "member"),
    email: member.user?.email || null,
    roleKey: member.roleKey || String(member.role || "").toLowerCase(),
    assignedCreators: member.assignedCreators ?? "all",
  };
}

async function getMembersShell(agencyId) {
  return prisma.agencyMember.findMany({
    where: { agencyId, deletedAt: null },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

function emptyMetric() {
  return {
    messagesSent: 0,
    massMessages: 0,
    totalMessages: 0,
    postsCreated: 0,
    storiesCreated: 0,
    chatOpened: 0,
    incomingMessages: 0,
    uniqueFans: 0,
    creatorCoverage: 0,
    activeEvents: 0,
    activeMinutes: 0,
    idleGapsCount: 0,
    longestIdleMin: 0,
    replyProxyAvgMin: null,
    replyProxyMedianMin: null,
    replyProxySamples: 0,
    avgResponseSeconds: null,
    medianResponseSeconds: null,
    p90ResponseSeconds: null,
    responseSamples: 0,
    unansweredIncomingCount: 0,
    slaReply5mPct: null,
    slaReply15mPct: null,
    dialogDwellSeconds: 0,
    dialogDwellMinutes: 0,
    avgDialogDwellSeconds: null,
    dialogSessionsCount: 0,
    topDialogSessions: [],
    revenueAttributedCents: 0,
    dollarsPerMessageCents: 0,

    // internal accumulators
    _fans: new Set(),
    _creators: new Set(),
    _responseSeconds: [],
    _sla5: 0,
    _sla15: 0,
    _dialogSessions: new Map(),
  };
}

function cleanMetric(metric) {
  const responseSamples = metric._responseSeconds.length;
  const dialogSessions = Array.from(metric._dialogSessions.values())
    .sort((a, b) => b.dwellSeconds - a.dwellSeconds)
    .slice(0, 10);

  metric.totalMessages = metric.messagesSent + metric.massMessages;
  metric.uniqueFans = metric._fans.size;
  metric.creatorCoverage = metric._creators.size;
  metric.activeEvents = metric.messagesSent + metric.massMessages + metric.incomingMessages + metric.dialogSessionsCount;
  metric.dialogDwellMinutes = Math.round(metric.dialogDwellSeconds / 60);
  metric.avgDialogDwellSeconds = metric.dialogSessionsCount > 0 ? metric.dialogDwellSeconds / metric.dialogSessionsCount : null;
  metric.avgResponseSeconds = mean(metric._responseSeconds);
  metric.medianResponseSeconds = median(metric._responseSeconds);
  metric.p90ResponseSeconds = percentile(metric._responseSeconds, 90);
  metric.responseSamples = responseSamples;
  metric.slaReply5mPct = responseSamples > 0 ? (metric._sla5 / responseSamples) * 100 : null;
  metric.slaReply15mPct = responseSamples > 0 ? (metric._sla15 / responseSamples) * 100 : null;
  metric.dollarsPerMessageCents = metric.totalMessages > 0 ? Math.round(metric.revenueAttributedCents / metric.totalMessages) : 0;
  metric.topDialogSessions = dialogSessions.map((item) => ({
    fanId: item.fanId || null,
    accountId: item.accountId || null,
    sessions: item.sessions || 0,
    dwellSeconds: item.dwellSeconds || 0,
    dwellMinutes: Math.round((item.dwellSeconds || 0) / 60),
  }));

  delete metric._fans;
  delete metric._creators;
  delete metric._responseSeconds;
  delete metric._sla5;
  delete metric._sla15;
  delete metric._dialogSessions;
  return metric;
}

function keyFor(ev) {
  const extra = eventExtra(ev);
  return [String(ev.accountId || extra.accountId || ""), String(ev.fanId || extra.fanId || extra.dialogId || "")].join("|");
}

function logicalEventKey(ev) {
  const extra = eventExtra(ev);
  const type = String(ev.type || "");
  const accountId = String(ev.accountId || extra.accountId || "");
  const fanId = String(ev.fanId || extra.fanId || extra.dialogId || "");
  const messageId = String(extra.messageId || "");
  const localSeed = String(extra.localSeed || "");

  if (type === "dialog_unread_opened") {
    // Old broken build emitted every /messages history item with reason=messages_api.
    // Those are not real opened-unread client markers and must not count.
    if (String(extra.reason || "") === "messages_api") return null;
    return [type, accountId, fanId, messageId || localSeed || ev.localId || ""].join("|");
  }

  if (type === "chat_message_sent_local") {
    return [type, accountId, fanId, messageId || localSeed || ev.localId || ""].join("|");
  }

  if (type === "dialog_session") {
    return [type, accountId, fanId, localSeed || extra.startedAt || ev.localId || ""].join("|");
  }

  return ev.localId || [type, accountId, fanId, new Date(ev.ts).getTime()].join("|");
}

function dedupeLogicalEvents(rows) {
  const out = [];
  const seen = new Set();
  for (const ev of rows || []) {
    const key = logicalEventKey(ev);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

async function loadV3Events({ agencyId, range }) {
  const rows = await prisma.teamActivityEvent.findMany({
    where: { agencyId, ...whereForRange("ts", range) },
    orderBy: { ts: "asc" },
    take: 20000,
  });
  return dedupeLogicalEvents(rows.filter(isV3));
}

async function buildComputed({ agencyId, rangeKey = "7d" }) {
  const range = resolveRange(rangeKey);
  const [members, events] = await Promise.all([
    getMembersShell(agencyId),
    loadV3Events({ agencyId, range }),
  ]);

  const metricsByMember = new Map();
  for (const m of members) metricsByMember.set(String(m.id), emptyMetric());

  function metricFor(memberId) {
    const id = String(memberId || "");
    if (!id) return null;
    if (!metricsByMember.has(id)) metricsByMember.set(id, emptyMetric());
    return metricsByMember.get(id);
  }

  const pending = [];

  for (const ev of events) {
    const extra = eventExtra(ev);
    const memberId = ev.memberId ? String(ev.memberId) : "";
    const m = metricFor(memberId);
    const fanId = String(ev.fanId || extra.fanId || extra.dialogId || "").trim();
    const accountId = String(ev.accountId || extra.accountId || "").trim();
    const type = String(ev.type || "");

    if (m) {
      if (fanId) m._fans.add(fanId);
      if (accountId) m._creators.add(accountId);
    }

    if (type === "dialog_unread_opened") {
      if (m) {
        // Count opened unread clients/dialogs, not raw OF unread message total.
        // rawUnreadMessagesCount remains available in extra for debugging.
        m.incomingMessages += 1;
        m.chatOpened += 1;
      }
      pending.push({
        key: keyFor(ev),
        openerMemberId: memberId,
        fanId,
        accountId,
        ts: new Date(ev.ts).getTime(),
        messageId: extra.messageId || null,
        closed: false,
      });
      continue;
    }

    if (type === "chat_message_sent_local") {
      if (m) m.messagesSent += 1;

      const evTs = new Date(ev.ts).getTime();
      const k = keyFor(ev);
      const open = pending.find((p) => !p.closed && p.key === k && p.ts <= evTs);
      if (open) {
        open.closed = true;
        const seconds = Math.max(0, Math.round((evTs - open.ts) / 1000));
        const senderMetric = m || metricFor(memberId);
        if (senderMetric) {
          senderMetric._responseSeconds.push(seconds);
          if (seconds <= 5 * 60) senderMetric._sla5 += 1;
          if (seconds <= 15 * 60) senderMetric._sla15 += 1;
        }
      }
      continue;
    }

    if (type === "mass_message_sent_local" || type === "message_queue_sent_local") {
      if (m) m.massMessages += Math.max(1, num(extra.count, 1));
      continue;
    }

    if (type === "dialog_session") {
      if (m) {
        const dwell = Math.max(0, num(extra.dwellSeconds, 0));
        m.dialogDwellSeconds += dwell;
        m.dialogSessionsCount += 1;
        const dk = [accountId, fanId || extra.dialogId || ""].join("|");
        const prev = m._dialogSessions.get(dk) || { fanId: fanId || extra.dialogId || null, accountId: accountId || null, sessions: 0, dwellSeconds: 0 };
        prev.sessions += 1;
        prev.dwellSeconds += dwell;
        m._dialogSessions.set(dk, prev);
      }
      continue;
    }
  }

  for (const p of pending) {
    if (!p.closed) {
      const m = metricFor(p.openerMemberId);
      if (m) m.unansweredIncomingCount += 1;
    }
  }

  const byMember = new Map();
  for (const [memberId, metric] of metricsByMember.entries()) byMember.set(memberId, cleanMetric(metric));

  return { range, members, events, byMember };
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
      if (row.attributedToMemberId) map.set(String(row.attributedToMemberId), num(row?._sum?.amountCents, 0));
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function buildTeamMembers({ agencyId, rangeKey = "7d" }) {
  const computed = await buildComputed({ agencyId, rangeKey });
  const revenueByMember = await getMoneyRevenueByMember({ agencyId, range: computed.range });

  const rows = computed.members.map((member) => {
    const shell = memberShell(member);
    const metrics = computed.byMember.get(String(member.id)) || cleanMetric(emptyMetric());
    const revenue = revenueByMember.get(String(member.id)) || 0;
    if (revenue > 0) {
      metrics.revenueAttributedCents = revenue;
      metrics.dollarsPerMessageCents = metrics.totalMessages > 0 ? Math.round(revenue / metrics.totalMessages) : 0;
      metrics.moneySource = "money_attribution";
    }
    return { member: shell, metrics, rawSummary: null };
  });

  return {
    ok: true,
    range: rangeForClient(computed.range),
    snapshot: null,
    members: rows,
    source: "team_activity_event_v3",
  };
}

function combineOverview(metricsList, membersCount) {
  const out = {
    totalMessages: 0,
    messagesSent: 0,
    massMessages: 0,
    botMessages: 0,
    postsCreated: 0,
    storiesCreated: 0,
    chatOpened: 0,
    incomingMessages: 0,
    uniqueFans: 0,
    activeCreators: 0,
    activeMembers: 0,
    membersCount,
    devicesOnline: 0,
    eventsCount: 0,
    revenueAttributedCents: 0,
    dollarsPerMessageCents: 0,
    avgResponseSeconds: null,
    slaReply15mPct: null,
    source: "team_activity_event_v3",
  };
  const fans = new Set();
  const responses = [];
  let sla15Good = 0;
  let sla15Samples = 0;

  for (const m of metricsList) {
    out.messagesSent += num(m.messagesSent, 0);
    out.massMessages += num(m.massMessages, 0);
    out.totalMessages += num(m.totalMessages, 0);
    out.postsCreated += num(m.postsCreated, 0);
    out.storiesCreated += num(m.storiesCreated, 0);
    out.chatOpened += num(m.chatOpened, 0);
    out.incomingMessages += num(m.incomingMessages, 0);
    out.revenueAttributedCents += num(m.revenueAttributedCents, 0);
    if (num(m.activeEvents, 0) > 0) out.activeMembers += 1;
    if (num(m.creatorCoverage, 0) > 0) out.activeCreators += num(m.creatorCoverage, 0);
    out.eventsCount += num(m.activeEvents, 0);
    if (num(m.avgResponseSeconds, NaN) === num(m.avgResponseSeconds, NaN) && num(m.responseSamples, 0) > 0) {
      for (let i = 0; i < num(m.responseSamples, 0); i++) responses.push(num(m.avgResponseSeconds, 0));
      const pct15 = nullableNum(m.slaReply15mPct);
      if (pct15 !== null) {
        sla15Good += (pct15 / 100) * num(m.responseSamples, 0);
        sla15Samples += num(m.responseSamples, 0);
      }
    }
  }
  out.avgResponseSeconds = mean(responses);
  out.slaReply15mPct = sla15Samples > 0 ? (sla15Good / sla15Samples) * 100 : null;
  out.dollarsPerMessageCents = out.totalMessages > 0 ? Math.round(out.revenueAttributedCents / out.totalMessages) : 0;
  return out;
}

async function buildTeamOverview({ agencyId, rangeKey = "7d" }) {
  const membersPayload = await buildTeamMembers({ agencyId, rangeKey });
  const overview = combineOverview(membersPayload.members.map((r) => r.metrics), membersPayload.members.length);
  return {
    ok: true,
    range: membersPayload.range,
    snapshot: null,
    overview,
  };
}

async function buildTeamAlerts({ agencyId, rangeKey = "7d" }) {
  const membersPayload = await buildTeamMembers({ agencyId, rangeKey });
  const alerts = [];
  for (const row of membersPayload.members) {
    const name = row.member?.name || "member";
    const m = row.metrics || {};
    if (num(m.unansweredIncomingCount, 0) > 0) {
      alerts.push({
        id: `unanswered_${row.member.id}`,
        tone: "warn",
        title: `${name}: ${m.unansweredIncomingCount} unanswered`,
        text: "Unread fan dialogs opened but not answered yet.",
        memberId: row.member.id,
      });
    }
    if (nullableNum(m.avgResponseSeconds) !== null && num(m.avgResponseSeconds, 0) > 15 * 60) {
      alerts.push({
        id: `slow_reply_${row.member.id}`,
        tone: "danger",
        title: `${name}: slow reply time`,
        text: `Average reply is ${Math.round(num(m.avgResponseSeconds, 0) / 60)} minutes.`,
        memberId: row.member.id,
      });
    }
  }
  return { ok: true, range: membersPayload.range, snapshot: null, alerts, source: "team_activity_event_v3" };
}

async function buildTeamFlags({ agencyId, rangeKey = "7d" }) {
  const alerts = await buildTeamAlerts({ agencyId, rangeKey });
  return { ok: true, range: alerts.range, snapshot: null, flags: alerts.alerts || [], source: "team_activity_event_v3" };
}

module.exports = {
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
};
