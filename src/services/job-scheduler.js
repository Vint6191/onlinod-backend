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

// Range keys we proactively keep fresh for owner dashboards.
// Don't pre-fetch the long ranges (180d/365d/all) — they're expensive
// and rarely viewed. They get scheduled on-demand when owner opens
// that tab in the UI.
const TRACKED_RANGES = ["7d", "30d"];

// Recurring sweeper interval. Owner asked for 1 hour.
const RECURRING_INTERVAL_MS = 60 * 60 * 1000;

// How recently a "DONE" job counts as fresh enough to skip rescheduling.
// Same as RECURRING_INTERVAL_MS — if we just refreshed, don't refresh again.
const FRESHNESS_WINDOW_MS = RECURRING_INTERVAL_MS;
const TRAFFIC_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const RETENTION_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000; // fallback; admin setting can override
const TEAM_MONEY_BACKFILL_BATCH_SIZE = 250; // DB-only historical reconciliation, no OF requests
const TEAM_PENDING_BACKFILL_BATCH_SIZE = 500; // DB-only Team queue projection repair
let lastRetentionSweepAt = 0;


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

  if (!force && lastRetentionSweepAt && now.getTime() - lastRetentionSweepAt < retentionWindowMs) {
    return { ok: true, skipped: true, reason: "fresh", windowMs: retentionWindowMs };
  }

  lastRetentionSweepAt = now.getTime();
  const startedAt = Date.now();

  try {
    const result = await runRetentionSweep({});
    console.log(
      `[scheduler] retention sweep done in ${Date.now() - startedAt}ms — deleted=${result.totalDeleted || 0}`
    );
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
 * @returns {Promise<{ created: string[], skipped: string[] }>}
 */
async function scheduleInitialJobsForCreator({ creatorId, agencyId, priority = 50, creator = null, includeAnalyticsCatchups = false }) {
  if (!creatorId || !agencyId) return { created: [], skipped: [] };
  const creatorRemoteId = creator?.remoteId || creator?.userId || null;
  const creatorUsername = creator?.username || null;
  const creatorDisplayName = creator?.displayName || null;

  const created = [];
  const skipped = [];
  const now = new Date();

  // Creator Analytics bootstrap owns the creator background-read lane until its
  // strict Notifications -> Financial -> Campaigns history sequence is proven.
  // Do not pre-schedule unrelated read jobs here: a lower-priority job can be
  // claimed while waiting and steal the lane between two bootstrap stages.
  try {
    const { ensureInitialCreatorAnalyticsSync, ensureRecurringCreatorAnalyticsCatchups } = require("./creator-analytics-sync-orchestrator");
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
  } catch (err) {
    skipped.push(`creator_analytics:${err?.message || "schedule_failed"}`);
    // Fail closed for automatic read work. If bootstrap state cannot be proven,
    // do not start other creator-wide OF scans that can race its recovery.
    return { created, skipped };
  }

  // Lightweight dashboard earnings are refreshed only after the initial
  // analytics history pipeline is complete.
  for (const rangeKey of TRACKED_RANGES) {
    const decision = await ensureSingleJob({
      jobKey: "fetch_earnings",
      creatorId,
      agencyId,
      params: { rangeKey },
      priority,
      now,
    });
    if (decision.created) created.push(`fetch_earnings:${rangeKey}`);
    else skipped.push(`fetch_earnings:${rangeKey}`);
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
  jobKey,
  creatorId,
  agencyId,
  params = {},
  priority = 100,
  now = new Date(),
  bucketMs = 60_000,
} = {}) {
  const idempotencyKey = buildJobIdempotencyKey({
    jobKey,
    scope: "creator",
    creatorId,
    agencyId,
    params,
    bucketAt: now,
    bucketMs,
  });

  const planned = await ensurePlannedJob({
    db: prisma,
    jobKey,
    scope: "creator",
    creatorId,
    agencyId,
    idempotencyKey,
    params,
    priority,
    scheduledAt: now,
    nextRunAt: now,
    shouldResetExisting: (existing) => existing.status !== "CLAIMED",
    protectedStatuses: ["CLAIMED"],
  });
  if (!planned.job) throw new Error(`Failed to schedule ${jobKey}: planning race did not converge`);
  return {
    job: planned.job,
    created: planned.created,
    reason: planned.created ? "created" : planned.rescheduled ? "rescheduled" : planned.reason,
  };
}


async function maybeReconcileHistoricalTeamMoney() {
  try {
    const { reconcileHistoricalTeamMoneyBatch } = require("./team-money-reconciliation-service");
    const result = await reconcileHistoricalTeamMoneyBatch({
      db: prisma,
      saleLimit: TEAM_MONEY_BACKFILL_BATCH_SIZE,
      tipLimit: TEAM_MONEY_BACKFILL_BATCH_SIZE,
    });
    if (!result?.skipped) {
      const sales = result?.sales || {};
      const tips = result?.tips || {};
      if ((sales.selected || 0) > 0 || (tips.selected || 0) > 0 || (sales.failed || 0) > 0 || (tips.failed || 0) > 0) {
        console.log(
          `[scheduler] Team money backfill — sales linked=${sales.linked || 0}/${sales.selected || 0}, tips linked=${tips.linked || 0}/${tips.selected || 0}, failed=${(sales.failed || 0) + (tips.failed || 0)}`
        );
      }
    }
    return result;
  } catch (err) {
    // This is maintenance over already-stored canonical facts. Never suppress
    // creator jobs because historical Team reconciliation temporarily failed.
    console.warn("[scheduler] Team money backfill failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function maybeBackfillTeamPendingProjection() {
  try {
    const { backfillTeamPendingProjectionBatch } = require("./team-pending-projection-service");
    const result = await backfillTeamPendingProjectionBatch({
      db: prisma,
      limit: TEAM_PENDING_BACKFILL_BATCH_SIZE,
    });
    if (!result?.skipped && Number(result?.selected || 0) > 0) {
      console.log(
        `[scheduler] Team pending projection — projected=${result.projected || 0}/${result.selected || 0}, dialogs=${result.dialogs || 0}`
      );
    }
    return result;
  } catch (err) {
    // Repair runs only over already-durable Team facts. It must never suppress
    // creator jobs or runtime automation when the derived queue is unavailable.
    console.warn("[scheduler] Team pending projection backfill failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Recurring scheduler — finds all READY creators across all agencies
 * and ensures they have scheduled jobs. Runs once on startup, then
 * every RECURRING_INTERVAL_MS.
 *
 * Designed to be cheap: looks at recent JobInstance rows (already indexed
 * by creatorId + jobKey), so even with thousands of creators it stays fast.
 */
async function runRecurringSweep() {
  const startedAt = Date.now();
  const now = new Date();

  const creators = await prisma.creatorAccount.findMany({
    where: {
      status: "READY",
      deletedAt: null,
      agency: { deletedAt: null },
    },
    select: { id: true, agencyId: true, remoteId: true, username: true, displayName: true },
    take: 10000});

  let totalCreated = 0;
  let totalSkipped = 0;
  let dailyCyclesStarted = 0;
  let dailyCyclesSkipped = 0;

  for (const creator of creators) {
    try {
      const result = await scheduleInitialJobsForCreator({
        creatorId: creator.id,
        agencyId: creator.agencyId,
        creator,
        priority: 30, // recurring work stays below explicit refresh-now / interactive connect work
        includeAnalyticsCatchups: true,
      });
      totalCreated += result.created.length;
      totalSkipped += result.skipped.length;
    } catch (err) {
      console.warn("[scheduler] regular creator jobs failed:", creator.id, err?.message || err);
    }

    // Daily Vault Intelligence is an independent maintenance lane. A failure in
    // earnings/campaign/automation scheduling must never suppress the catalog
    // and dialog freshness cycle for the same creator.
    try {
      // Load lazily to avoid a module cycle: vault-unsorted-service uses
      // scheduleJobNow from this module, while the daily coordinator composes
      // that catalog job with a dialog discovery generation.
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
  }

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
  const teamMoneyBackfill = await maybeReconcileHistoricalTeamMoney();
  const teamPendingBackfill = await maybeBackfillTeamPendingProjection();

  const elapsed = Date.now() - startedAt;
  console.log(
    `[scheduler] sweep done in ${elapsed}ms — creators=${creators.length}, jobs created=${totalCreated}, skipped=${totalSkipped}, daily started=${dailyCyclesStarted}, daily skipped=${dailyCyclesSkipped}`
  );

  return {
    creatorsScanned: creators.length,
    jobsCreated: totalCreated,
    jobsSkipped: totalSkipped,
    dailyCyclesStarted,
    dailyCyclesSkipped,
    retention,
    billingRenewals,
    billingExpiry,
    teamMoneyBackfill,
    teamPendingBackfill,
  };
}


let recurringTimer = null;

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
  console.log(`[scheduler] started (interval=${intervalMs}ms, immediate=${runImmediately})`);

  return () => stopRecurringScheduler();
}

function stopRecurringScheduler() {
  if (recurringTimer) {
    clearInterval(recurringTimer);
    recurringTimer = null;
    console.log("[scheduler] stopped");
  }
}


module.exports = {
  scheduleInitialJobsForCreator,
  ensureSingleJob,
  scheduleJobNow,
  runRecurringSweep,
  startRecurringScheduler,
  stopRecurringScheduler,
  TRACKED_RANGES,
  RECURRING_INTERVAL_MS,
  FRESHNESS_WINDOW_MS,
  TRAFFIC_REFRESH_WINDOW_MS,
  RETENTION_SWEEP_WINDOW_MS,
  TEAM_MONEY_BACKFILL_BATCH_SIZE,
  maybeRunRetentionSweep,
  maybeReconcileHistoricalTeamMoney,
};
