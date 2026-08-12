"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const { summarizePendingRows } = require("./team-pending-read-service");

const TEAM_TELEMETRY_VERSION = "team_v13_provenance";
const SUPPORTED_TEAM_TELEMETRY_VERSIONS = new Set([
  "team_v8_member_agency_local_fresh",
  "team_v9_message_ppv_ledger",
  "team_v10_server_ppv_resolver",
  "team_v11_ppv_safe_resolver",
  "team_v12_actual_backend_ppv_safe",
  TEAM_TELEMETRY_VERSION,
]);
const SUPPORTED_TEAM_TELEMETRY_SOURCES = new Set([
  "electron_team_v8",
  "electron_team_v9",
  "electron_team_v10",
  "electron_team_v11",
  "electron_team_v12",
  "electron_team_v13",
  "server_ppv_resolver",
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

function buildProjectedResponseSummary(rows) {
  const cases = Array.isArray(rows) ? rows : [];
  const freshSeconds = [];
  const coverageSeconds = [];
  const seenSeconds = [];
  let sla5Passes = 0;
  let sla15Passes = 0;
  let incomingHandled = 0;
  const counts = { FRESH: 0, BACKLOG: 0, HANDOFF: 0, UNKNOWN: 0 };

  for (const row of cases) {
    const classification = String(row?.classification || "UNKNOWN").toUpperCase();
    const key = Object.prototype.hasOwnProperty.call(counts, classification) ? classification : "UNKNOWN";
    counts[key] += 1;
    incomingHandled += Math.max(1, num(row?.incomingCount, 1));

    const coverage = nullableNum(row?.coverageResponseSeconds);
    const seen = nullableNum(row?.seenResponseSeconds);
    if (coverage !== null) coverageSeconds.push(Math.max(0, coverage));
    if (seen !== null) seenSeconds.push(Math.max(0, seen));

    if (row?.slaEligible === true) {
      const wall = nullableNum(row?.wallClockSeconds);
      if (wall !== null) freshSeconds.push(Math.max(0, wall));
      if (row?.sla5Pass === true) sla5Passes += 1;
      if (row?.sla15Pass === true) sla15Passes += 1;
    }
  }

  const responseSamples = freshSeconds.length;
  return {
    source: cases.length ? "team_response_case_v1" : "none",
    cases: cases.length,
    incomingHandled,
    freshReplies: counts.FRESH,
    backlogReplies: counts.BACKLOG,
    handoffReplies: counts.HANDOFF,
    unknownReplies: counts.UNKNOWN,
    responseSamples,
    avgResponseSeconds: mean(freshSeconds),
    medianResponseSeconds: median(freshSeconds),
    p90ResponseSeconds: percentile(freshSeconds, 90),
    slaReply5mPct: responseSamples > 0 ? (sla5Passes / responseSamples) * 100 : null,
    slaReply15mPct: responseSamples > 0 ? (sla15Passes / responseSamples) * 100 : null,
    coverageResponseAvgSeconds: mean(coverageSeconds),
    coverageResponseMedianSeconds: median(coverageSeconds),
    seenResponseAvgSeconds: mean(seenSeconds),
    seenResponseMedianSeconds: median(seenSeconds),
  };
}

function eventExtra(ev) {
  return ev?.extra && typeof ev.extra === "object" ? ev.extra : {};
}

function eventKind(ev) {
  return String(ev?.eventKind || "").trim().toUpperCase();
}

function actionSource(ev) {
  return String(ev?.actionSource || eventExtra(ev).actionSource || "").trim().toUpperCase();
}

function eventMessageId(ev) {
  return String(ev?.messageId || eventExtra(ev).messageId || "").trim();
}

function eventDialogId(ev) {
  return String(ev?.dialogId || ev?.fanId || eventExtra(ev).dialogId || eventExtra(ev).fanId || "").trim();
}

function isCurrentTelemetry(ev) {
  const extra = eventExtra(ev);
  const version = String(extra.telemetryVersion || "");
  const source = String(ev.source || extra.source || "");
  return SUPPORTED_TEAM_TELEMETRY_VERSIONS.has(version) || SUPPORTED_TEAM_TELEMETRY_SOURCES.has(source);
}

function creatorScopeWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const ids = Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

function activePpvFinancialWhere() {
  // Notification-only purchases do not have a payout status yet and remain
  // valid revenue. A later payout `undo` is authoritative reversal evidence.
  return { OR: [{ financialStatus: null }, { financialStatus: { not: "undo" } }] };
}

function ppvFinanciallyActive(row) {
  return String(row?.financialStatus || "").trim().toLowerCase() !== "undo";
}

function activeTipFinancialWhere() {
  return { OR: [{ financialStatus: null }, { financialStatus: { not: "undo" } }] };
}

async function findAllById(model, args = {}, pageSize = 5000) {
  const rows = [];
  let cursorId = null;
  const safePageSize = Math.max(100, Math.min(10000, Number(pageSize) || 5000));
  for (;;) {
    const page = await model.findMany({
      ...args,
      orderBy: { id: "asc" },
      take: safePageSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (!page.length) break;
    rows.push(...page);
    cursorId = String(page[page.length - 1].id || "");
    if (!cursorId || page.length < safePageSize) break;
  }
  return rows;
}

function memberShell(member) {
  return {
    id: member.id,
    userId: member.userId,
    name: member.displayName || member.user?.name || member.user?.email || (String(member.role || "owner").toLowerCase() === "owner" ? "Owner" : "member"),
    email: member.user?.email || null,
    roleKey: member.roleKey || String(member.role || "").toLowerCase(),
    assignedCreators: member.assignedCreators ?? "all",
    functions: Array.from(new Set((member.teamFunctions || []).map((row) => String(row.functionKey || "").toUpperCase()).filter(Boolean))),
  };
}

async function getMembersShell(agencyId) {
  const rows = await findAllById(prisma.agencyMember, {
    where: { agencyId, deletedAt: null },
    include: {
      user: { select: { id: true, email: true, name: true } },
      teamFunctions: { select: { functionKey: true } },
    },
  });
  return rows.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

function emptyMetric() {
  return {
    messagesSent: 0,
    manualMessages: 0,
    massMessages: 0,
    broadcastDispatches: 0,
    automationDeliveries: 0,
    totalMessages: 0,
    postsCreated: 0,
    storiesCreated: 0,
    chatOpened: 0,
    incomingMessages: 0,
    unansweredIncomingCount: 0,
    unansweredIncomingMessages: 0,
    unansweredOlderThan15m: 0,
    unansweredOlderThan60m: 0,
    oldestUnansweredSeconds: null,
    dialogDwellSeconds: 0,
    dialogSessionsCount: 0,
    engagementReplies: 0,
    backlogCleared: 0,
    backlogMaxAgeSeconds: 0,
    ppvSentMessages: 0,
    ppvSoldMessages: 0,
    ppvRevenueCents: 0,
    ppvOpenRatePct: null,
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
    freshReplies: 0,
    backlogReplies: 0,
    handoffReplies: 0,
    unknownReplies: 0,
    coverageResponseAvgSeconds: null,
    coverageResponseMedianSeconds: null,
    seenResponseAvgSeconds: null,
    seenResponseMedianSeconds: null,
    unansweredIncomingCount: 0,
    unansweredIncomingMessages: 0,
    unansweredOlderThan15m: 0,
    unansweredOlderThan60m: 0,
    oldestUnansweredSeconds: null,
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
    _coverageResponseSeconds: [],
    _seenResponseSeconds: [],
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

  metric.manualMessages = metric.messagesSent;
  // totalMessages remains a compatibility volume field. Efficiency metrics use
  // only confirmed human/manual messages and never mass/broadcast deliveries.
  metric.totalMessages = metric.messagesSent + metric.massMessages;
  metric.uniqueFans = metric._fans.size;
  metric.creatorCoverage = metric._creators.size;
  metric.activeEvents = metric.messagesSent + metric.massMessages + metric.incomingMessages + metric.dialogSessionsCount + metric.backlogCleared + metric.ppvSentMessages + metric.ppvSoldMessages;
  metric.dialogDwellMinutes = Math.round(metric.dialogDwellSeconds / 60);
  metric.avgDialogDwellSeconds = metric.dialogSessionsCount > 0 ? metric.dialogDwellSeconds / metric.dialogSessionsCount : null;
  metric.avgResponseSeconds = mean(metric._responseSeconds);
  metric.medianResponseSeconds = median(metric._responseSeconds);
  metric.p90ResponseSeconds = percentile(metric._responseSeconds, 90);
  metric.responseSamples = responseSamples;
  metric.coverageResponseAvgSeconds = mean(metric._coverageResponseSeconds);
  metric.coverageResponseMedianSeconds = median(metric._coverageResponseSeconds);
  metric.seenResponseAvgSeconds = mean(metric._seenResponseSeconds);
  metric.seenResponseMedianSeconds = median(metric._seenResponseSeconds);
  metric.slaReply5mPct = responseSamples > 0 ? (metric._sla5 / responseSamples) * 100 : null;
  metric.slaReply15mPct = responseSamples > 0 ? (metric._sla15 / responseSamples) * 100 : null;
  metric.dollarsPerMessageCents = metric.messagesSent > 0 ? Math.round(metric.revenueAttributedCents / metric.messagesSent) : 0;
  metric.ppvOpenRatePct = metric.ppvSentMessages > 0 ? (metric.ppvSoldMessages / metric.ppvSentMessages) * 100 : null;
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
  delete metric._coverageResponseSeconds;
  delete metric._seenResponseSeconds;
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
  const pendingSeed = String(extra.pendingSeed || "");
  const canonicalKind = eventKind(ev);
  if (canonicalKind) {
    return [
      canonicalKind,
      String(ev.accountId || extra.accountId || ""),
      String(ev.fanId || ev.dialogId || extra.fanId || extra.dialogId || ""),
      eventMessageId(ev) || String(ev.correlationId || ev.broadcastDispatchId || ev.automationDeliveryId || ev.localId || ""),
    ].join("|");
  }

  if (type === "dialog_unread_seen" || type === "dialog_unread_opened") {
    if (String(extra.reason || "") === "messages_api") return null;
    return ["dialog_unread_seen", accountId, fanId, messageId || localSeed || ev.localId || ""].join("|");
  }

  if (type === "fan_message_seen_active" || type === "fan_message_after_last_responder" || type === "creator_fan_incoming_unassigned") {
    return [type, accountId, fanId, messageId || localSeed || ev.localId || ""].join("|");
  }

  if (type === "dialog_unanswered_left") {
    return [type, accountId, fanId, pendingSeed || localSeed || ev.localId || ""].join("|");
  }

  if (type === "sent_message_recorded" || type === "ppv_message_sent_recorded") {
    return [type, accountId, fanId, messageId || localSeed || ev.localId || ""].join("|");
  }

  if (type === "ppv_purchase_attributed" || type === "ppv_purchase_unresolved") {
    return [type, accountId, fanId, messageId || extra.purchaseId || localSeed || ev.localId || ""].join("|");
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

async function loadV3Events({ agencyId, range, allowedCreatorIds = null }) {
  const rows = await findAllById(prisma.teamActivityEvent, {
    where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...whereForRange("ts", range) },
  });
  rows.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
  return dedupeLogicalEvents(rows.filter(isCurrentTelemetry));
}

async function loadPpvPurchaseLedger({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamPpvPurchaseLedger, {
      where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...whereForRange("purchasedAt", range) },
    });
    rows.sort((a, b) => new Date(a.purchasedAt || 0).getTime() - new Date(b.purchasedAt || 0).getTime());
    return rows;
  } catch (_) {
    return [];
  }
}

async function loadProjectedResponseCases({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamResponseCase, {
      where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...whereForRange("replyAt", range) },
    });
    rows.sort((a, b) => new Date(a.replyAt || 0).getTime() - new Date(b.replyAt || 0).getTime());
    return rows;
  } catch (_) {
    return [];
  }
}

async function loadProjectedDialogSessions({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamDialogSession, {
      where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...whereForRange("startedAt", range) },
    });
    rows.sort((a, b) => new Date(a.startedAt || 0).getTime() - new Date(b.startedAt || 0).getTime());
    return rows;
  } catch (_) {
    return [];
  }
}

async function loadProjectedPendingStates({ agencyId, allowedCreatorIds = null }) {
  try {
    if (!prisma.teamPendingDialogState?.findMany) return { available: false, rows: [] };
    const rows = await findAllById(prisma.teamPendingDialogState, {
      where: { agencyId, status: "PENDING", ...creatorScopeWhere(allowedCreatorIds) },
    });
    rows.sort((a, b) => new Date(a.firstIncomingAt || 0).getTime() - new Date(b.firstIncomingAt || 0).getTime());
    return { available: true, rows };
  } catch (_) {
    return { available: false, rows: [] };
  }
}

async function buildComputed({ agencyId, rangeKey = "7d", allowedCreatorIds = null }) {
  const range = resolveRange(rangeKey);
  const [members, events, ppvPurchases, responseCases, projectedDialogSessions, pendingProjection] = await Promise.all([
    getMembersShell(agencyId),
    loadV3Events({ agencyId, range, allowedCreatorIds }),
    loadPpvPurchaseLedger({ agencyId, range, allowedCreatorIds }),
    loadProjectedResponseCases({ agencyId, range, allowedCreatorIds }),
    loadProjectedDialogSessions({ agencyId, range, allowedCreatorIds }),
    loadProjectedPendingStates({ agencyId, allowedCreatorIds }),
  ]);

  const metricsByMember = new Map();
  for (const m of members) metricsByMember.set(String(m.id), emptyMetric());

  function metricFor(memberId) {
    const id = String(memberId || "");
    if (!id) return null;
    if (!metricsByMember.has(id)) metricsByMember.set(id, emptyMetric());
    return metricsByMember.get(id);
  }

  function eventTs(ev) {
    const t = new Date(ev.ts).getTime();
    return Number.isFinite(t) ? t : Date.now();
  }

  function seenTs(ev, extra) {
    const raw = extra.seenAt || extra.observedAt || extra.openedAt || ev.ts;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : eventTs(ev);
  }

  function incomingCount(extra) {
    const n = Number(extra.incomingCount ?? extra.rawUnreadMessagesCount ?? extra.unreadCount ?? 1);
    return Math.max(1, Number.isFinite(n) ? Math.round(n) : 1);
  }

  // account|fan -> pending seen dialog that may become unanswered only after leave.
  const pendingByDialog = new Map();
  const sentByMessageId = new Map();
  // A single OF purchase can appear as:
  // - local attributed event from the worker that has the ledger row
  // - unresolved event from another device
  // - server resolver attributed event
  // Count revenue ONCE per purchaseId, otherwise PPV revenue can silently x2/x3.
  const seenPpvPurchaseIds = new Set();

  // PPV ledger is the money source of truth. If a purchase exists in the
  // ledger as conflict/unresolved/rejected, old activity events must NOT keep
  // leaking revenue into member metrics. This is what makes Claims safe.
  const ledgerPpvPurchaseIds = new Set();
  for (const p of ppvPurchases || []) {
    if (!ppvFinanciallyActive(p)) continue;
    const purchaseId = String(p.purchaseId || "").trim();
    if (purchaseId) ledgerPpvPurchaseIds.add(purchaseId);

    const status = String(p.status || "").toLowerCase();
    if (status !== "attributed" && status !== "resolved") continue;

    const ownerMemberId = String(p.attributedMemberId || "").trim();
    const ownerMetric = metricFor(ownerMemberId);
    if (!ownerMetric) continue;

    const amount = Math.max(0, num(p.amountCents, 0));
    ownerMetric.ppvSoldMessages += 1;
    ownerMetric.ppvRevenueCents += amount;
    ownerMetric.revenueAttributedCents += amount;
    if (p.fanId) ownerMetric._fans.add(String(p.fanId));
    if (p.accountId) ownerMetric._creators.add(String(p.accountId));
    if (purchaseId) seenPpvPurchaseIds.add(purchaseId);
  }

  const hasProjectedResponses = responseCases.length > 0;
  for (const response of responseCases) {
    const m = metricFor(response.memberId);
    if (!m) continue;
    const incomingCount = Math.max(1, num(response.incomingCount, 1));
    m.incomingMessages += incomingCount;
    const classification = String(response.classification || "UNKNOWN").toUpperCase();
    if (classification === "FRESH") m.freshReplies += 1;
    else if (classification === "BACKLOG") {
      m.backlogReplies += 1;
      m.backlogCleared += 1;
      m.backlogMaxAgeSeconds = Math.max(num(m.backlogMaxAgeSeconds, 0), num(response.wallClockSeconds, 0));
    } else if (classification === "HANDOFF") {
      m.handoffReplies += 1;
      m.backlogCleared += 1;
      m.backlogMaxAgeSeconds = Math.max(num(m.backlogMaxAgeSeconds, 0), num(response.wallClockSeconds, 0));
    } else {
      m.unknownReplies += 1;
    }
    const coverageSeconds = nullableNum(response.coverageResponseSeconds);
    const seenSeconds = nullableNum(response.seenResponseSeconds);
    if (coverageSeconds !== null) m._coverageResponseSeconds.push(Math.max(0, coverageSeconds));
    if (seenSeconds !== null) m._seenResponseSeconds.push(Math.max(0, seenSeconds));
    if (response.slaEligible === true) {
      const seconds = Math.max(0, num(response.wallClockSeconds, 0));
      m._responseSeconds.push(seconds);
      if (response.sla5Pass === true) m._sla5 += 1;
      if (response.sla15Pass === true) m._sla15 += 1;
    }
  }

  const hasProjectedDialogSessions = projectedDialogSessions.length > 0;
  for (const session of projectedDialogSessions) {
    const m = metricFor(session.memberId);
    if (!m) continue;
    const activeSeconds = Math.max(0, num(session.activeSeconds, 0));
    m.dialogDwellSeconds += activeSeconds;
    m.dialogSessionsCount += 1;
    const dk = [String(session.creatorId || ""), String(session.dialogId || "")].join("|");
    const prev = m._dialogSessions.get(dk) || {
      fanId: session.fanId || session.dialogId || null,
      accountId: session.creatorId || null,
      sessions: 0,
      dwellSeconds: 0,
    };
    prev.sessions += 1;
    prev.dwellSeconds += activeSeconds;
    m._dialogSessions.set(dk, prev);
  }

  for (const ev of events) {
    const extra = eventExtra(ev);
    const type = String(ev.type || "");
    const canonicalKind = eventKind(ev);
    const isConfirmedSend = canonicalKind === "MESSAGE_SEND_CONFIRMED" && String(ev.lifecycle || "").toUpperCase() === "CONFIRMED";
    if (!isConfirmedSend && type !== "sent_message_recorded" && type !== "ppv_message_sent_recorded") continue;
    const messageId = eventMessageId(ev);
    if (!messageId) continue;
    // message_id is the ownership source of truth. Keep the FIRST owner
    // we saw; never let a later echo/resolver/retry race overwrite it.
    if (!sentByMessageId.has(messageId)) {
      sentByMessageId.set(messageId, {
        memberId: String(ev.memberId || extra.memberId || extra.attributedMemberId || ""),
        fanId: String(ev.fanId || ev.dialogId || extra.fanId || extra.dialogId || ""),
        accountId: String(ev.accountId || extra.accountId || ""),
        priceCents: num(ev.priceCents ?? extra.priceCents, 0),
        isPpv: ev.isPpv === true || extra.isPpv === true || type === "ppv_message_sent_recorded",
        shiftKey: extra.shiftKey || null,
        actionSource: actionSource(ev) || null,
      });
    }
  }

  function getPending(key, defaults = {}) {
    let item = pendingByDialog.get(key);
    if (!item || item.closed) {
      item = {
        key,
        memberId: defaults.memberId || "",
        fanId: defaults.fanId || "",
        accountId: defaults.accountId || "",
        firstSeenAt: defaults.firstSeenAt || Date.now(),
        leftUnanswered: false,
        closed: false,
      };
      pendingByDialog.set(key, item);
    }
    return item;
  }

  for (const ev of events) {
    const extra = eventExtra(ev);
    const memberId = ev.memberId ? String(ev.memberId) : "";
    const m = metricFor(memberId);
    const fanId = String(ev.fanId || extra.fanId || extra.dialogId || "").trim();
    const accountId = String(ev.accountId || extra.accountId || "").trim();
    const type = String(ev.type || "");
    const canonicalKind = eventKind(ev);
    const canonicalSource = actionSource(ev);
    const key = keyFor(ev);

    if (m) {
      if (fanId) m._fans.add(fanId);
      if (accountId) m._creators.add(accountId);
    }

    if (canonicalKind === "FAN_MESSAGE_RECEIVED") {
      // A fan incoming is a creator/dialog fact, never a chatter fact merely
      // because that chatter happened to have the creator open.
      continue;
    }

    if (canonicalKind === "MESSAGE_SEND_CONFIRMED") {
      if (String(ev.lifecycle || "").toUpperCase() !== "CONFIRMED") continue;
      if (canonicalSource === "MANUAL" && m) {
        m.messagesSent += 1;
        if (ev.isPpv === true || num(ev.priceCents, 0) > 0) m.ppvSentMessages += 1;
        const pending = pendingByDialog.get(key);
        if (pending && !pending.closed && Number(pending.firstSeenAt || 0) <= eventTs(ev)) pending.closed = true;
      } else if (canonicalSource === "AUTOMATION" && m) {
        // Normally automation has no human memberId by ingest policy. Keep this
        // defensive branch so malformed legacy rows still cannot count manual.
        m.automationDeliveries += 1;
      }
      continue;
    }

    if (canonicalKind === "BROADCAST_DISPATCH_CONFIRMED") {
      if (m) m.broadcastDispatches += 1;
      continue;
    }

    if (canonicalKind === "DIALOG_SESSION") {
      if (hasProjectedDialogSessions) continue;
      if (m) {
        const dwell = Math.max(0, num(ev.durationSeconds ?? extra.dwellSeconds, 0));
        m.dialogDwellSeconds += dwell;
        m.dialogSessionsCount += 1;
        const dk = [accountId, eventDialogId(ev)].join("|");
        const prev = m._dialogSessions.get(dk) || { fanId: fanId || eventDialogId(ev) || null, accountId: accountId || null, sessions: 0, dwellSeconds: 0 };
        prev.sessions += 1;
        prev.dwellSeconds += dwell;
        m._dialogSessions.set(dk, prev);
      }
      continue;
    }

    if (type === "dialog_unread_seen" || type === "dialog_unread_opened" || type === "fan_message_seen_active") {
      // Seen/opened incoming is NOT member incoming anymore.
      // It only creates a pending dialog. If the member leaves without reply -> unanswered.
      if (m && type !== "fan_message_seen_active") m.chatOpened += 1;

      const firstSeenAt = seenTs(ev, extra);
      const fanMessageAtMs = num(extra.fanMessageAtMs, 0) || firstSeenAt;
      const pending = getPending(key, { memberId, fanId, accountId, firstSeenAt });
      pending.memberId = memberId || pending.memberId;
      pending.fanId = fanId || pending.fanId;
      pending.accountId = accountId || pending.accountId;
      pending.firstSeenAt = Math.min(Number(pending.firstSeenAt || firstSeenAt), firstSeenAt);
      pending.fanMessageAtMs = Math.min(Number(pending.fanMessageAtMs || fanMessageAtMs), fanMessageAtMs);
      continue;
    }

    if (type === "fan_message_after_last_responder") {
      if (m) {
        m.incomingMessages += incomingCount(extra);
        m.engagementReplies += Math.max(1, num(extra.engagementCount, 1));
      }
      // Do NOT create pending/unanswered here: fan wrote in the background.
      // Unanswered appears only after the chatter opens/sees it and leaves without reply.
      continue;
    }

    if (type === "creator_fan_incoming_unassigned") {
      // Global creator flow only. It must not inflate member incoming/unanswered.
      continue;
    }

    if (type === "dialog_unanswered_left") {
      const leftAt = Number(extra.leftAt || eventTs(ev));
      const firstSeenAt = seenTs(ev, extra);
      const pending = getPending(key, { memberId, fanId, accountId, firstSeenAt });
      pending.memberId = memberId || pending.memberId;
      pending.fanId = fanId || pending.fanId;
      pending.accountId = accountId || pending.accountId;
      pending.firstSeenAt = Math.min(Number(pending.firstSeenAt || firstSeenAt), firstSeenAt);
      pending.leftUnanswered = true;
      pending.leftAt = leftAt;
      continue;
    }

    if (type === "sent_message_recorded" || type === "ppv_message_sent_recorded") {
      if (m && (type === "ppv_message_sent_recorded" || extra.isPpv === true)) {
        m.ppvSentMessages += 1;
      }
      continue;
    }

    if (type === "ppv_purchase_attributed" || type === "ppv_purchase_unresolved") {
      const messageId = String(extra.messageId || "").trim();
      const purchaseId = String(extra.purchaseId || extra.purchase_id || "").trim();
      // If the purchase is known to the ledger, the ledger already decided
      // whether it is attributed, conflict, unresolved or rejected. Do not let
      // legacy activity events override that decision.
      if (purchaseId && ledgerPpvPurchaseIds.has(purchaseId)) continue;
      // Prefer real purchase_id. Fallback keeps the aggregation safe if an older
      // event missed purchaseId but still has messageId + amount + purchasedAt.
      const purchaseKey = purchaseId || [accountId, messageId, String(extra.amountCents || ""), String(extra.purchasedAt || extra.purchasedAtMs || eventTs(ev))].join("|");
      if (purchaseKey) {
        if (seenPpvPurchaseIds.has(purchaseKey)) continue;
        seenPpvPurchaseIds.add(purchaseKey);
      }

      const owner = messageId ? sentByMessageId.get(messageId) : null;
      const ownerMemberId = String(ev.memberId || extra.attributedMemberId || owner?.memberId || "").trim();
      const ownerMetric = metricFor(ownerMemberId);
      if (ownerMetric) {
        const amount = Math.max(0, num(extra.amountCents, 0));
        ownerMetric.ppvSoldMessages += 1;
        ownerMetric.ppvRevenueCents += amount;
        ownerMetric.revenueAttributedCents += amount;
        if (fanId) ownerMetric._fans.add(fanId);
        if (accountId) ownerMetric._creators.add(accountId);
      }
      continue;
    }

    if (type === "chat_message_sent_local") {
      if (m) m.messagesSent += 1;

      const evTs = eventTs(ev);
      const pending = pendingByDialog.get(key);
      if (pending && !pending.closed && Number(pending.firstSeenAt || 0) <= evTs) pending.closed = true;

      const isBacklogReply = extra.isBacklogReply === true;
      const isFreshReply = extra.isFreshReply === true || (extra.isBacklogReply !== true && extra.replySeconds !== null && extra.replySeconds !== undefined);
      const backlogAgeSeconds = nullableNum(extra.backlogAgeSeconds);
      if (isBacklogReply) {
        if (m) {
          m.backlogCleared += 1;
          if (backlogAgeSeconds !== null) m.backlogMaxAgeSeconds = Math.max(num(m.backlogMaxAgeSeconds, 0), backlogAgeSeconds);
        }
        continue;
      }

      const suppliedReplySeconds = nullableNum(extra.replySeconds);
      if (!hasProjectedResponses && isFreshReply && suppliedReplySeconds !== null) {
        const seconds = Math.max(0, Math.round(suppliedReplySeconds));
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

  for (const p of pendingByDialog.values()) {
    if (!p.closed && p.leftUnanswered) {
      const m = metricFor(p.memberId);
      if (m) m.unansweredIncomingCount += 1;
    }
  }

  const hasProjectedPending = pendingProjection?.available === true;
  const pendingRows = hasProjectedPending ? (pendingProjection.rows || []) : [];
  const pendingSummary = hasProjectedPending ? summarizePendingRows(pendingRows) : null;

  if (hasProjectedPending) {
    // Projected current queue replaces the older Alpha unread/open heuristic.
    // Team-level unassigned rows stay visible in pendingSummary, but are never
    // blamed on a chatter until trusted DIALOG_SEEN evidence assigns an owner.
    for (const metric of metricsByMember.values()) {
      metric.unansweredIncomingCount = 0;
      metric.unansweredIncomingMessages = 0;
      metric.unansweredOlderThan15m = 0;
      metric.unansweredOlderThan60m = 0;
      metric.oldestUnansweredSeconds = null;
    }
    const nowMs = Date.now();
    for (const pending of pendingRows) {
      const owner = metricFor(pending.ownerMemberId);
      if (!owner) continue;
      owner.unansweredIncomingCount += 1;
      owner.unansweredIncomingMessages += Math.max(1, num(pending.incomingCount, 1));
      const firstAt = new Date(pending.firstIncomingAt || 0).getTime();
      if (Number.isFinite(firstAt) && firstAt > 0) {
        const age = Math.max(0, Math.floor((nowMs - firstAt) / 1000));
        if (age >= 15 * 60) owner.unansweredOlderThan15m += 1;
        if (age >= 60 * 60) owner.unansweredOlderThan60m += 1;
        owner.oldestUnansweredSeconds = owner.oldestUnansweredSeconds === null ? age : Math.max(owner.oldestUnansweredSeconds, age);
      }
    }
  } else if (hasProjectedResponses) {
    // Completed response cases are authoritative, so do not mix them with the
    // legacy pending heuristic when the additive pending migration is missing.
    for (const metric of metricsByMember.values()) {
      metric.unansweredIncomingCount = null;
      metric.unansweredIncomingMessages = null;
      metric.unansweredOlderThan15m = null;
      metric.unansweredOlderThan60m = null;
      metric.oldestUnansweredSeconds = null;
    }
  }

  const byMember = new Map();
  for (const [memberId, metric] of metricsByMember.entries()) byMember.set(memberId, cleanMetric(metric));
  const responseSummary = buildProjectedResponseSummary(responseCases);

  return {
    range,
    members,
    events,
    byMember,
    responseSummary,
    pendingSummary,
    projection: {
      responseCases: responseCases.length,
      dialogSessions: projectedDialogSessions.length,
      responseSource: hasProjectedResponses ? "team_response_case_v1" : "legacy_event_fallback",
      dialogSessionSource: hasProjectedDialogSessions ? "team_dialog_session_v1" : "event_fallback",
      unansweredSource: hasProjectedPending ? "team_pending_dialog_v1" : (hasProjectedResponses ? "not_projected" : "legacy_event_fallback"),
      creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
    },
  };
}

const LEGACY_TIP_MONEY_TYPES = ["tip_received"];
const ATTRIBUTED_PPV_STATUSES = ["attributed", "resolved"];
const ATTRIBUTED_TIP_STATUSES = ["attributed", "claimed", "resolved"];

function addToMap(map, key, cents) {
  const safeKey = String(key || "").trim();
  if (!safeKey) return;
  map.set(safeKey, (map.get(safeKey) || 0) + Math.max(0, num(cents, 0)));
}

function mergeRevenueMaps(...maps) {
  const out = new Map();
  for (const map of maps || []) {
    for (const [key, value] of map?.entries?.() || []) addToMap(out, key, value);
  }
  return out;
}

async function getLegacyTipRevenueByMember({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await prisma.moneyAttribution.groupBy({
      by: ["attributedToMemberId"],
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        eventType: { in: LEGACY_TIP_MONEY_TYPES },
        attributedToMemberId: { not: null },
        ...whereForRange("occurredAt", range),
      },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      if (row.attributedToMemberId) addToMap(map, row.attributedToMemberId, row?._sum?.amountCents);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function getLegacyTipRevenueByMemberDialog({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await prisma.moneyAttribution.groupBy({
      by: ["attributedToMemberId", "fanId"],
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        eventType: { in: LEGACY_TIP_MONEY_TYPES },
        attributedToMemberId: { not: null },
        fanId: { not: null },
        ...whereForRange("occurredAt", range),
      },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      if (!row.attributedToMemberId || !row.fanId) continue;
      addToMap(map, `${row.attributedToMemberId}|${row.fanId}`, row?._sum?.amountCents);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function getPpvLedgerRevenueByMember({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await prisma.teamPpvPurchaseLedger.groupBy({
      by: ["attributedMemberId"],
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        ...activePpvFinancialWhere(),
        status: { in: ATTRIBUTED_PPV_STATUSES },
        attributedMemberId: { not: null },
        ...whereForRange("purchasedAt", range),
      },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      if (row.attributedMemberId) addToMap(map, row.attributedMemberId, row?._sum?.amountCents);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function getPpvLedgerRevenueByMemberDialog({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamPpvPurchaseLedger, {
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        ...activePpvFinancialWhere(),
        status: { in: ATTRIBUTED_PPV_STATUSES },
        attributedMemberId: { not: null },
        ...whereForRange("purchasedAt", range),
      },
      select: { id: true, attributedMemberId: true, fanId: true, buyerFanId: true, dialogId: true, amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      const fanKey = row.fanId || row.buyerFanId || row.dialogId;
      if (!row.attributedMemberId || !fanKey) continue;
      addToMap(map, `${row.attributedMemberId}|${fanKey}`, row.amountCents);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function getTipLedgerRevenueByMember({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await prisma.teamTipLedger.groupBy({
      by: ["attributedMemberId"],
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        ...activeTipFinancialWhere(),
        status: { in: ATTRIBUTED_TIP_STATUSES },
        attributedMemberId: { not: null },
        ...whereForRange("receivedAt", range),
      },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      if (row.attributedMemberId) addToMap(map, row.attributedMemberId, row?._sum?.amountCents);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

async function getTipLedgerRevenueByMemberDialog({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamTipLedger, {
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        ...activeTipFinancialWhere(),
        status: { in: ATTRIBUTED_TIP_STATUSES },
        attributedMemberId: { not: null },
        ...whereForRange("receivedAt", range),
      },
      select: { id: true, attributedMemberId: true, fanId: true, dialogId: true, amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      const fanKey = row.fanId || row.dialogId;
      if (!row.attributedMemberId || !fanKey) continue;
      addToMap(map, `${row.attributedMemberId}|${fanKey}`, row.amountCents);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}


async function buildTeamMembers({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const computed = await buildComputed({ agencyId, rangeKey, allowedCreatorIds });
  const [
    ppvRevenueByMember,
    tipLedgerRevenueByMember,
    legacyTipRevenueByMember,
    ppvRevenueByMemberDialog,
    tipLedgerRevenueByMemberDialog,
    legacyTipRevenueByMemberDialog,
  ] = includeMoney ? await Promise.all([
    getPpvLedgerRevenueByMember({ agencyId, range: computed.range, allowedCreatorIds }),
    getTipLedgerRevenueByMember({ agencyId, range: computed.range, allowedCreatorIds }),
    getLegacyTipRevenueByMember({ agencyId, range: computed.range, allowedCreatorIds }),
    getPpvLedgerRevenueByMemberDialog({ agencyId, range: computed.range, allowedCreatorIds }),
    getTipLedgerRevenueByMemberDialog({ agencyId, range: computed.range, allowedCreatorIds }),
    getLegacyTipRevenueByMemberDialog({ agencyId, range: computed.range, allowedCreatorIds }),
  ]) : [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
  const revenueByMember = mergeRevenueMaps(ppvRevenueByMember, tipLedgerRevenueByMember, legacyTipRevenueByMember);
  const revenueByMemberDialog = mergeRevenueMaps(ppvRevenueByMemberDialog, tipLedgerRevenueByMemberDialog, legacyTipRevenueByMemberDialog);

  const rows = computed.members.map((member) => {
    const shell = memberShell(member);
    const metrics = computed.byMember.get(String(member.id)) || cleanMetric(emptyMetric());
    const revenue = revenueByMember.get(String(member.id)) || 0;
    if (includeMoney && revenue > 0) {
      metrics.revenueAttributedCents = revenue;
      metrics.dollarsPerMessageCents = metrics.messagesSent > 0 ? Math.round(revenue / metrics.messagesSent) : 0;
      metrics.moneySource = "ppv_ledger_plus_tip_ledger_with_legacy_tip_fallback";
    }
    if (!includeMoney) {
      metrics.revenueAttributedCents = null;
      metrics.dollarsPerMessageCents = null;
      metrics.ppvRevenueCents = null;
      metrics.ppvSoldMessages = null;
      metrics.ppvOpenRatePct = null;
      metrics.moneySource = null;
    }
    if (Array.isArray(metrics.topDialogSessions)) {
      metrics.topDialogSessions = metrics.topDialogSessions.map((item) => {
        const cents = includeMoney ? (revenueByMemberDialog.get(`${shell.id}|${item.fanId || ""}`) || 0) : null;
        const sharePct = metrics.dialogDwellSeconds > 0 ? Math.round((num(item.dwellSeconds, 0) / metrics.dialogDwellSeconds) * 100) : 0;
        return includeMoney
          ? { ...item, shiftRevenueCents: cents, shiftRevenueUsd: Math.round(cents || 0) / 100, shiftTimeSharePct: sharePct }
          : { ...item, shiftTimeSharePct: sharePct };
      });
    }
    return { member: shell, metrics, rawSummary: null };
  });

  return {
    ok: true,
    range: rangeForClient(computed.range),
    snapshot: null,
    members: rows,
    source: "team_activity_event_v13",
    projection: computed.projection,
    responseSummary: computed.responseSummary,
    pendingSummary: computed.pendingSummary || null,
    moneyVisible: includeMoney === true,
  };
}

function combineOverview(metricsList, membersCount) {
  const out = {
    totalMessages: 0,
    messagesSent: 0,
    manualMessages: 0,
    massMessages: 0,
    broadcastDispatches: 0,
    automationDeliveries: 0,
    botMessages: 0,
    postsCreated: 0,
    storiesCreated: 0,
    chatOpened: 0,
    incomingMessages: 0,
    unansweredIncomingCount: 0,
    unansweredIncomingMessages: 0,
    unassignedUnansweredCount: 0,
    unansweredOlderThan15m: 0,
    unansweredOlderThan60m: 0,
    oldestUnansweredSeconds: null,
    dialogDwellSeconds: 0,
    dialogSessionsCount: 0,
    engagementReplies: 0,
    backlogCleared: 0,
    backlogMaxAgeSeconds: 0,
    ppvSentMessages: 0,
    ppvSoldMessages: 0,
    ppvRevenueCents: 0,
    ppvOpenRatePct: null,
    uniqueFans: 0,
    activeCreators: 0,
    activeMembers: 0,
    membersCount,
    devicesOnline: 0,
    eventsCount: 0,
    revenueAttributedCents: 0,
    dollarsPerMessageCents: 0,
    avgResponseSeconds: null,
    medianResponseSeconds: null,
    p90ResponseSeconds: null,
    responseSamples: 0,
    freshReplies: 0,
    backlogReplies: 0,
    handoffReplies: 0,
    unknownReplies: 0,
    coverageResponseAvgSeconds: null,
    coverageResponseMedianSeconds: null,
    seenResponseAvgSeconds: null,
    seenResponseMedianSeconds: null,
    slaReply5mPct: null,
    slaReply15mPct: null,
    source: "team_activity_event_v13",
  };
  const fans = new Set();
  const responses = [];
  let sla15Good = 0;
  let sla15Samples = 0;

  for (const m of metricsList) {
    out.messagesSent += num(m.messagesSent, 0);
    out.manualMessages += num(m.messagesSent, 0);
    out.massMessages += num(m.massMessages, 0);
    out.broadcastDispatches += num(m.broadcastDispatches, 0);
    out.automationDeliveries += num(m.automationDeliveries, 0);
    out.totalMessages += num(m.totalMessages, 0);
    out.postsCreated += num(m.postsCreated, 0);
    out.storiesCreated += num(m.storiesCreated, 0);
    out.chatOpened += num(m.chatOpened, 0);
    out.incomingMessages += num(m.incomingMessages, 0);
    out.unansweredIncomingCount += num(m.unansweredIncomingCount, 0);
    out.unansweredIncomingMessages += num(m.unansweredIncomingMessages, 0);
    out.unansweredOlderThan15m += num(m.unansweredOlderThan15m, 0);
    out.unansweredOlderThan60m += num(m.unansweredOlderThan60m, 0);
    const memberOldestUnanswered = nullableNum(m.oldestUnansweredSeconds);
    if (memberOldestUnanswered !== null) out.oldestUnansweredSeconds = out.oldestUnansweredSeconds === null ? memberOldestUnanswered : Math.max(out.oldestUnansweredSeconds, memberOldestUnanswered);
    out.dialogDwellSeconds += num(m.dialogDwellSeconds, 0);
    out.dialogSessionsCount += num(m.dialogSessionsCount, 0);
    out.engagementReplies += num(m.engagementReplies, 0);
    out.backlogCleared += num(m.backlogCleared, 0);
    out.backlogMaxAgeSeconds = Math.max(num(out.backlogMaxAgeSeconds, 0), num(m.backlogMaxAgeSeconds, 0));
    out.responseSamples += num(m.responseSamples, 0);
    out.freshReplies += num(m.freshReplies, 0);
    out.backlogReplies += num(m.backlogReplies, 0);
    out.handoffReplies += num(m.handoffReplies, 0);
    out.unknownReplies += num(m.unknownReplies, 0);
    out.ppvSentMessages += num(m.ppvSentMessages, 0);
    out.ppvSoldMessages += num(m.ppvSoldMessages, 0);
    out.ppvRevenueCents += num(m.ppvRevenueCents, 0);
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
  out.dollarsPerMessageCents = out.messagesSent > 0 ? Math.round(out.revenueAttributedCents / out.messagesSent) : 0;
  out.ppvOpenRatePct = out.ppvSentMessages > 0 ? (out.ppvSoldMessages / out.ppvSentMessages) * 100 : null;
  return out;
}

async function buildTeamOverview({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const membersPayload = await buildTeamMembers({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
  const overview = combineOverview(membersPayload.members.map((r) => r.metrics), membersPayload.members.length);
  const responseSummary = membersPayload.responseSummary;
  if (responseSummary?.source === "team_response_case_v1") {
    overview.incomingMessages = responseSummary.incomingHandled;
    overview.freshReplies = responseSummary.freshReplies;
    overview.backlogReplies = responseSummary.backlogReplies;
    overview.handoffReplies = responseSummary.handoffReplies;
    overview.unknownReplies = responseSummary.unknownReplies;
    overview.responseSamples = responseSummary.responseSamples;
    overview.avgResponseSeconds = responseSummary.avgResponseSeconds;
    overview.medianResponseSeconds = responseSummary.medianResponseSeconds;
    overview.p90ResponseSeconds = responseSummary.p90ResponseSeconds;
    overview.slaReply5mPct = responseSummary.slaReply5mPct;
    overview.slaReply15mPct = responseSummary.slaReply15mPct;
    overview.coverageResponseAvgSeconds = responseSummary.coverageResponseAvgSeconds;
    overview.coverageResponseMedianSeconds = responseSummary.coverageResponseMedianSeconds;
    overview.seenResponseAvgSeconds = responseSummary.seenResponseAvgSeconds;
    overview.seenResponseMedianSeconds = responseSummary.seenResponseMedianSeconds;
  }
  if (membersPayload.pendingSummary?.source === "team_pending_dialog_v1") {
    overview.unansweredIncomingCount = membersPayload.pendingSummary.pendingDialogs;
    overview.unansweredIncomingMessages = membersPayload.pendingSummary.pendingIncomingMessages;
    overview.unassignedUnansweredCount = membersPayload.pendingSummary.unassignedDialogs;
    overview.unansweredOlderThan15m = membersPayload.pendingSummary.olderThan15m;
    overview.unansweredOlderThan60m = membersPayload.pendingSummary.olderThan60m;
    overview.oldestUnansweredSeconds = membersPayload.pendingSummary.oldestPendingSeconds;
  } else if (membersPayload.projection?.unansweredSource === "not_projected") {
    overview.unansweredIncomingCount = null;
    overview.unansweredIncomingMessages = null;
    overview.unassignedUnansweredCount = null;
    overview.unansweredOlderThan15m = null;
    overview.unansweredOlderThan60m = null;
    overview.oldestUnansweredSeconds = null;
  }
  if (!includeMoney) {
    overview.revenueAttributedCents = null;
    overview.dollarsPerMessageCents = null;
    overview.ppvRevenueCents = null;
    overview.ppvSoldMessages = null;
    overview.ppvOpenRatePct = null;
  }
  return {
    ok: true,
    range: membersPayload.range,
    snapshot: null,
    overview,
    projection: membersPayload.projection || null,
    responseSummary: membersPayload.responseSummary || null,
    pendingSummary: membersPayload.pendingSummary || null,
    moneyVisible: includeMoney === true,
  };
}

async function buildTeamAlerts({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const membersPayload = await buildTeamMembers({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
  const alerts = [];
  if (includeMoney) {
    try {
      const [jobConflicts, purchaseConflicts, tipConflicts] = await Promise.all([
        prisma.teamPpvResolveJob.count({ where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), status: "conflict" } }),
        prisma.teamPpvPurchaseLedger.count({ where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...activePpvFinancialWhere(), status: "conflict" } }),
        prisma.teamTipLedger.count({ where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...activeTipFinancialWhere(), status: "conflict" } }).catch(() => 0),
      ]);
      const conflictCount = Math.max(num(jobConflicts, 0), num(purchaseConflicts, 0));
      if (conflictCount > 0) {
        alerts.push({
          id: "ppv_conflicts",
          tone: "danger",
          title: `${conflictCount} PPV attribution conflicts`,
          text: "Some PPV purchases were claimed by multiple workers and need manager review.",
        });
      }
      if (num(tipConflicts, 0) > 0) {
        alerts.push({
          id: "tip_conflicts",
          tone: "warn",
          title: `${tipConflicts} tip attribution conflicts`,
          text: "Some tips have multiple recent chatters in the 10-minute window and need manager review.",
        });
      }
    } catch (_) {}
  }

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
    if (num(m.backlogCleared, 0) > 0) {
      alerts.push({
        id: `backlog_${row.member.id}`,
        tone: "warn",
        title: `${name}: ${m.backlogCleared} old backlog replies`,
        text: "Old fan messages were answered but excluded from avg reply/SLA.",
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
    const topDialog = Array.isArray(m.topDialogSessions) ? m.topDialogSessions[0] : null;
    if (topDialog && num(m.dialogDwellSeconds, 0) >= 15 * 60 && num(topDialog.shiftTimeSharePct, 0) >= 80) {
      const dollars = includeMoney ? (num(topDialog.shiftRevenueCents, 0) / 100).toFixed(2) : null;
      alerts.push({
        id: `focus_dialog_${row.member.id}_${topDialog.fanId || "unknown"}`,
        tone: includeMoney && num(topDialog.shiftRevenueCents, 0) > 0 ? "warn" : "danger",
        title: `${name}: ${topDialog.shiftTimeSharePct}% shift time in one dialog`,
        text: includeMoney
          ? `Fan ${topDialog.fanId || "unknown"}: ${Math.round(num(topDialog.dwellSeconds, 0) / 60)} min, earned this shift $${dollars}.`
          : `Fan ${topDialog.fanId || "unknown"}: ${Math.round(num(topDialog.dwellSeconds, 0) / 60)} min.`,
        memberId: row.member.id,
      });
    }
  }
  return { ok: true, range: membersPayload.range, snapshot: null, alerts, source: "team_activity_event_v13" };
}

async function buildTeamFlags({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const alerts = await buildTeamAlerts({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
  return { ok: true, range: alerts.range, snapshot: null, flags: alerts.alerts || [], source: "team_activity_event_v13" };
}

module.exports = {
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
};
