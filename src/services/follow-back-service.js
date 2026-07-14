"use strict";

const prisma = require("../prisma");
const {
  FOLLOW_BACK_MODULE_KEY,
  getAutomationControlSnapshot,
  assertAutomationEnabled,
  normalizeFollowBackSettings,
  requireCreator,
} = require("./automation-control-service");
const { listActionDeliveries, retryActionDelivery } = require("./automation-action-delivery-service");
const { evaluateCandidate } = require("./follow-back-rules");

const FOLLOW_BACK_ACTION_TYPE = "FOLLOW_BACK";
const ACTIVE_DELIVERY_STATUSES = ["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"];

function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function dayStart(date = new Date()) { const out = new Date(date); out.setHours(0, 0, 0, 0); return out; }
function monthStart(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function randomBetween(min, max) { const lo = Math.max(0, Math.floor(min)); const hi = Math.max(lo, Math.floor(max)); return lo + Math.floor(Math.random() * (hi - lo + 1)); }
async function refreshFollowBackProjection({ db = prisma, agencyId, creatorId, runId }) {
  const run = await db.subscriberScanRun.findFirst({
    where: { id: runId, agencyId, creatorId, status: "PUBLISHED" },
    select: { id: true, publishedAt: true },
  });
  if (!run) return { ok: false, reason: "snapshot_not_published", count: 0 };
  const now = new Date();
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeFollowBackSettings(control.modules.follow_back.settings);

  await db.$executeRawUnsafe(
    `
    INSERT INTO "FollowBackCandidate" (
      "id", "agencyId", "creatorId", "fanId", "dialogId", "username", "displayName", "avatarUrl",
      "subscriptionType", "isActive", "canReceiveChatMessage", "subscribedByCreator", "discoveredAt",
      "lastSeenAt", "eligibilityReason", "ignored", "blocked", "state", "generation", "cooldownUntil", "snapshotRunId",
      "metadata", "createdAt", "updatedAt"
    )
    SELECT
      'follow_' || md5(i."creatorId" || ':' || i."fanId"), i."agencyId", i."creatorId", i."fanId", i."dialogId",
      i."username", i."name", i."avatarUrl", i."subscriptionType", i."isActive", i."canReceiveChatMessage",
      i."subscribedBy", $2, i."lastSeenAt",
      CASE
        WHEN i."subscribedBy" = true THEN 'already_followed'
        WHEN i."isActive" = false THEN 'expired_subscriber'
        ELSE 'active_subscriber'
      END,
      false, false,
      CASE WHEN i."subscribedBy" = true THEN 'FOLLOWED' ELSE 'CANDIDATE' END,
      1, NULL, i."runId",
      COALESCE(i."metadata", '{}'::jsonb) || jsonb_build_object(
        'source', 'subscriber_directory', 'snapshotRunId', i."runId", 'subscribedOn', i."subscribedOn"
      ), $2, $2
    FROM "SubscriberScanItem" i
    WHERE i."runId" = $1
    ON CONFLICT ("creatorId", "fanId") DO UPDATE SET
      "dialogId" = EXCLUDED."dialogId",
      "username" = EXCLUDED."username",
      "displayName" = EXCLUDED."displayName",
      "avatarUrl" = EXCLUDED."avatarUrl",
      "subscriptionType" = EXCLUDED."subscriptionType",
      "isActive" = EXCLUDED."isActive",
      "canReceiveChatMessage" = EXCLUDED."canReceiveChatMessage",
      "subscribedByCreator" = EXCLUDED."subscribedByCreator",
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "eligibilityReason" = CASE
        WHEN "FollowBackCandidate"."blocked" = true THEN 'blocked'
        WHEN "FollowBackCandidate"."ignored" = true THEN 'ignored'
        WHEN EXCLUDED."subscribedByCreator" = true THEN 'already_followed'
        WHEN EXCLUDED."isActive" = false THEN 'expired_subscriber'
        ELSE 'active_subscriber'
      END,
      "state" = CASE
        WHEN "FollowBackCandidate"."blocked" = true THEN 'BLOCKED'
        WHEN "FollowBackCandidate"."ignored" = true THEN 'IGNORED'
        WHEN EXCLUDED."subscribedByCreator" = true THEN 'FOLLOWED'
        ELSE 'CANDIDATE'
      END,
      "generation" = CASE
        WHEN "FollowBackCandidate"."subscribedByCreator" = true AND EXCLUDED."subscribedByCreator" = false
          THEN "FollowBackCandidate"."generation" + 1
        ELSE "FollowBackCandidate"."generation"
      END,
      "cooldownUntil" = CASE
        WHEN "FollowBackCandidate"."subscribedByCreator" = true AND EXCLUDED."subscribedByCreator" = false
          THEN $2 + ($3 * INTERVAL '1 day')
        ELSE "FollowBackCandidate"."cooldownUntil"
      END,
      "snapshotRunId" = EXCLUDED."snapshotRunId",
      "metadata" = COALESCE("FollowBackCandidate"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
      "updatedAt" = EXCLUDED."updatedAt"
    `,
    runId,
    now,
    settings.refollowCooldownDays,
  );

  await db.followBackCandidate.updateMany({
    where: { agencyId, creatorId, snapshotRunId: { not: runId } },
    data: { state: "STALE", eligibilityReason: "stale_candidate", updatedAt: now },
  });
  const count = await db.followBackCandidate.count({ where: { agencyId, creatorId, snapshotRunId: runId } });

  let planned = null;
  if (control.effective.followBackEnabled && control.modules.follow_back.settings.automatic) {
    planned = await planFollowBack({ db, agencyId, creatorId, userId: null, source: "snapshot_publish" });
  }
  return { ok: true, count, runId, planned };
}

async function readyWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: {
      agencyId,
      creatorId,
      status: "ACTIVE",
      lastSeenAt: { gte: freshAfter },
      device: { lastSeenAt: { gte: freshAfter } },
    },
  });
}

async function nextNotBefore({ db, agencyId, creatorId, actionType, workspaceSettings, moduleSettings, now = new Date() }) {
  const latest = await db.automationDelivery.findFirst({
    where: { agencyId, creatorId, status: { notIn: ["CANCELED", "SKIPPED"] } },
    orderBy: [{ notBefore: "desc" }, { finishedAt: "desc" }, { createdAt: "desc" }],
    select: { notBefore: true, finishedAt: true },
  });
  const actionLatest = await db.automationDelivery.findFirst({
    where: { agencyId, creatorId, actionType, status: { notIn: ["CANCELED", "SKIPPED"] } },
    orderBy: [{ notBefore: "desc" }, { finishedAt: "desc" }, { createdAt: "desc" }],
    select: { notBefore: true, finishedAt: true },
  });
  const globalDelay = workspaceSettings.randomJitter
    ? randomBetween(workspaceSettings.globalWriteMinIntervalMs, workspaceSettings.globalWriteMaxIntervalMs)
    : workspaceSettings.globalWriteMinIntervalMs;
  const actionDelay = moduleSettings.randomJitter
    ? randomBetween(moduleSettings.minimumIntervalMs, moduleSettings.maximumIntervalMs)
    : moduleSettings.minimumIntervalMs;
  const globalBase = Math.max(latest?.notBefore?.getTime?.() || 0, latest?.finishedAt?.getTime?.() || 0);
  const actionBase = Math.max(actionLatest?.notBefore?.getTime?.() || 0, actionLatest?.finishedAt?.getTime?.() || 0);
  return new Date(Math.max(now.getTime(), globalBase + globalDelay, actionBase + actionDelay));
}

function automaticEligibilityWhere(settings, now = new Date()) {
  const and = [
    { OR: [{ subscribedByCreator: false }, { subscribedByCreator: null }] },
    { OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }] },
  ];
  if (settings.activeSubscribers && !settings.expiredSubscribers) {
    and.push({ OR: [{ isActive: true }, { isActive: null }] });
  } else if (!settings.activeSubscribers && settings.expiredSubscribers) {
    and.push({ isActive: false });
  } else if (!settings.activeSubscribers && !settings.expiredSubscribers) {
    and.push({ id: "__no_eligible_subscription_state__" });
  }
  if (!settings.expiredSubscribers) {
    and.push({ OR: [{ subscriptionType: null }, { NOT: { subscriptionType: { contains: "expired", mode: "insensitive" } } }] });
  }
  if (!settings.freeSubscribers) {
    and.push({ OR: [{ subscriptionType: null }, { NOT: { subscriptionType: { contains: "free", mode: "insensitive" } } }] });
  }
  if (!settings.paidSubscribers) {
    and.push({ OR: [
      { subscriptionType: null },
      { AND: [
        { NOT: { subscriptionType: { contains: "paid", mode: "insensitive" } } },
        { NOT: { subscriptionType: { contains: "active", mode: "insensitive" } } },
      ] },
    ] });
  }
  return {
    blocked: false,
    ignored: false,
    state: { not: "STALE" },
    generation: { lte: 1 },
    AND: and,
  };
}

async function planFollowBackLocked({ db, agencyId, creatorId, userId, fanId = null, source = "manual", priority = 60 }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, db });
  const settings = normalizeFollowBackSettings(control.modules.follow_back.settings);
  const state = await db.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId, status: "READY" } });
  if (!state?.currentRunId) throw Object.assign(new Error("Subscriber snapshot is not ready"), { code: "snapshot_not_ready", status: 409 });

  const today = dayStart();
  const [completedToday, activeCount] = await Promise.all([
    db.automationDelivery.count({
      where: {
        agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE,
        status: "COMPLETED", finishedAt: { gte: today },
      },
    }),
    db.automationDelivery.count({
      where: { agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE, status: { in: ACTIVE_DELIVERY_STATUSES } },
    }),
  ]);
  let capacity = Math.max(0, settings.dailyLimit - completedToday - activeCount);

  const candidateWhere = {
    agencyId,
    creatorId,
    snapshotRunId: state.currentRunId,
    ...(fanId ? { fanId } : automaticEligibilityWhere(settings)),
  };

  const summary = {
    scanned: 0,
    created: 0,
    existing: 0,
    skipped: {},
    dailyLimit: settings.dailyLimit,
    completedToday,
    activeCount,
    workerCount: await readyWorkerCount({ agencyId, creatorId, db }),
  };
  const skip = (code) => { summary.skipped[code] = (summary.skipped[code] || 0) + 1; };

  let cursorId = null;
  let exhausted = false;
  const batchSize = fanId ? 1 : 500;
  while (!exhausted && (fanId || capacity > 0)) {
    const candidates = await db.followBackCandidate.findMany({
      where: candidateWhere,
      orderBy: [{ discoveredAt: "asc" }, { id: "asc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: batchSize,
    });
    if (!candidates.length) break;
    summary.scanned += candidates.length;

    for (const candidate of candidates) {
      const eligibility = evaluateCandidate(candidate, settings);
      if (!eligibility.eligible) {
        skip(eligibility.code);
        // The projection remains the source of discovery metadata. For broad
        // planning sweeps we expose the calculated skip code in the summary/UI
        // without issuing thousands of no-op row updates. Manual fan actions do
        // persist the exact reason, and already-followed is a real state change.
        if (fanId || eligibility.code === "already_followed") {
          await db.followBackCandidate.update({
            where: { id: candidate.id },
            data: {
              eligibilityReason: eligibility.code,
              state: eligibility.code === "already_followed" ? "FOLLOWED" : candidate.state,
              latestError: eligibility.code,
            },
          });
        }
        continue;
      }
      if (capacity <= 0) { skip("daily_limit"); continue; }
      const active = await db.automationDelivery.findFirst({
        where: {
          agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE,
          targetId: candidate.fanId, status: { in: ACTIVE_DELIVERY_STATUSES },
        },
        select: { id: true },
      });
      if (active) { summary.existing += 1; skip("active_delivery"); continue; }

      const idempotencyKey = `follow_back:${creatorId}:${candidate.fanId}:${candidate.generation}`;
      const existing = await db.automationDelivery.findUnique({ where: { idempotencyKey } });
      if (existing) {
        summary.existing += 1;
        await db.followBackCandidate.update({
          where: { id: candidate.id },
          data: { latestDeliveryId: existing.id, latestActionType: existing.actionType, latestStatus: existing.status, latestError: existing.failureCode },
        });
        continue;
      }

      const notBefore = await nextNotBefore({
        db,
        agencyId,
        creatorId,
        actionType: FOLLOW_BACK_ACTION_TYPE,
        workspaceSettings: control.workspace.settings,
        moduleSettings: settings,
      });
      try {
        const delivery = await db.automationDelivery.create({
          data: {
            agencyId,
            creatorId,
            moduleKey: FOLLOW_BACK_MODULE_KEY,
            actionType: FOLLOW_BACK_ACTION_TYPE,
            targetId: candidate.fanId,
            fanId: candidate.fanId,
            dialogId: candidate.dialogId,
            idempotencyKey,
            generation: candidate.generation,
            priority: fanId ? Math.max(100, priority) : priority,
            payload: {
              fanId: candidate.fanId,
              username: candidate.username,
              displayName: candidate.displayName,
              subscriptionType: candidate.subscriptionType,
              snapshotRunId: candidate.snapshotRunId,
              source,
            },
            status: "QUEUED",
            scheduledAt: new Date(),
            notBefore,
            maxAttempts: settings.maxAttempts,
            createdByUserId: userId || null,
            result: { plannedBy: source, plannedAt: new Date().toISOString() },
          },
        });
        await db.followBackCandidate.update({
          where: { id: candidate.id },
          data: {
            state: "QUEUED",
            eligibilityReason: eligibility.code,
            latestDeliveryId: delivery.id,
            latestActionType: delivery.actionType,
            latestStatus: delivery.status,
            latestError: null,
          },
        });
        capacity -= 1;
        summary.created += 1;
      } catch (error) {
        if (error?.code === "P2002") {
          summary.existing += 1;
          skip("active_delivery");
          continue;
        }
        throw error;
      }
    }

    cursorId = candidates[candidates.length - 1].id;
    exhausted = fanId || candidates.length < batchSize;
  }
  return { ok: true, creatorId, source, summary };
}

async function planFollowBack(input) {
  const db = input.db || prisma;
  const execute = async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      `follow_back_plan:${input.agencyId}:${input.creatorId}`,
    );
    return planFollowBackLocked({ ...input, db: tx });
  };
  if (db === prisma) return prisma.$transaction(execute, { timeout: 30_000 });
  return execute(db);
}

async function ensureAutomaticFollowBack({ agencyId, creatorId, source = "recurring_sweep" }) {
  const control = await getAutomationControlSnapshot({ agencyId, creatorId });
  if (!control.effective.followBackEnabled) return { ok: true, created: false, reason: "module_disabled" };
  if (!control.modules.follow_back.settings.automatic) return { ok: true, created: false, reason: "automatic_disabled" };
  const directory = await prisma.subscriberDirectoryState.findFirst({
    where: { agencyId, creatorId, status: "READY" },
    select: { currentRunId: true },
  });
  if (!directory?.currentRunId) return { ok: true, created: false, reason: "snapshot_not_ready" };
  const planned = await planFollowBack({ agencyId, creatorId, userId: null, source, priority: 50 });
  return { ok: true, created: planned.summary.created > 0, reason: planned.summary.created > 0 ? "planned" : "nothing_due", planned };
}

async function retryCandidateDelivery({ agencyId, creatorId, fanId }) {
  const candidate = await prisma.followBackCandidate.findFirst({
    where: { agencyId, creatorId, fanId },
    select: { id: true, latestDeliveryId: true },
  });
  if (!candidate) {
    throw Object.assign(new Error("Follow Back candidate not found"), { code: "candidate_not_found", status: 404 });
  }
  if (!candidate.latestDeliveryId) {
    throw Object.assign(new Error("Candidate has no delivery to retry"), { code: "candidate_delivery_not_found", status: 409 });
  }
  const retried = await retryActionDelivery({ agencyId, deliveryId: candidate.latestDeliveryId });
  await prisma.followBackCandidate.update({
    where: { id: candidate.id },
    data: {
      state: "QUEUED",
      latestStatus: retried.delivery.status,
      latestError: null,
    },
  });
  return retried;
}

async function setCandidateState({ agencyId, creatorId, fanId, action }) {
  const candidate = await prisma.followBackCandidate.findFirst({ where: { agencyId, creatorId, fanId } });
  if (!candidate) throw Object.assign(new Error("Follow Back candidate not found"), { code: "candidate_not_found", status: 404 });
  const normalized = clean(action, 40);
  const data = normalized === "ignore"
    ? { ignored: true, blocked: false, state: "IGNORED", eligibilityReason: "ignored" }
    : normalized === "block"
      ? { blocked: true, ignored: false, state: "BLOCKED", eligibilityReason: "blocked" }
      : normalized === "restore"
        ? {
            blocked: false,
            ignored: false,
            state: candidate.subscribedByCreator ? "FOLLOWED" : "CANDIDATE",
            eligibilityReason: candidate.subscribedByCreator ? "already_followed" : (candidate.isActive === false ? "expired_subscriber" : "active_subscriber"),
          }
        : null;
  if (!data) throw Object.assign(new Error("Invalid candidate action"), { code: "invalid_candidate_action", status: 400 });
  const updated = await prisma.followBackCandidate.update({ where: { id: candidate.id }, data });
  if (normalized === "ignore" || normalized === "block") {
    await prisma.automationDelivery.updateMany({
      where: {
        agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, targetId: fanId,
        status: { in: ACTIVE_DELIVERY_STATUSES },
      },
      data: {
        status: "CANCELED",
        failureCode: normalized === "block" ? "blocked" : "ignored",
        lastError: `Candidate ${normalized}d`,
        finishedAt: new Date(),
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        leaseTokenHash: null,
        leaseRevision: { increment: 1 },
      },
    });
  }
  return { ok: true, candidate: updated };
}


async function countEligibleCandidates({ agencyId, creatorId, settings, now = new Date() }) {
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT COUNT(*)::bigint AS "count"
    FROM "FollowBackCandidate"
    WHERE "agencyId" = $1
      AND "creatorId" = $2
      AND "blocked" = false
      AND "ignored" = false
      AND "state" <> 'STALE'
      AND ("cooldownUntil" IS NULL OR "cooldownUntil" <= $3)
      AND COALESCE("subscribedByCreator", false) = false
      AND COALESCE("generation", 1) <= 1
      AND CASE
        WHEN "isActive" IS FALSE THEN $5
        ELSE $4
      END
      AND CASE
        WHEN lower(COALESCE("subscriptionType", '')) LIKE '%expired%' THEN $5
        WHEN lower(COALESCE("subscriptionType", '')) LIKE '%free%' THEN $6
        WHEN lower(COALESCE("subscriptionType", '')) LIKE '%paid%'
          OR lower(COALESCE("subscriptionType", '')) LIKE '%active%' THEN $7
        ELSE true
      END
    `,
    agencyId,
    creatorId,
    now,
    settings.activeSubscribers === true,
    settings.expiredSubscribers === true,
    settings.freeSubscribers === true,
    settings.paidSubscribers === true,
  );
  return Number(rows?.[0]?.count || 0);
}

async function listFollowBack({ agencyId, creatorId, search = "", state = null, offset = 0, limit = 100 }) {
  await requireCreator(agencyId, creatorId);
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const query = clean(search, 160);
  const where = {
    agencyId,
    creatorId,
    ...(state ? { state } : {}),
    ...(query ? { OR: [
      { fanId: { contains: query, mode: "insensitive" } },
      { username: { contains: query, mode: "insensitive" } },
      { displayName: { contains: query, mode: "insensitive" } },
    ] } : {}),
  };
  const now = new Date();
  const control = await getAutomationControlSnapshot({ agencyId, creatorId });
  const settings = normalizeFollowBackSettings(control.modules.follow_back.settings);
  const [items, count, deliveriesByStatus, completedToday, completedMonth, workerCount, lastRun, allCandidates, totalEligible, alreadyFollowed] = await Promise.all([
    prisma.followBackCandidate.findMany({ where, orderBy: [{ updatedAt: "desc" }], skip, take }),
    prisma.followBackCandidate.count({ where }),
    prisma.automationDelivery.groupBy({
      by: ["status"],
      where: { agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE },
      _count: { _all: true },
    }),
    prisma.automationDelivery.count({
      where: { agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) } },
    }),
    prisma.automationDelivery.count({
      where: { agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: monthStart(now) } },
    }),
    readyWorkerCount({ agencyId, creatorId }),
    prisma.automationDelivery.findFirst({
      where: { agencyId, creatorId, moduleKey: FOLLOW_BACK_MODULE_KEY, actionType: FOLLOW_BACK_ACTION_TYPE },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, status: true },
    }),
    prisma.followBackCandidate.count({ where: { agencyId, creatorId } }),
    countEligibleCandidates({ agencyId, creatorId, settings, now }),
    prisma.followBackCandidate.count({ where: { agencyId, creatorId, subscribedByCreator: true } }),
  ]);
  const statusCounts = Object.fromEntries(deliveriesByStatus.map((row) => [row.status, row._count._all]));
  const publicItems = items.map((item) => {
    const eligibility = evaluateCandidate(item, settings, now);
    return { ...item, currentEligibility: eligibility.code, eligible: eligibility.eligible };
  });
  return {
    ok: true,
    creatorId,
    control,
    settings,
    worker: { ready: workerCount > 0, readyDevices: workerCount, lastRunAt: lastRun?.updatedAt || null, lastStatus: lastRun?.status || null },
    metrics: {
      candidates: allCandidates,
      eligible: totalEligible,
      queued: statusCounts.QUEUED || 0,
      claimed: (statusCounts.CLAIMED || 0) + (statusCounts.RUNNING || 0),
      followed: statusCounts.COMPLETED || 0,
      alreadyFollowed,
      skipped: statusCounts.SKIPPED || 0,
      failed: statusCounts.FAILED || 0,
      today: completedToday,
      thisMonth: completedMonth,
    },
    items: publicItems,
    count,
    offset: skip,
    nextOffset: skip + publicItems.length,
    hasMore: skip + publicItems.length < count,
  };
}

async function getAutomationOverview({ agencyId, creatorId }) {
  const [followBack, queueByStatus, recentErrorsPage, recentSuccessPage, directory] = await Promise.all([
    listFollowBack({ agencyId, creatorId, limit: 1 }),
    prisma.automationDelivery.groupBy({
      by: ["status"],
      where: { agencyId, creatorId },
      _count: { _all: true },
    }),
    listActionDeliveries({ agencyId, creatorId, status: "FAILED", offset: 0, limit: 5 }),
    listActionDeliveries({ agencyId, creatorId, status: "COMPLETED", offset: 0, limit: 5 }),
    prisma.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId } }),
  ]);
  const statusCounts = Object.fromEntries(queueByStatus.map((row) => [row.status, row._count._all]));
  return {
    ok: true,
    creatorId,
    control: followBack.control,
    worker: followBack.worker,
    queue: {
      queued: statusCounts.QUEUED || 0,
      claimed: statusCounts.CLAIMED || 0,
      running: statusCounts.RUNNING || 0,
      failed: statusCounts.FAILED || 0,
    },
    subscriberDirectory: directory,
    followBack: followBack.metrics,
    recentErrors: recentErrorsPage.items,
    recentSuccess: recentSuccessPage.items,
  };
}

module.exports = {
  FOLLOW_BACK_ACTION_TYPE,
  evaluateCandidate,
  refreshFollowBackProjection,
  planFollowBack,
  ensureAutomaticFollowBack,
  setCandidateState,
  retryCandidateDelivery,
  listFollowBack,
  getAutomationOverview,
};
