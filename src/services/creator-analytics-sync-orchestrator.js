"use strict";

const prisma = require("../prisma");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { buildNotificationScanParams, loadNotificationSyncState } = require("./notification-sync-state-service");
const {
  buildCollectionCommand,
  buildCollectionPlanningDedupeParams,
  withCollectorStateLock,
  COLLECTOR_TYPES,
} = require("./analytics-collector-control-service");
const {
  NOTIFICATION_COLLECTION_FRESHNESS_MS,
  FINANCIAL_COLLECTION_FRESHNESS_MS,
  CAMPAIGN_COLLECTION_FRESHNESS_MS,
  CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS,
  trustedCollectionTimestamp,
} = require("./analytics-freshness-policy");
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
async function loadCollectorPlanningState(db, collectorType, creatorId, fallbackState = null) {
  const delegate = collectorType === COLLECTOR_TYPES.NOTIFICATIONS
    ? db?.creatorNotificationSyncState
    : collectorType === COLLECTOR_TYPES.FINANCIAL
      ? db?.creatorFinancialCollectionState
      : collectorType === COLLECTOR_TYPES.CAMPAIGNS
        ? db?.creatorCampaignCollectionState
        : null;
  if (typeof delegate?.findUnique === "function") {
    return delegate.findUnique({ where: { creatorId } });
  }
  // Tiny unit-test doubles may omit unrelated delegates. Production Prisma has
  // every current collector-state model, so only tests use the supplied state.
  return fallbackState || null;
}
async function scheduleIfIdle({ db, creatorId, agencyId, jobKey, params, priority, now, bucketMs, collectorType, collectorState, reserveDirectory = null }) {
  return withCollectorStateLock({ db, type: collectorType, creatorId, work: async (tx) => {
    const active = await inFlightJob(tx, creatorId, jobKey);
    if (active) return { created: false, reason: "already_in_flight", job: active };
    // The state used for planning identity/order must be read *after* acquiring
    // the same collector lock used by accept/complete. A pre-lock snapshot can
    // race a completion on another replica and issue work for an obsolete epoch.
    const currentCollectorState = await loadCollectorPlanningState(tx, collectorType, creatorId, collectorState);
    if (reserveDirectory && !await reserveDirectory(currentCollectorState)) return { created: false, reason: "directory_capacity_deferred" };
    return scheduleNow({
      db: tx,
      jobKey,
      creatorId,
      agencyId,
      params,
      priority,
      now,
      bucketMs,
      // Trigger provenance and the random server command UUID are excluded.
      // The shared collector lock prevents a manual/automatic cross-mode race;
      // stable dedupe closes same-mode replica races even after the lock releases.
      dedupeParams: buildCollectionPlanningDedupeParams({
        collectorType, collectionMode: params?.collectionMode, state: currentCollectorState,
      }),
    });
  }});
}

function verifiedProofTimestampReady(value, now = new Date()) {
  return Boolean(trustedCollectionTimestamp(value, now));
}

function notificationHistoricalBaselineReady(state, now = new Date()) {
  return verifiedProofTimestampReady(state?.fullBackfillVerifiedAt, now);
}
function notificationJobMode(params) {
  // Desktop has always treated anything except an explicit catch-up marker as
  // FULL. Mirror that fail-closed legacy contract on the backend so old queued
  // rows with no notificationMode can never bypass the redundant-FULL fence.
  return object(params).notificationMode === "catchup" ? "catchup" : "full";
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
    // Once historical coverage exists, any ordinary FULL is redundant even if
    // it came from the old manual scanner. Only a new, explicit force-full
    // request is allowed to cross this fence.
    if (params.forceNotificationFullRebuild === true || notificationJobMode(params) !== "full") continue;
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

async function financialInitialCoverageReady(db, creatorId, now = new Date()) {
  if (!db?.creatorFinancialCollectionState?.findUnique) return false;
  const state = await db.creatorFinancialCollectionState.findUnique({
    where: { creatorId },
    select: { status: true, baselineVerifiedAt: true, baselineGeneration: true },
  });
  return Boolean(state?.baselineGeneration && verifiedProofTimestampReady(state?.baselineVerifiedAt, now));
}

async function campaignInitialCoverageReady(db, creatorId, now = new Date()) {
  if (!db?.creatorCampaignCollectionState?.findUnique) return false;
  const state = await db.creatorCampaignCollectionState.findUnique({
    where: { creatorId },
    select: { status: true, baselineVerifiedAt: true, baselineGeneration: true },
  });
  return Boolean(state?.baselineGeneration && verifiedProofTimestampReady(state?.baselineVerifiedAt, now));
}

function campaignDelegatedRefreshPending(state) {
  const activeGeneration = String(state?.activeGeneration || "").trim();
  const coverageRunId = String(state?.fanValueCoverageScanRunId || "").trim();
  const expected = Math.max(0, Number(state?.fanValueExpected || 0));
  const freshness = String(state?.fanValueFreshnessStatus || "MISSING").toUpperCase();
  // FanData coverage is a generation-bound post-traversal authority. Do not
  // launch another Campaign provider generation while the current generation's
  // delegated refresh is QUEUED/PARTIAL, even when frontier budgeting leaves
  // membershipCoverageStatus PARTIAL. Otherwise a later frontier tranche can
  // reset the run ledger and hide older outstanding/failed freshness work.
  return Boolean(activeGeneration && coverageRunId === activeGeneration && expected > 0 && freshness !== "COMPLETE");
}

function campaignDirectoryDiscoveryPending(state) {
  const requested = Math.max(0, Number(state?.campaignDirectoryDiscoveryRequestedRevision || 0));
  const completed = Math.max(0, Number(state?.campaignDirectoryDiscoveryCompletedRevision || 0));
  return requested > completed;
}

function campaignDirectoryDiscoveryDue(state, now = new Date()) {
  if (!state) return true;
  if (campaignDirectoryDiscoveryPending(state)) return true;
  const explicitDueAt = state?.campaignDirectoryDiscoveryDueAt ? new Date(state.campaignDirectoryDiscoveryDueAt) : null;
  if (explicitDueAt && Number.isFinite(explicitDueAt.getTime())) return explicitDueAt.getTime() <= now.getTime();
  const verifiedAt = trustedCollectionTimestamp(state?.campaignDirectoryVerifiedAt, now);
  if (!verifiedAt) return true;
  return verifiedAt.getTime() <= now.getTime() - CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS;
}

function campaignFrontierWorkDue(state, now = new Date()) {
  if (String(state?.campaignFrontierFreshnessStatus || "MISSING").toUpperCase() !== "COMPLETE") return true;
  const nextDueAt = state?.campaignFrontierNextDueAt ? new Date(state.campaignFrontierNextDueAt) : null;
  return Boolean(nextDueAt && Number.isFinite(nextDueAt.getTime()) && nextDueAt.getTime() <= now.getTime());
}

function campaignDirectoryReuseBinding(state, now = new Date()) {
  if (campaignDirectoryDiscoveryDue(state, now)) return null;
  const generation = clean(state?.campaignDirectoryGeneration, 120);
  const requestedAt = state?.campaignDirectoryRequestedAt ? new Date(state.campaignDirectoryRequestedAt) : null;
  const verifiedAt = state?.campaignDirectoryVerifiedAt ? new Date(state.campaignDirectoryVerifiedAt) : null;
  const revision = Number(state?.campaignDirectoryRevision || 0);
  const campaignCount = Number(state?.campaignDirectoryCampaignCount || 0);
  if (!generation || !requestedAt || !Number.isFinite(requestedAt.getTime()) || !verifiedProofTimestampReady(verifiedAt, now)) return null;
  if (!Number.isInteger(revision) || revision < 1 || !Number.isInteger(campaignCount) || campaignCount < 0) return null;
  return {
    campaignDirectoryReuseGeneration: generation,
    campaignDirectoryReuseRequestedAt: requestedAt.toISOString(),
    campaignDirectoryReuseRevision: revision,
    campaignDirectoryReuseCampaignCount: campaignCount,
  };
}

async function creatorAnalyticsInitialSyncReady({ db = prisma, creatorId, now = new Date() } = {}) {
  now = await dbAuthorityNow({ db, fallbackNow: now });
  if (!creatorId) return false;
  const notificationState = await loadNotificationSyncState(db, creatorId);
  if (!notificationHistoricalBaselineReady(notificationState, now)) return false;
  if (!(await financialInitialCoverageReady(db, creatorId, now))) return false;
  if (!(await campaignInitialCoverageReady(db, creatorId, now))) return false;
  return true;
}

async function ensureInitialCreatorAnalyticsSync({ db = prisma, creatorId, agencyId, now = new Date(), priority = 95 } = {}) {
  now = await dbAuthorityNow({ db, fallbackNow: now });
  if (!creatorId || !agencyId) return { ready: false, stage: "invalid", created: false, reason: "missing_scope" };

  const notificationState = await loadNotificationSyncState(db, creatorId);
  if (notificationHistoricalBaselineReady(notificationState, now)) {
    // Only a durably verified historical baseline makes an ordinary FULL
    // redundant. A completed-but-unverified traversal remains repair work and
    // must not advance the staged initial-sync authority.
    await cancelRedundantInitialNotificationJobs(db, creatorId, now);
  } else {
    const notificationRetry = retryDisposition(notificationState, now);
    if (notificationRetry.deferred) return { ready: false, stage: "notifications", created: false, reason: "deferred", retryAfterAt: notificationRetry.retryAfterAt, jobId: null };
    if (notificationRetry.terminal) return { ready: false, stage: "notifications", created: false, reason: "failed_terminal", retryAfterAt: null, jobId: null };
    const params = {
      ...buildNotificationScanParams({ state: notificationState, now, reason: "creator_initial_analytics_sync", analyticsRangeKey: "all" }),
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.NOTIFICATIONS, collectionMode: "full", reason: "creator_initial_analytics_sync", now }),
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "notifications",
    };
    const scheduled = await scheduleIfIdle({
      db, creatorId, agencyId, jobKey: NOTIFICATION_JOB_KEY, params, priority, now, bucketMs: 60_000,
      collectorType: COLLECTOR_TYPES.NOTIFICATIONS, collectorState: notificationState,
    });
    return { ready: false, stage: "notifications", created: scheduled.created === true, reason: scheduled.reason || null, jobId: scheduled.job?.id || scheduled.jobId || null };
  }

  if (!(await financialInitialCoverageReady(db, creatorId, now))) {
    const financialState = await db.creatorFinancialCollectionState.findUnique({ where: { creatorId } });
    const retry = retryDisposition(financialState, now);
    if (retry.deferred) return { ready: false, stage: "financial", created: false, reason: "deferred", retryAfterAt: retry.retryAfterAt, jobId: null };
    if (retry.terminal) return { ready: false, stage: "financial", created: false, reason: "failed_terminal", retryAfterAt: null, jobId: null };
    const snapshotMarker = Math.floor(now.getTime() / 1000);
    const params = {
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "financial",
      financialMode: "full",
      reason: "creator_initial_analytics_sync",
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.FINANCIAL, collectionMode: "full", reason: "creator_initial_analytics_sync", now }),
      startDate: "2016-01-01 00:00:00",
      endDate: onlyFansUtcDateTime(new Date(snapshotMarker * 1000)),
      initialMarker: snapshotMarker,
      schemaVersion: FINANCIAL_SCHEMA_VERSION,
      collectorVersion: FINANCIAL_COLLECTOR_VERSION,
    };
    const scheduled = await scheduleIfIdle({
      db, creatorId, agencyId, jobKey: FINANCIAL_JOB_KEY, params, priority, now, bucketMs: 60_000,
      collectorType: COLLECTOR_TYPES.FINANCIAL, collectorState: financialState,
    });
    return { ready: false, stage: "financial", created: scheduled.created === true, reason: scheduled.reason || null, jobId: scheduled.job?.id || scheduled.jobId || null };
  }

  if (!(await campaignInitialCoverageReady(db, creatorId, now))) {
    const campaignState = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId } });
    if (campaignDelegatedRefreshPending(campaignState)) {
      return { ready: false, stage: "campaigns", created: false, reason: "fan_refresh_pending", retryAfterAt: null, jobId: campaignState?.sourceJobId || null };
    }
    const retry = retryDisposition(campaignState, now);
    if (retry.deferred) return { ready: false, stage: "campaigns", created: false, reason: "deferred", retryAfterAt: retry.retryAfterAt, jobId: null };
    if (retry.terminal) return { ready: false, stage: "campaigns", created: false, reason: "failed_terminal", retryAfterAt: null, jobId: null };
    const params = {
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "campaigns",
      campaignMode: "full",
      reason: "creator_initial_analytics_sync",
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.CAMPAIGNS, collectionMode: "full", reason: "creator_initial_analytics_sync", now }),
      pageSize: 50,
      maxPages: 40,
      claimerPageSize: 50,
      fanValueBatchSize: 20,
      observationTokenVersion: 1,
      observationReadLeaseVersion: 1,
      campaignResumablePaginationVersion: 1,
      campaignFreshnessCoverageVersion: 1,
      campaignOrderIndependentTraversalVersion: 1,
      campaignSegmentedFairTraversalVersion: 1,
      campaignFrontierSchedulingVersion: 1,
      campaignDirectoryReuseVersion: 1,
      campaignDirectoryDiscoveryVersion: 1,
      campaignFrontierBudget: 50,
    };
    const scheduled = await scheduleIfIdle({
      db, creatorId, agencyId, jobKey: CAMPAIGN_JOB_KEY, params, priority, now, bucketMs: 60_000,
      collectorType: COLLECTOR_TYPES.CAMPAIGNS, collectorState: campaignState,
    });
    return { ready: false, stage: "campaigns", created: scheduled.created === true, reason: scheduled.reason || null, jobId: scheduled.job?.id || scheduled.jobId || null };
  }

  return { ready: true, stage: "ready", created: false, reason: "initial_sync_complete", jobId: null };
}

function recentKnownNotificationIdsFromState(state) {
  if (!Array.isArray(state?.knownNotificationIds)) return [];
  const out = [];
  const seen = new Set();
  for (const value of state.knownNotificationIds) {
    const id = clean(value, 220);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= NOTIFICATION_KNOWN_ID_LIMIT) break;
  }
  return out;
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

function retryDisposition(state, now = new Date()) {
  const retryAt = state?.retryAfterAt ? new Date(state.retryAfterAt) : null;
  if (retryAt && Number.isFinite(retryAt.getTime()) && retryAt > now) {
    return { deferred: true, terminal: false, retryAfterAt: retryAt };
  }
  if (String(state?.status || "").toUpperCase() === "FAILED" && !retryAt) {
    return { deferred: false, terminal: true, retryAfterAt: null };
  }
  return { deferred: false, terminal: false, retryAfterAt: retryAt };
}

function due(lastVerifiedAt, intervalMs, now) {
  if (!lastVerifiedAt) return true;
  const verifiedAt = new Date(lastVerifiedAt);
  if (!Number.isFinite(verifiedAt.getTime())) return true;
  // Use the same future-clock poison rule as AnalyticsStateEvaluator. A clock-
  // poisoned durable timestamp must be DUE for repair, never silently treated
  // as fresh by the planner while read models report it as untrusted.
  if (!trustedCollectionTimestamp(verifiedAt, now)) return true;
  return verifiedAt.getTime() <= now.getTime() - intervalMs;
}

async function ensureRecurringCreatorAnalyticsCatchups({ db = prisma, creatorId, agencyId, now = new Date(), priority = 20, campaignDirectoryDiscoveryAdmitted = true, reserveCampaignDirectory = null } = {}) {
  now = await dbAuthorityNow({ db, fallbackNow: now });
  const initial = await ensureInitialCreatorAnalyticsSync({ db, creatorId, agencyId, now, priority: Math.max(priority, 80) });
  if (!initial.ready) return { ready: false, initial, created: [], skipped: [] };
  const created = [];
  const skipped = [];

  const [notificationState, financialState, campaignState] = await Promise.all([
    loadNotificationSyncState(db, creatorId),
    db.creatorFinancialCollectionState.findUnique({ where: { creatorId } }),
    db.creatorCampaignCollectionState.findUnique({ where: { creatorId } }),
  ]);

  if (notificationHistoricalBaselineReady(notificationState, now) && due(notificationState.lastCatchupVerifiedAt, NOTIFICATION_COLLECTION_FRESHNESS_MS, now)) {
    const retry = retryDisposition(notificationState, now);
    if (retry.deferred) skipped.push("notifications_catchup:deferred");
    else if (retry.terminal) skipped.push("notifications_catchup:failed_terminal");
    else {
    const knownNotificationIds = recentKnownNotificationIdsFromState(notificationState);
    const params = {
      ...buildNotificationScanParams({ state: notificationState, now, reason: "creator_analytics_catchup", analyticsRangeKey: "all" }),
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.NOTIFICATIONS, collectionMode: "catchup", reason: "creator_analytics_catchup", now }),
      analyticsSyncKind: "catchup",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "notifications",
      knownNotificationIds,
    };
    const scheduled = await scheduleIfIdle({
      db, creatorId, agencyId, jobKey: NOTIFICATION_JOB_KEY, params, priority, now, bucketMs: NOTIFICATION_COLLECTION_FRESHNESS_MS,
      collectorType: COLLECTOR_TYPES.NOTIFICATIONS, collectorState: notificationState,
    });
    if (scheduled.created) created.push("notifications_catchup"); else skipped.push(`notifications_catchup:${scheduled.reason || "skipped"}`);
    }
  } else skipped.push("notifications_catchup:fresh");

  if (due(financialState?.lastCatchupCompletedAt, FINANCIAL_COLLECTION_FRESHNESS_MS, now)) {
    const retry = retryDisposition(financialState, now);
    if (retry.deferred) skipped.push("financial_catchup:deferred");
    else if (retry.terminal) skipped.push("financial_catchup:failed_terminal");
    else {
    const knownTransactionIds = await recentKnownTransactionIds(db, creatorId);
    const snapshotMarker = Math.floor(now.getTime() / 1000);
    const params = {
      analyticsSyncKind: "catchup",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "financial",
      financialMode: "catchup",
      reason: "creator_analytics_catchup",
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.FINANCIAL, collectionMode: "catchup", reason: "creator_analytics_catchup", now }),
      startDate: "2016-01-01 00:00:00",
      endDate: onlyFansUtcDateTime(new Date(snapshotMarker * 1000)),
      initialMarker: snapshotMarker,
      knownTransactionIds,
      catchupMaxPages: 100,
      schemaVersion: FINANCIAL_SCHEMA_VERSION,
      collectorVersion: FINANCIAL_COLLECTOR_VERSION,
    };
    const scheduled = await scheduleIfIdle({
      db, creatorId, agencyId, jobKey: FINANCIAL_JOB_KEY, params, priority, now, bucketMs: FINANCIAL_COLLECTION_FRESHNESS_MS,
      collectorType: COLLECTOR_TYPES.FINANCIAL, collectorState: financialState,
    });
    if (scheduled.created) created.push("financial_catchup"); else skipped.push(`financial_catchup:${scheduled.reason || "skipped"}`);
    }
  } else skipped.push("financial_catchup:fresh");

  if (campaignDelegatedRefreshPending(campaignState)) {
    skipped.push("campaigns_catchup:fan_refresh_pending");
  } else {
    const frontierDue = campaignFrontierWorkDue(campaignState, now);
    const directoryDue = campaignDirectoryDiscoveryDue(campaignState, now);
    const directoryReuse = (frontierDue || !directoryDue) ? campaignDirectoryReuseBinding(campaignState, now) : null;
    const requiresDirectoryDiscovery = directoryDue || (frontierDue && !directoryReuse);
    if (!frontierDue && !directoryDue) {
      skipped.push("campaigns_catchup:fresh");
    } else if (requiresDirectoryDiscovery && campaignDirectoryDiscoveryAdmitted !== true && typeof reserveCampaignDirectory !== "function") {
      skipped.push("campaigns_catchup:directory_capacity_deferred");
    } else {
      const retry = retryDisposition(campaignState, now);
      if (retry.deferred) skipped.push("campaigns_catchup:deferred");
      else if (retry.terminal) skipped.push("campaigns_catchup:failed_terminal");
      else {
        const params = {
          analyticsSyncKind: "catchup",
          analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
          analyticsSyncStage: "campaigns",
          campaignMode: "catchup",
          reason: "creator_analytics_catchup",
          ...(directoryReuse || {}),
          ...(!directoryReuse ? { campaignDirectoryDiscoveryVersion: 1 } : {}),
          ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.CAMPAIGNS, collectionMode: "catchup", reason: "creator_analytics_catchup", now }),
          pageSize: 50,
          maxPages: 40,
          claimerPageSize: 50,
          fanValueBatchSize: 20,
          observationTokenVersion: 1,
          observationReadLeaseVersion: 1,
          campaignResumablePaginationVersion: 1,
          campaignFreshnessCoverageVersion: 1,
          campaignOrderIndependentTraversalVersion: 1,
          campaignSegmentedFairTraversalVersion: 1,
          campaignFrontierSchedulingVersion: 1,
          campaignDirectoryReuseVersion: 1,
          campaignFrontierBudget: 50,
        };
        const scheduled = await scheduleIfIdle({
          db, creatorId, agencyId, jobKey: CAMPAIGN_JOB_KEY, params, priority, now, bucketMs: directoryReuse ? CAMPAIGN_COLLECTION_FRESHNESS_MS : CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS,
          collectorType: COLLECTOR_TYPES.CAMPAIGNS, collectorState: campaignState,
          reserveDirectory: requiresDirectoryDiscovery ? reserveCampaignDirectory : null,
        });
        if (scheduled.created) created.push(directoryReuse ? "campaigns_frontier_reuse" : "campaigns_directory_discovery");
        else skipped.push(`campaigns_catchup:${scheduled.reason || "skipped"}`);
      }
    }
  }

  return { ready: true, initial, created, skipped };
}

async function advanceCreatorAnalyticsInitialSyncAfterCompletion({ db = prisma, job, sideEffect = null, now = new Date() } = {}) {
  if (!job?.creatorId || !job?.agencyId || !lifecycleParams(job.params)) return { advanced: false, reason: "not_initial_analytics_job" };
  if (job.jobKey === NOTIFICATION_JOB_KEY && sideEffect?.verified !== true) return { advanced: false, reason: "notifications_not_verified" };
  if (job.jobKey === FINANCIAL_JOB_KEY && sideEffect?.complete !== true) return { advanced: false, reason: "financial_not_verified" };
  if (job.jobKey === CAMPAIGN_JOB_KEY && sideEffect?.completion?.complete !== true) {
    return { advanced: false, reason: sideEffect?.ok === true ? "campaign_fan_refresh_pending" : "campaigns_not_verified" };
  }
  const next = await ensureInitialCreatorAnalyticsSync({ db, creatorId: job.creatorId, agencyId: job.agencyId, now, priority: 95 });
  return { advanced: true, next };
}

module.exports = {
  ANALYTICS_SYNC_VERSION,
  NOTIFICATION_CATCHUP_INTERVAL_MS: NOTIFICATION_COLLECTION_FRESHNESS_MS,
  FINANCIAL_CATCHUP_INTERVAL_MS: FINANCIAL_COLLECTION_FRESHNESS_MS,
  CAMPAIGN_CATCHUP_INTERVAL_MS: CAMPAIGN_COLLECTION_FRESHNESS_MS,
  CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS,
  ensureInitialCreatorAnalyticsSync,
  ensureRecurringCreatorAnalyticsCatchups,
  advanceCreatorAnalyticsInitialSyncAfterCompletion,
  recentKnownNotificationIdsFromState,
  recentKnownTransactionIds,
  financialInitialCoverageReady,
  campaignInitialCoverageReady,
  creatorAnalyticsInitialSyncReady,
  campaignDirectoryDiscoveryDue,
  campaignDirectoryReuseBinding,
  campaignFrontierWorkDue,
};
