"use strict";

const prisma = require("../prisma");
const {
  getAutomationControlSnapshot,
  assertAutomationEnabled,
  normalizeFollowAutomationSettings,
  requireCreator,
} = require("./automation-control-service");
const { nextAutomationWriteSlot } = require("./automation-pacing-service");
const {
  FOLLOW_AUTOMATION_MODULE_KEY,
  UNFOLLOW_FAN_ACTION_TYPE,
  FOLLOW_FAN_ACTION_TYPE,
  ACTIVE_FOLLOW_AUTOMATION_STATUSES,
} = require("./follow-automation-constants");
const {
  evaluateRefollowCandidate,
  refollowUnfollowKey,
  refollowFollowKey,
} = require("./follow-automation-rules");
const { readFanCurrent } = require("./fan-data-authority-service");

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function dayStart(date = new Date()) { const out = new Date(date); out.setHours(0, 0, 0, 0); return out; }
function monthStart(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function randomBetween(min, max) {
  const lo = Math.max(0, Math.floor(Number(min) || 0));
  const hi = Math.max(lo, Math.floor(Number(max) || lo));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function future(ms, now = new Date()) { return new Date(now.getTime() + Math.max(0, Number(ms) || 0)); }

async function sessionWriteWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: {
      agencyId, creatorId, status: "ACTIVE", sessionWriteReady: true, lastSeenAt: { gte: freshAfter },
      device: { lastSeenAt: { gte: freshAfter } },
    },
  });
}

async function refreshFollowAutomationProjection({ db = prisma, agencyId, creatorId, runId }) {
  const run = await db.subscriberScanRun.findFirst({
    where: { id: runId, agencyId, creatorId, status: "PUBLISHED" },
    select: { id: true, publishedAt: true },
  });
  if (!run) return { ok: false, reason: "snapshot_not_published", count: 0 };
  const now = new Date();
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeFollowAutomationSettings(control.modules.follow.settings);

  await db.$executeRawUnsafe(
    `
    INSERT INTO "FollowAutomationCandidate" (
      "id", "agencyId", "creatorId", "fanId", "dialogId", "username", "displayName", "avatarUrl",
      "subscriptionType", "isActive", "subscribedByCreator", "subscribedOn", "subscribePriceCents",
      "ofBlocked", "restricted", "performer", "discoveredAt", "lastSeenAt", "eligibilityReason",
      "ignored", "blocked", "state", "phase", "generation", "nudgeCount", "cooldownUntil",
      "waitReturnUntil", "snapshotRunId", "metadata", "createdAt", "updatedAt"
    )
    SELECT
      'follow_auto_' || md5(i."creatorId" || ':' || i."fanId"), i."agencyId", i."creatorId", i."fanId",
      i."dialogId", f."username", f."displayName", f."avatarUrl", r."fanSubscriptionType", r."fanSubscriptionActive", r."creatorFollowsFan", r."fanSubscribesToCreator",
      COALESCE(r."subscribePriceCents", 0), COALESCE(r."blocked", false), COALESCE(r."restricted", false), COALESCE(r."performer", false),
      $2, r."lastSeenAt",
      CASE
        WHEN r."fanSubscriptionActive" = false AND r."creatorFollowsFan" = true THEN 'fan_expired_creator_following'
        WHEN r."fanSubscriptionActive" = true THEN 'fan_active'
        WHEN r."creatorFollowsFan" = false THEN 'creator_not_following'
        ELSE 'subscription_state_unknown'
      END,
      false, false,
      CASE
        WHEN r."fanSubscriptionActive" = false AND r."creatorFollowsFan" = true THEN 'CANDIDATE'
        WHEN r."fanSubscriptionActive" = true THEN 'NOT_ELIGIBLE'
        WHEN r."creatorFollowsFan" = false THEN 'NOT_FOLLOWING'
        ELSE 'NOT_ELIGIBLE'
      END,
      'IDLE', 0, 0, NULL, NULL, i."runId",
      COALESCE(i."metadata", '{}'::jsonb) || jsonb_build_object(
        'source', 'fan_relationship_current', 'snapshotRunId', i."runId", 'fanSubscribesToCreator', r."fanSubscribesToCreator",
        'creatorFollowsFan', r."creatorFollowsFan", 'fanSubscriptionActive', r."fanSubscriptionActive", 'relationshipObservedAt', r."observedAt"
      ), $2, $2
    FROM "SubscriberScanItem" i
    JOIN "CreatorFan" f ON f."creatorId" = i."creatorId" AND f."onlyFansUserId" = i."fanId"
    JOIN "CreatorFanRelationshipCurrent" r ON r."creatorId" = i."creatorId" AND r."onlyFansUserId" = i."fanId"
    WHERE i."runId" = $1
    ON CONFLICT ("creatorId", "fanId") DO UPDATE SET
      "dialogId" = EXCLUDED."dialogId",
      "username" = EXCLUDED."username",
      "displayName" = EXCLUDED."displayName",
      "avatarUrl" = EXCLUDED."avatarUrl",
      "subscriptionType" = EXCLUDED."subscriptionType",
      "isActive" = EXCLUDED."isActive",
      "subscribedByCreator" = EXCLUDED."subscribedByCreator",
      "subscribedOn" = EXCLUDED."subscribedOn",
      "subscribePriceCents" = EXCLUDED."subscribePriceCents",
      "ofBlocked" = EXCLUDED."ofBlocked",
      "restricted" = EXCLUDED."restricted",
      "performer" = EXCLUDED."performer",
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "eligibilityReason" = CASE
        WHEN "FollowAutomationCandidate"."blocked" = true OR EXCLUDED."ofBlocked" = true THEN 'blocked'
        WHEN "FollowAutomationCandidate"."ignored" = true THEN 'ignored'
        WHEN "FollowAutomationCandidate"."phase" IN ('UNFOLLOW', 'FOLLOW', 'RECOVERY') THEN "FollowAutomationCandidate"."eligibilityReason"
        WHEN EXCLUDED."isActive" = true AND "FollowAutomationCandidate"."nudgeCount" > 0 THEN 'fan_returned'
        WHEN EXCLUDED."isActive" = true THEN 'fan_active'
        WHEN EXCLUDED."subscribedByCreator" = false THEN 'creator_not_following'
        WHEN "FollowAutomationCandidate"."cooldownUntil" > $2 THEN 'cooldown'
        WHEN "FollowAutomationCandidate"."nudgeCount" >= $3 THEN 'max_refollow_nudges_reached'
        WHEN EXCLUDED."isActive" = false AND EXCLUDED."subscribedByCreator" = true THEN 'fan_expired_creator_following'
        ELSE 'subscription_state_unknown'
      END,
      "state" = CASE
        WHEN "FollowAutomationCandidate"."blocked" = true OR EXCLUDED."ofBlocked" = true THEN 'BLOCKED'
        WHEN "FollowAutomationCandidate"."ignored" = true THEN 'IGNORED'
        WHEN "FollowAutomationCandidate"."phase" IN ('UNFOLLOW', 'FOLLOW', 'RECOVERY') THEN "FollowAutomationCandidate"."state"
        WHEN EXCLUDED."isActive" = true AND "FollowAutomationCandidate"."nudgeCount" > 0 THEN 'RETURNED'
        WHEN EXCLUDED."isActive" = true THEN 'NOT_ELIGIBLE'
        WHEN EXCLUDED."subscribedByCreator" = false THEN 'NOT_FOLLOWING'
        WHEN "FollowAutomationCandidate"."cooldownUntil" > $2 THEN 'COOLDOWN'
        WHEN "FollowAutomationCandidate"."nudgeCount" >= $3 THEN 'MAXED'
        WHEN EXCLUDED."isActive" = false AND EXCLUDED."subscribedByCreator" = true THEN 'CANDIDATE'
        ELSE 'NOT_ELIGIBLE'
      END,
      "phase" = CASE
        WHEN "FollowAutomationCandidate"."phase" IN ('UNFOLLOW', 'FOLLOW', 'RECOVERY') THEN "FollowAutomationCandidate"."phase"
        WHEN EXCLUDED."isActive" = true AND "FollowAutomationCandidate"."nudgeCount" > 0 THEN 'DONE'
        ELSE 'IDLE'
      END,
      "waitReturnUntil" = CASE WHEN EXCLUDED."isActive" = true THEN NULL ELSE "FollowAutomationCandidate"."waitReturnUntil" END,
      "snapshotRunId" = EXCLUDED."snapshotRunId",
      "metadata" = COALESCE("FollowAutomationCandidate"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
      "updatedAt" = EXCLUDED."updatedAt"
    `,
    runId,
    now,
    settings.maxNudgesPerFan,
  );

  await db.followAutomationCandidate.updateMany({
    where: {
      agencyId, creatorId, snapshotRunId: { not: runId },
      phase: { notIn: ["UNFOLLOW", "FOLLOW", "RECOVERY"] },
    },
    data: { state: "STALE", eligibilityReason: "stale_candidate", updatedAt: now },
  });
  const count = await db.followAutomationCandidate.count({ where: { agencyId, creatorId, snapshotRunId: runId } });
  let planned = null;
  if (control.effective.followEnabled && settings.automatic && settings.refollowEnabled) {
    planned = await planFollowAutomation({ db, agencyId, creatorId, userId: null, source: "snapshot_publish" });
  }
  return { ok: true, count, runId, planned };
}

async function planFollowAutomationLocked({ db, agencyId, creatorId, userId, fanId = null, source = "manual", priority = 65 }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, db });
  const settings = normalizeFollowAutomationSettings(control.modules.follow.settings);
  if (!settings.refollowEnabled) return { ok: true, creatorId, source, summary: { scanned: 0, created: 0, existing: 0, skipped: { refollow_disabled: 1 } } };
  const directory = await db.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId, status: "READY" } });
  if (!directory?.currentRunId) throw Object.assign(new Error("Subscriber snapshot is not ready"), { code: "snapshot_not_ready", status: 409 });
  const now = new Date();
  const [completedToday, activeCycles] = await Promise.all([
    db.automationDelivery.count({
      where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: FOLLOW_FAN_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) } },
    }),
    db.followAutomationCandidate.count({
      where: { agencyId, creatorId, phase: { in: ["UNFOLLOW", "FOLLOW", "RECOVERY"] } },
    }),
  ]);
  let capacity = Math.max(0, settings.dailyLimit - completedToday - activeCycles);
  const summary = {
    scanned: 0, created: 0, existing: 0, skipped: {}, dailyLimit: settings.dailyLimit,
    completedToday, activeCycles, workerCount: await sessionWriteWorkerCount({ agencyId, creatorId, db }),
  };
  const skip = (code) => { summary.skipped[code] = (summary.skipped[code] || 0) + 1; };
  let cursorId = null;
  const batchSize = fanId ? 1 : 500;
  for (;;) {
    const candidates = await db.followAutomationCandidate.findMany({
      where: {
        agencyId, creatorId, snapshotRunId: directory.currentRunId,
        ...(fanId ? { fanId } : { state: { not: "STALE" } }),
      },
      orderBy: [{ discoveredAt: "asc" }, { id: "asc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: batchSize,
    });
    if (!candidates.length) break;
    summary.scanned += candidates.length;
    for (const candidate of candidates) {
      const eligibility = evaluateRefollowCandidate(candidate, settings, now);
      if (!eligibility.eligible) {
        skip(eligibility.code);
        if (fanId) await db.followAutomationCandidate.update({
          where: { id: candidate.id },
          data: { eligibilityReason: eligibility.code, latestError: eligibility.code },
        });
        continue;
      }
      if (capacity <= 0) { skip("daily_limit"); continue; }
      const active = await db.automationDelivery.findFirst({
        where: {
          agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY,
          targetId: candidate.fanId, status: { in: ACTIVE_FOLLOW_AUTOMATION_STATUSES },
        }, select: { id: true },
      });
      if (active) { summary.existing += 1; skip("active_delivery"); continue; }
      const generation = Number(candidate.generation || 0) + 1;
      const idempotencyKey = refollowUnfollowKey({ creatorId, fanId: candidate.fanId, generation });
      const existing = await db.automationDelivery.findUnique({ where: { idempotencyKey } });
      if (existing) {
        summary.existing += 1;
        await db.followAutomationCandidate.update({
          where: { id: candidate.id },
          data: { latestDeliveryId: existing.id, latestActionType: existing.actionType, latestStatus: existing.status, latestError: existing.failureCode },
        });
        continue;
      }
      const notBefore = await nextAutomationWriteSlot({
        db, agencyId, creatorId, actionType: UNFOLLOW_FAN_ACTION_TYPE,
        workspaceSettings: control.workspace.settings, actionSettings: settings, now,
      });
      try {
        const delivery = await db.automationDelivery.create({
          data: {
            agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: UNFOLLOW_FAN_ACTION_TYPE,
            targetId: candidate.fanId, fanId: candidate.fanId, dialogId: candidate.dialogId,
            idempotencyKey, generation, priority: fanId ? Math.max(100, priority) : priority,
            payload: {
              fanId: candidate.fanId, username: candidate.username, displayName: candidate.displayName,
              snapshotRunId: candidate.snapshotRunId, source, recovery: false, refollowGeneration: generation,
            },
            status: "QUEUED", scheduledAt: now, notBefore, maxAttempts: settings.maxAttempts,
            createdByUserId: userId || null, result: { plannedBy: source, plannedAt: now.toISOString(), sagaStep: "unfollow" },
          },
        });
        await db.followAutomationCandidate.update({
          where: { id: candidate.id },
          data: {
            generation, state: "QUEUED_UNFOLLOW", phase: "UNFOLLOW", eligibilityReason: eligibility.code,
            latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: delivery.status, latestError: null,
          },
        });
        capacity -= 1;
        summary.created += 1;
      } catch (error) {
        if (error?.code === "P2002") { summary.existing += 1; skip("active_delivery"); continue; }
        throw error;
      }
    }
    cursorId = candidates[candidates.length - 1].id;
    if (fanId || candidates.length < batchSize || capacity <= 0) break;
  }
  return { ok: true, creatorId, source, summary };
}

async function planFollowAutomation(input) {
  const db = input.db || prisma;
  const execute = async (tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `follow_automation_plan:${input.agencyId}:${input.creatorId}`);
    return planFollowAutomationLocked({ ...input, db: tx });
  };
  if (db === prisma) return prisma.$transaction(execute, { timeout: 30_000 });
  return execute(db);
}

async function ensureAutomaticFollowAutomation({ agencyId, creatorId, source = "recurring_sweep" }) {
  const control = await getAutomationControlSnapshot({ agencyId, creatorId });
  const settings = control.modules.follow.settings;
  if (!control.effective.followEnabled) return { ok: true, created: false, reason: "module_disabled" };
  if (!settings.automatic || !settings.refollowEnabled) return { ok: true, created: false, reason: "automatic_disabled" };
  const directory = await prisma.subscriberDirectoryState.findFirst({ where: { agencyId, creatorId, status: "READY" }, select: { currentRunId: true } });
  if (!directory?.currentRunId) return { ok: true, created: false, reason: "snapshot_not_ready" };
  const planned = await planFollowAutomation({ agencyId, creatorId, userId: null, source, priority: 55 });
  return { ok: true, created: planned.summary.created > 0, reason: planned.summary.created ? "planned" : "nothing_due", planned };
}

async function validateFollowAutomationDelivery({ delivery, control, now = new Date(), db = prisma }) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return { ok: true };
  const candidate = await db.followAutomationCandidate.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId },
  });
  if (!candidate) return { ok: false, terminal: true, status: "SKIPPED", code: "invalid_target" };
  if (Number(candidate.generation) !== Number(delivery.generation)) return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
  if (delivery.actionType === FOLLOW_FAN_ACTION_TYPE) {
    if (!object(delivery.payload).recovery) return { ok: false, terminal: true, status: "SKIPPED", code: "invalid_payload" };
    if (!["FOLLOW", "RECOVERY"].includes(candidate.phase) && candidate.creatorFollowsFan !== true) {
      return { ok: false, terminal: false, code: "recovery_state_mismatch", retryAt: future(60_000, now) };
    }
    return { ok: true, candidate };
  }
  if (delivery.actionType !== UNFOLLOW_FAN_ACTION_TYPE) return { ok: false, terminal: true, status: "SKIPPED", code: "invalid_action_type" };
  const directory = await db.subscriberDirectoryState.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, status: "READY" }, select: { currentRunId: true },
  });
  if (!directory?.currentRunId || candidate.snapshotRunId !== directory.currentRunId) return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
  const settings = normalizeFollowAutomationSettings(control.modules.follow.settings);
  const eligibility = evaluateRefollowCandidate({ ...candidate, phase: "IDLE" }, settings, now);
  if (!eligibility.eligible) {
    const retryable = eligibility.code === "cooldown";
    return { ok: false, terminal: !retryable, status: "SKIPPED", code: eligibility.code, retryAt: retryable ? candidate.cooldownUntil : null };
  }
  const completedToday = await db.automationDelivery.count({
    where: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY,
      actionType: FOLLOW_FAN_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) }, id: { not: delivery.id },
    },
  });
  if (completedToday >= settings.dailyLimit) return { ok: false, terminal: false, code: "daily_limit", retryAt: future(24 * 60 * 60_000, dayStart(now)) };
  return { ok: true, candidate };
}

async function finalizeFollowAutomationSuccess({ delivery, outcomeCode, result = {}, db = prisma, now = new Date() }) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return null;
  const fanId = delivery.targetId || delivery.fanId;
  const candidate = await db.followAutomationCandidate.findFirst({ where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId } });
  if (!candidate) return null;
  if (delivery.actionType === UNFOLLOW_FAN_ACTION_TYPE) {
    const control = await getAutomationControlSnapshot({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db });
    const settings = normalizeFollowAutomationSettings(control.modules.follow.settings);
    const baseSlot = await nextAutomationWriteSlot({
      db, agencyId: delivery.agencyId, creatorId: delivery.creatorId, actionType: FOLLOW_FAN_ACTION_TYPE,
      workspaceSettings: control.workspace.settings, actionSettings: settings, now,
    });
    const pauseMs = randomBetween(settings.refollowPauseMinMs, settings.refollowPauseMaxMs);
    const notBefore = new Date(Math.max(baseSlot.getTime(), now.getTime() + pauseMs));
    const idempotencyKey = refollowFollowKey({ creatorId: delivery.creatorId, fanId, generation: delivery.generation });
    let follow = await db.automationDelivery.findUnique({ where: { idempotencyKey } });
    if (!follow) {
      follow = await db.automationDelivery.create({
        data: {
          agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY,
          actionType: FOLLOW_FAN_ACTION_TYPE, targetId: fanId, fanId, dialogId: delivery.dialogId,
          idempotencyKey, generation: delivery.generation, priority: Math.max(110, delivery.priority),
          payload: {
            fanId, sourceDeliveryId: delivery.id, source: object(delivery.payload).source || "refollow_saga",
            recovery: true, refollowGeneration: delivery.generation, snapshotRunId: candidate.snapshotRunId,
          },
          status: "QUEUED", scheduledAt: now, notBefore,
          maxAttempts: Math.max(settings.recoveryMaxAttempts, settings.maxAttempts),
          createdByUserId: delivery.createdByUserId || null,
          result: { plannedBy: "refollow_recovery", plannedAt: now.toISOString(), sagaStep: "follow", sourceDeliveryId: delivery.id },
        },
      });
    }
    await db.followAutomationCandidate.update({
      where: { id: candidate.id },
      data: {
        creatorFollowsFan: false, state: "QUEUED_FOLLOW", phase: "FOLLOW", eligibilityReason: "refollow_restore_pending",
        latestDeliveryId: follow.id, latestActionType: follow.actionType, latestStatus: follow.status, latestError: null,
        metadata: { ...object(candidate.metadata), lastUnfollowDeliveryId: delivery.id, lastUnfollowAt: now.toISOString(), lastUnfollowOutcome: outcomeCode || null },
      },
    });
    return { candidateId: candidate.id, followDeliveryId: follow.id, notBefore };
  }
  if (delivery.actionType === FOLLOW_FAN_ACTION_TYPE) {
    const control = await getAutomationControlSnapshot({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db });
    const settings = normalizeFollowAutomationSettings(control.modules.follow.settings);
    const waitReturnUntil = future(settings.refollowCooldownDays * 24 * 60 * 60_000, now);
    await db.followAutomationCandidate.update({
      where: { id: candidate.id },
      data: {
        creatorFollowsFan: true, state: "WAITING_RETURN", phase: "WAIT_RETURN",
        nudgeCount: { increment: 1 }, cooldownUntil: waitReturnUntil, waitReturnUntil,
        eligibilityReason: "refollow_nudge_sent_waiting_return", latestDeliveryId: delivery.id,
        latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
        metadata: { ...object(candidate.metadata), lastFollowDeliveryId: delivery.id, lastRefollowAt: now.toISOString(), lastFollowOutcome: outcomeCode || null, result: object(result) },
      },
    });
    return { candidateId: candidate.id, waitReturnUntil };
  }
  return null;
}

async function finalizeFollowAutomationFailure({ delivery, failureCode, retryable, db = prisma, now = new Date() }) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return null;
  const fanId = delivery.targetId || delivery.fanId;
  const recovery = delivery.actionType === FOLLOW_FAN_ACTION_TYPE;
  await db.followAutomationCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId },
    data: {
      state: retryable
        ? (recovery ? "QUEUED_FOLLOW" : "QUEUED_UNFOLLOW")
        : (recovery ? "RECOVERY_REQUIRED" : "FAILED"),
      phase: recovery ? (retryable ? "FOLLOW" : "RECOVERY") : (retryable ? "UNFOLLOW" : "IDLE"),
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType,
      latestStatus: retryable ? "RETRY_SCHEDULED" : "FAILED", latestError: failureCode,
      eligibilityReason: recovery && !retryable ? "recovery_required" : failureCode,
      metadata: { failureCode, failedAt: now.toISOString(), recovery },
    },
  });
  return { recoveryRequired: recovery && !retryable };
}

async function finalizeFollowAutomationTerminal({ delivery, status, failureCode, db = prisma }) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return null;
  if (delivery.actionType === FOLLOW_FAN_ACTION_TYPE && status === "CANCELED") {
    throw Object.assign(new Error("A refollow recovery action cannot be canceled"), { code: "UNSAFE_RECOVERY_CANCEL", status: 409 });
  }
  return finalizeFollowAutomationFailure({ delivery, failureCode: failureCode || status.toLowerCase(), retryable: false, db });
}

async function prepareFollowAutomationRetry({ delivery, db = prisma }) {
  if (!delivery || delivery.moduleKey !== FOLLOW_AUTOMATION_MODULE_KEY) return null;
  const recovery = delivery.actionType === FOLLOW_FAN_ACTION_TYPE;
  const changed = await db.followAutomationCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanId: delivery.targetId || delivery.fanId },
    data: {
      state: recovery ? "QUEUED_FOLLOW" : "QUEUED_UNFOLLOW",
      phase: recovery ? "FOLLOW" : "UNFOLLOW",
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType,
      latestStatus: "QUEUED", latestError: null,
    },
  });
  return { changed: changed.count };
}

async function setFollowAutomationCandidateState({ agencyId, creatorId, fanId, action, db = prisma }) {
  const candidate = await db.followAutomationCandidate.findFirst({ where: { agencyId, creatorId, fanId } });
  if (!candidate) throw Object.assign(new Error("Follow candidate not found"), { code: "candidate_not_found", status: 404 });
  const activeRecovery = ["FOLLOW", "RECOVERY"].includes(candidate.phase);
  const data = action === "ignore"
    ? { ignored: true, blocked: false, ...(activeRecovery ? {} : { state: "IGNORED", phase: "IDLE" }), eligibilityReason: "ignored" }
    : action === "block"
      ? { blocked: true, ignored: false, ...(activeRecovery ? {} : { state: "BLOCKED", phase: "IDLE" }), eligibilityReason: "blocked" }
      : action === "restore"
        ? { blocked: false, ignored: false, state: activeRecovery ? candidate.state : "CANDIDATE", eligibilityReason: activeRecovery ? candidate.eligibilityReason : "restored" }
        : null;
  if (!data) throw Object.assign(new Error("Unsupported candidate action"), { code: "invalid_candidate_action", status: 400 });
  return db.followAutomationCandidate.update({ where: { id: candidate.id }, data });
}

async function listFollowAutomation({ agencyId, creatorId, search = "", state = null, offset = 0, limit = 100, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeFollowAutomationSettings(control.modules.follow.settings);
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const text = clean(search, 160);
  const where = {
    agencyId, creatorId,
    ...(state ? { state } : {}),
    ...(text ? { OR: [
      { fanId: { contains: text, mode: "insensitive" } },
      { username: { contains: text, mode: "insensitive" } },
      { displayName: { contains: text, mode: "insensitive" } },
    ] } : {}),
  };
  const now = new Date();
  const [items, count, readyDevices, metrics] = await Promise.all([
    db.followAutomationCandidate.findMany({ where, orderBy: [{ updatedAt: "desc" }, { discoveredAt: "desc" }], skip, take }),
    db.followAutomationCandidate.count({ where }),
    sessionWriteWorkerCount({ agencyId, creatorId, db }),
    Promise.all([
      db.followAutomationCandidate.count({ where: { agencyId, creatorId } }),
      db.followAutomationCandidate.count({ where: { agencyId, creatorId, state: "CANDIDATE" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: UNFOLLOW_FAN_ACTION_TYPE, status: { in: ["QUEUED", "RETRY_SCHEDULED"] } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: FOLLOW_FAN_ACTION_TYPE, status: { in: ["QUEUED", "RETRY_SCHEDULED"] } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, status: { in: ["CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] } } }),
      db.followAutomationCandidate.count({ where: { agencyId, creatorId, state: "WAITING_RETURN" } }),
      db.followAutomationCandidate.count({ where: { agencyId, creatorId, state: "RETURNED" } }),
      db.followAutomationCandidate.count({ where: { agencyId, creatorId, state: "RECOVERY_REQUIRED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, status: "FAILED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: FOLLOW_FAN_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: FOLLOW_AUTOMATION_MODULE_KEY, actionType: FOLLOW_FAN_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: monthStart(now) } } }),
    ]),
  ]);
  const currentRows = await readFanCurrent(db, {
    agencyId, creatorId, onlyFansUserIds: items.map((item) => item.fanId),
  });
  const currentByFan = new Map(currentRows.map((row) => [String(row.onlyFansUserId), row]));
  const mapped = items.map((item) => {
    const eligibility = evaluateRefollowCandidate(item, settings, now);
    const current = currentByFan.get(String(item.fanId)) || null;
    return {
      ...item,
      eligible: eligibility.eligible,
      currentEligibility: eligibility.code,
      platformIdentity: current?.platformIdentity || null,
      relationship: current?.relationship || null,
      value: current?.value || null,
      // Compatibility aliases only; automation decisions use explicit relationship vocabulary.
      subscriptionType: item.fanSubscriptionType ?? null,
      isActive: item.fanSubscriptionActive ?? null,
      subscribedByCreator: item.creatorFollowsFan ?? null,
      subscribedOn: item.fanSubscribesToCreator ?? null,
    };
  });
  return {
    ok: true, creatorId, control, settings, worker: { ready: readyDevices > 0, readyDevices },
    metrics: {
      candidates: metrics[0], eligible: metrics[1], queuedUnfollow: metrics[2], queuedFollow: metrics[3],
      running: metrics[4], waitingReturn: metrics[5], returned: metrics[6], recoveryRequired: metrics[7],
      failed: metrics[8], today: metrics[9], thisMonth: metrics[10],
    },
    items: mapped, count, offset: skip, nextOffset: skip + mapped.length, hasMore: skip + mapped.length < count,
  };
}

module.exports = {
  FOLLOW_AUTOMATION_MODULE_KEY,
  UNFOLLOW_FAN_ACTION_TYPE,
  FOLLOW_FAN_ACTION_TYPE,
  refreshFollowAutomationProjection,
  planFollowAutomation,
  ensureAutomaticFollowAutomation,
  validateFollowAutomationDelivery,
  finalizeFollowAutomationSuccess,
  finalizeFollowAutomationFailure,
  finalizeFollowAutomationTerminal,
  prepareFollowAutomationRetry,
  setFollowAutomationCandidateState,
  listFollowAutomation,
};
