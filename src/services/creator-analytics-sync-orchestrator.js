"use strict";

const prisma = require("../prisma");
const { buildNotificationScanParams, loadNotificationSyncState } = require("./notification-sync-state-service");
const {
  JOB_KEY: FINANCIAL_JOB_KEY,
  SCHEMA_VERSION: FINANCIAL_SCHEMA_VERSION,
  COLLECTOR_VERSION: FINANCIAL_COLLECTOR_VERSION,
} = require("./financial-transactions-service");

const NOTIFICATION_JOB_KEY = "catchup_notifications_scan";
const CAMPAIGN_JOB_KEY = "fetch_campaigns";
const ANALYTICS_SYNC_VERSION = 1;
const NOTIFICATION_KNOWN_ID_LIMIT = 300;
const FINANCIAL_KNOWN_ID_LIMIT = 300;
const CAMPAIGN_FRONTIER_PER_CAMPAIGN = 100;

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}
const NOTIFICATION_CATCHUP_INTERVAL_MS = positiveMs(process.env.CREATOR_ANALYTICS_NOTIFICATION_CATCHUP_MS, 3 * 60 * 60 * 1000);
const FINANCIAL_CATCHUP_INTERVAL_MS = positiveMs(process.env.CREATOR_ANALYTICS_FINANCIAL_CATCHUP_MS, 24 * 60 * 60 * 1000);
const CAMPAIGN_CATCHUP_INTERVAL_MS = positiveMs(process.env.CREATOR_ANALYTICS_CAMPAIGN_CATCHUP_MS, 60 * 60 * 1000);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 220) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
function onlyFansUtcDateTime(date) {
  return new Date(date).toISOString().slice(0, 19).replace("T", " ");
}
function lifecycleParams(params) {
  return object(params).analyticsSyncKind === "initial" && Number(object(params).analyticsSyncVersion || 0) === ANALYTICS_SYNC_VERSION;
}
function catchupParams(params) {
  return object(params).analyticsSyncKind === "catchup" && Number(object(params).analyticsSyncVersion || 0) === ANALYTICS_SYNC_VERSION;
}
async function recentJobs(db, creatorId, jobKey, take = 60) {
  return db.jobInstance.findMany({
    where: { creatorId, jobKey },
    orderBy: [{ createdAt: "desc" }],
    take,
  });
}
async function inFlightJob(db, creatorId, jobKey) {
  return db.jobInstance.findFirst({
    where: { creatorId, jobKey, status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}
async function scheduleNow(input) {
  // Lazy import avoids a module cycle: job-scheduler invokes this orchestrator.
  const { scheduleJobNow } = require("./job-scheduler");
  return scheduleJobNow(input);
}
async function scheduleIfIdle({ db, creatorId, agencyId, jobKey, params, priority, now, bucketMs }) {
  const active = await inFlightJob(db, creatorId, jobKey);
  if (active) return { created: false, reason: "already_in_flight", job: active };
  return scheduleNow({ jobKey, creatorId, agencyId, params, priority, now, bucketMs });
}

function notificationHistoricalBaselineReady(state) {
  return Boolean(state?.fullBackfillVerifiedAt || state?.fullBackfillCompletedAt);
}

async function cancelRedundantInitialNotificationJobs(db, creatorId, now = new Date()) {
  if (!db?.jobInstance?.findMany || !db?.jobInstance?.updateMany) return 0;
  const rows = await db.jobInstance.findMany({
    where: {
      creatorId,
      jobKey: NOTIFICATION_JOB_KEY,
      status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 20,
  });
  let cancelled = 0;
  for (const job of rows) {
    const params = object(job.params);
    // Never cancel a full rebuild the user explicitly started from the debug UI.
    // Old automatic full jobs from pre-orchestrator builds may not have
    // analyticsSyncKind at all, so manualNotificationScan is the reliable fence.
    if (params.manualNotificationScan === true || params.notificationMode !== "full") continue;
    const result = await db.jobInstance.updateMany({
      where: { id: job.id, status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] } },
      data: {
        status: "CANCELLED",
        completedAt: now,
        lastError: "superseded_by_existing_notification_history",
        claimedAt: null,
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
        workId: null,
      },
    });
    cancelled += Number(result?.count || 0);
  }
  return cancelled;
}

async function financialInitialCoverageReady(db, creatorId) {
  if (!db?.creatorEarningsTotal?.findUnique || !db?.jobInstance?.findUnique) return false;
  const total = await db.creatorEarningsTotal.findUnique({
    where: { creatorId_category: { creatorId, category: "TOTAL" } },
    select: { sourceJobId: true, rangeFrom: true, scanRunId: true },
  });
  if (!total?.sourceJobId || !total.scanRunId || !total.rangeFrom) return false;
  if (new Date(total.rangeFrom).getTime() > new Date("2016-01-02T00:00:00.000Z").getTime()) return false;
  const job = await db.jobInstance.findUnique({ where: { id: total.sourceJobId }, select: { status: true, params: true } });
  if (!job || job.status !== "DONE") return false;
  return object(job.params).financialMode !== "catchup";
}

async function campaignInitialCoverageReady(db, creatorId) {
  if (!db?.analyticsCoverage?.findFirst) return false;
  const row = await db.analyticsCoverage.findFirst({
    where: { creatorId, dataType: "CAMPAIGNS", status: "COMPLETE" },
    orderBy: [{ lastVerifiedAt: "desc" }, { updatedAt: "desc" }],
    select: { id: true },
  });
  return Boolean(row);
}

async function ensureInitialCreatorAnalyticsSync({ db = prisma, creatorId, agencyId, now = new Date(), priority = 95 } = {}) {
  if (!creatorId || !agencyId) return { ready: false, stage: "invalid", created: false, reason: "missing_scope" };

  const notificationState = await loadNotificationSyncState(db, creatorId);
  if (notificationHistoricalBaselineReady(notificationState)) {
    // Older builds may already have a complete full-history traversal while a
    // newer bootstrap job was queued under the stricter verification contract.
    // Fence that redundant full walk immediately; future work starts at HEAD.
    await cancelRedundantInitialNotificationJobs(db, creatorId, now);
  } else {
    const params = {
      ...buildNotificationScanParams({ state: notificationState, now, reason: "creator_initial_analytics_sync", analyticsRangeKey: "all" }),
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "notifications",
    };
    const scheduled = await scheduleIfIdle({ db, creatorId, agencyId, jobKey: NOTIFICATION_JOB_KEY, params, priority, now, bucketMs: 60_000 });
    return { ready: false, stage: "notifications", created: scheduled.created === true, reason: scheduled.reason || null, jobId: scheduled.job?.id || scheduled.jobId || null };
  }

  if (!(await financialInitialCoverageReady(db, creatorId))) {
    const snapshotMarker = Math.floor(now.getTime() / 1000);
    const params = {
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "financial",
      financialMode: "full",
      reason: "creator_initial_analytics_sync",
      startDate: "2016-01-01 00:00:00",
      endDate: onlyFansUtcDateTime(new Date(snapshotMarker * 1000)),
      initialMarker: snapshotMarker,
      schemaVersion: FINANCIAL_SCHEMA_VERSION,
      collectorVersion: FINANCIAL_COLLECTOR_VERSION,
    };
    const scheduled = await scheduleIfIdle({ db, creatorId, agencyId, jobKey: FINANCIAL_JOB_KEY, params, priority, now, bucketMs: 60_000 });
    return { ready: false, stage: "financial", created: scheduled.created === true, reason: scheduled.reason || null, jobId: scheduled.job?.id || scheduled.jobId || null };
  }

  if (!(await campaignInitialCoverageReady(db, creatorId))) {
    const params = {
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "campaigns",
      campaignMode: "full",
      reason: "creator_initial_analytics_sync",
      pageSize: 50,
      maxPages: 40,
      claimerPageSize: 50,
      maxClaimerPages: 10_000,
      fanValueBatchSize: 20,
    };
    const scheduled = await scheduleIfIdle({ db, creatorId, agencyId, jobKey: CAMPAIGN_JOB_KEY, params, priority, now, bucketMs: 60_000 });
    return { ready: false, stage: "campaigns", created: scheduled.created === true, reason: scheduled.reason || null, jobId: scheduled.job?.id || scheduled.jobId || null };
  }

  return { ready: true, stage: "ready", created: false, reason: "initial_sync_complete", jobId: null };
}

async function recentKnownNotificationIds(db, creatorId) {
  if (!db?.creatorNotificationScanItem?.findMany) return [];
  const rows = await db.creatorNotificationScanItem.findMany({
    where: { creatorId, notificationId: { not: null } },
    orderBy: [{ createdAt: "desc" }],
    take: 2_000,
    select: { notificationId: true },
  });
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const id = clean(row.notificationId, 220);
    if (!id || seen.has(id)) continue;
    seen.add(id); ids.push(id);
    if (ids.length >= NOTIFICATION_KNOWN_ID_LIMIT) break;
  }
  return ids;
}

async function recentKnownTransactionIds(db, creatorId) {
  if (!db?.creatorFinancialTransaction?.findMany) return [];
  const rows = await db.creatorFinancialTransaction.findMany({
    where: { creatorId },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: FINANCIAL_KNOWN_ID_LIMIT,
    select: { externalTransactionId: true },
  });
  return rows.map((row) => clean(row.externalTransactionId, 220)).filter(Boolean);
}

async function campaignCatchupState(db, creatorId) {
  if (!db?.creatorCampaign?.findMany) return { knownCampaignFanCounts: {}, knownClaimersByCampaign: {} };
  const campaigns = await db.creatorCampaign.findMany({
    where: { creatorId },
    select: { id: true, externalCampaignId: true, _count: { select: { fans: true } } },
  });
  const knownCampaignFanCounts = {};
  const campaignIds = new Map();
  for (const row of campaigns) {
    const externalId = clean(row.externalCampaignId, 220);
    if (!externalId) continue;
    knownCampaignFanCounts[externalId] = Number(row?._count?.fans || 0);
    campaignIds.set(row.id, externalId);
  }

  const knownClaimersByCampaign = {};
  if (campaigns.length && typeof db.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`
      SELECT ranked."externalCampaignId", ranked."onlyFansUserId"
      FROM (
        SELECT c."externalCampaignId", f."onlyFansUserId",
               ROW_NUMBER() OVER (
                 PARTITION BY cf."campaignId"
                 ORDER BY cf."attributedAt" DESC NULLS LAST, cf."createdAt" DESC, cf."id" DESC
               ) AS rn
        FROM "CreatorCampaignFan" cf
        JOIN "CreatorCampaign" c ON c."id" = cf."campaignId" AND c."creatorId" = cf."creatorId"
        JOIN "CreatorFan" f ON f."id" = cf."fanId" AND f."creatorId" = cf."creatorId"
        WHERE cf."creatorId" = $1
      ) ranked
      WHERE ranked.rn <= $2
      ORDER BY ranked."externalCampaignId", ranked.rn
    `, creatorId, CAMPAIGN_FRONTIER_PER_CAMPAIGN);
    for (const row of rows || []) {
      const campaignId = clean(row.externalCampaignId, 220);
      const fanId = clean(row.onlyFansUserId, 180);
      if (!campaignId || !fanId) continue;
      if (!knownClaimersByCampaign[campaignId]) knownClaimersByCampaign[campaignId] = [];
      knownClaimersByCampaign[campaignId].push(fanId);
    }
  } else if (db?.creatorCampaignFan?.findMany) {
    const rows = await db.creatorCampaignFan.findMany({
      where: { creatorId },
      orderBy: [{ attributedAt: "desc" }, { createdAt: "desc" }],
      take: Math.min(20_000, Math.max(2_000, campaigns.length * CAMPAIGN_FRONTIER_PER_CAMPAIGN)),
      select: { campaignId: true, fan: { select: { onlyFansUserId: true } } },
    });
    for (const row of rows) {
      const campaignId = campaignIds.get(row.campaignId);
      const fanId = clean(row?.fan?.onlyFansUserId, 180);
      if (!campaignId || !fanId) continue;
      if (!knownClaimersByCampaign[campaignId]) knownClaimersByCampaign[campaignId] = [];
      if (knownClaimersByCampaign[campaignId].length < CAMPAIGN_FRONTIER_PER_CAMPAIGN) knownClaimersByCampaign[campaignId].push(fanId);
    }
  }

  return { knownCampaignFanCounts, knownClaimersByCampaign };
}

function latestCompletedCatchup(jobs, modeKey, modeValue) {
  return jobs.find((job) => job.status === "DONE" && catchupParams(job.params) && object(job.params)[modeKey] === modeValue && job.completedAt) || null;
}
function due(lastCompletedAt, intervalMs, now) {
  if (!lastCompletedAt) return true;
  return new Date(lastCompletedAt).getTime() <= now.getTime() - intervalMs;
}

async function ensureRecurringCreatorAnalyticsCatchups({ db = prisma, creatorId, agencyId, now = new Date(), priority = 20 } = {}) {
  const initial = await ensureInitialCreatorAnalyticsSync({ db, creatorId, agencyId, now, priority: Math.max(priority, 80) });
  if (!initial.ready) return { ready: false, initial, created: [], skipped: [] };
  const created = [];
  const skipped = [];

  const [notificationState, notificationJobs, financialJobs, campaignJobs] = await Promise.all([
    loadNotificationSyncState(db, creatorId),
    recentJobs(db, creatorId, NOTIFICATION_JOB_KEY),
    recentJobs(db, creatorId, FINANCIAL_JOB_KEY),
    recentJobs(db, creatorId, CAMPAIGN_JOB_KEY),
  ]);

  const lastNotificationCatchup = notificationJobs.find((job) => job.status === "DONE" && catchupParams(job.params) && object(job.params).notificationMode === "catchup" && job.completedAt);
  if (notificationHistoricalBaselineReady(notificationState) && due(notificationState.lastCatchupCompletedAt || lastNotificationCatchup?.completedAt, NOTIFICATION_CATCHUP_INTERVAL_MS, now)) {
    const knownNotificationIds = await recentKnownNotificationIds(db, creatorId);
    const params = {
      ...buildNotificationScanParams({ state: notificationState, now, reason: "creator_analytics_catchup", analyticsRangeKey: "all" }),
      analyticsSyncKind: "catchup",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "notifications",
      knownNotificationIds,
    };
    const scheduled = await scheduleIfIdle({ db, creatorId, agencyId, jobKey: NOTIFICATION_JOB_KEY, params, priority, now, bucketMs: NOTIFICATION_CATCHUP_INTERVAL_MS });
    if (scheduled.created) created.push("notifications_catchup"); else skipped.push(`notifications_catchup:${scheduled.reason || "skipped"}`);
  } else skipped.push("notifications_catchup:fresh");

  const lastFinancialCatchup = latestCompletedCatchup(financialJobs, "financialMode", "catchup");
  if (due(lastFinancialCatchup?.completedAt, FINANCIAL_CATCHUP_INTERVAL_MS, now)) {
    const knownTransactionIds = await recentKnownTransactionIds(db, creatorId);
    const snapshotMarker = Math.floor(now.getTime() / 1000);
    const params = {
      analyticsSyncKind: "catchup",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "financial",
      financialMode: "catchup",
      reason: "creator_analytics_catchup",
      startDate: "2016-01-01 00:00:00",
      endDate: onlyFansUtcDateTime(new Date(snapshotMarker * 1000)),
      initialMarker: snapshotMarker,
      knownTransactionIds,
      catchupMaxPages: 100,
      schemaVersion: FINANCIAL_SCHEMA_VERSION,
      collectorVersion: FINANCIAL_COLLECTOR_VERSION,
    };
    const scheduled = await scheduleIfIdle({ db, creatorId, agencyId, jobKey: FINANCIAL_JOB_KEY, params, priority, now, bucketMs: FINANCIAL_CATCHUP_INTERVAL_MS });
    if (scheduled.created) created.push("financial_catchup"); else skipped.push(`financial_catchup:${scheduled.reason || "skipped"}`);
  } else skipped.push("financial_catchup:fresh");

  const lastCampaignCatchup = latestCompletedCatchup(campaignJobs, "campaignMode", "catchup");
  if (due(lastCampaignCatchup?.completedAt, CAMPAIGN_CATCHUP_INTERVAL_MS, now)) {
    const catchup = await campaignCatchupState(db, creatorId);
    const params = {
      analyticsSyncKind: "catchup",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "campaigns",
      campaignMode: "catchup",
      reason: "creator_analytics_catchup",
      pageSize: 50,
      maxPages: 40,
      claimerPageSize: 50,
      maxClaimerPages: 10_000,
      fanValueBatchSize: 20,
      knownCampaignFanCounts: catchup.knownCampaignFanCounts,
      knownClaimersByCampaign: catchup.knownClaimersByCampaign,
    };
    const scheduled = await scheduleIfIdle({ db, creatorId, agencyId, jobKey: CAMPAIGN_JOB_KEY, params, priority, now, bucketMs: CAMPAIGN_CATCHUP_INTERVAL_MS });
    if (scheduled.created) created.push("campaigns_catchup"); else skipped.push(`campaigns_catchup:${scheduled.reason || "skipped"}`);
  } else skipped.push("campaigns_catchup:fresh");

  return { ready: true, initial, created, skipped };
}

async function advanceCreatorAnalyticsInitialSyncAfterCompletion({ db = prisma, job, sideEffect = null, now = new Date() } = {}) {
  if (!job?.creatorId || !job?.agencyId || !lifecycleParams(job.params)) return { advanced: false, reason: "not_initial_analytics_job" };
  if (job.jobKey === NOTIFICATION_JOB_KEY && sideEffect?.verified !== true) return { advanced: false, reason: "notifications_not_verified" };
  if (job.jobKey === FINANCIAL_JOB_KEY && sideEffect?.complete !== true) return { advanced: false, reason: "financial_not_verified" };
  if (job.jobKey === CAMPAIGN_JOB_KEY && sideEffect?.ok !== true) return { advanced: false, reason: "campaigns_not_verified" };
  const next = await ensureInitialCreatorAnalyticsSync({ db, creatorId: job.creatorId, agencyId: job.agencyId, now, priority: 95 });
  return { advanced: true, next };
}

module.exports = {
  ANALYTICS_SYNC_VERSION,
  NOTIFICATION_CATCHUP_INTERVAL_MS,
  FINANCIAL_CATCHUP_INTERVAL_MS,
  CAMPAIGN_CATCHUP_INTERVAL_MS,
  ensureInitialCreatorAnalyticsSync,
  ensureRecurringCreatorAnalyticsCatchups,
  advanceCreatorAnalyticsInitialSyncAfterCompletion,
  recentKnownNotificationIds,
  recentKnownTransactionIds,
  campaignCatchupState,
  financialInitialCoverageReady,
  campaignInitialCoverageReady,
};
