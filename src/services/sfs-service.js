"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { assertAutomationDeliveryAdoption } = require("./automation-delivery-adoption-guard");
const { nextAutomationWriteSlot } = require("./automation-pacing-service");
const { ensurePlannedJob, createPlannedJobIfAbsent } = require("./job-planning-repository");
const { runDbTransaction, withDbAdvisoryXactLock } = require("./db-transaction-service");
const { runWithAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { projectFanObservationBatch, scheduleFanDataPointRefresh, scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service");
const { consumeFanObservationToken } = require("./fan-observation-token-service");
const { PRECOMMIT_MUTABLE_STATUSES, ACTIVE_WRITE_WORKFLOW_STATUSES } = require("./automation-delivery-statuses");
const {
  getAutomationControlSnapshot,
  assertAutomationEnabled,
  requireCreator,
  normalizeSfsSettings,
} = require("./automation-control-service");
const {
  normalizeSfsTarget,
  classifySfsFollowEffectOwnership,
  sfsTargetGenerationKey,
  sfsCommentKey,
  sfsCommentLikeKey,
  sfsUnfollowKey,
} = require("./sfs-rules");
const {
  readFanCurrentMap,
  evaluateSfsFollowCurrent,
  buildFanCurrentFieldFence,
} = require("./fan-current-consumer-service");
const {
  SFS_MODULE_KEY,
  SFS_DISCOVERY_JOB_KEY,
  SFS_TARGET_SCAN_JOB_KEY,
  SFS_FOLLOW_TARGET_ACTION_TYPE,
  SFS_COMMENT_POST_ACTION_TYPE,
  SFS_LIKE_COMMENT_ACTION_TYPE,
  SFS_UNFOLLOW_TARGET_ACTION_TYPE,
  isSfsCleanupDelivery,
} = require("./sfs-constants");

const ACTIVE_DELIVERY_STATUSES = [...ACTIVE_WRITE_WORKFLOW_STATUSES];
const RETRYABLE_FAILURES = new Set(["network_error", "timeout", "rate_limited", "temporary_of_error", "backend_unavailable", "lease_lost", "creator_unavailable", "comment_result_unknown"]);
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function dateOrNull(value) { if (!value) return null; const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
function int(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.floor(n) : fallback; }
function randomBetween(min, max) { const lo = Math.max(0, int(min)); const hi = Math.max(lo, int(max, lo)); return crypto.randomInt(lo, hi + 1); }
function dayStart(date = new Date()) { const out = new Date(date); out.setHours(0, 0, 0, 0); return out; }
function monthStart(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1); }

function currentSfsCleanupOwnership(delivery, candidate) {
  const payload = object(delivery?.payload);
  const metadata = object(candidate?.metadata);
  if (payload.legacyMigration === true && metadata.legacyMigration === true) {
    return { owned: true, kind: "LEGACY_ADOPTED", followDeliveryId: null };
  }
  const followDeliveryId = clean(payload.followDeliveryId, 160);
  const owned = payload.safetyCleanup === true
    && payload.effectOwnership === "OWNED"
    && followDeliveryId
    && metadata.followEffectOwnership === "OWNED"
    && clean(metadata.followEffectDeliveryId, 160) === followDeliveryId
    && Number(metadata.followEffectGeneration) === Number(delivery?.generation)
    && candidate?.safetyUnfollowDeliveryId === delivery?.id;
  return { owned: Boolean(owned), kind: owned ? "OWNED" : "UNPROVEN", followDeliveryId };
}

async function resolveSfsCleanupOwnership({ delivery, candidate, db }) {
  const explicit = currentSfsCleanupOwnership(delivery, candidate);
  if (explicit.owned) return explicit;
  if (!delivery || !candidate || !db?.automationDelivery?.findFirst) return explicit;

  // Backward-compatible proof for cleanup rows created before INT4.3C. We only
  // adopt a cleanup when the original SFS FOLLOW is itself a server-recorded
  // completed write with a writeCommitAt and an explicit direct provider success
  // code. Ambiguous/recovered/already-followed outcomes are intentionally excluded.
  const original = await db.automationDelivery.findFirst({
    where: {
      agencyId: delivery.agencyId,
      creatorId: delivery.creatorId,
      moduleKey: SFS_MODULE_KEY,
      actionType: SFS_FOLLOW_TARGET_ACTION_TYPE,
      fanId: candidate.targetUserId,
      generation: delivery.generation,
      status: "COMPLETED",
    },
    orderBy: { finishedAt: "desc" },
    select: { id: true, result: true, writeCommitAt: true },
  });
  if (!original?.writeCommitAt || String(object(original.result).code || "").trim().toLowerCase() !== "followed") return explicit;
  return { owned: true, kind: "ADOPTED_SERVER_PROOF", followDeliveryId: original.id };
}

async function sessionWriteWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: { agencyId, creatorId, status: "ACTIVE", sessionWriteReady: true, lastSeenAt: { gte: freshAfter }, device: { lastSeenAt: { gte: freshAfter } } },
  });
}
async function withCreatorLock(db, agencyId, creatorId, fn) {
  return withDbAdvisoryXactLock({ db, key: `p14:sfs:${agencyId}:${creatorId}`, work: fn, options: { timeout: 30_000 } });
}

async function scheduleSfsCurrentRefresh({
  agencyId, creatorId, fanIds = [], refreshFields = [], reason = "sfs_current_refresh_required",
  priority = 90, trigger = "planning", scheduleFanRefresh = scheduleFanDataPointRefresh,
} = {}) {
  return scheduleDurableFanDataRefreshDebt({
    agencyId, creatorId, fanIds, consumer: "sfs", reason, priority, trigger, refreshFields, scheduleFanRefresh,
  });
}

async function scheduleSfsDiscovery({ agencyId, creatorId, userId = null, force = false, source = "manual", priority = 75, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: SFS_MODULE_KEY, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  if (!settings.huntingEnabled) return { ok: false, created: false, reason: "hunting_disabled" };
  const bucketMs = settings.discoveryFreshnessHours * 60 * 60_000;
  const bucket = force ? Date.now() : Math.floor(Date.now() / bucketMs);
  const idempotencyKey = `sfs_discovery:${creatorId}:${bucket}`;
  const params = { source, force, requestedByUserId: userId, wallScanPosts: settings.wallScanPosts, observationTokenVersion: 1, observationReadLeaseVersion: 1 };
  const planned = await ensurePlannedJob({
    db,
    jobKey: SFS_DISCOVERY_JOB_KEY,
    scope: "creator",
    agencyId,
    creatorId,
    idempotencyKey,
    params,
    priority,
    scheduledAt: new Date(),
    nextRunAt: new Date(),
    shouldResetExisting: (existing) => force && !["SCHEDULED", "CLAIMED", "RUNNING"].includes(existing.status),
    protectedStatuses: ["CLAIMED", "RUNNING"],
  });
  const job = planned.job;
  return { ok: true, created: job?.status === "SCHEDULED", reason: "scheduled", job };
}

async function applySfsDiscoveryChunk({ db = prisma, job, deviceId = null, chunkResult, projectFanObservations = projectFanObservationBatch, consumeObservationToken = consumeFanObservationToken }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("SFS discovery job is missing creator scope");
  const payload = object(chunkResult);
  if (payload.kind !== "sfs_target_profile") return { applied: 0 };
  const target = normalizeSfsTarget(payload.target, payload.sourcePostIds);
  if (!target) return { applied: 0 };
  const producerObservedAt = dateOrNull(payload.observedAt);
  const receivedAt = new Date();
  const params = object(job.params);
  const observationTokenVersion = int(params.observationTokenVersion, 0);
  let observedAt = null;
  let observationTimeBasis = "SERVER_JOB_GENERATION";
  if (observationTokenVersion >= 1) {
    const observationToken = clean(payload.observationToken, 500);
    if (!observationToken) throw new Error("SFS_DISCOVERY_OBSERVATION_TOKEN_REQUIRED");
    const consumed = await consumeObservationToken({
      db,
      job,
      deviceId,
      leaseRevision: Number(job.leaseRevision),
      token: observationToken,
      purpose: SFS_DISCOVERY_JOB_KEY,
      subjects: [target.targetUserId],
    });
    observedAt = dateOrNull(consumed?.observedAt);
    observationTimeBasis = "SERVER_PROVIDER_READ_TOKEN";
    if (!observedAt) throw new Error("SFS_DISCOVERY_OBSERVATION_TIME_REQUIRED");
  } else {
    // Upgrade compatibility only: jobs created before the token cutover keep
    // their immutable server generation so deploy does not break in-flight work.
    observedAt = dateOrNull(job.createdAt);
    if (!observedAt) throw new Error("SFS_DISCOVERY_CAUSAL_GENERATION_REQUIRED");
  }
  const sourceJobId = clean(job.id, 180);
  if (!sourceJobId) throw new Error("SFS_DISCOVERY_SOURCE_JOB_REQUIRED");

  const suppliedObservation = object(payload.fanObservation);
  const identityFacts = Object.keys(object(suppliedObservation.identity)).length
    ? object(suppliedObservation.identity)
    : { username: target.username, platformDisplayName: target.displayName, avatarUrl: target.avatarUrl };
  const suppliedRelationship = object(suppliedObservation.relationship);
  const relationshipFacts = Object.keys(suppliedRelationship).length ? suppliedRelationship : {
    ...(target.creatorFollowing !== null && target.creatorFollowing !== undefined ? { creatorFollowsFan: target.creatorFollowing } : {}),
    ...(target.subscribePriceCents !== null && target.subscribePriceCents !== undefined ? { subscribePriceCents: target.subscribePriceCents } : {}),
  };
  const valueFacts = object(suppliedObservation.value);
  // Source and chronology are re-owned by the server job envelope. The producer
  // payload contributes facts only.
  const canonicalItem = {
    onlyFansUserId: target.targetUserId,
    ...(Object.keys(identityFacts).length ? { identity: { ...identityFacts, source: "USER_PROFILE", observedAt } } : {}),
    ...(Object.keys(relationshipFacts).length ? { relationship: { ...relationshipFacts, source: "USER_PROFILE", observedAt } } : {}),
    ...(Object.keys(valueFacts).length ? { value: { ...valueFacts, source: "USER_PROFILE", observedAt } } : {}),
  };

  // Keep SFS projection locking separate from FanData locking. Automation
  // settlement can touch FanData before SFS workflow state; overlapping those
  // lock orders here would create an avoidable cross-domain deadlock class.
  const candidateResult = await withDbAdvisoryXactLock({
    db,
    key: `p14:sfs-target:${job.agencyId}:${job.creatorId}:${target.targetUserId}`,
    options: { timeout: 30_000 },
    work: async (tx) => {
      // targetUserId is the stable opaque SFS identity. Username is mutable profile
      // data and must never select another target's historical workflow state.
      let existing = await tx.sfsTargetCandidate.findFirst({
        where: { creatorId: job.creatorId, targetUserId: target.targetUserId },
      });
      if (!existing) {
        // One-way adoption for unresolved pre-cutover rows only. A recycled
        // username that already belongs to another non-null targetUserId is never
        // merged into this identity.
        existing = await tx.sfsTargetCandidate.findFirst({
          where: { creatorId: job.creatorId, username: target.username, targetUserId: null },
        });
      }

      const currentObservedAt = dateOrNull(existing?.discoveryObservedAt);
      const currentSourceJobId = clean(existing?.discoverySourceJobId, 180) || "";
      if (currentObservedAt) {
        const delta = observedAt.getTime() - currentObservedAt.getTime();
        const sameAuthority = delta === 0 && currentSourceJobId === sourceJobId;
        const tieWins = delta === 0 && sourceJobId.localeCompare(currentSourceJobId) > 0;
        if (delta < 0 || (delta === 0 && !sameAuthority && !tieWins)) {
          return {
            applied: 0,
            stale: true,
            sideEffect: "STALE_NOOP",
            candidateId: existing?.id || null,
            observedAt: observedAt.toISOString(),
            currentObservedAt: currentObservedAt.toISOString(),
          };
        }
      }

      const usedForever = existing?.usedForever === true;
      const data = {
        targetUserId: target.targetUserId, username: target.username, displayName: target.displayName, avatarUrl: target.avatarUrl,
        subscribePriceCents: target.subscribePriceCents, isWantComments: target.isWantComments,
        creatorFollowing: target.creatorFollowing, sourcePostIds: target.sourcePostIds, lastSeenAt: observedAt,
        discoveryObservedAt: observedAt, discoverySourceJobId: sourceJobId,
        ...(usedForever ? {} : { state: existing?.state === "STALE" ? "CANDIDATE" : existing?.state || "CANDIDATE" }),
        metadata: {
          ...object(existing?.metadata), discoveryJobId: sourceJobId, profileHash: payload.profileHash || null,
          producerObservedAt: producerObservedAt?.toISOString() || null, observationTimeBasis,
        },
      };
      const row = existing
        ? await tx.sfsTargetCandidate.update({ where: { id: existing.id }, data })
        : await tx.sfsTargetCandidate.create({ data: {
          agencyId: job.agencyId, creatorId: job.creatorId, ...data,
          state: "CANDIDATE", phase: "DISCOVERY", eligibilityReason: null, discoveredAt: observedAt,
        } });
      return { applied: 1, candidateId: row.id, observedAt: observedAt.toISOString(), targetUserId: target.targetUserId };
    },
  });

  if (candidateResult.applied !== 1) return candidateResult;
  const fanProjection = await projectFanObservations(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    sourceDeviceId: clean(deviceId, 180),
    sourceJobId,
    items: [canonicalItem],
    allowedSources: ["USER_PROFILE"],
    observedAtPolicy: "TRUSTED_INPUT",
    receivedAt,
  });
  return { ...candidateResult, fanProjection };
}

async function applySfsDiscoveryCompletion({ job, result, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("SFS discovery job is missing creator scope");
  const payload = object(result);
  const control = await getAutomationControlSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  const planned = settings.automatic
    ? await planSfsTargets({ agencyId: job.agencyId, creatorId: job.creatorId, source: "discovery_complete", priority: 70, db }).catch((error) => ({ ok: false, reason: error?.code || error?.message }))
    : { ok: true, created: 0, reason: "automatic_disabled" };
  return { type: "sfs_discovery", discovered: int(payload.discovered), resolved: int(payload.resolved), planned };
}

async function recordSfsJobFailure({ job, error, terminal = true, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) return null;
  if (job.jobKey === SFS_TARGET_SCAN_JOB_KEY) {
    const params = object(job.params);
    const candidateId = clean(params.candidateId, 160);
    const candidateGeneration = int(params.candidateGeneration, -1);
    if (candidateId && candidateGeneration >= 0) {
      const updated = await db.sfsTargetCandidate.updateMany({
        where: {
          id: candidateId, agencyId: job.agencyId, creatorId: job.creatorId,
          generation: candidateGeneration, scanJobId: job.id,
        },
        data: { state: terminal ? "RECOVERY_REQUIRED" : "SCAN_RETRY", phase: "SCAN", latestError: clean(error, 1000) },
      });
      if (!updated.count) return { recorded: false, stale: true, sideEffect: "STALE_NOOP" };
    }
  }
  return { recorded: true };
}

async function loadTemplates({ agencyId, creatorId, db = prisma }) {
  const tasks = await db.automationTask.findMany({
    where: { agencyId, creatorId, type: "sfs_comment", enabled: true, status: { not: "deleted" }, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "asc" }], take: 200,
  });
  return tasks.map((task) => {
    const config = object(task.config); const rules = object(task.rules);
    return {
      id: task.id, text: clean(config.commentText ?? config.messageText, 5000),
      weight: Math.max(1, Math.min(100, int(rules.weight, 1))),
      dailyUseLimit: Math.max(1, Math.min(100, int(rules.dailyUseLimit, 20))),
      forbidSameTemplateBackToBack: rules.forbidSameTemplateBackToBack !== false,
    };
  }).filter((row) => row.text);
}

function pickTemplate(templates, lastTemplateId = null) {
  let rows = templates.filter((row) => !(row.forbidSameTemplateBackToBack && row.id === lastTemplateId));
  if (!rows.length) rows = templates.slice();
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!total) return rows[0] || null;
  let draw = crypto.randomInt(0, total);
  for (const row of rows) { draw -= row.weight; if (draw < 0) return row; }
  return rows[rows.length - 1] || null;
}

async function planSfsTargets({ agencyId, creatorId, userId = null, candidateId = null, source = "manual", priority = 70, limit = 20, db = prisma, scheduleFanRefresh = scheduleFanDataPointRefresh }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: SFS_MODULE_KEY, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  if (!settings.huntingEnabled) return { ok: false, created: 0, reason: "hunting_disabled" };
  const result = await withCreatorLock(db, agencyId, creatorId, async (tx) => {
    const today = dayStart();
    const startedToday = await tx.automationDelivery.count({
      where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_FOLLOW_TARGET_ACTION_TYPE, createdAt: { gte: today }, status: { not: "CANCELED" } },
    });
    let remaining = Math.max(0, settings.dailyLimit - startedToday);
    if (!remaining) return { ok: true, created: 0, reason: "daily_limit", dailyLimit: settings.dailyLimit, refreshFanIds: [], refreshFields: [] };
    const candidates = await tx.sfsTargetCandidate.findMany({
      where: { agencyId, creatorId, ...(candidateId ? { id: candidateId } : {}) },
      orderBy: [{ discoveredAt: "asc" }, { updatedAt: "asc" }], take: Math.min(500, Math.max(1, Number(limit) || 20) * 5),
    });
    const currentByFan = await readFanCurrentMap(tx, {
      agencyId,
      creatorId,
      fanIds: candidates.map((candidate) => candidate.targetUserId).filter(Boolean),
    });
    const created = []; const skipped = []; const refreshFanIds = new Set(); const refreshFields = new Set();
    const now = new Date();
    for (const candidate of candidates) {
      if (!remaining) break;
      const current = currentByFan.get(String(candidate.targetUserId || "")) || null;
      const eligibility = evaluateSfsFollowCurrent(candidate, current, settings, now);
      const reason = eligibility.code;
      if (!eligibility.eligible) {
        if (eligibility.refreshRequired === true && candidate.targetUserId) {
          refreshFanIds.add(String(candidate.targetUserId));
          for (const field of eligibility.refreshFields || []) refreshFields.add(field);
        }
        if (reason === "already_following") {
          await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
            creatorFollowing: true, state: "SKIPPED", phase: "DONE", eligibilityReason: "already_following", latestError: null,
          } });
        } else if (["paid_target", "comments_disabled"].includes(reason)) {
          // Current ineligibility is not historical consumption. The same opaque
          // target may become eligible later (price/comments policy can change),
          // so oneTargetForever is reserved for a completed owned SFS cycle.
          await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
            usedForever: false, state: "SKIPPED", phase: "DONE", eligibilityReason: reason,
            completedAt: null, latestError: null,
          } });
        } else if (!["blocked", "ignored", "active_delivery", "cooldown", "used_forever"].includes(reason)) {
          await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: { eligibilityReason: reason } });
        }
        skipped.push({ id: candidate.id, reason, refreshRequired: eligibility.refreshRequired === true, refreshFields: eligibility.refreshFields || [] }); continue;
      }
      if (!candidate.targetUserId) { skipped.push({ id: candidate.id, reason: "invalid_target" }); continue; }
      const active = await tx.automationDelivery.findFirst({
        where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, fanId: candidate.targetUserId, status: { in: ACTIVE_DELIVERY_STATUSES } }, select: { id: true },
      });
      if (active) { skipped.push({ id: candidate.id, reason: "active_delivery" }); continue; }
      const generation = candidate.generation + 1;
      const idempotencyKey = `${sfsTargetGenerationKey(creatorId, candidate.targetUserId, generation)}:follow`;
      const notBefore = await nextAutomationWriteSlot({
        agencyId, creatorId, actionType: SFS_FOLLOW_TARGET_ACTION_TYPE,
        workspaceSettings: control.workspace.settings, actionSettings: settings, db: tx,
      });
      let delivery;
      try {
        delivery = await tx.automationDelivery.create({ data: {
          agencyId, creatorId, originKind: "AUTOMATION", moduleKey: SFS_MODULE_KEY, actionType: SFS_FOLLOW_TARGET_ACTION_TYPE,
          targetId: candidate.targetUserId, fanId: candidate.targetUserId, idempotencyKey, generation, priority,
          payload: { candidateId: candidate.id, username: candidate.username, source, requestedByUserId: userId, originalFollowing: eligibility.current?.relationship?.creatorFollowsFan === true },
          status: "QUEUED", scheduledAt: new Date(), notBefore, maxAttempts: settings.maxAttempts, createdByUserId: userId,
        } });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        delivery = assertAutomationDeliveryAdoption(await tx.automationDelivery.findUnique({ where: { idempotencyKey } }), { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_FOLLOW_TARGET_ACTION_TYPE });
      }
      await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
        generation, state: "QUEUED", phase: "FOLLOW", eligibilityReason: null,
        latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: delivery.status, latestError: null,
      } });
      created.push({ candidateId: candidate.id, deliveryId: delivery.id, notBefore }); remaining -= 1;
    }
    return { ok: true, created: created.length, items: created, skipped, dailyLimit: settings.dailyLimit, remaining, refreshFanIds: [...refreshFanIds].slice(0, 500), refreshFields: [...refreshFields] };
  });
  if (!result?.refreshFanIds?.length) return { ...result, fanRefresh: { requested: false, fanIds: [] } };
  const fanRefresh = await scheduleSfsCurrentRefresh({
    agencyId, creatorId, fanIds: result.refreshFanIds, refreshFields: result.refreshFields,
    reason: "sfs_planning_current_refresh_required", priority: Math.max(90, Number(priority) || 70), scheduleFanRefresh,
  });
  return { ...result, fanRefresh };
}

async function scheduleTargetScan({ delivery, candidate, settings, now, db }) {
  const delay = randomBetween(settings.followToScanMinMs, settings.followToScanMaxMs);
  const nextRunAt = new Date(now.getTime() + delay);
  const idempotencyKey = `sfs_target_scan:${delivery.creatorId}:${candidate.id}:${delivery.generation}`;
  const params = {
    candidateId: candidate.id, candidateGeneration: delivery.generation, targetUserId: candidate.targetUserId, username: candidate.username,
    maxPinnedPosts: settings.maxPinnedPosts, commentsPageLimit: settings.commentsPageLimit,
    commentsMaxPages: settings.commentsMaxPages, commentLikesPerPost: settings.commentLikesPerPost,
    commentLikesEnabled: settings.commentLikesEnabled, commentsEnabled: settings.commentsEnabled,
  };
  const planned = await createPlannedJobIfAbsent({
    db,
    jobKey: SFS_TARGET_SCAN_JOB_KEY,
    scope: "creator",
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    idempotencyKey,
    params,
    priority: 85,
    scheduledAt: now,
    nextRunAt,
  });
  return planned.job;
}

async function createSafetyUnfollow({ delivery, candidate, settings, now, db, effectOwnership }) {
  if (effectOwnership !== "OWNED" || !delivery?.id || !delivery?.writeCommitAt) {
    throw Object.assign(new Error("SFS cleanup requires server-owned follow effect proof"), { code: "sfs_cleanup_effect_unowned" });
  }
  const idempotencyKey = sfsUnfollowKey(delivery.creatorId, candidate.targetUserId, delivery.generation);
  const notBefore = new Date(now.getTime() + settings.safetyUnfollowMs);
  let cleanup;
  try {
    cleanup = await db.automationDelivery.create({ data: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, originKind: "AUTOMATION", moduleKey: SFS_MODULE_KEY,
      actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE, targetId: candidate.targetUserId, fanId: candidate.targetUserId,
      idempotencyKey, generation: delivery.generation, priority: 120,
      payload: {
        candidateId: candidate.id, safetyCleanup: true, originalFollowing: false,
        effectOwnership: "OWNED", followDeliveryId: delivery.id, followGeneration: delivery.generation,
      },
      status: "QUEUED", scheduledAt: now, notBefore, maxAttempts: 20,
    } });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    cleanup = assertAutomationDeliveryAdoption(await db.automationDelivery.findUnique({ where: { idempotencyKey } }), { agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE });
  }
  return cleanup;
}

async function applySfsTargetScanCompletion({ job, result, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("SFS target scan job is missing creator scope");
  const params = object(job.params);
  const payload = object(result);
  const candidateId = clean(params.candidateId, 160);
  const candidateGeneration = int(params.candidateGeneration, -1);
  if (!candidateId || candidateGeneration < 0) {
    return { type: "sfs_target_scan", applied: false, stale: true, reason: "scan_authority_missing", sideEffect: "STALE_NOOP" };
  }

  return runDbTransaction(db, async (tx) => {
    if (typeof tx.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe('SELECT "id" FROM "SfsTargetCandidate" WHERE "id" = $1 FOR UPDATE', candidateId);
    }
    const candidate = await tx.sfsTargetCandidate.findFirst({
      where: {
        id: candidateId, agencyId: job.agencyId, creatorId: job.creatorId,
        generation: candidateGeneration, scanJobId: job.id,
      },
    });
    if (!candidate) {
      return { type: "sfs_target_scan", applied: false, stale: true, reason: "scan_authority_lost", sideEffect: "STALE_NOOP" };
    }

    const control = await getAutomationControlSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db: tx });
    const settings = normalizeSfsSettings(control.modules.sfs.settings);
    const templates = await loadTemplates({ agencyId: job.agencyId, creatorId: job.creatorId, db: tx });
    const posts = Array.isArray(payload.posts) ? payload.posts : [];
    const now = new Date();
    let commentCount = 0;
    let likeCount = 0;
    let lastTemplateId = clean(object(candidate.metadata).lastTemplateId, 160);
    const today = dayStart(now);
    const existingLikesToday = await tx.automationDelivery.count({
      where: {
        agencyId: job.agencyId, creatorId: job.creatorId, moduleKey: SFS_MODULE_KEY,
        actionType: SFS_LIKE_COMMENT_ACTION_TYPE, createdAt: { gte: today },
        status: { notIn: ["FAILED", "SKIPPED", "CANCELED"] },
      },
    });
    let remainingLikeCapacity = settings.commentLikesDailyCap > 0
      ? Math.max(0, settings.commentLikesDailyCap - existingLikesToday)
      : Number.POSITIVE_INFINITY;
    const templateUses = new Map();
    async function templateUsageToday(templateId) {
      if (templateUses.has(templateId)) return templateUses.get(templateId);
      const count = await tx.automationDelivery.count({
        where: {
          agencyId: job.agencyId, creatorId: job.creatorId, moduleKey: SFS_MODULE_KEY,
          actionType: SFS_COMMENT_POST_ACTION_TYPE, createdAt: { gte: today },
          status: { notIn: ["FAILED", "SKIPPED", "CANCELED"] },
          payload: { path: ["templateId"], equals: templateId },
        },
      });
      templateUses.set(templateId, count);
      return count;
    }

    let cursor = now;
    for (const rawPost of posts.slice(0, settings.maxPinnedPosts)) {
      const post = object(rawPost);
      const postId = clean(post.postId, 160);
      if (!postId) continue;
      if (settings.commentsEnabled && post.ownComment !== true && templates.length) {
        const availableTemplates = [];
        for (const candidateTemplate of templates) {
          if (await templateUsageToday(candidateTemplate.id) < candidateTemplate.dailyUseLimit) availableTemplates.push(candidateTemplate);
        }
        const template = pickTemplate(availableTemplates, lastTemplateId);
        if (template) {
          const idempotencyKey = sfsCommentKey(job.creatorId, candidate.targetUserId, postId, candidateGeneration);
          const delay = randomBetween(settings.minimumIntervalMs, settings.maximumIntervalMs);
          cursor = new Date(cursor.getTime() + delay);
          try {
            await tx.automationDelivery.create({ data: {
              agencyId: job.agencyId, creatorId: job.creatorId, originKind: "AUTOMATION", moduleKey: SFS_MODULE_KEY,
              actionType: SFS_COMMENT_POST_ACTION_TYPE, targetId: postId, fanId: candidate.targetUserId,
              idempotencyKey, generation: candidateGeneration, priority: 75,
              payload: { candidateId: candidate.id, targetUserId: candidate.targetUserId, postId, templateId: template.id, text: template.text },
              status: "QUEUED", scheduledAt: now, notBefore: cursor, maxAttempts: settings.maxAttempts,
            } });
            commentCount += 1;
            lastTemplateId = template.id;
            templateUses.set(template.id, (templateUses.get(template.id) || 0) + 1);
          } catch (error) {
            if (error?.code !== "P2002") throw error;
          }
        }
      }
      if (settings.commentLikesEnabled && remainingLikeCapacity > 0) {
        const perPostLimit = Math.min(settings.commentLikesPerPost, Number.isFinite(remainingLikeCapacity) ? remainingLikeCapacity : settings.commentLikesPerPost);
        for (const rawComment of (Array.isArray(post.eligibleComments) ? post.eligibleComments : []).slice(0, perPostLimit)) {
          const comment = object(rawComment);
          const commentId = clean(comment.commentId, 160);
          if (!commentId) continue;
          const idempotencyKey = sfsCommentLikeKey(job.creatorId, candidate.targetUserId, commentId, candidateGeneration);
          const delay = randomBetween(settings.minimumIntervalMs, settings.maximumIntervalMs);
          cursor = new Date(cursor.getTime() + delay);
          try {
            await tx.automationDelivery.create({ data: {
              agencyId: job.agencyId, creatorId: job.creatorId, originKind: "AUTOMATION", moduleKey: SFS_MODULE_KEY,
              actionType: SFS_LIKE_COMMENT_ACTION_TYPE, targetId: commentId, fanId: candidate.targetUserId,
              idempotencyKey, generation: candidateGeneration, priority: 65,
              payload: { candidateId: candidate.id, targetUserId: candidate.targetUserId, postId, commentId, authorId: clean(comment.authorId, 160) },
              status: "QUEUED", scheduledAt: now, notBefore: cursor, maxAttempts: settings.maxAttempts,
            } });
            likeCount += 1;
            if (Number.isFinite(remainingLikeCapacity)) remainingLikeCapacity -= 1;
          } catch (error) {
            if (error?.code !== "P2002") throw error;
          }
        }
      }
    }

    const positive = commentCount > 0 || likeCount > 0 || posts.some((post) => object(post).ownComment === true);
    const cleanupDelay = positive
      ? randomBetween(settings.unfollowMinMinutes * 60_000, settings.unfollowMaxMinutes * 60_000)
      : randomBetween(settings.quickUnfollowMinMs, settings.quickUnfollowMaxMs);
    const unfollowAt = new Date(Math.max(cursor.getTime(), now.getTime()) + cleanupDelay);
    if (candidate.safetyUnfollowDeliveryId) await tx.automationDelivery.updateMany({
      where: { id: candidate.safetyUnfollowDeliveryId, status: { in: ["QUEUED", "RETRY_SCHEDULED", "PAUSED"] } },
      data: {
        notBefore: unfollowAt, status: "QUEUED", failureCode: null, lastError: null,
        payload: {
          candidateId: candidate.id, safetyCleanup: true, originalFollowing: false, plannedAfterScan: true,
          ...(object(candidate.metadata).followEffectOwnership === "OWNED" ? {
            effectOwnership: "OWNED",
            followDeliveryId: clean(object(candidate.metadata).followEffectDeliveryId, 160),
            followGeneration: Number(object(candidate.metadata).followEffectGeneration) || candidateGeneration,
          } : {}),
        },
      },
    });
    await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      state: positive ? "ACTING" : "UNFOLLOW_DUE", phase: positive ? "ACTIONS" : "UNFOLLOW",
      commentsPlanned: commentCount, likesPlanned: likeCount, unfollowAt, latestError: null,
      metadata: { ...object(candidate.metadata), lastTemplateId, pinnedCount: posts.length, scanCompletedAt: now.toISOString(), positive },
    } });
    return { type: "sfs_target_scan", applied: true, commentsPlanned: commentCount, likesPlanned: likeCount, unfollowAt };
  }, { timeout: 30_000 });
}

async function validateSfsDelivery({ delivery, control, now = new Date(), db = prisma }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return { ok: false, terminal: true, code: "invalid_payload" };
  const candidateId = clean(object(delivery.payload).candidateId, 160);
  const candidate = candidateId ? await db.sfsTargetCandidate.findFirst({ where: { id: candidateId, agencyId: delivery.agencyId, creatorId: delivery.creatorId } }) : null;
  if (!candidate) return { ok: false, terminal: true, code: "invalid_target" };
  if (isSfsCleanupDelivery(delivery)) {
    if (candidate.completedAt || candidate.state === "COMPLETED") return { ok: false, terminal: true, code: "already_unfollowed" };
    const cleanupOwnership = await resolveSfsCleanupOwnership({ delivery, candidate, db });
    if (!cleanupOwnership.owned) {
      return { ok: false, terminal: true, code: "cleanup_effect_ownership_unproven", candidate, cleanupOwnership };
    }
    return { ok: true, candidate, cleanupOwnership };
  }
  if (!control?.effective?.sfsEnabled) return { ok: false, terminal: true, code: "module_disabled" };
  if (candidate.blocked) return { ok: false, terminal: true, code: "blocked" };
  if (candidate.ignored) return { ok: false, terminal: true, code: "ignored" };
  if (candidate.generation !== delivery.generation) return { ok: false, terminal: true, code: "stale_candidate" };
  if (delivery.notBefore && delivery.notBefore.getTime() > now.getTime()) return { ok: false, terminal: false, code: "not_before", retryAt: delivery.notBefore };
  if (delivery.actionType !== SFS_FOLLOW_TARGET_ACTION_TYPE) return { ok: true, candidate };

  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  const currentByFan = await readFanCurrentMap(db, {
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    fanIds: [candidate.targetUserId || delivery.targetId || delivery.fanId].filter(Boolean),
  });
  const current = currentByFan.get(String(candidate.targetUserId || delivery.targetId || delivery.fanId || "")) || null;
  const eligibility = evaluateSfsFollowCurrent(candidate, current, settings, now);
  if (!eligibility.eligible) {
    if (eligibility.code === "already_following") {
      return { ok: false, terminal: true, code: "already_followed", candidate, current };
    }
    if (eligibility.refreshRequired === true) {
      return {
        ok: false, terminal: false, code: eligibility.code || "sfs_fan_current_unknown",
        retryAt: new Date(now.getTime() + 30_000), candidate, current,
        refreshRequired: true,
        refreshFanIds: candidate.targetUserId ? [String(candidate.targetUserId)] : [],
        refreshFields: eligibility.refreshFields || [],
        freshnessClass: eligibility.freshnessClass || null,
      };
    }
    return { ok: false, terminal: true, code: eligibility.code || "sfs_target_ineligible", candidate, current };
  }
  return {
    ok: true,
    candidate,
    current,
    fanCurrentFence: buildFanCurrentFieldFence(current, eligibility.requiredFields || []),
  };
}

async function finalizeSfsSuccess({ delivery, outcomeCode, result = {}, db = prisma, now = new Date() }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return null;
  const candidateId = clean(object(delivery.payload).candidateId, 160);
  const candidate = candidateId ? await db.sfsTargetCandidate.findUnique({ where: { id: candidateId } }) : null;
  if (!candidate) return null;
  if (delivery.actionType === SFS_FOLLOW_TARGET_ACTION_TYPE) {
    const effectOwnership = classifySfsFollowEffectOwnership({ outcomeCode, result, delivery });
    if (effectOwnership !== "OWNED") {
      const eligibilityReason = effectOwnership === "PREEXISTING" ? "already_following" : "follow_ownership_unproven";
      return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
        state: "SKIPPED", phase: "DONE", creatorFollowing: true, eligibilityReason, usedForever: false, completedAt: null,
        latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "SKIPPED", latestError: null,
        metadata: {
          ...object(candidate.metadata), followOutcome: outcomeCode, followEffectOwnership: effectOwnership,
          followEffectDeliveryId: delivery.id, followEffectGeneration: delivery.generation, cleanupAuthorized: false,
          relationshipPreservedAt: now.toISOString(),
        },
      } });
    }
    const control = await getAutomationControlSnapshot({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db });
    const settings = normalizeSfsSettings(control.modules.sfs.settings);
    const scanJob = await scheduleTargetScan({ delivery, candidate, settings, now, db });
    const cleanup = await createSafetyUnfollow({ delivery, candidate, settings, now, db, effectOwnership });
    return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      state: "SCANNING", phase: "SCAN", creatorFollowing: true, scanJobId: scanJob.id,
      safetyUnfollowDeliveryId: cleanup.id, unfollowAt: cleanup.notBefore,
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
      metadata: {
        ...object(candidate.metadata), originalFollowing: false, followedAt: now.toISOString(), followOutcome: outcomeCode,
        followEffectOwnership: "OWNED", followEffectDeliveryId: delivery.id, followEffectGeneration: delivery.generation,
        cleanupAuthorized: true, cleanupAuthorizedAt: now.toISOString(), cleanupDeliveryId: cleanup.id,
      },
    } });
  }
  if (delivery.actionType === SFS_COMMENT_POST_ACTION_TYPE || delivery.actionType === SFS_LIKE_COMMENT_ACTION_TYPE) {
    return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
      metadata: { ...object(candidate.metadata), lastActionAt: now.toISOString(), lastActionOutcome: outcomeCode },
    } });
  }
  if (delivery.actionType === SFS_UNFOLLOW_TARGET_ACTION_TYPE) {
    const cleanupOwnership = await resolveSfsCleanupOwnership({ delivery, candidate, db });
    if (!cleanupOwnership.owned) {
      return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
        state: "RECOVERY_REQUIRED", phase: "UNFOLLOW", creatorFollowing: false, usedForever: false, completedAt: null, unfollowAt: null,
        latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: "cleanup_effect_ownership_unproven_after_write",
        metadata: {
          ...object(candidate.metadata), unfollowedAt: now.toISOString(), unfollowOutcome: outcomeCode, result: object(result),
          cleanupEffectOwnership: cleanupOwnership.kind, cleanupOwnershipIncidentAt: now.toISOString(),
        },
      } });
    }
    return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      state: "COMPLETED", phase: "DONE", creatorFollowing: false, usedForever: true, completedAt: now, unfollowAt: null,
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
      metadata: {
        ...object(candidate.metadata), unfollowedAt: now.toISOString(), unfollowOutcome: outcomeCode, result: object(result),
        cleanupEffectOwnership: cleanupOwnership.kind, cleanupFollowDeliveryId: cleanupOwnership.followDeliveryId,
      },
    } });
  }
  return null;
}

async function finalizeSfsFailure({ delivery, failureCode, retryable, db = prisma }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return null;
  const candidateId = clean(object(delivery.payload).candidateId, 160); if (!candidateId) return null;
  const cleanup = isSfsCleanupDelivery(delivery);
  return db.sfsTargetCandidate.updateMany({ where: { id: candidateId, agencyId: delivery.agencyId, creatorId: delivery.creatorId }, data: {
    state: cleanup && !retryable ? "RECOVERY_REQUIRED" : retryable ? "RETRY_SCHEDULED" : "FAILED",
    phase: cleanup ? "UNFOLLOW" : delivery.actionType === SFS_FOLLOW_TARGET_ACTION_TYPE ? "FOLLOW" : "ACTIONS",
    latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: retryable ? "RETRY_SCHEDULED" : "FAILED", latestError: failureCode,
  } });
}
async function finalizeSfsTerminal({ delivery, status, failureCode, db = prisma, now = new Date() }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return null;
  const candidateId = clean(object(delivery.payload).candidateId, 160); if (!candidateId) return null;
  if (delivery.actionType === SFS_FOLLOW_TARGET_ACTION_TYPE && status === "SKIPPED" && ["already_followed", "followed_recovered"].includes(failureCode)) {
    const effectOwnership = failureCode === "already_followed" ? "PREEXISTING" : "AMBIGUOUS_UNOWNED";
    const candidate = typeof db.sfsTargetCandidate.findFirst === "function"
      ? await db.sfsTargetCandidate.findFirst({ where: { id: candidateId, agencyId: delivery.agencyId, creatorId: delivery.creatorId } })
      : null;
    return db.sfsTargetCandidate.updateMany({ where: { id: candidateId, agencyId: delivery.agencyId, creatorId: delivery.creatorId }, data: {
      state: "SKIPPED", phase: "DONE", creatorFollowing: true, usedForever: false, completedAt: null,
      eligibilityReason: failureCode === "already_followed" ? "already_following" : "follow_ownership_unproven",
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "SKIPPED", latestError: null,
      metadata: {
        ...object(candidate?.metadata), followOutcome: failureCode, followEffectOwnership: effectOwnership, followEffectDeliveryId: delivery.id,
        followEffectGeneration: delivery.generation, cleanupAuthorized: false, relationshipPreservedAt: now.toISOString(),
      },
    } });
  }
  return db.sfsTargetCandidate.updateMany({ where: { id: candidateId }, data: {
    state: isSfsCleanupDelivery(delivery) ? "RECOVERY_REQUIRED" : status,
    latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status, latestError: failureCode,
  } });
}
async function prepareSfsRetry({ delivery, db = prisma }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return null;
  const candidateId = clean(object(delivery.payload).candidateId, 160); if (!candidateId) return null;
  return db.sfsTargetCandidate.updateMany({ where: { id: candidateId }, data: {
    state: isSfsCleanupDelivery(delivery) ? "UNFOLLOW_DUE" : "QUEUED", latestDeliveryId: delivery.id,
    latestActionType: delivery.actionType, latestStatus: "QUEUED", latestError: null,
  } });
}

async function listSfs({ agencyId, creatorId, search = "", state = null, offset = 0, limit = 100, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  const take = Math.max(1, Math.min(500, Number(limit) || 100)); const skip = Math.max(0, Number(offset) || 0); const q = clean(search, 160);
  const where = { agencyId, creatorId, ...(state ? { state } : {}), ...(q ? { OR: [
    { username: { contains: q, mode: "insensitive" } }, { displayName: { contains: q, mode: "insensitive" } }, { targetUserId: { contains: q, mode: "insensitive" } },
  ] } : {}) };
  const today = dayStart(); const month = monthStart();
  const [items, count, ready, discovery, metricsRows] = await Promise.all([
    db.sfsTargetCandidate.findMany({ where, orderBy: [{ updatedAt: "desc" }, { discoveredAt: "desc" }], skip, take }),
    db.sfsTargetCandidate.count({ where }), sessionWriteWorkerCount({ agencyId, creatorId, db }),
    db.jobInstance.findFirst({ where: { agencyId, creatorId, jobKey: { in: [SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY] } }, orderBy: { updatedAt: "desc" }, select: { id: true, jobKey: true, status: true, progress: true, lastError: true, createdAt: true, completedAt: true } }),
    Promise.all([
      db.sfsTargetCandidate.count({ where: { agencyId, creatorId } }),
      db.sfsTargetCandidate.count({ where: { agencyId, creatorId, usedForever: true } }),
      db.sfsTargetCandidate.count({ where: { agencyId, creatorId, state: "RECOVERY_REQUIRED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, status: "QUEUED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, status: { in: ["CLAIMED", "RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_COMMENT_POST_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: today } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_LIKE_COMMENT_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: today } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: today } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: month } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, status: "FAILED" } }),
    ]),
  ]);
  const [candidates, used, recoveryRequired, queued, running, commentsToday, likesToday, targetsToday, targetsMonth, failed] = metricsRows;
  const currentByFan = await readFanCurrentMap(db, { agencyId, creatorId, fanIds: items.map((item) => item.targetUserId).filter(Boolean) });
  const decisionRows = items.map((item) => {
    const current = currentByFan.get(String(item.targetUserId || "")) || null;
    const decision = evaluateSfsFollowCurrent(item, current, settings, new Date());
    const rel = current?.relationship || null;
    return {
      ...item,
      relationship: rel,
      creatorFollowing: rel?.creatorFollowsFan ?? null,
      subscribePriceCents: rel?.subscribePriceCents ?? null,
      currentEligibility: decision.code,
      eligible: decision.eligible === true,
      currentRefreshRequired: decision.refreshRequired === true,
      currentRefreshFields: decision.refreshFields || [],
    };
  });
  return {
    ok: true, creatorId, control, settings, worker: { ready: ready > 0, readyDevices: ready }, discovery,
    metrics: { candidates, used, recoveryRequired, queued, running, commentsToday, likesToday, targetsToday, targetsMonth, failed },
    items: decisionRows,
    count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count,
  };
}

async function setSfsCandidateState({ agencyId, creatorId, candidateId, action, db = prisma }) {
  if (action === "run") return planSfsTargets({ agencyId, creatorId, candidateId, source: "candidate_run", priority: 100, limit: 1, db });
  if (action === "retry") {
    const candidate = await db.sfsTargetCandidate.findFirst({ where: { id: candidateId, agencyId, creatorId } });
    if (!candidate) throw Object.assign(new Error("SFS candidate not found"), { code: "candidate_not_found", status: 404 });
    const delivery = await db.automationDelivery.findFirst({ where: { id: candidate.latestDeliveryId || "__none__", agencyId } });
    if (!delivery) return planSfsTargets({ agencyId, creatorId, candidateId, source: "candidate_retry", priority: 100, limit: 1, db });
    return { ok: true, deliveryId: delivery.id, requiresQueueRetry: true };
  }

  return runWithAutomationWriteCommitFence({ db, agencyId, options: { timeout: 30_000 }, work: async (tx) => {
    const candidate = await tx.sfsTargetCandidate.findFirst({ where: { id: candidateId, agencyId, creatorId } });
    if (!candidate) throw Object.assign(new Error("SFS candidate not found"), { code: "candidate_not_found", status: 404 });
    const data = action === "ignore" ? { ignored: true, blocked: false, state: "IGNORED" }
      : action === "block" ? { blocked: true, ignored: false, state: "BLOCKED" }
        : action === "restore" ? { blocked: false, ignored: false, state: candidate.usedForever ? "COMPLETED" : "CANDIDATE", latestError: null }
          : null;
    if (!data) throw Object.assign(new Error("Unsupported SFS candidate action"), { code: "invalid_action", status: 400 });
    const updated = await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data });
    if (["ignore", "block"].includes(action)) {
      const deliveryWhere = {
        agencyId, creatorId, moduleKey: SFS_MODULE_KEY, fanId: candidate.targetUserId || "__none__",
        status: { in: PRECOMMIT_MUTABLE_STATUSES }, actionType: { not: SFS_UNFOLLOW_TARGET_ACTION_TYPE },
      };
      if (typeof tx.automationDelivery.findMany !== "function") {
        await tx.automationDelivery.updateMany({
          where: deliveryWhere,
          data: {
            status: "CANCELED", failureCode: action === "block" ? "blocked" : "ignored",
            lastError: `SFS candidate ${action}d`, finishedAt: new Date(),
            claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 },
          },
        });
      } else {
        const deliveries = await tx.automationDelivery.findMany({
          where: deliveryWhere,
          select: { id: true, leaseRevision: true },
        });
        for (const row of deliveries) {
          const changed = await tx.automationDelivery.updateMany({
            where: { id: row.id, leaseRevision: row.leaseRevision, status: { in: PRECOMMIT_MUTABLE_STATUSES } },
            data: {
              status: "CANCELED", failureCode: action === "block" ? "blocked" : "ignored",
              lastError: `SFS candidate ${action}d`, finishedAt: new Date(),
              claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 },
            },
          });
          if (changed.count && typeof tx.fanObservationReadLease?.deleteMany === "function") {
            await tx.fanObservationReadLease.deleteMany({ where: { deliveryId: row.id, leaseRevision: row.leaseRevision } });
          }
        }
      }
    }
    return { ok: true, item: updated };
  } });
}

async function adoptLegacySfsUnfollow({ agencyId, creatorId, targetUserId, targetUsername = null, runAfter = null, sourceJobId = null, db = prisma }) {
  const targetId = clean(targetUserId, 160);
  if (!agencyId || !creatorId || !targetId) return { ok: false, created: false, reason: "invalid_target" };
  await requireCreator(agencyId, creatorId, db);
  const username = String(clean(targetUsername, 80) || `legacy_${targetId}`).replace(/^@+/, "").toLowerCase();
  const dueAt = dateOrNull(runAfter) || new Date();
  return withDbAdvisoryXactLock({
    db,
    key: `p14:sfs-target:${agencyId}:${creatorId}:${targetId}`,
    options: { timeout: 30_000 },
    work: async (tx) => {
    let candidate = await tx.sfsTargetCandidate.findFirst({ where: { creatorId, targetUserId: targetId } });
    if (!candidate) candidate = await tx.sfsTargetCandidate.findFirst({ where: { creatorId, username, targetUserId: null } });
    candidate = candidate
      ? await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
        targetUserId: targetId, username, state: "UNFOLLOW_DUE", phase: "UNFOLLOW", creatorFollowing: true,
        usedForever: true, unfollowAt: dueAt, metadata: { ...object(candidate.metadata), legacyMigration: true, sourceJobId },
      } })
      : await tx.sfsTargetCandidate.create({ data: {
        agencyId, creatorId, targetUserId: targetId, username, state: "UNFOLLOW_DUE", phase: "UNFOLLOW",
        creatorFollowing: true, usedForever: true, generation: 1, unfollowAt: dueAt,
        metadata: { legacyMigration: true, sourceJobId },
      } });
    const generation = Math.max(1, candidate.generation || 1);
    const idempotencyKey = sfsUnfollowKey(creatorId, targetId, generation);
    let delivery;
    try {
      delivery = await tx.automationDelivery.create({ data: {
        agencyId, creatorId, originKind: "AUTOMATION", moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE,
        targetId, fanId: targetId, idempotencyKey, generation, priority: 120,
        payload: { candidateId: candidate.id, safetyCleanup: true, legacyMigration: true, sourceJobId },
        status: "QUEUED", scheduledAt: new Date(), notBefore: dueAt, maxAttempts: 20,
      } });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      delivery = assertAutomationDeliveryAdoption(await tx.automationDelivery.findUnique({ where: { idempotencyKey } }), { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE });
    }
    await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      safetyUnfollowDeliveryId: delivery?.id || candidate.safetyUnfollowDeliveryId,
      latestDeliveryId: delivery?.id || candidate.latestDeliveryId, latestActionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE,
      latestStatus: delivery?.status || candidate.latestStatus,
    } });
    await tx.automationJob.updateMany({
      where: { agencyId, creatorId, type: "sfs_hunter", action: "sfs_unfollow_due", status: { in: ["scheduled", "claimed", "running"] },
        OR: [{ fanId: targetId }, { payload: { path: ["targetUserId"], equals: targetId } }] },
      data: { status: "canceled", claimedByDeviceId: null, claimedAt: null, completedAt: new Date(), error: "P14_SFS_UNFOLLOW_ADOPTED" },
    }).catch(() => null);
    return { ok: true, created: true, candidateId: candidate.id, deliveryId: delivery?.id || null, notBefore: dueAt };
    },
  });
}

async function ensureAutomaticSfs({ agencyId, creatorId, source = "scheduler", db = prisma }) {
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  if (!control.effective.sfsEnabled || !settings.automatic) return { ok: true, created: false, reason: "automatic_disabled" };
  const discovery = await scheduleSfsDiscovery({ agencyId, creatorId, source, db }).catch((error) => ({ ok: false, reason: error?.code || error?.message }));
  const planning = await planSfsTargets({ agencyId, creatorId, source, limit: settings.dailyLimit, db }).catch((error) => ({ ok: false, reason: error?.code || error?.message }));
  if (planning?.fanRefresh?.requested > 0 && planning.fanRefresh.durable !== true) {
    return { ok: false, created: Boolean(discovery?.created || planning?.created), reason: "fan_refresh_debt_not_durable", discovery, planning };
  }
  return { ok: true, created: Boolean(discovery?.created || planning?.created), discovery, planning };
}

module.exports = {
  SFS_MODULE_KEY, SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY,
  scheduleSfsDiscovery, applySfsDiscoveryChunk, applySfsDiscoveryCompletion, applySfsTargetScanCompletion,
  recordSfsJobFailure, planSfsTargets, validateSfsDelivery, finalizeSfsSuccess, finalizeSfsFailure,
  finalizeSfsTerminal, prepareSfsRetry, listSfs, setSfsCandidateState, adoptLegacySfsUnfollow, ensureAutomaticSfs,
  RETRYABLE_FAILURES,
};
