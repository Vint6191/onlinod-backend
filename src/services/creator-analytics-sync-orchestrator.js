"use strict";

const { directoryObservationAt } = require("./analytics-observation-time");
const campaignFreshness = require("./campaign-freshness-service");
const { membershipProofState, recoverPublishedMembershipProof } = require("./campaign-membership-proof-service");

const prisma = require("../prisma");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { buildNotificationScanParams, loadNotificationSyncState } = require("./notification-sync-state-service");
const {
  buildCollectionCommand,
  buildCollectionPlanningDedupeParams,
  collectorPlanningProofAt,
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
const liveSync = require("./creator-live-sync-service");
const NOTIFICATION_KNOWN_ID_LIMIT = 300;

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
    where: { creatorId, jobKey, status: { in: ["SCHEDULED", "PUBLISHING", "CLAIMED", "PAUSED"] } },
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
async function scheduleIfIdle({ db, creatorId, agencyId, jobKey, params, priority, now, bucketMs, collectorType, collectorState, reserveDirectory = null, campaignDirectoryDiscoveryAdmitted = true, catchupFreshnessMs = null }) {
  return withCollectorStateLock({ db, type: collectorType, creatorId, work: async (tx) => {
    const active = await inFlightJob(tx, creatorId, jobKey);
    if (active) return { created: false, reason: "already_in_flight", job: active };
    // Pre-lock reads are admission hints only. Reconstruct the whole command
    // from the current proof, debt, retry and directory authority under the same
    // lock as accept/complete; dedupe alone cannot reject obsolete work.
    let currentCollectorState = await loadCollectorPlanningState(tx, collectorType, creatorId, collectorState);
    now = await dbAuthorityNow({ db: tx, fallbackNow: now });
    if (collectorType === COLLECTOR_TYPES.CAMPAIGNS) currentCollectorState = await recoverPublishedMembershipProof({ db: tx, state: currentCollectorState, now });
    const initial = lifecycleParams(params);
    const baseline = collectorPlanningProofAt(collectorType, "full", currentCollectorState, now);
    let baselineReady = Boolean(baseline && (collectorType === COLLECTOR_TYPES.NOTIFICATIONS || (collectorType === COLLECTOR_TYPES.CAMPAIGNS ? membershipProofState(currentCollectorState).baselineGeneration : currentCollectorState?.baselineGeneration)));
    if(initial && collectorType===COLLECTOR_TYPES.FINANCIAL && baselineReady) {
      const [proof]=await tx.$queryRawUnsafe('SELECT "creatorId" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',creatorId);
      baselineReady=Boolean(proof);
    }
    if (initial && baselineReady) return { created: false, reason: "baseline_verified" };
    if (!initial && !baselineReady) return { created: false, reason: "baseline_unverified" };
    if (!params.recoveryIntentId && catchupFreshnessMs != null && !collectorCatchupDue(collectorType, currentCollectorState, catchupFreshnessMs, now)) {
      return { created: false, reason: "fresh" };
    }
    const retry = await collectorRetryDisposition({ db: tx, collectorType, state: currentCollectorState, agencyId, creatorId, now });
    currentCollectorState = retry.state;
    if (retry.deferred || retry.terminal) return { created: false, reason: retry.deferred ? retry.reason || "deferred" : "failed_terminal", retryAfterAt: retry.retryAfterAt };

    params = { ...params, ...buildCollectionCommand({ collectorType, collectionMode: initial ? "full" : "catchup", reason: params.reason, now }) };
    let collectionPlan = null;
    if (collectorType === COLLECTOR_TYPES.NOTIFICATIONS) {
      params = { ...params, ...buildNotificationScanParams({ state: initial ? null : currentCollectorState, now, reason: params.reason, analyticsRangeKey: "all" }) };
      if (!initial) params.knownNotificationIds = recentKnownNotificationIdsFromState(currentCollectorState);
    } else if (collectorType === COLLECTOR_TYPES.FINANCIAL) {
      // Financial windows are bound under the claim fence to current coverage.
    } else if (collectorType === COLLECTOR_TYPES.CAMPAIGNS && !initial && params.recoveryIntentId) {
      // Re-observe the unordered directory and member scopes once after a real
      // gap. Fair page cursors preserve progress across handoffs.
      params.campaignDirectoryDiscoveryVersion = 1;
      collectionPlan = "campaigns_offline_recovery";
    } else if (collectorType === COLLECTOR_TYPES.CAMPAIGNS && !initial) {
      const frontierDue = campaignFrontierWorkDue(currentCollectorState, now);
      const directoryDue = campaignDirectoryDiscoveryDue(currentCollectorState, now);
      if (!frontierDue && !directoryDue) return { created: false, reason: "fresh" };
      const reuse = campaignDirectoryReuseBinding(currentCollectorState, now);
      for (const key of ["campaignDirectoryReuseGeneration", "campaignDirectoryReuseRequestedAt", "campaignDirectoryReuseRevision", "campaignDirectoryReuseCampaignCount", "campaignDirectoryDiscoveryVersion"]) delete params[key];
      if (reuse) {
        Object.assign(params, reuse);
        bucketMs = CAMPAIGN_COLLECTION_FRESHNESS_MS;
        collectionPlan = "campaigns_frontier_reuse";
      } else {
        if (typeof reserveDirectory === "function") {
          if (!await reserveDirectory(currentCollectorState)) return { created: false, reason: "directory_capacity_deferred" };
        } else if (campaignDirectoryDiscoveryAdmitted !== true) return { created: false, reason: "directory_capacity_deferred" };
        params.campaignDirectoryDiscoveryVersion = 1;
        bucketMs = CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS;
        collectionPlan = "campaigns_directory_discovery";
      }
    }
    const scheduled = await scheduleNow({
      db: tx, jobKey, creatorId, agencyId, params, priority, now, bucketMs,
      dedupeParams: { ...buildCollectionPlanningDedupeParams({
        collectorType, collectionMode: params.collectionMode, state: currentCollectorState, now,
      }), ...(params.recoveryIntentId ? { recoveryIntentId: params.recoveryIntentId } : {}) },
    });
    if (params.recoveryIntentId && scheduled.job?.id) await liveSync.bindRecovery(tx, { id:params.recoveryIntentId }, scheduled.job.id);
    return { ...scheduled, collectionPlan };
  }});
}

function verifiedProofTimestampReady(value, now = new Date()) {
  return Boolean(trustedCollectionTimestamp(value, now));
}

function notificationHistoricalBaselineReady(state, now = new Date()) {
  return state?.normalizerVersion === "notification-source-v2" && verifiedProofTimestampReady(state?.fullBackfillVerifiedAt, now);
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
      status: { in: ["SCHEDULED", "PUBLISHING", "CLAIMED", "PAUSED"] },
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
      where: { id: job.id, status: { in: ["SCHEDULED", "PUBLISHING", "CLAIMED", "PAUSED"] } },
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
  if(!(state?.baselineGeneration && verifiedProofTimestampReady(state?.baselineVerifiedAt,now)))return false;
  const [proof]=await db.$queryRawUnsafe('SELECT "creatorId" FROM "CreatorEarningsLedgerProof" WHERE "creatorId"=$1',creatorId);
  return Boolean(proof);
}

async function campaignInitialCoverageReady(db, creatorId, now = new Date()) {
  if (!db?.creatorCampaignCollectionState?.findUnique) return false;
  // Readiness is read-only. Publication callers may already own a later
  // collector lock; do not acquire Campaign authority during this predicate.
  const state = await recoverPublishedMembershipProof({ db, persist: false,
    state: await db.creatorCampaignCollectionState.findUnique({ where: { creatorId } }), now });
  const proof = membershipProofState(state);
  return Boolean(proof.baselineGeneration && verifiedProofTimestampReady(proof.baselineVerifiedAt, now));
}

function campaignDirectoryDiscoveryDue(state, now = new Date()) {
  return campaignFreshness.directoryDue(state, now);
}

function campaignFrontierWorkDue(state, now = new Date()) {
  return campaignFreshness.frontierAdmissionDue(state, now);
}

function campaignDirectoryReuseBinding(state, now = new Date()) {
  if (campaignDirectoryDiscoveryDue(state, now)) return null;
  const generation = clean(state?.campaignDirectoryGeneration, 120);
  const requestedAt = state?.campaignDirectoryRequestedAt ? new Date(state.campaignDirectoryRequestedAt) : null;
  const verifiedAt = directoryObservationAt(state, now);
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
    const notificationRetry = await collectorRetryDisposition({ db, collectorType: COLLECTOR_TYPES.NOTIFICATIONS, state: notificationState, agencyId, creatorId, now });
    if (notificationRetry.deferred) return { ready: false, stage: "notifications", created: false, reason: notificationRetry.reason || "deferred", retryAfterAt: notificationRetry.retryAfterAt, jobId: null };
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
    const retry = await collectorRetryDisposition({ db, collectorType: COLLECTOR_TYPES.FINANCIAL, state: financialState, agencyId, creatorId, now });
    if (retry.deferred) return { ready: false, stage: "financial", created: false, reason: retry.reason || "deferred", retryAfterAt: retry.retryAfterAt, jobId: null };
    if (retry.terminal) return { ready: false, stage: "financial", created: false, reason: "failed_terminal", retryAfterAt: null, jobId: null };
    const snapshotMarker = Math.floor(now.getTime() / 1000);
    const params = {
      analyticsSyncKind: "initial",
      analyticsSyncVersion: ANALYTICS_SYNC_VERSION,
      analyticsSyncStage: "financial",
      financialMode: "full",
      earningsLedgerVersion:1,
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
    const retry = await collectorRetryDisposition({ db, collectorType: COLLECTOR_TYPES.CAMPAIGNS, state: campaignState, agencyId, creatorId, now });
    if (retry.deferred) return { ready: false, stage: "campaigns", created: false, reason: retry.reason || "deferred", retryAfterAt: retry.retryAfterAt, jobId: null };
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

async function collectorRetryDisposition({ db, collectorType, state, agencyId, creatorId, now }) {
  const recovered = await require("./collector-retry-policy").recoverTerminalCollector({ db, type: collectorType, state, agencyId, creatorId, now });
  if (recovered.active) return { state: recovered.state, deferred: true, terminal: false, retryAfterAt: null, reason: "already_in_flight" };
  return recovered.waitingForSession
    ? { state: recovered.state, deferred: true, terminal: false, retryAfterAt: null, reason: "waiting_for_api_session" }
    : { ...retryDisposition(recovered.state, now), state: recovered.state };
}

function due(lastVerifiedAt, intervalMs, now) {
  if (!lastVerifiedAt) return true;
  const verifiedAt = new Date(lastVerifiedAt);
  if (!Number.isFinite(verifiedAt.getTime())) return true;
  // Use the same future-clock poison rule as AnalyticsStateEvaluator. A clock-
  // poisoned durable timestamp must be DUE for repair, never silently treated
  // as fresh by the planner while read models report it as untrusted.
  if (!trustedCollectionTimestamp(verifiedAt, now)) return true;
  return verifiedAt.getTime() < now.getTime() - intervalMs;
}

function collectorCatchupDue(type, state, freshnessMs, now) {
  if (type === COLLECTOR_TYPES.FINANCIAL) {
    // The reader exposes gaps and stale historical audits independently of the
    // recent head. Planning must use that same authority: a just-verified head
    // must not postpone the next historical segment for another 24 hours.
    // Retry/quarantine is checked separately under the collector lock below.
    return !require("./financial-receipt-authority").evaluateCollection(state, now, freshnessMs).fresh;
  }
  return due(collectorPlanningProofAt(type, "catchup", state, now), freshnessMs, now);
}

async function ensureRecurringCreatorAnalyticsCatchups({ db = prisma, creatorId, agencyId, now = new Date(), priority = 20, campaignDirectoryDiscoveryAdmitted = true, reserveCampaignDirectory = null, _planningLocksHeld = false } = {}) {
  if (!creatorId || !agencyId) return { ready: false, initial: { ready: false, reason: "missing_scope" }, created: [], skipped: [], blocked: [], pendingRecoveryCount: 0, nextRetryAt: null };
  // One creator plan owns collector locks in Notifications -> Financial ->
  // Campaigns order before bootstrap can take its stage lock. Otherwise an
  // unfinished Campaign bootstrap followed by a Notification catch-up reverses
  // the order used by completion/next-stage planning in another replica.
  if (!_planningLocksHeld) return withCollectorStateLock({ db, type: COLLECTOR_TYPES.NOTIFICATIONS, creatorId, work: notificationTx =>
    withCollectorStateLock({ db: notificationTx, type: COLLECTOR_TYPES.FINANCIAL, creatorId, work: financialTx =>
      withCollectorStateLock({ db: financialTx, type: COLLECTOR_TYPES.CAMPAIGNS, creatorId, work: campaignTx =>
        ensureRecurringCreatorAnalyticsCatchups({ db: campaignTx, creatorId, agencyId, now, priority,
          campaignDirectoryDiscoveryAdmitted, reserveCampaignDirectory, _planningLocksHeld: true }) }) }) });
  now = await dbAuthorityNow({ db, fallbackNow: now });
  const initial = await ensureInitialCreatorAnalyticsSync({ db, creatorId, agencyId, now, priority: Math.max(priority, 80) });
  // Bootstrap order remains staged. Each already-proven stream can refresh
  // while a later bootstrap stage is pending or terminally failed.
  if (initial.reason === "missing_scope") return { ready: false, initial, created: [], skipped: [], blocked: [], pendingRecoveryCount: 0, nextRetryAt: null };
  const created = [];
  const skipped = [];
  const blocked = [];

  const [notificationState, financialState, storedCampaignState] = await Promise.all([
    loadNotificationSyncState(db, creatorId),
    db.creatorFinancialCollectionState.findUnique({ where: { creatorId } }),
    db.creatorCampaignCollectionState.findUnique({ where: { creatorId } }),
  ]);

  const campaignState = await recoverPublishedMembershipProof({ db, state: storedCampaignState, now });

  const readiness = {
    notifications: notificationHistoricalBaselineReady(notificationState, now),
    financial: Boolean(financialState?.baselineGeneration && collectorPlanningProofAt(COLLECTOR_TYPES.FINANCIAL, "full", financialState, now)),
    campaigns: Boolean(membershipProofState(campaignState).baselineGeneration && collectorPlanningProofAt(COLLECTOR_TYPES.CAMPAIGNS, "full", campaignState, now)),
  };
  const states = { notifications: notificationState, financial: financialState, campaigns: campaignState };
  // One indexed pending/running lookup per stream, never a count over history.
  // A live job can fail after this planning transaction yields. The durable
  // debt keeps a bounded wake until completion, including the subscriber stream.
  const intents = Object.fromEntries(await Promise.all(liveSync.STREAMS.map(async stream =>
    [stream, await liveSync.pendingRecovery(db, creatorId, stream)])));
  const pendingRecoveryCount = Object.values(intents).filter(Boolean).length;
  let nextRetryAt = null;
  for (const stream of liveSync.STREAMS.filter(stream=>stream!=="subscribers")) {
    const collectorType = stream === "notifications" ? COLLECTOR_TYPES.NOTIFICATIONS : stream === "financial" ? COLLECTOR_TYPES.FINANCIAL : COLLECTOR_TYPES.CAMPAIGNS;
    const retry = await collectorRetryDisposition({ db, collectorType, state: states[stream], agencyId, creatorId, now });
    states[stream] = retry.state;
    const candidateRetryAt = retry.reason === "waiting_for_api_session" ? new Date(+now + 60_000) : retry.retryAfterAt;
    if (candidateRetryAt && +candidateRetryAt > +now && (!nextRetryAt || +candidateRetryAt < +nextRetryAt)) nextRetryAt = candidateRetryAt;
    if (retry.terminal) blocked.push({ stream, reason: "failed_terminal", code: states[stream]?.lastErrorCode || "COLLECTOR_REPAIR_REQUIRED" });
    if (retry.deferred || retry.terminal) { skipped.push(`${stream}:${retry.terminal ? "failed_terminal" : retry.reason || "deferred"}`); continue; }
    if (!readiness[stream]) { skipped.push(`${stream}:baseline_unverified`); continue; }
    const intent = intents[stream];
    if (!intent) { skipped.push(`${stream}:live_no_recovery_debt`); continue; }
    const jobKey = stream === "notifications" ? NOTIFICATION_JOB_KEY : stream === "financial" ? FINANCIAL_JOB_KEY : CAMPAIGN_JOB_KEY;
    const params = {
      ...buildCollectionCommand({ collectorType, collectionMode:"catchup", reason:intent.reason, now }),
      analyticsSyncKind:"catchup", analyticsSyncVersion:ANALYTICS_SYNC_VERSION, analyticsSyncStage:stream,
      ...liveSync.recoveryParams(intent),
      ...(stream === "notifications" ? { ...buildNotificationScanParams({state:notificationState,now,reason:intent.reason}), notificationFrontierVersion:2 } : {}),
      ...(stream === "financial" ? { financialMode:"catchup", startDate:"2016-01-01 00:00:00", endDate:onlyFansUtcDateTime(now),
        initialMarker:Math.floor(+now/1000), schemaVersion:FINANCIAL_SCHEMA_VERSION, collectorVersion:FINANCIAL_COLLECTOR_VERSION, financialFrontierVersion:2 } : {}),
      ...(stream === "campaigns" ? { campaignMode:"catchup", pageSize:50, maxPages:40, claimerPageSize:50, fanValueBatchSize:20,
        observationTokenVersion:1, observationReadLeaseVersion:1, campaignResumablePaginationVersion:1,
        campaignFreshnessCoverageVersion:1, campaignOrderIndependentTraversalVersion:1, campaignSegmentedFairTraversalVersion:1,
        campaignFrontierSchedulingVersion:1, campaignDirectoryReuseVersion:1, campaignFrontierBudget:50,
        campaignDirectoryDiscoveryVersion:1 } : {}),
    };
    const result = await scheduleIfIdle({ db,creatorId,agencyId,jobKey,params,priority,now,bucketMs:1,
      collectorType,collectorState:states[stream] });
    if (result.created) created.push(`${stream}_offline_recovery`);
    else skipped.push(`${stream}:${result.reason || "in_flight"}`);
  }

  return { ready: initial.ready, initial, created, skipped, blocked, pendingRecoveryCount, nextRetryAt };
}

async function advanceCreatorAnalyticsInitialSyncAfterCompletion({ db = prisma, job, sideEffect = null, now = new Date() } = {}) {
  if (!job?.creatorId || !job?.agencyId || !lifecycleParams(job.params)) return { advanced: false, reason: "not_initial_analytics_job" };
  if (job.jobKey === NOTIFICATION_JOB_KEY && sideEffect?.verified !== true) return { advanced: false, reason: "notifications_not_verified" };
  if (job.jobKey === FINANCIAL_JOB_KEY && sideEffect?.complete !== true) return { advanced: false, reason: "financial_not_verified" };
  if (job.jobKey === CAMPAIGN_JOB_KEY && sideEffect?.completion?.membershipComplete !== true) {
    return { advanced: false, reason: "campaigns_not_verified" };
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
  financialInitialCoverageReady,
  campaignInitialCoverageReady,
  creatorAnalyticsInitialSyncReady,
  campaignDirectoryDiscoveryDue,
  campaignDirectoryReuseBinding,
  campaignFrontierWorkDue,
};
