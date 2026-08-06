/* src/services/job-scheduler.js
   ────────────────────────────────────────────────────────────
   Job auto-scheduling.

   Used in two places:

   1. creator-connect.js — after a creator transitions to READY,
      we schedule initial fetch_earnings + fetch_campaigns jobs
      so the owner UI sees data without anyone clicking refresh.

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
const { buildNotificationScanParams, loadNotificationSyncState } = require("./notification-sync-state-service");
const { ensureAutomaticSfs } = require("./sfs-service");

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
 * Schedule initial jobs for a single creator that just became READY.
 * Idempotent: if jobs already exist (SCHEDULED or recently DONE), we skip.
 *
 * @param {object} args
 * @param {string} args.creatorId
 * @param {string} args.agencyId
 * @param {number} [args.priority=50]
 * @returns {Promise<{ created: string[], skipped: string[] }>}
 */
async function scheduleInitialJobsForCreator({ creatorId, agencyId, priority = 50, creator = null }) {
  if (!creatorId || !agencyId) return { created: [], skipped: [] };
  const creatorRemoteId = creator?.remoteId || creator?.userId || null;
  const creatorUsername = creator?.username || null;
  const creatorDisplayName = creator?.displayName || null;

  const created = [];
  const skipped = [];
  const now = new Date();

  // 1. fetch_earnings for each tracked range
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

  // 2. fetch_campaigns (account-scoped, no rangeKey)
  const campaignsDecision = await ensureSingleJob({
    jobKey: "fetch_campaigns",
    creatorId,
    agencyId,
    params: {},
    priority,
    now,
  });
  if (campaignsDecision.created) created.push("fetch_campaigns");
  else skipped.push("fetch_campaigns");

  // 3. Notification facts use one resumable type=all stream. The first run
  // walks to explicit hasMore=false; later hourly runs stop at the last known
  // head notification and only close realtime/offline gaps.
  const notificationState = await loadNotificationSyncState(prisma, creatorId);
  const notificationParams = buildNotificationScanParams({
    state: notificationState,
    now,
    reason: notificationState?.fullBackfillCompletedAt ? "recurring_notification_catchup" : "initial_notification_backfill",
    analyticsRangeKey: "all",
  });
  const notificationDecision = await ensureSingleJob({
    jobKey: "catchup_notifications_scan",
    creatorId,
    agencyId,
    params: notificationParams,
    priority: Math.max(20, priority - 10),
    now,
  });
  if (notificationDecision.created) created.push(`catchup_notifications_scan:${notificationParams.notificationMode}`);
  else skipped.push(`catchup_notifications_scan:${notificationParams.notificationMode}`);

  // 4. traffic_sources_scan — source/member attribution index.
  // Kept much cooler than earnings jobs because it can walk large trial/promo lists.
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

  // 4. Subscriber Directory — one shared weekly source for Hidden Online,
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

  // Prefer the explicit idempotency key. Older rows without one are still
  // considered by the compatibility rangeKey scan below.
  const keyed = await prisma.jobInstance.findFirst({
    where: { idempotencyKey },
    orderBy: { createdAt: "desc" },
  });
  if (keyed && (keyed.status === "SCHEDULED" || keyed.status === "CLAIMED")) {
    return { created: false, reason: "already_in_flight", jobId: keyed.id };
  }
  if (keyed && keyed.status === "DONE" && keyed.completedAt && keyed.completedAt > new Date(now.getTime() - window)) {
    return { created: false, reason: "recently_done", jobId: keyed.id };
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

  // Create. The database unique key closes the race between multiple
  // backend instances running the same scheduler bucket.
  try {
    const created = await prisma.jobInstance.create({
      data: {
        jobKey,
        scope: "creator",
        creatorId,
        agencyId,
        idempotencyKey,
        params: params || {},
        priority,
        scheduledAt: now,
        nextRunAt: now,
      },
    });
    return { created: true, jobId: created.id };
  } catch (err) {
    if (err?.code !== "P2002") throw err;
    const raced = await prisma.jobInstance.findUnique({ where: { idempotencyKey } });
    return { created: false, reason: "idempotency_race", jobId: raced?.id || null };
  }
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

  for (let race = 0; race < 3; race += 1) {
    const existing = await prisma.jobInstance.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.status === "CLAIMED") {
        return { job: existing, created: false, reason: "already_claimed" };
      }
      const reset = await prisma.jobInstance.updateMany({
        where: { id: existing.id, status: { not: "CLAIMED" } },
        data: {
          status: "SCHEDULED",
          params,
          priority,
          scheduledAt: now,
          nextRunAt: now,
          claimedAt: null,
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          workId: null,
          continuation: null,
          progress: null,
          lastProgressAt: null,
          completedAt: null,
          lastError: null,
          attempts: 0,
          result: null,
        },
      });
      if (!reset.count) continue;
      const job = await prisma.jobInstance.findUnique({ where: { id: existing.id } });
      return { job, created: false, reason: "rescheduled" };
    }

    try {
      const job = await prisma.jobInstance.create({
        data: {
          jobKey,
          scope: "creator",
          creatorId,
          agencyId,
          idempotencyKey,
          params,
          status: "SCHEDULED",
          priority,
          scheduledAt: now,
          nextRunAt: now,
        },
      });
      return { job, created: true, reason: "created" };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }

  const job = await prisma.jobInstance.findUnique({ where: { idempotencyKey } });
  if (!job) throw new Error(`Failed to schedule ${jobKey}: idempotency race did not converge`);
  return { job, created: false, reason: job.status === "CLAIMED" ? "already_claimed" : "race_reused" };
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
        priority: 30, // recurring is lower priority than refresh-now (100) and creator-connect (50)
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

  const retention = await maybeRunRetentionSweep({ now });

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
  maybeRunRetentionSweep,
};
