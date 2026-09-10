/* src/services/job-scheduler.js
   ────────────────────────────────────────────────────────────
   Job auto-scheduling.

   Used in two places:

   1. creators.js complete-connection — after a creator transitions to READY,
      we schedule lightweight dashboard earnings plus the strict Creator Analytics
      initial sync pipeline so history begins without anyone clicking refresh.

   2. server.js startup — the recurring scheduler runs every
      `RECURRING_INTERVAL_MS` (default 1 hour) and creates fresh
      scheduled jobs for any READY creator that doesn't have a
      scheduled or recently-completed job already.

   Why this design:
   - JobInstance has no unique constraint on (creator, jobKey, params).
     We dedupe in code: if there's already a SCHEDULED or recently-DONE
     (within the cooldown window) job for the same (creator, jobKey,
     rangeKey), we don't create a duplicate.
   - The recurring scheduler is idempotent — running it twice within
     the same hour creates zero new jobs.
   ────────────────────────────────────────────────────────────
*/

"use strict";

const prisma = require("../prisma");
const { runRetentionSweep, getRetentionSettings } = require("./retention-service");
const { selectPhase2MaintenanceLanes } = require("./phase2-maintenance-admission-service");
const { buildJobIdempotencyKey } = require("./job-idempotency");
const { ensureSubscriberScanDue } = require("./subscriber-directory-service");
const { ensureAutomaticFollowBack } = require("./follow-back-service");
const { ensureAutomaticBumps } = require("./bump-service");
const { ensureAutomaticLikes } = require("./likes-service");
const { ensureAutomaticFollowAutomation } = require("./follow-automation-service");
const { ensureAutomaticSfs } = require("./sfs-service");
const { reconcileExpiredBillingStates } = require("./billing-entitlement-service");
const { renewDueCreatorSubscriptions } = require("./billing-wallet-service");
const { ensurePlannedJob, createPlannedJobIfAbsent } = require("./job-planning-repository");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { runMaintenanceLane } = require("./maintenance-work-authority");
const {
  WORK_CLASS: PHASE2_WORK_CLASS,
  claimDomainWorkBatch,
  heartbeatDomainWorkClaim,
  ackDomainWorkClaim,
  blockDomainWorkClaim,
  failDomainWorkClaim,
  yieldDomainWorkClaim,
  publishDomainWork,
  currentDependencyRevision,
} = require("./domain-work-authority-service");
const {
  FAMILY: PHASE2_COVERAGE_FAMILY,
  GENERATION: PHASE2_COVERAGE_GENERATION,
  ensurePhase2Coverage,
  markPhase2CoverageRunning,
  markPhase2CoverageComplete,
  markPhase2CoverageFailed,
  phase2CoverageStatus,
} = require("./phase2-work-coverage-authority-service");
const { stampCollectionAuthorityParams } = require("./analytics-collector-control-service");
const {
  ensureOperationalAnalyticsFreshness,
  runAnalyticsCollectionSweep,
  runAnalyticsCollectionDemandSweep,
  claimAnalyticsSweepCycle,
  renewAnalyticsSweepLease,
  completeAnalyticsSweepCycle,
} = require("./analytics-collection-planner");

// Recurring sweeper interval. Owner asked for 1 hour.
const RECURRING_INTERVAL_MS = 60 * 60 * 1000;

// How recently a "DONE" job counts as fresh enough to skip rescheduling.
// Same as RECURRING_INTERVAL_MS — if we just refreshed, don't refresh again.
const FRESHNESS_WINDOW_MS = RECURRING_INTERVAL_MS;
const TRAFFIC_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const RETENTION_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000; // fallback; admin setting can override
const TEAM_PENDING_BACKFILL_BATCH_SIZE = 500; // DB-only Team queue projection repair
const PROVIDER_OPERATIONAL_BACKFILL_BATCH_SIZE = 100; // one-time cold-history -> current-work projection
const PROVIDER_OPERATIONAL_DIRTY_BATCH_SIZE = 100; // bounded current canonical transitions only
const PHASE2_COVERAGE_SEED_LANE_KEY = "phase2_coverage_seed_v2";
const PHASE2_COVERAGE_SEED_GENERATION = "phase2_coverage_seed_v2";
const PHASE2_COVERAGE_AGENCY_BATCH_SIZE = 100;
const PHASE2_HISTORICAL_ENUMERATION_BATCH_SIZE = 20;
const PHASE2_CUSTOM_REMINDER_BATCH_SIZE = 50;
const TEAM_PENDING_PROJECTION_LANE_KEY = "team_pending_projection_v1";
const TEAM_PENDING_PROJECTION_LANE_GENERATION = "team_pending_projection_v1";
const TEAM_LEGACY_PENDING_REPAIR_LANE_KEY = "team_legacy_pending_bootstrap_repair_v1";
const TEAM_LEGACY_PENDING_REPAIR_LANE_GENERATION = "team_legacy_pending_bootstrap_repair_v1";
const ANALYTICS_DEMAND_INTERVAL_MS = 15 * 1000; // durable interactive Home freshness demands
const TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS = 30 * 1000; // lane cadence; pump checks due state more frequently
const PHASE2_MAINTENANCE_PUMP_INTERVAL_MS = 5 * 1000;
const PHASE2_MAINTENANCE_LANES_PER_TICK = 5;
const TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE = 200;
const CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_KEY = "custom_external_proof_backfill_v1";
const CUSTOM_EXTERNAL_PROOF_BACKFILL_LANE_GENERATION = "custom_external_proof_backfill_v1";
const CUSTOM_EXTERNAL_CURRENT_DEBT_LANE_KEY = "custom_external_projection_debt_v1";
const CUSTOM_EXTERNAL_CURRENT_DEBT_LANE_GENERATION = "custom_external_projection_debt_v1";
const RECURRING_READY_PAGE_SIZE = 250;
const CREATOR_ANALYTICS_SWEEP_LEASE_KEY = "creator_analytics_recurring_v1";
const CREATOR_ANALYTICS_SWEEP_COORDINATION_LOCK_KEY = "creator-analytics-recurring-sweep-coordinator";
const CREATOR_ANALYTICS_SWEEP_LEASE_MS = 15 * 60 * 1000;
const CREATOR_ANALYTICS_SWEEP_HEARTBEAT_EVERY = 25;
let recurringSweepPromise = null;
let creatorAnalyticsSweepPromise = null;
let phase2MaintenancePromise = null;


function retentionBreakdown(result, laneNames) {
  const out = {};
  for (const name of laneNames) {
    const lane = result?.[name];
    if (!lane) continue;
    out[name] = {
      totalDeleted: Number(lane.totalDeleted || 0),
      items: Object.fromEntries((Array.isArray(lane.items) ? lane.items : [])
        .map((item) => [String(item?.label || "unknown"), Number(item?.deleted || 0)])),
    };
    if (lane.error) out[name].error = String(lane.error);
  }
  return out;
}

async function maybeRunRetentionSweep({ now = new Date(), force = false } = {}) {
  let retentionWindowMs = RETENTION_SWEEP_WINDOW_MS;
  try {
    const current = await getRetentionSettings();
    const hours = Number(current?.settings?.retentionSweepWindowHours || 24);
    if (Number.isFinite(hours) && hours > 0) {
      retentionWindowMs = Math.max(1, Math.round(hours)) * 60 * 60 * 1000;
    }
  } catch (err) {
    console.warn("[scheduler] retention settings read failed:", err?.message || err);
  }

  const startedAt = Date.now();

  try {
    const result = await runRetentionSweep({ minIntervalMs: force ? 0 : retentionWindowMs });
    const laneNames = ["teamActivity", "teamLedgers", "traffic", "automation", "dialogIntelligence", "auditLogs", "creatorTaskActivity", "analyticsExecution"];
    const laneSummary = laneNames
      .map((name) => `${name}=${Number(result?.[name]?.totalDeleted || 0)}`)
      .join(", ");
    const breakdown = JSON.stringify(retentionBreakdown(result, laneNames));
    if (result?.ok === false) {
      console.warn(`[scheduler] retention sweep partial/failed in ${Date.now() - startedAt}ms — deleted=${result.totalDeleted || 0}; ${laneSummary}; errors=${JSON.stringify(result.laneErrors || result.coordinationError || [])}; breakdown=${breakdown}`);
    } else if (result?.skipped) {
      console.log(`[scheduler] retention sweep skipped in ${Date.now() - startedAt}ms — reason=${result.reason || "unknown"}`);
    } else {
      console.log(`[scheduler] retention sweep done in ${Date.now() - startedAt}ms — deleted=${result.totalDeleted || 0}; ${laneSummary}; breakdown=${breakdown}`);
    }
    return { ...result, windowMs: retentionWindowMs };
  } catch (err) {
    console.warn("[scheduler] retention sweep failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err), windowMs: retentionWindowMs };
  }
}


/**
 * Schedule jobs for a creator that is READY. Creator Analytics history is
 * orchestrated separately as a strict Notifications -> Money -> Campaigns
 * pipeline; recurring sweeps additionally schedule cheap head catch-ups.
 *
 * @param {object} args
 * @param {string} args.creatorId
 * @param {string} args.agencyId
 * @param {number} [args.priority=50]
 * @param {boolean} [args.includeAnalyticsCatchups=false]
 * @param {boolean} [args.includeCreatorAnalytics=true]
 * @returns {Promise<{ created: string[], skipped: string[] }>}
 */
async function scheduleInitialJobsForCreator({
  creatorId,
  agencyId,
  priority = 50,
  creator = null,
  includeAnalyticsCatchups = false,
  includeEarningsFreshness = true,
  includeCreatorAnalytics = true,
}) {
  if (!creatorId || !agencyId) return { created: [], skipped: [] };
  const creatorRemoteId = creator?.remoteId || creator?.userId || null;
  const creatorUsername = creator?.username || null;
  const creatorDisplayName = creator?.displayName || null;

  const created = [];
  const skipped = [];
  const now = new Date();

  // Creator Analytics bootstrap owns the creator background-read lane until its
  // strict Notifications -> Financial -> Campaigns history sequence is proven.
  // The recurring scheduler can delegate the actual Analytics planning to its
  // distributed sweep, but it still gates unrelated creator-wide scans on the
  // proven bootstrap state so the old lane-ownership invariant is preserved.
  try {
    const {
      ensureInitialCreatorAnalyticsSync,
      ensureRecurringCreatorAnalyticsCatchups,
      creatorAnalyticsInitialSyncReady,
    } = require("./creator-analytics-sync-orchestrator");

    if (includeCreatorAnalytics) {
      const initial = await ensureInitialCreatorAnalyticsSync({
        creatorId, agencyId, now, priority: Math.max(80, priority),
      });
      if (initial.created) created.push(`creator_analytics_initial:${initial.stage}`);
      else skipped.push(`creator_analytics_initial:${initial.stage}:${initial.reason || "waiting"}`);
      if (!initial.ready) return { created, skipped };

      if (includeAnalyticsCatchups) {
        const catchups = await ensureRecurringCreatorAnalyticsCatchups({
          creatorId, agencyId, now, priority: Math.max(15, priority - 10),
        });
        created.push(...(catchups.created || []));
        skipped.push(...(catchups.skipped || []));
      }
    } else {
      const ready = await creatorAnalyticsInitialSyncReady({ creatorId });
      if (!ready) {
        skipped.push("creator_analytics_initial:waiting:distributed_sweep");
        return { created, skipped };
      }
    }
  } catch (err) {
    skipped.push(`creator_analytics:${err?.message || "schedule_failed"}`);
    // Fail closed for automatic read work. If bootstrap state cannot be proven,
    // do not start other creator-wide OF scans that can race its recovery.
    return { created, skipped };
  }

  // Earnings collection is no longer display-range scheduling. A single
  // coverage/freshness planner owns exact provider windows.
  if (includeEarningsFreshness) {
    const earnings = await ensureOperationalAnalyticsFreshness({
      creatorId,
      agencyId,
      reason: "INITIAL_SYNC",
      priority,
      now,
    });
    if (earnings.created > 0) created.push(`fetch_earnings:${earnings.created}`);
    else skipped.push(`fetch_earnings:${earnings.reused ? "reused" : "fresh"}`);
  }

  // Traffic/member attribution stays independent once bootstrap no longer owns
  // the read lane.
  const trafficDecision = await ensureSingleJob({
    jobKey: "traffic_sources_scan",
    creatorId,
    agencyId,
    params: {
      hydrateFanValues: false,
      hydrateLimit: 0,
      valueTtlHours: 6,
      creatorRemoteId,
      remoteId: creatorRemoteId,
      creatorUsername,
      username: creatorUsername,
      creatorDisplayName,
      reason: "recurring_traffic_refresh",
    },
    priority: Math.max(10, priority - 20),
    now,
    freshnessWindowMs: TRAFFIC_REFRESH_WINDOW_MS,
  });
  if (trafficDecision.created) created.push("traffic_sources_scan");
  else skipped.push("traffic_sources_scan");

  // Subscriber Directory — one shared weekly source for Hidden Online,
  // Follow Back candidates and future subscriber-driven modules.
  const subscriberDecision = await ensureSubscriberScanDue({
    agencyId,
    creatorId,
    priority: Math.max(5, priority - 30),
    now,
  });
  if (subscriberDecision.created) created.push("subscriber_directory_scan");
  else skipped.push("subscriber_directory_scan");

  // Follow Back candidate planning is backend orchestration over the already
  // published Subscriber Directory projection. It never starts another OF scan.
  const followBackDecision = await ensureAutomaticFollowBack({
    agencyId,
    creatorId,
    source: "recurring_scheduler",
  });
  if (followBackDecision.created) created.push("follow_back_plan");
  else skipped.push(`follow_back_plan:${followBackDecision.reason}`);

  const bumpDecision = await ensureAutomaticBumps({
    agencyId,
    creatorId,
    source: "recurring_scheduler",
  });
  if (bumpDecision.created) created.push(`bumps_plan:${bumpDecision.planned}`);
  else skipped.push(`bumps_plan:${bumpDecision.reason}`);

  const likesDecision = await ensureAutomaticLikes({
    agencyId,
    creatorId,
    source: "recurring_scheduler",
  });
  if (likesDecision.created) created.push("likes_plan");
  else skipped.push(`likes_plan:${likesDecision.reason}`);

  const followAutomationDecision = await ensureAutomaticFollowAutomation({
    agencyId,
    creatorId,
    source: "recurring_scheduler",
  });
  if (followAutomationDecision.created) created.push("follow_automation_plan");
  else skipped.push(`follow_automation_plan:${followAutomationDecision.reason}`);

  const sfsDecision = await ensureAutomaticSfs({ agencyId, creatorId, source: "recurring_scheduler" });
  if (sfsDecision?.planning?.created || sfsDecision?.discovery?.created) created.push("sfs_plan");
  else skipped.push(`sfs_plan:${sfsDecision?.planning?.reason || sfsDecision?.discovery?.reason || sfsDecision?.reason || "skipped"}`);

  return { created, skipped };
}


/**
 * Look up by (jobKey, creatorId, params.rangeKey) and decide whether to create a job.
 * Skips if:
 *  - There's already a SCHEDULED or CLAIMED job for this combo
 *  - There's a DONE job completed within freshnessWindowMs (defaults to FRESHNESS_WINDOW_MS).
 *
 * Pass `freshnessWindowMs` explicitly when on-demand callers (e.g. /home/summary
 * trying to backfill a missing range) want a stricter "fresh" definition than
 * the recurring sweeper's 1-hour window.
 */
async function ensureSingleJob({ jobKey, creatorId, agencyId, params, priority, now, freshnessWindowMs }) {
  const rangeKey = params?.rangeKey || null;
  const window = Number.isFinite(freshnessWindowMs) ? freshnessWindowMs : FRESHNESS_WINDOW_MS;
  const idempotencyKey = buildJobIdempotencyKey({
    jobKey,
    scope: "creator",
    creatorId,
    agencyId,
    params: params || {},
    bucketAt: now,
    bucketMs: window,
  });

  // Prefer the explicit idempotency key. Because idempotencyKey is unique,
  // ANY row for the current bucket already owns that bucket. Do not attempt a
  // second INSERT for FAILED/CANCELLED/other terminal rows: PostgreSQL would
  // correctly reject it with P2002 and Prisma would emit a scary error log even
  // when the application catches the exception. The next scheduler bucket gets
  // a different key and is the normal retry boundary. Older rows without a key
  // are still considered by the compatibility rangeKey scan below.
  const keyed = await prisma.jobInstance.findUnique({ where: { idempotencyKey } });
  if (keyed) {
    if (keyed.status === "SCHEDULED" || keyed.status === "CLAIMED") {
      return { created: false, reason: "already_in_flight", jobId: keyed.id };
    }
    if (keyed.status === "DONE" && keyed.completedAt && keyed.completedAt > new Date(now.getTime() - window)) {
      return { created: false, reason: "recently_done", jobId: keyed.id };
    }
    return {
      created: false,
      reason: `same_bucket_${String(keyed.status || "terminal").toLowerCase()}`,
      jobId: keyed.id,
    };
  }

  // Find any existing legacy job for this creator+jobKey+rangeKey.
  const existing = await prisma.jobInstance.findMany({
    where: {
      jobKey,
      creatorId,
    },
    orderBy: { createdAt: "desc" },
    take: 20, // small enough; usually 1-3 rows
  });

  // Filter by rangeKey (we can't compose JSON path filter in Prisma cleanly).
  const matching = existing.filter((j) => {
    const p = j.params || {};
    return rangeKey ? p.rangeKey === rangeKey : !p.rangeKey;
  });

  // Check: already scheduled or claimed?
  const inFlight = matching.find((j) => j.status === "SCHEDULED" || j.status === "CLAIMED");
  if (inFlight) {
    return { created: false, reason: "already_in_flight", jobId: inFlight.id };
  }

  // Check: recently done?
  const freshnessThreshold = new Date(now.getTime() - window);
  const recentlyDone = matching.find(
    (j) => j.status === "DONE" && j.completedAt && j.completedAt > freshnessThreshold
  );
  if (recentlyDone) {
    return { created: false, reason: "recently_done", jobId: recentlyDone.id };
  }

  const planned = await createPlannedJobIfAbsent({
    db: prisma,
    jobKey,
    scope: "creator",
    creatorId,
    agencyId,
    idempotencyKey,
    params: params || {},
    priority,
    scheduledAt: now,
    nextRunAt: now,
  });
  return planned.created
    ? { created: true, jobId: planned.job?.id || null }
    : { created: false, reason: "idempotency_race", jobId: planned.job?.id || null };
}

async function scheduleJobNow({
  db = prisma,
  jobKey,
  creatorId,
  agencyId,
  params = {},
  priority = 100,
  now = new Date(),
  bucketMs = 60_000,
  dedupeParams = null,
} = {}) {
  // Some planners issue a server-authoritative command inside params.  Fields
  // such as collectionGeneration/collectionRequestedAt are intentionally unique
  // per command and therefore must not participate in planning idempotency.
  // When dedupeParams is supplied, all replicas converge on the first stored
  // command for the bucket instead of replacing its generation after a race.
  const hasStableDedupe = dedupeParams && typeof dedupeParams === "object" && !Array.isArray(dedupeParams);
  if (hasStableDedupe && !String(dedupeParams.planningEpoch || "").trim()) {
    throw new Error("JOB_PLANNING_DEDUPE_EPOCH_REQUIRED");
  }
  const idempotencyKey = buildJobIdempotencyKey({
    jobKey,
    scope: "creator",
    creatorId,
    agencyId,
    params: hasStableDedupe ? dedupeParams : params,
    // Stable dedupe is tied to a durable collection-state epoch, not a wall
    // clock bucket. This closes the minute/hour boundary race between replicas.
    bucketAt: hasStableDedupe ? new Date(0) : now,
    bucketMs: hasStableDedupe ? 1 : bucketMs,
  });

  const analyticsCommand = hasStableDedupe
    && Number(params?.collectionContractVersion) === 1
    && typeof params?.collectionGeneration === "string"
    && typeof params?.collectionRequestedAt === "string";
  const authorityNow = analyticsCommand
    ? await dbAuthorityNow({ db, fallbackNow: now })
    : now;
  const plannedParams = analyticsCommand
    ? stampCollectionAuthorityParams(params, authorityNow, dedupeParams?.collectionOrderingAfter)
    : params;

  const planned = await ensurePlannedJob({
    db,
    jobKey,
    scope: "creator",
    creatorId,
    agencyId,
    idempotencyKey,
    params: plannedParams,
    priority,
    scheduledAt: authorityNow,
    nextRunAt: authorityNow,
    shouldResetExisting: (existing) => {
      if (!hasStableDedupe) return existing.status !== "CLAIMED";
      // Same planning epoch + active row means another replica already owns the
      // command. A terminal row with no durable epoch advance, however, must be
      // recoverable; otherwise cancellation/expiry before collector acceptance
      // would permanently strand automatic collection on this epoch.
      return !["SCHEDULED", "CLAIMED", "PAUSED"].includes(String(existing.status || "").toUpperCase());
    },
    protectedStatuses: ["CLAIMED"],
  });
  if (!planned.job) throw new Error(`Failed to schedule ${jobKey}: planning race did not converge`);
  return {
    job: planned.job,
    created: planned.created,
    reason: planned.created ? "created" : planned.rescheduled ? "rescheduled" : planned.reason,
  };
}


async function maybeReconcileHistoricalTeamMoney({ db = prisma, now = new Date() } = {}) {
  // Compatibility entry only. Historical Team money is no longer a global recurring
  // business writer. Per-agency Phase2 coverage enumerates legacy/canonical sources and
  // publishes exact TEAM_MONEY_RECONCILIATION work; execution is owned by DomainWork.
  const seed = await maybeSeedPhase2CoverageWork({ db, now });
  const enumeration = await maybeRunPhase2HistoricalEnumeration({ db, now });
  return { ok: seed?.ok !== false && enumeration?.ok !== false, seed, enumeration, authority: "PHASE2_PER_AGENCY_COVERAGE" };
}

async function publishCoverageEnumerationWork({ db, agencyId, family, generation, now }) {
  await ensurePhase2Coverage({ db, agencyId, family, generation });
  return publishDomainWork({
    db, agencyId, workClass: PHASE2_WORK_CLASS.HISTORICAL_ENUMERATION,
    objectType: "Phase2Coverage", objectId: `${family}:${generation}`,
    parentObjectId: agencyId, partitionKey: agencyId, availableAt: now,
  });
}

async function maybeSeedPhase2CoverageWork({ db = prisma, now = new Date() } = {}) {
  return runMaintenanceLane({
    db, key: PHASE2_COVERAGE_SEED_LANE_KEY, generation: PHASE2_COVERAGE_SEED_GENERATION,
    oneTime: true, leaseMs: 5 * 60 * 1000, minIntervalMs: 1_000, fallbackNow: now,
    work: async ({ claim }) => {
      const cursor = String(claim?.cursor?.lastAgencyId || "").trim() || null;
      const agencies = await db?.agency?.findMany?.({
        where: { deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true }, orderBy: { id: "asc" }, take: PHASE2_COVERAGE_AGENCY_BATCH_SIZE,
      }) || [];
      let published = 0;
      for (const agency of agencies) {
        const agencyId = String(agency.id);
        for (const [family, generation] of [
          [PHASE2_COVERAGE_FAMILY.PROVIDER_OPERATIONAL, PHASE2_COVERAGE_GENERATION.PROVIDER_OPERATIONAL],
          [PHASE2_COVERAGE_FAMILY.CUSTOM_EXTERNAL_PROJECTION, PHASE2_COVERAGE_GENERATION.CUSTOM_EXTERNAL_PROJECTION],
          [PHASE2_COVERAGE_FAMILY.CUSTOM_SOURCE_PIPELINE, PHASE2_COVERAGE_GENERATION.CUSTOM_SOURCE_PIPELINE],
          [PHASE2_COVERAGE_FAMILY.TEAM_ACTIVITY_CONTRIBUTION, PHASE2_COVERAGE_GENERATION.TEAM_ACTIVITY_CONTRIBUTION],
          [PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR, PHASE2_COVERAGE_GENERATION.TEAM_RESPONSE_RANGE_REPAIR],
          [PHASE2_COVERAGE_FAMILY.TEAM_DIALOG_PROJECTION, PHASE2_COVERAGE_GENERATION.TEAM_DIALOG_PROJECTION],
          [PHASE2_COVERAGE_FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION, PHASE2_COVERAGE_GENERATION.TEAM_MONEY_ROOT_CLASSIFICATION],
          [PHASE2_COVERAGE_FAMILY.TEAM_MONEY_RECONCILIATION, PHASE2_COVERAGE_GENERATION.TEAM_MONEY_RECONCILIATION],
          [PHASE2_COVERAGE_FAMILY.TEAM_READ_SUMMARY, PHASE2_COVERAGE_GENERATION.TEAM_READ_SUMMARY],
          [PHASE2_COVERAGE_FAMILY.TELEGRAM_CONFIRMED_PROJECTION, PHASE2_COVERAGE_GENERATION.TELEGRAM_CONFIRMED_PROJECTION],
          [PHASE2_COVERAGE_FAMILY.TELEGRAM_INBOUND_PROJECTION, PHASE2_COVERAGE_GENERATION.TELEGRAM_INBOUND_PROJECTION],
        ]) {
          const status = await phase2CoverageStatus({ db, agencyId, family, generation });
          if (!status.ready) {
            await publishCoverageEnumerationWork({ db, agencyId, family, generation, now });
            published += 1;
          }
        }
      }
      const complete = agencies.length < PHASE2_COVERAGE_AGENCY_BATCH_SIZE;
      return {
        complete, outcome: complete ? "COVERAGE_SEED_COMPLETE" : "COVERAGE_SEED_BATCH_COMPLETE",
        cursor: { lastAgencyId: complete ? null : String(agencies[agencies.length - 1]?.id || cursor || "") },
        nextRunAt: complete ? null : new Date(now.getTime() + 1_000),
        progress: { scannedAgencies: Number(claim?.progress?.scannedAgencies || 0) + agencies.length, published },
      };
    },
  });
}

async function runProviderCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { selectProviderOperationalBackfillBatch, reconcileProviderOperationalDebtForOrder } = require("./provider-operational-debt-authority-service");
  const family = PHASE2_COVERAGE_FAMILY.PROVIDER_OPERATIONAL;
  const generation = PHASE2_COVERAGE_GENERATION.PROVIDER_OPERATIONAL;
  const cursor = String(item?.progressCursor?.lastOrderId || item?.progressCursor?.lastId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const rows = await selectProviderOperationalBackfillBatch({ db, agencyId: item.agencyId, cursor, limit: PROVIDER_OPERATIONAL_BACKFILL_BATCH_SIZE });
  let projected = 0;
  for (const row of rows) {
    await reconcileProviderOperationalDebtForOrder({ agencyId: String(item.agencyId), orderId: String(row.id), db, now, markClean: false });
    await publishDomainWork({
      db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_COMMUNICATION,
      objectType: "CustomOrder", objectId: String(row.id), partitionKey: String(row.creatorId || item.agencyId),
      creatorId: row.creatorId ? String(row.creatorId) : null, availableAt: now,
    });
    projected += 1;
  }
  const lastOrderId = rows.length ? String(rows[rows.length - 1].id) : cursor;
  if (rows.length >= PROVIDER_OPERATIONAL_BACKFILL_BATCH_SIZE) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: lastOrderId });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastOrderId }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: lastOrderId, projectedThrough: lastOrderId, unresolvedCount: 0, fallbackNow: now });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, projected, complete: true };
}

async function runExternalCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { convergeHistoricalCustomExternalProofs } = require("./custom-external-proof-convergence-service");
  const family = PHASE2_COVERAGE_FAMILY.CUSTOM_EXTERNAL_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.CUSTOM_EXTERNAL_PROJECTION;
  const cursor = String(item?.progressCursor?.lastSubmissionId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await convergeHistoricalCustomExternalProofs({ agencyId: item.agencyId, cursor, limit: 200, db });
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.ok === false || Number(batch?.failed || 0) > 0) {
    await markPhase2CoverageFailed({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, Number(batch?.failed || 0)) });
    const error = new Error("CUSTOM_EXTERNAL_COVERAGE_ENUMERATION_FAILED"); error.code = "CUSTOM_EXTERNAL_COVERAGE_ENUMERATION_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastSubmissionId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runCustomSourcePipelineCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.CUSTOM_SOURCE_PIPELINE;
  const generation = PHASE2_COVERAGE_GENERATION.CUSTOM_SOURCE_PIPELINE;
  const cursor = String(item?.progressCursor?.lastSubmissionId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const rows = await db.customContentSubmission.findMany({
    where: {
      agencyId: String(item.agencyId),
      pipelineDisposition: { in: ["ACTIVE", "SALVAGE"] },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: { id: true, creatorId: true, telegramSourceAccountId: true },
    orderBy: { id: "asc" }, take: 100,
  });
  for (const row of rows || []) await publishDomainWork({
    db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
    objectType: "CustomContentSubmission", objectId: String(row.id), partitionKey: String(row.creatorId || item.agencyId),
    creatorId: row.creatorId ? String(row.creatorId) : null,
    accountId: row.telegramSourceAccountId ? String(row.telegramSourceAccountId) : null,
    availableAt: now,
  });
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : cursor;
  if (Number(rows?.length || 0) >= 100) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastSubmissionId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }

  // Enumeration is not activation. Existing source work can be owned by a Desktop
  // for several minutes while Telegram/OnlyFans execution is in flight. Coverage is
  // COMPLETE only when every enumerated/live source revision has reached DONE.
  let outstanding = false;
  if (typeof db?.$queryRawUnsafe === "function") {
    const pending = await db.$queryRawUnsafe(`SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" w WHERE w."agencyId"=$1 AND w."workClass"='CUSTOM_SOURCE_PIPELINE'
        AND (w."state" <> 'DONE' OR w."requestedRevision" > w."completedRevision") LIMIT 1
    ) AS "hasOutstanding"`, String(item.agencyId));
    outstanding = Boolean(pending?.[0]?.hasOutstanding);
  } else if (db?.domainWorkItem?.findMany) {
    const pending = await db.domainWorkItem.findMany({
      where: { agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_SOURCE_PIPELINE },
      select: { state: true, requestedRevision: true, completedRevision: true }, take: 100,
    });
    outstanding = (pending || []).some((row) => String(row?.state || "") !== "DONE" || BigInt(row?.requestedRevision || 0) > BigInt(row?.completedRevision || 0));
  }
  if (outstanding) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastSubmissionId: nextCursor }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: "domain_work_converged", unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTeamActivityCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { backfillActivityContributionBatch } = require("./team-activity-contribution-authority-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_ACTIVITY_CONTRIBUTION;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_ACTIVITY_CONTRIBUTION;
  const cursor = String(item?.progressCursor?.lastEventId || "").trim() || null;
  const previousUnresolved = Math.max(0, Number(item?.progressCursor?.unresolved || 0));
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await backfillActivityContributionBatch({ db, agencyId: item.agencyId, cursor, limit: 100 });
  if (batch?.ok === false) {
    await markPhase2CoverageFailed({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, previousUnresolved + Number(batch?.unresolved || 0)) });
    const error = new Error(batch?.code || "TEAM_ACTIVITY_CONTRIBUTION_BACKFILL_FAILED"); error.code = batch?.code || "TEAM_ACTIVITY_CONTRIBUTION_BACKFILL_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  const unresolved = previousUnresolved + Number(batch?.unresolved || 0);
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastEventId: nextCursor, unresolved }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({
    db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor,
    unresolvedCount: unresolved, fallbackNow: now,
  });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, unresolved, complete: true, baseline: Number(batch?.baseline || 0), zero: Number(batch?.zero || 0) };
}

async function runTeamResponseCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { backfillTeamResponseRangeBatch } = require("./team-response-projection-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_RESPONSE_RANGE_REPAIR;
  const cursor = String(item?.progressCursor?.lastCaseId || "").trim() || null;
  const previousUnresolved = Math.max(0, Number(item?.progressCursor?.unresolved || 0));
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await backfillTeamResponseRangeBatch({ db, agencyId: item.agencyId, cursor, limit: 100 });
  if (batch?.ok === false) {
    await markPhase2CoverageFailed({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, previousUnresolved + Number(batch?.unresolved || 0)) });
    const error = new Error(batch?.code || "TEAM_RESPONSE_RANGE_REPAIR_FAILED"); error.code = batch?.code || "TEAM_RESPONSE_RANGE_REPAIR_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  const unresolved = previousUnresolved + Number(batch?.unresolved || 0);
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastCaseId: nextCursor, unresolved }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({
    db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor,
    unresolvedCount: unresolved, fallbackNow: now,
  });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, unresolved, repaired: Number(batch?.repaired || 0), complete: true };
}


async function runTeamDialogCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { dialogWorkObjectId, listUnprojectedRelevantDialogEvents } = require("./team-dialog-projection-authority-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_DIALOG_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_DIALOG_PROJECTION;
  const cursor = String(item?.progressCursor?.lastEventId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const rows = await listUnprojectedRelevantDialogEvents({
    db, agencyId: String(item.agencyId), cursor, limit: 100,
  });
  let published = 0;
  for (const row of rows || []) {
    const creatorId = String(row?.creatorId || "").trim(); const dialogId = String(row?.dialogId || row?.fanId || "").trim();
    if (!creatorId || !dialogId) continue;
    await publishDomainWork({ db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_DIALOG_PROJECTION,
      objectType: "CreatorDialog", objectId: dialogWorkObjectId(creatorId, dialogId), parentObjectId: String(row.id),
      partitionKey: creatorId, creatorId, availableAt: now });
    published += 1;
  }
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : cursor;
  if (Number(rows?.length || 0) >= 100) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastEventId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  // Enumerated != converged. Before activating coverage, verify no raw event remains
  // unprojected. If workers are still draining, republish a bounded set and retry later.
  const pending = await listUnprojectedRelevantDialogEvents({
    db, agencyId: String(item.agencyId), limit: 25,
  });
  let unresolved = 0;
  for (const row of pending || []) {
    const creatorId = String(row?.creatorId || "").trim(); const dialogId = String(row?.dialogId || row?.fanId || "").trim();
    if (!creatorId || !dialogId) continue;
    await publishDomainWork({ db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_DIALOG_PROJECTION, objectType: "CreatorDialog",
      objectId: dialogWorkObjectId(creatorId, dialogId), parentObjectId: String(row.id), partitionKey: creatorId, creatorId, availableAt: now });
    unresolved += 1;
  }
  if (unresolved > 0) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastEventId: null }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, complete: true, published };
}

async function runTeamMoneyRootClassificationUnit({ db, item, ownerToken, now }) {
  const { classifyTeamMoneyRootsBatch } = require("./team-money-root-classification-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_MONEY_ROOT_CLASSIFICATION;
  const cursor = String(item?.progressCursor?.lastFactId || "").trim() || null;
  const previousUnresolved = Math.max(0, Number(item?.progressCursor?.unresolved || 0));
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await classifyTeamMoneyRootsBatch({ db, agencyId: item.agencyId, cursor, limit: 100 });
  if (batch?.ok === false) {
    await markPhase2CoverageFailed({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, previousUnresolved) });
    const error = new Error(batch?.code || "TEAM_MONEY_ROOT_CLASSIFICATION_FAILED"); error.code = batch?.code || "TEAM_MONEY_ROOT_CLASSIFICATION_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  const unresolved = previousUnresolved + Math.max(0, Number(batch?.unresolved || 0));
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastFactId: nextCursor, unresolved }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: unresolved, fallbackNow: now });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, complete: true, unresolved, scanned: Number(batch?.scanned || 0) };
}

async function runTeamMoneyReconciliationCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { repairMigratedLegacyTipManualAuthority, migrateLegacyTipsToTipLedger } = require("./team-tip-ledger-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_MONEY_RECONCILIATION;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_MONEY_RECONCILIATION;
  const progress = item?.progressCursor && typeof item.progressCursor === "object" ? item.progressCursor : {};
  const phase = String(progress.phase || "legacy_manual");
  const agencyId = String(item.agencyId);
  await markPhase2CoverageRunning({ db, agencyId, family, generation, enumeratedThrough: JSON.stringify(progress) });

  if (phase === "legacy_manual") {
    const repaired = await repairMigratedLegacyTipManualAuthority({ db, agencyId, limit: 100, dryRun: false });
    if (repaired?.ok === false) throw Object.assign(new Error("TEAM_MONEY_LEGACY_MANUAL_REPAIR_FAILED"), { code: "TEAM_MONEY_LEGACY_MANUAL_REPAIR_FAILED" });
    const more = Number(repaired?.scanned || 0) >= 100;
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase: more ? "legacy_manual" : "legacy_tips" }, availableAt: now, fallbackNow: new Date() });
  }
  if (phase === "legacy_tips") {
    const migrated = await migrateLegacyTipsToTipLedger({ db, agencyId, limit: 100, dryRun: false, deleteLegacy: true, now });
    if (migrated?.ok === false) throw Object.assign(new Error("TEAM_MONEY_LEGACY_TIP_MIGRATION_FAILED"), { code: "TEAM_MONEY_LEGACY_TIP_MIGRATION_FAILED" });
    const more = Number(migrated?.scanned || 0) >= 100;
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase: more ? "legacy_tips" : "sales", lastId: null }, availableAt: now, fallbackNow: new Date() });
  }

  if (phase === "sales" || phase === "tips") {
    const model = phase === "sales" ? db.creatorSale : db.creatorTip;
    if (!model?.findMany) throw Object.assign(new Error("TEAM_MONEY_CANONICAL_SOURCE_UNAVAILABLE"), { code: "TEAM_MONEY_CANONICAL_SOURCE_UNAVAILABLE" });
    const cursor = String(progress.lastId || "").trim() || null;
    const where = { agencyId, ...(cursor ? { id: { gt: cursor } } : {}) };
    if (phase === "sales") where.saleType = "MESSAGE";
    const rows = await model.findMany({ where, select: { id: true, creatorId: true }, orderBy: { id: "asc" }, take: 100 });
    for (const row of rows || []) await publishDomainWork({
      db, agencyId, workClass: PHASE2_WORK_CLASS.TEAM_MONEY_RECONCILIATION,
      objectType: phase === "sales" ? "CreatorSale" : "CreatorTip", objectId: String(row.id),
      partitionKey: String(row.creatorId || agencyId), creatorId: row.creatorId ? String(row.creatorId) : null, availableAt: now,
    });
    const nextId = rows?.length ? String(rows[rows.length - 1].id) : cursor;
    if (Number(rows?.length || 0) >= 100) {
      await markPhase2CoverageRunning({ db, agencyId, family, generation, enumeratedThrough: `${phase}:${nextId}` });
      return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase, lastId: nextId }, availableAt: now, fallbackNow: new Date() });
    }
    if (phase === "sales") {
      return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase: "tips", lastId: null }, availableAt: now, fallbackNow: new Date() });
    }
  }

  // Enumeration alone is not activation. Wait until every exact current/historical
  // money item published for this agency has reached the requested revision.
  let outstanding = false;
  if (typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" w WHERE w."agencyId"=$1 AND w."workClass"='TEAM_MONEY_RECONCILIATION'
        AND (w."state" <> 'DONE' OR w."requestedRevision" > w."completedRevision") LIMIT 1
    ) AS "hasOutstanding"`, agencyId);
    outstanding = Boolean(rows?.[0]?.hasOutstanding);
  } else if (db?.domainWorkItem?.findMany) {
    const pendingRows = await db.domainWorkItem.findMany({
      where: { agencyId, workClass: PHASE2_WORK_CLASS.TEAM_MONEY_RECONCILIATION },
      select: { state: true, requestedRevision: true, completedRevision: true }, take: 25,
    });
    outstanding = (pendingRows || []).some((row) => String(row?.state || "") !== "DONE" || BigInt(row?.requestedRevision || 0) > BigInt(row?.completedRevision || 0));
  }
  if (outstanding) {
    await markPhase2CoverageRunning({ db, agencyId, family, generation, enumeratedThrough: "sources_enumerated" });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase: "verify" }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId, family, generation, enumeratedThrough: "sources_enumerated", projectedThrough: "domain_work_converged", unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTeamReadSummaryCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.TEAM_READ_SUMMARY;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_READ_SUMMARY;
  const cursor = String(item?.progressCursor?.lastFactId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const rows = await db.teamMoneyAttributionFact.findMany({
    where: { agencyId: String(item.agencyId), ...(cursor ? { id: { gt: cursor } } : {}) },
    select: { id: true, creatorId: true }, orderBy: { id: "asc" }, take: 100,
  });
  for (const row of rows || []) await publishDomainWork({
    db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_READ_SUMMARY,
    objectType: "TeamMoneyAttributionFact", objectId: String(row.id), partitionKey: String(row.creatorId || item.agencyId),
    creatorId: row.creatorId ? String(row.creatorId) : null, availableAt: now,
  });
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : cursor;
  if (Number(rows?.length || 0) >= 100) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastFactId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  // Do not activate a reader generation merely because source rows were enumerated.
  // Every historical fact must have its durable contribution snapshot first.
  let missing = [];
  if (typeof db?.$queryRawUnsafe === "function") {
    missing = await db.$queryRawUnsafe(`SELECT f."id",f."creatorId" FROM "TeamMoneyAttributionFact" f
      LEFT JOIN "TeamMoneyRollupContribution" c ON c."sourceFactId"=f."id"
      WHERE f."agencyId"=$1 AND c."sourceFactId" IS NULL ORDER BY f."id" ASC LIMIT 25`, String(item.agencyId));
  } else if (db?.teamMoneyAttributionFact?.findMany) {
    missing = await db.teamMoneyAttributionFact.findMany({
      where: { agencyId: String(item.agencyId), rollupContribution: { is: null } }, select: { id: true, creatorId: true }, orderBy: { id: "asc" }, take: 25,
    });
  }
  for (const row of missing || []) await publishDomainWork({ db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_READ_SUMMARY, objectType: "TeamMoneyAttributionFact", objectId: String(row.id),
    partitionKey: String(row.creatorId || item.agencyId), creatorId: row.creatorId ? String(row.creatorId) : null, availableAt: now });

  // Existing contribution != converged contribution. A live fact can change after the
  // historical enumerator has passed it, leaving a newer TEAM_READ_SUMMARY revision queued.
  // Coverage is allowed to activate only after both storage presence and execution revision
  // convergence are proven.
  let outstanding = false;
  if (typeof db?.$queryRawUnsafe === "function") {
    const pending = await db.$queryRawUnsafe(`SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" w WHERE w."agencyId"=$1 AND w."workClass"='TEAM_READ_SUMMARY'
        AND (w."state" <> 'DONE' OR w."requestedRevision" > w."completedRevision") LIMIT 1
    ) AS "hasOutstanding"`, String(item.agencyId));
    outstanding = Boolean(pending?.[0]?.hasOutstanding);
  } else if (db?.domainWorkItem?.findMany) {
    const pending = await db.domainWorkItem.findMany({
      where: { agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_READ_SUMMARY },
      select: { state: true, requestedRevision: true, completedRevision: true }, take: 25,
    });
    outstanding = (pending || []).some((row) => String(row?.state || "") !== "DONE" || BigInt(row?.requestedRevision || 0) > BigInt(row?.completedRevision || 0));
  }
  if (Number(missing?.length || 0) > 0 || outstanding) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastFactId: nextCursor }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTelegramConfirmedCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.TELEGRAM_CONFIRMED_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.TELEGRAM_CONFIRMED_PROJECTION;
  const cursor = String(item?.progressCursor?.lastIntentId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const rows = await db.telegramDeliveryIntent.findMany({
    where: { agencyId: String(item.agencyId), state: "CONFIRMED", ...(cursor ? { id: { gt: cursor } } : {}) },
    select: { id: true, creatorId: true, accountId: true }, orderBy: { id: "asc" }, take: 100,
  });
  for (const row of rows || []) await publishDomainWork({
    db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TELEGRAM_CONFIRMED_PROJECTION,
    objectType: "TelegramDeliveryIntent", objectId: String(row.id), partitionKey: String(row.accountId || row.creatorId || item.agencyId),
    creatorId: row.creatorId ? String(row.creatorId) : null, accountId: row.accountId ? String(row.accountId) : null, availableAt: now,
  });
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : cursor;
  if (Number(rows?.length || 0) >= 100) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastIntentId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTelegramInboundCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.TELEGRAM_INBOUND_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.TELEGRAM_INBOUND_PROJECTION;
  const cursor = String(item?.progressCursor?.lastInboundEventId || "").trim() || null;
  await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const rows = await db.telegramInboundEvent.findMany({
    where: {
      agencyId: String(item.agencyId),
      ...(cursor ? { id: { gt: cursor } } : {}),
      OR: [
        { submissionId: { not: null }, projectionState: { not: "APPLIED" } },
        { submissionId: null, projectionState: { in: ["PENDING", "FAILED_RETRYABLE"] } },
      ],
    },
    select: { id: true, creatorId: true, accountId: true }, orderBy: { id: "asc" }, take: 100,
  });
  for (const row of rows || []) await publishDomainWork({
    db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TELEGRAM_INBOUND_PROJECTION,
    objectType: "TelegramInboundEvent", objectId: String(row.id), partitionKey: String(row.accountId || row.creatorId || item.agencyId),
    creatorId: row.creatorId ? String(row.creatorId) : null, accountId: row.accountId ? String(row.accountId) : null, availableAt: now,
  });
  const nextCursor = rows?.length ? String(rows[rows.length - 1].id) : cursor;
  if (Number(rows?.length || 0) >= 100) {
    await markPhase2CoverageRunning({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastInboundEventId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function maybeRunPhase2HistoricalEnumeration({ db = prisma, now = new Date() } = {}) {
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.HISTORICAL_ENUMERATION, limit: PHASE2_HISTORICAL_ENUMERATION_BATCH_SIZE,
    perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 5 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), completed: 0, yielded: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      const objectId = String(item.objectId || "");
      let result;
      if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.PROVIDER_OPERATIONAL}:`)) {
        result = await runProviderCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.CUSTOM_EXTERNAL_PROJECTION}:`)) {
        result = await runExternalCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.CUSTOM_SOURCE_PIPELINE}:`)) {
        result = await runCustomSourcePipelineCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TEAM_ACTIVITY_CONTRIBUTION}:`)) {
        result = await runTeamActivityCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TEAM_RESPONSE_RANGE_REPAIR}:`)) {
        result = await runTeamResponseCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TEAM_DIALOG_PROJECTION}:`)) {
        result = await runTeamDialogCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION}:`)) {
        result = await runTeamMoneyRootClassificationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TEAM_MONEY_RECONCILIATION}:`)) {
        result = await runTeamMoneyReconciliationCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TEAM_READ_SUMMARY}:`)) {
        result = await runTeamReadSummaryCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TELEGRAM_CONFIRMED_PROJECTION}:`)) {
        result = await runTelegramConfirmedCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else if (objectId.startsWith(`${PHASE2_COVERAGE_FAMILY.TELEGRAM_INBOUND_PROJECTION}:`)) {
        result = await runTelegramInboundCoverageEnumerationUnit({ db, item, ownerToken: claim.ownerToken, now });
      } else {
        const error = new Error(`Unsupported Phase2 coverage family: ${objectId}`); error.code = "PHASE2_COVERAGE_FAMILY_UNSUPPORTED";
        result = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() });
      }
      if (result?.lost) report.lostOwnership += 1;
      else if (result?.state === "READY" || result?.yielded) report.yielded += 1;
      else if (result?.failed) report.failed += 1;
      else report.completed += 1;
    } catch (error) {
      await markPhase2CoverageFailed({ db, agencyId: item.agencyId,
        family: String(item.objectId || "").split(":")[0], generation: String(item.objectId || "").split(":").slice(1).join(":"), unresolvedCount: 1 }).catch(() => {});
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

// Compatibility export: the old global backfill authority is retired. This now seeds and
// executes per-agency coverage only; readiness of Agency B is independent from poison in A.
async function maybeBackfillProviderOperationalDebt({ db = prisma, now = new Date() } = {}) {
  const seed = await maybeSeedPhase2CoverageWork({ db, now });
  const enumeration = await maybeRunPhase2HistoricalEnumeration({ db, now });
  return { ok: seed?.ok !== false && enumeration?.ok !== false, seed, enumeration };
}

async function communicationBlockedDependency({ item, report, db }) {
  const reason = String(report?.initialTaskBlockedReason || "");
  if (!reason) return null;
  const order = await db?.customOrder?.findFirst?.({
    where: { agencyId: String(item.agencyId), id: String(item.objectId) },
    select: { id: true, creatorId: true, creator: { select: { telegramAccountId: true, telegramContact: true } } },
  });
  const creatorId = String(order?.creatorId || item.creatorId || "");
  if (reason === "CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED") {
    const revision = await currentDependencyRevision({ db, agencyId: item.agencyId, dependencyKind: "CREATOR_BINDING", dependencyKey: creatorId });
    return { dependencyKind: "CREATOR_BINDING", dependencyKey: creatorId, dependencyRevision: revision, reason };
  }
  if (["CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING"].includes(reason)) {
    const explicitAccount = String(order?.creator?.telegramAccountId || "").trim();
    const dependencyKind = explicitAccount ? "ACCOUNT_LIFECYCLE" : "AUTO_PROVIDER";
    const dependencyKey = explicitAccount || String(item.agencyId);
    const revision = await currentDependencyRevision({ db, agencyId: item.agencyId, dependencyKind, dependencyKey });
    return { dependencyKind, dependencyKey, dependencyRevision: revision, reason };
  }
  return null;
}

// Compatibility export name retained for callers/tests. Execution ownership is no longer the
// providerOperationalDirty boolean: revisioned DomainWorkItem is the distributed authority.
async function maybeRepairProviderOperationalDirty({ db = prisma, now = new Date() } = {}) {
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.CUSTOM_COMMUNICATION,
    limit: PROVIDER_OPERATIONAL_DIRTY_BATCH_SIZE, perAgencyQuantum: 10,
    leaseMs: 5 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), acknowledged: 0, blocked: 0, failed: 0, lostOwnership: 0, projected: 0, modelCommunicationRepaired: 0 };
  const { repairClaimedCustomModelCommunicationWork } = require("./telegram-delivery-authority-service");
  for (const item of claim?.items || []) {
    try {
      const claimedRepair = await repairClaimedCustomModelCommunicationWork({
        agencyId: String(item.agencyId), orderId: String(item.objectId), workItem: item,
        ownerToken: claim.ownerToken, now: new Date(), db, leaseMs: 5 * 60 * 1000,
      });
      if (claimedRepair?.lostOwnership) { report.lostOwnership += 1; continue; }
      if (claimedRepair?.superseded || claimedRepair?.missing) {
        const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
        if (ack?.lost) report.lostOwnership += 1; else report.acknowledged += 1;
        continue;
      }
      const communication = claimedRepair?.communication || {};
      report.modelCommunicationRepaired += Number(communication?.initialTaskPlanned || 0) + Number(communication?.initialTaskReactivated || 0)
        + Number(communication?.revisionIntentPlanned || 0) + Number(communication?.precommitCancelled || 0)
        + Number(communication?.precommitRefreshed || 0) + Number(communication?.reminderScheduleRepaired || 0);
      if (claimedRepair?.ok === false || communication?.ok === false) {
        const failure = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error: Object.assign(new Error("CUSTOM_MODEL_COMMUNICATION_REPAIR_FAILED"), { code: "CUSTOM_MODEL_COMMUNICATION_REPAIR_FAILED" }), fallbackNow: new Date() });
        if (failure?.lost) report.lostOwnership += 1; else report.failed += 1;
        continue;
      }
      const projection = claimedRepair?.projection || {};
      report.projected += Number(projection?.projected || 0);
      const dependency = await communicationBlockedDependency({ item, report: communication, db });
      if (dependency) {
        const blocked = await blockDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, ...dependency, fallbackNow: new Date() });
        if (blocked?.lost) report.lostOwnership += 1; else report.blocked += 1;
        continue;
      }
      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) report.lostOwnership += 1; else report.acknowledged += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function listDependencyFanoutOrders({ db, item, limit = 100 }) {
  const cursor = String(item?.progressCursor?.lastOrderId || "").trim() || null;
  const baseWhere = { agencyId: String(item.agencyId), status: "PENDING", type: { in: ["CONTENT", "CALL", "PHYSICAL"] }, ...(cursor ? { id: { gt: cursor } } : {}) };
  if (String(item.objectType) === "CreatorAccount") {
    return db.customOrder.findMany({ where: { ...baseWhere, creatorId: String(item.objectId) }, select: { id: true, agencyId: true, creatorId: true }, orderBy: { id: "asc" }, take: limit });
  }
  if (String(item.objectType) === "ReminderPolicy") {
    return db.customOrder.findMany({ where: baseWhere, select: { id: true, agencyId: true, creatorId: true }, orderBy: { id: "asc" }, take: limit });
  }
  if (String(item.objectType) === "AgencyTelegramMtprotoAccount" && typeof db?.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(
      `SELECT co."id",co."agencyId",co."creatorId"
         FROM "CustomOrder" co JOIN "CreatorAccount" ca ON ca."agencyId"=co."agencyId" AND ca."id"=co."creatorId"
        WHERE co."agencyId"=$1 AND co."status"='PENDING' AND co."type" IN ('CONTENT','CALL','PHYSICAL')
          AND ($2::text IS NULL OR co."id">$2)
          AND (ca."telegramAccountId" IS NULL OR ca."telegramAccountId"=$3)
        ORDER BY co."id" ASC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 100))}`,
      String(item.agencyId), cursor, String(item.objectId),
    );
    return rows || [];
  }
  // Reduced test fallback. Production account fanout uses the indexed join above.
  return db.customOrder.findMany({ where: baseWhere, select: { id: true, agencyId: true, creatorId: true }, orderBy: { id: "asc" }, take: limit });
}

async function listDependencyFanoutSubmissions({ db, item, limit = 100 }) {
  const cursor = String(item?.progressCursor?.lastSubmissionId || item?.progressCursor?.lastId || "").trim() || null;
  const where = {
    agencyId: String(item.agencyId),
    pipelineDisposition: { in: ["ACTIVE", "SALVAGE"] },
    ...(cursor ? { id: { gt: cursor } } : {}),
  };
  if (String(item.objectType) === "CreatorAccount") where.creatorId = String(item.objectId);
  else if (String(item.objectType) === "AgencyTelegramMtprotoAccount") where.telegramSourceAccountId = String(item.objectId);
  else if (String(item.objectType) !== "CustomPipelineConfig") return [];
  return db.customContentSubmission.findMany({
    where,
    select: { id: true, agencyId: true, creatorId: true, telegramSourceAccountId: true },
    orderBy: { id: "asc" }, take: Math.max(1, Math.min(100, Number(limit) || 100)),
  });
}

async function processTeamMoneyEvidenceFanout({ db, item, now }) {
  const sent = await db?.teamSentMessageLedger?.findFirst?.({
    where: { id: String(item.objectId), agencyId: String(item.agencyId) },
    select: { id: true, agencyId: true, creatorId: true, accountId: true, messageId: true, sentAt: true },
  });
  if (!sent) return { complete: true, obsolete: true, published: 0 };
  const creatorId = String(sent.creatorId || sent.accountId || "").trim();
  const messageId = String(sent.messageId || "").trim();
  if (!creatorId || !messageId) return { complete: true, obsolete: true, published: 0 };
  const progress = item?.progressCursor && typeof item.progressCursor === "object" ? item.progressCursor : {};
  const phase = String(progress.phase || "sales");
  const cursor = String(progress.lastId || "").trim() || null;
  const sentAt = sent.sentAt instanceof Date ? sent.sentAt : new Date(sent.sentAt || now);
  const tipWindowEnd = new Date(sentAt.getTime() + 15 * 60 * 1000);
  let published = 0;

  if (phase === "sales") {
    const rows = await db.creatorSale.findMany({
      where: { agencyId: String(item.agencyId), creatorId, saleType: "MESSAGE", messageId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true }, orderBy: { id: "asc" }, take: 100,
    });
    for (const row of rows || []) {
      await publishDomainWork({ db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_MONEY_RECONCILIATION,
        objectType: "CreatorSale", objectId: String(row.id), partitionKey: creatorId, creatorId, availableAt: now });
      published += 1;
    }
    if (Number(rows?.length || 0) >= 100) return { complete: false, published, progressCursor: { phase: "sales", lastId: String(rows[rows.length - 1].id) } };
  }

  const tipCursor = phase === "tips" ? cursor : null;
  const tips = await db.creatorTip.findMany({
    where: { agencyId: String(item.agencyId), creatorId, ...(tipCursor ? { id: { gt: tipCursor } } : {}),
      OR: [{ messageId }, { tippedAt: { gte: sentAt, lte: tipWindowEnd } }] },
    select: { id: true }, orderBy: { id: "asc" }, take: 100,
  });
  for (const row of tips || []) {
    await publishDomainWork({ db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_MONEY_RECONCILIATION,
      objectType: "CreatorTip", objectId: String(row.id), partitionKey: creatorId, creatorId, availableAt: now });
    published += 1;
  }
  if (Number(tips?.length || 0) >= 100) return { complete: false, published, progressCursor: { phase: "tips", lastId: String(tips[tips.length - 1].id) } };
  return { complete: true, published };
}

async function maybeRunPhase2DependencyFanout({ db = prisma, now = new Date() } = {}) {
  const claim = await claimDomainWorkBatch({ db, workClass: PHASE2_WORK_CLASS.DEPENDENCY_FANOUT, limit: 20, perAgencyQuantum: 2, leaseMs: 2 * 60 * 1000, fallbackNow: now });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), published: 0, sourcePublished: 0, reminderReprojected: 0, completed: 0, yielded: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) === "TeamSentMessageLedger") {
        const moneyFanout = await processTeamMoneyEvidenceFanout({ db, item, now });
        report.published += Number(moneyFanout?.published || 0);
        if (moneyFanout?.complete === false) {
          const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, progressCursor: moneyFanout.progressCursor, availableAt: now, fallbackNow: new Date() });
          if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
        } else {
          const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
          if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
        }
        continue;
      }

      if (String(item.objectType) === "ReminderPolicy") {
        const rows = await listDependencyFanoutOrders({ db, item, limit: 100 });
        for (const row of rows) {
          const { reprojectCustomReminderSchedule } = require("./custom-order-reminders");
          await reprojectCustomReminderSchedule({ agencyId: String(row.agencyId), orderId: String(row.id), now: new Date(), db });
          report.reminderReprojected += 1;
        }
        if ((rows?.length || 0) >= 100) {
          const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, progressCursor: { lastOrderId: String(rows[rows.length - 1].id) }, availableAt: now, fallbackNow: new Date() });
          if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
        } else {
          const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
          if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
        }
        continue;
      }

      const progress = item?.progressCursor && typeof item.progressCursor === "object" ? item.progressCursor : {};
      let phase = String(progress.phase || (String(item.objectType) === "CustomPipelineConfig" ? "submissions" : "orders"));
      if (phase === "orders") {
        const rows = await listDependencyFanoutOrders({ db, item: { ...item, progressCursor: { lastOrderId: progress.lastId || progress.lastOrderId || null } }, limit: 100 });
        for (const row of rows) {
          await publishDomainWork({ db, agencyId: String(row.agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_COMMUNICATION, objectType: "CustomOrder", objectId: String(row.id), partitionKey: String(row.creatorId), creatorId: String(row.creatorId), availableAt: now });
          report.published += 1;
        }
        if ((rows?.length || 0) >= 100) {
          const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, progressCursor: { phase: "orders", lastId: String(rows[rows.length - 1].id) }, availableAt: now, fallbackNow: new Date() });
          if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
          continue;
        }
        phase = "submissions";
      }

      if (phase === "submissions") {
        const rows = await listDependencyFanoutSubmissions({ db, item: { ...item, progressCursor: { lastSubmissionId: progress.phase === "submissions" ? (progress.lastId || progress.lastSubmissionId || null) : null } }, limit: 100 });
        for (const row of rows) {
          await publishDomainWork({ db, agencyId: String(row.agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
            objectType: "CustomContentSubmission", objectId: String(row.id), partitionKey: String(row.creatorId), creatorId: String(row.creatorId),
            accountId: row.telegramSourceAccountId ? String(row.telegramSourceAccountId) : null, availableAt: now });
          report.sourcePublished += 1;
        }
        if ((rows?.length || 0) >= 100) {
          const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, progressCursor: { phase: "submissions", lastId: String(rows[rows.length - 1].id) }, availableAt: now, fallbackNow: new Date() });
          if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
          continue;
        }
      }

      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function reminderBlockedDependency({ item, result, db }) {
  const code = String(result?.blockedCode || "");
  if (!code) return null;
  if (code === "CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED") {
    const dependencyKind = "REMINDER_OUTCOME", dependencyKey = String(item.parentObjectId || item.objectId);
    const dependencyRevision = await currentDependencyRevision({ db, agencyId: item.agencyId, dependencyKind, dependencyKey });
    return { dependencyKind, dependencyKey, dependencyRevision };
  }
  if (["CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "CUSTOM_ORDER_TELEGRAM_ACCOUNT_RETIRING"].includes(code)) {
    const orderId = String(item.parentObjectId || "").trim();
    const order = orderId ? await db?.customOrder?.findFirst?.({ where: { agencyId: String(item.agencyId), id: orderId }, select: { creatorId: true, creator: { select: { telegramAccountId: true } } } }) : null;
    const explicit = String(order?.creator?.telegramAccountId || result?.accountId || "").trim();
    const dependencyKind = explicit ? "ACCOUNT_LIFECYCLE" : "AUTO_PROVIDER";
    const dependencyKey = explicit || String(item.agencyId);
    const dependencyRevision = await currentDependencyRevision({ db, agencyId: item.agencyId, dependencyKind, dependencyKey });
    return { dependencyKind, dependencyKey, dependencyRevision };
  }
  return null;
}

async function maybePlanDueCustomReminderWork({ db = prisma, now = new Date() } = {}) {
  const { ensureAutomaticReminderIntentForOrder } = require("./telegram-delivery-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.CUSTOM_REMINDER, limit: PHASE2_CUSTOM_REMINDER_BATCH_SIZE,
    perAgencyQuantum: 10, perPartitionQuantum: 1, leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), planned: 0, blocked: 0, stale: 0, completed: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      const orderId = String(item.parentObjectId || "").trim();
      if (!orderId) throw Object.assign(new Error("CUSTOM_REMINDER_WORK_PARENT_REQUIRED"), { code: "CUSTOM_REMINDER_WORK_PARENT_REQUIRED" });
      const result = await ensureAutomaticReminderIntentForOrder({ agencyId: String(item.agencyId), orderId, member: null, now, db });
      report.planned += Number(result?.planned || 0);
      if (result?.blocked) {
        const dependency = await reminderBlockedDependency({ item, result, db });
        if (dependency) {
          const blocked = await blockDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, ...dependency, reason: result.blockedCode, fallbackNow: new Date() });
          if (blocked?.lost) report.lostOwnership += 1; else report.blocked += 1;
          continue;
        }
      }
      if (result?.stale) report.stale += 1;
      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) {
        // Reprojection may have superseded exactly this old identity in the same domain action.
        const current = await db?.domainWorkItem?.findFirst?.({ where: { id: String(item.id) } });
        if (result?.stale && String(current?.state || "") === "DONE" && String(current?.terminalCause || "") === "REMINDER_SUPERSEDED") report.completed += 1;
        else report.lostOwnership += 1;
      } else report.completed += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runCustomExternalProofConvergenceSweep({ now = new Date(), db = prisma } = {}) {
  const { repairCustomExternalProjectionWorkItem } = require("./custom-external-proof-convergence-service");
  const claim = await claimDomainWorkBatch({
    db,
    workClass: PHASE2_WORK_CLASS.CUSTOM_EXTERNAL_PROJECTION,
    limit: 50,
    perAgencyQuantum: 5,
    perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000,
    fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), repaired: 0, cleared: 0, obsolete: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) !== "AutomationDelivery") {
        throw Object.assign(new Error("CUSTOM_EXTERNAL_WORK_TYPE_UNSUPPORTED"), { code: "CUSTOM_EXTERNAL_WORK_TYPE_UNSUPPORTED" });
      }
      const result = await repairCustomExternalProjectionWorkItem({ agencyId: String(item.agencyId), deliveryId: String(item.objectId), db });
      report.repaired += Number(result?.repaired || 0);
      report.cleared += Number(result?.cleared || 0);
      if (result?.obsolete) report.obsolete += 1;
      if (!result?.converged && !result?.obsolete) {
        const error = new Error("CUSTOM_EXTERNAL_PROJECTION_NOT_CONVERGED");
        error.code = "CUSTOM_EXTERNAL_PROJECTION_NOT_CONVERGED";
        const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() });
        if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
        continue;
      }
      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) report.lostOwnership += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return { ok: report.ok, backfill: { skipped: true, reason: "per_agency_historical_enumeration" }, current: report };
}

async function runTeamDialogProjectionSweep({ now = new Date(), db = prisma } = {}) {
  const { parseDialogWorkObjectId, projectCreatorDialogWorkItem } = require("./team-dialog-projection-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.TEAM_DIALOG_PROJECTION, limit: 50, perAgencyQuantum: 5, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), projected: 0, yielded: 0, completed: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) !== "CreatorDialog") throw Object.assign(new Error("TEAM_DIALOG_WORK_TYPE_UNSUPPORTED"), { code: "TEAM_DIALOG_WORK_TYPE_UNSUPPORTED" });
      const identity = parseDialogWorkObjectId(item.objectId);
      if (!identity) throw Object.assign(new Error("TEAM_DIALOG_WORK_IDENTITY_INVALID"), { code: "TEAM_DIALOG_WORK_IDENTITY_INVALID" });
      const result = await projectCreatorDialogWorkItem({ agencyId: String(item.agencyId), ...identity, db, limit: 100 });
      report.projected += Number(result?.projected || 0);
      if (result?.hasMore) {
        const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, availableAt: now, fallbackNow: new Date() });
        if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
      } else {
        const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
        if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
      }
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runTeamResponseRangeRepairSweep({ now = new Date(), db = prisma } = {}) {
  const { projectCoverageResponseWorkItem } = require("./team-dialog-projection-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.TEAM_RESPONSE_RANGE_REPAIR, limit: 25, perAgencyQuantum: 3, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), repaired: 0, yielded: 0, completed: 0, obsolete: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) !== "TeamActivityEvent") throw Object.assign(new Error("TEAM_RESPONSE_RANGE_WORK_TYPE_UNSUPPORTED"), { code: "TEAM_RESPONSE_RANGE_WORK_TYPE_UNSUPPORTED" });
      const result = await projectCoverageResponseWorkItem({
        agencyId: String(item.agencyId), eventId: String(item.objectId), db,
        cursor: item?.progressCursor?.lastReplyLedgerId || null, limit: 100,
      });
      report.repaired += Number(result?.repaired || 0); if (result?.obsolete) report.obsolete += 1;
      if (result?.hasMore && result?.nextCursor) {
        const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, progressCursor: { lastReplyLedgerId: String(result.nextCursor) }, availableAt: now, fallbackNow: new Date() });
        if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
      } else {
        const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
        if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
      }
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runTeamMoneyReconciliationSweep({ now = new Date(), db = prisma } = {}) {
  const { repairTeamMoneyReconciliationWorkItem } = require("./team-money-reconciliation-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.TEAM_MONEY_RECONCILIATION, limit: 50, perAgencyQuantum: 5, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), reconciled: 0, obsolete: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      const result = await repairTeamMoneyReconciliationWorkItem({ db, agencyId: String(item.agencyId), objectType: String(item.objectType), objectId: String(item.objectId) });
      if (result?.obsolete) report.obsolete += 1; else report.reconciled += 1;
      if (result?.ok === false) throw Object.assign(new Error(result?.code || "TEAM_MONEY_RECONCILIATION_FAILED"), { code: result?.code || "TEAM_MONEY_RECONCILIATION_FAILED" });
      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) report.lostOwnership += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runTeamReadSummarySweep({ now = new Date(), db = prisma } = {}) {
  const { applyTeamMoneyFactToRollups } = require("./team-money-rollup-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.TEAM_READ_SUMMARY, limit: 50, perAgencyQuantum: 5, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), changed: 0, idempotent: 0, obsolete: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) !== "TeamMoneyAttributionFact") throw Object.assign(new Error("TEAM_READ_SUMMARY_WORK_TYPE_UNSUPPORTED"), { code: "TEAM_READ_SUMMARY_WORK_TYPE_UNSUPPORTED" });
      const result = await applyTeamMoneyFactToRollups({ db, agencyId: String(item.agencyId), factId: String(item.objectId) });
      if (result?.obsolete) report.obsolete += 1; else if (result?.changed) report.changed += 1; else report.idempotent += 1;
      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) report.lostOwnership += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runTelegramInboundProjectionSweep({ now = new Date(), db = prisma } = {}) {
  const { projectTelegramInboundEvent, reconcilePendingInboundForConfirmedDelivery } = require("./telegram-inbound-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.TELEGRAM_INBOUND_PROJECTION,
    limit: Math.min(100, TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE), perAgencyQuantum: 5, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), applied: 0, terminal: 0, yielded: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) === "TelegramInboundEvent") {
        const result = await projectTelegramInboundEvent({ eventId: String(item.objectId), now, db });
        if (String(result?.state) === "FAILED_RETRYABLE") {
          const error = new Error(result?.reason || "TELEGRAM_INBOUND_PROJECTION_FAILED"); error.code = result?.reason || "TELEGRAM_INBOUND_PROJECTION_FAILED";
          const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() });
          if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
          continue;
        }
        if (String(result?.state) === "APPLIED") report.applied += 1;
        else report.terminal += 1;
        const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
        if (ack?.lost) report.lostOwnership += 1;
        continue;
      }
      if (String(item.objectType) === "TelegramDeliveryReceipt") {
        const receipt = await db.telegramDeliveryIntent.findFirst({ where: { id: String(item.objectId), agencyId: String(item.agencyId), state: "CONFIRMED" } });
        if (!receipt) {
          const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
          if (ack?.lost) report.lostOwnership += 1;
          else report.terminal += 1;
          continue;
        }
        const providerReceipt = String(receipt.confirmationAuthority || "PROVIDER_RECEIPT") === "PROVIDER_RECEIPT";
        const result = await reconcilePendingInboundForConfirmedDelivery({
          agencyId: String(item.agencyId), accountId: String(receipt.accountId),
          senderTelegramUserId: providerReceipt ? (receipt.remoteRecipientTelegramUserId || null) : null,
          replyToMessageId: receipt.remoteMessageId || null, actorUserId: receipt.userId || null, now,
          limit: 100, cursor: item?.progressCursor?.lastInboundEventId || null, db,
        });
        report.applied += Number(result?.reconciled || 0);
        if (result?.hasMore && result?.nextCursor) {
          const yielded = await yieldDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, progressCursor: { lastInboundEventId: String(result.nextCursor) }, availableAt: now, fallbackNow: new Date() });
          if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
        } else {
          const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
          if (ack?.lost) report.lostOwnership += 1; else report.terminal += 1;
        }
        continue;
      }
      const error = new Error(`Unsupported Telegram inbound work type: ${item.objectType}`); error.code = "TELEGRAM_INBOUND_WORK_TYPE_UNSUPPORTED";
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() });
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runTelegramInboundProjectionMaintenanceSweep({ now = new Date(), db = prisma } = {}) {
  return runTelegramInboundProjectionSweep({ now, db });
}

async function runTelegramConfirmedProjectionSweep({ now = new Date(), db = prisma } = {}) {
  const { repairConfirmedTelegramDeliveryProjectionItem } = require("./telegram-delivery-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.TELEGRAM_CONFIRMED_PROJECTION,
    limit: 50, perAgencyQuantum: 5, perPartitionQuantum: 1, leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), repaired: 0, obsolete: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      if (String(item.objectType) !== "TelegramDeliveryIntent") throw Object.assign(new Error("TELEGRAM_CONFIRMED_WORK_TYPE_UNSUPPORTED"), { code: "TELEGRAM_CONFIRMED_WORK_TYPE_UNSUPPORTED" });
      const result = await repairConfirmedTelegramDeliveryProjectionItem({ agencyId: String(item.agencyId), intentId: String(item.objectId), now, db });
      report.repaired += Number(result?.repaired || 0); if (result?.obsolete) report.obsolete += 1;
      const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
      if (ack?.lost) report.lostOwnership += 1;
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runTelegramConfirmedProjectionMaintenanceSweep({ now = new Date(), db = prisma } = {}) {
  return runTelegramConfirmedProjectionSweep({ now, db });
}

async function maybeBackfillTeamPendingProjection({ db = prisma, now = new Date() } = {}) {
  // Compatibility entry point: current pending/response work is now exact CreatorDialog
  // DomainWork. Cold history is owned by per-agency HISTORICAL_ENUMERATION coverage.
  return runTeamDialogProjectionSweep({ db, now });
}

async function maybeRepairLegacyTeamPendingBootstrap({ db = prisma, now = new Date() } = {}) {
  try {
    const { repairStaleLegacyBootstrapPendingBatch } = require("./team-pending-read-service");
    const result = await runMaintenanceLane({
      db,
      key: TEAM_LEGACY_PENDING_REPAIR_LANE_KEY,
      generation: TEAM_LEGACY_PENDING_REPAIR_LANE_GENERATION,
      oneTime: true,
      fallbackNow: now,
      work: async () => repairStaleLegacyBootstrapPendingBatch({ db, limit: TEAM_PENDING_BACKFILL_BATCH_SIZE, fallbackNow: now }),
    });
    if (!result?.skipped && (Number(result?.selected || 0) > 0 || result?.complete)) {
      console.log(`[scheduler] Team legacy pending repair — cleared=${result.cleared || 0}/${result.selected || 0}, remaining=${result.remaining || 0}, complete=${result.complete === true}`);
    }
    return result;
  } catch (err) {
    console.warn("[scheduler] Team legacy pending repair failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function runCreatorAnalyticsCatchupSweep({ db = prisma, now = new Date(), pageSize = RECURRING_READY_PAGE_SIZE } = {}) {
  if (creatorAnalyticsSweepPromise) {
    return { ok: true, skipped: true, reason: "local_overlap" };
  }

  creatorAnalyticsSweepPromise = (async () => {
    const size = Math.max(1, Math.min(1000, Number(pageSize) || RECURRING_READY_PAGE_SIZE));
    const claim = await claimAnalyticsSweepCycle({
      db,
      now,
      leaseKey: CREATOR_ANALYTICS_SWEEP_LEASE_KEY,
      coordinationLockKey: CREATOR_ANALYTICS_SWEEP_COORDINATION_LOCK_KEY,
      leaseMs: CREATOR_ANALYTICS_SWEEP_LEASE_MS,
    });
    if (!claim.acquired) {
      return { ok: true, skipped: true, reason: claim.reason, cycleKey: claim.cycleKey };
    }

    const cycleNow = claim.cycleNow;
    let cursor = claim.cursorCreatorId || null;
    let creators = 0;
    let pages = 0;
    let jobsCreated = 0;
    let jobsSkipped = 0;
    let failures = 0;

    while (true) {
      const renewed = await renewAnalyticsSweepLease({
        db,
        ownerToken: claim.ownerToken,
        cycleKey: claim.cycleKey,
        cursorCreatorId: cursor,
        leaseKey: CREATOR_ANALYTICS_SWEEP_LEASE_KEY,
        leaseMs: CREATOR_ANALYTICS_SWEEP_LEASE_MS,
      });
      if (!renewed) {
        return { ok: false, skipped: true, reason: "cycle_lease_lost", cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures };
      }

      const rows = await db.creatorAccount.findMany({
        where: {
          status: "READY",
          deletedAt: null,
          agency: { deletedAt: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, agencyId: true },
        orderBy: [{ id: "asc" }],
        take: size,
      });
      if (!rows.length) break;
      pages += 1;

      const { ensureRecurringCreatorAnalyticsCatchups } = require("./creator-analytics-sync-orchestrator");
      for (let index = 0; index < rows.length; index += 1) {
        const creator = rows[index];
        try {
          const result = await ensureRecurringCreatorAnalyticsCatchups({
            db,
            creatorId: creator.id,
            agencyId: creator.agencyId,
            now: cycleNow,
            priority: 20,
          });
          jobsCreated += Number(result?.created?.length || 0) + (result?.initial?.created ? 1 : 0);
          jobsSkipped += Number(result?.skipped?.length || 0) + (result?.initial && !result.initial.created ? 1 : 0);
        } catch (err) {
          failures += 1;
          console.warn("[scheduler] Creator Analytics catchup failed:", creator.id, err?.message || err);
        }
        creators += 1;
        cursor = creator.id;

        if ((index + 1) % CREATOR_ANALYTICS_SWEEP_HEARTBEAT_EVERY === 0) {
          const heartbeat = await renewAnalyticsSweepLease({
            db,
            ownerToken: claim.ownerToken,
            cycleKey: claim.cycleKey,
            cursorCreatorId: cursor,
            leaseKey: CREATOR_ANALYTICS_SWEEP_LEASE_KEY,
            leaseMs: CREATOR_ANALYTICS_SWEEP_LEASE_MS,
          });
          if (!heartbeat) {
            return { ok: false, skipped: true, reason: "cycle_lease_lost", cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures };
          }
        }
      }

      const pageRenewed = await renewAnalyticsSweepLease({
        db,
        ownerToken: claim.ownerToken,
        cycleKey: claim.cycleKey,
        cursorCreatorId: cursor,
        leaseKey: CREATOR_ANALYTICS_SWEEP_LEASE_KEY,
        leaseMs: CREATOR_ANALYTICS_SWEEP_LEASE_MS,
      });
      if (!pageRenewed) {
        return { ok: false, skipped: true, reason: "cycle_lease_lost", cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures };
      }
      if (rows.length < size) break;
    }

    const completed = await completeAnalyticsSweepCycle({
      db,
      ownerToken: claim.ownerToken,
      cycleKey: claim.cycleKey,
      cursorCreatorId: cursor,
      leaseKey: CREATOR_ANALYTICS_SWEEP_LEASE_KEY,
    });
    if (!completed) {
      return { ok: false, skipped: true, reason: "cycle_completion_lost", cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures };
    }
    return { ok: true, skipped: false, cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures, pageSize: size };
  })();

  try {
    return await creatorAnalyticsSweepPromise;
  } finally {
    creatorAnalyticsSweepPromise = null;
  }
}

async function runRecurringCreatorWork({ db = prisma, now = new Date(), pageSize = RECURRING_READY_PAGE_SIZE } = {}) {
  const size = Math.max(1, Math.min(1000, Number(pageSize) || RECURRING_READY_PAGE_SIZE));
  let cursor = null;
  let creatorsScanned = 0;
  let pages = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let dailyCyclesStarted = 0;
  let dailyCyclesSkipped = 0;

  while (true) {
    const creators = await db.creatorAccount.findMany({
      where: {
        status: "READY",
        deletedAt: null,
        agency: { deletedAt: null },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, agencyId: true, remoteId: true, username: true, displayName: true },
      orderBy: [{ id: "asc" }],
      take: size,
    });
    if (!creators.length) break;
    pages += 1;

    for (const creator of creators) {
      try {
        const result = await scheduleInitialJobsForCreator({
          creatorId: creator.id,
          agencyId: creator.agencyId,
          creator,
          priority: 30,
          includeAnalyticsCatchups: false,
          includeEarningsFreshness: false,
          includeCreatorAnalytics: false,
        });
        totalCreated += result.created.length;
        totalSkipped += result.skipped.length;
      } catch (err) {
        console.warn("[scheduler] regular creator jobs failed:", creator.id, err?.message || err);
      }

      try {
        const { ensureDailyVaultIntelligenceCycle } = require("./vault-intelligence-daily-service");
        const daily = await ensureDailyVaultIntelligenceCycle({
          agencyId: creator.agencyId,
          creatorId: creator.id,
          now,
        });
        if (Number(daily?.created || 0) > 0) dailyCyclesStarted += 1;
        else dailyCyclesSkipped += 1;
      } catch (err) {
        dailyCyclesSkipped += 1;
        console.warn("[scheduler] daily Vault Intelligence failed:", creator.id, err?.message || err);
      }

      creatorsScanned += 1;
      cursor = creator.id;
    }
    if (creators.length < size) break;
  }

  return { creatorsScanned, pages, totalCreated, totalSkipped, dailyCyclesStarted, dailyCyclesSkipped, pageSize: size };
}

/**
 * Recurring scheduler — finds all READY creators across all agencies
 * and ensures they have scheduled jobs. Runs once on startup, then
 * every RECURRING_INTERVAL_MS.
 *
 * Designed to be cheap: looks at recent JobInstance rows (already indexed
 * by creatorId + jobKey), so even with thousands of creators it stays fast.
 */
async function runPhase2MaintenancePump({ db = prisma, now = new Date() } = {}) {
  if (phase2MaintenancePromise) return { ok: true, skipped: true, reason: "local_overlap" };
  phase2MaintenancePromise = (async () => {
    // R6 final admission layer. Each lane remains its own durable distributed authority;
    // this rotation is only a resource/fairness budget, never business truth. A restart may
    // change which lane runs first, but no lane loses work because claims/cursors stay durable.
    const lanes = [
      ["providerOperationalBackfill", () => maybeBackfillProviderOperationalDebt({ db, now })],
      ["dependencyFanout", () => maybeRunPhase2DependencyFanout({ db, now })],
      ["customReminderWork", () => maybePlanDueCustomReminderWork({ db, now })],
      ["providerOperationalDirty", () => maybeRepairProviderOperationalDirty({ db, now })],
      ["telegramConfirmedProjection", () => runTelegramConfirmedProjectionMaintenanceSweep({ now, db })],
      ["telegramInboundProjection", () => runTelegramInboundProjectionMaintenanceSweep({ now, db })],
      ["customExternalProofConvergence", () => runCustomExternalProofConvergenceSweep({ now, db })],
      ["teamMoneyReconciliation", () => runTeamMoneyReconciliationSweep({ now, db })],
      ["teamReadSummary", () => runTeamReadSummarySweep({ now, db })],
      ["teamPendingBackfill", () => maybeBackfillTeamPendingProjection({ db, now })],
      ["teamResponseRangeRepair", () => runTeamResponseRangeRepairSweep({ db, now })],
      ["teamLegacyPendingRepair", () => maybeRepairLegacyTeamPendingBootstrap({ db, now })],
    ];
    const admission = selectPhase2MaintenanceLanes({
      laneNames: lanes.map(([name]) => name),
      now,
      intervalMs: PHASE2_MAINTENANCE_PUMP_INTERVAL_MS,
      lanesPerTick: PHASE2_MAINTENANCE_LANES_PER_TICK,
    });
    const selected = admission.selected.map((name) => lanes.find(([laneName]) => laneName === name)).filter(Boolean);
    const result = { ok: true, admission };
    // Sequential admission deliberately avoids a fixed Promise.all connection burst. Every
    // admitted lane executes one already-bounded work unit, then yields to the next lane.
    for (const [name, run] of selected) {
      try {
        const laneResult = await run();
        result[name] = laneResult;
        if (laneResult?.ok === false) result.ok = false;
      } catch (error) {
        result.ok = false;
        result[name] = { ok: false, error: error?.message || String(error) };
      }
    }
    return result;
  })();
  try { return await phase2MaintenancePromise; }
  finally { phase2MaintenancePromise = null; }
}

async function runRecurringSweepInternal() {
  const startedAt = Date.now();
  const now = new Date();

  // Analytics has its own paginated current-work sweep. A durable UTC-cycle lease
  // elects one sweep owner across replicas; creator-local DB reservation remains
  // the second fence for exact provider work, and the planner prevents in-process overlap.
  let analyticsSweep = null;
  try {
    analyticsSweep = await runAnalyticsCollectionSweep({ db: prisma, now });
  } catch (err) {
    console.warn("[scheduler] analytics collection sweep failed:", err?.message || err);
    analyticsSweep = { ok: false, error: err?.message || String(err) };
  }

  let creatorAnalyticsSweep = null;
  try {
    creatorAnalyticsSweep = await runCreatorAnalyticsCatchupSweep({ db: prisma, now });
  } catch (err) {
    console.warn("[scheduler] Creator Analytics recurring sweep failed:", err?.message || err);
    creatorAnalyticsSweep = { ok: false, error: err?.message || String(err) };
  }

  const recurringCreatorWork = await runRecurringCreatorWork({ db: prisma, now });
  const {
    creatorsScanned,
    pages: creatorPages,
    totalCreated,
    totalSkipped,
    dailyCyclesStarted,
    dailyCyclesSkipped,
  } = recurringCreatorWork;

  // Retention owns the detailed 180d boundary. Run it before the historical
  // Team backfill so deleted old detail is not immediately recreated.
  const retention = await maybeRunRetentionSweep({ now });
  let billingRenewals = null;
  try {
    billingRenewals = await renewDueCreatorSubscriptions({ now });
    if (billingRenewals?.scanned) {
      console.log(`[scheduler] billing renewals — scanned=${billingRenewals.scanned}, renewed=${billingRenewals.renewed}, balance=${billingRenewals.insufficientBalance}, earnings=${billingRenewals.earningsUnavailable}, skipped=${billingRenewals.skipped}`);
    }
  } catch (err) {
    console.warn("[scheduler] billing wallet renewal failed:", err?.message || err);
    billingRenewals = { ok: false, error: err?.message || String(err) };
  }
  let billingExpiry = null;
  try {
    // Renewal gets the first chance at the due boundary. Only after it either
    // succeeds or safely declines do we derive the workspace aggregate from
    // the resulting live entitlements.
    billingExpiry = await reconcileExpiredBillingStates({ now });
    if (billingExpiry?.scanned) {
      console.log(`[scheduler] billing expiry — scanned=${billingExpiry.scanned}, expired=${billingExpiry.expired}, repaired=${billingExpiry.repaired}`);
    }
  } catch (err) {
    console.warn("[scheduler] billing expiry reconciliation failed:", err?.message || err);
    billingExpiry = { ok: false, error: err?.message || String(err) };
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[scheduler] sweep done in ${elapsed}ms — creators=${creatorsScanned}, pages=${creatorPages}, jobs created=${totalCreated}, skipped=${totalSkipped}, daily started=${dailyCyclesStarted}, daily skipped=${dailyCyclesSkipped}`
  );

  return {
    creatorsScanned,
    creatorPages,
    jobsCreated: totalCreated,
    jobsSkipped: totalSkipped,
    dailyCyclesStarted,
    dailyCyclesSkipped,
    analyticsSweep,
    creatorAnalyticsSweep,
    retention,
    billingRenewals,
    billingExpiry,
  };
}

async function runRecurringSweep() {
  if (recurringSweepPromise) {
    return { ok: true, skipped: true, reason: "local_overlap" };
  }
  recurringSweepPromise = runRecurringSweepInternal();
  try {
    return await recurringSweepPromise;
  } finally {
    recurringSweepPromise = null;
  }
}

let recurringTimer = null;
let analyticsDemandTimer = null;
let phase2MaintenanceTimer = null;

/**
 * Start the recurring scheduler. Call once at server startup.
 * Returns a stop function for graceful shutdown.
 */
function startRecurringScheduler({ intervalMs = RECURRING_INTERVAL_MS, runImmediately = true } = {}) {
  if (recurringTimer) {
    console.warn("[scheduler] already running, ignoring start");
    return () => stopRecurringScheduler();
  }

  const tick = () => {
    runRecurringSweep().catch((err) => {
      console.error("[scheduler] sweep crashed:", err);
    });
  };

  if (runImmediately) {
    // Small delay so DB pool is fully ready and we don't compete with
    // first-request handling for connections.
    setTimeout(tick, 30 * 1000);
  }

  recurringTimer = setInterval(tick, intervalMs);

  const analyticsDemandTick = () => {
    runAnalyticsCollectionDemandSweep({ db: prisma }).catch((err) => {
      console.error("[scheduler] analytics demand sweep crashed:", err);
    });
  };
  if (runImmediately) setTimeout(analyticsDemandTick, 2 * 1000);
  analyticsDemandTimer = setInterval(analyticsDemandTick, ANALYTICS_DEMAND_INTERVAL_MS);

  const phase2MaintenanceTick = () => {
    runPhase2MaintenancePump({ db: prisma }).catch((err) => {
      console.error("[scheduler] Phase2 maintenance pump crashed:", err);
    });
  };
  if (runImmediately) setTimeout(phase2MaintenanceTick, 5 * 1000);
  phase2MaintenanceTimer = setInterval(phase2MaintenanceTick, PHASE2_MAINTENANCE_PUMP_INTERVAL_MS);

  console.log(`[scheduler] started (interval=${intervalMs}ms, phase2MaintenanceInterval=${PHASE2_MAINTENANCE_PUMP_INTERVAL_MS}ms, immediate=${runImmediately})`);

  return () => stopRecurringScheduler();
}

function stopRecurringScheduler() {
  if (recurringTimer) {
    clearInterval(recurringTimer);
    recurringTimer = null;
  }
  if (analyticsDemandTimer) {
    clearInterval(analyticsDemandTimer);
    analyticsDemandTimer = null;
  }
  if (phase2MaintenanceTimer) {
    clearInterval(phase2MaintenanceTimer);
    phase2MaintenanceTimer = null;
  }
  console.log("[scheduler] stopped");
}


module.exports = {
  scheduleInitialJobsForCreator,
  ensureSingleJob,
  scheduleJobNow,
  runRecurringSweep,
  runCreatorAnalyticsCatchupSweep,
  runRecurringCreatorWork,
  startRecurringScheduler,
  stopRecurringScheduler,
  RECURRING_INTERVAL_MS,
  FRESHNESS_WINDOW_MS,
  TRAFFIC_REFRESH_WINDOW_MS,
  RETENTION_SWEEP_WINDOW_MS,
  TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS,
  TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE,
  PHASE2_MAINTENANCE_PUMP_INTERVAL_MS,
  runPhase2MaintenancePump,
  runTelegramInboundProjectionSweep,
  runTelegramInboundProjectionMaintenanceSweep,
  runTelegramConfirmedProjectionSweep,
  runTelegramConfirmedProjectionMaintenanceSweep,
  runCustomExternalProofConvergenceSweep,
  runTeamDialogProjectionSweep,
  runTeamResponseRangeRepairSweep,
  runTeamMoneyReconciliationSweep,
  runTeamReadSummarySweep,
  maybeRunRetentionSweep,
  maybeReconcileHistoricalTeamMoney,
  maybeRepairLegacyTeamPendingBootstrap,
  maybeBackfillProviderOperationalDebt,
  maybeSeedPhase2CoverageWork,
  maybeRunPhase2HistoricalEnumeration,
  maybePlanDueCustomReminderWork,
  maybeRepairProviderOperationalDirty,
  maybeRunPhase2DependencyFanout,
};
