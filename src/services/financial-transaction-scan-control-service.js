"use strict";

const crypto = require("node:crypto");
const { activeCollectorJob, pauseCollectorJob } = require("./analytics-scan-job-authority");
const prisma = require("../prisma");
const { scheduleJobNow } = require("./job-scheduler");
const { reschedulePlannedJob } = require("./job-planning-repository");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { capabilityFreshnessWindow } = require("./capability-freshness-authority-service");
const { JOB_KEY, SCHEMA_VERSION, COLLECTOR_VERSION, summarizeStatusGroups } = require("./financial-transactions-service");
const {
  buildCollectionCommand, buildCollectionPlanningDedupeParams, withCollectorStateLock, COLLECTOR_TYPES,
} = require("./analytics-collector-control-service");

const MANUAL_REASON = "manual_creator_analytics_financial_transactions_scan";

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
async function countOnlineBindings(db, creator, now = null) {
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: now || new Date() });
  const freshnessWindow = capabilityFreshnessWindow(authorityNow, 2 * 60 * 1000);
  return db.deviceCreatorBinding.count({
    where: {
      creatorId: creator.id, agencyId: creator.agencyId, status: "ACTIVE", sessionReadReady: true, lastSeenAt: freshnessWindow,
      device: { lastSeenAt: freshnessWindow },
    },
  });
}

async function startManualFinancialTransactionScan({ db = prisma, creator, requestedByUserId = null, now = new Date() }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.FINANCIAL, creatorId: creator.id, work: async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow: now });
    // Manual and automatic starts share one collector planning boundary. The
    // read is repeated under the same advisory lock used by accept/complete, so
    // a cross-replica manual click cannot create a second provider traversal.
    const active = await activeCollectorJob(tx, creator.id, JOB_KEY);
    if (active?.status === "PAUSED") {
      const planned = await reschedulePlannedJob({
        db: tx, job: active, params: active.params || {}, priority: active.priority || 0,
        scheduledAt: authorityNow, nextRunAt: authorityNow, continuation: active.continuation || null, progress: active.progress || null,
        lastProgressAt: active.lastProgressAt || null, startedAt: active.startedAt || null, resetAttempts: false,
        protectedStatuses: [],
      });
      return { job: planned.job, action: "resumed" };
    }
    if (active) return { job: active, action: active.status === "CLAIMED" ? "already_running" : "already_queued" };

    const state = typeof tx.creatorFinancialCollectionState?.findUnique === "function"
      ? await tx.creatorFinancialCollectionState.findUnique({ where: { creatorId: creator.id } })
      : null;
    const manualRunToken = crypto.randomUUID();
    const snapshotMarker = Math.floor(authorityNow.getTime() / 1000);
    const params = {
      manualFinancialTransactionScan: true,
      manualFinancialTransactionScanVersion: 1,
      manualRunToken,
      requestedByUserId: clean(requestedByUserId, 220),
      reason: MANUAL_REASON,
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.FINANCIAL, collectionMode: "full", reason: MANUAL_REASON, now: authorityNow }),
      startDate: "2016-01-01 00:00:00",
      endDate: onlyFansUtcDateTime(new Date(snapshotMarker * 1000)),
      initialMarker: snapshotMarker,
      schemaVersion: SCHEMA_VERSION,
      collectorVersion: COLLECTOR_VERSION,
    };
    const scheduled = await scheduleJobNow({
      db: tx, jobKey: JOB_KEY, creatorId: creator.id, agencyId: creator.agencyId,
      params, priority: 100, now: authorityNow, bucketMs: 1,
      dedupeParams: buildCollectionPlanningDedupeParams({
        collectorType: COLLECTOR_TYPES.FINANCIAL, collectionMode: "full", state, now: authorityNow,
      }),
    });
    return { job: scheduled.job, action: scheduled.reason === "already_claimed" ? "already_running" : "created" };
  }});
}

async function stopManualFinancialTransactionScan({ db = prisma, creatorId, now = new Date() }) {
  return pauseCollectorJob({ db, creatorId, jobKey: JOB_KEY, collectorType: COLLECTOR_TYPES.FINANCIAL, now });
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

async function readManualFinancialTransactionScan({ db = prisma, creator, limit = 100, offset = 0, cursor = null }) {
  const jobs = await recentJobs(db, creator.id, null, 60);
  const job = await activeCollectorJob(db, creator.id, JOB_KEY) || jobs[0] || null;
  const safeLimit = Math.max(1, Math.min(200, integer(limit, 100, 200)));
  if (Number(offset) !== 0) throw Object.assign(new Error("Use the returned Financial page cursor"), { code: "FINANCIAL_CURSOR_REQUIRED", status: 409 });
  const safeOffset = 0;
  const progress = object(job?.progress);
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
  const receipt = await require("./financial-receipt-read-service").read({ db, job, creator, limit: safeLimit, cursor });
  const run = receipt.run, proof = run?.proof.windows[0];
  if (proof) {
    rows = receipt.items.map(transactionForClient); total = proof.count; bounds = receipt.bounds;
    const statusTotals = summarizeStatusGroups(Object.values(proof.statusGroups));
    statusSummary = statusTotals.statusSummary;
    summary = { transactionsCount: total, grossCents: proof.grossCents, netCents: proof.netCents, feeCents: proof.feeCents,
      projected: total - proof.storedOnly, storedOnly: proof.storedOnly,
      earningsTransactionsCount: Math.max(0, total - statusTotals.refundTransactionsCount),
      earningsGrossCents: proof.grossCents - statusTotals.refundGrossCents,
      earningsNetCents: proof.netCents - statusTotals.refundNetCents,
      ...Object.fromEntries(Object.entries(statusTotals).filter(([key]) => key !== "statusSummary")),
    };
    typeSummary = Object.values(proof.typeGroups || {}).sort((a,b) => b.count-a.count || a.transactionType.localeCompare(b.transactionType));
    const categories = { total: "TOTAL", subscribes: "SUBSCRIPTIONS", tips: "TIPS", messages: "MESSAGES", post: "POSTS", stream: "STREAMS" };
    charts = Object.entries(proof.charts).map(([key, value]) => ({ ...value, category: categories[key],
      rangeFrom: run.windows[0].from, rangeTo: run.windows[0].to, collectedAt: null }));
  }
  const onlineWorkers = await countOnlineBindings(db, creator);
  const continuationEnvelope = object(job?.continuation);
  const continuation = run?.cursor || (continuationEnvelope.driverPhase === "execute" ? object(continuationEnvelope.jobContinuation) : continuationEnvelope);
  const totalChart = charts.find((row) => row.category === "TOTAL") || null;
  const sourceBoundaryReached = run?.cursor.phase === "done";
  const scannerRejected = run ? run.proof.windows.reduce((sum, window) => sum + window.rejected, 0) : 0;
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
    const verified = run?.proof.complete === true && sourceBoundaryReached && scannerRejected === 0 && computedReconciliation.chartReady
      && computedReconciliation.countMatched && computedReconciliation.grossMatched && computedReconciliation.netMatched;
    status = verified ? "COMPLETE" : "PARTIAL";
  }
  return {
    ok: true,
    creatorId: creator.id,
    jobId: job?.id || null,
    status,
    manual: isManualJob(job),
    receiptRunId: run?.id || null,
    receiptReady: Boolean(run), detailsExpired: receipt.detailsExpired,
    rangeFrom: run?.windows[0]?.from || null, rangeTo: run?.windows[0]?.to || null,
    phase: clean(continuation.phase, 40) || (status === "COMPLETE" || status === "PARTIAL" ? "complete" : "transactions"),
    pagesScanned: run ? run.proof.windows.reduce((sum, window) => sum + window.pages, 0) : integer(progress.current, 0, 1_000_000),
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
    pagination: { limit: safeLimit, offset: safeOffset, returned: rows.length, total, hasMore: receipt.hasMore, nextCursor: receipt.nextCursor },
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
