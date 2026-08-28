"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { scheduleJobNow } = require("./job-scheduler");
const { JOB_KEY, SCHEMA_VERSION, COLLECTOR_VERSION, summarizeStatusGroups } = require("./financial-transactions-service");

const MANUAL_REASON = "manual_creator_analytics_financial_transactions_scan";
const ACTIVE_STATUSES = new Set(["SCHEDULED", "CLAIMED", "PAUSED"]);

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, max = 100_000_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(max, parsed);
}
function signedInteger(value, fallback = 0, max = 2_147_483_647) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > max) return fallback;
  return parsed;
}
function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function isManualJob(job) {
  const params = object(job?.params);
  return params.manualFinancialTransactionScan === true && params.manualFinancialTransactionScanVersion === 1;
}
function onlyFansUtcDateTime(date) {
  return new Date(date).toISOString().slice(0, 19).replace("T", " ");
}
function jobStatus(job) {
  if (!job) return "IDLE";
  if (job.status === "SCHEDULED") return "QUEUED";
  if (job.status === "CLAIMED") return "RUNNING";
  if (job.status === "PAUSED") return "PAUSED";
  if (job.status === "FAILED") return "FAILED";
  if (job.status === "CANCELLED") return "CANCELLED";
  if (job.status === "DONE") return object(job.result).complete === true ? "COMPLETE" : "PARTIAL";
  return String(job.status || "IDLE").toUpperCase();
}
async function recentJobs(db, creatorId, statuses = null, take = 40) {
  const rows = await db.jobInstance.findMany({
    where: { creatorId, jobKey: JOB_KEY, ...(statuses ? { status: { in: statuses } } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take,
  });
  return rows.filter(isManualJob);
}
async function activeJob(db, creatorId) {
  const rows = await recentJobs(db, creatorId, ["SCHEDULED", "CLAIMED", "PAUSED"], 40);
  return rows.find((row) => ACTIVE_STATUSES.has(row.status)) || null;
}
async function countOnlineBindings(db, creator) {
  const freshAfter = new Date(Date.now() - 2 * 60 * 1000);
  return db.deviceCreatorBinding.count({
    where: {
      creatorId: creator.id, agencyId: creator.agencyId, status: "ACTIVE", sessionReadReady: true, lastSeenAt: { gte: freshAfter },
      device: { lastSeenAt: { gte: freshAfter } },
    },
  });
}

async function startManualFinancialTransactionScan({ db = prisma, creator, requestedByUserId = null, now = new Date() }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  const active = await activeJob(db, creator.id);
  if (active?.status === "PAUSED") {
    const resumed = await db.jobInstance.update({
      where: { id: active.id },
      data: {
        status: "SCHEDULED", nextRunAt: now, scheduledAt: now,
        claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null,
        leaseRevision: { increment: 1 }, workId: null, completedAt: null, lastError: null,
      },
    });
    return { job: resumed, action: "resumed" };
  }
  if (active) return { job: active, action: active.status === "CLAIMED" ? "already_running" : "already_queued" };
  const manualRunToken = crypto.randomUUID();
  const snapshotMarker = Math.floor(now.getTime() / 1000);
  const params = {
    manualFinancialTransactionScan: true,
    manualFinancialTransactionScanVersion: 1,
    manualRunToken,
    requestedByUserId: clean(requestedByUserId, 220),
    reason: MANUAL_REASON,
    startDate: "2016-01-01 00:00:00",
    endDate: onlyFansUtcDateTime(new Date(snapshotMarker * 1000)),
    initialMarker: snapshotMarker,
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
  };
  const scheduled = await scheduleJobNow({
    jobKey: JOB_KEY, creatorId: creator.id, agencyId: creator.agencyId,
    params, priority: 100, now, bucketMs: 1,
  });
  return { job: scheduled.job, action: scheduled.reason === "already_claimed" ? "already_running" : "created" };
}

async function stopManualFinancialTransactionScan({ db = prisma, creatorId, now = new Date() }) {
  const active = await activeJob(db, creatorId);
  if (!active) return { job: null, action: "idle" };
  if (active.status === "PAUSED") return { job: active, action: "already_paused" };
  const result = await db.jobInstance.updateMany({
    where: { id: active.id, status: { in: ["SCHEDULED", "CLAIMED"] } },
    data: {
      status: "PAUSED", claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null,
      leaseRevision: { increment: 1 }, workId: null, completedAt: null, lastError: null,
      lastProgressAt: active.lastProgressAt || now,
    },
  });
  if (!result.count) {
    const current = await db.jobInstance.findUnique({ where: { id: active.id } });
    return { job: current, action: current?.status === "PAUSED" ? "already_paused" : "changed" };
  }
  return { job: await db.jobInstance.findUnique({ where: { id: active.id } }), action: "paused" };
}

function transactionForClient(row) {
  return {
    id: row.id,
    externalTransactionId: row.externalTransactionId,
    transactionType: row.transactionType,
    factType: row.factType,
    projectionStatus: row.projectionStatus,
    occurredAt: iso(row.occurredAt),
    fanOnlyFansUserId: row.fanOnlyFansUserId,
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    netCents: row.netCents,
    currency: row.currency,
    transactionStatus: row.transactionStatus,
    page: row.page,
    ordinal: row.ordinal,
    reasonCode: row.reasonCode,
  };
}

async function readManualFinancialTransactionScan({ db = prisma, creator, limit = 100, offset = 0 }) {
  const jobs = await recentJobs(db, creator.id, null, 60);
  const job = jobs[0] || null;
  const safeLimit = Math.max(1, Math.min(200, integer(limit, 100, 200)));
  const safeOffset = Math.max(0, Math.min(1_000_000, integer(offset, 0, 1_000_000)));
  const progress = object(job?.progress);
  const result = object(job?.result);
  let rows = [];
  let total = 0;
  let summary = {
    transactionsCount: 0, grossCents: 0, netCents: 0, feeCents: 0, projected: 0, storedOnly: 0,
    earningsTransactionsCount: 0, earningsGrossCents: 0, earningsNetCents: 0,
    settledTransactionsCount: 0, settledGrossCents: 0, settledNetCents: 0,
    pendingTransactionsCount: 0, pendingGrossCents: 0, pendingNetCents: 0,
    refundTransactionsCount: 0, refundGrossCents: 0, refundNetCents: 0,
  };
  let statusSummary = [];
  let typeSummary = [];
  let charts = [];
  let bounds = null;
  if (job) {
    const where = { creatorId: creator.id, sourceJobId: job.id, ...(clean(result.scanRunId, 120) ? { scanRunId: clean(result.scanRunId, 120) } : {}) };
    const [items, count, aggregate, statusGroups, projectionGroups, typeGroups, chartRows, minMax] = await Promise.all([
      db.creatorFinancialTransaction.findMany({ where, orderBy: [{ page: "desc" }, { ordinal: "asc" }, { occurredAt: "desc" }], skip: safeOffset, take: safeLimit }),
      db.creatorFinancialTransaction.count({ where }),
      db.creatorFinancialTransaction.aggregate({ where, _sum: { amountCents: true, netCents: true, feeCents: true } }),
      db.creatorFinancialTransaction.groupBy({ by: ["transactionStatus"], where, _count: { _all: true }, _sum: { amountCents: true, netCents: true, feeCents: true } }),
      db.creatorFinancialTransaction.groupBy({ by: ["projectionStatus"], where, _count: { _all: true } }),
      db.creatorFinancialTransaction.groupBy({ by: ["transactionType", "factType", "projectionStatus", "reasonCode"], where, _count: { _all: true }, _sum: { amountCents: true, netCents: true } }),
      db.creatorEarningsTotal.findMany({ where: { creatorId: creator.id, sourceJobId: job.id }, orderBy: { category: "asc" } }),
      db.creatorFinancialTransaction.aggregate({ where, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    ]);
    rows = items.map(transactionForClient);
    total = count;
    const grossCents = Number(aggregate?._sum?.amountCents || 0);
    const netCents = Number(aggregate?._sum?.netCents || 0);
    const feeCents = Number(aggregate?._sum?.feeCents || 0);
    const statusTotals = summarizeStatusGroups(statusGroups);
    statusSummary = statusTotals.statusSummary;
    summary = {
      transactionsCount: count,
      grossCents,
      netCents,
      feeCents,
      projected: Number(projectionGroups.find((group) => group.projectionStatus === "PROJECTED")?._count?._all || 0),
      storedOnly: Number(projectionGroups.find((group) => group.projectionStatus === "STORED_ONLY")?._count?._all || 0),
      earningsTransactionsCount: Math.max(0, count - statusTotals.refundTransactionsCount),
      earningsGrossCents: grossCents - statusTotals.refundGrossCents,
      earningsNetCents: netCents - statusTotals.refundNetCents,
      settledTransactionsCount: statusTotals.settledTransactionsCount,
      settledGrossCents: statusTotals.settledGrossCents,
      settledNetCents: statusTotals.settledNetCents,
      pendingTransactionsCount: statusTotals.pendingTransactionsCount,
      pendingGrossCents: statusTotals.pendingGrossCents,
      pendingNetCents: statusTotals.pendingNetCents,
      refundTransactionsCount: statusTotals.refundTransactionsCount,
      refundGrossCents: statusTotals.refundGrossCents,
      refundNetCents: statusTotals.refundNetCents,
    };
    typeSummary = typeGroups.map((group) => ({
      transactionType: group.transactionType,
      factType: group.factType,
      projectionStatus: group.projectionStatus,
      reasonCode: group.reasonCode,
      count: Number(group._count?._all || 0),
      grossCents: Number(group._sum?.amountCents || 0),
      netCents: Number(group._sum?.netCents || 0),
    })).sort((a, b) => b.count - a.count || a.transactionType.localeCompare(b.transactionType));
    charts = chartRows.map((row) => ({
      category: row.category, grossCents: row.grossCents, netCents: row.netCents,
      transactionsCount: row.transactionsCount, rangeFrom: iso(row.rangeFrom), rangeTo: iso(row.rangeTo), collectedAt: iso(row.collectedAt),
    }));
    bounds = minMax;
  }
  const onlineWorkers = await countOnlineBindings(db, creator);
  const continuationEnvelope = object(job?.continuation);
  const continuation = continuationEnvelope.driverPhase === "execute" ? object(continuationEnvelope.jobContinuation) : continuationEnvelope;
  const totalChart = charts.find((row) => row.category === "TOTAL") || null;
  const sourceBoundaryReached = result.sourceBoundaryReached === true;
  const scannerRejected = integer(result.scannerRejected ?? continuation.scannerRejected, 0, 100_000_000);
  const computedReconciliation = {
    chartReady: Boolean(totalChart),
    countMatched: Boolean(totalChart) && summary.earningsTransactionsCount === Number(totalChart.transactionsCount || 0),
    grossMatched: Boolean(totalChart) && summary.earningsGrossCents === Number(totalChart.grossCents || 0),
    netMatched: Boolean(totalChart) && summary.earningsNetCents === Number(totalChart.netCents || 0),
    chartCount: totalChart ? Number(totalChart.transactionsCount || 0) : null,
    chartGrossCents: totalChart ? Number(totalChart.grossCents || 0) : null,
    chartNetCents: totalChart ? Number(totalChart.netCents || 0) : null,
  };
  let status = jobStatus(job);
  if (job?.status === "DONE") {
    const verified = sourceBoundaryReached && scannerRejected === 0 && computedReconciliation.chartReady
      && computedReconciliation.countMatched && computedReconciliation.grossMatched && computedReconciliation.netMatched;
    status = verified ? "COMPLETE" : "PARTIAL";
  }
  return {
    ok: true,
    creatorId: creator.id,
    jobId: job?.id || null,
    status,
    manual: Boolean(job),
    phase: clean(continuation.phase, 40) || (status === "COMPLETE" || status === "PARTIAL" ? "complete" : "transactions"),
    pagesScanned: integer(continuation.page ?? progress.current, 0, 1_000_000),
    marker: clean(continuation.marker, 220),
    sourceBoundaryReached,
    scannerRejected,
    oldestOccurredAt: iso(bounds?._min?.occurredAt),
    newestOccurredAt: iso(bounds?._max?.occurredAt),
    startedAt: iso(job?.startedAt || job?.scheduledAt),
    completedAt: iso(job?.completedAt),
    lastProgressAt: iso(job?.lastProgressAt),
    lastErrorCode: status === "FAILED" ? "FINANCIAL_TRANSACTION_SCAN_FAILED" : null,
    lastErrorMessage: status === "FAILED" ? clean(job?.lastError, 1000) : null,
    currentMessage: clean(progress.message, 500),
    onlineWorkers,
    summary,
    statusSummary,
    typeSummary,
    charts,
    reconciliation: computedReconciliation,
    items: rows,
    pagination: { limit: safeLimit, offset: safeOffset, returned: rows.length, total, hasMore: safeOffset + rows.length < total },
  };
}

module.exports = {
  JOB_KEY,
  MANUAL_REASON,
  isManualJob,
  startManualFinancialTransactionScan,
  stopManualFinancialTransactionScan,
  readManualFinancialTransactionScan,
};
