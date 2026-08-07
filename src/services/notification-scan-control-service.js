"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { scheduleJobNow } = require("./job-scheduler");
const { buildNotificationScanParams, loadNotificationSyncState } = require("./notification-sync-state-service");

const JOB_KEY = "catchup_notifications_scan";
const MANUAL_REASON = "manual_creator_analytics_notification_scan";
const ACTIVE_STATUSES = new Set(["SCHEDULED", "CLAIMED", "PAUSED"]);
const OUTCOMES = new Set(["ACCEPTED", "REJECTED", "IGNORED"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
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
  return params.manualNotificationScan === true && params.manualNotificationScanVersion === 1;
}
function scanStatus(job, sync) {
  if (!job) return "IDLE";
  if (job.status === "SCHEDULED") return "QUEUED";
  if (job.status === "CLAIMED") return "RUNNING";
  if (job.status === "PAUSED") return "PAUSED";
  if (job.status === "FAILED") return "FAILED";
  if (job.status === "CANCELLED") return "CANCELLED";
  if (job.status === "DONE") {
    if (sync?.sourceJobId === job.id && sync.status === "COMPLETE") return "COMPLETE";
    if (sync?.sourceJobId === job.id && sync.status === "FAILED") return "FAILED";
    return "PARTIAL";
  }
  return String(job.status || "IDLE").toUpperCase();
}
function scanMode(job, sync) {
  const params = object(job?.params);
  if (params.notificationMode === "catchup" || params.notificationMode === "full") return params.notificationMode;
  if (sync?.mode === "catchup" || sync?.mode === "full") return sync.mode;
  return "full";
}
function jobMessage(job) {
  return clean(object(job?.progress).message, 500);
}

async function recentManualJobs(db, creatorId, statuses = null, take = 40) {
  const rows = await db.jobInstance.findMany({
    where: {
      creatorId,
      jobKey: JOB_KEY,
      ...(statuses ? { status: { in: statuses } } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take,
  });
  return rows.filter(isManualJob);
}

async function findActiveManualJob(db, creatorId) {
  const rows = await recentManualJobs(db, creatorId, ["SCHEDULED", "CLAIMED", "PAUSED"], 40);
  return rows.find((row) => ACTIVE_STATUSES.has(row.status)) || null;
}

async function startManualNotificationScan({ db = prisma, creator, requestedByUserId = null, now = new Date() }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  const active = await findActiveManualJob(db, creator.id);
  if (active?.status === "PAUSED") {
    const resumed = await db.jobInstance.update({
      where: { id: active.id },
      data: {
        status: "SCHEDULED",
        nextRunAt: now,
        scheduledAt: now,
        claimedAt: null,
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        workId: null,
        completedAt: null,
        lastError: null,
      },
    });
    return { job: resumed, action: "resumed" };
  }
  if (active) return { job: active, action: active.status === "CLAIMED" ? "already_running" : "already_queued" };

  const state = await loadNotificationSyncState(db, creator.id);
  const manualRunToken = crypto.randomUUID();
  const params = {
    ...buildNotificationScanParams({
      state,
      now,
      reason: MANUAL_REASON,
      analyticsRangeKey: "all",
    }),
    manualNotificationScan: true,
    manualNotificationScanVersion: 1,
    manualRunToken,
    requestedByUserId: clean(requestedByUserId, 220),
  };
  const scheduled = await scheduleJobNow({
    jobKey: JOB_KEY,
    creatorId: creator.id,
    agencyId: creator.agencyId,
    params,
    priority: 100,
    now,
    bucketMs: 1,
  });
  return { job: scheduled.job, action: scheduled.reason === "already_claimed" ? "already_running" : "created" };
}

async function stopManualNotificationScan({ db = prisma, creatorId, now = new Date() }) {
  const active = await findActiveManualJob(db, creatorId);
  if (!active) return { job: null, action: "idle" };
  if (active.status === "PAUSED") return { job: active, action: "already_paused" };

  const result = await db.jobInstance.updateMany({
    where: { id: active.id, status: { in: ["SCHEDULED", "CLAIMED"] } },
    data: {
      status: "PAUSED",
      claimedAt: null,
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      workId: null,
      completedAt: null,
      lastError: null,
      lastProgressAt: active.lastProgressAt || now,
    },
  });
  if (!result.count) {
    const current = await db.jobInstance.findUnique({ where: { id: active.id } });
    return { job: current, action: current?.status === "PAUSED" ? "already_paused" : "changed" };
  }
  const paused = await db.jobInstance.findUnique({ where: { id: active.id } });
  return { job: paused, action: "paused" };
}

function normalizeAuditRow(row, index) {
  const outcome = String(row?.outcome || "").trim().toUpperCase();
  if (!OUTCOMES.has(outcome)) throw new Error(`Notification scan item ${index} has invalid outcome`);
  const factTypeRaw = clean(row?.factType, 40);
  const factType = factTypeRaw ? factTypeRaw.toUpperCase() : null;
  if (factType && !["PURCHASE", "TIP", "SUBSCRIPTION", "LIKE", "COMMENT"].includes(factType)) {
    throw new Error(`Notification scan item ${index} has invalid factType`);
  }
  const page = integer(row?.page, 0, 1_000_000);
  const ordinal = integer(row?.ordinal, -1, 99);
  if (page < 1 || ordinal < 0) throw new Error(`Notification scan item ${index} has invalid page/ordinal`);
  const occurredAt = row?.occurredAt ? new Date(row.occurredAt) : null;
  if (occurredAt && !Number.isFinite(occurredAt.getTime())) throw new Error(`Notification scan item ${index} has invalid occurredAt`);
  const rawAmountCents = row?.amountCents;
  const amountCents = rawAmountCents === null || rawAmountCents === undefined ? null : Number(rawAmountCents);
  if (amountCents !== null && (!Number.isInteger(amountCents) || Math.abs(amountCents) > 2_147_483_647)) {
    throw new Error(`Notification scan item ${index} has invalid amountCents`);
  }
  const rawCurrency = clean(row?.currency, 10);
  const currencyCode = rawCurrency ? rawCurrency.toUpperCase() : null;
  if (currencyCode && !/^[A-Z]{3}$/.test(currencyCode)) throw new Error(`Notification scan item ${index} has invalid currency`);
  return {
    page,
    ordinal,
    notificationId: clean(row?.notificationId, 220),
    sourceType: clean(row?.sourceType, 120),
    sourceSubType: clean(row?.sourceSubType, 160),
    factType,
    occurredAt,
    fanOnlyFansUserId: clean(row?.fanOnlyFansUserId, 180),
    postId: clean(row?.postId, 220),
    commentId: clean(row?.commentId, 220),
    messageId: clean(row?.messageId, 220),
    amountCents,
    currency: currencyCode,
    outcome,
    reasonCode: clean(row?.reasonCode, 160),
  };
}

async function recordNotificationScanItems({ db, job, chunk }) {
  if (!db?.creatorNotificationScanItem?.createMany) return { received: 0, stored: 0 };
  if (!job?.creatorId || !job?.agencyId || !job?.id) throw new Error("Notification scan audit requires creator job scope");
  const scanRunId = clean(chunk?.scanRunId, 80);
  if (!scanRunId || !/^[A-Za-z0-9._-]{8,80}$/.test(scanRunId)) throw new Error("Notification scan audit requires a valid scanRunId");
  const rawItems = Array.isArray(chunk?.auditItems) ? chunk.auditItems : [];
  if (rawItems.length > 10) throw new Error("Notification scan page audit exceeds 10 rows");
  const rows = rawItems.map(normalizeAuditRow);
  if (!rows.length) return { received: 0, stored: 0 };
  const created = await db.creatorNotificationScanItem.createMany({
    data: rows.map((row) => ({
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      sourceJobId: job.id,
      scanRunId,
      ...row,
    })),
    skipDuplicates: true,
  });
  return { received: rows.length, stored: Number(created?.count || 0) };
}

function itemForClient(row) {
  return {
    id: row.id,
    page: row.page,
    ordinal: row.ordinal,
    notificationId: row.notificationId,
    sourceType: row.sourceType,
    sourceSubType: row.sourceSubType,
    factType: row.factType,
    occurredAt: iso(row.occurredAt),
    fanOnlyFansUserId: row.fanOnlyFansUserId,
    postId: row.postId,
    commentId: row.commentId,
    messageId: row.messageId,
    amountCents: row.amountCents,
    currency: row.currency,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
  };
}

async function countOnlineBindings(db, creator) {
  const freshAfter = new Date(Date.now() - 2 * 60 * 1000);
  return db.deviceCreatorBinding.count({
    where: {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      status: "ACTIVE",
      lastSeenAt: { gte: freshAfter },
      device: { lastSeenAt: { gte: freshAfter } },
    },
  });
}

async function readManualNotificationScan({ db = prisma, creator, outcome = "ALL", limit = 100, offset = 0 }) {
  const manualJobs = await recentManualJobs(db, creator.id, null, 60);
  const job = manualJobs[0] || null;
  const sync = await loadNotificationSyncState(db, creator.id);
  const syncBelongsToJob = Boolean(job && sync?.sourceJobId === job.id);
  const linkedSync = syncBelongsToJob ? sync : null;
  const normalizedOutcome = String(outcome || "ALL").trim().toUpperCase();
  if (normalizedOutcome !== "ALL" && !OUTCOMES.has(normalizedOutcome)) throw new Error("Invalid notification scan outcome filter");
  const safeLimit = Math.max(1, Math.min(200, integer(limit, 100, 200)));
  const safeOffset = Math.max(0, Math.min(1_000_000, integer(offset, 0, 1_000_000)));

  let items = [];
  let totalItems = 0;
  let counts = { ACCEPTED: 0, REJECTED: 0, IGNORED: 0 };
  let reasonSummary = [];
  let currentRunOldestOccurredAt = null;
  let currentRunNewestOccurredAt = null;
  if (job && db?.creatorNotificationScanItem) {
    const where = {
      creatorId: creator.id,
      sourceJobId: job.id,
      ...(normalizedOutcome === "ALL" ? {} : { outcome: normalizedOutcome }),
    };
    const [rows, total, outcomeGroups, reasonGroups, bounds] = await Promise.all([
      db.creatorNotificationScanItem.findMany({
        where,
        orderBy: [{ page: "desc" }, { ordinal: "asc" }],
        skip: safeOffset,
        take: safeLimit,
      }),
      db.creatorNotificationScanItem.count({ where }),
      db.creatorNotificationScanItem.groupBy({
        by: ["outcome"],
        where: { creatorId: creator.id, sourceJobId: job.id },
        _count: { _all: true },
      }),
      db.creatorNotificationScanItem.groupBy({
        by: ["outcome", "reasonCode"],
        where: { creatorId: creator.id, sourceJobId: job.id, reasonCode: { not: null } },
        _count: { _all: true },
      }),
      typeof db.creatorNotificationScanItem.aggregate === "function"
        ? db.creatorNotificationScanItem.aggregate({
            where: { creatorId: creator.id, sourceJobId: job.id, occurredAt: { not: null } },
            _min: { occurredAt: true },
            _max: { occurredAt: true },
          })
        : Promise.resolve(null),
    ]);
    items = rows.map(itemForClient);
    totalItems = total;
    for (const group of outcomeGroups) counts[group.outcome] = Number(group._count?._all || 0);
    currentRunOldestOccurredAt = bounds?._min?.occurredAt || null;
    currentRunNewestOccurredAt = bounds?._max?.occurredAt || null;
    reasonSummary = reasonGroups
      .map((group) => ({
        outcome: group.outcome,
        reasonCode: group.reasonCode,
        count: Number(group._count?._all || 0),
      }))
      .sort((left, right) => right.count - left.count || String(left.reasonCode || "").localeCompare(String(right.reasonCode || "")))
      .slice(0, 30);
  }

  const progress = object(job?.progress);
  const pagesScanned = linkedSync ? integer(linkedSync.pagesScanned) : integer(progress.current);
  // Audit rows and the cursor are committed by the same progress transaction.
  // Their relational counts are the truth for this manual run, so an older
  // sync snapshot can never leak counters into the selected job.
  const accepted = job && db?.creatorNotificationScanItem ? counts.ACCEPTED : linkedSync ? integer(linkedSync.eventsAccepted) : 0;
  const rejected = job && db?.creatorNotificationScanItem ? counts.REJECTED : linkedSync ? integer(linkedSync.eventsRejected) : 0;
  const ignored = job && db?.creatorNotificationScanItem ? counts.IGNORED : linkedSync ? integer(linkedSync.ignoredEvents) : 0;
  const onlineWorkers = await countOnlineBindings(db, creator);
  const params = object(job?.params);
  const currentStatus = scanStatus(job, linkedSync);

  const legacySummary = sync && !syncBelongsToJob ? {
    status: sync.status,
    mode: sync.mode,
    pagesScanned: integer(sync.pagesScanned),
    accepted: integer(sync.eventsAccepted),
    rejected: integer(sync.eventsRejected),
    ignored: integer(sync.ignoredEvents),
    sourceJobId: sync.sourceJobId || null,
    lastErrorCode: sync.lastErrorCode || null,
    lastErrorMessage: sync.lastErrorMessage || null,
    updatedAt: iso(sync.updatedAt),
  } : null;

  return {
    ok: true,
    creatorId: creator.id,
    jobId: job?.id || null,
    status: currentStatus,
    mode: scanMode(job, linkedSync),
    manual: Boolean(job),
    pagesScanned,
    processed: accepted + rejected + ignored,
    accepted,
    rejected,
    ignored,
    cursor: linkedSync?.nextCursor || clean(object(job?.continuation).fromId, 220),
    headNotificationId: linkedSync?.headNotificationId || null,
    tailNotificationId: linkedSync?.tailNotificationId || null,
    oldestOccurredAt: iso(currentRunOldestOccurredAt || linkedSync?.oldestOccurredAt),
    newestOccurredAt: iso(currentRunNewestOccurredAt || linkedSync?.newestOccurredAt),
    startedAt: iso(job?.startedAt || job?.scheduledAt),
    completedAt: iso(job?.completedAt),
    lastProgressAt: iso(job?.lastProgressAt || linkedSync?.updatedAt),
    lastErrorCode: currentStatus === "FAILED" ? (linkedSync?.lastErrorCode || "NOTIFICATION_SCAN_FAILED") : linkedSync?.lastErrorCode || null,
    lastErrorMessage: currentStatus === "FAILED" ? (linkedSync?.lastErrorMessage || job?.lastError || null) : linkedSync?.lastErrorMessage || null,
    currentMessage: jobMessage(job),
    sourceBoundaryReached: Boolean(linkedSync && !linkedSync.nextCursor && linkedSync.fullBackfillCompletedAt && params.notificationMode === "full")
      || Boolean(job?.status === "DONE" && linkedSync),
    onlineWorkers,
    legacySummary,
    items,
    reasonSummary,
    pagination: {
      outcome: normalizedOutcome,
      limit: safeLimit,
      offset: safeOffset,
      returned: items.length,
      total: totalItems,
      hasMore: safeOffset + items.length < totalItems,
    },
  };
}

module.exports = {
  JOB_KEY,
  MANUAL_REASON,
  isManualJob,
  startManualNotificationScan,
  stopManualNotificationScan,
  recordNotificationScanItems,
  readManualNotificationScan,
};
