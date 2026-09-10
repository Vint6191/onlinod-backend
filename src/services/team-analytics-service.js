"use strict";

const prisma = require("../prisma");
const { resolveRange, rangeForClient, whereForRange } = require("./range-service");
const { summarizePendingRows } = require("./team-pending-read-service");
const { getRetentionSettings } = require("./retention-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { coverageState, buildProjectionDetailAuthority } = require("./team-historical-range-authority-service");
const { phase2CoverageStatus, FAMILY: PHASE2_COVERAGE_FAMILY, GENERATION: PHASE2_COVERAGE_GENERATION } = require("./phase2-work-coverage-authority-service");

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
    status: member.deletedAt ? "removed" : (member.deactivatedAt ? "deactivated" : "active"),
    deactivatedAt: member.deactivatedAt || null,
    deletedAt: member.deletedAt || null,
    assignedCreators: member.assignedCreators ?? "all",
    functions: Array.from(new Set((member.teamFunctions || []).map((row) => String(row.functionKey || "").toUpperCase()).filter(Boolean))),
  };
}

async function getMembersShell(agencyId) {
  const rows = await findAllById(prisma.agencyMember, {
    where: { agencyId },
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
    contentActions: 0,
    contentMediaItemsPublished: 0,
    contentCreatorCoverage: 0,
    contentActiveDays: 0,
    lastContentActivityAt: null,
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
    ppvRevenueCurrency: null,
    ppvRevenueByCurrency: {},
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
    revenueByCurrency: {},
    revenueCurrency: null,
    dollarsPerMessageCents: 0,

    // internal accumulators
    _fans: new Set(),
    _creators: new Set(),
    _contentCreators: new Set(),
    _contentDays: new Set(),
    _responseSeconds: [],
    _coverageResponseSeconds: [],
    _seenResponseSeconds: [],
    _sla5: 0,
    _sla15: 0,
    _dialogSessions: new Map(),
    _ppvRevenueByCurrency: new Map(),
  };
}

function cleanMetric(metric) {
  const accumulatedResponseSamples = metric._responseSeconds.length;
  const dialogSessions = Array.from(metric._dialogSessions.values())
    .sort((a, b) => b.dwellSeconds - a.dwellSeconds)
    .slice(0, 10);

  metric.manualMessages = metric.messagesSent;
  // totalMessages remains a compatibility volume field. Efficiency metrics use
  // only confirmed human/manual messages and never mass/broadcast deliveries.
  metric.totalMessages = metric.messagesSent + metric.massMessages;
  // Legacy materialization populates Set/array accumulators. The production
  // scale read authority writes already-aggregated SQL values directly. Never
  // erase a SQL aggregate merely because its legacy accumulator is empty.
  metric.uniqueFans = Math.max(Math.max(0, num(metric.uniqueFans, 0)), metric._fans.size);
  metric.creatorCoverage = Math.max(Math.max(0, num(metric.creatorCoverage, 0)), metric._creators.size);
  metric.contentCreatorCoverage = Math.max(Math.max(0, num(metric.contentCreatorCoverage, 0)), metric._contentCreators.size);
  metric.contentActiveDays = Math.max(Math.max(0, num(metric.contentActiveDays, 0)), metric._contentDays.size);
  metric.activeEvents = metric.messagesSent + metric.massMessages + metric.incomingMessages + metric.dialogSessionsCount + metric.backlogCleared + metric.ppvSentMessages + metric.ppvSoldMessages + metric.contentActions;
  metric.dialogDwellMinutes = Math.round(metric.dialogDwellSeconds / 60);
  metric.avgDialogDwellSeconds = metric.dialogSessionsCount > 0 ? metric.dialogDwellSeconds / metric.dialogSessionsCount : null;
  if (accumulatedResponseSamples > 0) {
    metric.avgResponseSeconds = mean(metric._responseSeconds);
    metric.medianResponseSeconds = median(metric._responseSeconds);
    metric.p90ResponseSeconds = percentile(metric._responseSeconds, 90);
    metric.responseSamples = accumulatedResponseSamples;
    metric.slaReply5mPct = (metric._sla5 / accumulatedResponseSamples) * 100;
    metric.slaReply15mPct = (metric._sla15 / accumulatedResponseSamples) * 100;
  }
  if (metric._coverageResponseSeconds.length > 0) {
    metric.coverageResponseAvgSeconds = mean(metric._coverageResponseSeconds);
    metric.coverageResponseMedianSeconds = median(metric._coverageResponseSeconds);
  }
  if (metric._seenResponseSeconds.length > 0) {
    metric.seenResponseAvgSeconds = mean(metric._seenResponseSeconds);
    metric.seenResponseMedianSeconds = median(metric._seenResponseSeconds);
  }
  metric.dollarsPerMessageCents = metric.messagesSent > 0 ? Math.round(metric.revenueAttributedCents / metric.messagesSent) : 0;
  const ppvRevenue = singleCurrencyValue(metric._ppvRevenueByCurrency);
  metric.ppvRevenueByCurrency = currencyBucketObject(metric._ppvRevenueByCurrency);
  metric.ppvRevenueCurrency = ppvRevenue.currency;
  metric.ppvRevenueCents = ppvRevenue.cents;
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
  delete metric._contentCreators;
  delete metric._contentDays;
  delete metric._responseSeconds;
  delete metric._coverageResponseSeconds;
  delete metric._seenResponseSeconds;
  delete metric._sla5;
  delete metric._sla15;
  delete metric._dialogSessions;
  delete metric._ppvRevenueByCurrency;
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

function analyticsUnavailable(section, err) {
  const error = new Error(`Team analytics ${section} is temporarily unavailable`);
  error.code = "TEAM_ANALYTICS_DATA_UNAVAILABLE";
  error.status = 503;
  error.section = section;
  if (err) error.cause = err;
  return error;
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

async function loadHistoricalCoverage({ agencyId }) {
  try {
    if (!prisma.teamHistoricalAnalyticsCoverage?.findUnique) throw new Error("TeamHistoricalAnalyticsCoverage model unavailable");
    const row = await prisma.teamHistoricalAnalyticsCoverage.findUnique({ where: { agencyId } });
    if (!row) throw new Error("TeamHistoricalAnalyticsCoverage row unavailable");
    return {
      activityCoverageFrom: row.activityCoverageFrom ? new Date(row.activityCoverageFrom) : null,
      moneyCoverageFrom: row.moneyCoverageFrom ? new Date(row.moneyCoverageFrom) : null,
      activityProjectionVersion: String(row.activityProjectionVersion || "team_activity_daily_v1"),
      moneyProjectionVersion: String(row.moneyProjectionVersion || "team_money_fact_v2"),
      source: String(row.source || "phase2_historical_authority"),
    };
  } catch (err) {
    throw analyticsUnavailable("historical_coverage", err);
  }
}

async function loadActivityDaily({ agencyId, range, allowedCreatorIds = null }) {
  try {
    if (!prisma.teamMemberActivityDaily?.findMany) throw new Error("TeamMemberActivityDaily model unavailable");
    const rows = await prisma.teamMemberActivityDaily.findMany({
      where: {
        agencyId,
        ...creatorScopeWhere(allowedCreatorIds),
        ...whereForRange("day", range),
      },
      orderBy: [{ day: "asc" }, { id: "asc" }],
    });
    return rows || [];
  } catch (err) {
    throw analyticsUnavailable("activity_history", err);
  }
}

async function loadPpvMoneyFacts({ agencyId, range, allowedCreatorIds = null }) {
  try {
    if (!prisma.teamMoneyAttributionFact?.findMany) throw new Error("TeamMoneyAttributionFact model unavailable");
    const rows = await findAllById(prisma.teamMoneyAttributionFact, {
      where: {
        agencyId,
        sourceType: "PPV",
        classificationState: "CANONICAL",
        ...creatorScopeWhere(allowedCreatorIds),
        ...whereForRange("occurredAt", range),
      },
    });
    rows.sort((a, b) => new Date(a.occurredAt || 0).getTime() - new Date(b.occurredAt || 0).getTime());
    return rows;
  } catch (err) {
    throw analyticsUnavailable("ppv_historical_fact", err);
  }
}

function clampRangeToDetail(range, detailDays) {
  const endAt = range?.endAt ? new Date(range.endAt) : new Date();
  const cutoff = new Date(endAt.getTime() - Math.max(1, Number(detailDays) || 180) * 86400000);
  const requestedStart = range?.startAt ? new Date(range.startAt) : null;
  const startAt = requestedStart && requestedStart.getTime() > cutoff.getTime() ? requestedStart : cutoff;
  if (startAt.getTime() > endAt.getTime()) return null;
  return { ...range, startAt, endAt };
}

async function loadProjectionCoverage({ agencyId }) {
  try {
    if (!prisma.teamProjectionCoverage?.findUnique) throw new Error("TeamProjectionCoverage model unavailable");
    const row = await prisma.teamProjectionCoverage.findUnique({ where: { agencyId } });
    if (!row) throw new Error("TeamProjectionCoverage row unavailable");
    return {
      available: true,
      responseCoverageFrom: row.responseCoverageFrom ? new Date(row.responseCoverageFrom) : null,
      dialogCoverageFrom: row.dialogCoverageFrom ? new Date(row.dialogCoverageFrom) : null,
    };
  } catch (err) {
    throw analyticsUnavailable("projection_coverage", err);
  }
}

function projectionRange(range, coverageFrom) {
  if (!coverageFrom || !Number.isFinite(new Date(coverageFrom).getTime())) return null;
  const from = new Date(coverageFrom);
  const end = range?.endAt ? new Date(range.endAt) : new Date();
  if (end.getTime() < from.getTime()) return null;
  const start = range?.startAt ? new Date(Math.max(new Date(range.startAt).getTime(), from.getTime())) : from;
  return { ...range, startAt: start, endAt: end };
}

function projectionOwnsTimestamp(timestamp, coverageFrom) {
  const t = Number(timestamp);
  const from = coverageFrom ? new Date(coverageFrom).getTime() : NaN;
  return Number.isFinite(t) && Number.isFinite(from) && t >= from;
}

function projectionCoversWholeRange(range, coverageFrom) {
  const from = coverageFrom ? new Date(coverageFrom).getTime() : NaN;
  if (!Number.isFinite(from) || !range?.startAt) return false;
  return new Date(range.startAt).getTime() >= from;
}

async function loadProjectedResponseCases({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamResponseCase, {
      where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...whereForRange("replyAt", range) },
    });
    rows.sort((a, b) => new Date(a.replyAt || 0).getTime() - new Date(b.replyAt || 0).getTime());
    return rows;
  } catch (err) {
    throw analyticsUnavailable("response_projection", err);
  }
}

async function loadProjectedDialogSessions({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamDialogSession, {
      where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...whereForRange("startedAt", range) },
    });
    rows.sort((a, b) => new Date(a.startedAt || 0).getTime() - new Date(b.startedAt || 0).getTime());
    return rows;
  } catch (err) {
    throw analyticsUnavailable("dialog_projection", err);
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


function supportsTeamScaleReadAuthority() {
  return typeof prisma?.$queryRawUnsafe === "function"
    && typeof prisma?.teamMemberActivityDaily?.aggregate === "function"
    && typeof prisma?.teamMoneyAttributionFact?.aggregate === "function"
    && typeof prisma?.teamResponseCase?.aggregate === "function"
    && typeof prisma?.teamDialogSession?.aggregate === "function";
}

function isReducedTeamAnalyticsTestDouble() {
  // Real Prisma / TransactionClient exposes raw SQL. If that surface exists but
  // any required aggregate delegate is missing, fail closed instead of silently
  // resurrecting the historical materialization path in production. Tiny unit
  // test doubles omit raw SQL entirely and may use the compatibility path below.
  return typeof prisma?.$queryRawUnsafe !== "function";
}

function sqlLiteralList(values) {
  return Array.from(values || []).map((value) => `'${String(value).replace(/'/g, "''")}'`).join(",");
}

function currentTelemetrySql(alias) {
  const versions = sqlLiteralList(SUPPORTED_TEAM_TELEMETRY_VERSIONS);
  const sources = sqlLiteralList(SUPPORTED_TEAM_TELEMETRY_SOURCES);
  return `(COALESCE(${alias}."extra"->>'telemetryVersion','') IN (${versions}) OR COALESCE(NULLIF(${alias}."source",''), ${alias}."extra"->>'source','') IN (${sources}))`;
}

function normalizedCreatorScope(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return null;
  return Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
}

function sqlScopedWhere({ alias, agencyId, allowedCreatorIds = null, range = null, field = null, extra = [] }) {
  const params = [String(agencyId)];
  const clauses = [`${alias}."agencyId" = $1`];
  const scope = normalizedCreatorScope(allowedCreatorIds);
  if (scope && scope.length === 0) return { empty: true, sql: "FALSE", params };
  if (scope) {
    params.push(scope);
    clauses.push(`${alias}."creatorId" = ANY($${params.length}::text[])`);
  }
  if (field && range?.startAt) {
    params.push(new Date(range.startAt));
    clauses.push(`${alias}."${field}" >= $${params.length}`);
  }
  if (field && range?.endAt) {
    params.push(new Date(range.endAt));
    clauses.push(`${alias}."${field}" <= $${params.length}`);
  }
  clauses.push(...extra);
  return { empty: false, sql: clauses.join(" AND "), params };
}

async function teamScaleQuery(section, sql, params) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...(params || []));
  } catch (err) {
    throw analyticsUnavailable(section, err);
  }
}

function rowNumber(row, key, fallback = 0) {
  return num(row?.[key], fallback);
}

function rowNullableNumber(row, key) {
  return nullableNum(row?.[key]);
}

function rowIso(row, key) {
  const value = row?.[key];
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function loadActivitySummarySql({ agencyId, range, allowedCreatorIds = null, exactRaw = false }) {
  if (exactRaw) {
    const where = sqlScopedWhere({
      alias: "e", agencyId, allowedCreatorIds, range, field: "ts",
      extra: [`e."memberId" IS NOT NULL`, currentTelemetrySql("e")],
    });
    if (where.empty) return [];
    const sql = `
      SELECT
        e."memberId" AS "memberId",
        COUNT(*) FILTER (WHERE e."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')::bigint AS "messagesSent",
        COUNT(*) FILTER (WHERE e."eventKind" = 'MESSAGE_SEND_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED' AND (e."isPpv" = TRUE OR COALESCE(e."priceCents", 0) > 0))::bigint AS "ppvSentMessages",
        COUNT(*) FILTER (WHERE e."eventKind" = 'BROADCAST_DISPATCH_CONFIRMED')::bigint AS "broadcastDispatches",
        COUNT(*) FILTER (WHERE e."eventKind" = 'CONTENT_POST_PUBLISHED_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')::bigint AS "postsCreated",
        COUNT(*) FILTER (WHERE e."eventKind" = 'CONTENT_STORY_PUBLISHED_CONFIRMED' AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')::bigint AS "storiesCreated",
        COUNT(*) FILTER (WHERE e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')::bigint AS "contentActions",
        COALESCE(SUM(CASE WHEN e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED' THEN COALESCE(e."mediaCount",0) ELSE 0 END), 0)::bigint AS "contentMediaItemsPublished",
        COUNT(DISTINCT e."creatorId") FILTER (WHERE e."creatorId" IS NOT NULL AND e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')::bigint AS "contentCreatorCoverage",
        COUNT(DISTINCT DATE_TRUNC('day', e."ts")) FILTER (WHERE e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED')::bigint AS "contentActiveDays",
        MAX(e."ts") FILTER (WHERE e."eventKind" IN ('CONTENT_POST_PUBLISHED_CONFIRMED','CONTENT_STORY_PUBLISHED_CONFIRMED') AND e."actionSource" = 'MANUAL' AND e."lifecycle" = 'CONFIRMED') AS "lastContentActivityAt"
      FROM "TeamActivityEvent" e
      WHERE ${where.sql}
      GROUP BY e."memberId"
    `;
    return teamScaleQuery("activity_summary", sql, where.params);
  }

  const where = sqlScopedWhere({
    alias: "d", agencyId, allowedCreatorIds, range, field: "day",
    extra: [`d."memberId" IS NOT NULL`],
  });
  if (where.empty) return [];
  const sql = `
    SELECT
      d."memberId" AS "memberId",
      COALESCE(SUM(d."messagesSent"),0)::bigint AS "messagesSent",
      COALESCE(SUM(d."ppvSentMessages"),0)::bigint AS "ppvSentMessages",
      COALESCE(SUM(d."broadcastDispatches"),0)::bigint AS "broadcastDispatches",
      COALESCE(SUM(d."postsCreated"),0)::bigint AS "postsCreated",
      COALESCE(SUM(d."storiesCreated"),0)::bigint AS "storiesCreated",
      COALESCE(SUM(d."contentActions"),0)::bigint AS "contentActions",
      COALESCE(SUM(d."contentMediaItemsPublished"),0)::bigint AS "contentMediaItemsPublished",
      COUNT(DISTINCT d."creatorId") FILTER (WHERE d."creatorId" IS NOT NULL AND d."contentActions" > 0)::bigint AS "contentCreatorCoverage",
      COUNT(DISTINCT d."day") FILTER (WHERE d."contentActions" > 0)::bigint AS "contentActiveDays",
      MAX(d."lastContentActivityAt") AS "lastContentActivityAt"
    FROM "TeamMemberActivityDaily" d
    WHERE ${where.sql}
    GROUP BY d."memberId"
  `;
  return teamScaleQuery("activity_summary", sql, where.params);
}

async function loadLegacyBoundedSummarySql({ agencyId, range, allowedCreatorIds = null }) {
  if (!range) return [];
  const where = sqlScopedWhere({ alias: "e", agencyId, allowedCreatorIds, range, field: "ts", extra: [`e."memberId" IS NOT NULL`, currentTelemetrySql("e")] });
  if (where.empty) return [];
  const numericJson = (name, fallback = "0") => `CASE WHEN COALESCE(e."extra"->>'${name}','') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (e."extra"->>'${name}')::double precision ELSE ${fallback} END`;
  const sql = `
    SELECT
      e."memberId" AS "memberId",
      COUNT(*) FILTER (WHERE e."type" IN ('dialog_unread_seen','dialog_unread_opened'))::bigint AS "chatOpened",
      COALESCE(SUM(CASE WHEN e."type" = 'fan_message_after_last_responder' THEN GREATEST(1, ${numericJson("incomingCount", numericJson("rawUnreadMessagesCount", numericJson("unreadCount", "1")))}) ELSE 0 END),0)::bigint AS "incomingMessagesLegacy",
      COALESCE(SUM(CASE WHEN e."type" = 'fan_message_after_last_responder' THEN GREATEST(1, ${numericJson("engagementCount", "1")}) ELSE 0 END),0)::bigint AS "engagementReplies",
      COALESCE(SUM(CASE WHEN e."type" IN ('mass_message_sent_local','message_queue_sent_local') THEN GREATEST(1, ${numericJson("count", "1")}) ELSE 0 END),0)::bigint AS "massMessages",
      COUNT(*) FILTER (WHERE e."type" = 'chat_message_sent_local' AND COALESCE(e."extra"->>'isBacklogReply','false') = 'true')::bigint AS "backlogClearedLegacy",
      COALESCE(MAX(CASE WHEN e."type" = 'chat_message_sent_local' AND COALESCE(e."extra"->>'isBacklogReply','false') = 'true' THEN GREATEST(0, ${numericJson("backlogAgeSeconds", "0")}) ELSE 0 END),0)::double precision AS "backlogMaxAgeSecondsLegacy"
    FROM "TeamActivityEvent" e
    WHERE ${where.sql}
    GROUP BY e."memberId"
  `;
  return teamScaleQuery("bounded_legacy_summary", sql, where.params);
}

function responseSelectSql(alias) {
  return `
    COUNT(*)::bigint AS "cases",
    COALESCE(SUM(${alias}."incomingCount"),0)::bigint AS "incomingHandled",
    COUNT(*) FILTER (WHERE UPPER(COALESCE(${alias}."classification",'UNKNOWN')) = 'FRESH')::bigint AS "freshReplies",
    COUNT(*) FILTER (WHERE UPPER(COALESCE(${alias}."classification",'UNKNOWN')) = 'BACKLOG')::bigint AS "backlogReplies",
    COUNT(*) FILTER (WHERE UPPER(COALESCE(${alias}."classification",'UNKNOWN')) = 'HANDOFF')::bigint AS "handoffReplies",
    COUNT(*) FILTER (WHERE UPPER(COALESCE(${alias}."classification",'UNKNOWN')) NOT IN ('FRESH','BACKLOG','HANDOFF'))::bigint AS "unknownReplies",
    COUNT(*) FILTER (WHERE ${alias}."slaEligible" = TRUE)::bigint AS "responseSamples",
    AVG(${alias}."wallClockSeconds"::double precision) FILTER (WHERE ${alias}."slaEligible" = TRUE) AS "avgResponseSeconds",
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${alias}."wallClockSeconds") FILTER (WHERE ${alias}."slaEligible" = TRUE) AS "medianResponseSeconds",
    percentile_cont(0.9) WITHIN GROUP (ORDER BY ${alias}."wallClockSeconds") FILTER (WHERE ${alias}."slaEligible" = TRUE) AS "p90ResponseSeconds",
    COUNT(*) FILTER (WHERE ${alias}."slaEligible" = TRUE AND ${alias}."sla5Pass" = TRUE)::bigint AS "sla5Passes",
    COUNT(*) FILTER (WHERE ${alias}."slaEligible" = TRUE AND ${alias}."sla15Pass" = TRUE)::bigint AS "sla15Passes",
    AVG(${alias}."coverageResponseSeconds"::double precision) FILTER (WHERE ${alias}."coverageResponseSeconds" IS NOT NULL) AS "coverageResponseAvgSeconds",
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${alias}."coverageResponseSeconds") FILTER (WHERE ${alias}."coverageResponseSeconds" IS NOT NULL) AS "coverageResponseMedianSeconds",
    AVG(${alias}."seenResponseSeconds"::double precision) FILTER (WHERE ${alias}."seenResponseSeconds" IS NOT NULL) AS "seenResponseAvgSeconds",
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${alias}."seenResponseSeconds") FILTER (WHERE ${alias}."seenResponseSeconds" IS NOT NULL) AS "seenResponseMedianSeconds",
    COALESCE(MAX(${alias}."wallClockSeconds") FILTER (WHERE UPPER(COALESCE(${alias}."classification",'UNKNOWN')) IN ('BACKLOG','HANDOFF')),0)::bigint AS "backlogMaxAgeSeconds"
  `;
}

async function loadResponseSummarySql({ agencyId, range, allowedCreatorIds = null, currentGenerationOnly = false }) {
  if (!range) return [];
  const where = sqlScopedWhere({
    alias: "r", agencyId, allowedCreatorIds, range, field: "replyAt",
    extra: currentGenerationOnly ? [`r."derivationVersion"='team_response_v2'`, `r."projectionState"='FULL'`] : [],
  });
  if (where.empty) return [];
  const sql = `
    SELECT GROUPING(r."memberId")::int AS "isTotal", r."memberId" AS "memberId", ${responseSelectSql("r")}
    FROM "TeamResponseCaseCurrent" r
    WHERE ${where.sql}
    GROUP BY GROUPING SETS ((r."memberId"), ())
  `;
  return teamScaleQuery("response_summary", sql, where.params);
}

async function loadDialogSummarySql({ agencyId, range, allowedCreatorIds = null, includeMoney = false }) {
  if (!range) return [];
  const where = sqlScopedWhere({ alias: "s", agencyId, allowedCreatorIds, range, field: "startedAt" });
  if (where.empty) return [];
  let params = [...where.params];
  let moneyJoin = "";
  let moneySelect = `NULL::text AS "currency", 0::bigint AS "revenueCents"`;
  let moneyGroup = "";
  if (includeMoney) {
    const scope = normalizedCreatorScope(allowedCreatorIds);
    const moneyClauses = [`m."agencyId" = $1`, `m."classificationState" = 'CANONICAL'`, `m."attributionActive" = TRUE`, `m."memberId" = r."memberId"`, `m."creatorId" = r."creatorId"`, `COALESCE(NULLIF(m."fanId",''), NULLIF(m."dialogId",'')) = r."fanKey"`];
    if (scope) {
      const scopeIndex = where.params.findIndex((value) => Array.isArray(value)) + 1;
      if (scopeIndex > 0) moneyClauses.push(`m."creatorId" = ANY($${scopeIndex}::text[])`);
    }
    if (range.startAt) {
      params.push(new Date(range.startAt));
      moneyClauses.push(`m."occurredAt" >= $${params.length}`);
    }
    if (range.endAt) {
      params.push(new Date(range.endAt));
      moneyClauses.push(`m."occurredAt" <= $${params.length}`);
    }
    moneyJoin = `LEFT JOIN "TeamMoneyAttributionFact" m ON ${moneyClauses.join(" AND ")}`;
    moneySelect = `m."currency" AS "currency", COALESCE(SUM(m."amountCents"),0)::bigint AS "revenueCents"`;
    moneyGroup = `, m."currency"`;
  }
  const sql = `
    WITH grouped AS (
      SELECT s."memberId", s."creatorId", COALESCE(NULLIF(s."fanId",''), s."dialogId") AS "fanKey",
             COUNT(*)::bigint AS "sessions", COALESCE(SUM(s."activeSeconds"),0)::bigint AS "dwellSeconds"
      FROM "TeamDialogSession" s
      WHERE ${where.sql}
      GROUP BY s."memberId", s."creatorId", COALESCE(NULLIF(s."fanId",''), s."dialogId")
    ), ranked AS (
      SELECT g.*,
             SUM(g."sessions") OVER (PARTITION BY g."memberId")::bigint AS "memberSessionCount",
             SUM(g."dwellSeconds") OVER (PARTITION BY g."memberId")::bigint AS "memberDwellSeconds",
             ROW_NUMBER() OVER (PARTITION BY g."memberId" ORDER BY g."dwellSeconds" DESC, g."fanKey" ASC) AS rn
      FROM grouped g
    )
    SELECT r."memberId", r."creatorId", r."fanKey", r."sessions", r."dwellSeconds", r."memberSessionCount", r."memberDwellSeconds",
           ${moneySelect}
    FROM ranked r
    ${moneyJoin}
    WHERE r.rn <= 10
    GROUP BY r."memberId", r."creatorId", r."fanKey", r."sessions", r."dwellSeconds", r."memberSessionCount", r."memberDwellSeconds"${moneyGroup}
    ORDER BY r."memberId", r."dwellSeconds" DESC, r."fanKey" ASC
  `;
  return teamScaleQuery("dialog_summary", sql, params);
}

async function loadPendingSummarySql({ agencyId, allowedCreatorIds = null, authorityNow, currentGenerationOnly = false }) {
  const where = sqlScopedWhere({
    alias: "p", agencyId, allowedCreatorIds,
    extra: [
      `p."status" = 'PENDING'`,
      ...(currentGenerationOnly ? [`p."derivationVersion"='team_pending_v2'`, `p."projectionState" IN ('FULL','INCOMPLETE_HISTORY')`] : []),
    ],
  });
  if (where.empty) return [];
  const params = [...where.params, new Date(authorityNow)];
  const nowRef = `$${params.length}`;
  const sql = `
    SELECT GROUPING(p."ownerMemberId")::int AS "isTotal", p."ownerMemberId" AS "memberId",
           COUNT(*)::bigint AS "pendingDialogs",
           COALESCE(SUM(GREATEST(1,p."incomingCount")),0)::bigint AS "pendingIncomingMessages",
           COUNT(*) FILTER (WHERE p."ownerMemberId" IS NULL)::bigint AS "unassignedDialogs",
           COUNT(*) FILTER (WHERE p."firstSeenAt" IS NOT NULL)::bigint AS "seenDialogs",
           COUNT(*) FILTER (WHERE p."firstIncomingAt" <= ${nowRef} - INTERVAL '15 minutes')::bigint AS "olderThan15m",
           COUNT(*) FILTER (WHERE p."firstIncomingAt" <= ${nowRef} - INTERVAL '60 minutes')::bigint AS "olderThan60m",
           MIN(p."firstIncomingAt") AS "oldestPendingAt"
    FROM "TeamPendingDialogStateCurrent" p
    WHERE ${where.sql}
    GROUP BY GROUPING SETS ((p."ownerMemberId"), ())
  `;
  return teamScaleQuery("pending_summary", sql, params);
}

function floorUtcDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ceilUtcDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const floor = floorUtcDay(d);
  return d.getTime() === floor.getTime() ? floor : new Date(floor.getTime() + 24 * 60 * 60 * 1000);
}

async function teamMoneyReadSummaryGenerationStatus({ agencyId }) {
  const coverage = await phase2CoverageStatus({
    agencyId,
    family: PHASE2_COVERAGE_FAMILY.TEAM_READ_SUMMARY,
    generation: PHASE2_COVERAGE_GENERATION.TEAM_READ_SUMMARY,
  }).catch(() => ({ ready: false, state: "UNAVAILABLE", row: null }));
  if (!coverage?.ready) return { ready: false, coverage, outstanding: null };
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" w
      WHERE w."agencyId"=$1 AND w."workClass"='TEAM_READ_SUMMARY'
        AND (w."state" <> 'DONE' OR w."requestedRevision" > w."completedRevision")
      LIMIT 1
    ) AS "hasOutstanding"`, String(agencyId));
    const outstanding = Boolean(rows?.[0]?.hasOutstanding);
    return { ready: !outstanding, coverage, outstanding };
  } catch (_) {
    // Failure to prove rollup convergence is not permission to trust a stale
    // aggregate generation. Canonical facts remain the exact fallback.
    return { ready: false, coverage, outstanding: null };
  }
}

async function loadMoneySummaryRollupSql({ agencyId, range, allowedCreatorIds = null }) {
  const startAt = range?.startAt ? new Date(range.startAt) : null;
  const endAt = range?.endAt ? new Date(range.endAt) : null;
  if (!startAt || !endAt || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt < startAt) return null;

  const fullStart = ceilUtcDay(startAt);
  const fullEnd = floorUtcDay(endAt);
  if (!fullStart || !fullEnd || fullStart.getTime() >= fullEnd.getTime()) return null;

  const scope = normalizedCreatorScope(allowedCreatorIds);
  if (scope && scope.length === 0) return [];
  const params = [String(agencyId), fullStart, fullEnd, startAt, endAt];
  let rollupScope = "";
  let factScope = "";
  if (scope) {
    params.push(scope);
    const ref = `$${params.length}::text[]`;
    rollupScope = ` AND r."creatorId" = ANY(${ref})`;
    factScope = ` AND m."creatorId" = ANY(${ref})`;
  }

  const sql = `
    WITH money_slices AS (
      SELECT r."memberId", r."sourceType", r."currency",
             SUM(r."factCount")::bigint AS "factCount", SUM(r."amountCents")::bigint AS "amountCents"
      FROM "TeamMoneyDailyRollup" r
      WHERE r."agencyId"=$1 AND r."memberId" IS NOT NULL
        AND r."day" >= $2::date AND r."day" < $3::date${rollupScope}
      GROUP BY r."memberId", r."sourceType", r."currency"
      UNION ALL
      SELECT m."memberId", m."sourceType", m."currency",
             COUNT(*)::bigint AS "factCount", COALESCE(SUM(m."amountCents"),0)::bigint AS "amountCents"
      FROM "TeamMoneyAttributionFact" m
      WHERE m."agencyId"=$1 AND m."classificationState"='CANONICAL' AND m."attributionActive"=TRUE AND m."memberId" IS NOT NULL
        AND m."occurredAt" >= $4 AND m."occurredAt" <= $5
        AND (m."occurredAt" < $2 OR m."occurredAt" >= $3)${factScope}
      GROUP BY m."memberId", m."sourceType", m."currency"
    )
    SELECT x."memberId" AS "memberId", x."sourceType" AS "sourceType", x."currency" AS "currency",
           GROUPING(x."sourceType")::int AS "sourceGrouped", GROUPING(x."currency")::int AS "currencyGrouped",
           COALESCE(SUM(x."factCount"),0)::bigint AS "factCount", COALESCE(SUM(x."amountCents"),0)::bigint AS "amountCents"
    FROM money_slices x
    GROUP BY GROUPING SETS ((x."memberId",x."sourceType",x."currency"),(x."memberId"))
  `;
  return teamScaleQuery("money_summary_rollup", sql, params);
}

async function loadMoneySummarySql({ agencyId, range, allowedCreatorIds = null, rollupReady = false }) {
  if (rollupReady) {
    const rolled = await loadMoneySummaryRollupSql({ agencyId, range, allowedCreatorIds });
    if (rolled !== null) return rolled;
  }
  const where = sqlScopedWhere({ alias: "m", agencyId, allowedCreatorIds, range, field: "occurredAt", extra: [`m."classificationState" = 'CANONICAL'`, `m."attributionActive" = TRUE`, `m."memberId" IS NOT NULL`] });
  if (where.empty) return [];
  const sql = `
    SELECT m."memberId" AS "memberId", m."sourceType" AS "sourceType", m."currency" AS "currency",
           GROUPING(m."sourceType")::int AS "sourceGrouped", GROUPING(m."currency")::int AS "currencyGrouped",
           COUNT(*)::bigint AS "factCount", COALESCE(SUM(m."amountCents"),0)::bigint AS "amountCents"
    FROM "TeamMoneyAttributionFact" m
    WHERE ${where.sql}
    GROUP BY GROUPING SETS ((m."memberId",m."sourceType",m."currency"),(m."memberId"))
  `;
  return teamScaleQuery("money_summary", sql, where.params);
}

async function loadAudienceCoverageSummarySql({ agencyId, range, rawRange, allowedCreatorIds = null, includeMoney = true, exactRawActivity = false }) {
  const scope = normalizedCreatorScope(allowedCreatorIds);
  if (scope && scope.length === 0) return [];
  const params = [String(agencyId)];
  let scopeRef = null;
  if (scope) {
    params.push(scope);
    scopeRef = `$${params.length}::text[]`;
  }

  function sourceWhere({ alias, field, sourceRange, extra = [] }) {
    const clauses = [`${alias}."agencyId" = $1`, `${alias}."memberId" IS NOT NULL`];
    if (scopeRef) clauses.push(`${alias}."creatorId" = ANY(${scopeRef})`);
    if (field && sourceRange?.startAt) {
      params.push(new Date(sourceRange.startAt));
      clauses.push(`${alias}."${field}" >= $${params.length}`);
    }
    if (field && sourceRange?.endAt) {
      params.push(new Date(sourceRange.endAt));
      clauses.push(`${alias}."${field}" <= $${params.length}`);
    }
    clauses.push(...extra);
    return clauses.join(" AND ");
  }

  const fanSources = [];
  const creatorSources = [];

  if (rawRange) {
    const rawFanKey = `COALESCE(NULLIF(e."fanId",''), NULLIF(e."dialogId",''), NULLIF(e."extra"->>'fanId',''), NULLIF(e."extra"->>'dialogId',''))`;
    const rawCreatorKey = `COALESCE(NULLIF(e."accountId",''), NULLIF(e."extra"->>'accountId',''), NULLIF(e."creatorId",''))`;
    const rawWhere = sourceWhere({ alias: "e", field: "ts", sourceRange: rawRange, extra: [currentTelemetrySql("e")] });
    fanSources.push(`SELECT e."memberId" AS "memberId", ${rawFanKey} AS "key" FROM "TeamActivityEvent" e WHERE ${rawWhere} AND ${rawFanKey} IS NOT NULL`);
    creatorSources.push(`SELECT e."memberId" AS "memberId", ${rawCreatorKey} AS "key" FROM "TeamActivityEvent" e WHERE ${rawWhere} AND ${rawCreatorKey} IS NOT NULL`);
  }

  if (!exactRawActivity) {
    const dailyWhere = sourceWhere({ alias: "d", field: "day", sourceRange: range });
    creatorSources.push(`SELECT d."memberId" AS "memberId", d."creatorId" AS "key" FROM "TeamMemberActivityDaily" d WHERE ${dailyWhere} AND d."creatorId" IS NOT NULL`);
  }

  if (includeMoney) {
    const moneyWhere = sourceWhere({ alias: "m", field: "occurredAt", sourceRange: range, extra: [`m."classificationState" = 'CANONICAL'`, `m."attributionActive" = TRUE`] });
    const moneyFanKey = `COALESCE(NULLIF(m."fanId",''), NULLIF(m."dialogId",''))`;
    fanSources.push(`SELECT m."memberId" AS "memberId", ${moneyFanKey} AS "key" FROM "TeamMoneyAttributionFact" m WHERE ${moneyWhere} AND ${moneyFanKey} IS NOT NULL`);
    creatorSources.push(`SELECT m."memberId" AS "memberId", m."creatorId" AS "key" FROM "TeamMoneyAttributionFact" m WHERE ${moneyWhere} AND m."creatorId" IS NOT NULL`);
  }

  const fanSql = fanSources.length ? fanSources.join("\n      UNION\n      ") : `SELECT NULL::text AS "memberId", NULL::text AS "key" WHERE FALSE`;
  const creatorSql = creatorSources.length ? creatorSources.join("\n      UNION\n      ") : `SELECT NULL::text AS "memberId", NULL::text AS "key" WHERE FALSE`;
  const sql = `
    WITH fan_keys AS (
      ${fanSql}
    ), creator_keys AS (
      ${creatorSql}
    ), fan_counts AS (
      SELECT "memberId", COUNT(*)::bigint AS "uniqueFans"
      FROM fan_keys
      GROUP BY "memberId"
    ), creator_counts AS (
      SELECT "memberId", COUNT(*)::bigint AS "creatorCoverage"
      FROM creator_keys
      GROUP BY "memberId"
    )
    SELECT COALESCE(f."memberId", c."memberId") AS "memberId",
           COALESCE(f."uniqueFans", 0)::bigint AS "uniqueFans",
           COALESCE(c."creatorCoverage", 0)::bigint AS "creatorCoverage"
    FROM fan_counts f
    FULL OUTER JOIN creator_counts c ON c."memberId" = f."memberId"
  `;
  return teamScaleQuery("audience_coverage_summary", sql, params);
}

function applyResponseAggregate(metric, row) {
  metric.incomingMessages += Math.max(0, rowNumber(row, "incomingHandled", 0));
  metric.freshReplies += Math.max(0, rowNumber(row, "freshReplies", 0));
  metric.backlogReplies += Math.max(0, rowNumber(row, "backlogReplies", 0));
  metric.handoffReplies += Math.max(0, rowNumber(row, "handoffReplies", 0));
  metric.unknownReplies += Math.max(0, rowNumber(row, "unknownReplies", 0));
  metric.backlogCleared += Math.max(0, rowNumber(row, "backlogReplies", 0) + rowNumber(row, "handoffReplies", 0));
  metric.backlogMaxAgeSeconds = Math.max(metric.backlogMaxAgeSeconds || 0, rowNumber(row, "backlogMaxAgeSeconds", 0));
  metric.responseSamples = Math.max(0, rowNumber(row, "responseSamples", 0));
  metric.avgResponseSeconds = rowNullableNumber(row, "avgResponseSeconds");
  metric.medianResponseSeconds = rowNullableNumber(row, "medianResponseSeconds");
  metric.p90ResponseSeconds = rowNullableNumber(row, "p90ResponseSeconds");
  const samples = metric.responseSamples;
  metric.slaReply5mPct = samples > 0 ? (rowNumber(row, "sla5Passes", 0) / samples) * 100 : null;
  metric.slaReply15mPct = samples > 0 ? (rowNumber(row, "sla15Passes", 0) / samples) * 100 : null;
  metric.coverageResponseAvgSeconds = rowNullableNumber(row, "coverageResponseAvgSeconds");
  metric.coverageResponseMedianSeconds = rowNullableNumber(row, "coverageResponseMedianSeconds");
  metric.seenResponseAvgSeconds = rowNullableNumber(row, "seenResponseAvgSeconds");
  metric.seenResponseMedianSeconds = rowNullableNumber(row, "seenResponseMedianSeconds");
}

function responseSummaryFromAggregate(row, source, coverageFrom) {
  const samples = Math.max(0, rowNumber(row, "responseSamples", 0));
  return {
    source,
    cases: Math.max(0, rowNumber(row, "cases", 0)),
    incomingHandled: Math.max(0, rowNumber(row, "incomingHandled", 0)),
    freshReplies: Math.max(0, rowNumber(row, "freshReplies", 0)),
    backlogReplies: Math.max(0, rowNumber(row, "backlogReplies", 0)),
    handoffReplies: Math.max(0, rowNumber(row, "handoffReplies", 0)),
    unknownReplies: Math.max(0, rowNumber(row, "unknownReplies", 0)),
    responseSamples: samples,
    avgResponseSeconds: rowNullableNumber(row, "avgResponseSeconds"),
    medianResponseSeconds: rowNullableNumber(row, "medianResponseSeconds"),
    p90ResponseSeconds: rowNullableNumber(row, "p90ResponseSeconds"),
    slaReply5mPct: samples > 0 ? (rowNumber(row, "sla5Passes", 0) / samples) * 100 : null,
    slaReply15mPct: samples > 0 ? (rowNumber(row, "sla15Passes", 0) / samples) * 100 : null,
    coverageResponseAvgSeconds: rowNullableNumber(row, "coverageResponseAvgSeconds"),
    coverageResponseMedianSeconds: rowNullableNumber(row, "coverageResponseMedianSeconds"),
    seenResponseAvgSeconds: rowNullableNumber(row, "seenResponseAvgSeconds"),
    seenResponseMedianSeconds: rowNullableNumber(row, "seenResponseMedianSeconds"),
    coverageFrom: coverageFrom || null,
  };
}

async function buildComputedScale({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const authorityNow = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const range = resolveRange(rangeKey, authorityNow);
  const [projectionCoverage, historicalCoverage, retentionPolicy, members, moneyRootCoverageStatus, moneyReadSummaryStatus, dialogGenerationStatus, responseRepairStatus] = await Promise.all([
    loadProjectionCoverage({ agencyId }),
    loadHistoricalCoverage({ agencyId }),
    getRetentionSettings(),
    getMembersShell(agencyId),
    includeMoney ? phase2CoverageStatus({ agencyId, family: PHASE2_COVERAGE_FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION, generation: PHASE2_COVERAGE_GENERATION.TEAM_MONEY_ROOT_CLASSIFICATION }) : Promise.resolve({ ready: true, state: "NOT_REQUIRED", row: null }),
    includeMoney ? teamMoneyReadSummaryGenerationStatus({ agencyId }) : Promise.resolve({ ready: false, coverage: { state: "NOT_REQUIRED" }, outstanding: false }),
    phase2CoverageStatus({ agencyId, family: PHASE2_COVERAGE_FAMILY.TEAM_DIALOG_PROJECTION, generation: PHASE2_COVERAGE_GENERATION.TEAM_DIALOG_PROJECTION }),
    phase2CoverageStatus({ agencyId, family: PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR, generation: PHASE2_COVERAGE_GENERATION.TEAM_RESPONSE_RANGE_REPAIR }),
  ]);
  const currentDialogGeneration = dialogGenerationStatus?.ready === true;
  const currentResponseGeneration = currentDialogGeneration && responseRepairStatus?.ready === true;
  if (retentionPolicy?.ok !== true) throw analyticsUnavailable("retention_policy", new Error("Team retention policy unavailable"));
  const detailDays = Number(retentionPolicy.settings?.teamCanonicalDetailDays || 180);
  const projectionDetail = buildProjectionDetailAuthority({
    range,
    authorityNow,
    detailDays,
    responseCoverageFrom: projectionCoverage.responseCoverageFrom,
    dialogCoverageFrom: projectionCoverage.dialogCoverageFrom,
  });
  const rawRange = clampRangeToDetail(range, detailDays);
  const exactRawActivity = String(range.key || "") === "24h";
  const activityRange = range;
  const responseRange = projectionDetail.responseRange;
  const dialogRange = projectionDetail.dialogRange;

  const [activityRows, legacyRows, responseRows, dialogRows, pendingRows, moneyRows, audienceRows] = await Promise.all([
    loadActivitySummarySql({ agencyId, range: activityRange, allowedCreatorIds, exactRaw: exactRawActivity }),
    rawRange ? loadLegacyBoundedSummarySql({ agencyId, range: rawRange, allowedCreatorIds }) : Promise.resolve([]),
    responseRange ? loadResponseSummarySql({ agencyId, range: responseRange, allowedCreatorIds, currentGenerationOnly: currentResponseGeneration }) : Promise.resolve([]),
    dialogRange ? loadDialogSummarySql({ agencyId, range: dialogRange, allowedCreatorIds, includeMoney }) : Promise.resolve([]),
    loadPendingSummarySql({ agencyId, allowedCreatorIds, authorityNow, currentGenerationOnly: currentDialogGeneration }),
    includeMoney ? loadMoneySummarySql({ agencyId, range, allowedCreatorIds, rollupReady: moneyReadSummaryStatus.ready === true }) : Promise.resolve([]),
    loadAudienceCoverageSummarySql({ agencyId, range, rawRange, allowedCreatorIds, includeMoney, exactRawActivity }),
  ]);

  const metricsByMember = new Map();
  for (const member of members) metricsByMember.set(String(member.id), emptyMetric());
  function metricFor(memberId) {
    const id = String(memberId || "");
    if (!id) return null;
    if (!metricsByMember.has(id)) metricsByMember.set(id, emptyMetric());
    return metricsByMember.get(id);
  }

  for (const row of activityRows || []) {
    const metric = metricFor(row.memberId);
    if (!metric) continue;
    metric.messagesSent += Math.max(0, rowNumber(row, "messagesSent", 0));
    metric.ppvSentMessages += Math.max(0, rowNumber(row, "ppvSentMessages", 0));
    metric.broadcastDispatches += Math.max(0, rowNumber(row, "broadcastDispatches", 0));
    metric.postsCreated += Math.max(0, rowNumber(row, "postsCreated", 0));
    metric.storiesCreated += Math.max(0, rowNumber(row, "storiesCreated", 0));
    metric.contentActions += Math.max(0, rowNumber(row, "contentActions", 0));
    metric.contentMediaItemsPublished += Math.max(0, rowNumber(row, "contentMediaItemsPublished", 0));
    metric.contentCreatorCoverage = Math.max(metric.contentCreatorCoverage || 0, rowNumber(row, "contentCreatorCoverage", 0));
    metric.contentActiveDays = Math.max(metric.contentActiveDays || 0, rowNumber(row, "contentActiveDays", 0));
    metric.lastContentActivityAt = rowIso(row, "lastContentActivityAt");
  }

  for (const row of legacyRows || []) {
    const metric = metricFor(row.memberId);
    if (!metric) continue;
    metric.chatOpened += Math.max(0, rowNumber(row, "chatOpened", 0));
    metric.incomingMessages += Math.max(0, rowNumber(row, "incomingMessagesLegacy", 0));
    metric.engagementReplies += Math.max(0, rowNumber(row, "engagementReplies", 0));
    metric.massMessages += Math.max(0, rowNumber(row, "massMessages", 0));
    metric.backlogCleared += Math.max(0, rowNumber(row, "backlogClearedLegacy", 0));
    metric.backlogMaxAgeSeconds = Math.max(metric.backlogMaxAgeSeconds || 0, rowNumber(row, "backlogMaxAgeSecondsLegacy", 0));
  }

  let totalResponseRow = null;
  for (const row of responseRows || []) {
    if (Number(row?.isTotal) === 1) { totalResponseRow = row; continue; }
    const metric = metricFor(row.memberId);
    if (metric) applyResponseAggregate(metric, row);
  }

  const dialogBuckets = new Map();
  for (const row of dialogRows || []) {
    const metric = metricFor(row.memberId);
    if (!metric) continue;
    metric.dialogSessionsCount = Math.max(metric.dialogSessionsCount || 0, rowNumber(row, "memberSessionCount", 0));
    metric.dialogDwellSeconds = Math.max(metric.dialogDwellSeconds || 0, rowNumber(row, "memberDwellSeconds", 0));
    const key = `${row.memberId}|${row.creatorId || ""}|${row.fanKey}`;
    let item = dialogBuckets.get(key);
    if (!item) {
      item = {
        memberId: String(row.memberId || ""),
        fanId: row.fanKey || null,
        accountId: row.creatorId || null,
        sessions: Math.max(0, rowNumber(row, "sessions", 0)),
        dwellSeconds: Math.max(0, rowNumber(row, "dwellSeconds", 0)),
        revenue: new Map(),
      };
      dialogBuckets.set(key, item);
    }
    if (includeMoney && row.currency) item.revenue.set(normalizeCurrency(row.currency), Math.max(0, rowNumber(row, "revenueCents", 0)));
  }
  for (const item of dialogBuckets.values()) {
    const metric = metricFor(item.memberId);
    if (!metric) continue;
    metric._dialogSessions.set(`${item.accountId || ""}|${item.fanId || ""}`, {
      fanId: item.fanId,
      accountId: item.accountId,
      sessions: item.sessions,
      dwellSeconds: item.dwellSeconds,
      _revenue: item.revenue,
    });
  }

  let pendingSummary = null;
  for (const row of pendingRows || []) {
    const oldestAt = rowIso(row, "oldestPendingAt");
    const oldestSeconds = oldestAt ? Math.max(0, Math.floor((authorityNow.getTime() - new Date(oldestAt).getTime()) / 1000)) : null;
    const summary = {
      source: "team_pending_dialog_v1",
      pendingDialogs: Math.max(0, rowNumber(row, "pendingDialogs", 0)),
      pendingIncomingMessages: Math.max(0, rowNumber(row, "pendingIncomingMessages", 0)),
      unassignedDialogs: Math.max(0, rowNumber(row, "unassignedDialogs", 0)),
      seenDialogs: Math.max(0, rowNumber(row, "seenDialogs", 0)),
      olderThan15m: Math.max(0, rowNumber(row, "olderThan15m", 0)),
      olderThan60m: Math.max(0, rowNumber(row, "olderThan60m", 0)),
      oldestPendingAt: oldestAt,
      oldestPendingSeconds: oldestSeconds,
    };
    if (Number(row?.isTotal) === 1) {
      pendingSummary = summary;
      continue;
    }
    if (!row.memberId) continue;
    const metric = metricFor(row.memberId);
    if (!metric) continue;
    metric.unansweredIncomingCount = summary.pendingDialogs;
    metric.unansweredIncomingMessages = summary.pendingIncomingMessages;
    metric.unansweredOlderThan15m = summary.olderThan15m;
    metric.unansweredOlderThan60m = summary.olderThan60m;
    metric.oldestUnansweredSeconds = summary.oldestPendingSeconds;
  }
  if (!pendingSummary) pendingSummary = { source: "team_pending_dialog_v1", pendingDialogs: 0, pendingIncomingMessages: 0, unassignedDialogs: 0, seenDialogs: 0, olderThan15m: 0, olderThan60m: 0, oldestPendingAt: null, oldestPendingSeconds: null };

  for (const row of audienceRows || []) {
    const metric = metricFor(row.memberId);
    if (!metric) continue;
    metric.uniqueFans = Math.max(0, rowNumber(row, "uniqueFans", 0));
    metric.creatorCoverage = Math.max(0, rowNumber(row, "creatorCoverage", 0));
  }

  const revenueByMember = new Map();
  for (const row of moneyRows || []) {
    const metric = metricFor(row.memberId);
    if (!metric) continue;
    if (Number(row?.sourceGrouped) === 1 && Number(row?.currencyGrouped) === 1) {
          continue;
    }
    const currency = normalizeCurrency(row.currency);
    const cents = Math.max(0, rowNumber(row, "amountCents", 0));
    addCurrencyToMap(revenueByMember, row.memberId, currency, cents);
    if (String(row.sourceType || "").toUpperCase() === "PPV") {
      metric.ppvSoldMessages += Math.max(0, rowNumber(row, "factCount", 0));
      metric._ppvRevenueByCurrency.set(currency, (metric._ppvRevenueByCurrency.get(currency) || 0) + cents);
    }
  }

  const byMember = new Map();
  for (const [memberId, metric] of metricsByMember.entries()) {
    const revenueBucket = revenueByMember.get(memberId) || new Map();
    if (includeMoney) {
      const revenue = singleCurrencyValue(revenueBucket);
      metric.revenueByCurrency = currencyBucketObject(revenueBucket);
      metric.revenueAttributedCents = revenue.cents;
      metric.revenueCurrency = revenue.currency;
      metric.moneySource = revenue.mixed ? "team_money_fact_v2_multi_currency" : "team_money_fact_v2";
    }
    const cleaned = cleanMetric(metric);
    if (includeMoney && Array.isArray(cleaned.topDialogSessions)) {
      cleaned.topDialogSessions = cleaned.topDialogSessions.map((dialog) => {
        const item = dialogBuckets.get(`${memberId}|${dialog.accountId || ""}|${dialog.fanId || ""}`);
        const bucket = item?._revenue || new Map();
        const revenue = singleCurrencyValue(bucket);
        const sharePct = cleaned.dialogDwellSeconds > 0 ? Math.round((num(dialog.dwellSeconds, 0) / cleaned.dialogDwellSeconds) * 100) : 0;
        return { ...dialog, shiftRevenueByCurrency: currencyBucketObject(bucket), shiftRevenueCents: revenue.cents, shiftRevenueCurrency: revenue.currency, shiftRevenueUsd: revenue.currency === "USD" ? Math.round(revenue.cents || 0) / 100 : null, shiftTimeSharePct: sharePct };
      });
    } else if (Array.isArray(cleaned.topDialogSessions)) {
      cleaned.topDialogSessions = cleaned.topDialogSessions.map((dialog) => ({ ...dialog, shiftTimeSharePct: cleaned.dialogDwellSeconds > 0 ? Math.round((num(dialog.dwellSeconds, 0) / cleaned.dialogDwellSeconds) * 100) : 0 }));
    }
    if (!includeMoney) {
      cleaned.revenueAttributedCents = null;
      cleaned.revenueByCurrency = null;
      cleaned.revenueCurrency = null;
      cleaned.dollarsPerMessageCents = null;
      cleaned.ppvRevenueCents = null;
      cleaned.ppvRevenueCurrency = null;
      cleaned.ppvRevenueByCurrency = null;
      cleaned.ppvSoldMessages = null;
      cleaned.ppvOpenRatePct = null;
      cleaned.moneySource = null;
    }
    byMember.set(memberId, cleaned);
  }

  const responseSource = currentResponseGeneration
    ? (projectionDetail.responseCoverage.status === "FULL" ? "team_response_case_v2" : (responseRange ? "bounded_projection_partial_v2" : "unavailable"))
    : (projectionDetail.responseCoverage.status === "FULL" ? "team_response_case_legacy_transition" : (responseRange ? "bounded_projection_partial" : "unavailable"));
  const responseSummary = responseSummaryFromAggregate(totalResponseRow || {}, responseSource, projectionDetail.responseAvailableFrom?.toISOString?.() || null);
  const activityCoverage = coverageState(range, historicalCoverage.activityCoverageFrom);
  const baseMoneyCoverage = coverageState(range, historicalCoverage.moneyCoverageFrom);
  const classificationUnresolved = Math.max(0, Number(moneyRootCoverageStatus?.row?.unresolvedCount || 0));
  const moneyCoverage = includeMoney ? {
    ...baseMoneyCoverage,
    status: moneyRootCoverageStatus?.ready ? (classificationUnresolved > 0 ? "PARTIAL" : baseMoneyCoverage.status) : "PARTIAL",
    rootClassification: moneyRootCoverageStatus?.state || "MISSING",
    unresolvedRootGenerations: classificationUnresolved,
    readSummaryGeneration: moneyReadSummaryStatus?.coverage?.state || "MISSING",
    readSummaryCurrent: moneyReadSummaryStatus?.ready === true,
    readSummaryOutstanding: moneyReadSummaryStatus?.outstanding,
  } : baseMoneyCoverage;
  const rawDistinctCoverage = coverageState(range, projectionDetail.detailRetainedFrom);

  return {
    range,
    members,
    byMember,
    responseSummary,
    pendingSummary,
    projection: {
      responseCases: Math.max(0, rowNumber(totalResponseRow, "cases", 0)),
      dialogSessions: Array.from(byMember.values()).reduce((sum, metric) => sum + Math.max(0, num(metric.dialogSessionsCount, 0)), 0),
      responseSource,
      dialogSessionSource: projectionDetail.dialogCoverage.status === "FULL" ? "team_dialog_session_v1" : (dialogRange ? "bounded_projection_partial" : "unavailable"),
      responseCoverageFrom: projectionDetail.responseAvailableFrom?.toISOString?.() || null,
      dialogCoverageFrom: projectionDetail.dialogAvailableFrom?.toISOString?.() || null,
      unansweredSource: "team_pending_dialog_v1",
      creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
      readAuthority: "team_analytics_read_authority_v1",
      queryShape: "sql_aggregate_bounded_v1",
      projectionGeneration: {
        dialog: currentDialogGeneration ? "team_pending_v2" : "LEGACY_TRANSITION",
        response: currentResponseGeneration ? "team_response_v2" : "LEGACY_TRANSITION",
      },
      historical: {
        version: "team_historical_analytics_v1",
        authoritySource: historicalCoverage.source,
        rawDetailRetainedFrom: projectionDetail.detailRetainedFrom.toISOString(),
        rawDetailDays: detailDays,
        families: {
          manualActivity: { ...activityCoverage, source: exactRawActivity ? "team_activity_event_v13_exact_sql" : historicalCoverage.activityProjectionVersion },
          content: { ...activityCoverage, source: exactRawActivity ? "team_activity_event_v13_exact_sql" : historicalCoverage.activityProjectionVersion },
          money: { ...moneyCoverage, source: historicalCoverage.moneyProjectionVersion },
          responses: { ...projectionDetail.responseCoverage, source: "bounded_team_response_case_v1_sql" },
          dialogs: { ...projectionDetail.dialogCoverage, source: "bounded_team_dialog_session_v1_sql" },
          distinctFansAndLegacyActivity: { ...rawDistinctCoverage, source: "bounded_team_activity_detail_sql" },
        },
      },
    },
  };
}


async function buildComputed({ agencyId, rangeKey = "7d", allowedCreatorIds = null }) {
  const authorityNow = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const range = resolveRange(rangeKey, authorityNow);
  const [projectionCoverage, historicalCoverage, retentionPolicy] = await Promise.all([
    loadProjectionCoverage({ agencyId }),
    loadHistoricalCoverage({ agencyId }),
    getRetentionSettings(),
  ]);
  if (retentionPolicy?.ok !== true) throw analyticsUnavailable("retention_policy", new Error("Team retention policy unavailable"));
  const detailDays = Number(retentionPolicy.settings?.teamCanonicalDetailDays || 180);
  const projectionDetail = buildProjectionDetailAuthority({
    range,
    authorityNow,
    detailDays,
    responseCoverageFrom: projectionCoverage.responseCoverageFrom,
    dialogCoverageFrom: projectionCoverage.dialogCoverageFrom,
  });
  const canonicalDetailRetainedFrom = projectionDetail.detailRetainedFrom;
  const rawRange = clampRangeToDetail(range, detailDays);
  const useDailyActivity = String(range.key || "") !== "24h";
  const responseRange = projectionDetail.responseRange;
  const dialogRange = projectionDetail.dialogRange;
  const [members, events, activityDaily, ppvPurchases, responseCases, projectedDialogSessions, pendingProjection] = await Promise.all([
    getMembersShell(agencyId),
    rawRange ? loadV3Events({ agencyId, range: rawRange, allowedCreatorIds }) : Promise.resolve([]),
    useDailyActivity ? loadActivityDaily({ agencyId, range, allowedCreatorIds }) : Promise.resolve([]),
    loadPpvMoneyFacts({ agencyId, range, allowedCreatorIds }),
    responseRange ? loadProjectedResponseCases({ agencyId, range: responseRange, allowedCreatorIds }) : Promise.resolve([]),
    dialogRange ? loadProjectedDialogSessions({ agencyId, range: dialogRange, allowedCreatorIds }) : Promise.resolve([]),
    loadProjectedPendingStates({ agencyId, allowedCreatorIds }),
  ]);
  const responseProjectionCoversRange = projectionDetail.responseCoverage.status === "FULL";
  const dialogProjectionCoversRange = projectionDetail.dialogCoverage.status === "FULL";

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

  function historicalActivityOwns(ev) {
    return useDailyActivity && projectionOwnsTimestamp(eventTs(ev), historicalCoverage.activityCoverageFrom);
  }

  if (useDailyActivity) {
    for (const row of activityDaily || []) {
      const m = metricFor(row.memberId);
      if (!m) continue;
      m.messagesSent += Math.max(0, num(row.messagesSent, 0));
      m.ppvSentMessages += Math.max(0, num(row.ppvSentMessages, 0));
      m.broadcastDispatches += Math.max(0, num(row.broadcastDispatches, 0));
      m.postsCreated += Math.max(0, num(row.postsCreated, 0));
      m.storiesCreated += Math.max(0, num(row.storiesCreated, 0));
      m.contentActions += Math.max(0, num(row.contentActions, 0));
      m.contentMediaItemsPublished += Math.max(0, num(row.contentMediaItemsPublished, 0));
      if (row.creatorId) m._creators.add(String(row.creatorId));
      if (row.creatorId && num(row.contentActions, 0) > 0) m._contentCreators.add(String(row.creatorId));
      if (num(row.contentActions, 0) > 0 && row.day) {
        const day = new Date(row.day);
        if (Number.isFinite(day.getTime())) m._contentDays.add(day.toISOString().slice(0, 10));
      }
      if (row.lastContentActivityAt) {
        const at = new Date(row.lastContentActivityAt);
        const previous = m.lastContentActivityAt ? new Date(m.lastContentActivityAt).getTime() : 0;
        if (Number.isFinite(at.getTime()) && at.getTime() >= previous) m.lastContentActivityAt = at.toISOString();
      }
    }
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

  // Durable TeamMoneyAttributionFact is the long-range money source of truth.
  // Raw claims ledgers remain recent detail/conflict evidence only. Historical
  // telemetry must never resurrect revenue that the durable fact deactivated.
  const ledgerPpvPurchaseIds = new Set();
  for (const p of ppvPurchases || []) {
    const purchaseId = String(p.externalId || "").trim();
    if (purchaseId) ledgerPpvPurchaseIds.add(purchaseId);

    if (p.attributionActive !== true) continue;

    const ownerMemberId = String(p.memberId || "").trim();
    const ownerMetric = metricFor(ownerMemberId);
    if (!ownerMetric) continue;

    const amount = Math.max(0, num(p.amountCents, 0));
    const currency = normalizeCurrency(p.currency);
    ownerMetric.ppvSoldMessages += 1;
    ownerMetric._ppvRevenueByCurrency.set(currency, (ownerMetric._ppvRevenueByCurrency.get(currency) || 0) + amount);
    if (p.fanId) ownerMetric._fans.add(String(p.fanId));
    if (p.creatorId) ownerMetric._creators.add(String(p.creatorId));
    if (purchaseId) seenPpvPurchaseIds.add(purchaseId);
  }

  const hasProjectedResponses = responseProjectionCoversRange;
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

  const hasProjectedDialogSessions = dialogProjectionCoversRange;
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
        if (!historicalActivityOwns(ev)) {
          m.messagesSent += 1;
          if (ev.isPpv === true || num(ev.priceCents, 0) > 0) m.ppvSentMessages += 1;
        }
        const pending = pendingByDialog.get(key);
        if (pending && !pending.closed && Number(pending.firstSeenAt || 0) <= eventTs(ev)) pending.closed = true;
      } else if (canonicalSource === "AUTOMATION" && m) {
        // Normally automation has no human memberId by ingest policy. Keep this
        // defensive branch so malformed legacy rows still cannot count manual.
        m.automationDeliveries += 1;
      }
      continue;
    }

    if (canonicalKind === "CONTENT_POST_PUBLISHED_CONFIRMED" || canonicalKind === "CONTENT_STORY_PUBLISHED_CONFIRMED") {
      if (String(ev.lifecycle || "").toUpperCase() !== "CONFIRMED" || canonicalSource !== "MANUAL" || !m) continue;
      if (!historicalActivityOwns(ev)) {
        if (canonicalKind === "CONTENT_POST_PUBLISHED_CONFIRMED") m.postsCreated += 1;
        else m.storiesCreated += 1;
        m.contentActions += 1;
        m.contentMediaItemsPublished += Math.max(0, num(ev.mediaCount ?? extra.mediaCount, 0));
        if (accountId) m._contentCreators.add(accountId);
        const ts = new Date(ev.ts || extra.occurredAt || Date.now());
        if (Number.isFinite(ts.getTime())) {
          m._contentDays.add(ts.toISOString().slice(0, 10));
          const previous = m.lastContentActivityAt ? new Date(m.lastContentActivityAt).getTime() : 0;
          if (ts.getTime() >= previous) m.lastContentActivityAt = ts.toISOString();
        }
      }
      continue;
    }

    if (canonicalKind === "BROADCAST_QUEUE_CANCELED_CONFIRMED") {
      continue;
    }

    if (canonicalKind === "BROADCAST_DISPATCH_CONFIRMED") {
      if (m && !historicalActivityOwns(ev)) m.broadcastDispatches += 1;
      continue;
    }

    if (canonicalKind === "DIALOG_SESSION") {
      if (projectionOwnsTimestamp(eventTs(ev), projectionCoverage.dialogCoverageFrom)) continue;
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
      if (!historicalActivityOwns(ev) && m && (type === "ppv_message_sent_recorded" || extra.isPpv === true)) {
        m.ppvSentMessages += 1;
      }
      continue;
    }

    if (type === "ppv_purchase_attributed" || type === "ppv_purchase_unresolved") {
      // Audit15: retained historical telemetry is provenance/history only.
      // Team money is read exclusively from TeamPpvPurchaseLedger, whose rows
      // are projected from canonical CreatorSale facts. Never resurrect revenue
      // from an old client-authored PPV event when the canonical ledger is absent.
      continue;
    }

    if (type === "chat_message_sent_local") {
      if (!historicalActivityOwns(ev) && m) m.messagesSent += 1;

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
      if (!projectionOwnsTimestamp(eventTs(ev), projectionCoverage.responseCoverageFrom) && isFreshReply && suppliedReplySeconds !== null) {
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
  responseSummary.source = responseProjectionCoversRange
    ? "team_response_case_v1"
    : (responseRange ? "hybrid_legacy_before_projection_coverage" : "legacy_event_fallback");
  responseSummary.coverageFrom = projectionDetail.responseAvailableFrom?.toISOString?.() || null;

  const activityCoverage = coverageState(range, historicalCoverage.activityCoverageFrom);
  const moneyCoverage = coverageState(range, historicalCoverage.moneyCoverageFrom);
  const responseCoverage = projectionDetail.responseCoverage;
  const dialogCoverage = projectionDetail.dialogCoverage;
  const rawDistinctCoverage = coverageState(range, canonicalDetailRetainedFrom);

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
      responseSource: responseProjectionCoversRange
        ? "team_response_case_v1"
        : (responseRange ? "hybrid_legacy_before_projection_coverage" : "legacy_event_fallback"),
      dialogSessionSource: dialogProjectionCoversRange
        ? "team_dialog_session_v1"
        : (dialogRange ? "hybrid_legacy_before_projection_coverage" : "event_fallback"),
      responseCoverageFrom: projectionDetail.responseAvailableFrom?.toISOString?.() || null,
      dialogCoverageFrom: projectionDetail.dialogAvailableFrom?.toISOString?.() || null,
      unansweredSource: hasProjectedPending ? "team_pending_dialog_v1" : (responseProjectionCoversRange ? "not_projected" : "legacy_event_fallback"),
      creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds.map(String) : "all",
      historical: {
        version: "team_historical_analytics_v1",
        authoritySource: historicalCoverage.source,
        rawDetailRetainedFrom: canonicalDetailRetainedFrom.toISOString(),
        rawDetailDays: detailDays,
        families: {
          manualActivity: { ...activityCoverage, source: useDailyActivity ? historicalCoverage.activityProjectionVersion : "team_activity_event_v13_exact" },
          content: { ...activityCoverage, source: useDailyActivity ? historicalCoverage.activityProjectionVersion : "team_activity_event_v13_exact" },
          money: { ...moneyCoverage, source: historicalCoverage.moneyProjectionVersion },
          responses: { ...responseCoverage, source: "bounded_team_response_case_v1" },
          dialogs: { ...dialogCoverage, source: "bounded_team_dialog_session_v1" },
          distinctFansAndLegacyActivity: { ...rawDistinctCoverage, source: "bounded_team_activity_detail" },
        },
      },
    },
  };
}

const ATTRIBUTED_PPV_STATUSES = ["attributed", "resolved"];
const ATTRIBUTED_TIP_STATUSES = ["attributed", "claimed", "resolved"];

function normalizeCurrency(value) {
  const currency = String(value || "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "USD";
}

function addCurrencyToMap(map, key, currency, cents) {
  const safeKey = String(key || "").trim();
  if (!safeKey) return;
  const code = normalizeCurrency(currency);
  const bucket = map.get(safeKey) || new Map();
  bucket.set(code, (bucket.get(code) || 0) + Math.max(0, num(cents, 0)));
  map.set(safeKey, bucket);
}

function mergeRevenueCurrencyMaps(...maps) {
  const out = new Map();
  for (const map of maps || []) {
    for (const [key, bucket] of map?.entries?.() || []) {
      for (const [currency, cents] of bucket?.entries?.() || []) addCurrencyToMap(out, key, currency, cents);
    }
  }
  return out;
}

function currencyBucketObject(bucket) {
  return Object.fromEntries([...(bucket?.entries?.() || [])].sort(([a], [b]) => a.localeCompare(b)));
}

function singleCurrencyValue(bucket) {
  const entries = [...(bucket?.entries?.() || [])];
  if (entries.length === 0) return { cents: 0, currency: null, mixed: false };
  if (entries.length === 1) return { cents: entries[0][1], currency: entries[0][0], mixed: false };
  return { cents: null, currency: null, mixed: true };
}

function bucketTotal(bucket) {
  let total = 0;
  for (const value of bucket?.values?.() || []) total += Math.max(0, num(value, 0));
  return total;
}

function formatCurrencyBucketForAlert(bucketObject) {
  const entries = Object.entries(bucketObject && typeof bucketObject === "object" ? bucketObject : {})
    .map(([currency, cents]) => [normalizeCurrency(currency), Math.max(0, num(cents, 0))])
    .filter(([, cents]) => cents > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return { text: "no attributed revenue", hasRevenue: false, mixed: false };
  return {
    text: entries.map(([currency, cents]) => `${currency} ${(cents / 100).toFixed(2)}`).join(" + "),
    hasRevenue: true,
    mixed: entries.length > 1,
  };
}

async function getPpvLedgerRevenueByMember({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await prisma.teamMoneyAttributionFact.groupBy({
      by: ["memberId", "currency"],
      where: { agencyId, sourceType: "PPV", classificationState: "CANONICAL", attributionActive: true, ...creatorScopeWhere(allowedCreatorIds), memberId: { not: null }, ...whereForRange("occurredAt", range) },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) if (row.memberId) addCurrencyToMap(map, row.memberId, row.currency, row?._sum?.amountCents);
    return map;
  } catch (err) { throw analyticsUnavailable("ppv_revenue", err); }
}

async function getPpvLedgerRevenueByMemberDialog({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamMoneyAttributionFact, {
      where: { agencyId, sourceType: "PPV", classificationState: "CANONICAL", attributionActive: true, ...creatorScopeWhere(allowedCreatorIds), memberId: { not: null }, ...whereForRange("occurredAt", range) },
      select: { id: true, memberId: true, fanId: true, dialogId: true, amountCents: true, currency: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      const fanKey = row.fanId || row.dialogId;
      if (row.memberId && fanKey) addCurrencyToMap(map, `${row.memberId}|${fanKey}`, row.currency, row.amountCents);
    }
    return map;
  } catch (err) { throw analyticsUnavailable("ppv_revenue_dialog", err); }
}

async function getTipLedgerRevenueByMember({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await prisma.teamMoneyAttributionFact.groupBy({
      by: ["memberId", "currency"],
      where: { agencyId, sourceType: "TIP", classificationState: "CANONICAL", attributionActive: true, ...creatorScopeWhere(allowedCreatorIds), memberId: { not: null }, ...whereForRange("occurredAt", range) },
      _sum: { amountCents: true },
    });
    const map = new Map();
    for (const row of rows || []) if (row.memberId) addCurrencyToMap(map, row.memberId, row.currency, row?._sum?.amountCents);
    return map;
  } catch (err) { throw analyticsUnavailable("tip_revenue", err); }
}

async function getTipLedgerRevenueByMemberDialog({ agencyId, range, allowedCreatorIds = null }) {
  try {
    const rows = await findAllById(prisma.teamMoneyAttributionFact, {
      where: { agencyId, sourceType: "TIP", classificationState: "CANONICAL", attributionActive: true, ...creatorScopeWhere(allowedCreatorIds), memberId: { not: null }, ...whereForRange("occurredAt", range) },
      select: { id: true, memberId: true, fanId: true, dialogId: true, amountCents: true, currency: true },
    });
    const map = new Map();
    for (const row of rows || []) {
      const fanKey = row.fanId || row.dialogId;
      if (row.memberId && fanKey) addCurrencyToMap(map, `${row.memberId}|${fanKey}`, row.currency, row.amountCents);
    }
    return map;
  } catch (err) { throw analyticsUnavailable("tip_revenue_dialog", err); }
}


function memberHasHistoricalActivity(metrics, revenueCents = 0) {
  if (Math.max(0, num(revenueCents, 0)) > 0) return true;
  const numericKeys = [
    "messagesSent", "manualMessages", "massMessages", "broadcastDispatches", "automationDeliveries",
    "incomingMessages", "freshReplies", "backlogReplies", "handoffReplies", "unknownReplies",
    "responseSamples", "dialogDwellSeconds", "dialogSessionsCount", "ppvSentMessages", "ppvSoldMessages",
    "ppvRevenueCents", "revenueAttributedCents", "activeEvents", "activeMinutes", "chatOpened",
    "engagementReplies", "backlogCleared",
  ];
  return numericKeys.some((key) => Math.max(0, num(metrics?.[key], 0)) > 0);
}

async function buildTeamMembers({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const scaleAuthority = supportsTeamScaleReadAuthority();
  if (!scaleAuthority && !isReducedTeamAnalyticsTestDouble()) {
    throw analyticsUnavailable("scale_read_authority", new Error("TEAM_ANALYTICS_SCALE_READ_AUTHORITY_REQUIRED"));
  }
  const computed = scaleAuthority
    ? await buildComputedScale({ agencyId, rangeKey, includeMoney, allowedCreatorIds })
    : await buildComputed({ agencyId, rangeKey, allowedCreatorIds });

  if (scaleAuthority) {
    const rows = computed.members.map((member) => {
      const shell = memberShell(member);
      const metrics = computed.byMember.get(String(member.id)) || cleanMetric(emptyMetric());
      const historicalValue = includeMoney ? Math.max(0, num(metrics.revenueAttributedCents, 0)) : 0;
      return {
        member: shell,
        metrics,
        rawSummary: null,
        _historicalVisible: !member.deletedAt || memberHasHistoricalActivity(metrics, historicalValue),
      };
    }).filter((row) => row._historicalVisible).map(({ _historicalVisible, ...row }) => row);

    return {
      ok: true,
      range: rangeForClient(computed.range),
      snapshot: null,
      members: rows,
      source: "team_analytics_read_authority_v1",
      projection: computed.projection,
      responseSummary: computed.responseSummary,
      pendingSummary: computed.pendingSummary || null,
      moneyVisible: includeMoney === true,
    };
  }

  // Unit-test / reduced-double compatibility path. Production Prisma exposes
  // the aggregate + raw-query surface above; this branch preserves isolated
  // semantic tests without turning historical materialization back into a
  // production read authority.
  const [
    ppvRevenueByMember,
    tipLedgerRevenueByMember,
    ppvRevenueByMemberDialog,
    tipLedgerRevenueByMemberDialog,
  ] = includeMoney ? await Promise.all([
    getPpvLedgerRevenueByMember({ agencyId, range: computed.range, allowedCreatorIds }),
    getTipLedgerRevenueByMember({ agencyId, range: computed.range, allowedCreatorIds }),
    getPpvLedgerRevenueByMemberDialog({ agencyId, range: computed.range, allowedCreatorIds }),
    getTipLedgerRevenueByMemberDialog({ agencyId, range: computed.range, allowedCreatorIds }),
  ]) : [new Map(), new Map(), new Map(), new Map()];
  const revenueByMember = mergeRevenueCurrencyMaps(ppvRevenueByMember, tipLedgerRevenueByMember);
  const revenueByMemberDialog = mergeRevenueCurrencyMaps(ppvRevenueByMemberDialog, tipLedgerRevenueByMemberDialog);

  const rows = computed.members.map((member) => {
    const shell = memberShell(member);
    const metrics = computed.byMember.get(String(member.id)) || cleanMetric(emptyMetric());
    const revenueBucket = revenueByMember.get(String(member.id)) || new Map();
    const revenue = singleCurrencyValue(revenueBucket);
    if (includeMoney) {
      metrics.revenueByCurrency = currencyBucketObject(revenueBucket);
      metrics.revenueAttributedCents = revenue.cents;
      metrics.revenueCurrency = revenue.currency;
      metrics.dollarsPerMessageCents = revenue.cents !== null && metrics.messagesSent > 0 ? Math.round(revenue.cents / metrics.messagesSent) : (revenue.cents === 0 ? 0 : null);
      metrics.moneySource = revenue.mixed ? "team_money_fact_v2_multi_currency" : "team_money_fact_v2";
    }
    if (!includeMoney) {
      metrics.revenueAttributedCents = null;
      metrics.dollarsPerMessageCents = null;
      metrics.ppvRevenueCents = null;
      metrics.ppvRevenueCurrency = null;
      metrics.ppvRevenueByCurrency = null;
      metrics.ppvSoldMessages = null;
      metrics.ppvOpenRatePct = null;
      metrics.moneySource = null;
      metrics.revenueByCurrency = null;
      metrics.revenueCurrency = null;
    }
    if (Array.isArray(metrics.topDialogSessions)) {
      metrics.topDialogSessions = metrics.topDialogSessions.map((item) => {
        const dialogBucket = includeMoney ? (revenueByMemberDialog.get(`${shell.id}|${item.fanId || ""}`) || new Map()) : new Map();
        const dialogRevenue = singleCurrencyValue(dialogBucket);
        const sharePct = metrics.dialogDwellSeconds > 0 ? Math.round((num(item.dwellSeconds, 0) / metrics.dialogDwellSeconds) * 100) : 0;
        return includeMoney
          ? { ...item, shiftRevenueByCurrency: currencyBucketObject(dialogBucket), shiftRevenueCents: dialogRevenue.cents, shiftRevenueCurrency: dialogRevenue.currency, shiftRevenueUsd: dialogRevenue.currency === "USD" ? Math.round(dialogRevenue.cents || 0) / 100 : null, shiftTimeSharePct: sharePct }
          : { ...item, shiftTimeSharePct: sharePct };
      });
    }
    return { member: shell, metrics, rawSummary: null, _historicalVisible: !member.deletedAt || memberHasHistoricalActivity(metrics, bucketTotal(revenueBucket)) };
  }).filter((row) => row._historicalVisible).map(({ _historicalVisible, ...row }) => row);

  return {
    ok: true,
    range: rangeForClient(computed.range),
    snapshot: null,
    members: rows,
    source: "team_historical_authority_v1",
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
    contentActions: 0,
    contentMediaItemsPublished: 0,
    contentCreatorCoverage: 0,
    contentActiveDays: 0,
    lastContentActivityAt: null,
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
    ppvRevenueCurrency: null,
    ppvRevenueByCurrency: {},
    ppvOpenRatePct: null,
    uniqueFans: 0,
    activeCreators: 0,
    activeMembers: 0,
    membersCount,
    devicesOnline: 0,
    eventsCount: 0,
    revenueAttributedCents: 0,
    revenueByCurrency: {},
    revenueCurrency: null,
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
    source: "team_historical_authority_v1",
  };
  const fans = new Set();
  let responseWeightedSeconds = 0;
  let responseWeightedSamples = 0;
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
    out.contentActions += num(m.contentActions, 0);
    out.contentMediaItemsPublished += num(m.contentMediaItemsPublished, 0);
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
    for (const [currency, cents] of Object.entries(m.ppvRevenueByCurrency || {})) {
      out.ppvRevenueByCurrency[currency] = (out.ppvRevenueByCurrency[currency] || 0) + Math.max(0, num(cents, 0));
    }
    for (const [currency, cents] of Object.entries(m.revenueByCurrency || {})) {
      out.revenueByCurrency[currency] = (out.revenueByCurrency[currency] || 0) + Math.max(0, num(cents, 0));
    }
    if (num(m.activeEvents, 0) > 0) out.activeMembers += 1;
    if (num(m.creatorCoverage, 0) > 0) out.activeCreators += num(m.creatorCoverage, 0);
    out.eventsCount += num(m.activeEvents, 0);
    if (num(m.avgResponseSeconds, NaN) === num(m.avgResponseSeconds, NaN) && num(m.responseSamples, 0) > 0) {
      const samples = num(m.responseSamples, 0);
      responseWeightedSeconds += num(m.avgResponseSeconds, 0) * samples;
      responseWeightedSamples += samples;
      const pct15 = nullableNum(m.slaReply15mPct);
      if (pct15 !== null) {
        sla15Good += (pct15 / 100) * samples;
        sla15Samples += samples;
      }
    }
  }
  out.avgResponseSeconds = responseWeightedSamples > 0 ? responseWeightedSeconds / responseWeightedSamples : null;
  out.slaReply15mPct = sla15Samples > 0 ? (sla15Good / sla15Samples) * 100 : null;
  const overviewCurrencies = Object.entries(out.revenueByCurrency || {});
  if (overviewCurrencies.length === 0) {
    out.revenueAttributedCents = 0; out.revenueCurrency = null;
  } else if (overviewCurrencies.length === 1) {
    out.revenueCurrency = overviewCurrencies[0][0]; out.revenueAttributedCents = overviewCurrencies[0][1];
  } else {
    out.revenueCurrency = null; out.revenueAttributedCents = null;
  }
  out.dollarsPerMessageCents = out.revenueAttributedCents !== null && out.messagesSent > 0 ? Math.round(out.revenueAttributedCents / out.messagesSent) : (out.revenueAttributedCents === 0 ? 0 : null);
  const ppvOverviewCurrencies = Object.entries(out.ppvRevenueByCurrency || {});
  if (ppvOverviewCurrencies.length === 0) {
    out.ppvRevenueCents = 0; out.ppvRevenueCurrency = null;
  } else if (ppvOverviewCurrencies.length === 1) {
    out.ppvRevenueCurrency = ppvOverviewCurrencies[0][0]; out.ppvRevenueCents = ppvOverviewCurrencies[0][1];
  } else {
    out.ppvRevenueCurrency = null; out.ppvRevenueCents = null;
  }
  out.ppvOpenRatePct = out.ppvSentMessages > 0 ? (out.ppvSoldMessages / out.ppvSentMessages) * 100 : null;
  return out;
}

function buildOverviewFromMembersPayload(membersPayload, includeMoney) {
  const overview = combineOverview(membersPayload.members.map((r) => r.metrics), membersPayload.members.length);
  const responseSummary = membersPayload.responseSummary;
  if (responseSummary?.source && responseSummary.source !== "none" && responseSummary.source !== "unavailable") {
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
    overview.revenueByCurrency = null;
    overview.revenueCurrency = null;
    overview.dollarsPerMessageCents = null;
    overview.ppvRevenueCents = null;
    overview.ppvRevenueCurrency = null;
    overview.ppvRevenueByCurrency = null;
    overview.ppvSoldMessages = null;
    overview.ppvOpenRatePct = null;
  }
  return overview;
}

const teamSnapshotFlights = new Map();

function teamSnapshotKey({ agencyId, rangeKey, includeMoney, allowedCreatorIds }) {
  const scope = Array.isArray(allowedCreatorIds) ? [...new Set(allowedCreatorIds.map(String))].sort().join(",") : "all";
  return [String(agencyId), String(rangeKey || "7d"), includeMoney === true ? "money" : "no-money", scope].join("|");
}

async function buildTeamAnalyticsSnapshot({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const key = teamSnapshotKey({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
  const existing = teamSnapshotFlights.get(key);
  if (existing) return existing;

  const flight = (async () => {
    const membersPayload = await buildTeamMembers({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
    const overview = buildOverviewFromMembersPayload(membersPayload, includeMoney);
    return {
      ok: true,
      range: membersPayload.range,
      snapshot: {
        authorityVersion: "team_analytics_read_authority_v1",
        source: membersPayload.source,
      },
      overview,
      members: membersPayload.members,
      projection: membersPayload.projection || null,
      responseSummary: membersPayload.responseSummary || null,
      pendingSummary: membersPayload.pendingSummary || null,
      moneyVisible: includeMoney === true,
    };
  })();
  teamSnapshotFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (teamSnapshotFlights.get(key) === flight) teamSnapshotFlights.delete(key);
  }
}

async function buildTeamOverview({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const snapshot = await buildTeamAnalyticsSnapshot({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
  return {
    ok: true,
    range: snapshot.range,
    snapshot: snapshot.snapshot,
    overview: snapshot.overview,
    projection: snapshot.projection,
    responseSummary: snapshot.responseSummary,
    pendingSummary: snapshot.pendingSummary,
    moneyVisible: snapshot.moneyVisible,
  };
}

async function buildTeamAlerts({ agencyId, rangeKey = "7d", includeMoney = true, allowedCreatorIds = null }) {
  const snapshot = await buildTeamAnalyticsSnapshot({ agencyId, rangeKey, includeMoney, allowedCreatorIds });
  const membersPayload = { range: snapshot.range, members: snapshot.members };
  const alerts = [];
  if (includeMoney) {
    let jobConflicts;
    let purchaseConflicts;
    let tipConflicts;
    try {
      [jobConflicts, purchaseConflicts, tipConflicts] = await Promise.all([
        prisma.teamPpvResolveJob.count({ where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), status: "conflict" } }),
        prisma.teamPpvPurchaseLedger.count({ where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...activePpvFinancialWhere(), status: "conflict" } }),
        prisma.teamTipLedger.count({ where: { agencyId, ...creatorScopeWhere(allowedCreatorIds), ...activeTipFinancialWhere(), status: "conflict" } }),
      ]);
    } catch (err) {
      throw analyticsUnavailable("money_conflicts", err);
    }
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
      const revenue = includeMoney ? formatCurrencyBucketForAlert(topDialog.shiftRevenueByCurrency) : null;
      alerts.push({
        id: `focus_dialog_${row.member.id}_${topDialog.fanId || "unknown"}`,
        tone: includeMoney && revenue?.hasRevenue ? "warn" : "danger",
        title: `${name}: ${topDialog.shiftTimeSharePct}% shift time in one dialog`,
        text: includeMoney
          ? `Fan ${topDialog.fanId || "unknown"}: ${Math.round(num(topDialog.dwellSeconds, 0) / 60)} min, earned this shift ${revenue.text}.`
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
  buildTeamAnalyticsSnapshot,
  buildTeamOverview,
  buildTeamMembers,
  buildTeamAlerts,
  buildTeamFlags,
};
