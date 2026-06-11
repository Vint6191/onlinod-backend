"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const { getLatestPayload } = require("./analytics-snapshot-service");

// Count operator sent messages ONLY from local API-send telemetry.
// Do not count websocket creator echoes (chat_message_sent/ppv_message_sent),
// because they also arrive for another browser/device and for automation.
const OUTGOING_TYPES = new Set([
  "chat_message_sent_local",
  "message_sent_local",
  "local_chat_message_sent",
  "manual_message_sent",
  "reply_sent_local",
]);

const MASS_TYPES = new Set([
  "mass_message_sent_local",
  "local_mass_message_sent",
  "mass_message_sent",
  "broadcast_message_sent",
  "campaign_message_sent",
  "bump_message_sent",
  "bump_sent",
]);

const INCOMING_TYPES = new Set([
  "incoming_message",
  "incoming_unread_seen",
  "dialog_unread_snapshot",
  "dialog_unread_seen_local",
  "message_received",
  "chat_message_received",
  "fan_message_received",
]);

const CHAT_OPEN_TYPES = new Set([
  "chat_opened",
  "dialog_opened",
  "dialog_focus",
  "chat_focus",
]);

const ACTIVE_TYPES = new Set([
  "active",
  "activity",
  "heartbeat",
  "focus",
  "chat_opened",
  "dialog_opened",
  "dialog_focus",
  "chat_focus",
]);

const CONTENT_TYPES = new Set([
  "post_created",
  "story_created",
  "vault_upload",
  "content_created",
]);

const MONEY_EVENT_TYPES = new Set([
  "tip_received",
  "ppv_purchase_received",
  "purchase_received",
  "subscription_created",
  "money_received",
]);

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

function avg(values) {
  const list = values.filter((v) => Number.isFinite(Number(v)) && Number(v) >= 0).map(Number);
  if (!list.length) return null;
  return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
}

function median(values) {
  const list = values.filter((v) => Number.isFinite(Number(v)) && Number(v) >= 0).map(Number).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? Math.round(list[mid]) : Math.round((list[mid - 1] + list[mid]) / 2);
}

function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(Number(v)) && Number(v) >= 0).map(Number).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return Math.round(list[idx]);
}

function percentage(part, total) {
  if (!total) return null;
  return Math.round((Number(part || 0) / Number(total || 0)) * 100);
}

function cleanLower(value) {
  return String(value || "").trim().toLowerCase();
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function secondsFromExtra(extra = {}) {
  const e = safeObject(extra);
  const ms = firstNumber(e.dialogTimeMs, e.timeInDialogMs, e.dwellMs, e.durationMs, e.ms);
  if (ms !== null && ms > 0) return Math.round(ms / 1000);

  const minutes = firstNumber(e.dialogDwellMinutes, e.dialogTimeMinutes, e.timeInDialogMinutes, e.dwellMinutes, e.minutes);
  if (minutes !== null && minutes > 0) return Math.round(minutes * 60);

  const seconds = firstNumber(
    e.dialogDwellSeconds,
    e.dialogTimeSeconds,
    e.timeInDialogSeconds,
    e.dwellSeconds,
    e.durationSeconds,
    e.seconds
  );
  return seconds !== null && seconds > 0 ? Math.round(seconds) : 0;
}

function amountCentsFromExtra(extra = {}) {
  const e = safeObject(extra);
  const cents = firstNumber(e.amountCents, e.priceCents, e.revenueCents, e.netAmountCents);
  if (cents !== null) return Math.round(cents);
  const dollars = firstNumber(e.amount, e.price, e.revenue, e.netAmount);
  if (dollars !== null) return Math.round(dollars * 100);
  return 0;
}

function millisFromValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function incomingObservedTs(event) {
  const e = safeObject(event.extra);
  const observed = millisFromValue(e.observedAt || e.seenAt || e.openedAt || e.enteredAt);
  if (observed !== null) return observed;
  const ts = millisFromValue(event.ts);
  return ts !== null ? ts : Date.now();
}

function unreadCountFromExtra(extra = {}) {
  const e = safeObject(extra);
  const n = firstNumber(e.unreadMessagesCount, e.unreadCount, e.count);
  return n !== null && n > 0 ? Math.max(1, Math.round(n)) : 1;
}

function incomingMessageIdentity(event) {
  const e = safeObject(event.extra);
  const scope = event.accountId || event.creatorId || event.creatorRef || "";
  const fan = event.fanId || "";
  const messageId = String(e.messageId || e.lastMessageId || "").trim();
  if (messageId) return `${scope}|${fan}|${messageId}`;
  return `${scope}|${fan}|${event.id}`;
}

function isDetailedUnreadEvent(type) {
  const t = cleanLower(type);
  return t === "incoming_unread_seen" || t === "dialog_unread_seen_local";
}

function normalizeRoleKey(role, roleKey) {
  const key = cleanLower(roleKey);
  if (key) return key;
  const legacy = String(role || "").toUpperCase();
  if (legacy === "OWNER") return "owner";
  if (legacy === "ADMIN") return "manager";
  if (legacy === "MANAGER") return "manager";
  if (legacy === "OPERATOR") return "chatter";
  return "chatter";
}

async function getMembersShell(agencyId) {
  return prisma.agencyMember.findMany({
    where: { agencyId, deletedAt: null },
    include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
}

function memberShell(member) {
  const display = member.displayName || member.user?.name || member.user?.email || "member";
  return {
    id: member.id,
    userId: member.userId,
    name: display,
    email: member.user?.email || null,
    avatarUrl: member.user?.avatarUrl || null,
    initials: member.initials || String(display || "??").trim().slice(0, 2).toUpperCase(),
    roleKey: normalizeRoleKey(member.role, member.roleKey),
    role: normalizeRoleKey(member.role, member.roleKey),
    legacyRole: member.role,
    assignedCreators: member.assignedCreators ?? "all",
    tone: member.tone || "amber",
    statusBadge: member.statusBadge || null,
    lastSeenLabel: member.lastSeenLabel || null,
    isOwner: member.role === "OWNER" || normalizeRoleKey(member.role, member.roleKey) === "owner",
    isTest: !!member.isTest,
    createdAt: member.createdAt,
  };
}

function emptyMetrics() {
  return {
    messagesSent: 0,
    massMessages: 0,
    botMessages: 0,
    totalMessages: 0,
    postsCreated: 0,
    storiesCreated: 0,
    chatOpened: 0,
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
    incomingMessages: 0,
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
  };
}

function mergeMetricInto(target, raw = {}) {
  const src = safeObject(raw);
  const numericAdds = [
    "messagesSent", "massMessages", "botMessages", "totalMessages", "postsCreated", "storiesCreated",
    "chatOpened", "uniqueFans", "creatorCoverage", "activeEvents", "activeMinutes", "idleGapsCount",
    "incomingMessages", "unansweredIncomingCount", "dialogDwellSeconds", "dialogDwellMinutes",
    "dialogSessionsCount", "revenueAttributedCents",
  ];
  for (const key of numericAdds) target[key] = num(target[key], 0) + num(src[key], 0);

  target.longestIdleMin = Math.max(num(target.longestIdleMin, 0), num(src.longestIdleMin, 0));
  for (const key of ["avgResponseSeconds", "medianResponseSeconds", "p90ResponseSeconds", "avgDialogDwellSeconds", "slaReply5mPct", "slaReply15mPct"]) {
    const n = nullableNum(src[key]);
    if (n !== null) target[key] = n;
  }
  target.responseSamples = num(target.responseSamples, 0) + num(src.responseSamples, 0);
  target.replyProxySamples = num(target.replyProxySamples, 0) + num(src.replyProxySamples, 0);
  return target;
}

function finalizeMetrics(metrics) {
  metrics.totalMessages = num(metrics.totalMessages, 0) || (num(metrics.messagesSent, 0) + num(metrics.massMessages, 0) + num(metrics.botMessages, 0));
  metrics.dialogDwellMinutes = Math.round(num(metrics.dialogDwellSeconds, 0) / 60);
  metrics.dollarsPerMessageCents = metrics.totalMessages > 0
    ? Math.round(num(metrics.revenueAttributedCents, 0) / metrics.totalMessages)
    : 0;
  return metrics;
}

function rowMemberId(event, fallbackMemberId) {
  return event.memberId || fallbackMemberId || "__unassigned__";
}

function fanKey(event) {
  return [event.accountId || event.creatorId || event.creatorRef || "", event.fanId || ""].join("|");
}

function responseKey(event, memberId) {
  return [memberId || "", event.accountId || event.creatorId || event.creatorRef || "", event.fanId || ""].join("|");
}

function dialogFanKey(event) {
  return [event.accountId || event.creatorId || event.creatorRef || "", event.fanId || ""].join("|");
}

async function loadEvents({ agencyId, range }) {
  return prisma.teamActivityEvent.findMany({
    where: { agencyId, ...whereForRange("ts", range) },
    orderBy: { ts: "asc" },
    select: {
      id: true,
      memberId: true,
      userId: true,
      accountId: true,
      creatorId: true,
      creatorRef: true,
      fanId: true,
      type: true,
      ts: true,
      source: true,
      extra: true,
    },
  });
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

async function getMoneyRevenueTotal({ agencyId, range }) {
  const byMember = await getMoneyRevenueByMember({ agencyId, range });
  let total = 0;
  for (const value of byMember.values()) total += num(value, 0);
  return total;
}

function computeFromEvents({ members, events, revenueByMember }) {
  const memberIds = new Set(members.map((m) => String(m.id)));
  const perMember = new Map();
  const fanSets = new Map();
  const creatorSets = new Map();
  const topDialogMap = new Map();
  const incomingByKey = new Map();
  const incomingByIdentity = new Map();
  const responseSamples = new Map();
  const allResponseSamples = [];
  const overview = emptyMetrics();
  const allFans = new Set();
  const allCreators = new Set();

  function ensure(memberId) {
    const id = String(memberId || "__unassigned__");
    if (!perMember.has(id)) perMember.set(id, emptyMetrics());
    if (!fanSets.has(id)) fanSets.set(id, new Set());
    if (!creatorSets.has(id)) creatorSets.set(id, new Set());
    if (!responseSamples.has(id)) responseSamples.set(id, []);
    return perMember.get(id);
  }

  for (const member of members) ensure(member.id);

  for (const event of events || []) {
    const type = cleanLower(event.type);
    const memberId = rowMemberId(event, null);
    const metrics = ensure(memberId);
    const knownMember = memberIds.has(String(memberId));
    const e = safeObject(event.extra);

    if (event.fanId) {
      fanSets.get(String(memberId))?.add(String(event.fanId));
      allFans.add(fanKey(event));
    }
    if (event.creatorId || event.accountId || event.creatorRef) {
      creatorSets.get(String(memberId))?.add(String(event.creatorId || event.accountId || event.creatorRef));
      allCreators.add(String(event.creatorId || event.accountId || event.creatorRef));
    }

    if (OUTGOING_TYPES.has(type)) {
      metrics.messagesSent += 1;
      overview.messagesSent += 1;
    } else if (MASS_TYPES.has(type)) {
      metrics.massMessages += 1;
      overview.massMessages += 1;
    }

    if (type === "bot_message_sent" || type === "ai_message_sent") {
      metrics.botMessages += 1;
      overview.botMessages += 1;
    }

    if (INCOMING_TYPES.has(type)) {
      // Drop the bad legacy events from the previous patch: they used the fan
      // message createdAt as reply timer start, which produced 5h+ fake avg
      // replies. New events always carry observedAt/seenAt.
      if (type === "incoming_unread_seen" && !e.observedAt && !e.seenAt && event.source === "of-api-chat-messages") {
        continue;
      }

      const incomingCount = unreadCountFromExtra(e);
      const incomingTs = incomingObservedTs(event);
      const identity = incomingMessageIdentity(event);
      const detailed = isDetailedUnreadEvent(type);
      let item = incomingByIdentity.get(identity);

      if (item) {
        // /chats list can see the unread first, then /chats/:id/messages gives
        // the real "operator opened this dialog" timestamp. Upgrade instead
        // of double-counting the same last message.
        item.count = Math.max(item.count || 1, incomingCount);
        if (detailed && !item.detailed) {
          item.ts = incomingTs;
          item.detailed = true;
          item.memberId = knownMember ? String(memberId) : item.memberId;
        }
      } else {
        item = {
          ts: incomingTs,
          count: incomingCount,
          answered: false,
          answeredByMemberId: null,
          memberId: knownMember ? String(memberId) : null,
          detailed,
        };
        incomingByIdentity.set(identity, item);
        if (event.fanId) {
          const key = dialogFanKey(event);
          if (!incomingByKey.has(key)) incomingByKey.set(key, []);
          incomingByKey.get(key).push(item);
        }

        overview.incomingMessages += incomingCount;
        if (knownMember) metrics.incomingMessages += incomingCount;
      }
    }

    if (OUTGOING_TYPES.has(type) && event.fanId) {
      const key = dialogFanKey(event);
      const waiting = incomingByKey.get(key) || [];
      const outgoingTs = millisFromValue(event.ts) || Date.now();
      const candidates = waiting.filter((item) => !item.answered && item.ts <= outgoingTs);
      if (candidates.length) {
        // One operator reply resolves the open unread state for this fan/dialog.
        // Response sample starts from when this dialog/unread was seen, not from
        // the fan's original message timestamp hours earlier.
        const base = Math.min(...candidates.map((item) => Number(item.ts || outgoingTs)));
        for (const item of candidates) {
          item.answered = true;
          item.answeredByMemberId = String(memberId);
        }
        const seconds = Math.max(0, Math.round((outgoingTs - base) / 1000));
        responseSamples.get(String(memberId))?.push(seconds);
        allResponseSamples.push(seconds);
      }
    }

    if (CHAT_OPEN_TYPES.has(type)) {
      metrics.chatOpened += 1;
      overview.chatOpened += 1;
    }

    if (ACTIVE_TYPES.has(type)) {
      metrics.activeEvents += 1;
      overview.activeEvents += 1;
    }

    if (type === "post_created") {
      metrics.postsCreated += 1;
      overview.postsCreated += 1;
    }
    if (type === "story_created") {
      metrics.storiesCreated += 1;
      overview.storiesCreated += 1;
    }
    if (CONTENT_TYPES.has(type) && type !== "post_created" && type !== "story_created") {
      metrics.postsCreated += 1;
      overview.postsCreated += 1;
    }

    const dwellSeconds = secondsFromExtra(e);
    if (dwellSeconds > 0 || type.includes("dwell") || type.includes("dialog_session")) {
      metrics.dialogDwellSeconds += dwellSeconds;
      overview.dialogDwellSeconds += dwellSeconds;
      metrics.dialogSessionsCount += 1;
      overview.dialogSessionsCount += 1;
      const topKey = `${String(memberId)}|${fanKey(event)}`;
      const current = topDialogMap.get(topKey) || {
        fanId: event.fanId || null,
        accountId: event.accountId || event.creatorId || event.creatorRef || null,
        sessions: 0,
        dwellSeconds: 0,
        memberId: String(memberId),
      };
      current.sessions += 1;
      current.dwellSeconds += dwellSeconds;
      topDialogMap.set(topKey, current);
    }

    if (MONEY_EVENT_TYPES.has(type)) {
      const cents = amountCentsFromExtra(e);
      if (cents > 0) {
        metrics.revenueAttributedCents += cents;
        overview.revenueAttributedCents += cents;
      }
    }

    const activeSeconds = firstNumber(e.activeSeconds, e.durationSeconds, e.seconds);
    if (activeSeconds !== null && activeSeconds > 0) {
      const mins = Math.max(1, Math.round(activeSeconds / 60));
      metrics.activeMinutes += mins;
      overview.activeMinutes += mins;
    }

    // Unknown member events still count in overview, but member table remains all known agency members.
    if (!knownMember && memberId === "__unassigned__") ensure("__unassigned__");
  }

  for (const [_key, waiting] of incomingByKey.entries()) {
    for (const item of waiting) {
      if (!item.answered) {
        const count = Math.max(1, Math.round(Number(item.count || 1)));
        overview.unansweredIncomingCount += count;
        if (item.memberId && perMember.has(String(item.memberId))) {
          perMember.get(String(item.memberId)).unansweredIncomingCount += count;
        }
      }
    }
  }

  for (const [memberId, samples] of responseSamples.entries()) {
    const metrics = ensure(memberId);
    metrics.responseSamples = samples.length;
    metrics.avgResponseSeconds = avg(samples);
    metrics.medianResponseSeconds = median(samples);
    metrics.p90ResponseSeconds = percentile(samples, 90);
    metrics.slaReply5mPct = percentage(samples.filter((s) => s <= 5 * 60).length, samples.length);
    metrics.slaReply15mPct = percentage(samples.filter((s) => s <= 15 * 60).length, samples.length);
  }

  for (const [memberId, metrics] of perMember.entries()) {
    metrics.uniqueFans = fanSets.get(memberId)?.size || 0;
    metrics.creatorCoverage = creatorSets.get(memberId)?.size || 0;
    metrics.topDialogSessions = Array.from(topDialogMap.values())
      .filter((item) => item.memberId === memberId)
      .sort((a, b) => b.dwellSeconds - a.dwellSeconds)
      .slice(0, 10)
      .map((item) => ({
        fanId: item.fanId,
        accountId: item.accountId,
        sessions: item.sessions,
        dwellSeconds: item.dwellSeconds,
        dwellMinutes: Math.round(item.dwellSeconds / 60),
      }));
    metrics.avgDialogDwellSeconds = metrics.dialogSessionsCount > 0
      ? Math.round(metrics.dialogDwellSeconds / metrics.dialogSessionsCount)
      : null;

    const money = revenueByMember.get(memberId) || 0;
    if (money > 0) {
      metrics.revenueAttributedCents = money;
      metrics.moneySource = "money_attribution";
    }
    finalizeMetrics(metrics);
  }

  overview.uniqueFans = allFans.size;
  overview.activeCreators = allCreators.size;
  overview.activeMembers = Array.from(perMember.entries()).filter(([, m]) => finalizeMetrics({ ...m }).totalMessages > 0 || m.activeEvents > 0 || m.incomingMessages > 0).length;
  overview.eventsCount = (events || []).length;
  overview.responseSamples = allResponseSamples.length;
  overview.avgResponseSeconds = avg(allResponseSamples);
  overview.medianResponseSeconds = median(allResponseSamples);
  overview.p90ResponseSeconds = percentile(allResponseSamples, 90);
  overview.slaReply5mPct = percentage(allResponseSamples.filter((s) => s <= 5 * 60).length, allResponseSamples.length);
  overview.slaReply15mPct = percentage(allResponseSamples.filter((s) => s <= 15 * 60).length, allResponseSamples.length);
  overview.avgDialogDwellSeconds = overview.dialogSessionsCount > 0
    ? Math.round(overview.dialogDwellSeconds / overview.dialogSessionsCount)
    : null;
  finalizeMetrics(overview);

  return { perMember, overview };
}

function unwrapSnapshot(snapshot, key, fallback) {
  const payload = snapshot?.payload || {};
  const value = payload[key];
  return value === undefined || value === null ? fallback : value;
}

function normalizeSnapshotMemberMetrics(raw = {}) {
  return finalizeMetrics(mergeMetricInto(emptyMetrics(), raw));
}

async function loadCommon({ agencyId, rangeKey }) {
  const range = resolveRange(rangeKey);
  const [members, events, revenueByMember, devices] = await Promise.all([
    getMembersShell(agencyId),
    loadEvents({ agencyId, range }),
    getMoneyRevenueByMember({ agencyId, range }),
    prisma.workerDevice.findMany({ where: { agencyId }, orderBy: { lastSeenAt: "desc" } }).catch(() => []),
  ]);
  const computed = computeFromEvents({ members, events, revenueByMember });
  return { range, members, events, revenueByMember, devices, computed };
}

async function buildTeamOverview({ agencyId, rangeKey = "7d" }) {
  const { range, members, devices, computed } = await loadCommon({ agencyId, rangeKey });
  const snapshot = await getLatestPayload({ agencyId, scope: "team_overview", rangeKey: range.key }).catch(() => null);
  const now = Date.now();
  const onlineDevices = (devices || []).filter((d) => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000).length;

  const overview = { ...computed.overview };
  const snapshotOverview = unwrapSnapshot(snapshot, "overview", null);
  if (snapshotOverview && computed.overview.eventsCount === 0) {
    Object.assign(overview, normalizeSnapshotMemberMetrics(snapshotOverview));
  }

  const moneyTotal = await getMoneyRevenueTotal({ agencyId, range });
  if (moneyTotal > 0) {
    overview.revenueAttributedCents = moneyTotal;
    overview.dollarsPerMessageCents = overview.totalMessages > 0 ? Math.round(moneyTotal / overview.totalMessages) : 0;
    overview.moneySource = "money_attribution";
  }

  overview.membersCount = members.length;
  overview.devicesOnline = onlineDevices;
  overview.source = computed.overview.eventsCount > 0 ? "team_activity_events" : (snapshot ? "analytics_snapshot" : "server_empty");

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    overview,
  };
}

async function buildTeamMembers({ agencyId, rangeKey = "7d" }) {
  const { range, members, computed, revenueByMember } = await loadCommon({ agencyId, rangeKey });
  const snapshot = await getLatestPayload({ agencyId, scope: "team_members", rangeKey: range.key }).catch(() => null);
  const snapshotMembers = Array.isArray(snapshot?.payload?.members) ? snapshot.payload.members : [];
  const byId = new Map(snapshotMembers.map((row) => [String(row.member?.id || row.memberId || row.id || ""), row]));

  const rows = members.map((member) => {
    const shell = memberShell(member);
    let metrics = computed.perMember.get(String(member.id)) || emptyMetrics();

    const snap = byId.get(String(member.id)) || {};
    if (computed.overview.eventsCount === 0 && snap.metrics) {
      metrics = normalizeSnapshotMemberMetrics(snap.metrics || {});
    }

    const money = revenueByMember.get(String(member.id)) || 0;
    if (money > 0) {
      metrics.revenueAttributedCents = money;
      metrics.dollarsPerMessageCents = metrics.totalMessages > 0 ? Math.round(money / metrics.totalMessages) : 0;
      metrics.moneySource = "money_attribution";
    }

    return {
      member: { ...shell, ...(snap.member || {}) },
      metrics: finalizeMetrics({ ...metrics }),
      rawSummary: snap.rawSummary || null,
    };
  });

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    members: rows,
    source: computed.overview.eventsCount > 0 ? "team_activity_events" : (snapshot ? "analytics_snapshot" : "server_empty"),
  };
}

async function buildTeamAlerts({ agencyId, rangeKey = "7d" }) {
  const { range, computed } = await loadCommon({ agencyId, rangeKey });
  const snapshot = await getLatestPayload({ agencyId, scope: "team_alerts", rangeKey: range.key }).catch(() => null);
  const alerts = Array.isArray(snapshot?.payload?.alerts) ? snapshot.payload.alerts.slice() : [];

  if (computed.overview.unansweredIncomingCount > 0) {
    alerts.unshift({
      id: "unanswered_incoming",
      tone: "warn",
      title: `${computed.overview.unansweredIncomingCount} unanswered messages`,
      text: "Fan incoming messages have no outgoing operator reply in this range.",
    });
  }
  if (computed.overview.avgResponseSeconds !== null && computed.overview.avgResponseSeconds > 15 * 60) {
    alerts.unshift({
      id: "slow_reply_avg",
      tone: "warn",
      title: "Slow average reply",
      text: `Average response time is ${Math.round(computed.overview.avgResponseSeconds / 60)} minutes.`,
    });
  }

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    alerts,
    source: computed.overview.eventsCount > 0 ? "team_activity_events" : (snapshot ? "analytics_snapshot" : "server_empty"),
  };
}

async function buildTeamFlags({ agencyId, rangeKey = "7d" }) {
  const { range, members, computed } = await loadCommon({ agencyId, rangeKey });
  const snapshot = await getLatestPayload({ agencyId, scope: "team_flags", rangeKey: range.key }).catch(() => null);
  const flags = Array.isArray(snapshot?.payload?.flags) ? snapshot.payload.flags.slice() : [];

  for (const member of members) {
    const shell = memberShell(member);
    const metrics = computed.perMember.get(String(member.id)) || emptyMetrics();
    if (metrics.incomingMessages > 0 && metrics.unansweredIncomingCount >= metrics.incomingMessages) {
      flags.push({
        id: `member_no_replies_${member.id}`,
        tone: "warn",
        title: `${shell.name}: no replies`,
        text: `${metrics.unansweredIncomingCount} incoming messages without reply.`,
        memberId: member.id,
      });
    }
  }

  return {
    ok: true,
    range: rangeForClient(range),
    snapshot: snapshot ? { id: snapshot.id, capturedAt: snapshot.capturedAt, staleSeconds: snapshot.staleSeconds } : null,
    flags,
    source: computed.overview.eventsCount > 0 ? "team_activity_events" : (snapshot ? "analytics_snapshot" : "server_empty"),
  };
}

module.exports = {
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
};
