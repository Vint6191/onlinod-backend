"use strict";
const { notificationCommittedPageProof } = require("./notification-page-receipt-service");

const { isDeepStrictEqual } = require("node:util");

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { isOwner, normalizeAssignedCreators } = require("./team-access-control");
const { assertExecutionAccessFence, ExecutionAccessFenceError } = require("./execution-access-fence-service");
const { readBillingExecutionAccess, billingJobClaimWhere, assertJobBillingAccess, BillingExecutionAccessError } = require("./billing-execution-access-service");
const { applyJobChunk, applyJobResult, recordJobFailure } = require("./job-result-service");
const { filterClaimableDesktopJobKeys } = require("./job-catalog");
const { completeDialogJobFenced } = require("./dialog-job-completion-fence");
const { completeNotificationSync } = require("./notification-sync-state-service");
const { trustedCollectionTimestamp } = require("./analytics-freshness-policy");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { publishNotificationConsequences } = require("./notification-consequence-service");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const {
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS,
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR,
  fanDataRefreshClaimAvailable,
} = require("./provider-capacity-authority-service");
const { enterCampaignClaimGeneration } = require("./campaign-causal-activation-service");
const { capabilityFreshnessWindow, isCapabilityTimestampFresh } = require("./capability-freshness-authority-service");
const { createFanObservationToken } = require("./fan-observation-token-service");
const {
  FanObservationReadLeaseError,
  FAN_OBSERVATION_READ_LEASE_TTL_MS,
  acquireFanObservationReadLease: acquireCreatorObservationReadLease,
  completeJobFanObservationReadLease,
  releaseJobFanObservationReadLease,
} = require("./fan-observation-read-lease-service");

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 30 * 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS = Math.max(1, Math.min(100, Number.parseInt(process.env.CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS || "8", 10) || 8));
const CAMPAIGN_DIRECTORY_DISCOVERY_CLAIM_LOCK_KEY = "campaign-directory-discovery-claim-admission-v1";
const CAMPAIGN_DIRECTORY_DISCOVERY_MAX_NON_RECURRING_ACTIVE_CLAIMS = Math.max(1, Math.min(CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS, Number.parseInt(process.env.CAMPAIGN_DIRECTORY_DISCOVERY_MAX_NON_RECURRING_ACTIVE_CLAIMS || "4", 10) || 4));
const DIALOG_INTELLIGENCE_JOB_KEY = "dialog_intelligence_scan";
const DIALOG_DISCOVERY_DIALOG_ID = "__dialog_discovery__";
const FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY = Object.freeze({
  fan_data_point_refresh: Object.freeze(["fan_data_point_refresh"]),
  sfs_target_discovery: Object.freeze(["sfs_target_discovery"]),
  subscriber_directory_scan: Object.freeze(["subscriber_directory_page"]),
  fetch_campaigns: Object.freeze(["campaign_claimers_page", "campaign_fan_values"]),
});
const FAN_OBSERVATION_READ_LEASE_JOB_KEYS = new Set(Object.keys(FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY));

class JobLeaseError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "JobLeaseError";
    this.code = code;
    this.status = status;
  }
}
function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function campaignDirectoryDiscoveryJob(params) {
  const value = object(params);
  // Every fetch_campaigns job without an exact directory-reuse binding can
  // issue provider /campaigns reads. Classify old pre-A10 queued jobs as
  // discovery too, so rolling deployment cannot bypass the new active cap.
  return !(Number(value.campaignDirectoryReuseVersion || 0) >= 1
    && clean(value.campaignDirectoryReuseGeneration, 120));
}
function campaignDirectoryRecurringDiscoveryJob(params) {
  const value = object(params);
  return String(value.analyticsSyncKind || "") === "catchup"
    && String(value.reason || "") === "creator_analytics_catchup"
    && campaignDirectoryDiscoveryJob(value);
}
async function campaignDirectoryDiscoveryClaimAvailable(db, candidateParams = null) {
  if (typeof db?.$queryRawUnsafe !== "function" || typeof db?.$executeRawUnsafe !== "function") return true;
  await lockDbAdvisoryXact({ db, key: CAMPAIGN_DIRECTORY_DISCOVERY_CLAIM_LOCK_KEY });
  // Count the entire CLAIMED set under one transaction-scoped advisory lock.
  // A bounded JS sample is not sufficient: provider-free reuse rows could sort
  // ahead of discovery rows and make a saturated fleet look under capacity.
  // Legacy pre-A10 jobs are discovery unless they carry the exact A9 reuse
  // binding, so rolling deployment cannot escape the cap.
  const rows = await db.$queryRawUnsafe(`
    WITH claimed AS (
      SELECT "params",
        NOT (
          CASE
            WHEN COALESCE("params"->>'campaignDirectoryReuseVersion', '') ~ '^[0-9]+$'
              THEN ("params"->>'campaignDirectoryReuseVersion')::integer
            ELSE 0
          END >= 1
          AND NULLIF(BTRIM(COALESCE("params"->>'campaignDirectoryReuseGeneration', '')), '') IS NOT NULL
        ) AS discovery
      FROM "JobInstance"
      WHERE "jobKey" = 'fetch_campaigns'
        AND "status" = 'CLAIMED'
    )
    SELECT
      COUNT(*) FILTER (WHERE discovery)::bigint AS "activeDiscovery",
      COUNT(*) FILTER (
        WHERE discovery
          AND NOT (
            COALESCE("params"->>'analyticsSyncKind', '') = 'catchup'
            AND COALESCE("params"->>'reason', '') = 'creator_analytics_catchup'
          )
      )::bigint AS "activeNonRecurringDiscovery"
    FROM claimed
  `);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const activeDiscovery = Number(row?.activeDiscovery ?? row?.activediscovery ?? 0);
  const activeNonRecurring = Number(row?.activeNonRecurringDiscovery ?? row?.activenonrecurringdiscovery ?? 0);
  if (!Number.isFinite(activeDiscovery) || activeDiscovery >= CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS) return false;
  if (!campaignDirectoryRecurringDiscoveryJob(candidateParams)) {
    return Number.isFinite(activeNonRecurring) && activeNonRecurring < CAMPAIGN_DIRECTORY_DISCOVERY_MAX_NON_RECURRING_ACTIVE_CLAIMS;
  }
  return true;
}

function campaignClaimParams(value) {
  const params = { ...object(value) };
  // Retire the old O(campaign fan history) catch-up hints at the claim fence so
  // already-SCHEDULED pre-cutover jobs cannot leak oversized params to a new
  // Desktop. Missing compact hints only causes a safe provider rescan.
  delete params.knownCampaignFanCounts;
  delete params.knownClaimersByCampaign;
  // Retire the old terminal 10k claimer-page cap from already-queued jobs.
  // campaigns-v10+ keep page/offset in O(1) durable continuation and rely on
  // exact server-side no-progress detection instead of a completeness cap.
  delete params.maxClaimerPages;
  // Current Campaign traversal is order-independent. Historical head hashes
  // remain server-side diagnostics only; never lease them as skip authority.
  delete params.knownClaimerFrontierHashes;
  return params;
}
function campaignDirectoryReuseInitialContinuation(value) {
  const params = object(value);
  if (Number(params.campaignDirectoryReuseVersion || 0) < 1) return null;
  const directoryGeneration = clean(params.campaignDirectoryReuseGeneration, 120);
  if (!directoryGeneration) return null;
  const generation = clean(params.collectionGeneration, 120);
  const requestedAt = clean(params.collectionRequestedAt, 100);
  const mode = String(params.collectionMode || params.campaignMode || "").toLowerCase();
  const revision = Number(params.campaignDirectoryReuseRevision);
  const campaignCount = Number(params.campaignDirectoryReuseCampaignCount);
  const directoryRequestedAt = clean(params.campaignDirectoryReuseRequestedAt, 100);
  if (!generation || !requestedAt || mode !== "catchup" || !directoryRequestedAt) return null;
  if (!Number.isInteger(revision) || revision < 1 || !Number.isInteger(campaignCount) || campaignCount < 0) return null;
  if (!Number.isFinite(Date.parse(requestedAt)) || !Number.isFinite(Date.parse(directoryRequestedAt))) return null;
  return {
    driverPhase: "execute",
    jobContinuation: {
      collectorVersion: "campaigns-v13", scanRunId: generation, scanStartedAt: new Date(requestedAt).toISOString(),
      phase: "segment", campaignMode: "catchup", offset: 0, page: 0, campaigns: [],
      segmentCursor: null, segmentRequestCursor: null, segmentHasMore: false, campaignIndex: 0,
      claimerOffset: 0, claimerPage: 0, directorySourceExhausted: true, campaignPagesComplete: true, truncated: false,
      totalCampaignCount: campaignCount, campaignBatchCount: 0, claimerBatchCount: 0, campaignScannerRejected: 0, claimerScannerRejected: 0,
      fanValuesDiscovered: 0, quantumLeaseRevision: 0, quantumStartedAt: new Date(requestedAt).toISOString(), quantumRequests: 0,
    },
  };
}
function campaignServerBoundaryContinuation(value, externalCampaignId, previousValue = null, { forceTruncated = false } = {}) {
  const driver = object(value);
  if (driver.driverPhase !== "execute") return null;
  const current = object(driver.jobContinuation);
  if (!["campaigns-v9", "campaigns-v10", "campaigns-v11", "campaigns-v12", "campaigns-v13"].includes(String(current.collectorVersion || ""))) return null;
  const campaignId = clean(externalCampaignId, 220);
  if (!campaignId || !Array.isArray(current.campaigns)) return null;
  const currentIndex = Math.max(0, Math.floor(Number(current.campaignIndex) || 0));
  let matchedIndex = -1;
  for (let index = currentIndex; index < current.campaigns.length; index += 1) {
    const row = object(current.campaigns[index]);
    if (clean(row.id, 220) === campaignId) {
      matchedIndex = index;
      break;
    }
  }
  if (matchedIndex < 0) return null;
  const previousDriver = object(previousValue);
  const previous = previousDriver.driverPhase === "execute" ? object(previousDriver.jobContinuation) : {};
  return {
    ...current,
    phase: "claimers",
    campaignIndex: matchedIndex + 1,
    claimerOffset: 0,
    claimerPage: 0,
    // A proven deep boundary preserves prior truncation. Exact server no-progress
    // detection instead marks this Campaign partial so a buggy provider cannot
    // loop forever after the old page-count cap is removed.
    truncated: forceTruncated === true || previous.truncated === true,
  };
}

function campaignDirectorySegmentContinuation(value, segmentValue) {
  const driver = object(value);
  if (driver.driverPhase !== "execute") return null;
  const current = object(driver.jobContinuation);
  if (
    current.collectorVersion !== "campaigns-v13" ||
    current.phase !== "segment" ||
    current.directorySourceExhausted !== true ||
    current.campaignPagesComplete !== true ||
    current.truncated === true
  ) return null;
  const segment = object(segmentValue);
  const requestCursor = clean(segment.requestCursor, 220) || null;
  const currentCursor = clean(current.segmentCursor, 220) || null;
  if (requestCursor !== currentCursor) return null;
  const campaigns = Array.isArray(segment.campaigns)
    ? segment.campaigns.slice(0, 50).map((item) => {
      const row = object(item);
      const id = clean(row.id, 220);
      return id && typeof row.scanClaimers === "boolean" ? { id, scanClaimers: row.scanClaimers } : null;
    }).filter(Boolean)
    : [];
  const cursor = clean(segment.cursor, 220) || requestCursor;
  const totalCampaignCount = Number.isInteger(Number(segment.totalCampaignCount)) && Number(segment.totalCampaignCount) >= 0
    ? Number(segment.totalCampaignCount)
    : Number(current.totalCampaignCount || 0);
  return {
    ...current,
    phase: "claimers",
    campaigns,
    campaignIndex: 0,
    claimerOffset: 0,
    claimerPage: 0,
    segmentRequestCursor: requestCursor,
    segmentCursor: cursor,
    segmentHasMore: segment.hasMore === true,
    totalCampaignCount,
  };
}

function waitKind(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("creator execution context unavailable")) return "creator_context";
  if (text.includes("worker stopped") || text.includes("worker disabled")) return "worker_shutdown";
  return "worker_release";
}
function clearWaitProgress(value) {
  const progress = { ...object(value) };
  delete progress.waitKind;
  delete progress.waitReason;
  delete progress.waitingSince;
  delete progress.retryAt;
  return Object.keys(progress).length ? progress : null;
}
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function tokenMatches(token, expectedHash) {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function leaseDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LEASE_MS;
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(parsed)));
}

async function maybeAdvanceCreatorAnalyticsInitialSync(job, sideEffect) {
  try {
    const { advanceCreatorAnalyticsInitialSyncAfterCompletion } = require("./creator-analytics-sync-orchestrator");
    return await advanceCreatorAnalyticsInitialSyncAfterCompletion({ job, sideEffect });
  } catch (error) {
    console.warn("[creator-analytics-sync] failed to advance initial pipeline:", job?.id || null, error?.message || error);
    return null;
  }
}

function dialogDiscoveryClaimConstraint(enabled) {
  if (enabled !== true) return null;
  return {
    OR: [
      // Every non-dialog job requested by this worker remains claimable.
      { jobKey: { not: DIALOG_INTELLIGENCE_JOB_KEY } },
      // The shared dialog job key is claimable only for creator-wide discovery.
      // Per-dialog history is owned exclusively by DialogHistoryBatchRunner.
      {
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        params: { path: ["dialogId"], equals: DIALOG_DISCOVERY_DIALOG_ID },
      },
    ],
  };
}

function claimCandidateWhere({ allowedJobKeys, eligibleCreatorIds, now, dialogDiscoveryOnly, excludedJobIds = [], fanRefreshBlockedCreatorIds = [], fanRefreshGlobalBlocked = false, billingConstraint = null }) {
  const constraints = [];
  if (billingConstraint) constraints.push(billingConstraint);
  const discoveryConstraint = dialogDiscoveryClaimConstraint(dialogDiscoveryOnly);
  if (discoveryConstraint) constraints.push(discoveryConstraint);
  if (fanRefreshGlobalBlocked) constraints.push({ jobKey: { not: "fan_data_point_refresh" } });
  if (fanRefreshBlockedCreatorIds.length) {
    constraints.push({ NOT: { jobKey: "fan_data_point_refresh", creatorId: { in: fanRefreshBlockedCreatorIds } } });
  }
  return {
    status: "SCHEDULED",
    nextRunAt: { lte: now },
    attempts: { lt: MAX_ATTEMPTS },
    jobKey: { in: allowedJobKeys },
    creatorId: { in: eligibleCreatorIds },
    ...(excludedJobIds.length ? { id: { notIn: excludedJobIds } } : {}),
    ...(constraints.length ? { AND: constraints } : {}),
  };
}
function safeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = object(value);
  const out = {};
  const numericFields = [
    "percent", "current", "total", "pages", "rawMessages", "messages",
    "skippedMessages", "media", "offset", "status", "pageStart", "pageEnd",
    "pagesInBatch", "messageCount", "mediaCount", "inserted", "updated",
    "unchanged", "localUncheckpointedMessages", "scanned", "knownStreak",
  ];
  for (const field of numericFields) {
    const parsed = Number(source[field]);
    if (!Number.isFinite(parsed)) continue;
    out[field] = field === "percent"
      ? Math.max(0, Math.min(100, parsed))
      : Math.max(0, parsed);
  }
  const stringLimits = {
    message: 500,
    stage: 80,
    mode: 40,
    dialogId: 200,
    cursorType: 40,
    cursorIn: 300,
    cursor: 300,
    endpointKey: 160,
    storage: 80,
    checkpointMode: 80,
  };
  for (const [field, max] of Object.entries(stringLimits)) {
    const normalized = clean(source[field], max);
    if (normalized) out[field] = normalized;
  }
  if (source.live === true) out.live = true;
  return Object.keys(out).length ? out : null;
}

/**
 * JobInstance.continuation historically existed in two shapes: a plain
 * domain continuation and the Desktop driver envelope. Older Desktop builds
 * could repeatedly wrap an already-enveloped value after a restart:
 * execute -> execute -> execute -> domain state. Prisma/PostgreSQL eventually
 * rejects that deeply nested JSON with "recursion limit exceeded".
 *
 * Normalize iteratively (never recursively) so an existing poisoned job is
 * healed by its next progress/renewal request. The domain payload itself stays
 * transport-neutral; this boundary is also the future server-worker handoff.
 */
function normalizeLeaseContinuation(value) {
  let current = value;
  for (let depth = 0; depth < 10000; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current ?? null;
    const phase = current.driverPhase;
    if (phase === "complete") {
      return {
        driverPhase: "complete",
        result: current.result ?? null,
        progress: safeProgress(current.progress) ?? current.progress ?? null,
      };
    }
    if (phase !== "execute") return current;
    const nested = current.jobContinuation ?? null;
    if (nested && typeof nested === "object" && !Array.isArray(nested)
      && (nested.driverPhase === "execute" || nested.driverPhase === "complete")) {
      current = nested;
      continue;
    }
    return { driverPhase: "execute", jobContinuation: nested };
  }
  throw new JobLeaseError("JOB_CONTINUATION_TOO_DEEP", "Job continuation nesting is invalid", 409);
}
async function requireOwnedDevice({ userId, deviceId, db = prisma }) {
  const device = await db.workerDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) throw new JobLeaseError("NOT_YOUR_DEVICE", "Invalid device", 403);
  const member = await db.agencyMember.findFirst({
    where: { agencyId: device.agencyId, userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
  });
  if (!member) throw new JobLeaseError("DEVICE_AGENCY_ACCESS_REVOKED", "Device agency access was revoked", 403);
  return { device, member };
}
async function scopedCreatorIds({ device, member, now }) {
  if (!member) return [];
  const scope = normalizeAssignedCreators(member.assignedCreators);
  const broad = isOwner(member) || scope.mode === "all";
  const creators = await prisma.creatorAccount.findMany({
    where: {
      agencyId: device.agencyId,
      deletedAt: null,
      status: "READY",
      ...(!broad ? { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } } : {}),
    },
    select: { id: true },
    take: 10000,
  });
  const visibleIds = creators.map((item) => item.id);
  if (!visibleIds.length) return [];
  const authorityNow = now instanceof Date && Number.isFinite(now.getTime())
    ? now
    : await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const freshnessWindow = capabilityFreshnessWindow(authorityNow, 2 * 60 * 1000);
  const bindings = await prisma.deviceCreatorBinding.findMany({
    where: {
      agencyId: device.agencyId,
      deviceId: device.id,
      status: "ACTIVE",
      sessionReadReady: true,
      lastSeenAt: freshnessWindow,
      creatorId: { in: visibleIds },
    },
    select: { creatorId: true },
    take: 10000,
  });
  // A device may claim read jobs only for creators with fresh SESSION_READ
  // capability telemetry. Current member access is checked independently above.
  return bindings.map((item) => item.creatorId);
}
function notificationJobMode(params) {
  // Keep backend lease semantics identical to Desktop's scanMode(): legacy
  // notification rows without an explicit mode are FULL, never catch-up.
  return object(params).notificationMode === "catchup" ? "catchup" : "full";
}
function boundedNotificationCatchupCompletion(job, result) {
  return job?.jobKey === "catchup_notifications_scan"
    && notificationJobMode(job.params) === "catchup"
    && Number(result?.schemaVersion || 0) >= 4
    && result?.sourceExhausted === true;
}
function notificationScannerSuccessful(job, result) {
  const params = object(job?.params);
  const requested = Array.isArray(params.types)
    ? [...new Set(params.types.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]
    : ["purchases", "tips", "subscriptions", "likes", "comments"];
  const coverage = object(result?.coverage);
  return result?.sourceExhausted === true && requested.length > 0 && requested.every((type) => {
    const row = object(coverage[type]);
    return row.status === "complete" && Number(row.rejected || 0) === 0;
  });
}
async function notificationFullIsRedundant(job, db = prisma, now = new Date()) {
  if (job?.jobKey !== "catchup_notifications_scan") return false;
  const params = object(job.params);
  if (notificationJobMode(params) !== "full" || params.forceNotificationFullRebuild === true) return false;
  if (!db?.creatorNotificationSyncState?.findUnique) return false;
  const state = await db.creatorNotificationSyncState.findUnique({
    where: { creatorId: job.creatorId },
    select: { fullBackfillVerifiedAt: true },
  });
  return Boolean(trustedCollectionTimestamp(state?.fullBackfillVerifiedAt, now));
}
async function cancelRedundantNotificationFull(job, now = new Date(), db = prisma) {
  if (!(await notificationFullIsRedundant(job, db, now))) return false;
  const cancelled = await db.jobInstance.updateMany({
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
  return Number(cancelled?.count || 0) > 0;
}

async function sweepExpiredLeases(now = null, { agencyId = null, limit = 100 } = {}) {
  const scanNow = now instanceof Date && Number.isFinite(now.getTime())
    ? now : await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  const rows = await prisma.jobInstance.findMany({
    where: { status: "CLAIMED", leaseUntil: { lte: scanNow }, ...(agencyId ? { agencyId } : {}) },
    orderBy: [{ leaseUntil: "asc" }, { id: "asc" }], take: Math.max(1, Math.min(100, Number(limit) || 100)),
  });
  let changed = 0;
  for (const candidate of rows) {
    const applied = await runRootCommit(prisma, async ({ tx }) => {
      const locked = typeof tx.$queryRawUnsafe === "function"
        ? (await tx.$queryRawUnsafe('SELECT * FROM "JobInstance" WHERE "id"=$1 FOR UPDATE SKIP LOCKED', candidate.id))?.[0]
        : await tx.jobInstance.findUnique({ where: { id: candidate.id } });
      const currentNow = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
      if (!locked || locked.status !== "CLAIMED" || locked.leaseRevision !== candidate.leaseRevision
          || !locked.leaseUntil || new Date(locked.leaseUntil) > currentNow) return false;
      const job = locked;
      const attempts = Number(job.attempts || 0) + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const retryAt = terminal ? null : new Date(currentNow.getTime() + RETRY_BACKOFF_MS);
      const updated = await tx.jobInstance.updateMany({
        where: { id: job.id, status: "CLAIMED", leaseRevision: job.leaseRevision, leaseUntil: { lte: currentNow } },
        data: { status: terminal ? "FAILED" : "SCHEDULED", attempts,
          ...(terminal ? { completedAt: currentNow } : { nextRunAt: retryAt }), lastError: "lease expired",
          claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null },
      });
      if (!updated.count) return false;
      if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
        await tx.fanObservationReadLease.deleteMany({ where: { jobId: job.id, leaseRevision: job.leaseRevision } });
      }
      await recordJobFailure({ db: tx, job, error: "lease expired", terminal, retryAfterAt: retryAt });
      return true;
    }, { profile: "JOB_COMPLETION", authority: { kind: "JOB_LEASE_EXPIRY", agencyId: candidate.agencyId, creatorId: candidate.creatorId } });
    if (applied) changed += 1;
  }
  return changed;
}

async function claimJob({ userId, deviceId, leaseMs, jobKeys, excludedCreatorIds = [], dialogDiscoveryOnly = false, capabilities = {} }) {
  const { device, member } = await requireOwnedDevice({ userId, deviceId });
  const now = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  await sweepExpiredLeases(now, { agencyId: device.agencyId });
  if (!isCapabilityTimestampFresh(device.lastSeenAt, now, 5 * 60 * 1000)) return { job: null, reason: "device-stale" };
  const creatorIds = await scopedCreatorIds({ device, member, now });
  if (!creatorIds.length) return { job: null, reason: "no-creators-visible" };
  let allowedJobKeys = filterClaimableDesktopJobKeys(jobKeys);
  // Campaign causal-v1 is an explicit wire capability. A Desktop that does not
  // advertise it must never receive fetch_campaigns from a bridge-capable Backend.
  // Unknown claim fields are stripped by old Backends, so new Desktop -> old Backend
  // remains rolling-compatible until the durable activation barrier is executed.
  if (
    capabilities?.campaignCausalObservationV1 !== true ||
    capabilities?.campaignServerFanRefreshV1 !== true ||
    capabilities?.campaignResumablePaginationV1 !== true ||
    capabilities?.campaignFreshnessCoverageV1 !== true ||
    capabilities?.campaignOrderIndependentTraversalV1 !== true ||
    capabilities?.campaignSegmentedFairTraversalV1 !== true ||
    capabilities?.campaignFrontierSchedulingV1 !== true ||
    capabilities?.campaignDirectoryReuseV1 !== true
  ) {
    allowedJobKeys = allowedJobKeys.filter((jobKey) => jobKey !== "fetch_campaigns");
  }
  if (!allowedJobKeys.length) return { job: null, reason: "no-capabilities" };
  const explicitlyExcluded = new Set(
    (Array.isArray(excludedCreatorIds) ? excludedCreatorIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  // Do not globally lock a creator at the durable-job layer. Different devices
  // may prepare independent workflows (for example dialog history and the
  // Messages catalog), while writes use their own delivery worker. Physical OF
  // request starts are globally serialized by the shared request-gate service at 700ms.
  // A Desktop still sends excludedCreatorIds for lanes it cannot execute locally,
  // preventing parked leases without blocking useful work on another device.
  const eligibleCreatorIds = creatorIds.filter((creatorId) => !explicitlyExcluded.has(creatorId));
  if (!eligibleCreatorIds.length) return { job: null, reason: "creators-busy" };
  const billingConstraint = billingJobClaimWhere({
    access: await readBillingExecutionAccess({ db: prisma, agencyId: device.agencyId, creatorIds: eligibleCreatorIds }),
    recoveryCapable: capabilities?.billingRecoveryLeaseV1 === true,
  });
  const capacityBlockedIds = [];
  const fanRefreshBlockedCreatorIds = [];
  let fanRefreshGlobalBlocked = false;
  for (let race = 0; race < 20; race += 1) {
    const candidateWhere = claimCandidateWhere({
      allowedJobKeys,
      eligibleCreatorIds,
      now,
      dialogDiscoveryOnly,
      excludedJobIds: capacityBlockedIds,
      fanRefreshBlockedCreatorIds,
      fanRefreshGlobalBlocked,
      billingConstraint,
    });
    const candidate = await prisma.jobInstance.findFirst({
      where: candidateWhere,
      orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }],
    });
    if (!candidate) return { job: null, reason: "no-work" };
    // Last-chance fence: an old FULL can remain queued while another run has
    // already established the historical baseline. Re-check at claim time so
    // a stale row can never wake up hours later and replay the whole history.
    if (await cancelRedundantNotificationFull(candidate, now)) continue;
    const leaseToken = crypto.randomBytes(32).toString("base64url");
    const until = new Date(now.getTime() + leaseDuration(leaseMs));
    const reuseContinuation = String(candidate.jobKey || "") === "fetch_campaigns" && candidate.continuation == null
      ? campaignDirectoryReuseInitialContinuation(candidate.params)
      : null;
    const claimData = {
      status: "CLAIMED", claimedAt: now, claimedByDeviceId: device.id, leaseUntil: until,
      leaseTokenHash: hashToken(leaseToken), leaseRevision: { increment: 1 }, leaseMemberId: member.id, leaseAccessEpoch: Number(member.accessEpoch || 1), startedAt: candidate.startedAt || now, lastError: null,
      progress: clearWaitProgress(candidate.progress),
      ...(FAN_OBSERVATION_READ_LEASE_JOB_KEYS.has(String(candidate.jobKey || "")) ? {
        params: {
          ...(String(candidate.jobKey || "") === "fetch_campaigns" ? campaignClaimParams(candidate.params) : object(candidate.params)),
          observationTokenVersion: 1,
          observationReadLeaseVersion: 1,
          ...(String(candidate.jobKey || "") === "fetch_campaigns" ? { campaignResumablePaginationVersion: 1, campaignFreshnessCoverageVersion: 1, campaignOrderIndependentTraversalVersion: 1, campaignSegmentedFairTraversalVersion: 1, campaignFrontierSchedulingVersion: 1, campaignDirectoryReuseVersion: 1 } : {}),
        },
      } : {}),
      ...(reuseContinuation ? { continuation: reuseContinuation } : {}),
    };
    const claimWork = async (db) => {
      await assertExecutionAccessFence({ db, userId, agencyId: device.agencyId, memberId: member.id,
        accessEpoch: Number(member.accessEpoch || 1), creatorId: candidate.creatorId, lock: true });
      await assertJobBillingAccess({ db, job: candidate, recoveryCapable: capabilities?.billingRecoveryLeaseV1 === true });
      if (String(candidate.jobKey || "") === "fetch_campaigns") {
        await enterCampaignClaimGeneration({ db });
        if (campaignDirectoryDiscoveryJob(candidate.params) && !(await campaignDirectoryDiscoveryClaimAvailable(db, candidate.params))) {
          return { __campaignDirectoryCapacityBlocked: true };
        }
      }
      if (String(candidate.jobKey || "") === "fan_data_point_refresh") {
        const admission = await fanDataRefreshClaimAvailable(db, candidate.creatorId);
        if (!admission.available) return { __fanDataRefreshCapacityBlocked: true, ...admission };
      }
      if (typeof db.$queryRawUnsafe === "function") {
        const locked = (await db.$queryRawUnsafe('SELECT * FROM "JobInstance" WHERE "id"=$1 FOR UPDATE', candidate.id))?.[0];
        // Admission and claim data were derived from the observed candidate.
        // If a planner/previous owner changed it while locks were pending,
        // start discovery again, including the appropriate capacity checks.
        const observedFields = ["agencyId", "creatorId", "jobKey", "leaseRevision", "params", "progress", "continuation", "startedAt"];
        if (!locked || observedFields.some(key => !isDeepStrictEqual(locked[key], candidate[key]))) return null;
      }
      // Capacity/job locks can outlive the time read during request admission.
      // Recheck paid access and telemetry and construct a full lease only now.
      const billing = await assertJobBillingAccess({ db, job: candidate, recoveryCapable: capabilities?.billingRecoveryLeaseV1 === true });
      const claimNow = billing.now;
      const currentDevice = await db.workerDevice.findUnique({ where: { id: deviceId } });
      if (!currentDevice || currentDevice.userId !== userId || currentDevice.agencyId !== device.agencyId
          || !isCapabilityTimestampFresh(currentDevice.lastSeenAt, claimNow, 5 * 60 * 1000)) return null;
      const readyBindings = await db.deviceCreatorBinding.findMany({
        where: { agencyId: device.agencyId, deviceId, creatorId: candidate.creatorId, status: "ACTIVE", sessionReadReady: true,
          lastSeenAt: capabilityFreshnessWindow(claimNow, 2 * 60 * 1000) }, select: { creatorId: true }, take: 1,
      });
      if (!readyBindings.length) return null;
      const attemptClaimData = { ...claimData, claimedAt: claimNow,
        leaseUntil: new Date(claimNow.getTime() + leaseDuration(leaseMs)), startedAt: candidate.startedAt || claimNow };
      const updated = await db.jobInstance.updateMany({
        where: {
          id: candidate.id,
          ...claimCandidateWhere({
            allowedJobKeys,
            eligibleCreatorIds,
            now: claimNow,
            dialogDiscoveryOnly,
            excludedJobIds: capacityBlockedIds,
            fanRefreshBlockedCreatorIds,
            fanRefreshGlobalBlocked,
            billingConstraint,
          }),
        },
        data: attemptClaimData,
      });
      if (!updated.count) return null;
      return db.jobInstance.findUnique({
        where: { id: candidate.id },
        include: { creator: { select: { id: true, remoteId: true, username: true, displayName: true } } },
      });
    };
    let claimed = null;
    try {
      claimed = await runRootCommit(prisma, ({ tx }) => claimWork(tx), {
        profile: "JOB_CHUNK", authority: { kind: "JOB_CLAIM", agencyId: device.agencyId, creatorId: candidate.creatorId, userId },
        conflictCode: "JOB_LEASE_CONFLICT",
      });
    } catch (error) {
      if (error?.code === "JOB_LEASE_CONFLICT") throw new JobLeaseError(error.code, error.message, 409);
      if (error instanceof BillingExecutionAccessError) {
        if (error.status >= 500) throw error;
        capacityBlockedIds.push(candidate.id);
        continue;
      }
      if (String(candidate.jobKey || "") === "fetch_campaigns"
          && /CAMPAIGN_CLAIM_GENERATION_RETIRED/.test(String(error?.message || ""))) {
        continue;
      }
      throw error;
    }
    if (claimed?.__campaignDirectoryCapacityBlocked === true) {
      capacityBlockedIds.push(candidate.id);
      continue;
    }
    if (claimed?.__fanDataRefreshCapacityBlocked === true) {
      if (claimed.globalFull) fanRefreshGlobalBlocked = true;
      else if (!fanRefreshBlockedCreatorIds.includes(String(candidate.creatorId))) fanRefreshBlockedCreatorIds.push(String(candidate.creatorId));
      continue;
    }
    if (!claimed) continue;
    return {
      job: {
        id: claimed.id, jobKey: claimed.jobKey, scope: claimed.scope, creatorId: claimed.creatorId, agencyId: claimed.agencyId,
        idempotencyKey: claimed.idempotencyKey, params: claimed.params || {}, priority: claimed.priority, creator: claimed.creator || null,
        attempt: claimed.attempts + 1, leaseUntil: claimed.leaseUntil, leaseToken, leaseRevision: claimed.leaseRevision,
        leaseAccessEpoch: claimed.leaseAccessEpoch,
        workId: claimed.workId, continuation: normalizeLeaseContinuation(claimed.continuation), progress: claimed.progress,
      },
      reason: "claimed",
    };
  }
  return { job: null, reason: capacityBlockedIds.length ? "campaign-directory-capacity" : (fanRefreshGlobalBlocked || fanRefreshBlockedCreatorIds.length ? "fan-data-refresh-capacity" : "race-lost") };
}
async function requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, allowExpired = false, db = prisma, lock = false }) {
  const { device } = await requireOwnedDevice({ userId, deviceId, db });
  let job = await db.jobInstance.findUnique({ where: { id: jobId } });
  if (!job) throw new JobLeaseError("JOB_NOT_FOUND", "Job not found", 404);
  if (job.agencyId && job.agencyId !== device.agencyId) throw new JobLeaseError("JOB_DEVICE_AGENCY_MISMATCH", "Job belongs to a different device agency", 403);
  try {
    await assertExecutionAccessFence({ db, userId, agencyId: device.agencyId,
      memberId: job.leaseMemberId, accessEpoch: job.leaseAccessEpoch, creatorId: job.creatorId, lock });
  } catch (error) {
    if (error instanceof ExecutionAccessFenceError) throw new JobLeaseError(error.code, error.message, error.status);
    throw error;
  }
  // Authority/member lock precedes the JobInstance lock. Reading time before
  // either wait would allow an already-expired lease to pass the mutation CAS.
  if (lock && typeof db.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe('SELECT * FROM "JobInstance" WHERE "id"=$1 FOR UPDATE', jobId);
    job = rows?.[0];
    if (!job) throw new JobLeaseError("JOB_NOT_FOUND", "Job not found", 404);
  }
  const now = await dbAuthorityNow({ db, fallbackNow: new Date() });
  if (job.status !== "CLAIMED") throw new JobLeaseError("JOB_NOT_CLAIMED", `Job status is ${job.status}`);
  if (job.claimedByDeviceId !== deviceId) throw new JobLeaseError("JOB_CLAIMED_BY_OTHER", "Job is claimed by a different device");
  if (!tokenMatches(leaseToken, job.leaseTokenHash)) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease token is stale");
  if (!Number.isInteger(leaseRevision) || job.leaseRevision !== leaseRevision) throw new JobLeaseError("JOB_LEASE_REVISION_STALE", "Job lease revision is stale");
  if (!allowExpired && (!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime())) throw new JobLeaseError("JOB_LEASE_EXPIRED", "Job lease expired");
  // Normalize in memory before any lease/result service consumes this job. This
  // protects side effects from legacy execute->execute nesting even before the
  // next durable checkpoint rewrites the database row in canonical form.
  job.continuation = normalizeLeaseContinuation(job.continuation);
  return job;
}

async function leaseCommit(input, work, { profile = "JOB_CHUNK", allowExpired = false } = {}) {
  try {
    return await runRootCommit(prisma, async ({ tx }) => {
      const job = await requireLease({ ...input, db: tx, lock: true, allowExpired });
      const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
      return work(tx, { job, now });
    }, { profile, authority: { kind: "JOB_LEASE", userId: input.userId }, conflictCode: "JOB_LEASE_CONFLICT" });
  } catch (error) {
    if (error?.code === "JOB_LEASE_CONFLICT") throw new JobLeaseError(error.code, error.message, 409);
    throw error;
  }
}
function observationReadPurpose(job, requestedPurpose) {
  const allowed = FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY[String(job?.jobKey || "")] || null;
  const requested = clean(requestedPurpose, 120);
  if (!Array.isArray(allowed) || !requested || !allowed.includes(requested)) {
    throw new JobLeaseError("FAN_OBSERVATION_READ_LEASE_PURPOSE_FORBIDDEN", "Job is not allowed to acquire this observation read lease", 403);
  }
  return requested;
}

function readLeaseError(error) {
  if (error instanceof FanObservationReadLeaseError) {
    const wrapped = new JobLeaseError(error.code, error.message, error.status);
    if (Number.isFinite(Number(error.retryAfterMs))) wrapped.retryAfterMs = Number(error.retryAfterMs);
    return wrapped;
  }
  return error;
}

async function acquireJobFanObservationReadLease({ jobId, userId, deviceId, leaseToken, leaseRevision, purpose, requestId }) {
  return leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job, now }) => {
  if (Number(job?.params?.observationReadLeaseVersion || 0) < 1) {
    throw new JobLeaseError("FAN_OBSERVATION_READ_LEASE_NOT_REQUIRED", "Job does not use the cross-device observation read lease", 409);
  }
  const normalizedPurpose = observationReadPurpose(job, purpose);
    try {
      await assertExecutionAccessFence({
        db: tx, userId, agencyId: job.agencyId, memberId: job.leaseMemberId,
        accessEpoch: job.leaseAccessEpoch, creatorId: job.creatorId, lock: true,
      });
      const current = await tx.jobInstance.findFirst({
        where: {
          id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken),
          leaseRevision, leaseUntil: { gt: now },
        },
        select: { id: true },
      });
      if (!current) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before observation read acquisition", 409);
      const acquired = await acquireCreatorObservationReadLease({
        db: tx, jobId: job.id, agencyId: job.agencyId, creatorId: job.creatorId, deviceId, leaseRevision,
        purpose: normalizedPurpose, requestId,
      });
      await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, db: tx, lock: true });
      return acquired;
    } catch (error) {
      if (error instanceof ExecutionAccessFenceError) throw new JobLeaseError(error.code, error.message, error.status);
      throw readLeaseError(error);
    }
  });
}

async function releaseJobObservationReadLease({ jobId, userId, deviceId, leaseToken, leaseRevision, readLeaseToken }) {
  return leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job }) => {
    try { return await releaseJobFanObservationReadLease({ db: tx, job, deviceId, leaseRevision, readLeaseToken }); }
    catch (error) { throw readLeaseError(error); }
  }, { allowExpired: true });
}

async function issueFanObservationToken({ jobId, userId, deviceId, leaseToken, leaseRevision, purpose, subjects, readLeaseToken = null }) {
  return leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job, now }) => {
    try {
      await assertExecutionAccessFence({
        db: tx, userId, agencyId: job.agencyId, memberId: job.leaseMemberId,
        accessEpoch: job.leaseAccessEpoch, creatorId: job.creatorId, lock: true,
      });
    } catch (error) {
      if (error instanceof ExecutionAccessFenceError) throw new JobLeaseError(error.code, error.message, error.status);
      throw error;
    }
    const readLeaseRequired = Number(job?.params?.observationReadLeaseVersion || 0) >= 1;
    if (readLeaseRequired) {
      const current = await tx.jobInstance.findFirst({
        where: {
          id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken),
          leaseRevision, leaseUntil: { gt: now },
        },
        select: { id: true },
      });
      if (!current) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before observation read completion", 409);
    }
    if (readLeaseRequired) {
      const normalizedPurpose = observationReadPurpose(job, purpose);
      if (!clean(readLeaseToken, 500)) {
        throw new JobLeaseError("FAN_OBSERVATION_READ_LEASE_REQUIRED", "Observation token requires the active cross-device read lease", 409);
      }
      try {
        const issued = await completeJobFanObservationReadLease({
          db: tx, job, deviceId, leaseRevision, readLeaseToken, purpose: normalizedPurpose, subjects,
        });
        await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, db: tx, lock: true });
        return issued;
      } catch (error) { throw readLeaseError(error); }
    }
    const issued = await createFanObservationToken({ db: tx, job, deviceId, leaseRevision, purpose, subjects });
    await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, db: tx, lock: true });
    return issued;
  });
}

async function renewLease({ jobId, userId, deviceId, leaseToken, leaseRevision, leaseMs, workId, progress, continuation }) {
  const outcome = await leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job, now }) => {
  const tokenHash = hashToken(leaseToken);
  const data = {
    leaseUntil: new Date(now.getTime() + leaseDuration(leaseMs)),
  };
  if (workId !== undefined) data.workId = clean(workId, 200) || job.workId;
  const normalizedProgress = safeProgress(progress);
  if (normalizedProgress) data.progress = normalizedProgress;
  if (continuation !== undefined) data.continuation = normalizeLeaseContinuation(continuation);
  if (normalizedProgress || continuation !== undefined) data.lastProgressAt = now;

    // Also fence a FULL that became redundant *after* it was claimed. The
    // access fence and redundant-cancel mutation must share this transaction;
    // otherwise a revoke could land between the continuation check and write.
    if (await cancelRedundantNotificationFull(job, now, tx)) return { superseded: true };
    // A pure keepalive updates only leaseUntil. Rewriting unchanged poisoned
    // legacy JSON on every heartbeat was intentionally removed earlier.
    const result = await tx.jobInstance.updateMany({
      where: { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: tokenHash, leaseRevision, leaseUntil: { gt: now } },
      data,
    });
    if (!result.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before renewal");
    // A causal read can legitimately outlive one OF request because the global
    // request gate and safe-read retries are bounded independently. The normal
    // 60s job keepalive extends the durable creator fence while this exact job
    // lease/revision remains alive, preventing TTL expiry from reopening a
    // cross-device causal race mid-read.
    if (typeof tx.fanObservationReadLease?.updateMany === "function") {
      await tx.fanObservationReadLease.updateMany({
        where: { jobId: job.id, deviceId, leaseRevision },
        data: { expiresAt: new Date(now.getTime() + FAN_OBSERVATION_READ_LEASE_TTL_MS) },
      });
    }
    const updated = await tx.jobInstance.findUnique({ where: { id: job.id } });
    return { superseded: false, updated };
  });

  if (outcome.superseded) throw new JobLeaseError("JOB_SUPERSEDED", "Notification full scan was superseded by existing history", 409);
  const updated = outcome.updated;
  return {
    id: updated.id,
    status: updated.status,
    leaseUntil: updated.leaseUntil,
    leaseRevision: updated.leaseRevision,
    progress: updated.progress,
    continuation: normalizeLeaseContinuation(updated.continuation),
  };
}
async function progressJob({ jobId, userId, deviceId, leaseToken, leaseRevision, leaseMs, workId, progress, continuation, chunkResult }) {
  return leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job, now }) => {
  const tokenHash = hashToken(leaseToken);
  const nextLeaseUntil = new Date(now.getTime() + leaseDuration(leaseMs));
  const normalizedProgress = safeProgress(progress) ?? job.progress;
  const requestedContinuation = continuation === undefined
    ? job.continuation
    : normalizeLeaseContinuation(continuation);

    const updatedFence = await tx.jobInstance.updateMany({
      where: {
        id: job.id,
        status: "CLAIMED",
        claimedByDeviceId: deviceId,
        leaseTokenHash: tokenHash,
        leaseRevision,
        leaseUntil: { gt: now },
      },
      data: {
        leaseUntil: nextLeaseUntil,
        workId: clean(workId, 200) || job.workId,
        progress: normalizedProgress,
        continuation: requestedContinuation,
        lastProgressAt: now,
      },
    });
    if (!updatedFence.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before progress");

    const sideEffect = await applyJobChunk({ db: tx, job, deviceId, userId, chunkResult });
    if (chunkResult != null) await publishNotificationConsequences({ db: tx, job });
    const campaignBoundaryOverride = sideEffect?.serverDeepBoundaryReached === true
      ? campaignServerBoundaryContinuation(requestedContinuation, sideEffect.externalCampaignId, job.continuation)
      : sideEffect?.serverNoProgressDetected === true
        ? campaignServerBoundaryContinuation(requestedContinuation, sideEffect.externalCampaignId, job.continuation, { forceTruncated: true })
        : null;
    const campaignSegmentOverride = sideEffect?.campaignDirectorySegment
      ? campaignDirectorySegmentContinuation(requestedContinuation, sideEffect.campaignDirectorySegment)
      : null;
    if (sideEffect?.campaignDirectorySegment && !campaignSegmentOverride) {
      throw new JobLeaseError("CAMPAIGN_SEGMENT_CONTINUATION_INVALID", "Campaign directory segment could not be bound to requested continuation", 409);
    }
    let updated = null;
    if (sideEffect?.completeAfterCommit === true) {
      updated = await tx.jobInstance.update({
        where: { id: job.id },
        data: {
          continuation: {
            driverPhase: "complete",
            result: sideEffect.completionResult || {},
            progress: normalizedProgress,
          },
        },
      });
    } else if (campaignBoundaryOverride || campaignSegmentOverride || sideEffect?.jobContinuationOverride) {
      updated = await tx.jobInstance.update({
        where: { id: job.id },
        data: {
          continuation: {
            driverPhase: "execute",
            jobContinuation: campaignBoundaryOverride || campaignSegmentOverride || sideEffect.jobContinuationOverride,
          },
        },
      });
    }

    // update() already returns the row. Avoid a final findUnique round-trip on
    // every checkpoint; hosted Postgres latency made that redundant read part
    // of the 5-second Prisma transaction timeout failure.
    if (!updated) {
      updated = {
        id: job.id,
        status: job.status,
        leaseUntil: nextLeaseUntil,
        leaseRevision: job.leaseRevision,
        progress: normalizedProgress,
        continuation: requestedContinuation,
      };
    }
    return {
      id: updated.id,
      status: updated.status,
      leaseUntil: updated.leaseUntil,
      leaseRevision: updated.leaseRevision,
      progress: updated.progress,
      continuation: updated.continuation,
      sideEffect,
    };
  });
}

async function completeJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, result, progress }) {
  let now = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });
  let job = await requireLease({ jobId, userId, deviceId, leaseToken, leaseRevision, now });
  let fenceWhere = {
    id: job.id,
    status: "CLAIMED",
    claimedByDeviceId: deviceId,
    leaseTokenHash: hashToken(leaseToken),
    leaseRevision,
    leaseUntil: { gt: now },
  };
  let completionData = {
    status: "DONE",
    completedAt: now,
    leaseUntil: null,
    leaseTokenHash: null,
    workId: clean(workId, 200) || job.workId,
    continuation: null,
    progress: safeProgress(progress) || { percent: 100, message: "completed" },
    lastProgressAt: now,
    result: result || null,
    lastError: null,
  };

  // Each durable phase re-reads authority and locks the exact current tuple.
  // Large domain publication stays outside these short retryable commits.
  const phaseCommit = (work, { reserved = false, profile = "JOB_COMPLETION" } = {}) => leaseCommit({
    jobId, userId, deviceId, leaseToken, leaseRevision: reserved ? leaseRevision + 1 : leaseRevision,
  }, async (tx, current) => {
    job = current.job;
    now = current.now;
    fenceWhere = { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId,
      leaseTokenHash: hashToken(leaseToken), leaseRevision, leaseUntil: { gt: now } };
    completionData = { ...completionData, completedAt: now, lastProgressAt: now };
    return work(tx);
  }, { profile });

  // Jobs whose completion mutates durable projections must fence the lease
  // before applying those mutations. Otherwise a reclaimed worker could write
  // a stale snapshot after another device has already taken ownership.
  if (job.jobKey === "dialog_intelligence_scan") {
    return phaseCommit(async (tx) => {
      const { sideEffect } = await completeDialogJobFenced({
        tx,
        fenceWhere,
        completionData,
        staleError: () => new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion"),
        applySideEffect: (db) => applyJobResult({ db, job, deviceId, userId, result: result || {} }),
      });
      return { job: { id: job.id, status: "DONE" }, sideEffect };
    }, { reserved: false, profile: "JOB_COMPLETION" });
  }

  if (job.jobKey === "subscriber_directory_scan") {
    // Subscriber publication is a durable multi-transaction state machine.
    // Reserve completion ownership in a short fenced transaction, then run the
    // publication on the root Prisma client so every 500-row phase commits
    // independently. Crash/retry resumes from SubscriberScanRun publication
    // phase+cursor instead of replaying one O(all subscribers) transaction.
    const completionLeaseRevision = leaseRevision + 1;
    await phaseCommit(async (tx) => {
      try {
        await assertExecutionAccessFence({
          db: tx, userId, agencyId: job.agencyId, memberId: job.leaseMemberId,
          accessEpoch: job.leaseAccessEpoch, creatorId: job.creatorId, lock: true,
        });
      } catch (error) {
        if (error instanceof ExecutionAccessFenceError) throw new JobLeaseError(error.code, error.message, error.status);
        throw error;
      }
      const reserved = await tx.jobInstance.updateMany({
        where: fenceWhere,
        data: { leaseRevision: { increment: 1 }, leaseUntil: new Date(now.getTime() + MAX_LEASE_MS), lastProgressAt: now },
      });
      if (!reserved.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before subscriber completion reservation");
    }, { reserved: false, profile: "JOB_CHUNK" });

    let sideEffect;
    try {
      sideEffect = await applyJobResult({ db: prisma, job, deviceId, userId, result: result || {} });
    } catch (error) {
      // Keep the reserved job reclaimable. Publication progress itself is
      // durable; shortening the lease avoids pinning a failed request for the
      // full 15-minute reservation window while still fencing this attempt.
      await phaseCommit(async (tx) => tx.jobInstance.updateMany({
        where: {
          id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken),
          leaseRevision: completionLeaseRevision,
        },
        data: { leaseUntil: new Date(now.getTime() + MIN_LEASE_MS), lastError: clean(error?.message || error, 2000) || "subscriber_publication_failed" },
      }), { reserved: true }).catch(() => null);
      throw error;
    }

    const completionFence = {
      id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken),
      leaseRevision: completionLeaseRevision,
    };
    const completed = await phaseCommit(async (tx) => {
      const updated = await tx.jobInstance.updateMany({ where: completionFence, data: completionData });
      if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Subscriber completion reservation was lost");
      if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
        await tx.fanObservationReadLease.deleteMany({
          where: { jobId: job.id, deviceId, leaseRevision },
        });
      }
      const scanRunId = clean(job.params?.scanRunId, 120);
      if (!scanRunId) throw new JobLeaseError("SUBSCRIBER_SCAN_RUN_MISSING", "Subscriber completion is missing scanRunId");
      const reconciledRun = await tx.subscriberScanRun.updateMany({
        where: {
          id: scanRunId,
          publicationStatus: "COMPLETE",
          status: { in: ["PUBLISHED", "SUPERSEDED"] },
        },
        data: { publicationJobReconciledAt: now, publicationLastError: null },
      });
      if (!reconciledRun.count) throw new JobLeaseError("SUBSCRIBER_PUBLICATION_RECONCILE_MISSING", "Published Subscriber run was not available for atomic job reconciliation");
      return updated;
    }, { reserved: true, profile: "JOB_CHUNK" });
    if (!completed.count) throw new JobLeaseError("JOB_LEASE_STALE", "Subscriber completion fence was lost");
    return { job: { id: job.id, status: "DONE" }, sideEffect };
  }

  if (["fetch_earnings", "fetch_campaigns", "financial_transactions_scan"].includes(job.jobKey)) {
    // These jobs write durable relational projections. Reserve completion
    // ownership before any side effect so a reclaimed worker cannot publish a
    // stale earnings/campaign snapshot after another device takes the lease.
    const completionLeaseRevision = leaseRevision + 1;
    const reserved = await phaseCommit(async (tx) => tx.jobInstance.updateMany({
      where: fenceWhere,
      data: {
        leaseRevision: { increment: 1 },
        leaseUntil: new Date(now.getTime() + MAX_LEASE_MS),
        lastProgressAt: now,
      },
    }), { reserved: false });
    if (!reserved.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before analytics completion");

    const sideEffect = await applyJobResult({ job, deviceId, userId, result: result || {} });
    const completionFence = {
      id: job.id,
      status: "CLAIMED",
      claimedByDeviceId: deviceId,
      leaseTokenHash: hashToken(leaseToken),
      leaseRevision: completionLeaseRevision,
    };
    if (sideEffect?.ok !== true) {
      const campaignProtocolSuperseded =
        job.jobKey === "fetch_campaigns" &&
        sideEffect?.type === "campaigns" &&
        sideEffect?.completion?.protocolCurrent === false;
      if (campaignProtocolSuperseded) {
        const retryAt = new Date(now.getTime() + 1_000);
        const superseded = await phaseCommit(async (tx) => tx.jobInstance.updateMany({
          where: completionFence,
          data: {
            status: "SCHEDULED",
            nextRunAt: retryAt,
            completedAt: null,
            claimedAt: null,
            claimedByDeviceId: null,
            leaseUntil: null,
            leaseTokenHash: null,
            continuation: null,
            workId: null,
            result: { ...(result || {}), completionSideEffect: sideEffect || null },
            lastError: "fetch_campaigns_protocol_superseded",
            progress: { percent: 0, message: "fetch_campaigns protocol upgraded; scheduled for current collector" },
          },
        }), { reserved: true });
        if (!superseded.count) throw new JobLeaseError("JOB_LEASE_STALE", "Campaign protocol supersession fence was lost");
        return { job: { id: job.id, status: "SCHEDULED", retryAt }, sideEffect, protocolSuperseded: true };
      }
      const attempts = Number(job.attempts || 0) + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const retryAt = terminal ? null : new Date(now.getTime() + RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1)));
      const partial = await phaseCommit(async (tx) => {
        const updated = await tx.jobInstance.updateMany({
          where: completionFence,
          data: terminal ? {
            status: "FAILED",
            attempts,
            completedAt: now,
            claimedAt: null,
            claimedByDeviceId: null,
            leaseUntil: null,
            leaseTokenHash: null,
            continuation: null,
            workId: null,
            result: { ...(result || {}), completionSideEffect: sideEffect || null },
            lastError: `${job.jobKey}_partial`,
          } : {
            status: "SCHEDULED",
            attempts,
            nextRunAt: retryAt,
            completedAt: null,
            claimedAt: null,
            claimedByDeviceId: null,
            leaseUntil: null,
            leaseTokenHash: null,
            continuation: null,
            workId: null,
            result: { ...(result || {}), completionSideEffect: sideEffect || null },
            lastError: `${job.jobKey}_partial`,
            progress: { percent: 0, message: `${job.jobKey} scheduled for repair` },
          },
        });
        if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Analytics partial-completion fence was lost");
        // Durable collector state must carry the exact same retry/quarantine
        // decision as JobInstance. Otherwise terminal technical history can be
        // cleaned while the planner immediately emits a fresh generation.
        await recordJobFailure({
          db: tx, job, error: `${job.jobKey}_partial`, terminal, retryAfterAt: retryAt,
        });
        return updated;
      }, { reserved: true, profile: "JOB_COMPLETION" });
      return { job: { id: job.id, status: terminal ? "FAILED" : "SCHEDULED", retryAt }, sideEffect };
    }
    const completed = await phaseCommit(async (tx) => tx.jobInstance.updateMany({ where: completionFence, data: completionData }), { reserved: true });
    if (!completed.count) throw new JobLeaseError("JOB_LEASE_STALE", "Analytics completion fence was lost");
    await maybeAdvanceCreatorAnalyticsInitialSync(job, sideEffect);
    return { job: { id: job.id, status: "DONE" }, sideEffect };
  }

  if (job.jobKey === "catchup_notifications_scan") {
    // Bounded HEAD catch-up pages are already atomically committed by /progress.
    // Do not keep the JobInstance CLAIMED while legacy compatibility/read-cache
    // projection runs: if that long response is lost, an expired lease can make
    // the same HEAD page appear to restart. First commit the durable terminal job
    // state + catch-up frontier in one short transaction, then project compatibility
    // through durable paged work after the job is DONE. Atomic notification facts remain
    // the source of truth; compatibility/cache work must never hold the scan lease.
    if (boundedNotificationCatchupCompletion(job, result)) {
      const fast = await phaseCommit(async (tx) => {
        // Page receipts and the job tuple share this commit boundary. A parallel
        // progress request cannot change the proof between verification and DONE.
        const pageProof = notificationScannerSuccessful(job, result)
          ? await notificationCommittedPageProof(tx, job, result)
          : { verified: false, reason: "scanner_report_partial" };
        const successful = pageProof.verified === true;
        const attempts = Number(job.attempts || 0) + (successful ? 0 : 1);
        const terminal = !successful && attempts >= MAX_ATTEMPTS;
        const retryAt = successful || terminal ? null
          : new Date(now.getTime() + RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1)));
        const status = successful ? "DONE" : terminal ? "FAILED" : "SCHEDULED";
        const failureData = {
          status, attempts, completedAt: terminal ? now : null,
          ...(retryAt ? { nextRunAt: retryAt, progress: { percent: 0, message: "notification catch-up scheduled for repair" } } : {}),
          claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, continuation: null, workId: null,
          result: { ...(result || {}), completionSideEffect: { verified: false, sourceTraversalComplete: true } },
          lastError: "notification_scan_partial",
        };
        const updated = await tx.jobInstance.updateMany({ where: fenceWhere, data: successful ? completionData : failureData });
        if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before bounded notification completion");
        const syncState = await completeNotificationSync({ db: tx, job, deviceId, result: result || {}, successful });
        if (!successful) await recordJobFailure({ db: tx, job, error: "notification_scan_partial", terminal, retryAfterAt: retryAt });
        await publishNotificationConsequences({ db: tx, job });
        return { status, retryAt, sideEffect: {
          type: "catchup_notifications", ok: successful, verified: successful, sourceTraversalComplete: true,
          compatibilityDeferred: successful, pageProof, syncStateId: syncState?.id || null,
        } };
      });
      return { job: { id: job.id, status: fast.status, retryAt: fast.retryAt }, sideEffect: fast.sideEffect };
    }

    // Full scans share the durable consequence lane. Final canonical proof,
    // SyncState, retry/manual outcome and intent commit atomically; no full
    // receipt history traversal or automation execution inside this command.
    const completed = await phaseCommit(async (tx) => {
      const sideEffect = await applyJobResult({ db: tx, job, deviceId, userId, result: result || {} });
      const successful = sideEffect?.ok === true;
      const manualPartial = !successful && job.params?.manualNotificationScan === true
        && sideEffect?.sourceTraversalComplete === true;
      const attempts = Number(job.attempts || 0) + (successful || manualPartial ? 0 : 1);
      const terminal = !successful && !manualPartial && attempts >= MAX_ATTEMPTS;
      const retryAt = successful || manualPartial || terminal ? null
        : new Date(now.getTime() + RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1)));
      const status = successful || manualPartial ? "DONE" : terminal ? "FAILED" : "SCHEDULED";
      const repairParams = { ...object(job.params) };
      const requestedTypes = sideEffect?.summary?.requestedTypes || repairParams.types || [];
      const partialTypes = requestedTypes.filter(type => sideEffect?.summary?.collectionCoverageByType?.[type] !== "complete");
      if (partialTypes.length) repairParams.types = partialTypes;
      delete repairParams.resumeCursors;
      delete repairParams.notificationRepairPass;
      const data = successful ? completionData : {
        status, attempts, params: repairParams, completedAt: status === "SCHEDULED" ? null : now,
        ...(retryAt ? { nextRunAt: retryAt } : {}),
        claimedAt: null, claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null,
        continuation: null, workId: null,
        progress: manualPartial ? { percent: 100, message: "notification scan completed with rejected facts" }
          : { percent: 0, message: "notification scan scheduled for repair" },
        lastError: "notification_scan_partial",
      };
      data.result = { ...(result || {}), completionSideEffect: sideEffect };
      const updated = await tx.jobInstance.updateMany({ where: fenceWhere, data });
      if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Notification completion fence was lost");
      if (!successful && !manualPartial) await recordJobFailure({ db: tx, job,
        error: "notification_scan_partial", terminal, retryAfterAt: retryAt });
      return { job: { id: job.id, status, retryAt }, sideEffect };
    });
    if (completed.sideEffect?.ok) await maybeAdvanceCreatorAnalyticsInitialSync(job, completed.sideEffect);
    return completed;
  }

  if (job.jobKey === "vault_unsorted_scan") {
    const completed = await phaseCommit(async (tx) => {
      const updated = await tx.jobInstance.updateMany({ where: fenceWhere, data: completionData });
      if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion");
      const sideEffect = await applyJobResult({ db: tx, job, deviceId, userId, result: result || {} });
      return { job: { id: job.id, status: "DONE" }, sideEffect };
    }, { reserved: false, profile: "JOB_COMPLETION" });
    // Dialog history is realtime-first. Completing the daily media catalog must
    // not automatically start a creator-wide dialog discovery anymore. A dialog
    // recovery plan is scheduled only by the long-offline coverage detector or
    // by an explicit operator action.
    return completed;
  }

  const completed = await phaseCommit(async (tx) => {
    try {
      await assertExecutionAccessFence({
        db: tx, userId, agencyId: job.agencyId, memberId: job.leaseMemberId,
        accessEpoch: job.leaseAccessEpoch, creatorId: job.creatorId, lock: true,
      });
    } catch (error) {
      if (error instanceof ExecutionAccessFenceError) throw new JobLeaseError(error.code, error.message, error.status);
      throw error;
    }
    const reserved = await tx.jobInstance.updateMany({
      where: fenceWhere,
      data: { leaseRevision: { increment: 1 }, leaseUntil: new Date(now.getTime() + MAX_LEASE_MS), lastProgressAt: now },
    });
    if (!reserved.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before completion reservation");
    const sideEffect = await applyJobResult({ db: tx, job, deviceId, userId, result: result || {} });
    const updated = await tx.jobInstance.updateMany({
      where: {
        id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken),
        leaseRevision: leaseRevision + 1,
      },
      data: completionData,
    });
    if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job completion reservation was lost");
    return sideEffect;
  }, { reserved: false, profile: "JOB_COMPLETION" });
  await maybeAdvanceCreatorAnalyticsInitialSync(job, completed);
  return { job: { id: job.id, status: "DONE" }, sideEffect: completed };
}
async function failJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, error, result, retryable = true }) {
  const outcome = await leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job, now }) => {
  const errorText = clean(error, 2000) || "unknown error";
  const attempts = job.attempts + 1;
  const terminal = retryable === false || attempts >= MAX_ATTEMPTS;
  const data = terminal ? {
    status: "FAILED", attempts, lastError: errorText, result: result || null, completedAt: now, claimedAt: null,
    claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: clean(workId, 200) || job.workId,
  } : {
    status: "SCHEDULED", attempts, lastError: errorText, result: result || null,
    nextRunAt: new Date(now.getTime() + RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1))), claimedAt: null,
    claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null,
  };
    const updated = await tx.jobInstance.updateMany({
      where: { id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseTokenHash: hashToken(leaseToken), leaseRevision },
      data,
    });
    if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before failure report");
    if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: { jobId: job.id, deviceId, leaseRevision },
      });
    }
    const failureSideEffect = await recordJobFailure({ db: tx, job, error: errorText, terminal, retryAfterAt: terminal ? null : data.nextRunAt });
    return { job, terminal, data, errorText, failureSideEffect };
  }, { allowExpired: true, profile: "JOB_COMPLETION" });
  const { job, terminal, data, errorText, failureSideEffect } = outcome;

  // The bounded final subscriber page may be fully committed even when the
  // worker reports failure (for example a lost final response). The transaction
  // above records only a recovery marker; perform durable publication on the
  // root client so its phases cannot collapse into the failJob transaction.
  if (job.jobKey === "subscriber_directory_scan" && failureSideEffect?.publicationRecoveryPending === true) {
    await recordJobFailure({ db: prisma, job, error: errorText, terminal, retryAfterAt: terminal ? null : data.nextRunAt });
  }
  return { id: job.id, status: terminal ? "FAILED" : "SCHEDULED", terminal, retryAt: terminal ? null : data.nextRunAt };
}

async function releaseJob({ jobId, userId, deviceId, leaseToken, leaseRevision, workId, reason, runAfterMs = 30_000 }) {
  return leaseCommit({ jobId, userId, deviceId, leaseToken, leaseRevision }, async (tx, { job, now }) => {
  const delay = Math.max(1_000, Math.min(15 * 60_000, Math.floor(Number(runAfterMs) || 30_000)));
    const updated = await tx.jobInstance.updateMany({
      where: {
        id: job.id,
        status: "CLAIMED",
        claimedByDeviceId: deviceId,
        leaseTokenHash: hashToken(leaseToken),
        leaseRevision,
      },
      data: {
        status: "SCHEDULED",
        nextRunAt: new Date(now.getTime() + delay),
        // A cooperative lease release is not a failed attempt. Keep the reason
        // in bounded progress diagnostics, never as a fake retry failure.
        lastError: null,
        progress: {
          ...object(job.progress),
          waitKind: waitKind(reason),
          waitReason: clean(reason, 500) || "worker released lease",
          waitingSince: now.toISOString(),
          retryAt: new Date(now.getTime() + delay).toISOString(),
        },
        claimedAt: null,
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        workId: clean(workId, 200) || job.workId,
      },
    });
    if (!updated.count) throw new JobLeaseError("JOB_LEASE_STALE", "Job lease changed before release");
    if (typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({
        where: { jobId: job.id, deviceId, leaseRevision },
      });
    }
  return { id: job.id, status: "SCHEDULED", retryAt: new Date(now.getTime() + delay), attempts: job.attempts };
  }, { allowExpired: true, profile: "JOB_COMPLETION" });
}
module.exports = {
  JobLeaseError,
  claimJob,
  renewLease,
  acquireJobFanObservationReadLease,
  releaseJobObservationReadLease,
  issueFanObservationToken,
  progressJob,
  completeJob,
  failJob,
  releaseJob,
  campaignDirectoryDiscoveryJob,
  CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS,
  CAMPAIGN_DIRECTORY_DISCOVERY_MAX_NON_RECURRING_ACTIVE_CLAIMS,
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS,
  FAN_DATA_REFRESH_MAX_ACTIVE_CLAIMS_PER_CREATOR,
  fanDataRefreshClaimAvailable,
  sweepExpiredLeases,
  normalizeLeaseContinuation,
  dialogDiscoveryClaimConstraint,
  claimCandidateWhere,
};
