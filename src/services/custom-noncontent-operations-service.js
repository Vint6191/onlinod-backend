"use strict";

const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { callPhaseSnapshot, paymentSnapshot } = require("./custom-orders-service");

const PHYSICAL_STAGES = ["WAITING", "READY", "SHIPPED"];

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function bounded(value, fallback, min, max) { const number = Math.floor(Number(value)); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback; }
function scopeWhere(scope) { if (scope?.broad) return {}; const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : []; return { creatorId: { in: ids.length ? ids : ["__none__"] } }; }
function creatorSummary(creator) { return creator ? { displayName: creator.displayName || null, username: creator.username || null, avatarUrl: creator.avatarUrl || null } : null; }
function money(row) { const payment = paymentSnapshot(row?.priceCents, row?.paidAmountCents); return { totalPriceCents: Math.max(0, Number(row?.priceCents || 0)), paidAmountCents: payment.paidAmountCents, remainingAmountCents: payment.remainingAmountCents, paymentStatus: payment.paymentStatus }; }
function iso(value) { if (!value) return null; const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }

async function exactCallSummarySql({ client, agencyId, scope, now, horizonAt }) {
  if (typeof client?.$queryRawUnsafe !== "function") return null;
  const params = [String(agencyId), now, horizonAt];
  let creatorClause = "";
  if (!scope?.broad) {
    const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
    if (!ids.length) return { upcoming: 0, due: 0, overdue: 0 };
    params.push(ids);
    creatorClause = ` AND "creatorId" = ANY($4::text[])`;
  }
  const rows = await client.$queryRawUnsafe(`
    SELECT
      COUNT(*) FILTER (WHERE "scheduledAt" > $2 AND "scheduledAt" <= $3)::int AS "upcoming",
      COUNT(*) FILTER (WHERE "scheduledAt" <= $2 AND "scheduledAt" + ("durationMinutes" * INTERVAL '1 minute') > $2)::int AS "due",
      COUNT(*) FILTER (WHERE "scheduledAt" + ("durationMinutes" * INTERVAL '1 minute') <= $2)::int AS "overdue"
    FROM "CustomOrder"
    WHERE "agencyId" = $1
      AND "type" = 'CALL'
      AND "status" = 'PENDING'
      AND "scheduledAt" IS NOT NULL
      ${creatorClause}
  `, ...params);
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    upcoming: Math.max(0, Number(row?.upcoming || 0)),
    due: Math.max(0, Number(row?.due || 0)),
    overdue: Math.max(0, Number(row?.overdue || 0)),
  };
}

async function requireView({ agencyId, member, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_OPERATIONS_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "team.analytics.view", db })) throw fail("CUSTOM_OPERATIONS_VIEW_FORBIDDEN", "team.analytics.view permission is required", 403);
}

function serializeCall(row, now) {
  const phase = callPhaseSnapshot(row, now);
  return {
    customOrderId: String(row.id), creatorId: String(row.creatorId), dialogId: String(row.dialogId), creator: creatorSummary(row.creator),
    scenario: String(row.scenario || ""), scheduledAt: iso(row.scheduledAt), durationMinutes: Math.max(1, Number(row.durationMinutes || 1)),
    callEndAt: phase.callEndAt ? phase.callEndAt.toISOString() : null, phase: phase.callPhase || "UPCOMING",
    secondsToStart: phase.callSecondsToStart, secondsSinceEnd: phase.callSecondsSinceEnd,
    telegramTaskDelivered: row.telegramTaskMessageId != null, createdAt: iso(row.createdAt), ...money(row),
  };
}

function serializePhysical(row, now) {
  const changed = row.physicalStatusChangedAt ? new Date(row.physicalStatusChangedAt) : null;
  const stageAgeSeconds = changed && Number.isFinite(changed.getTime()) ? Math.max(0, Math.floor((now.getTime() - changed.getTime()) / 1000)) : null;
  return {
    customOrderId: String(row.id), creatorId: String(row.creatorId), dialogId: String(row.dialogId), creator: creatorSummary(row.creator),
    scenario: String(row.scenario || ""), physicalStatus: String(row.physicalStatus || "WAITING"), physicalStatusChangedAt: iso(row.physicalStatusChangedAt),
    stageAgeSeconds, telegramTaskDelivered: row.telegramTaskMessageId != null, createdAt: iso(row.createdAt), ...money(row),
  };
}

async function listCustomNonContentOperations({ agencyId, member, horizonHours = 24, limit = 100, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma");
  await requireView({ agencyId, member, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const scopeFilter = scopeWhere(scope);
  const take = bounded(limit, 100, 1, 200);
  const horizon = bounded(horizonHours, 24, 1, 168);
  const horizonAt = new Date(now.getTime() + horizon * 60 * 60 * 1000);
  const include = { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } } };

  // CALL duration is validated to <= 1440 minutes. Anything that started
  // more than 24h ago is therefore definitely overdue and can be counted in
  // SQL without loading unbounded historical rows into every 30s Team poll.
  const definitelyOverdueBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const supportsExactSql = typeof client?.$queryRawUnsafe === "function";
  const recentDetailTake = Math.min(800, Math.max(take * 4, 200));
  const [oldOverdueCalls, oldOverdueCount, recentStartedCalls, upcomingCalls, upcomingCount, physicalRows, waitingCount, readyCount, shippedCount, exactCallSummary] = await Promise.all([
    client.customOrder.findMany({
      where: { agencyId, ...scopeFilter, type: "CALL", status: "PENDING", scheduledAt: { lte: definitelyOverdueBefore } },
      include,
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take,
    }),
    supportsExactSql ? Promise.resolve(null) : client.customOrder.count({ where: { agencyId, ...scopeFilter, type: "CALL", status: "PENDING", scheduledAt: { lte: definitelyOverdueBefore } } }),
    client.customOrder.findMany({
      where: { agencyId, ...scopeFilter, type: "CALL", status: "PENDING", scheduledAt: { gt: definitelyOverdueBefore, lte: now } },
      include,
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take: recentDetailTake,
    }),
    client.customOrder.findMany({
      where: { agencyId, ...scopeFilter, type: "CALL", status: "PENDING", scheduledAt: { gt: now, lte: horizonAt } },
      include,
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take,
    }),
    supportsExactSql ? Promise.resolve(null) : client.customOrder.count({ where: { agencyId, ...scopeFilter, type: "CALL", status: "PENDING", scheduledAt: { gt: now, lte: horizonAt } } }),
    client.customOrder.findMany({
      where: { agencyId, ...scopeFilter, type: "PHYSICAL", status: "PENDING", physicalStatus: { in: PHYSICAL_STAGES } },
      include,
      orderBy: [{ physicalStatusChangedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }, { id: "asc" }],
      take,
    }),
    client.customOrder.count({ where: { agencyId, ...scopeFilter, type: "PHYSICAL", status: "PENDING", physicalStatus: "WAITING" } }),
    client.customOrder.count({ where: { agencyId, ...scopeFilter, type: "PHYSICAL", status: "PENDING", physicalStatus: "READY" } }),
    client.customOrder.count({ where: { agencyId, ...scopeFilter, type: "PHYSICAL", status: "PENDING", physicalStatus: "SHIPPED" } }),
    supportsExactSql ? exactCallSummarySql({ client, agencyId, scope, now, horizonAt }) : Promise.resolve(null),
  ]);

  let dueCount = 0; let recentOverdueCount = 0;
  const startedSerialized = (recentStartedCalls || []).map((row) => serializeCall(row, now));
  for (const item of startedSerialized) { if (item.phase === "DUE") dueCount += 1; else if (item.phase === "OVERDUE") recentOverdueCount += 1; }
  const overdueCount = exactCallSummary ? exactCallSummary.overdue : Number(oldOverdueCount || 0) + recentOverdueCount;
  const exactDueCount = exactCallSummary ? exactCallSummary.due : dueCount;
  const exactUpcomingCount = exactCallSummary ? exactCallSummary.upcoming : Number(upcomingCount || 0);
  const callRank = { OVERDUE: 0, DUE: 1, UPCOMING: 2 };
  const calls = [...(oldOverdueCalls || []).map((row) => serializeCall(row, now)), ...startedSerialized, ...(upcomingCalls || []).map((row) => serializeCall(row, now))]
    .sort((a, b) => (callRank[a.phase] ?? 9) - (callRank[b.phase] ?? 9)
      || (a.phase === "OVERDUE" ? Number(b.secondsSinceEnd || 0) - Number(a.secondsSinceEnd || 0) : new Date(a.scheduledAt || 0).getTime() - new Date(b.scheduledAt || 0).getTime())
      || a.customOrderId.localeCompare(b.customOrderId))
    .slice(0, take);

  return {
    ok: true,
    calls,
    callSummary: { upcoming: exactUpcomingCount, due: exactDueCount, overdue: overdueCount, horizonHours: horizon },
    physical: (physicalRows || []).map((row) => serializePhysical(row, now)),
    physicalSummary: { waiting: Number(waitingCount || 0), ready: Number(readyCount || 0), shipped: Number(shippedCount || 0) },
    serverNow: now.toISOString(),
  };
}

module.exports = { listCustomNonContentOperations, serializeCall, serializePhysical };
