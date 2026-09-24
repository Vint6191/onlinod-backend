"use strict";
const { runRootCommit } = require("./db-commit-kernel");

const { partitionAutomationDeliveryHardDeleteCandidates, isSfsFollowProof, sfsCandidateId } = require("./automation-delivery-hard-delete-guard");

const { createHash } = require("node:crypto");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { adminError } = require("./admin-command-contract");

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

// Caller owns the transaction. Selection is bounded, and only DELETE RETURNING
// owns a history contribution. Absence after another process deletes is not proof.
async function archiveAutomationDeliveryBatch({ tx, rows, olderThan, strict = false, commitGuard = null }) {
  if (!Array.isArray(rows) || rows.length > 500 || !Number.isFinite(new Date(olderThan).getTime())) throw new TypeError("Invalid bounded archive selection");
  if (commitGuard) await commitGuard(tx);
  const agencies = [...new Set(rows.map(row => row.agencyId))].sort();
  const liveAgencies = new Set();
  for (const agencyId of agencies) {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId });
    if (lifecycle.row && !lifecycle.row.deletedAt) liveAgencies.add(agencyId);
  }
  const creatorIds = [...new Set(rows.filter(row => liveAgencies.has(row.agencyId)).map(row => row.creatorId))].sort();
  const creators = creatorIds.length ? await tx.$queryRawUnsafe('SELECT "id", "agencyId", "deletedAt" FROM "CreatorAccount" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR SHARE', creatorIds) : [];
  const liveCreators = new Map(creators.filter(row => !row.deletedAt).map(row => [row.id, row.agencyId]));
  const eligible = rows.filter(row => liveCreators.get(row.creatorId) === row.agencyId);
  // SFS settlement locks candidate before delivery. Preserve that order and
  // retain missing/malformed candidate proofs conservatively.
  const candidateIds = [...new Set(eligible.filter(isSfsFollowProof).map(sfsCandidateId).filter(Boolean))].sort();
  const lockedCandidates = candidateIds.length ? await tx.$queryRawUnsafe('SELECT "id" FROM "SfsTargetCandidate" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR SHARE', candidateIds) : [];
  const knownCandidates = new Set(lockedCandidates.map(row => row.id));
  const manifest = eligible.map(row => ({ id: row.id, agencyId: row.agencyId, creatorId: row.creatorId, expectedUpdatedAt: row.updatedAt }));
  const locked = manifest.length ? await tx.$queryRawUnsafe(`
    SELECT d.* FROM "AutomationDelivery" d JOIN jsonb_to_recordset($1::jsonb)
      AS m(id text, "agencyId" text, "creatorId" text, "expectedUpdatedAt" timestamp)
      ON d."id"=m.id AND d."agencyId"=m."agencyId" AND d."creatorId"=m."creatorId" AND d."updatedAt"=m."expectedUpdatedAt"
    ORDER BY d."id" FOR UPDATE OF d`, JSON.stringify(manifest)) : [];
  const proofSafe = locked.filter(row => !isSfsFollowProof(row) || knownCandidates.has(sfsCandidateId(row)));
  const partition = await partitionAutomationDeliveryHardDeleteCandidates({ db: tx, rows: proofSafe });
  const ids = partition.deletable.map(row => row.id);
  const deletedRows = ids.length ? await tx.$queryRawUnsafe(`
    DELETE FROM "AutomationDelivery" d WHERE d."id" = ANY($1::text[])
      AND d."originKind" = 'AUTOMATION' AND d."status" IN ('COMPLETED','FAILED','SKIPPED','CANCELED')
      AND d."finishedAt" IS NOT NULL AND d."finishedAt" < $2::timestamp
      AND d."failureCode" IS DISTINCT FROM 'outcome_unresolved_do_not_retry'
      AND (d."remoteLifecycleState" IS NULL OR d."remoteLifecycleState" = 'SETTLED')
      AND (d."actionType" <> 'MASS_QUEUE_CREATE' OR d."intentAcknowledgedAt" IS NOT NULL)
    RETURNING d.*`, ids, new Date(olderThan)) : [];
  if (strict && deletedRows.length !== rows.length) throw adminError("ADMIN_ARCHIVE_SELECTION_CHANGED", "Selection changed, is outside scope, or contains protected/live records; reload before archiving", 409);
  const groups = groupDeliveriesForArchive(deletedRows).sort((a,b) => JSON.stringify([a.creatorId,a.moduleKey,a.actionType,a.periodStart]).localeCompare(JSON.stringify([b.creatorId,b.moduleKey,b.actionType,b.periodStart])));
  if (groups.length) {
    const data = groups.map(group => ({ ...group, id: "ama_" + createHash("sha256").update(JSON.stringify([group.creatorId, group.moduleKey, group.actionType, group.periodStart])).digest("hex") }));
    const counters = Object.keys(counterShape());
    const names = ['id','agencyId','creatorId','moduleKey','actionType','periodStart','firstAt','lastAt',...counters];
    const quoted = names.map(name => '"' + name + '"').join(',');
    const types = names.map(name => '"' + name + '" ' + (counters.includes(name) ? 'integer' : ['periodStart','firstAt','lastAt'].includes(name) ? 'timestamp' : 'text')).join(',');
    const increments = counters.map(name => '"' + name + '" = a."' + name + '" + EXCLUDED."' + name + '"').join(',');
    const written = await tx.$queryRawUnsafe(`
      INSERT INTO "AutomationMonthlyAggregate" AS a (${quoted},"createdAt","updatedAt")
      SELECT ${quoted}, clock_timestamp(), clock_timestamp() FROM jsonb_to_recordset($1::jsonb) AS g(${types})
      ORDER BY "creatorId","moduleKey","actionType","periodStart"
      ON CONFLICT ("creatorId","moduleKey","actionType","periodStart") DO UPDATE SET ${increments},
        "firstAt"=LEAST(a."firstAt",EXCLUDED."firstAt"), "lastAt"=GREATEST(a."lastAt",EXCLUDED."lastAt"), "updatedAt"=clock_timestamp()
      WHERE a."agencyId"=EXCLUDED."agencyId" RETURNING a."id"`, JSON.stringify(data));
    if (written.length !== groups.length) throw adminError("AUTOMATION_ARCHIVE_SCOPE_CONFLICT", "Archive agency differs from its creator; explicit repair is required", 409);
  }
  if (commitGuard) await commitGuard(tx);
  return { archived: deletedRows.length, aggregateUpdates: groups.length, protected: rows.length - deletedRows.length };
}

async function compactAutomationDeliveries({ olderThan, batchSize = 500, db = null, commitGuard = null }) {
  db = db || require("../prisma");
  let archived = 0;
  let aggregateUpdates = 0;
  const take = Math.max(1, Math.min(500, Math.floor(Number(batchSize) || 500)));
  let cursor = null;
  let batches = 0;
  let hasMore = false;
  for (; batches < 4; batches += 1) {
    const lifecycleGuards = [
      { OR: [{ failureCode: null }, { failureCode: { not: "outcome_unresolved_do_not_retry" } }] },
      { OR: [{ remoteLifecycleState: null }, { remoteLifecycleState: "SETTLED" }] },
      { OR: [{ actionType: { not: "MASS_QUEUE_CREATE" } }, { intentAcknowledgedAt: { not: null } }] },
    ];
    if (cursor) lifecycleGuards.push({
      OR: [
        { finishedAt: { gt: cursor.finishedAt, lt: olderThan } },
        { finishedAt: cursor.finishedAt, id: { gt: cursor.id } },
      ],
    });
    const rows = await db.automationDelivery.findMany({
      where: {
        originKind: "AUTOMATION",
        status: { in: TERMINAL_STATUSES },
        AND: lifecycleGuards,
        finishedAt: { not: null, lt: olderThan },
      },
      orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true,
        agencyId: true,
        creatorId: true,
        moduleKey: true,
        actionType: true,
        payload: true,
        generation: true,
        fanId: true,
        targetId: true,
        status: true,
        result: true,
        createdAt: true,
        updatedAt: true,
        finishedAt: true,
      },
    });
    if (!rows.length) { hasMore = false; break; }
    cursor = { finishedAt: rows[rows.length - 1].finishedAt, id: rows[rows.length - 1].id };
    const committed = await runRootCommit(db, ({ tx }) => archiveAutomationDeliveryBatch({ tx, rows, olderThan, commitGuard }), { profile: "RETENTION_MUTATION", authority: { kind: "RETENTION_ARCHIVE" } });
    archived += committed.archived;
    aggregateUpdates += committed.aggregateUpdates;
    hasMore = rows.length >= take;
    if (!hasMore) break;
  }
  return { label: "automationDelivery.compacted", archived, deleted: archived, aggregateUpdates, hasMore };
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
  const [archived, liveRows, failures] = await db.$transaction(tx => Promise.all([
    tx.automationMonthlyAggregate.findMany({
      where: { agencyId, creatorId, periodStart: { gte: monthStart(start), lte: end } },
      orderBy: [{ periodStart: "asc" }, { moduleKey: "asc" }, { actionType: "asc" }],
    }),
    tx.automationDelivery.findMany({
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
    tx.automationDelivery.groupBy({
      by: ["moduleKey", "failureCode"],
      where: { agencyId, creatorId, originKind: "AUTOMATION", status: "FAILED", finishedAt: { gte: start, lte: end } },
      _count: { _all: true },
    }),
  ]), { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 15000 });

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
  archiveAutomationDeliveryBatch,
  compactAutomationDeliveries,
  normalizeRange,
  getAutomationMetrics,
  listAutomationAudit,
};
