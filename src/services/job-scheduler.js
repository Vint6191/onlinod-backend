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
const { runSubscriberDirectoryMaintenance } = require("./subscriber-directory-maintenance-service");
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
const { runCampaignFanRefreshPromotionMaintenance } = require("./campaign-fan-refresh-queue-service");
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
  hasOutstandingDomainWork,
} = require("./domain-work-authority-service");
const { processTelegramAccountRetirementFanout } = require("./telegram-account-retirement-fanout-service");
const {
  FAMILY: PHASE2_COVERAGE_FAMILY,
  GENERATION: PHASE2_COVERAGE_GENERATION,
  ensurePhase2Coverage,
  markPhase2CoverageRunning,
  markPhase2CoverageComplete,
  markPhase2CoverageFailed,
  phase2CoverageStatus,
} = require("./phase2-work-coverage-authority-service");
const {
  COVERAGE_SEED_LANE_KEY: PHASE2_COVERAGE_SEED_LANE_KEY,
  COVERAGE_SEED_GENERATION: PHASE2_COVERAGE_SEED_GENERATION,
  COVERAGE_MANIFEST: PHASE2_COVERAGE_MANIFEST,
  COVERAGE_MANIFEST_VERSION: PHASE2_COVERAGE_MANIFEST_VERSION,
  coverageManifestFingerprint,
} = require("./phase2-coverage-manifest");
const { stampCollectionAuthorityParams } = require("./analytics-collector-control-service");
const {
  ensureOperationalAnalyticsFreshness,
  runAnalyticsCollectionSweep,
  runAnalyticsCollectionDemandSweep,
  claimAnalyticsSweepCycle,
  renewAnalyticsSweepLease,
  completeAnalyticsSweepCycle,
} = require("./analytics-collection-planner");
const { refreshProviderCapacityDebtSnapshot, readProviderCapacityDebtSnapshot } = require("./provider-capacity-debt-authority-service");
const { deriveProviderOverloadControl } = require("./provider-capacity-topology-control-service");

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
const CREATOR_RECURRING_PLANNING_BATCH_SIZE = Math.max(1, Math.min(100, Number.parseInt(process.env.CREATOR_RECURRING_PLANNING_BATCH_SIZE || "25", 10) || 25));
const CREATOR_RECURRING_PLANNING_MAX_RUNTIME_MS = Math.max(1_000, Math.min(60_000, Number.parseInt(process.env.CREATOR_RECURRING_PLANNING_MAX_RUNTIME_MS || "15000", 10) || 15_000));
const CREATOR_RECURRING_PLANNING_LEASE_MS = Math.max(60_000, Math.min(30 * 60_000, Number.parseInt(process.env.CREATOR_RECURRING_PLANNING_LEASE_MS || "900000", 10) || 900_000));
const CREATOR_RECURRING_PLANNING_PER_AGENCY_QUANTUM = Math.max(1, Math.min(25, Number.parseInt(process.env.CREATOR_RECURRING_PLANNING_PER_AGENCY_QUANTUM || "5", 10) || 5));
const CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP = Math.max(1, Math.min(20_000, Number.parseInt(process.env.CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP || "2400", 10) || 2400));
const CAMPAIGN_DIRECTORY_DISCOVERY_MAX_JOBS_PER_SWEEP = Math.max(1, Math.min(1000, Number.parseInt(process.env.CAMPAIGN_DIRECTORY_DISCOVERY_MAX_JOBS_PER_SWEEP || "100", 10) || 100));
const CAMPAIGN_DIRECTORY_PAGE_SIZE = 50;
let recurringSweepPromise = null;
let creatorAnalyticsSweepPromise = null;
let phase2MaintenancePromise = null;

const SCHEDULER_OUTCOME = Object.freeze({
  CREATED: "CREATED",
  NOOP: "NOOP",
  WAITING: "WAITING",
  DEGRADED: "DEGRADED",
});
const WAITING_REASON_PATTERN = /(?:waiting|not_ready|pending|deferred|already_in_flight|recently_done|idempotency_race|daily_limit|cooldown|lease_contended|legacy_executor_drain)/i;
let recurringSchedulerHealth = {
  status: "STARTING",
  consecutiveDegraded: 0,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastHealthyAt: null,
  lastDegradedAt: null,
  lastReason: null,
  lastDegraded: [],
};


function retentionBreakdown(result, laneNames) {
  const out = {};
  for (const name of laneNames) {
    const lane = result?.[name];
    if (!lane) continue;
    const items = Array.isArray(lane.items) ? lane.items : [];
    out[name] = {
      totalDeleted: Number(lane.totalDeleted || 0),
      items: Object.fromEntries(items
        .map((item) => [String(item?.label || "unknown"), Number(item?.deleted || 0)])),
      hasMore: lane?.hasMore === true,
      saturated: items.filter((item) => item?.saturated === true).map((item) => String(item?.label || "unknown")),
      workBudgetRows: items.reduce((max, item) => Math.max(max, Number(item?.workBudgetRows || 0)), 0),
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
    const laneNames = ["teamActivity", "teamLedgers", "traffic", "automation", "dialogIntelligence", "auditLogs", "authSessions", "creatorTaskActivity", "analyticsExecution"];
    const laneSummary = laneNames
      .map((name) => `${name}=${Number(result?.[name]?.totalDeleted || 0)}`)
      .join(", ");
    const breakdown = JSON.stringify(retentionBreakdown(result, laneNames));
    if (result?.ok === false) {
      console.warn(`[scheduler] retention sweep partial/failed in ${Date.now() - startedAt}ms — deleted=${result.totalDeleted || 0}; remainingWork=${result?.remainingWork === true}; ${laneSummary}; errors=${JSON.stringify(result.laneErrors || result.coordinationError || [])}; breakdown=${breakdown}`);
    } else if (result?.skipped) {
      console.log(`[scheduler] retention sweep skipped in ${Date.now() - startedAt}ms — reason=${result.reason || "unknown"}`);
    } else {
      console.log(`[scheduler] retention sweep done in ${Date.now() - startedAt}ms — deleted=${result.totalDeleted || 0}; remainingWork=${result?.remainingWork === true}; ${laneSummary}; breakdown=${breakdown}`);
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
 * @returns {Promise<{ ok: boolean, created: string[], skipped: string[], degraded: Array<{ work: string, reason: string, created: boolean }> }>}
 */
function schedulerDecisionNodes(value, path = "result", seen = new Set()) {
  if (!value || typeof value !== "object" || value instanceof Date || seen.has(value)) return [];
  seen.add(value);
  const nodes = [{ value, path }];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nodes.push(...schedulerDecisionNodes(entry, `${path}[${index}]`, seen)));
    return nodes;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!nested || typeof nested !== "object" || nested instanceof Date) continue;
    nodes.push(...schedulerDecisionNodes(nested, `${path}.${key}`, seen));
  }
  return nodes;
}

function schedulerCreated(value) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return false;
}

function normalizeSchedulerDecision(decision, { requireOk = true, reason = null, createdWhen = null } = {}) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return {
      outcome: SCHEDULER_OUTCOME.DEGRADED,
      ok: false,
      created: Boolean(createdWhen),
      reason: String(reason || "malformed_planner_result"),
      failures: [{ path: "result", reason: "malformed_planner_result" }],
    };
  }
  const nodes = schedulerDecisionNodes(decision);
  const failures = nodes
    .filter((node) => node.value?.ok === false)
    .map((node) => ({
      path: node.path,
      reason: String(node.value?.reason || node.value?.code || node.value?.error || "planner_reported_failure"),
    }));
  if (requireOk && typeof decision.ok !== "boolean") {
    failures.unshift({ path: "result", reason: "planner_result_missing_ok" });
  }
  const didCreate = createdWhen == null
    ? nodes.some((node) => schedulerCreated(node.value?.created) || schedulerCreated(node.value?.planned))
    : Boolean(createdWhen);
  const why = String(reason || decision.reason || failures[0]?.reason || (didCreate ? "created" : "nothing_due"));
  if (failures.length) {
    return { outcome: SCHEDULER_OUTCOME.DEGRADED, ok: false, created: didCreate, reason: why, failures };
  }
  if (didCreate) return { outcome: SCHEDULER_OUTCOME.CREATED, ok: true, created: true, reason: why, failures: [] };
  const waiting = WAITING_REASON_PATTERN.test(why);
  return {
    outcome: waiting ? SCHEDULER_OUTCOME.WAITING : SCHEDULER_OUTCOME.NOOP,
    ok: true,
    created: false,
    reason: why,
    failures: [],
  };
}

function recordDerivedSchedulerOutcome({ created, skipped, degraded, outcomes = null, work, decision, createdLabel = work, createdWhen = null, reason = null, requireOk = true }) {
  const normalized = normalizeSchedulerDecision(decision, { requireOk, reason, createdWhen });
  if (normalized.created) created.push(createdLabel);
  else skipped.push(`${work}:${normalized.reason}`);
  if (normalized.outcome === SCHEDULER_OUTCOME.DEGRADED) {
    degraded.push({
      work,
      reason: normalized.reason,
      created: normalized.created,
      failures: normalized.failures,
    });
  }
  if (Array.isArray(outcomes)) outcomes.push({ work, ...normalized });
  return normalized;
}

async function executeSchedulerConsumer({ work, execute, created, skipped, degraded, outcomes, createdLabel = work, createdWhen = null, reason = null, requireOk = true }) {
  let decision;
  try {
    decision = await execute();
  } catch (error) {
    decision = {
      ok: false,
      created: false,
      reason: error?.code || `${work}_exception`,
      error: String(error?.message || error),
    };
  }
  return {
    decision,
    normalized: recordDerivedSchedulerOutcome({
      created, skipped, degraded, outcomes, work, decision,
      createdLabel: typeof createdLabel === "function" ? createdLabel(decision) : createdLabel,
      createdWhen: typeof createdWhen === "function" ? createdWhen(decision) : createdWhen,
      reason: typeof reason === "function" ? reason(decision) : reason,
      requireOk,
    }),
  };
}

function schedulerPlanningResult(created, skipped, degraded, outcomes = []) {
  const ok = degraded.length === 0;
  return {
    ok,
    outcome: ok
      ? (created.length ? SCHEDULER_OUTCOME.CREATED : (outcomes.some((entry) => entry.outcome === SCHEDULER_OUTCOME.WAITING) ? SCHEDULER_OUTCOME.WAITING : SCHEDULER_OUTCOME.NOOP))
      : SCHEDULER_OUTCOME.DEGRADED,
    reason: ok ? null : degraded[0]?.reason || "derived_planning_degraded",
    created,
    skipped,
    degraded,
    outcomes,
  };
}

async function scheduleInitialJobsForCreator({
  db = prisma,
  creatorId,
  agencyId,
  priority = 50,
  creator = null,
  includeAnalyticsCatchups = false,
  includeEarningsFreshness = true,
  includeCreatorAnalytics = true,
}) {
  if (!creatorId || !agencyId) {
    return schedulerPlanningResult([], [], [{ work: "creator_scope", reason: "missing_scope", created: false, failures: [{ path: "input", reason: "missing_scope" }] }], []);
  }
  const creatorRemoteId = creator?.remoteId || creator?.userId || null;
  const creatorUsername = creator?.username || null;
  const creatorDisplayName = creator?.displayName || null;

  const created = [];
  const skipped = [];
  const degraded = [];
  const outcomes = [];
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
        db, creatorId, agencyId, now, priority: Math.max(80, priority),
      });
      if (initial.created) created.push(`creator_analytics_initial:${initial.stage}`);
      else skipped.push(`creator_analytics_initial:${initial.stage}:${initial.reason || "waiting"}`);
      if (!initial.ready) {
        const failedTerminal = ["failed_terminal", "missing_scope"].includes(String(initial.reason || ""));
        const normalized = {
          work: "creator_analytics_initial",
          outcome: failedTerminal ? SCHEDULER_OUTCOME.DEGRADED : SCHEDULER_OUTCOME.WAITING,
          ok: !failedTerminal,
          created: Boolean(initial.created),
          reason: String(initial.reason || "waiting"),
          failures: failedTerminal ? [{ path: "result", reason: String(initial.reason) }] : [],
        };
        outcomes.push(normalized);
        if (failedTerminal) degraded.push({ work: normalized.work, reason: normalized.reason, created: normalized.created, failures: normalized.failures });
        return schedulerPlanningResult(created, skipped, degraded, outcomes);
      }
      outcomes.push({ work: "creator_analytics_initial", outcome: initial.created ? SCHEDULER_OUTCOME.CREATED : SCHEDULER_OUTCOME.NOOP, ok: true, created: Boolean(initial.created), reason: initial.reason || "initial_sync_complete", failures: [] });

      if (includeAnalyticsCatchups) {
        const catchups = await ensureRecurringCreatorAnalyticsCatchups({
          db, creatorId, agencyId, now, priority: Math.max(15, priority - 10),
        });
        created.push(...(catchups.created || []));
        skipped.push(...(catchups.skipped || []));
      }
    } else {
      const ready = await creatorAnalyticsInitialSyncReady({ db, creatorId, now });
      if (!ready) {
        skipped.push("creator_analytics_initial:waiting:distributed_sweep");
        outcomes.push({ work: "creator_analytics_initial", outcome: SCHEDULER_OUTCOME.WAITING, ok: true, created: false, reason: "distributed_sweep", failures: [] });
        return schedulerPlanningResult(created, skipped, degraded, outcomes);
      }
      outcomes.push({ work: "creator_analytics_initial", outcome: SCHEDULER_OUTCOME.NOOP, ok: true, created: false, reason: "initial_sync_complete", failures: [] });
    }
  } catch (err) {
    const reason = err?.code || "creator_analytics_exception";
    skipped.push(`creator_analytics:${reason}`);
    const failure = { work: "creator_analytics", reason, created: false, failures: [{ path: "exception", reason, error: String(err?.message || err) }] };
    degraded.push(failure);
    outcomes.push({ ...failure, outcome: SCHEDULER_OUTCOME.DEGRADED, ok: false });
    // Fail closed for automatic read work. If bootstrap state cannot be proven,
    // do not start other creator-wide OF scans that can race its recovery.
    return schedulerPlanningResult(created, skipped, degraded, outcomes);
  }

  // Earnings collection is no longer display-range scheduling. A single
  // coverage/freshness planner owns exact provider windows.
  if (includeEarningsFreshness) {
    await executeSchedulerConsumer({
      work: "earnings_freshness",
      created,
      skipped,
      degraded,
      outcomes,
      requireOk: false,
      createdLabel: "fetch_earnings",
      execute: () => ensureOperationalAnalyticsFreshness({
        db, creatorId, agencyId, reason: "INITIAL_SYNC", priority, now,
      }),
    });
  }

  // Traffic/member attribution stays independent once bootstrap no longer owns
  // the read lane.
  await executeSchedulerConsumer({
    work: "traffic_sources_scan",
    created,
    skipped,
    degraded,
    outcomes,
    requireOk: false,
    execute: () => ensureSingleJob({
      db,
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
    }),
  });

  // Subscriber Directory — one shared weekly source for Hidden Online,
  // Follow Back candidates and future subscriber-driven modules.
  await executeSchedulerConsumer({
    work: "subscriber_directory_scan",
    created,
    skipped,
    degraded,
    outcomes,
    execute: () => ensureSubscriberScanDue({
      db, agencyId, creatorId, priority: Math.max(5, priority - 30), now,
    }),
  });

  // Follow Back candidate planning is backend orchestration over the already
  // published Subscriber Directory projection. It never starts another OF scan.
  await executeSchedulerConsumer({
    work: "follow_back_plan", created, skipped, degraded, outcomes,
    execute: () => ensureAutomaticFollowBack({ agencyId, creatorId, source: "recurring_scheduler", db }),
  });

  await executeSchedulerConsumer({
    work: "bumps_plan", created, skipped, degraded, outcomes,
    createdLabel: (decision) => `bumps_plan:${Number(decision?.planned || 0)}`,
    execute: () => ensureAutomaticBumps({ agencyId, creatorId, source: "recurring_scheduler", db }),
  });

  await executeSchedulerConsumer({
    work: "likes_plan", created, skipped, degraded, outcomes,
    execute: () => ensureAutomaticLikes({ agencyId, creatorId, source: "recurring_scheduler", db }),
  });

  await executeSchedulerConsumer({
    work: "follow_automation_plan", created, skipped, degraded, outcomes,
    execute: () => ensureAutomaticFollowAutomation({ agencyId, creatorId, source: "recurring_scheduler", db }),
  });

  await executeSchedulerConsumer({
    work: "sfs_plan", created, skipped, degraded, outcomes,
    execute: () => ensureAutomaticSfs({ agencyId, creatorId, source: "recurring_scheduler", db }),
  });

  return schedulerPlanningResult(created, skipped, degraded, outcomes);
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
async function ensureSingleJob({ db = prisma, jobKey, creatorId, agencyId, params, priority, now, freshnessWindowMs }) {
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
  const keyed = await db.jobInstance.findUnique({ where: { idempotencyKey } });
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
  const existing = await db.jobInstance.findMany({
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
    db,
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
        for (const [family, generation] of PHASE2_COVERAGE_MANIFEST) {
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
        progress: {
          manifestVersion: PHASE2_COVERAGE_MANIFEST_VERSION,
          manifestFingerprint: coverageManifestFingerprint(),
          scannedAgencies: Number(claim?.progress?.scannedAgencies || 0) + agencies.length,
          published: Number(claim?.progress?.published || 0) + published,
        },
      };
    },
  });
}

async function runProviderCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { selectProviderOperationalBackfillBatch, reconcileProviderOperationalDebtForOrder } = require("./provider-operational-debt-authority-service");
  const family = PHASE2_COVERAGE_FAMILY.PROVIDER_OPERATIONAL;
  const generation = PHASE2_COVERAGE_GENERATION.PROVIDER_OPERATIONAL;
  const cursor = String(item?.progressCursor?.lastOrderId || item?.progressCursor?.lastId || "").trim() || null;
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: lastOrderId });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastOrderId }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: lastOrderId, projectedThrough: lastOrderId, unresolvedCount: 0, fallbackNow: now });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, projected, complete: true };
}

async function runExternalCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { convergeHistoricalCustomExternalProofs } = require("./custom-external-proof-convergence-service");
  const family = PHASE2_COVERAGE_FAMILY.CUSTOM_EXTERNAL_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.CUSTOM_EXTERNAL_PROJECTION;
  const cursor = String(item?.progressCursor?.lastSubmissionId || "").trim() || null;
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await convergeHistoricalCustomExternalProofs({ agencyId: item.agencyId, cursor, limit: 200, db });
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.ok === false || Number(batch?.failed || 0) > 0) {
    await markPhase2CoverageFailed({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, Number(batch?.failed || 0)) });
    const error = new Error("CUSTOM_EXTERNAL_COVERAGE_ENUMERATION_FAILED"); error.code = "CUSTOM_EXTERNAL_COVERAGE_ENUMERATION_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastSubmissionId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runCustomSourcePipelineCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.CUSTOM_SOURCE_PIPELINE;
  const generation = PHASE2_COVERAGE_GENERATION.CUSTOM_SOURCE_PIPELINE;
  const cursor = String(item?.progressCursor?.lastSubmissionId || "").trim() || null;
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastSubmissionId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }

  // Enumeration is not activation. Existing source work can be owned by a Desktop
  // for several minutes while Telegram/OnlyFans execution is in flight. Coverage is
  // COMPLETE only when every enumerated/live source revision has reached DONE.
  const outstanding = await hasOutstandingDomainWork({
    db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.CUSTOM_SOURCE_PIPELINE,
  });
  if (outstanding !== false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastSubmissionId: nextCursor }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: "domain_work_converged", unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTeamActivityCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const { backfillActivityContributionBatch } = require("./team-activity-contribution-authority-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_ACTIVITY_CONTRIBUTION;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_ACTIVITY_CONTRIBUTION;
  const cursor = String(item?.progressCursor?.lastEventId || "").trim() || null;
  const previousUnresolved = Math.max(0, Number(item?.progressCursor?.unresolved || 0));
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await backfillActivityContributionBatch({ db, agencyId: item.agencyId, cursor, limit: 100 });
  if (batch?.ok === false) {
    await markPhase2CoverageFailed({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, previousUnresolved + Number(batch?.unresolved || 0)) });
    const error = new Error(batch?.code || "TEAM_ACTIVITY_CONTRIBUTION_BACKFILL_FAILED"); error.code = batch?.code || "TEAM_ACTIVITY_CONTRIBUTION_BACKFILL_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  const unresolved = previousUnresolved + Number(batch?.unresolved || 0);
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastEventId: nextCursor, unresolved }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({
    db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor,
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
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await backfillTeamResponseRangeBatch({ db, agencyId: item.agencyId, cursor, limit: 100 });
  if (batch?.ok === false) {
    await markPhase2CoverageFailed({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, previousUnresolved + Number(batch?.unresolved || 0)) });
    const error = new Error(batch?.code || "TEAM_RESPONSE_RANGE_REPAIR_FAILED"); error.code = batch?.code || "TEAM_RESPONSE_RANGE_REPAIR_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  const unresolved = previousUnresolved + Number(batch?.unresolved || 0);
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastCaseId: nextCursor, unresolved }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({
    db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor,
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
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastEventId: null }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  const ack = await ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
  return { ...ack, complete: true, published };
}

async function runTeamMoneyRootClassificationUnit({ db, item, ownerToken, now }) {
  const { classifyTeamMoneyRootsBatch } = require("./team-money-root-classification-service");
  const family = PHASE2_COVERAGE_FAMILY.TEAM_MONEY_ROOT_CLASSIFICATION;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_MONEY_ROOT_CLASSIFICATION;
  const cursor = String(item?.progressCursor?.lastFactId || "").trim() || null;
  const previousUnresolved = Math.max(0, Number(item?.progressCursor?.unresolved || 0));
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
  const batch = await classifyTeamMoneyRootsBatch({ db, agencyId: item.agencyId, cursor, limit: 100 });
  if (batch?.ok === false) {
    await markPhase2CoverageFailed({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor, unresolvedCount: Math.max(1, previousUnresolved) });
    const error = new Error(batch?.code || "TEAM_MONEY_ROOT_CLASSIFICATION_FAILED"); error.code = batch?.code || "TEAM_MONEY_ROOT_CLASSIFICATION_FAILED";
    return failDomainWorkClaim({ db, item, ownerToken, error, fallbackNow: new Date() });
  }
  const unresolved = previousUnresolved + Math.max(0, Number(batch?.unresolved || 0));
  const nextCursor = String(batch?.nextCursor || cursor || "").trim() || null;
  if (batch?.complete === false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastFactId: nextCursor, unresolved }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: unresolved, fallbackNow: now });
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
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId, family, generation, enumeratedThrough: JSON.stringify(progress) });

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
      await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId, family, generation, enumeratedThrough: `${phase}:${nextId}` });
      return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase, lastId: nextId }, availableAt: now, fallbackNow: new Date() });
    }
    if (phase === "sales") {
      return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase: "tips", lastId: null }, availableAt: now, fallbackNow: new Date() });
    }
  }

  // Enumeration alone is not activation. Wait until every exact current/historical
  // money item published for this agency has reached the requested revision.
  const outstanding = await hasOutstandingDomainWork({
    db, agencyId, workClass: PHASE2_WORK_CLASS.TEAM_MONEY_RECONCILIATION,
  });
  if (outstanding !== false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId, family, generation, enumeratedThrough: "sources_enumerated" });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { phase: "verify" }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId, family, generation, enumeratedThrough: "sources_enumerated", projectedThrough: "domain_work_converged", unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTeamReadSummaryCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.TEAM_READ_SUMMARY;
  const generation = PHASE2_COVERAGE_GENERATION.TEAM_READ_SUMMARY;
  const cursor = String(item?.progressCursor?.lastFactId || "").trim() || null;
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
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
  const outstanding = await hasOutstandingDomainWork({
    db, agencyId: String(item.agencyId), workClass: PHASE2_WORK_CLASS.TEAM_READ_SUMMARY,
  });
  if (Number(missing?.length || 0) > 0 || outstanding !== false) {
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastFactId: nextCursor }, availableAt: new Date(now.getTime() + 1000), fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTelegramConfirmedCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.TELEGRAM_CONFIRMED_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.TELEGRAM_CONFIRMED_PROJECTION;
  const cursor = String(item?.progressCursor?.lastIntentId || "").trim() || null;
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastIntentId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
  return ackDomainWorkClaim({ db, item, ownerToken, fallbackNow: new Date() });
}

async function runTelegramInboundCoverageEnumerationUnit({ db, item, ownerToken, now }) {
  const family = PHASE2_COVERAGE_FAMILY.TELEGRAM_INBOUND_PROJECTION;
  const generation = PHASE2_COVERAGE_GENERATION.TELEGRAM_INBOUND_PROJECTION;
  const cursor = String(item?.progressCursor?.lastInboundEventId || "").trim() || null;
  await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: cursor });
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
    await markPhase2CoverageRunning({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor });
    return yieldDomainWorkClaim({ db, item, ownerToken, progressCursor: { lastInboundEventId: nextCursor }, availableAt: now, fallbackNow: new Date() });
  }
  await markPhase2CoverageComplete({ db, workItem: item, ownerToken, agencyId: item.agencyId, family, generation, enumeratedThrough: nextCursor, projectedThrough: nextCursor, unresolvedCount: 0, fallbackNow: now });
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
      await markPhase2CoverageFailed({ db, workItem: item, ownerToken: claim.ownerToken, agencyId: item.agencyId,
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
      if (String(item.objectType) === "TelegramAccountRetirement") {
        const retirement = await processTelegramAccountRetirementFanout({ db, item, now });
        if (retirement.complete === false) {
          const yielded = await yieldDomainWorkClaim({
            db,
            item,
            ownerToken: claim.ownerToken,
            progressCursor: retirement.progressCursor || null,
            availableAt: now,
            fallbackNow: new Date(),
          });
          if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
        } else {
          const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
          if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
        }
        continue;
      }

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
      const result = await projectCreatorDialogWorkItem({
        agencyId: String(item.agencyId), ...identity, db, limit: 100, progressCursor: item?.progressCursor || null,
      });
      report.projected += Number(result?.projected || 0);
      if (result?.hasMore) {
        const nextProgressCursor = result?.nextProgressCursor || null;
        const yielded = await yieldDomainWorkClaim({
          db, item, ownerToken: claim.ownerToken, availableAt: now,
          progressCursor: nextProgressCursor, fallbackNow: new Date(),
          preserveProgressOnNewerRevision: Boolean(nextProgressCursor?.pendingRepair),
        });
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

async function runAgencyDestructiveCleanupSweep({ now = new Date(), db = prisma } = {}) {
  const { processAgencyHardDeleteWorkItem } = require("./phase2-destructive-delete-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP,
    limit: 2, perAgencyQuantum: 1, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), completed: 0, yielded: 0, deletedRows: 0, workUnits: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      const result = await processAgencyHardDeleteWorkItem({ db, item, ownerToken: claim.ownerToken, batchSize: 250, fallbackNow: now });
      report.deletedRows += Number(result?.deleted || 0);
      report.workUnits += Number(result?.workUnits || 0);
      if (result?.lost) { report.lostOwnership += 1; continue; }
      if (result?.ok === false) throw Object.assign(new Error(result?.code || "AGENCY_DESTRUCTIVE_CLEANUP_FAILED"), { code: result?.code || "AGENCY_DESTRUCTIVE_CLEANUP_FAILED" });
      if (result?.complete) {
        // Final Agency deletion cascades this very DomainWorkItem. Its absence is the
        // terminal proof, so attempting a post-delete ACK would manufacture a false lost-owner event.
        if (result?.identityDeleted) report.completed += 1;
        else {
          const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
          if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
        }
      } else {
        const delayMs = String(result?.phase || "").startsWith("WAIT_") ? 1000 : 250;
        const yielded = await yieldDomainWorkClaim({
          db, item, ownerToken: claim.ownerToken,
          progressCursor: { phase: result?.phase || "CLEANUP", deletedRows: report.deletedRows, workUnits: report.workUnits },
          availableAt: new Date(now.getTime() + delayMs), fallbackNow: new Date(),
        });
        if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
      }
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: new Date() }).catch(() => ({ lost: true }));
      if (failed?.lost) report.lostOwnership += 1; else report.failed += 1;
    }
  }
  report.ok = report.failed === 0 && report.lostOwnership === 0;
  return report;
}

async function runCreatorDestructiveCleanupSweep({ now = new Date(), db = prisma } = {}) {
  const { processCreatorHardDeleteWorkItem } = require("./phase2-destructive-delete-authority-service");
  const claim = await claimDomainWorkBatch({
    db, workClass: PHASE2_WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP,
    limit: 10, perAgencyQuantum: 2, perPartitionQuantum: 1,
    leaseMs: 2 * 60 * 1000, fallbackNow: now,
  });
  const report = { ok: true, selected: Number(claim?.items?.length || 0), completed: 0, yielded: 0, deletedRows: 0, failed: 0, lostOwnership: 0 };
  for (const item of claim?.items || []) {
    try {
      const result = await processCreatorHardDeleteWorkItem({ db, item, ownerToken: claim.ownerToken, batchSize: 250, fallbackNow: now });
      report.deletedRows += Number(result?.deleted || 0);
      if (result?.lost) { report.lostOwnership += 1; continue; }
      if (result?.ok === false) throw Object.assign(new Error(result?.code || "CREATOR_DESTRUCTIVE_CLEANUP_FAILED"), { code: result?.code || "CREATOR_DESTRUCTIVE_CLEANUP_FAILED" });
      if (result?.complete) {
        const ack = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: new Date() });
        if (ack?.lost) report.lostOwnership += 1; else report.completed += 1;
      } else {
        const yielded = await yieldDomainWorkClaim({
          db, item, ownerToken: claim.ownerToken,
          progressCursor: { phase: result?.phase || "CLEANUP", deletedRows: report.deletedRows },
          availableAt: new Date(now.getTime() + 250), fallbackNow: new Date(),
        });
        if (yielded?.lost) report.lostOwnership += 1; else report.yielded += 1;
      }
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


function estimatedCampaignDirectoryPages(state) {
  const count = Math.max(0, Number(state?.campaignDirectoryCampaignCount || 0));
  // Source-exhaustive traversal needs the terminal page as well. Existing exact
  // count is the best server-owned cost estimate; a creator with no prior
  // directory still reserves one page and claim-time concurrency is the second
  // backpressure layer if reality is larger.
  return Math.max(1, Math.ceil(count / CAMPAIGN_DIRECTORY_PAGE_SIZE) + 1);
}

async function selectCampaignDirectoryDiscoveryAdmissions({
  db = prisma, now = new Date(),
  pageBudget = CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP,
  maxJobs = CAMPAIGN_DIRECTORY_DISCOVERY_MAX_JOBS_PER_SWEEP,
} = {}) {
  if (typeof db?.creatorCampaignCollectionState?.findMany !== "function") {
    return { admittedCreatorIds: null, estimatedProviderPages: 0, considered: 0, reason: "adapter_without_campaign_state_scan" };
  }
  const safePageBudget = Math.max(1, Math.floor(Number(pageBudget) || CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP));
  const safeMaxJobs = Math.max(1, Math.floor(Number(maxJobs) || CAMPAIGN_DIRECTORY_DISCOVERY_MAX_JOBS_PER_SWEEP));
  // A fixed "oldest N" window can itself become a starvation source: if the
  // head is dominated by creators whose Campaign job is already active, later
  // overdue creators are never even considered. Page the whole due set until
  // capacity is filled or the source is exhausted. The provider-page budget
  // and maxJobs still bound actual admissions; this scan is DB-only.
  const scanPageSize = Math.min(1000, Math.max(250, safeMaxJobs * 5));
  const admitted = new Set();
  let estimatedProviderPages = 0;
  let considered = 0;
  let pageCursor = null;
  let stopForBudget = false;

  while (admitted.size < safeMaxJobs && !stopForBudget) {
    const pagination = pageCursor
      ? (pageCursor.dueAt === null
        ? {
          OR: [
            { campaignDirectoryDiscoveryDueAt: null, creatorId: { gt: pageCursor.creatorId } },
            { campaignDirectoryDiscoveryDueAt: { not: null, lte: now } },
          ],
        }
        : {
          OR: [
            { campaignDirectoryDiscoveryDueAt: { gt: pageCursor.dueAt, lte: now } },
            { campaignDirectoryDiscoveryDueAt: pageCursor.dueAt, creatorId: { gt: pageCursor.creatorId } },
          ],
        })
      : null;
    const candidates = await db.creatorCampaignCollectionState.findMany({
      where: {
        baselineVerifiedAt: { not: null },
        AND: [
          {
            OR: [
              { campaignDirectoryDiscoveryDueAt: null },
              { campaignDirectoryDiscoveryDueAt: { lte: now } },
            ],
          },
          {
            OR: [
              { retryAfterAt: null },
              { retryAfterAt: { lte: now } },
            ],
          },
          {
            OR: [
              { status: { not: "FAILED" } },
              { retryAfterAt: { not: null } },
            ],
          },
          ...(pagination ? [pagination] : []),
        ],
      },
      orderBy: [
        { campaignDirectoryDiscoveryDueAt: { sort: "asc", nulls: "first" } },
        { creatorId: "asc" },
      ],
      take: scanPageSize,
      select: { creatorId: true, campaignDirectoryCampaignCount: true, campaignDirectoryDiscoveryDueAt: true, status: true, retryAfterAt: true },
    });
    if (!candidates.length) break;
    considered += candidates.length;

    const active = typeof db?.jobInstance?.findMany === "function"
      ? await db.jobInstance.findMany({
        where: { creatorId: { in: candidates.map((row) => row.creatorId) }, jobKey: "fetch_campaigns", status: { in: ["SCHEDULED", "CLAIMED", "PAUSED"] } },
        select: { creatorId: true },
        distinct: ["creatorId"],
        take: Math.min(10_000, candidates.length),
      })
      : [];
    const activeIds = new Set((active || []).map((row) => String(row.creatorId || "")).filter(Boolean));

    for (const row of candidates) {
      if (admitted.size >= safeMaxJobs) break;
      if (activeIds.has(row.creatorId)) continue;
      // Retry/terminal eligibility is pushed into the DB where-clause, but
      // retain the source-side guard for compatibility with in-memory adapters
      // that ignore query predicates.
      const retryAt = row?.retryAfterAt ? new Date(row.retryAfterAt) : null;
      if (retryAt && Number.isFinite(retryAt.getTime()) && retryAt.getTime() > now.getTime()) continue;
      if (String(row?.status || "").toUpperCase() === "FAILED" && !retryAt) continue;
      const cost = estimatedCampaignDirectoryPages(row);
      // Strict oldest-due fairness: once an eligible older creator would exceed
      // the remaining budget, do not let cheaper newer creators jump ahead.
      // The first eligible creator is always admitted so an oversized oldest
      // creator can make progress instead of becoming permanently impossible.
      if (admitted.size > 0 && estimatedProviderPages + cost > safePageBudget) {
        stopForBudget = true;
        break;
      }
      admitted.add(row.creatorId);
      estimatedProviderPages += cost;
      if (estimatedProviderPages >= safePageBudget) {
        stopForBudget = true;
        break;
      }
    }

    if (stopForBudget || admitted.size >= safeMaxJobs || candidates.length < scanPageSize) break;
    const last = candidates[candidates.length - 1];
    pageCursor = {
      dueAt: last?.campaignDirectoryDiscoveryDueAt ? new Date(last.campaignDirectoryDiscoveryDueAt) : null,
      creatorId: String(last?.creatorId || ""),
    };
    if (!pageCursor.creatorId) break;
  }
  return { admittedCreatorIds: admitted, estimatedProviderPages, considered, reason: "oldest_due_keyset_budget" };
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
    let providerCapacityControl = null;
    let preAdmissionCapacityDebt = null;
    try {
      // A19: sample canonical debt BEFORE directory admission. Reading a previously
      // persisted two-hour-old HEALTHY snapshot first can admit a full normal
      // directory budget even when new unknown-cardinality background work arrived
      // since that sample. The sweep lease already serializes this control cycle,
      // so refresh the derived projection first and derive admission from that exact
      // sample.
      preAdmissionCapacityDebt = await refreshProviderCapacityDebtSnapshot({ db, now: cycleNow });
      const freshCapacitySnapshot = preAdmissionCapacityDebt?.computed
        || await readProviderCapacityDebtSnapshot({ db });
      providerCapacityControl = deriveProviderOverloadControl({
        snapshot: freshCapacitySnapshot,
        now: cycleNow,
        normalDirectoryAdmissionCalls: CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP,
      });
      if (preAdmissionCapacityDebt?.ok !== true) {
        providerCapacityControl = deriveProviderOverloadControl({
          snapshot: null,
          now: cycleNow,
          normalDirectoryAdmissionCalls: CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP,
        });
        providerCapacityControl.sampleError = preAdmissionCapacityDebt?.reason || "capacity_projection_not_persisted";
      }
    } catch (error) {
      // Sampling failure is fail-conservative. Canonical debt remains untouched;
      // only NEW periodic directory admission is reduced to guaranteed capacity.
      providerCapacityControl = deriveProviderOverloadControl({
        snapshot: null,
        now: cycleNow,
        normalDirectoryAdmissionCalls: CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP,
      });
      providerCapacityControl.sampleError = error?.message || String(error);
    }
    const directoryAdmission = await selectCampaignDirectoryDiscoveryAdmissions({
      db,
      now: cycleNow,
      pageBudget: providerCapacityControl.campaignDirectoryAdmissionBudgetCalls,
    });
    const directoryAdmittedIds = directoryAdmission.admittedCreatorIds;
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
            campaignDirectoryDiscoveryAdmitted: directoryAdmittedIds === null || directoryAdmittedIds.has(creator.id),
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

    let providerCapacityDebt = null;
    try {
      providerCapacityDebt = await refreshProviderCapacityDebtSnapshot({ db, now: cycleNow });
    } catch (error) {
      // Capacity debt is a derived projection. A transient projection failure
      // must not replay already-scheduled provider work; sampledAt/revision make
      // staleness explicit to readers and the next sweep repairs it.
      providerCapacityDebt = { ok: false, persisted: false, reason: "capacity_projection_failed", error: error?.message || String(error) };
      console.warn("[scheduler] provider capacity debt projection failed:", error?.message || error);
    }

    const completed = await completeAnalyticsSweepCycle({
      db,
      ownerToken: claim.ownerToken,
      cycleKey: claim.cycleKey,
      cursorCreatorId: cursor,
      leaseKey: CREATOR_ANALYTICS_SWEEP_LEASE_KEY,
    });
    if (!completed) {
      return { ok: false, skipped: true, reason: "cycle_completion_lost", cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures, providerCapacityDebt };
    }
    return {
      ok: true, skipped: false, cycleKey: claim.cycleKey, creators, pages, jobsCreated, jobsSkipped, failures, pageSize: size, providerCapacityDebt,
      campaignDirectoryAdmission: {
        admitted: directoryAdmittedIds === null ? null : directoryAdmittedIds.size,
        estimatedProviderPages: Number(directoryAdmission.estimatedProviderPages || 0),
        considered: Number(directoryAdmission.considered || 0),
        controlMode: providerCapacityControl?.controlMode || "CONSERVATIVE",
        controlReason: providerCapacityControl?.controlReason || null,
        pageBudget: Number(providerCapacityControl?.campaignDirectoryAdmissionBudgetCalls || 0),
        topologyId: providerCapacityControl?.topology?.topologyId || "of-global",
        topologyShardCount: Number(providerCapacityControl?.topology?.shardCount || 1),
        preAdmissionSampled: preAdmissionCapacityDebt?.ok === true,
        preAdmissionSampleError: providerCapacityControl?.sampleError || null,
      },
    };
  })();

  try {
    return await creatorAnalyticsSweepPromise;
  } finally {
    creatorAnalyticsSweepPromise = null;
  }
}

async function runRecurringCreatorWork({
  db = prisma,
  now = new Date(),
  batchSize = CREATOR_RECURRING_PLANNING_BATCH_SIZE,
  pageSize = null,
  maxRuntimeMs = CREATOR_RECURRING_PLANNING_MAX_RUNTIME_MS,
  ownerToken = undefined,
} = {}) {
  const size = Math.max(1, Math.min(100, Number(pageSize ?? batchSize) || CREATOR_RECURRING_PLANNING_BATCH_SIZE));
  const runtimeBudget = Math.max(1_000, Math.min(60_000, Number(maxRuntimeMs) || CREATOR_RECURRING_PLANNING_MAX_RUNTIME_MS));
  const startedAt = Date.now();
  let claim;
  try {
    claim = await claimDomainWorkBatch({
      db,
      workClass: PHASE2_WORK_CLASS.CREATOR_RECURRING_PLANNING,
      ...(ownerToken ? { ownerToken } : {}),
      limit: size,
      perAgencyQuantum: Math.min(size, CREATOR_RECURRING_PLANNING_PER_AGENCY_QUANTUM),
      perPartitionQuantum: 1,
      leaseMs: CREATOR_RECURRING_PLANNING_LEASE_MS,
      fallbackNow: now,
    });
  } catch (error) {
    return {
      ok: false,
      outcome: SCHEDULER_OUTCOME.DEGRADED,
      reason: error?.code || "recurring_planning_claim_failed",
      error: String(error?.message || error),
      creatorsScanned: 0,
      pages: 0,
      totalCreated: 0,
      totalSkipped: 0,
      totalDegraded: 1,
      degradedCreators: [],
      dailyCyclesStarted: 0,
      dailyCyclesSkipped: 0,
      selected: 0,
      yieldedForBudget: 0,
      lostOwnership: 0,
      pageSize: size,
      durationMs: Date.now() - startedAt,
    };
  }

  const items = Array.isArray(claim?.items) ? claim.items : [];
  if (claim?.skipped && !["legacy_executor_drain"].includes(String(claim.reason || ""))) {
    return {
      ok: false,
      outcome: SCHEDULER_OUTCOME.DEGRADED,
      reason: claim.reason || "recurring_planning_claim_skipped",
      creatorsScanned: 0,
      pages: 0,
      totalCreated: 0,
      totalSkipped: 0,
      totalDegraded: 1,
      degradedCreators: [],
      dailyCyclesStarted: 0,
      dailyCyclesSkipped: 0,
      selected: 0,
      yieldedForBudget: 0,
      lostOwnership: 0,
      pageSize: size,
      durationMs: Date.now() - startedAt,
    };
  }

  let creatorsScanned = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalDegraded = 0;
  const degradedCreators = [];
  const processedCreatorIds = [];
  let dailyCyclesStarted = 0;
  let dailyCyclesSkipped = 0;
  let retired = 0;
  let retried = 0;
  let yielded = 0;
  let yieldedForBudget = 0;
  let lostOwnership = 0;

  for (let index = 0; index < items.length; index += 1) {
    if (Date.now() - startedAt >= runtimeBudget) {
      const remaining = items.slice(index);
      const releases = await Promise.all(remaining.map((item) => yieldDomainWorkClaim({
        db,
        item,
        ownerToken: claim.ownerToken,
        availableAt: claim.authorityNow || now,
        fallbackNow: now,
      }).catch(() => ({ yielded: false, lost: true }))));
      yieldedForBudget += releases.filter((entry) => entry?.yielded).length;
      lostOwnership += releases.filter((entry) => !entry?.yielded).length;
      break;
    }

    const item = items[index];
    const heartbeat = await heartbeatDomainWorkClaim({
      db,
      item,
      ownerToken: claim.ownerToken,
      leaseMs: CREATOR_RECURRING_PLANNING_LEASE_MS,
      fallbackNow: now,
    }).catch(() => ({ renewed: false, lost: true }));
    if (!heartbeat?.renewed) {
      lostOwnership += 1;
      continue;
    }

    let creator;
    try {
      creator = await db.creatorAccount.findFirst({
        where: {
          id: String(item.creatorId || item.objectId || ""),
          agencyId: String(item.agencyId || ""),
          status: "READY",
          deletedAt: null,
          agency: { deletedAt: null },
        },
        select: { id: true, agencyId: true, remoteId: true, username: true, displayName: true },
      });
    } catch (error) {
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: now }).catch(() => ({ failed: false, lost: true }));
      if (failed?.failed) retried += 1;
      else lostOwnership += 1;
      totalDegraded += 1;
      degradedCreators.push({ creatorId: item.creatorId || item.objectId || null, issues: [{ work: "creator_lookup", reason: error?.code || "creator_lookup_failed", error: String(error?.message || error) }] });
      continue;
    }

    if (!creator) {
      const acknowledged = await ackDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, fallbackNow: now }).catch(() => ({ acknowledged: false, lost: true }));
      if (acknowledged?.acknowledged) retired += 1;
      else lostOwnership += 1;
      continue;
    }

    const creatorIssues = [];
    let planning;
    try {
      planning = await scheduleInitialJobsForCreator({
        db,
        creatorId: creator.id,
        agencyId: creator.agencyId,
        creator,
        priority: 30,
        includeAnalyticsCatchups: false,
        includeEarningsFreshness: false,
        includeCreatorAnalytics: false,
      });
      totalCreated += Number(planning?.created?.length || 0);
      totalSkipped += Number(planning?.skipped?.length || 0);
      if (!planning || planning.ok === false || !Array.isArray(planning.degraded)) {
        creatorIssues.push(...(Array.isArray(planning?.degraded) && planning.degraded.length
          ? planning.degraded
          : [{ work: "creator_planning", reason: planning?.reason || "malformed_creator_planning_result" }]));
      }
    } catch (error) {
      creatorIssues.push({ work: "creator_planning", reason: error?.code || "creator_planning_exception", error: String(error?.message || error) });
    }

    try {
      const { ensureDailyVaultIntelligenceCycle } = require("./vault-intelligence-daily-service");
      const daily = await ensureDailyVaultIntelligenceCycle({
        db,
        agencyId: creator.agencyId,
        creatorId: creator.id,
        now,
      });
      const dailyOutcome = normalizeSchedulerDecision(daily, { requireOk: true });
      if (dailyOutcome.created) dailyCyclesStarted += 1;
      else dailyCyclesSkipped += 1;
      if (!dailyOutcome.ok) creatorIssues.push({ work: "daily_vault_intelligence", reason: dailyOutcome.reason, failures: dailyOutcome.failures });
    } catch (error) {
      dailyCyclesSkipped += 1;
      creatorIssues.push({ work: "daily_vault_intelligence", reason: error?.code || "daily_vault_exception", error: String(error?.message || error) });
    }

    creatorsScanned += 1;
    processedCreatorIds.push(creator.id);
    if (creatorIssues.length) {
      totalDegraded += creatorIssues.length;
      degradedCreators.push({ creatorId: creator.id, issues: creatorIssues });
      const error = Object.assign(new Error(creatorIssues.map((issue) => `${issue.work}:${issue.reason}`).join("; ").slice(0, 1900)), {
        code: "CREATOR_RECURRING_PLANNING_DEGRADED",
      });
      const failed = await failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error, fallbackNow: now }).catch(() => ({ failed: false, lost: true }));
      if (failed?.failed || failed?.superseded) retried += 1;
      else lostOwnership += 1;
      continue;
    }

    const baseNow = heartbeat.authorityNow || claim.authorityNow || now;
    const nextRunAt = new Date(new Date(baseNow).getTime() + RECURRING_INTERVAL_MS);
    const released = await yieldDomainWorkClaim({
      db,
      item,
      ownerToken: claim.ownerToken,
      availableAt: nextRunAt,
      progressCursor: { lastPlanningCycleAt: new Date(baseNow).toISOString(), nextPlanningCycleAt: nextRunAt.toISOString() },
      fallbackNow: now,
    }).catch(() => ({ yielded: false, lost: true }));
    if (released?.yielded) yielded += 1;
    else lostOwnership += 1;
  }

  const ok = totalDegraded === 0 && lostOwnership === 0;
  return {
    ok,
    outcome: ok ? (creatorsScanned ? SCHEDULER_OUTCOME.NOOP : SCHEDULER_OUTCOME.WAITING) : SCHEDULER_OUTCOME.DEGRADED,
    reason: ok ? (claim?.skipped ? claim.reason : null) : (totalDegraded ? "derived_planning_degraded" : "domain_work_lease_lost"),
    creatorsScanned,
    pages: items.length ? 1 : 0,
    totalCreated,
    totalSkipped,
    totalDegraded,
    degradedCreators,
    processedCreatorIds,
    dailyCyclesStarted,
    dailyCyclesSkipped,
    selected: items.length,
    retired,
    retried,
    yielded,
    yieldedForBudget,
    lostOwnership,
    pageSize: size,
    maxRuntimeMs: runtimeBudget,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Recurring scheduler — claims a bounded, fair DomainWorkItem batch for READY
 * creators. Creator lifecycle triggers publish/revoke that durable work, so no
 * replica scans the full creator catalog. The maintenance pump drains backlog
 * between hourly top-level sweeps; leases make restart/takeover safe.
 */
async function runPhase2MaintenancePump({ db = prisma, now = new Date() } = {}) {
  if (phase2MaintenancePromise) return { ok: true, skipped: true, reason: "local_overlap" };
  phase2MaintenancePromise = (async () => {
    // R6 final admission layer. Each lane remains its own durable distributed authority;
    // this rotation is only a resource/fairness budget, never business truth. A restart may
    // change which lane runs first, but no lane loses work because claims/cursors stay durable.
    const lanes = [
      ["agencyDestructiveCleanup", () => runAgencyDestructiveCleanupSweep({ db, now })],
      ["creatorDestructiveCleanup", () => runCreatorDestructiveCleanupSweep({ db, now })],
      ["providerOperationalBackfill", () => maybeBackfillProviderOperationalDebt({ db, now })],
      ["subscriberDirectoryMaintenance", () => runSubscriberDirectoryMaintenance({ db, now, maxSignals: 16, concurrency: 4, maxRuntimeMs: 5_000, recoveryStepsPerRun: 4, retentionBatch: 50 })],
      ["creatorRecurringPlanning", () => runRecurringCreatorWork({ db, now })],
      ["campaignFanRefreshPromotion", () => runCampaignFanRefreshPromotionMaintenance({ db, now, maxCreators: 200, maxJobsPerCreator: 4, concurrency: 4, maxRuntimeMs: 8_000 })],
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

  let recurringCreatorWork = null;
  try {
    recurringCreatorWork = await runRecurringCreatorWork({ db: prisma, now });
  } catch (err) {
    console.warn("[scheduler] recurring creator planning crashed:", err?.message || err);
    recurringCreatorWork = {
      ok: false,
      reason: err?.code || "recurring_creator_planning_crashed",
      error: err?.message || String(err),
      creatorsScanned: 0,
      pages: 0,
      totalCreated: 0,
      totalSkipped: 0,
      totalDegraded: 1,
      degradedCreators: [],
      dailyCyclesStarted: 0,
      dailyCyclesSkipped: 0,
    };
  }
  const {
    creatorsScanned,
    pages: creatorPages,
    totalCreated,
    totalSkipped,
    totalDegraded,
    degradedCreators,
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
    `[scheduler] sweep done in ${elapsed}ms — creators=${creatorsScanned}, pages=${creatorPages}, jobs created=${totalCreated}, skipped=${totalSkipped}, degraded=${totalDegraded}, daily started=${dailyCyclesStarted}, daily skipped=${dailyCyclesSkipped}`
  );

  const components = { analyticsSweep, creatorAnalyticsSweep, recurringCreatorWork, retention, billingRenewals, billingExpiry };
  const degradedComponents = [];
  for (const [component, result] of Object.entries(components)) {
    const failures = schedulerDecisionNodes(result, component)
      .filter((node) => node.value?.ok === false)
      .map((node) => ({
        component,
        path: node.path,
        reason: String(node.value?.reason || node.value?.code || node.value?.error || "resolved_degradation"),
      }));
    degradedComponents.push(...failures);
  }
  const ok = degradedComponents.length === 0;

  return {
    ok,
    outcome: ok ? SCHEDULER_OUTCOME.NOOP : SCHEDULER_OUTCOME.DEGRADED,
    reason: ok ? null : degradedComponents[0]?.reason || "recurring_sweep_degraded",
    degradedComponents,
    durationMs: elapsed,
    creatorsScanned,
    creatorPages,
    jobsCreated: totalCreated,
    jobsSkipped: totalSkipped,
    jobsDegraded: totalDegraded,
    degradedCreators,
    creatorWorkOk: recurringCreatorWork.ok,
    creatorWorkReason: recurringCreatorWork.reason,
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
  recurringSchedulerHealth = { ...recurringSchedulerHealth, lastStartedAt: new Date().toISOString() };
  recurringSweepPromise = runRecurringSweepInternal();
  try {
    const result = await recurringSweepPromise;
    recordRecurringSchedulerHealth(result);
    return result;
  } catch (error) {
    recordRecurringSchedulerHealth(null, error);
    throw error;
  } finally {
    recurringSweepPromise = null;
  }
}

function recordRecurringSchedulerHealth(result, error = null) {
  const completedAt = new Date().toISOString();
  const degraded = Boolean(error || result?.ok === false);
  recurringSchedulerHealth = {
    ...recurringSchedulerHealth,
    status: degraded ? "DEGRADED" : "HEALTHY",
    consecutiveDegraded: degraded ? Number(recurringSchedulerHealth.consecutiveDegraded || 0) + 1 : 0,
    lastCompletedAt: completedAt,
    lastHealthyAt: degraded ? recurringSchedulerHealth.lastHealthyAt : completedAt,
    lastDegradedAt: degraded ? completedAt : recurringSchedulerHealth.lastDegradedAt,
    lastReason: degraded ? String(error?.code || result?.reason || error?.message || "recurring_sweep_degraded") : null,
    lastDegraded: degraded
      ? (Array.isArray(result?.degradedComponents) && result.degradedComponents.length
        ? result.degradedComponents.slice(0, 25)
        : [{ component: "recurringSweep", path: "exception", reason: String(error?.message || result?.reason || "recurring_sweep_degraded") }])
      : [],
  };
  return getRecurringSchedulerHealthSnapshot();
}

function getRecurringSchedulerHealthSnapshot() {
  return {
    ...recurringSchedulerHealth,
    lastDegraded: recurringSchedulerHealth.lastDegraded.map((entry) => ({ ...entry })),
  };
}

function handleRecurringSweepTickResult(result) {
  if (result?.ok !== false) return result;
  console.error(`[scheduler] sweep resolved degraded: ${JSON.stringify({ reason: result.reason, degraded: result.degradedComponents || [] })}`);
  return result;
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
    runRecurringSweep()
      .then(handleRecurringSweepTickResult)
      .catch((err) => {
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
    runPhase2MaintenancePump({ db: prisma })
      .then((result) => {
        if (result?.ok !== false) return;
        const degraded = {};
        for (const [name, lane] of Object.entries(result || {})) {
          if (!lane || typeof lane !== "object" || lane.ok !== false) continue;
          degraded[name] = {
            errors: Number(lane.errors || 0),
            contended: Number(lane.contended || 0),
            poisonedSignals: Number(lane.poisonedSignals || 0),
            errorDetails: Array.isArray(lane.errorDetails) ? lane.errorDetails.slice(0, 5) : [],
            poisonedSample: Array.isArray(lane.poisonedSample) ? lane.poisonedSample.slice(0, 5) : [],
            error: lane.error || null,
          };
        }
        console.error(`[scheduler] Phase2 maintenance degraded: ${JSON.stringify(degraded)}`);
      })
      .catch((err) => {
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
  selectCampaignDirectoryDiscoveryAdmissions,
  estimatedCampaignDirectoryPages,
  runRecurringCreatorWork,
  startRecurringScheduler,
  stopRecurringScheduler,
  getRecurringSchedulerHealthSnapshot,
  RECURRING_INTERVAL_MS,
  FRESHNESS_WINDOW_MS,
  TRAFFIC_REFRESH_WINDOW_MS,
  CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP,
  CAMPAIGN_DIRECTORY_DISCOVERY_MAX_JOBS_PER_SWEEP,
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
  runAgencyDestructiveCleanupSweep,
  runCreatorDestructiveCleanupSweep,
  maybeRunRetentionSweep,
  maybeReconcileHistoricalTeamMoney,
  maybeRepairLegacyTeamPendingBootstrap,
  maybeBackfillProviderOperationalDebt,
  maybeSeedPhase2CoverageWork,
  maybeRunPhase2HistoricalEnumeration,
  maybePlanDueCustomReminderWork,
  maybeRepairProviderOperationalDirty,
  maybeRunPhase2DependencyFanout,
  _test: {
    SCHEDULER_OUTCOME,
    normalizeSchedulerDecision,
    executeSchedulerConsumer,
    recordRecurringSchedulerHealth,
    handleRecurringSweepTickResult,
  },
};
