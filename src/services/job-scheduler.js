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
const TEAM_MONEY_BACKFILL_BATCH_SIZE = 250; // DB-only historical reconciliation, no OF requests
const TEAM_PENDING_BACKFILL_BATCH_SIZE = 500; // DB-only Team queue projection repair
const ANALYTICS_DEMAND_INTERVAL_MS = 15 * 1000; // durable interactive Home freshness demands
const TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS = 30 * 1000; // lightweight DB-only Customs projection retry
const TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE = 200;
const RECURRING_READY_PAGE_SIZE = 250;
const CREATOR_ANALYTICS_SWEEP_LEASE_KEY = "creator_analytics_recurring_v1";
const CREATOR_ANALYTICS_SWEEP_COORDINATION_LOCK_KEY = "creator-analytics-recurring-sweep-coordinator";
const CREATOR_ANALYTICS_SWEEP_LEASE_MS = 15 * 60 * 1000;
const CREATOR_ANALYTICS_SWEEP_HEARTBEAT_EVERY = 25;
let lastRetentionSweepAt = 0;
let recurringSweepPromise = null;
let creatorAnalyticsSweepPromise = null;


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
    const { migrateLegacyTipsToTipLedger, repairMigratedLegacyTipManualAuthority } = require("./team-tip-ledger-service");
    const { reconcileHistoricalTeamMoneyBatch } = require("./team-money-reconciliation-service");
    const legacyManualRepair = await repairMigratedLegacyTipManualAuthority({
      limit: TEAM_MONEY_BACKFILL_BATCH_SIZE,
      dryRun: false,
    });
    const legacyTips = await migrateLegacyTipsToTipLedger({
      limit: TEAM_MONEY_BACKFILL_BATCH_SIZE,
      dryRun: false,
      deleteLegacy: true,
    });
    const result = await reconcileHistoricalTeamMoneyBatch({
      db: prisma,
      saleLimit: TEAM_MONEY_BACKFILL_BATCH_SIZE,
      tipLimit: TEAM_MONEY_BACKFILL_BATCH_SIZE,
    });
    result.legacyManualRepair = legacyManualRepair;
    result.legacyTips = legacyTips;
    if (!result?.skipped) {
      const sales = result?.sales || {};
      const tips = result?.tips || {};
      if ((legacyManualRepair.scanned || 0) > 0 || (legacyTips.scanned || 0) > 0 || (sales.selected || 0) > 0 || (tips.selected || 0) > 0 || (sales.failed || 0) > 0 || (tips.failed || 0) > 0) {
        console.log(
          `[scheduler] Team money backfill — migrated-manual repaired=${legacyManualRepair.repaired || 0}/${legacyManualRepair.scanned || 0}; legacy tips migrated=${legacyTips.migrated || 0}, deleted=${legacyTips.deletedLegacy || 0}; sales linked=${sales.linked || 0}/${sales.selected || 0}, tips linked=${tips.linked || 0}/${tips.selected || 0}, failed=${(sales.failed || 0) + (tips.failed || 0)}`
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

async function runCustomExternalProofConvergenceSweep({ now = new Date() } = {}) {
  try {
    // Provider-completed CUSTOM relay results are canonical historical facts. Their
    // projection is backend-owned repair and deliberately has no Desktop lease,
    // creator READY/deleted, manager permission, or Custom lifecycle dependency.
    const { convergeHistoricalCustomExternalProofs } = require("./custom-external-proof-convergence-service");
    const result = await convergeHistoricalCustomExternalProofs({ limit: 200, db: prisma });
    if (Number(result?.selected || 0) > 0 || Number(result?.failed || 0) > 0) {
      console.log(`[scheduler] Custom external proof convergence — selected=${result.selected || 0}, repaired=${result.repaired || 0}, media=${result.projectedMedia || 0}, failed=${result.failed || 0}`);
    }
    return result;
  } catch (err) {
    console.warn("[scheduler] Custom external proof convergence failed:", err?.message || err);
    return { ok: false, selected: 0, repaired: 0, projectedMedia: 0, failed: 1, error: err?.message || String(err) };
  }
}

async function runTelegramInboundProjectionSweep({ now = new Date() } = {}) {
  try {
    // Provider observations are ACKed once TelegramInboundEvent is durable. Any derived
    // Custom submission/current-state repair after that boundary is server-owned work and
    // must continue even when no Desktop is open or polling delivery work.
    const { retryPendingInboundProjections } = require("./telegram-inbound-authority-service");
    const result = await retryPendingInboundProjections({
      now,
      limit: TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE,
      db: prisma,
    });
    if (Number(result?.scanned || 0) > 0) {
      console.log(`[scheduler] Telegram inbound projection — scanned=${result.scanned}, applied=${result.applied || 0}, skipped=${result.skipped || 0}, pending=${result.pending || 0}, review=${result.reviewRequired || 0}`);
    }
    return result;
  } catch (err) {
    // This lane owns only derived state over already-durable provider observations. A
    // temporary failure must never suppress the main recurring scheduler.
    console.warn("[scheduler] Telegram inbound projection failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function runTelegramConfirmedProjectionSweep({ now = new Date() } = {}) {
  try {
    // CONFIRMED Telegram provider receipts are canonical facts. If an older process crashed
    // after committing the receipt but before projecting CustomOrder / CANCELLATION state, the
    // repair is backend-owned and must converge even with no Desktop polling. Drain agencies by
    // cursor instead of hiding historical debt behind a fixed first-N workspace sample.
    const { scanAllById } = require("./telegram-exact-authority-scan-service");
    const { repairConfirmedTelegramDeliveryProjections, repairCustomModelCommunicationConvergence } = require("./telegram-delivery-authority-service");
    const report = {
      ok: true, agencies: 0, scanned: 0, repaired: 0, failed: 0,
      reminderScheduleScanned: 0, reminderScheduleRepaired: 0, reminderScheduleFailed: 0,
      modelInitialTasksPlanned: 0, modelInitialTasksReactivated: 0, modelInitialTasksBlocked: 0, modelInitialTasksRaced: 0, modelInitialTasksFailed: 0,
      modelCommunicationPrecommitScanned: 0, modelCommunicationPrecommitCancelled: 0, modelCommunicationPrecommitFailed: 0,
      modelCommunicationReminderScanned: 0, modelCommunicationReminderRepaired: 0, modelCommunicationReminderFailed: 0,
      revisionIntentsPlanned: 0,
    };
    await scanAllById({
      delegate: prisma.agency,
      where: { deletedAt: null },
      select: { id: true },
      pageSize: 100,
      onPage: async (rows) => {
        for (const agency of rows || []) {
          report.agencies += 1;
          const result = await repairConfirmedTelegramDeliveryProjections({ agencyId: String(agency.id), now, db: prisma });
          report.scanned += Number(result?.scanned || 0);
          report.repaired += Number(result?.repaired || 0);
          report.failed += Number(result?.failed || 0);
          report.reminderScheduleScanned += Number(result?.reminderScheduleScanned || 0);
          report.reminderScheduleRepaired += Number(result?.reminderScheduleRepaired || 0);
          report.reminderScheduleFailed += Number(result?.reminderScheduleFailed || 0);
          if (result?.ok === false) report.ok = false;

          const modelCommunication = await repairCustomModelCommunicationConvergence({ agencyId: String(agency.id), now, db: prisma });
          report.modelInitialTasksPlanned += Number(modelCommunication?.initialTaskIntentsPlanned || 0);
          report.modelInitialTasksReactivated += Number(modelCommunication?.initialTaskIntentsReactivated || 0);
          report.modelInitialTasksBlocked += Number(modelCommunication?.initialTaskIntentsBlocked || 0);
          report.modelInitialTasksRaced += Number(modelCommunication?.initialTaskIntentsRaced || 0);
          report.modelInitialTasksFailed += Number(modelCommunication?.initialTaskIntentsFailed || 0);
          report.modelCommunicationPrecommitScanned += Number(modelCommunication?.precommitScanned || 0);
          report.modelCommunicationPrecommitCancelled += Number(modelCommunication?.precommitCancelled || 0);
          report.modelCommunicationPrecommitFailed += Number(modelCommunication?.precommitFailed || 0);
          report.modelCommunicationReminderScanned += Number(modelCommunication?.reminderScheduleScanned || 0);
          report.modelCommunicationReminderRepaired += Number(modelCommunication?.reminderScheduleRepaired || 0);
          report.modelCommunicationReminderFailed += Number(modelCommunication?.reminderScheduleFailed || 0);
          report.revisionIntentsPlanned += Number(modelCommunication?.revisionIntentsPlanned || 0);
          if (modelCommunication?.ok === false) report.ok = false;
        }
        return false;
      },
    });
    if (report.scanned > 0 || report.failed > 0 || report.reminderScheduleScanned > 0 || report.reminderScheduleFailed > 0
      || report.modelInitialTasksPlanned > 0 || report.modelInitialTasksReactivated > 0 || report.modelInitialTasksFailed > 0
      || report.modelCommunicationPrecommitScanned > 0 || report.modelCommunicationReminderScanned > 0 || report.revisionIntentsPlanned > 0) {
      console.log(`[scheduler] Telegram/custom model convergence — agencies=${report.agencies}, confirmedScanned=${report.scanned}, confirmedRepaired=${report.repaired}, confirmedFailed=${report.failed}, reminderScheduleScanned=${report.reminderScheduleScanned}, reminderScheduleRepaired=${report.reminderScheduleRepaired}, reminderScheduleFailed=${report.reminderScheduleFailed}, initialTaskPlanned=${report.modelInitialTasksPlanned}, initialTaskReactivated=${report.modelInitialTasksReactivated}, initialTaskBlocked=${report.modelInitialTasksBlocked}, initialTaskRaced=${report.modelInitialTasksRaced}, initialTaskFailed=${report.modelInitialTasksFailed}, precommitScanned=${report.modelCommunicationPrecommitScanned}, precommitCancelled=${report.modelCommunicationPrecommitCancelled}, precommitFailed=${report.modelCommunicationPrecommitFailed}, modelReminderScanned=${report.modelCommunicationReminderScanned}, modelReminderRepaired=${report.modelCommunicationReminderRepaired}, modelReminderFailed=${report.modelCommunicationReminderFailed}, revisionIntentsPlanned=${report.revisionIntentsPlanned}`);
    }
    return report;
  } catch (err) {
    // Repair touches only derived state over already-confirmed provider outcomes. Never suppress
    // the recurring scheduler if one historical row requires explicit operator adjudication.
    console.warn("[scheduler] Telegram confirmed projection failed:", err?.message || err);
    return { ok: false, agencies: 0, scanned: 0, repaired: 0, failed: 1, error: err?.message || String(err) };
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
  const telegramConfirmedProjection = await runTelegramConfirmedProjectionSweep({ now });
  const customExternalProofConvergence = await runCustomExternalProofConvergenceSweep({ now });
  const teamMoneyBackfill = await maybeReconcileHistoricalTeamMoney();
  const teamPendingBackfill = await maybeBackfillTeamPendingProjection();

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
    telegramConfirmedProjection,
    customExternalProofConvergence,
    teamMoneyBackfill,
    teamPendingBackfill,
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
let telegramInboundProjectionTimer = null;

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

  const projectionTick = () => {
    runTelegramInboundProjectionSweep().catch((err) => {
      console.error("[scheduler] Telegram inbound projection sweep crashed:", err);
    });
    runCustomExternalProofConvergenceSweep().catch((err) => {
      console.error("[scheduler] Custom external proof convergence sweep crashed:", err);
    });
  };
  if (runImmediately) setTimeout(projectionTick, 5 * 1000);
  telegramInboundProjectionTimer = setInterval(projectionTick, TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS);

  console.log(`[scheduler] started (interval=${intervalMs}ms, inboundProjectionInterval=${TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS}ms, immediate=${runImmediately})`);

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
  if (telegramInboundProjectionTimer) {
    clearInterval(telegramInboundProjectionTimer);
    telegramInboundProjectionTimer = null;
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
  TEAM_MONEY_BACKFILL_BATCH_SIZE,
  TELEGRAM_INBOUND_PROJECTION_INTERVAL_MS,
  TELEGRAM_INBOUND_PROJECTION_BATCH_SIZE,
  runTelegramInboundProjectionSweep,
  runTelegramConfirmedProjectionSweep,
  runCustomExternalProofConvergenceSweep,
  maybeRunRetentionSweep,
  maybeReconcileHistoricalTeamMoney,
};
