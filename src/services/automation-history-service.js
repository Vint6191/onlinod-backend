"use strict";

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function monthStart(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function counterShape() {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
    sent: 0,
    replied: 0,
    followed: 0,
    unfollowed: 0,
    liked: 0,
    commented: 0,
  };
}

function classifyAutomationDelivery(row) {
  const counters = counterShape();
  counters.total = 1;
  const status = String(row?.status || "").toUpperCase();
  if (status === "COMPLETED") counters.completed = 1;
  if (status === "FAILED") counters.failed = 1;
  if (status === "SKIPPED") counters.skipped = 1;
  if (status === "CANCELED") counters.canceled = 1;

  const action = String(row?.actionType || "").toUpperCase();
  const result = object(row?.result);
  if (status === "COMPLETED" && action === "SEND_MESSAGE") counters.sent = 1;
  if (result.replied === true || result.code === "replied") counters.replied = 1;
  if (status === "COMPLETED" && ["FOLLOW_BACK", "FOLLOW_FAN", "SFS_FOLLOW_TARGET"].includes(action)) counters.followed = 1;
  if (status === "COMPLETED" && ["UNFOLLOW_FAN", "SFS_UNFOLLOW_TARGET"].includes(action)) counters.unfollowed = 1;
  if (status === "COMPLETED" && ["LIKE_POST", "SFS_LIKE_COMMENT"].includes(action)) counters.liked = 1;
  if (status === "COMPLETED" && action === "SFS_COMMENT_POST") counters.commented = 1;
  return counters;
}

function addCounters(target, source) {
  for (const key of Object.keys(counterShape())) target[key] = Number(target[key] || 0) + Number(source?.[key] || 0);
  return target;
}

function aggregateKey(row) {
  const period = monthStart(row.finishedAt || row.updatedAt || row.createdAt);
  return `${row.agencyId}\u0000${row.creatorId}\u0000${row.moduleKey}\u0000${row.actionType}\u0000${period.toISOString()}`;
}

function groupDeliveriesForArchive(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = aggregateKey(row);
    let group = groups.get(key);
    const at = row.finishedAt || row.updatedAt || row.createdAt;
    if (!group) {
      group = {
        agencyId: row.agencyId,
        creatorId: row.creatorId,
        moduleKey: row.moduleKey,
        actionType: row.actionType,
        periodStart: monthStart(at),
        firstAt: at,
        lastAt: at,
        ...counterShape(),
      };
      groups.set(key, group);
    }
    addCounters(group, classifyAutomationDelivery(row));
    if (new Date(at) < new Date(group.firstAt)) group.firstAt = at;
    if (new Date(at) > new Date(group.lastAt)) group.lastAt = at;
  }
  return [...groups.values()];
}

async function compactAutomationDeliveries({ olderThan, batchSize = 2000, db = null }) {
  db = db || require("../prisma");
  let archived = 0;
  let aggregateUpdates = 0;
  for (;;) {
    const rows = await db.automationDelivery.findMany({
      where: {
        originKind: "AUTOMATION",
        status: { in: TERMINAL_STATUSES },
        AND: [{ OR: [{ failureCode: null }, { failureCode: { not: "outcome_unresolved_do_not_retry" } }] }],
        finishedAt: { not: null, lt: olderThan },
      },
      orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
      take: Math.max(100, Math.min(10000, Number(batchSize) || 2000)),
      select: {
        id: true,
        agencyId: true,
        creatorId: true,
        moduleKey: true,
        actionType: true,
        status: true,
        result: true,
        createdAt: true,
        updatedAt: true,
        finishedAt: true,
      },
    });
    if (!rows.length) break;
    const groups = groupDeliveriesForArchive(rows);
    await db.$transaction(async (tx) => {
      for (const group of groups) {
        const where = {
          creatorId_moduleKey_actionType_periodStart: {
            creatorId: group.creatorId,
            moduleKey: group.moduleKey,
            actionType: group.actionType,
            periodStart: group.periodStart,
          },
        };
        const existing = await tx.automationMonthlyAggregate.findUnique({ where });
        if (!existing) {
          await tx.automationMonthlyAggregate.create({ data: group });
        } else {
          await tx.automationMonthlyAggregate.update({
            where,
            data: {
              total: { increment: group.total },
              completed: { increment: group.completed },
              failed: { increment: group.failed },
              skipped: { increment: group.skipped },
              canceled: { increment: group.canceled },
              sent: { increment: group.sent },
              replied: { increment: group.replied },
              followed: { increment: group.followed },
              unfollowed: { increment: group.unfollowed },
              liked: { increment: group.liked },
              commented: { increment: group.commented },
              firstAt: !existing.firstAt || new Date(group.firstAt) < existing.firstAt ? group.firstAt : existing.firstAt,
              lastAt: !existing.lastAt || new Date(group.lastAt) > existing.lastAt ? group.lastAt : existing.lastAt,
            },
          });
        }
      }
      await tx.automationDelivery.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, originKind: "AUTOMATION", AND: [{ OR: [{ failureCode: null }, { failureCode: { not: "outcome_unresolved_do_not_retry" } }] }] } });
    });
    archived += rows.length;
    aggregateUpdates += groups.length;
    if (rows.length < batchSize) break;
  }
  return { label: "automationDelivery.compacted", archived, deleted: archived, aggregateUpdates };
}

function normalizeRange({ from = null, to = null, months = 12 } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - Math.max(1, Math.min(60, Number(months) || 12)) + 1, 1));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    const error = new Error("Invalid metrics date range");
    error.code = "INVALID_DATE_RANGE";
    error.status = 400;
    throw error;
  }
  return { start, end };
}

async function getAutomationMetrics({ agencyId, creatorId, from = null, to = null, months = 12, db = null }) {
  db = db || require("../prisma");
  const { start, end } = normalizeRange({ from, to, months });
  const [archived, liveRows, failures] = await Promise.all([
    db.automationMonthlyAggregate.findMany({
      where: { agencyId, creatorId, periodStart: { gte: monthStart(start), lte: end } },
      orderBy: [{ periodStart: "asc" }, { moduleKey: "asc" }, { actionType: "asc" }],
    }),
    db.automationDelivery.findMany({
      where: {
        agencyId,
        creatorId,
        originKind: "AUTOMATION",
        status: { in: TERMINAL_STATUSES },
        finishedAt: { gte: start, lte: end },
      },
      select: { moduleKey: true, actionType: true, status: true, result: true, finishedAt: true, updatedAt: true, createdAt: true, agencyId: true, creatorId: true },
      take: 100000,
    }),
    db.automationDelivery.groupBy({
      by: ["moduleKey", "failureCode"],
      where: { agencyId, creatorId, originKind: "AUTOMATION", status: "FAILED", finishedAt: { gte: start, lte: end } },
      _count: { _all: true },
    }),
  ]);

  const summary = counterShape();
  const byModule = {};
  const byMonth = {};
  const add = (moduleKey, period, counters) => {
    addCounters(summary, counters);
    byModule[moduleKey] = addCounters(byModule[moduleKey] || counterShape(), counters);
    byMonth[period] = addCounters(byMonth[period] || counterShape(), counters);
  };

  for (const row of archived) {
    add(row.moduleKey, row.periodStart.toISOString().slice(0, 7), row);
  }

  for (const row of liveRows) {
    const period = monthStart(row.finishedAt || row.updatedAt || row.createdAt).toISOString().slice(0, 7);
    add(row.moduleKey, period, classifyAutomationDelivery(row));
  }

  return {
    ok: true,
    range: { from: start, to: end },
    summary,
    byModule,
    byMonth: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([period, counters]) => ({ period, ...counters })),
    archivedMonths: archived.length,
    recentFailureCodes: failures
      .map((row) => ({ moduleKey: row.moduleKey, failureCode: row.failureCode || "unknown", count: row._count._all }))
      .sort((a, b) => b.count - a.count || a.moduleKey.localeCompare(b.moduleKey))
      .slice(0, 25),
  };
}


async function listAutomationAudit({ agencyId, creatorId, moduleKey = null, cursor = null, limit = 100, db = null }) {
  db = db || require("../prisma");
  const take = Math.max(1, Math.min(250, Number(limit) || 100));
  const where = {
    agencyId,
    action: { startsWith: "automation." },
    NOT: { action: { startsWith: "automation.mutation." } },
    OR: [
      { targetId: creatorId },
      { metadata: { path: ["creatorId"], equals: creatorId } },
    ],
    ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
  };
  if (moduleKey) {
    where.AND = [{ metadata: { path: ["moduleKey"], equals: moduleKey } }];
  }
  const rows = await db.auditLog.findMany({
    where,
    include: { actor: { select: { id: true, email: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  return {
    ok: true,
    items: rows.map((row) => ({
      id: row.id, action: row.action, targetType: row.targetType, targetId: row.targetId,
      metadata: row.metadata || {}, createdAt: row.createdAt,
      actor: row.actor ? { id: row.actor.id, email: row.actor.email, name: row.actor.name } : null,
    })),
    nextCursor: rows.length === take ? rows[rows.length - 1].createdAt : null,
  };
}
module.exports = {
  TERMINAL_STATUSES,
  monthStart,
  counterShape,
  classifyAutomationDelivery,
  addCounters,
  groupDeliveriesForArchive,
  compactAutomationDeliveries,
  normalizeRange,
  getAutomationMetrics,
  listAutomationAudit,
};
