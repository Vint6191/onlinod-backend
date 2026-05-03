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
async function scheduleInitialJobsForCreator({ creatorId, agencyId, priority = 50 }) {
  if (!creatorId || !agencyId) return { created: [], skipped: [] };

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

  return { created, skipped };
}


/**
 * Look up by (jobKey, creatorId, params.rangeKey) and decide whether to create a job.
 * Skips if:
 *  - There's already a SCHEDULED or CLAIMED job for this combo
 *  - There's a DONE job completed within FRESHNESS_WINDOW_MS
 */
async function ensureSingleJob({ jobKey, creatorId, agencyId, params, priority, now }) {
  const rangeKey = params?.rangeKey || null;

  // Find any existing job for this creator+jobKey+rangeKey.
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
  const freshnessThreshold = new Date(now.getTime() - FRESHNESS_WINDOW_MS);
  const recentlyDone = matching.find(
    (j) => j.status === "DONE" && j.completedAt && j.completedAt > freshnessThreshold
  );
  if (recentlyDone) {
    return { created: false, reason: "recently_done", jobId: recentlyDone.id };
  }

  // Create.
  const created = await prisma.jobInstance.create({
    data: {
      jobKey,
      scope: "creator",
      creatorId,
      agencyId,
      params: params || {},
      priority,
      scheduledAt: now,
      nextRunAt: now,
    },
  });

  return { created: true, jobId: created.id };
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

  const creators = await prisma.creatorAccount.findMany({
    where: {
      status: "READY",
      deletedAt: null,
      agency: { deletedAt: null },
    },
    select: { id: true, agencyId: true },
  });

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const creator of creators) {
    try {
      const result = await scheduleInitialJobsForCreator({
        creatorId: creator.id,
        agencyId: creator.agencyId,
        priority: 30, // recurring is lower priority than refresh-now (100) and creator-connect (50)
      });
      totalCreated += result.created.length;
      totalSkipped += result.skipped.length;
    } catch (err) {
      console.warn("[scheduler] sweep creator failed:", creator.id, err?.message || err);
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[scheduler] sweep done in ${elapsed}ms — creators=${creators.length}, jobs created=${totalCreated}, skipped=${totalSkipped}`
  );

  return { creatorsScanned: creators.length, jobsCreated: totalCreated, jobsSkipped: totalSkipped };
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
  runRecurringSweep,
  startRecurringScheduler,
  stopRecurringScheduler,
  TRACKED_RANGES,
  RECURRING_INTERVAL_MS,
};
