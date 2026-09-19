"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { scheduleJobNow } = require("./job-scheduler");
const { reschedulePlannedJob } = require("./job-planning-repository");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { capabilityFreshnessWindow } = require("./capability-freshness-authority-service");
const { readCampaignsWithRevenue } = require("./creator-analytics-ledger-service");
const { campaignDirectoryDiscoveryCapacityState } = require("./provider-capacity-sla-service");
const { repairFailedCampaignFanRefreshDemands, CAMPAIGN_FAN_REFRESH_MAX_RETRIES } = require("./campaign-fan-refresh-queue-service");
const { deriveCampaignPresentationStatus, deriveManualCampaignStartDebtAction } = require("./campaign-scan-status-authority");
const {
  buildCollectionCommand, buildCollectionPlanningDedupeParams, withCollectorStateLock, COLLECTOR_TYPES,
} = require("./analytics-collector-control-service");

const JOB_KEY = "fetch_campaigns";
const MANUAL_REASON = "manual_creator_analytics_campaign_scan";
const ACTIVE_STATUSES = new Set(["SCHEDULED", "CLAIMED", "PAUSED"]);
const MANUAL_VERSION = 1;

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
  return params.manualCampaignScan === true && params.manualCampaignScanVersion === MANUAL_VERSION;
}
function jobStatus(job) {
  if (!job) return "IDLE";
  if (job.status === "SCHEDULED") return "QUEUED";
  if (job.status === "CLAIMED") return "RUNNING";
  if (job.status === "PAUSED") return "PAUSED";
  if (job.status === "FAILED") return "FAILED";
  if (job.status === "CANCELLED") return "CANCELLED";
  if (job.status === "DONE") {
    const result = object(job.result);
    // Collector status proves provider traversal only. FanData freshness is a
    // delegated server-side coverage lifecycle and must be evaluated from the
    // live CreatorCampaignCollectionState, not frozen job.result booleans.
    const complete = result.campaignPagesComplete === true && result.claimersComplete === true && result.truncated !== true
      && integer(result.campaignScannerRejected, 0) === 0 && integer(result.claimerScannerRejected, 0) === 0;
    return complete ? "COMPLETE" : "PARTIAL";
  }
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
async function activeCollectorJob(db, creatorId) {
  const rows = await db.jobInstance.findMany({
    where: { creatorId, jobKey: JOB_KEY, status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 40,
  });
  return rows.find((row) => ACTIVE_STATUSES.has(row.status)) || null;
}
async function countOnlineBindings(db, creator, now = null) {
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: now || new Date() });
  const freshnessWindow = capabilityFreshnessWindow(authorityNow, 2 * 60 * 1000);
  return db.deviceCreatorBinding.count({
    where: {
      creatorId: creator.id,
      agencyId: creator.agencyId,
      status: "ACTIVE",
      sessionReadReady: true,
      lastSeenAt: freshnessWindow,
      device: { lastSeenAt: freshnessWindow },
    },
  });
}

async function startManualCampaignScan({ db = prisma, creator, requestedByUserId = null, now = new Date() }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.CAMPAIGNS, creatorId: creator.id, work: async (tx) => {
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow: now });
    const active = await activeCollectorJob(tx, creator.id);
    const activeParams = object(active?.params);
    const activeUsesDirectoryReuse = Number(activeParams.campaignDirectoryReuseVersion || 0) >= 1
      && Boolean(clean(activeParams.campaignDirectoryReuseGeneration, 120));
    // An explicit manual FULL is a directory-discovery demand. If provider-free
    // reuse is already queued/running/paused, invalidate that reuse authority
    // immediately before returning it. Its next progress preflight will fail
    // closed against the raised discovery revision, and recurring planning can
    // then schedule the required source-exhaustive discovery.
    if (activeUsesDirectoryReuse && typeof tx.creatorCampaignCollectionState?.findUnique === "function"
      && typeof tx.creatorCampaignCollectionState?.update === "function") {
      const activeState = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: creator.id } });
      if (activeState) {
        const requestedRevision = Math.max(0, Number(activeState.campaignDirectoryDiscoveryRequestedRevision || 0)) + 1;
        await tx.creatorCampaignCollectionState.update({
          where: { creatorId: creator.id },
          data: {
            campaignDirectoryDiscoveryRequestedRevision: requestedRevision,
            campaignDirectoryDiscoveryRequestedAt: authorityNow,
            campaignDirectoryDiscoveryDueAt: authorityNow,
          },
        });
      }
    }
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

    // If the provider collector already finished but delegated FanData debt is
    // still open, START is a recovery/status action, never permission to replay
    // the Campaign directory/claimer traversal. This is deliberately fail-closed
    // across lost HTTP responses: once FAILED debt is requeued, a repeated START
    // sees QUEUED debt and returns refresh_pending instead of launching a full scan.
    if (typeof tx.creatorFanRefreshDemand?.count === "function") {
      const [failedDebt, queuedDebtBeforeRepair] = await Promise.all([
        tx.creatorFanRefreshDemand.count({ where: { creatorId: creator.id, status: "FAILED" } }),
        tx.creatorFanRefreshDemand.count({ where: { creatorId: creator.id, status: "QUEUED" } }),
      ]);
      const debtAction = deriveManualCampaignStartDebtAction({ failedDebt, queuedDebt: queuedDebtBeforeRepair });
      if (debtAction === "repair") {
        const repaired = await repairFailedCampaignFanRefreshDemands({ db: tx, creatorId: creator.id, now: authorityNow, maxDemands: 500 });
        // Even if another replica won the SKIP LOCKED race and repaired the rows
        // first, the observed FAILED debt proves this request belongs to the
        // delegated refresh recovery lifecycle. Never fall through to FULL scan.
        return { job: null, action: repaired.recovered > 0 || repaired.promotedJobs > 0 ? "refresh_repair_queued" : "refresh_pending", repaired };
      }
      if (debtAction === "refresh_pending") return { job: null, action: "refresh_pending", repaired: null };
    }

    let state = typeof tx.creatorCampaignCollectionState?.findUnique === "function"
      ? await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: creator.id } })
      : null;
    if (state && typeof tx.creatorCampaignCollectionState?.update === "function") {
      const requestedRevision = Math.max(0, Number(state.campaignDirectoryDiscoveryRequestedRevision || 0)) + 1;
      state = await tx.creatorCampaignCollectionState.update({
        where: { creatorId: creator.id },
        data: {
          campaignDirectoryDiscoveryRequestedRevision: requestedRevision,
          campaignDirectoryDiscoveryRequestedAt: authorityNow,
          campaignDirectoryDiscoveryDueAt: authorityNow,
        },
      });
    }
    const params = {
      manualCampaignScan: true,
      manualCampaignScanVersion: MANUAL_VERSION,
      manualRunToken: crypto.randomUUID(),
      requestedByUserId: clean(requestedByUserId, 220),
      reason: MANUAL_REASON,
      ...buildCollectionCommand({ collectorType: COLLECTOR_TYPES.CAMPAIGNS, collectionMode: "full", reason: MANUAL_REASON, now: authorityNow }),
      pageSize: 50,
      maxPages: 40,
      claimerPageSize: 50,
      fanValueBatchSize: 20,
      observationTokenVersion: 1,
      observationReadLeaseVersion: 1,
      campaignResumablePaginationVersion: 1,
      campaignFreshnessCoverageVersion: 1,
      campaignDirectoryDiscoveryVersion: 1,
    };
    const scheduled = await scheduleJobNow({
      db: tx, jobKey: JOB_KEY, creatorId: creator.id, agencyId: creator.agencyId, params, priority: 100, now: authorityNow, bucketMs: 1,
      dedupeParams: buildCollectionPlanningDedupeParams({
        collectorType: COLLECTOR_TYPES.CAMPAIGNS, collectionMode: "full", state,
      }),
    });
    return { job: scheduled.job, action: scheduled.reason === "already_claimed" ? "already_running" : "created" };
  }});
}

async function stopManualCampaignScan({ db = prisma, creatorId, now = new Date() }) {
  const active = await activeJob(db, creatorId);
  if (!active) return { job: null, action: "idle" };
  if (active.status === "PAUSED") return { job: active, action: "already_paused" };
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: now });
  const pause = async (tx) => {
    const result = await tx.jobInstance.updateMany({
      where: {
        id: active.id,
        status: { in: ["SCHEDULED", "CLAIMED"] },
        leaseRevision: active.leaseRevision,
      },
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
        lastProgressAt: active.lastProgressAt || authorityNow,
      },
    });
    if (!result.count) return { changed: false };
    if (active.status === "CLAIMED" && active.claimedByDeviceId && typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: {
          creatorId,
          jobId: active.id,
          deviceId: active.claimedByDeviceId,
          leaseRevision: active.leaseRevision,
        },
      });
    }
    return { changed: true };
  };
  const outcome = typeof db.$transaction === "function"
    ? await db.$transaction(pause)
    : await pause(db);
  if (!outcome.changed) {
    const current = await db.jobInstance.findUnique({ where: { id: active.id } });
    return { job: current, action: current?.status === "PAUSED" ? "already_paused" : "changed" };
  }
  return { job: await db.jobInstance.findUnique({ where: { id: active.id } }), action: "paused" };
}

function campaignForClient(row) {
  return {
    id: row.id,
    externalCampaignId: row.externalCampaignId,
    name: row.name,
    campaignType: row.campaignType,
    trackingCode: row.trackingCode,
    trackingUrl: row.trackingUrl,
    isActive: row.isActive === true,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    claimersCount: row.claimersCount,
    clicksCount: row.clicksCount,
    fansCount: integer(row.fansCount, 0),
    payingFans: integer(row.payingFans, 0),
    transactionsCount: integer(row.transactionsCount, 0),
    grossCents: Number(row.grossCents || 0),
    netCents: Number(row.netCents || 0),
    settledTransactionsCount: integer(row.settledTransactionsCount, 0),
    settledGrossCents: Number(row.settledGrossCents || 0),
    settledNetCents: Number(row.settledNetCents || 0),
    pendingTransactionsCount: integer(row.pendingTransactionsCount, 0),
    pendingGrossCents: Number(row.pendingGrossCents || 0),
    pendingNetCents: Number(row.pendingNetCents || 0),
    ofValueKnownFans: integer(row.ofValueKnownFans, 0),
    ofValuePayingFans: integer(row.ofValuePayingFans, 0),
    platformReportedFanSpendCents: Number(row.platformReportedFanSpendCents || 0),
    ofValueFetchedAt: iso(row.ofValueFetchedAt),
  };
}

async function readManualCampaignScan({ db = prisma, creator, limit = 100, offset = 0, generationReadAttempt = 0 }) {
  if (!creator?.id || !creator?.agencyId) throw new Error("Creator scope is required");
  const jobs = await recentJobs(db, creator.id, null, 60);
  const job = jobs[0] || null;
  const manualCollectorStatus = jobStatus(job);
  const safeLimit = Math.max(1, Math.min(200, integer(limit, 100, 200)));
  const safeOffset = Math.max(0, Math.min(1_000_000, integer(offset, 0, 1_000_000)));
  const progress = object(job?.progress);
  const result = object(job?.result);
  const continuationEnvelope = object(job?.continuation);
  const continuation = continuationEnvelope.driverPhase === "execute" ? object(continuationEnvelope.jobContinuation) : continuationEnvelope;
  const page = await readCampaignsWithRevenue({ db, creatorId: creator.id, limit: safeLimit, offset: safeOffset });
  const campaignRows = page.campaigns.map(campaignForClient);
  const totals = page.summary || { campaigns: campaignRows.length, fans: 0, payingFans: 0, settledNetCents: 0, pendingNetCents: 0, transactionsCount: 0, ofValueKnownFans: 0, ofValuePayingFans: 0, platformReportedFanSpendCents: 0, ofValueFetchedAt: null };
  const onlineWorkers = await countOnlineBindings(db, creator);
  const collectionState = await db.creatorCampaignCollectionState?.findUnique?.({ where: { creatorId: creator.id } }) || null;
  const capacityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const directoryDiscovery = campaignDirectoryDiscoveryCapacityState(collectionState, capacityNow);
  const campaignRefs = Array.isArray(continuation.campaigns) ? continuation.campaigns : [];
  const resultScanRunId = clean(result.scanRunId ?? continuation.scanRunId, 120);
  const currentCoverageScanRunId = clean(collectionState?.fanValueCoverageScanRunId, 120);
  const coverageMatches = Boolean(resultScanRunId && currentCoverageScanRunId === resultScanRunId);
  const canonicalCoveragePresent = Boolean(currentCoverageScanRunId);
  const manualGenerationSuperseded = Boolean(resultScanRunId && currentCoverageScanRunId && resultScanRunId !== currentCoverageScanRunId);
  const currentCoverageSourceJobId = clean(collectionState?.fanValueCoverageSourceJobId ?? collectionState?.sourceJobId, 220);
  const currentCoverageOwnerKind = clean(collectionState?.fanValueCoverageOwnerKind, 32);
  const currentCoverageCollectorVersion = clean(collectionState?.fanValueCoverageCollectorVersion, 80);
  const currentCoverageDelegated = canonicalCoveragePresent && collectionState?.fanValueCoverageDelegated === true;
  let currentCoverageJob = null;
  if (currentCoverageSourceJobId && typeof db.jobInstance?.findUnique === "function") {
    currentCoverageJob = await db.jobInstance.findUnique({ where: { id: currentCoverageSourceJobId } });
  }
  const currentCoverageCollectorStatus = currentCoverageJob ? jobStatus(currentCoverageJob) : null;
  const currentCoverageOwnsPresentation = canonicalCoveragePresent && (!coverageMatches || !job);
  const collectorStatus = currentCoverageOwnsPresentation
    ? (currentCoverageCollectorStatus || manualCollectorStatus)
    : manualCollectorStatus;
  // The endpoint presents two independent authorities: the selected manual job
  // remains the provider traversal history, while FanData counters always come
  // from the creator's current canonical coverage generation when one exists.
  const fanValuesExpected = canonicalCoveragePresent ? integer(collectionState.fanValueExpected, 0, 100_000_000) : integer(result.fanValuesTotal ?? continuation.fanValuesDiscovered, 0, 100_000_000);
  const fanValuesAlreadyFresh = canonicalCoveragePresent ? integer(collectionState.fanValueAlreadyFresh, 0, 100_000_000) : 0;
  const fanValuesQueued = canonicalCoveragePresent ? integer(collectionState.fanValueQueued, 0, 100_000_000) : integer(result.fanValuesRequested ?? continuation.fanValuesRequested, 0, 100_000_000);
  const fanValuesSucceeded = canonicalCoveragePresent ? integer(collectionState.fanValueSucceeded, 0, 100_000_000) : integer(result.fanValuesFetched ?? continuation.fanValuesFetched, 0, 100_000_000);
  const fanValuesUnavailable = canonicalCoveragePresent ? integer(collectionState.fanValueUnavailable, 0, 100_000_000) : integer(result.fanValuesUnavailable ?? continuation.fanValuesUnavailable, 0, 100_000_000);
  const fanValuesFailed = canonicalCoveragePresent ? integer(collectionState.fanValueFailed, 0, 100_000_000) : 0;
  const fanValuesOutstanding = canonicalCoveragePresent ? integer(collectionState.fanValueOutstanding, 0, 100_000_000) : Math.max(0, fanValuesQueued - fanValuesSucceeded - fanValuesUnavailable);
  const fanValueFreshnessStatus = canonicalCoveragePresent ? clean(collectionState.fanValueFreshnessStatus, 40) || "MISSING" : "MISSING";
  const campaignFrontierFreshnessStatus = clean(collectionState?.campaignFrontierFreshnessStatus, 40) || "MISSING";
  const campaignFrontierDue = integer(collectionState?.campaignFrontierDueCount, 0, 100_000_000);
  const campaignFrontierTarget = integer(collectionState?.campaignFrontierTargetCount, 0, 100_000_000);
  const campaignFrontierCompleted = integer(collectionState?.campaignFrontierCompletedCount, 0, 100_000_000);
  const campaignFrontierDeferred = integer(collectionState?.campaignFrontierDeferredCount, 0, 100_000_000);
  const manualFanRefreshDelegated = result.fanRefreshDelegated === true || ["campaigns-v9", "campaigns-v10", "campaigns-v11", "campaigns-v12", "campaigns-v13"].includes(continuation.collectorVersion);
  const fanRefreshDelegated = canonicalCoveragePresent ? currentCoverageDelegated : manualFanRefreshDelegated;
  const membershipCoverageStatus = clean(collectionState?.membershipCoverageStatus, 40) || "MISSING";
  const fanValuesComplete = canonicalCoveragePresent
    ? fanValueFreshnessStatus === "COMPLETE" && campaignFrontierFreshnessStatus === "COMPLETE"
    : fanRefreshDelegated ? false : result.fanValuesComplete === true;
  let failedRefreshDemands = 0;
  let quarantinedRefreshDemands = 0;
  let refreshNextRetryAt = null;
  let refreshLastFailureFanId = null;
  let refreshLastFailureMessage = null;
  let refreshLastFailureAt = null;
  let refreshLastFailureAttempts = 0;
  let refreshLastFailureQuarantined = false;
  if (typeof db.creatorFanRefreshDemand?.count === "function") {
    const counts = await Promise.all([
      db.creatorFanRefreshDemand.count({ where: { creatorId: creator.id, status: "FAILED", quarantinedAt: null } }),
      db.creatorFanRefreshDemand.count({ where: { creatorId: creator.id, status: "FAILED", quarantinedAt: { not: null } } }),
    ]);
    failedRefreshDemands = counts[0];
    quarantinedRefreshDemands = counts[1];
  }
  if (failedRefreshDemands > 0 && typeof db.creatorFanRefreshDemand?.findFirst === "function") {
    const retry = await db.creatorFanRefreshDemand.findFirst({
      where: { creatorId: creator.id, status: "FAILED", quarantinedAt: null, nextRetryAt: { not: null } },
      orderBy: [{ nextRetryAt: "asc" }, { id: "asc" }],
      select: { nextRetryAt: true },
    });
    refreshNextRetryAt = iso(retry?.nextRetryAt);
  }
  if ((failedRefreshDemands > 0 || quarantinedRefreshDemands > 0) && typeof db.creatorFanRefreshDemand?.findFirst === "function") {
    const latestFailure = await db.creatorFanRefreshDemand.findFirst({
      where: { creatorId: creator.id, status: "FAILED" },
      orderBy: [{ lastFailedAt: "desc" }, { id: "asc" }],
      select: { onlyFansUserId: true, lastError: true, lastFailedAt: true, retryAttempts: true, quarantinedAt: true },
    });
    refreshLastFailureFanId = clean(latestFailure?.onlyFansUserId, 180);
    refreshLastFailureMessage = clean(latestFailure?.lastError, 1000);
    refreshLastFailureAt = iso(latestFailure?.lastFailedAt);
    refreshLastFailureAttempts = integer(latestFailure?.retryAttempts, 0, CAMPAIGN_FAN_REFRESH_MAX_RETRIES);
    refreshLastFailureQuarantined = Boolean(latestFailure?.quarantinedAt);
  }
  const presentation = deriveCampaignPresentationStatus({
    collectorStatus, fanRefreshDelegated, membershipCoverageStatus, campaignFrontierFreshnessStatus,
    fanValuesComplete, fanValuesOutstanding, fanValueFreshnessStatus, retryableFailedDemands: failedRefreshDemands,
    currentCoverageAuthoritative: canonicalCoveragePresent,
  });
  const { status, coverageStatus, refreshPending } = presentation;
  const refreshRecoveryAvailable = failedRefreshDemands > 0 || quarantinedRefreshDemands > 0;
  const stateErrorCode = clean(collectionState?.lastErrorCode, 120);
  const stateErrorMessage = clean(collectionState?.lastErrorMessage, 1000);
  if (canonicalCoveragePresent && typeof db.creatorCampaignCollectionState?.findUnique === "function") {
    const endState = await db.creatorCampaignCollectionState.findUnique({
      where: { creatorId: creator.id },
      select: { fanValueCoverageScanRunId: true },
    });
    const endCoverageScanRunId = clean(endState?.fanValueCoverageScanRunId, 120);
    if (endCoverageScanRunId !== currentCoverageScanRunId) {
      if (generationReadAttempt < 2) {
        return readManualCampaignScan({ db, creator, limit, offset, generationReadAttempt: generationReadAttempt + 1 });
      }
      const error = new Error("CAMPAIGN_COVERAGE_READ_GENERATION_UNSTABLE");
      error.code = "CAMPAIGN_COVERAGE_READ_GENERATION_UNSTABLE";
      throw error;
    }
  }
  return {
    ok: true,
    creatorId: creator.id,
    jobId: job?.id || null,
    status,
    collectorStatus,
    coverageStatus,
    refreshPending,
    manual: Boolean(job),
    manualCollectorStatus,
    currentCoverageCollectorStatus,
    currentCoverageOwnerKind,
    currentCoverageCollectorVersion,
    currentCoverageSourceJobId,
    currentCoverageDelegated,
    phase: clean(continuation.phase, 40) || (["COMPLETE", "PARTIAL", "REFRESH_PENDING"].includes(status) ? "complete" : "campaigns"),
    campaignPagesScanned: integer(continuation.page ?? result.campaignBatchCount, 0, 10_000),
    campaignIndex: integer(continuation.campaignIndex ?? result.campaignCount, 0, 10_000),
    claimerPage: integer(continuation.claimerPage ?? result.claimerBatchCount, 0, 2_147_483_647),
    discoveredCampaigns: integer(campaignRefs.length || result.campaignCount, 0, 10_000),
    sourceBoundaryReached: result.campaignPagesComplete === true && result.claimersComplete === true && result.truncated !== true,
    truncated: result.truncated === true || continuation.truncated === true,
    campaignScannerRejected: integer(result.campaignScannerRejected ?? continuation.campaignScannerRejected, 0, 100_000_000),
    claimerScannerRejected: integer(result.claimerScannerRejected ?? continuation.claimerScannerRejected, 0, 100_000_000),
    fanValuesTotal: fanValuesExpected,
    fanValuesRequested: fanValuesQueued,
    fanValuesFetched: fanValuesSucceeded,
    fanValuesUnavailable,
    fanValuesAlreadyFresh,
    fanValuesFailed,
    fanValuesOutstanding,
    fanValueFreshnessStatus,
    fanValueFreshnessCutoffAt: canonicalCoveragePresent ? iso(collectionState.fanValueFreshnessCutoffAt) : null,
    manualScanRunId: resultScanRunId,
    currentCoverageScanRunId,
    coverageMatchesManualGeneration: coverageMatches,
    manualGenerationSuperseded,
    campaignFrontierFreshnessStatus,
    campaignFrontierDue,
    campaignFrontierTarget,
    campaignFrontierCompleted,
    campaignFrontierDeferred,
    campaignFrontierOldestDueAt: iso(collectionState?.campaignFrontierOldestDueAt),
    campaignFrontierNextDueAt: iso(collectionState?.campaignFrontierNextDueAt),
    campaignMembershipCoverageStatus: membershipCoverageStatus,
    campaignDirectoryDiscoveryStatus: directoryDiscovery.status,
    campaignDirectoryDiscoveryDueAt: iso(directoryDiscovery.dueAt),
    campaignDirectoryVerifiedAt: iso(directoryDiscovery.verifiedAt),
    campaignDirectoryDiscoveryOverdueByMs: directoryDiscovery.overdueByMs,
    campaignDirectoryDiscoveryPending: directoryDiscovery.pendingDemand,
    campaignDirectoryDiscoveryEstimatedProviderCalls: directoryDiscovery.estimatedProviderCalls,
    campaignDirectoryDiscoveryTargetMs: directoryDiscovery.targetMs,
    fanValuesComplete,
    fanRefreshDelegated,
    failedRefreshDemands,
    quarantinedRefreshDemands,
    refreshNextRetryAt,
    refreshRetryMaxAttempts: CAMPAIGN_FAN_REFRESH_MAX_RETRIES,
    refreshRecoveryAvailable,
    refreshLastFailureFanId,
    refreshLastFailureMessage,
    refreshLastFailureAt,
    refreshLastFailureAttempts,
    refreshLastFailureQuarantined,
    startedAt: iso(job?.startedAt || job?.scheduledAt),
    completedAt: iso(job?.completedAt),
    lastProgressAt: iso(job?.lastProgressAt),
    lastErrorCode: status === "FAILED" ? "CAMPAIGN_SCAN_FAILED" : (status === "PARTIAL" ? stateErrorCode : null),
    lastErrorMessage: status === "FAILED" ? clean(job?.lastError, 1000) : (status === "PARTIAL" ? stateErrorMessage : null),
    currentMessage: clean(progress.message, 500),
    onlineWorkers,
    summary: {
      campaigns: integer(totals.campaigns, campaignRows.length, 100_000),
      fans: integer(totals.fans, 0, 100_000_000),
      payingFans: integer(totals.payingFans, 0, 100_000_000),
      transactionsCount: integer(totals.transactionsCount, 0, 100_000_000),
      settledNetCents: Number(totals.settledNetCents || 0),
      pendingNetCents: Number(totals.pendingNetCents || 0),
      ofValueKnownFans: integer(totals.ofValueKnownFans, 0, 100_000_000),
      ofValuePayingFans: integer(totals.ofValuePayingFans, 0, 100_000_000),
      platformReportedFanSpendCents: Number(totals.platformReportedFanSpendCents || 0),
      ofValueFetchedAt: iso(totals.ofValueFetchedAt),
      ofValueFreshnessCutoffAt: iso(totals.ofValueFreshnessCutoffAt),
    },
    campaigns: campaignRows,
    pagination: page.pagination,
  };
}

module.exports = {
  JOB_KEY,
  MANUAL_REASON,
  isManualJob,
  startManualCampaignScan,
  stopManualCampaignScan,
  readManualCampaignScan,
  _test: { jobStatus },
};
