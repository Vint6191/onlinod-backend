"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { nextAutomationWriteSlot } = require("./automation-pacing-service");
const {
  getAutomationControlSnapshot,
  assertAutomationEnabled,
  requireCreator,
  normalizeSfsSettings,
} = require("./automation-control-service");
const {
  targetEligibility,
  normalizeSfsTarget,
  shouldStartSfsSagaAfterFollow,
  sfsTargetGenerationKey,
  sfsCommentKey,
  sfsCommentLikeKey,
  sfsUnfollowKey,
} = require("./sfs-rules");
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

const ACTIVE_DELIVERY_STATUSES = ["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED", "PAUSED"];
const RETRYABLE_FAILURES = new Set(["network_error", "timeout", "rate_limited", "temporary_of_error", "backend_unavailable", "lease_lost", "creator_unavailable", "comment_result_unknown"]);
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function dateOrNull(value) { if (!value) return null; const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
function int(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.floor(n) : fallback; }
function randomBetween(min, max) { const lo = Math.max(0, int(min)); const hi = Math.max(lo, int(max, lo)); return crypto.randomInt(lo, hi + 1); }
function dayStart(date = new Date()) { const out = new Date(date); out.setHours(0, 0, 0, 0); return out; }
function monthStart(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1); }

async function readyWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: { agencyId, creatorId, status: "ACTIVE", lastSeenAt: { gte: freshAfter }, device: { lastSeenAt: { gte: freshAfter } } },
  });
}
async function withCreatorLock(db, agencyId, creatorId, fn) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`p14:sfs:${agencyId}:${creatorId}`}))`;
    return fn(tx);
  }, { timeout: 30_000 });
}

async function scheduleSfsDiscovery({ agencyId, creatorId, userId = null, force = false, source = "manual", priority = 75, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: SFS_MODULE_KEY, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  if (!settings.huntingEnabled) return { ok: false, created: false, reason: "hunting_disabled" };
  if (!await readyWorkerCount({ agencyId, creatorId, db })) return { ok: false, created: false, reason: "no_ready_worker" };
  const bucketMs = settings.discoveryFreshnessHours * 60 * 60_000;
  const bucket = force ? Date.now() : Math.floor(Date.now() / bucketMs);
  const idempotencyKey = `sfs_discovery:${creatorId}:${bucket}`;
  const params = { source, force, requestedByUserId: userId, wallScanPosts: settings.wallScanPosts };
  let job = await db.jobInstance.findUnique({ where: { idempotencyKey } });
  if (!job) {
    try {
      job = await db.jobInstance.create({ data: {
        jobKey: SFS_DISCOVERY_JOB_KEY, scope: "creator", agencyId, creatorId, idempotencyKey, params,
        status: "SCHEDULED", priority, scheduledAt: new Date(), nextRunAt: new Date(),
      } });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      job = await db.jobInstance.findUnique({ where: { idempotencyKey } });
    }
  } else if (force && !["SCHEDULED", "CLAIMED", "RUNNING"].includes(job.status)) {
    job = await db.jobInstance.update({ where: { id: job.id }, data: {
      status: "SCHEDULED", params, priority, scheduledAt: new Date(), nextRunAt: new Date(), claimedAt: null,
      claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null, continuation: null,
      progress: null, lastProgressAt: null, completedAt: null, lastError: null, attempts: 0, result: null,
      leaseRevision: { increment: 1 },
    } });
  }
  return { ok: true, created: job?.status === "SCHEDULED", reason: "scheduled", job };
}

async function applySfsDiscoveryChunk({ db = prisma, job, chunkResult }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("SFS discovery job is missing creator scope");
  const payload = object(chunkResult);
  if (payload.kind !== "sfs_target_profile") return { applied: 0 };
  const target = normalizeSfsTarget(payload.target, payload.sourcePostIds);
  if (!target) return { applied: 0 };
  const now = dateOrNull(payload.observedAt) || new Date();
  const existing = await db.sfsTargetCandidate.findUnique({ where: { creatorId_username: { creatorId: job.creatorId, username: target.username } } });
  const usedForever = existing?.usedForever === true;
  const row = await db.sfsTargetCandidate.upsert({
    where: { creatorId_username: { creatorId: job.creatorId, username: target.username } },
    create: {
      agencyId: job.agencyId, creatorId: job.creatorId, targetUserId: target.targetUserId, username: target.username,
      displayName: target.displayName, avatarUrl: target.avatarUrl, subscribePriceCents: target.subscribePriceCents,
      isWantComments: target.isWantComments, creatorFollowing: target.creatorFollowing, sourcePostIds: target.sourcePostIds,
      state: "CANDIDATE", phase: "DISCOVERY", eligibilityReason: null, discoveredAt: now, lastSeenAt: now,
      metadata: { discoveryJobId: job.id, profileHash: payload.profileHash || null },
    },
    update: {
      targetUserId: target.targetUserId, displayName: target.displayName, avatarUrl: target.avatarUrl,
      subscribePriceCents: target.subscribePriceCents, isWantComments: target.isWantComments,
      creatorFollowing: target.creatorFollowing, sourcePostIds: target.sourcePostIds, lastSeenAt: now,
      ...(usedForever ? {} : { state: existing?.state === "STALE" ? "CANDIDATE" : existing?.state || "CANDIDATE" }),
      metadata: { ...object(existing?.metadata), discoveryJobId: job.id, profileHash: payload.profileHash || null },
    },
  });
  return { applied: 1, candidateId: row.id };
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
    const candidateId = clean(object(job.params).candidateId, 160);
    if (candidateId) await db.sfsTargetCandidate.updateMany({
      where: { id: candidateId, agencyId: job.agencyId, creatorId: job.creatorId },
      data: { state: terminal ? "RECOVERY_REQUIRED" : "SCAN_RETRY", phase: "SCAN", latestError: clean(error, 1000), scanJobId: job.id },
    });
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

async function planSfsTargets({ agencyId, creatorId, userId = null, candidateId = null, source = "manual", priority = 70, limit = 20, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: SFS_MODULE_KEY, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  if (!settings.huntingEnabled) return { ok: false, created: 0, reason: "hunting_disabled" };
  return withCreatorLock(db, agencyId, creatorId, async (tx) => {
    const today = dayStart();
    const startedToday = await tx.automationDelivery.count({
      where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_FOLLOW_TARGET_ACTION_TYPE, createdAt: { gte: today }, status: { not: "CANCELED" } },
    });
    let remaining = Math.max(0, settings.dailyLimit - startedToday);
    if (!remaining) return { ok: true, created: 0, reason: "daily_limit", dailyLimit: settings.dailyLimit };
    const candidates = await tx.sfsTargetCandidate.findMany({
      where: { agencyId, creatorId, ...(candidateId ? { id: candidateId } : {}) },
      orderBy: [{ discoveredAt: "asc" }, { updatedAt: "asc" }], take: Math.min(500, Math.max(1, Number(limit) || 20) * 5),
    });
    const created = []; const skipped = [];
    for (const candidate of candidates) {
      if (!remaining) break;
      const reason = targetEligibility(candidate, settings);
      if (reason !== "eligible") {
        if (["paid_target", "comments_disabled"].includes(reason)) {
          await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
            usedForever: true, state: "SKIPPED", phase: "DONE", eligibilityReason: reason,
            completedAt: candidate.completedAt || new Date(), latestError: null,
          } });
        } else if (!["blocked", "ignored", "active_delivery", "cooldown", "used_forever"].includes(reason)) {
          await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: { eligibilityReason: reason } });
        }
        skipped.push({ id: candidate.id, reason }); continue;
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
          agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_FOLLOW_TARGET_ACTION_TYPE,
          targetId: candidate.targetUserId, fanId: candidate.targetUserId, idempotencyKey, generation, priority,
          payload: { candidateId: candidate.id, username: candidate.username, source, requestedByUserId: userId, originalFollowing: candidate.creatorFollowing === true },
          status: "QUEUED", scheduledAt: new Date(), notBefore, maxAttempts: settings.maxAttempts, createdByUserId: userId,
        } });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        delivery = await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
      }
      await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
        generation, state: "QUEUED", phase: "FOLLOW", eligibilityReason: null,
        latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: delivery.status, latestError: null,
      } });
      created.push({ candidateId: candidate.id, deliveryId: delivery.id, notBefore }); remaining -= 1;
    }
    return { ok: true, created: created.length, items: created, skipped, dailyLimit: settings.dailyLimit, remaining };
  });
}

async function scheduleTargetScan({ delivery, candidate, settings, now, db }) {
  const delay = randomBetween(settings.followToScanMinMs, settings.followToScanMaxMs);
  const nextRunAt = new Date(now.getTime() + delay);
  const idempotencyKey = `sfs_target_scan:${delivery.creatorId}:${candidate.id}:${delivery.generation}`;
  const params = {
    candidateId: candidate.id, targetUserId: candidate.targetUserId, username: candidate.username,
    maxPinnedPosts: settings.maxPinnedPosts, commentsPageLimit: settings.commentsPageLimit,
    commentsMaxPages: settings.commentsMaxPages, commentLikesPerPost: settings.commentLikesPerPost,
    commentLikesEnabled: settings.commentLikesEnabled, commentsEnabled: settings.commentsEnabled,
  };
  let job;
  try {
    job = await db.jobInstance.create({ data: {
      jobKey: SFS_TARGET_SCAN_JOB_KEY, scope: "creator", agencyId: delivery.agencyId, creatorId: delivery.creatorId,
      idempotencyKey, params, status: "SCHEDULED", priority: 85, scheduledAt: now, nextRunAt,
    } });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    job = await db.jobInstance.findUnique({ where: { idempotencyKey } });
  }
  return job;
}

async function createSafetyUnfollow({ delivery, candidate, settings, now, db }) {
  const idempotencyKey = sfsUnfollowKey(delivery.creatorId, candidate.targetUserId, delivery.generation);
  const notBefore = new Date(now.getTime() + settings.safetyUnfollowMs);
  let cleanup;
  try {
    cleanup = await db.automationDelivery.create({ data: {
      agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: SFS_MODULE_KEY,
      actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE, targetId: candidate.targetUserId, fanId: candidate.targetUserId,
      idempotencyKey, generation: delivery.generation, priority: 120,
      payload: { candidateId: candidate.id, safetyCleanup: true, originalFollowing: object(delivery.payload).originalFollowing === true },
      status: "QUEUED", scheduledAt: now, notBefore, maxAttempts: 20,
    } });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    cleanup = await db.automationDelivery.findUnique({ where: { idempotencyKey } });
  }
  return cleanup;
}

async function applySfsTargetScanCompletion({ job, result, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("SFS target scan job is missing creator scope");
  const params = object(job.params); const payload = object(result);
  const candidate = await db.sfsTargetCandidate.findFirst({ where: { id: clean(params.candidateId, 160), agencyId: job.agencyId, creatorId: job.creatorId } });
  if (!candidate) return { type: "sfs_target_scan", applied: false, reason: "candidate_not_found" };
  const control = await getAutomationControlSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  const templates = await loadTemplates({ agencyId: job.agencyId, creatorId: job.creatorId, db });
  const posts = Array.isArray(payload.posts) ? payload.posts : [];
  const now = new Date();
  return db.$transaction(async (tx) => {
    let commentCount = 0; let likeCount = 0; let lastTemplateId = clean(object(candidate.metadata).lastTemplateId, 160);
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
      const post = object(rawPost); const postId = clean(post.postId, 160); if (!postId) continue;
      if (settings.commentsEnabled && post.ownComment !== true && templates.length) {
        const availableTemplates = [];
        for (const candidateTemplate of templates) {
          if (await templateUsageToday(candidateTemplate.id) < candidateTemplate.dailyUseLimit) availableTemplates.push(candidateTemplate);
        }
        const template = pickTemplate(availableTemplates, lastTemplateId);
        if (template) {
          const idempotencyKey = sfsCommentKey(job.creatorId, candidate.targetUserId, postId, candidate.generation);
          const delay = randomBetween(settings.minimumIntervalMs, settings.maximumIntervalMs);
          cursor = new Date(cursor.getTime() + delay);
          try {
            await tx.automationDelivery.create({ data: {
              agencyId: job.agencyId, creatorId: job.creatorId, moduleKey: SFS_MODULE_KEY,
              actionType: SFS_COMMENT_POST_ACTION_TYPE, targetId: postId, fanId: candidate.targetUserId,
              idempotencyKey, generation: candidate.generation, priority: 75,
              payload: { candidateId: candidate.id, targetUserId: candidate.targetUserId, postId, templateId: template.id, text: template.text },
              status: "QUEUED", scheduledAt: now, notBefore: cursor, maxAttempts: settings.maxAttempts,
            } });
            commentCount += 1; lastTemplateId = template.id;
            templateUses.set(template.id, (templateUses.get(template.id) || 0) + 1);
          } catch (error) { if (error?.code !== "P2002") throw error; }
        }
      }
      if (settings.commentLikesEnabled && remainingLikeCapacity > 0) {
        const perPostLimit = Math.min(settings.commentLikesPerPost, Number.isFinite(remainingLikeCapacity) ? remainingLikeCapacity : settings.commentLikesPerPost);
        for (const rawComment of (Array.isArray(post.eligibleComments) ? post.eligibleComments : []).slice(0, perPostLimit)) {
          const comment = object(rawComment); const commentId = clean(comment.commentId, 160); if (!commentId) continue;
          const idempotencyKey = sfsCommentLikeKey(job.creatorId, candidate.targetUserId, commentId, candidate.generation);
          const delay = randomBetween(settings.minimumIntervalMs, settings.maximumIntervalMs);
          cursor = new Date(cursor.getTime() + delay);
          try {
            await tx.automationDelivery.create({ data: {
              agencyId: job.agencyId, creatorId: job.creatorId, moduleKey: SFS_MODULE_KEY,
              actionType: SFS_LIKE_COMMENT_ACTION_TYPE, targetId: commentId, fanId: candidate.targetUserId,
              idempotencyKey, generation: candidate.generation, priority: 65,
              payload: { candidateId: candidate.id, targetUserId: candidate.targetUserId, postId, commentId, authorId: clean(comment.authorId, 160) },
              status: "QUEUED", scheduledAt: now, notBefore: cursor, maxAttempts: settings.maxAttempts,
            } });
            likeCount += 1;
            if (Number.isFinite(remainingLikeCapacity)) remainingLikeCapacity -= 1;
          } catch (error) { if (error?.code !== "P2002") throw error; }
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
      data: { notBefore: unfollowAt, status: "QUEUED", failureCode: null, lastError: null,
        payload: { candidateId: candidate.id, safetyCleanup: true, originalFollowing: object(candidate.metadata).originalFollowing === true, plannedAfterScan: true } },
    });
    await tx.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      state: positive ? "ACTING" : "UNFOLLOW_DUE", phase: positive ? "ACTIONS" : "UNFOLLOW",
      commentsPlanned: commentCount, likesPlanned: likeCount, unfollowAt,
      latestError: null, scanJobId: job.id,
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
    return { ok: true, candidate };
  }
  if (!control?.effective?.sfsEnabled) return { ok: false, terminal: true, code: "module_disabled" };
  if (candidate.blocked) return { ok: false, terminal: true, code: "blocked" };
  if (candidate.ignored) return { ok: false, terminal: true, code: "ignored" };
  if (candidate.generation !== delivery.generation) return { ok: false, terminal: true, code: "stale_candidate" };
  if (delivery.notBefore && delivery.notBefore.getTime() > now.getTime()) return { ok: false, terminal: false, code: "not_before", retryAt: delivery.notBefore };
  return { ok: true, candidate };
}

async function finalizeSfsSuccess({ delivery, outcomeCode, result = {}, db = prisma, now = new Date() }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return null;
  const candidateId = clean(object(delivery.payload).candidateId, 160);
  const candidate = candidateId ? await db.sfsTargetCandidate.findUnique({ where: { id: candidateId } }) : null;
  if (!candidate) return null;
  if (delivery.actionType === SFS_FOLLOW_TARGET_ACTION_TYPE) {
    if (!shouldStartSfsSagaAfterFollow(outcomeCode, result)) {
      return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
        state: "SKIPPED", phase: "DONE", creatorFollowing: true, eligibilityReason: "already_following",
        latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "SKIPPED", latestError: null,
        metadata: { ...object(candidate.metadata), followOutcome: outcomeCode, manualFollowPreservedAt: now.toISOString() },
      } });
    }
    const control = await getAutomationControlSnapshot({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db });
    const settings = normalizeSfsSettings(control.modules.sfs.settings);
    const scanJob = await scheduleTargetScan({ delivery, candidate, settings, now, db });
    const cleanup = await createSafetyUnfollow({ delivery, candidate, settings, now, db });
    return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      state: "SCANNING", phase: "SCAN", creatorFollowing: true, scanJobId: scanJob.id,
      safetyUnfollowDeliveryId: cleanup.id, unfollowAt: cleanup.notBefore,
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
      metadata: { ...object(candidate.metadata), originalFollowing: object(delivery.payload).originalFollowing === true, followedAt: now.toISOString(), followOutcome: outcomeCode },
    } });
  }
  if (delivery.actionType === SFS_COMMENT_POST_ACTION_TYPE || delivery.actionType === SFS_LIKE_COMMENT_ACTION_TYPE) {
    return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
      metadata: { ...object(candidate.metadata), lastActionAt: now.toISOString(), lastActionOutcome: outcomeCode },
    } });
  }
  if (delivery.actionType === SFS_UNFOLLOW_TARGET_ACTION_TYPE) {
    return db.sfsTargetCandidate.update({ where: { id: candidate.id }, data: {
      state: "COMPLETED", phase: "DONE", creatorFollowing: false, usedForever: true, completedAt: now, unfollowAt: null,
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: "COMPLETED", latestError: null,
      metadata: { ...object(candidate.metadata), unfollowedAt: now.toISOString(), unfollowOutcome: outcomeCode, result: object(result) },
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
async function finalizeSfsTerminal({ delivery, status, failureCode, db = prisma }) {
  if (!delivery || delivery.moduleKey !== SFS_MODULE_KEY) return null;
  const candidateId = clean(object(delivery.payload).candidateId, 160); if (!candidateId) return null;
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
    db.sfsTargetCandidate.count({ where }), readyWorkerCount({ agencyId, creatorId, db }),
    db.jobInstance.findFirst({ where: { agencyId, creatorId, jobKey: { in: [SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY] } }, orderBy: { updatedAt: "desc" }, select: { id: true, jobKey: true, status: true, progress: true, lastError: true, createdAt: true, completedAt: true } }),
    Promise.all([
      db.sfsTargetCandidate.count({ where: { agencyId, creatorId } }),
      db.sfsTargetCandidate.count({ where: { agencyId, creatorId, usedForever: true } }),
      db.sfsTargetCandidate.count({ where: { agencyId, creatorId, state: "RECOVERY_REQUIRED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, status: "QUEUED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, status: { in: ["CLAIMED", "RUNNING"] } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_COMMENT_POST_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: today } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_LIKE_COMMENT_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: today } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: today } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: month } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, status: "FAILED" } }),
    ]),
  ]);
  const [candidates, used, recoveryRequired, queued, running, commentsToday, likesToday, targetsToday, targetsMonth, failed] = metricsRows;
  return {
    ok: true, creatorId, control, settings, worker: { ready: ready > 0, readyDevices: ready }, discovery,
    metrics: { candidates, used, recoveryRequired, queued, running, commentsToday, likesToday, targetsToday, targetsMonth, failed },
    items: items.map((item) => ({ ...item, currentEligibility: targetEligibility(item, settings), eligible: targetEligibility(item, settings) === "eligible" })),
    count, offset: skip, nextOffset: skip + items.length, hasMore: skip + items.length < count,
  };
}

async function setSfsCandidateState({ agencyId, creatorId, candidateId, action, db = prisma }) {
  const candidate = await db.sfsTargetCandidate.findFirst({ where: { id: candidateId, agencyId, creatorId } });
  if (!candidate) throw Object.assign(new Error("SFS candidate not found"), { code: "candidate_not_found", status: 404 });
  if (action === "run") return planSfsTargets({ agencyId, creatorId, candidateId, source: "candidate_run", priority: 100, limit: 1, db });
  if (action === "retry") {
    const delivery = await db.automationDelivery.findFirst({ where: { id: candidate.latestDeliveryId || "__none__", agencyId } });
    if (!delivery) return planSfsTargets({ agencyId, creatorId, candidateId, source: "candidate_retry", priority: 100, limit: 1, db });
    return { ok: true, deliveryId: delivery.id, requiresQueueRetry: true };
  }
  const data = action === "ignore" ? { ignored: true, blocked: false, state: "IGNORED" }
    : action === "block" ? { blocked: true, ignored: false, state: "BLOCKED" }
      : action === "restore" ? { blocked: false, ignored: false, state: candidate.usedForever ? "COMPLETED" : "CANDIDATE", latestError: null }
        : null;
  if (!data) throw Object.assign(new Error("Unsupported SFS candidate action"), { code: "invalid_action", status: 400 });
  const updated = await db.sfsTargetCandidate.update({ where: { id: candidate.id }, data });
  if (["ignore", "block"].includes(action)) await db.automationDelivery.updateMany({
    where: { agencyId, creatorId, moduleKey: SFS_MODULE_KEY, fanId: candidate.targetUserId || "__none__", status: { in: ["QUEUED", "RETRY_SCHEDULED", "PAUSED"] }, actionType: { not: SFS_UNFOLLOW_TARGET_ACTION_TYPE } },
    data: { status: "CANCELED", failureCode: action === "block" ? "blocked" : "ignored", lastError: `SFS candidate ${action}d`, finishedAt: new Date(), leaseRevision: { increment: 1 } },
  });
  return { ok: true, item: updated };
}

async function adoptLegacySfsUnfollow({ agencyId, creatorId, targetUserId, targetUsername = null, runAfter = null, sourceJobId = null, db = prisma }) {
  const targetId = clean(targetUserId, 160);
  if (!agencyId || !creatorId || !targetId) return { ok: false, created: false, reason: "invalid_target" };
  await requireCreator(agencyId, creatorId, db);
  const username = String(clean(targetUsername, 80) || `legacy_${targetId}`).replace(/^@+/, "").toLowerCase();
  const dueAt = dateOrNull(runAfter) || new Date();
  return db.$transaction(async (tx) => {
    const candidate = await tx.sfsTargetCandidate.upsert({
      where: { creatorId_username: { creatorId, username } },
      create: {
        agencyId, creatorId, targetUserId: targetId, username, state: "UNFOLLOW_DUE", phase: "UNFOLLOW",
        creatorFollowing: true, usedForever: true, generation: 1, unfollowAt: dueAt,
        metadata: { legacyMigration: true, sourceJobId },
      },
      update: {
        targetUserId: targetId, state: "UNFOLLOW_DUE", phase: "UNFOLLOW", creatorFollowing: true,
        usedForever: true, unfollowAt: dueAt, metadata: { legacyMigration: true, sourceJobId },
      },
    });
    const generation = Math.max(1, candidate.generation || 1);
    const idempotencyKey = sfsUnfollowKey(creatorId, targetId, generation);
    let delivery;
    try {
      delivery = await tx.automationDelivery.create({ data: {
        agencyId, creatorId, moduleKey: SFS_MODULE_KEY, actionType: SFS_UNFOLLOW_TARGET_ACTION_TYPE,
        targetId, fanId: targetId, idempotencyKey, generation, priority: 120,
        payload: { candidateId: candidate.id, safetyCleanup: true, legacyMigration: true, sourceJobId },
        status: "QUEUED", scheduledAt: new Date(), notBefore: dueAt, maxAttempts: 20,
      } });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      delivery = await tx.automationDelivery.findUnique({ where: { idempotencyKey } });
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
  });
}

async function ensureAutomaticSfs({ agencyId, creatorId, source = "scheduler", db = prisma }) {
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeSfsSettings(control.modules.sfs.settings);
  if (!control.effective.sfsEnabled || !settings.automatic) return { ok: true, created: false, reason: "automatic_disabled" };
  const discovery = await scheduleSfsDiscovery({ agencyId, creatorId, source, db }).catch((error) => ({ ok: false, reason: error?.code || error?.message }));
  const planning = await planSfsTargets({ agencyId, creatorId, source, limit: settings.dailyLimit, db }).catch((error) => ({ ok: false, reason: error?.code || error?.message }));
  return { ok: true, discovery, planning };
}

module.exports = {
  SFS_MODULE_KEY, SFS_DISCOVERY_JOB_KEY, SFS_TARGET_SCAN_JOB_KEY,
  scheduleSfsDiscovery, applySfsDiscoveryChunk, applySfsDiscoveryCompletion, applySfsTargetScanCompletion,
  recordSfsJobFailure, planSfsTargets, validateSfsDelivery, finalizeSfsSuccess, finalizeSfsFailure,
  finalizeSfsTerminal, prepareSfsRetry, listSfs, setSfsCandidateState, adoptLegacySfsUnfollow, ensureAutomaticSfs,
  RETRYABLE_FAILURES,
};
