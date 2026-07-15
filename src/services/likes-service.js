"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { nextAutomationWriteSlot } = require("./automation-pacing-service");
const {
  getAutomationControlSnapshot,
  assertAutomationEnabled,
  normalizeLikesSettings,
  requireCreator,
} = require("./automation-control-service");

const {
  normalizeDiscoveredLikePost,
  likeDeliveryIdempotencyKey,
} = require("./likes-rules");
const {
  LIKES_MODULE_KEY,
  LIKES_DISCOVERY_JOB_KEY,
  LIKE_POST_ACTION_TYPE,
} = require("./likes-constants");

const ACTIVE_DELIVERY_STATUSES = ["QUEUED", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"];
const RETRYABLE_FAILURES = new Set([
  "network_error", "timeout", "rate_limited", "temporary_of_error", "backend_unavailable", "lease_lost", "creator_unavailable",
]);

function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function dateOrNull(value) { if (!value) return null; const d = value instanceof Date ? value : new Date(value); return Number.isFinite(d.getTime()) ? d : null; }
function dayStart(date = new Date()) { const out = new Date(date); out.setHours(0, 0, 0, 0); return out; }
function monthStart(date = new Date()) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function stableHash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24); }
function chunks(items, size) { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }
function shuffled(items) {
  const out = Array.isArray(items) ? items.slice() : [];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(0, index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}
function roundRobin(groups) {
  const queues = groups.map((group) => group.slice()).filter((group) => group.length);
  const out = [];
  while (queues.length) {
    for (let index = queues.length - 1; index >= 0; index -= 1) {
      const value = queues[index].shift();
      if (value) out.push(value);
      if (!queues[index].length) queues.splice(index, 1);
    }
  }
  return out;
}
function subscriptionWhere(settings) {
  const and = [];
  if (settings.activeSubscribers && !settings.expiredSubscribers) and.push({ OR: [{ isActive: true }, { isActive: null }] });
  else if (!settings.activeSubscribers && settings.expiredSubscribers) and.push({ isActive: false });
  else if (!settings.activeSubscribers && !settings.expiredSubscribers) and.push({ id: "__none__" });
  if (!settings.expiredSubscribers) and.push({ OR: [{ subscriptionType: null }, { NOT: { subscriptionType: { contains: "expired", mode: "insensitive" } } }] });
  if (!settings.freeSubscribers) and.push({ OR: [{ subscriptionType: null }, { NOT: { subscriptionType: { contains: "free", mode: "insensitive" } } }] });
  if (!settings.paidSubscribers) and.push({ OR: [
    { subscriptionType: null },
    { AND: [
      { NOT: { subscriptionType: { contains: "paid", mode: "insensitive" } } },
      { NOT: { subscriptionType: { contains: "active", mode: "insensitive" } } },
    ] },
  ] });
  return and;
}
async function readyWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: { agencyId, creatorId, status: "ACTIVE", lastSeenAt: { gte: freshAfter }, device: { lastSeenAt: { gte: freshAfter } } },
  });
}
async function withCreatorLock(db, agencyId, creatorId, fn) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`p12:likes:${agencyId}:${creatorId}`}))`;
    return fn(tx);
  });
}

async function currentSnapshot({ agencyId, creatorId, db = prisma }) {
  return db.subscriberDirectoryState.findFirst({
    where: { agencyId, creatorId, status: "READY", currentRunId: { not: null } },
    select: { currentRunId: true, publishedAt: true },
  });
}

async function eligibleDiscoveryFans({ agencyId, creatorId, settings, snapshotRunId, fanIds = [], force = false, maxFans = 500, db = prisma }) {
  const now = new Date();
  const freshnessCutoff = new Date(now.getTime() - settings.discoveryFreshnessHours * 60 * 60_000);
  const requested = [...new Set((Array.isArray(fanIds) ? fanIds : []).map((value) => clean(value, 160)).filter(Boolean))];
  const rows = await db.subscriberScanItem.findMany({
    where: {
      agencyId,
      creatorId,
      runId: snapshotRunId,
      ...(requested.length ? { fanId: { in: requested } } : {}),
      AND: subscriptionWhere(settings),
    },
    orderBy: [{ observedAt: "desc" }, { fanId: "asc" }],
    select: { fanId: true, username: true, name: true, avatarUrl: true, subscriptionType: true, isActive: true, metadata: true },
    take: Math.min(10_000, Math.max(1, Number(maxFans) || 500) * 3),
  });
  if (!rows.length) return [];
  const ids = rows.map((row) => row.fanId);
  const failedRetryCutoff = new Date(now.getTime() - 15 * 60_000);
  const [hiddenStatuses, bumpStates, recentDiscovery] = await Promise.all([
    db.hiddenOnlineUser.findMany({ where: { agencyId, creatorId, fanId: { in: ids }, status: { in: ["ignored", "blocked"] } }, select: { fanId: true } }),
    db.automationBumpFanState.findMany({ where: { agencyId, creatorId, fanId: { in: ids }, OR: [{ ignored: true }, { blocked: true }] }, select: { fanId: true } }),
    force ? Promise.resolve([]) : db.automationContentDiscoveryState.findMany({
      where: {
        agencyId, creatorId, ownerFanId: { in: ids }, sourceKey: "fan_posts", snapshotRunId,
        OR: [
          { status: "READY", lastSuccessAt: { gte: freshnessCutoff } },
          { status: "FAILED", lastScannedAt: { gte: failedRetryCutoff } },
        ],
      },
      select: { ownerFanId: true }, take: 10_000,
    }),
  ]);
  const excluded = new Set([...hiddenStatuses, ...bumpStates].map((row) => row.fanId));
  const fresh = new Set(recentDiscovery.map((row) => row.ownerFanId));
  return rows.filter((row) => !excluded.has(row.fanId) && (force || !fresh.has(row.fanId))).slice(0, Math.max(1, Number(maxFans) || 500));
}

async function scheduleLikesDiscovery({ agencyId, creatorId, userId = null, fanIds = [], force = false, source = "manual", maxFans = 500, priority = 80, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, db });
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  const snapshot = await currentSnapshot({ agencyId, creatorId, db });
  if (!snapshot?.currentRunId) return { ok: false, created: false, reason: "snapshot_not_ready", jobs: [] };
  const ready = await readyWorkerCount({ agencyId, creatorId, db });
  if (!ready) return { ok: false, created: false, reason: "no_ready_worker", jobs: [] };
  const fans = await eligibleDiscoveryFans({ agencyId, creatorId, settings, snapshotRunId: snapshot.currentRunId, fanIds, force, maxFans, db });
  if (!fans.length) return { ok: true, created: false, reason: "discovery_fresh_or_no_fans", jobs: [] };
  const batches = chunks(fans, settings.discoveryBatchSize);
  const bucket = Math.floor(Date.now() / (15 * 60_000));
  const jobs = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const params = {
      snapshotRunId: snapshot.currentRunId,
      fans: batch.map((fan) => ({ fanId: fan.fanId, username: fan.username, displayName: fan.name, avatarUrl: fan.avatarUrl })),
      postLimit: settings.discoveryPostLimit,
      contentMaxAgeDays: settings.contentMaxAgeDays,
      source,
      requestedByUserId: userId,
      batchIndex: index,
      batchCount: batches.length,
    };
    const idempotencyKey = `likes_discovery:${creatorId}:${snapshot.currentRunId}:${stableHash(batch.map((fan) => fan.fanId))}:${force ? Date.now() : bucket}`;
    let job = await db.jobInstance.findUnique({ where: { idempotencyKey } });
    if (!job) {
      try {
        job = await db.jobInstance.create({ data: {
          jobKey: LIKES_DISCOVERY_JOB_KEY, scope: "creator", creatorId, agencyId, idempotencyKey, params,
          status: "SCHEDULED", priority, scheduledAt: new Date(), nextRunAt: new Date(),
        } });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        job = await db.jobInstance.findUnique({ where: { idempotencyKey } });
      }
    } else if (!["CLAIMED", "SCHEDULED"].includes(job.status)) {
      job = await db.jobInstance.update({ where: { id: job.id }, data: {
        status: "SCHEDULED", params, priority, scheduledAt: new Date(), nextRunAt: new Date(), claimedAt: null,
        claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null, workId: null, continuation: null,
        progress: null, lastProgressAt: null, completedAt: null, lastError: null, attempts: 0, result: null,
      } });
    }
    jobs.push({ id: job.id, status: job.status, batchSize: batch.length });
  }
  return { ok: true, created: jobs.some((job) => job.status === "SCHEDULED"), reason: "scheduled", jobs, fans: fans.length };
}

async function applyLikesDiscoveryChunk({ db = prisma, job, chunkResult }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("Likes discovery job is missing creator scope");
  const payload = object(chunkResult);
  const fan = object(payload.fan);
  const now = dateOrNull(payload.observedAt) || new Date();
  const snapshotRunId = clean(payload.snapshotRunId || object(job.params).snapshotRunId, 160);
  const posts = (Array.isArray(payload.posts) ? payload.posts : []).map((post) => normalizeDiscoveredLikePost(post, fan, now)).filter(Boolean);
  let applied = 0;
  for (const post of posts) {
    const existing = await db.automationContentCandidate.findUnique({
      where: { creatorId_contentType_contentId: { creatorId: job.creatorId, contentType: "post", contentId: post.contentId } },
    });
    const preserveLiked = existing?.state === "LIKED" || existing?.isFavorite === true;
    await db.automationContentCandidate.upsert({
      where: { creatorId_contentType_contentId: { creatorId: job.creatorId, contentType: "post", contentId: post.contentId } },
      create: {
        agencyId: job.agencyId, creatorId: job.creatorId, ownerFanId: post.ownerFanId, contentId: post.contentId,
        contentType: "post", username: post.username, displayName: post.displayName, avatarUrl: post.avatarUrl,
        source: "subscriber_directory", publishedAt: post.publishedAt, discoveredAt: now, lastSeenAt: now,
        canToggleFavorite: post.canToggleFavorite, canViewMedia: post.canViewMedia, isFavorite: post.isFavorite,
        state: post.state, eligibilityReason: post.reason, skipReason: post.state === "SKIPPED" ? post.reason : null,
        snapshotRunId, metadata: post.metadata,
      },
      update: {
        ownerFanId: post.ownerFanId, username: post.username, displayName: post.displayName, avatarUrl: post.avatarUrl,
        publishedAt: post.publishedAt, lastSeenAt: now, canToggleFavorite: post.canToggleFavorite,
        canViewMedia: post.canViewMedia, isFavorite: preserveLiked ? true : post.isFavorite,
        state: preserveLiked ? existing.state : post.state,
        eligibilityReason: preserveLiked ? existing.eligibilityReason : post.reason,
        skipReason: preserveLiked ? existing.skipReason : (post.state === "SKIPPED" ? post.reason : null),
        snapshotRunId, metadata: { ...object(existing?.metadata), ...post.metadata },
      },
    });
    applied += 1;
  }
  const fanId = clean(fan.fanId, 160);
  const sourceErrors = Array.isArray(payload.sourceErrors) ? payload.sourceErrors.map((item) => object(item)).slice(0, 10) : [];
  const failed = posts.length === 0 && sourceErrors.length >= 3;
  if (fanId) {
    await db.automationContentDiscoveryState.upsert({
      where: { creatorId_ownerFanId_sourceKey: { creatorId: job.creatorId, ownerFanId: fanId, sourceKey: "fan_posts" } },
      create: {
        agencyId: job.agencyId, creatorId: job.creatorId, ownerFanId: fanId, sourceKey: "fan_posts",
        snapshotRunId, status: failed ? "FAILED" : "READY", contentCount: posts.length, sourceErrors,
        lastScannedAt: now, lastSuccessAt: failed ? null : now,
        metadata: { latestJobId: job.id, latestChunkKind: clean(payload.kind, 80) },
      },
      update: {
        snapshotRunId, status: failed ? "FAILED" : "READY", contentCount: posts.length, sourceErrors,
        lastScannedAt: now, ...(failed ? {} : { lastSuccessAt: now }),
        metadata: { latestJobId: job.id, latestChunkKind: clean(payload.kind, 80) },
      },
    });
  }
  return { type: "likes_content", fanId, posts: posts.length, applied, sourceErrors: sourceErrors.length, status: failed ? "FAILED" : "READY" };
}

async function applyLikesDiscoveryCompletion({ job, result, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("Likes discovery job is missing creator scope");
  const snapshotRunId = clean(object(job.params).snapshotRunId || object(result).snapshotRunId, 160);
  if (snapshotRunId) {
    await Promise.all([
      db.automationContentCandidate.updateMany({
        where: {
          agencyId: job.agencyId,
          creatorId: job.creatorId,
          snapshotRunId: { not: snapshotRunId },
          state: { notIn: ["LIKED", "ALREADY_LIKED", "IGNORED", "BLOCKED"] },
        },
        data: { state: "STALE", eligibilityReason: "stale_candidate", latestStatus: "STALE" },
      }),
      db.automationContentDiscoveryState.updateMany({
        where: { agencyId: job.agencyId, creatorId: job.creatorId, snapshotRunId: { not: snapshotRunId }, status: { not: "STALE" } },
        data: { status: "STALE" },
      }),
    ]);
  }
  let planning = null;
  try {
    const control = await getAutomationControlSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db });
    if (control.effective.likesEnabled && control.modules.likes.settings.automatic) {
      planning = await planLikes({ agencyId: job.agencyId, creatorId: job.creatorId, source: "discovery_complete", manual: false, db });
    }
  } catch (error) {
    planning = { ok: false, reason: error?.code || "planning_failed", error: error?.message || String(error) };
  }
  return { type: "likes_discovery", result: object(result), planning };
}

async function recordLikesDiscoveryFailure({ job, error, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) return null;
  const now = new Date();
  const message = clean(error?.message || error, 2000) || "likes_discovery_failed";
  const failureCode = clean(error?.code, 120) || "likes_discovery_failed";
  const snapshotRunId = clean(object(job.params).snapshotRunId, 160);
  const fans = Array.isArray(object(job.params).fans) ? object(job.params).fans : [];
  for (const fan of fans.slice(0, 500)) {
    const ownerFanId = clean(object(fan).fanId, 160);
    if (!ownerFanId) continue;
    await db.automationContentDiscoveryState.upsert({
      where: { creatorId_ownerFanId_sourceKey: { creatorId: job.creatorId, ownerFanId, sourceKey: "fan_posts" } },
      create: {
        agencyId: job.agencyId, creatorId: job.creatorId, ownerFanId, sourceKey: "fan_posts", snapshotRunId,
        status: "FAILED", contentCount: 0, sourceErrors: [{ source: "job", code: failureCode }],
        lastScannedAt: now, metadata: { latestJobId: job.id, failureCode },
      },
      update: {
        snapshotRunId, status: "FAILED", sourceErrors: [{ source: "job", code: failureCode }],
        lastScannedAt: now, metadata: { latestJobId: job.id, failureCode },
      },
    });
  }
  return { type: "likes_discovery", creatorId: job.creatorId, error: message, failureCode };
}

async function currentBlockedFans({ agencyId, creatorId, fanIds, db }) {
  if (!fanIds.length) return new Set();
  const [hidden, bump] = await Promise.all([
    db.hiddenOnlineUser.findMany({ where: { agencyId, creatorId, fanId: { in: fanIds }, status: { in: ["ignored", "blocked"] } }, select: { fanId: true } }),
    db.automationBumpFanState.findMany({ where: { agencyId, creatorId, fanId: { in: fanIds }, OR: [{ ignored: true }, { blocked: true }] }, select: { fanId: true } }),
  ]);
  return new Set([...hidden, ...bump].map((row) => row.fanId));
}

async function planLikesLocked({ db, agencyId, creatorId, userId = null, candidateIds = [], source = "manual", manual = true, priority = 60 }) {
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, db });
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  const snapshot = await currentSnapshot({ agencyId, creatorId, db });
  if (!snapshot?.currentRunId) return { ok: false, created: false, reason: "snapshot_not_ready", planned: 0, skipped: {} };
  const ready = await readyWorkerCount({ agencyId, creatorId, db });
  if (!ready) return { ok: false, created: false, reason: "no_ready_worker", planned: 0, skipped: { no_ready_worker: 1 } };
  const now = new Date();
  const completedToday = await db.automationDelivery.count({
    where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) } },
  });
  const activeCount = await db.automationDelivery.count({
    where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE, status: { in: ACTIVE_DELIVERY_STATUSES } },
  });
  let capacity = Math.max(0, settings.dailyLimit - completedToday - activeCount);
  if (!capacity) return { ok: true, created: false, reason: "daily_limit", planned: 0, skipped: { daily_limit: 1 } };
  const ids = [...new Set((Array.isArray(candidateIds) ? candidateIds : []).map((value) => clean(value, 160)).filter(Boolean))];
  const cutoff = new Date(now.getTime() - settings.contentMaxAgeDays * 24 * 60 * 60_000);
  const candidates = await db.automationContentCandidate.findMany({
    where: {
      agencyId, creatorId, contentType: "post", snapshotRunId: snapshot.currentRunId,
      ...(ids.length ? { id: { in: ids } } : {}),
      state: { in: ["ELIGIBLE", "DISCOVERED"] },
      OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
      AND: [
        { OR: [{ canToggleFavorite: true }, { canToggleFavorite: null }] },
        { OR: [{ canViewMedia: true }, { canViewMedia: null }] },
        ...(settings.onlyUnliked ? [{ OR: [{ isFavorite: false }, { isFavorite: null }] }] : []),
        { OR: [{ publishedAt: null }, { publishedAt: { gte: cutoff } }] },
      ],
    },
    orderBy: [{ publishedAt: "desc" }, { discoveredAt: "desc" }],
    take: Math.min(2000, Math.max(capacity * 4, 100)),
  });
  const blocked = await currentBlockedFans({ agencyId, creatorId, fanIds: [...new Set(candidates.map((row) => row.ownerFanId))], db });
  const skipped = {};
  if (blocked.size) {
    const blockedIds = [...blocked];
    await db.automationContentCandidate.updateMany({
      where: { agencyId, creatorId, contentType: "post", ownerFanId: { in: blockedIds }, state: { in: ["ELIGIBLE", "DISCOVERED"] } },
      data: { state: "BLOCKED", skipReason: "blocked", eligibilityReason: "blocked", latestError: "blocked" },
    });
    skipped.blocked = candidates.filter((candidate) => blocked.has(candidate.ownerFanId)).length;
  }
  const available = candidates.filter((candidate) => !blocked.has(candidate.ownerFanId));
  let selected;
  if (ids.length) {
    selected = available.slice(0, capacity);
  } else {
    const byFan = new Map();
    for (const candidate of available) {
      const list = byFan.get(candidate.ownerFanId) || [];
      if (list.length < settings.postsPerFanMax) list.push(candidate);
      byFan.set(candidate.ownerFanId, list);
    }
    const minimum = Math.max(1, Math.min(settings.postsPerFanMin, settings.postsPerFanMax));
    const maximum = Math.max(minimum, settings.postsPerFanMax);
    const groups = [...byFan.values()].map((list) => {
      const target = Math.min(list.length, crypto.randomInt(minimum, maximum + 1));
      return shuffled(list).slice(0, target);
    });
    selected = roundRobin(groups).slice(0, capacity);
  }
  let planned = 0;
  for (const candidate of selected) {
    const idempotencyKey = likeDeliveryIdempotencyKey({ creatorId, contentId: candidate.contentId });
    const active = await db.automationDelivery.findFirst({
      where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE, targetId: candidate.contentId, status: { in: ACTIVE_DELIVERY_STATUSES } },
      select: { id: true },
    });
    if (active) { skipped.active_delivery = (skipped.active_delivery || 0) + 1; continue; }
    if (!idempotencyKey) { skipped.invalid_target = (skipped.invalid_target || 0) + 1; continue; }
    const existing = await db.automationDelivery.findUnique({ where: { idempotencyKey } });
    if (existing?.status === "COMPLETED") {
      await db.automationContentCandidate.update({ where: { id: candidate.id }, data: {
        state: "ALREADY_LIKED", isFavorite: true, latestDeliveryId: existing.id, latestActionType: LIKE_POST_ACTION_TYPE,
        latestStatus: existing.status, latestError: null,
      } });
      skipped.already_liked = (skipped.already_liked || 0) + 1;
      continue;
    }
    const notBefore = await nextAutomationWriteSlot({
      agencyId, creatorId, actionType: LIKE_POST_ACTION_TYPE, workspaceSettings: control.workspace.settings,
      actionSettings: settings, now, db,
    });
    let delivery;
    if (existing && ["FAILED", "SKIPPED", "CANCELED"].includes(existing.status)) {
      delivery = await db.automationDelivery.update({ where: { id: existing.id }, data: {
        status: "QUEUED", priority, notBefore, failureCode: null, lastError: null, finishedAt: null,
        claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 },
        maxAttempts: settings.maxAttempts,
        payload: { ...object(existing.payload), candidateId: candidate.id, postId: candidate.contentId, authorId: candidate.ownerFanId, source },
      } });
    } else if (!existing) {
      delivery = await db.automationDelivery.create({ data: {
        agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE,
        targetId: candidate.contentId, fanId: candidate.ownerFanId, idempotencyKey, generation: candidate.generation,
        priority, payload: { candidateId: candidate.id, postId: candidate.contentId, authorId: candidate.ownerFanId, source, manual },
        status: "QUEUED", scheduledAt: now, notBefore, maxAttempts: settings.maxAttempts, createdByUserId: userId,
      } });
    } else {
      skipped.terminal_delivery = (skipped.terminal_delivery || 0) + 1;
      continue;
    }
    await db.automationContentCandidate.update({ where: { id: candidate.id }, data: {
      state: "QUEUED", latestDeliveryId: delivery.id, latestActionType: LIKE_POST_ACTION_TYPE,
      latestStatus: delivery.status, latestError: null,
    } });
    planned += 1;
    capacity -= 1;
    if (!capacity) break;
  }
  return { ok: true, created: planned > 0, reason: planned ? "planned" : "no_eligible_candidates", planned, skipped };
}

async function planLikes(input) {
  const { db = prisma, agencyId, creatorId } = input;
  return withCreatorLock(db, agencyId, creatorId, (tx) => planLikesLocked({ ...input, db: tx }));
}

async function ensureAutomaticLikes({ agencyId, creatorId, source = "automatic", db = prisma }) {
  let control;
  try { control = await getAutomationControlSnapshot({ agencyId, creatorId, db }); }
  catch (error) { return { ok: false, created: false, reason: error?.code || "control_unavailable" }; }
  if (!control.effective.likesEnabled) return { ok: true, created: false, reason: "module_disabled" };
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  if (!settings.automatic) return { ok: true, created: false, reason: "automatic_disabled" };
  const discovery = await scheduleLikesDiscovery({ agencyId, creatorId, source, force: false, maxFans: settings.discoveryBatchSize * 2, priority: 25, db });
  const planning = await planLikes({ agencyId, creatorId, source, manual: false, priority: 40, db });
  return { ok: true, created: discovery.created || planning.created, discovery, planning };
}

async function validateLikeDelivery({ delivery, control, now = new Date(), db = prisma }) {
  if (!delivery || delivery.moduleKey !== LIKES_MODULE_KEY || delivery.actionType !== LIKE_POST_ACTION_TYPE) return { ok: true };
  const candidate = await db.automationContentCandidate.findFirst({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, contentType: "post", contentId: delivery.targetId || clean(object(delivery.payload).postId, 160) },
  });
  if (!candidate) return { ok: false, terminal: true, status: "SKIPPED", code: "invalid_target" };
  const snapshot = await currentSnapshot({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, db });
  if (!snapshot?.currentRunId || candidate.snapshotRunId !== snapshot.currentRunId || candidate.state === "STALE") return { ok: false, terminal: true, status: "SKIPPED", code: "stale_candidate" };
  if (candidate.isFavorite === true || ["LIKED", "ALREADY_LIKED"].includes(candidate.state)) return { ok: false, terminal: true, status: "COMPLETED", code: "already_liked" };
  if (candidate.canToggleFavorite === false) return { ok: false, terminal: true, status: "SKIPPED", code: "cannot_like" };
  if (candidate.canViewMedia === false) return { ok: false, terminal: true, status: "SKIPPED", code: "cannot_view" };
  if (candidate.cooldownUntil && candidate.cooldownUntil > now) return { ok: false, terminal: false, code: "cooldown", retryAt: candidate.cooldownUntil };
  const blocked = await currentBlockedFans({ agencyId: delivery.agencyId, creatorId: delivery.creatorId, fanIds: [candidate.ownerFanId], db });
  if (blocked.has(candidate.ownerFanId)) return { ok: false, terminal: true, status: "CANCELED", code: "blocked_or_ignored" };
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  const completedToday = await db.automationDelivery.count({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) }, id: { not: delivery.id } },
  });
  if (completedToday >= settings.dailyLimit) {
    const retryAt = new Date(dayStart(now)); retryAt.setDate(retryAt.getDate() + 1);
    return { ok: false, terminal: false, code: "daily_limit", retryAt };
  }
  return { ok: true, candidate };
}

async function updateLikeCandidateFromDelivery({ delivery, state, status, failureCode = null, result = {}, db = prisma }) {
  if (!delivery || delivery.moduleKey !== LIKES_MODULE_KEY) return;
  const contentId = delivery.targetId || clean(object(delivery.payload).postId, 160);
  if (!contentId) return;
  await db.automationContentCandidate.updateMany({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, contentType: "post", contentId },
    data: {
      state,
      ...(["LIKED", "ALREADY_LIKED"].includes(state) ? { isFavorite: true } : {}),
      latestDeliveryId: delivery.id, latestActionType: delivery.actionType, latestStatus: status,
      latestError: failureCode, skipReason: status === "SKIPPED" || status === "CANCELED" ? failureCode : null,
      metadata: { ...object(result), lastDeliveryId: delivery.id },
    },
  });
}
async function finalizeLikeSuccess({ delivery, outcomeCode, result, db = prisma }) {
  const state = outcomeCode === "already_liked" ? "ALREADY_LIKED" : "LIKED";
  await updateLikeCandidateFromDelivery({ delivery, state, status: "COMPLETED", result, db });
}
async function finalizeLikeFailure({ delivery, failureCode, retryable, result, db = prisma }) {
  await updateLikeCandidateFromDelivery({ delivery, state: retryable ? "ELIGIBLE" : "FAILED", status: retryable ? "RETRY_SCHEDULED" : "FAILED", failureCode, result, db });
}
async function finalizeLikeTerminal({ delivery, status, failureCode, result, db = prisma }) {
  const state = status === "COMPLETED" && failureCode === "already_liked" ? "ALREADY_LIKED" : status;
  await updateLikeCandidateFromDelivery({ delivery, state, status, failureCode, result, db });
}
async function prepareLikeRetry({ delivery, db = prisma }) {
  await updateLikeCandidateFromDelivery({ delivery, state: "QUEUED", status: "QUEUED", failureCode: null, db });
}

async function listLikes({ agencyId, creatorId, search = "", state = null, offset = 0, limit = 100, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const where = {
    agencyId, creatorId, contentType: "post",
    ...(state ? { state } : {}),
    ...(clean(search, 160) ? { OR: [
      { username: { contains: clean(search, 160), mode: "insensitive" } },
      { displayName: { contains: clean(search, 160), mode: "insensitive" } },
      { contentId: { contains: clean(search, 160), mode: "insensitive" } },
      { ownerFanId: { contains: clean(search, 160), mode: "insensitive" } },
    ] } : {}),
  };
  const now = new Date();
  const [items, count, metrics, worker, lastJob] = await Promise.all([
    db.automationContentCandidate.findMany({ where, orderBy: [{ publishedAt: "desc" }, { discoveredAt: "desc" }], skip: offset, take: limit }),
    db.automationContentCandidate.count({ where }),
    Promise.all([
      db.automationContentCandidate.count({ where: { agencyId, creatorId, contentType: "post" } }),
      db.automationContentCandidate.count({ where: { agencyId, creatorId, contentType: "post", state: "ELIGIBLE" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "QUEUED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "CLAIMED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "RUNNING" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "COMPLETED", finishedAt: { gte: dayStart(now) } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "COMPLETED", finishedAt: { gte: monthStart(now) } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "FAILED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "SKIPPED" } }),
    ]),
    readyWorkerCount({ agencyId, creatorId, db }),
    db.jobInstance.findFirst({ where: { agencyId, creatorId, jobKey: LIKES_DISCOVERY_JOB_KEY }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, progress: true, lastError: true, createdAt: true, completedAt: true } }),
  ]);
  return {
    ok: true, creatorId, control, settings: control.modules.likes.settings,
    worker: { ready: worker > 0, readyDevices: worker },
    discovery: lastJob,
    metrics: {
      candidates: metrics[0], eligible: metrics[1], queued: metrics[2], claimed: metrics[3], running: metrics[4],
      likedToday: metrics[5], likedThisMonth: metrics[6], failed: metrics[7], skipped: metrics[8],
    },
    items, count, offset, nextOffset: offset + items.length, hasMore: offset + items.length < count,
  };
}

async function setLikeCandidateState({ agencyId, creatorId, candidateId, action, db = prisma }) {
  const candidate = await db.automationContentCandidate.findFirst({ where: { id: candidateId, agencyId, creatorId } });
  if (!candidate) throw Object.assign(new Error("Like candidate not found"), { code: "candidate_not_found", status: 404 });
  if (action === "restore") {
    return db.automationContentCandidate.update({ where: { id: candidate.id }, data: { state: candidate.isFavorite ? "ALREADY_LIKED" : "ELIGIBLE", skipReason: null, latestError: null } });
  }
  if (!["ignore", "block"].includes(action)) throw Object.assign(new Error("Unsupported candidate action"), { code: "invalid_candidate_action", status: 400 });
  const state = action === "ignore" ? "IGNORED" : "BLOCKED";
  await db.automationDelivery.updateMany({
    where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, targetId: candidate.contentId, status: { in: ACTIVE_DELIVERY_STATUSES } },
    data: { status: "CANCELED", failureCode: action === "ignore" ? "ignored" : "blocked", lastError: action, finishedAt: new Date(), claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 } },
  });
  return db.automationContentCandidate.update({ where: { id: candidate.id }, data: { state, skipReason: action, latestError: action } });
}

module.exports = {
  LIKES_DISCOVERY_JOB_KEY,
  LIKE_POST_ACTION_TYPE,
  RETRYABLE_FAILURES,
  scheduleLikesDiscovery,
  applyLikesDiscoveryChunk,
  applyLikesDiscoveryCompletion,
  recordLikesDiscoveryFailure,
  planLikes,
  ensureAutomaticLikes,
  validateLikeDelivery,
  finalizeLikeSuccess,
  finalizeLikeFailure,
  finalizeLikeTerminal,
  prepareLikeRetry,
  listLikes,
  setLikeCandidateState,
};
