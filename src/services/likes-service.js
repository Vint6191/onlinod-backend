"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { assertAutomationDeliveryAdoption } = require("./automation-delivery-adoption-guard");
const { nextAutomationWriteSlot } = require("./automation-pacing-service");
const { ensurePlannedJob, afterPlanningCommit } = require("./job-planning-repository");
const { readSubscriberConsumerPage, readFanConsumerPage } = require("./fan-consumer-cursor-service");
const { withDbAdvisoryXactLock } = require("./db-transaction-service");
const { runWithAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { readFanCurrentMap, evaluateLikesCurrent, likesRequiredFields, buildFanCurrentFieldFence } = require("./fan-current-consumer-service");
const { scheduleFanDataPointRefresh, scheduleDurableFanDataRefreshDebt } = require("./fan-data-authority-service");
const { PRECOMMIT_MUTABLE_STATUSES, ACTIVE_WRITE_WORKFLOW_STATUSES } = require("./automation-delivery-statuses");
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

const ACTIVE_DELIVERY_STATUSES = [...ACTIVE_WRITE_WORKFLOW_STATUSES];
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
async function sessionWriteWorkerCount({ agencyId, creatorId, db = prisma }) {
  const freshAfter = new Date(Date.now() - 2 * 60_000);
  return db.deviceCreatorBinding.count({
    where: { agencyId, creatorId, status: "ACTIVE", sessionWriteReady: true, lastSeenAt: { gte: freshAfter }, device: { lastSeenAt: { gte: freshAfter } } },
  });
}
async function withCreatorLock(db, agencyId, creatorId, fn) {
  return withDbAdvisoryXactLock({ db, key: `p12:likes:${agencyId}:${creatorId}`, work: fn });
}

function jobAuthorityAt(job) {
  return dateOrNull(job?.startedAt || job?.claimedAt || job?.scheduledAt || job?.createdAt) || new Date(0);
}
function likesAuthorityMetadata(job) {
  return { latestJobId: job.id, latestJobAuthorityAt: jobAuthorityAt(job).toISOString() };
}
async function likesStateSupersedesJob({ db, state, job }) {
  const metadata = object(state?.metadata);
  const latestJobId = clean(metadata.latestJobId, 160);
  if (!latestJobId || latestJobId === job.id) return false;
  let latestAt = dateOrNull(metadata.latestJobAuthorityAt);
  if (!latestAt) {
    const latestJob = await db.jobInstance.findUnique({
      where: { id: latestJobId },
      select: { id: true, startedAt: true, claimedAt: true, scheduledAt: true, createdAt: true },
    });
    latestAt = latestJob ? jobAuthorityAt(latestJob) : null;
  }
  if (!latestAt) return true;
  const currentAt = jobAuthorityAt(job);
  if (latestAt.getTime() !== currentAt.getTime()) return latestAt.getTime() > currentAt.getTime();
  return latestJobId.localeCompare(String(job.id)) > 0;
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
  const rows = await readSubscriberConsumerPage({ db, agencyId, creatorId, runId: snapshotRunId,
    consumerKey: "likes:discovery", fanIds: requested, limit: maxFans });
  if (!rows.length) return [];
  const ids = rows.map((row) => row.fanId);
  const failedRetryCutoff = new Date(now.getTime() - 15 * 60_000);
  const [hiddenStatuses, recentDiscovery] = await Promise.all([
    db.hiddenOnlineUser.findMany({ where: { agencyId, creatorId, fanId: { in: ids }, status: { in: ["ignored", "blocked"] } }, select: { fanId: true } }),
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
  const excluded = new Set(hiddenStatuses.map((row) => row.fanId));
  const fresh = new Set(recentDiscovery.map((row) => row.ownerFanId));
  const selected = rows.filter((row) => !excluded.has(row.fanId) && (force || !fresh.has(row.fanId)));
  const currentByFan = await readFanCurrentMap(db, { agencyId, creatorId, fanIds: selected.map((row) => row.fanId) });
  return selected.map((row) => {
    const identity = currentByFan.get(row.fanId)?.platformIdentity || {};
    return { ...row, username: identity.username || null, name: identity.platformDisplayName || null, avatarUrl: identity.avatarUrl || null };
  });
}

async function scheduleLikesDiscovery(input) {
  const db = input.db || prisma;
  // A failed job insert rolls back the cursor; notification follows commit.
  return afterPlanningCommit(() => withCreatorLock(db, input.agencyId, input.creatorId,
    (tx) => scheduleLikesDiscoveryLocked({ ...input, db: tx })));
}

async function scheduleLikesDiscoveryLocked({ agencyId, creatorId, userId = null, fanIds = [], force = false, source = "manual", maxFans = 500, priority = 80, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, db });
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  const snapshot = await currentSnapshot({ agencyId, creatorId, db });
  if (!snapshot?.currentRunId) return { ok: false, created: false, reason: "snapshot_not_ready", jobs: [] };
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
    const planned = await ensurePlannedJob({
      db,
      jobKey: LIKES_DISCOVERY_JOB_KEY,
      scope: "creator",
      creatorId,
      agencyId,
      idempotencyKey,
      params,
      priority,
      scheduledAt: new Date(),
      nextRunAt: new Date(),
      shouldResetExisting: (existing) => !["CLAIMED", "SCHEDULED"].includes(existing.status),
      protectedStatuses: ["CLAIMED"],
    });
    const job = planned.job;
    jobs.push({ id: job.id, status: job.status, batchSize: batch.length });
  }
  return { ok: true, created: jobs.some((job) => job.status === "SCHEDULED"), reason: "scheduled", jobs, fans: fans.length };
}

async function applyLikesDiscoveryChunk({ db = prisma, job, chunkResult }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("Likes discovery job is missing creator scope");
  return withCreatorLock(db, job.agencyId, job.creatorId, async (tx) => {
    const payload = object(chunkResult);
    const fan = object(payload.fan);
    const fanId = clean(fan.fanId, 160);
    const now = dateOrNull(payload.observedAt) || new Date();
    const snapshotRunId = clean(payload.snapshotRunId || object(job.params).snapshotRunId, 160);
    const snapshot = await currentSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db: tx });
    if (snapshotRunId && snapshot?.currentRunId !== snapshotRunId) {
      return { type: "likes_content", applied: 0, stale: true, sideEffect: "STALE_NOOP", snapshotRunId, currentSnapshotRunId: snapshot?.currentRunId || null };
    }
    const discoveryState = fanId ? await tx.automationContentDiscoveryState.findUnique({
      where: { creatorId_ownerFanId_sourceKey: { creatorId: job.creatorId, ownerFanId: fanId, sourceKey: "fan_posts" } },
    }) : null;
    if (discoveryState && await likesStateSupersedesJob({ db: tx, state: discoveryState, job })) {
      return { type: "likes_content", fanId, applied: 0, stale: true, sideEffect: "STALE_NOOP", snapshotRunId };
    }

    const posts = (Array.isArray(payload.posts) ? payload.posts : []).map((post) => normalizeDiscoveredLikePost(post, fan, now)).filter(Boolean);
    let applied = 0;
    for (const post of posts) {
      const existing = await tx.automationContentCandidate.findUnique({
        where: { creatorId_contentType_contentId: { creatorId: job.creatorId, contentType: "post", contentId: post.contentId } },
      });
      const preserveLiked = existing?.state === "LIKED" || existing?.isFavorite === true;
      await tx.automationContentCandidate.upsert({
        where: { creatorId_contentType_contentId: { creatorId: job.creatorId, contentType: "post", contentId: post.contentId } },
        create: {
          agencyId: job.agencyId, creatorId: job.creatorId, ownerFanId: fanId, contentType: "post", contentId: post.contentId,
          username: clean(fan.username, 160), displayName: clean(fan.displayName || fan.name, 200), contentUrl: post.contentUrl,
          postedAt: post.postedAt, canViewMedia: post.canViewMedia, isFavorite: post.isFavorite, state: post.state,
          eligibilityReason: post.reason, skipReason: post.state === "SKIPPED" ? post.reason : null,
          snapshotRunId, metadata: { ...post.metadata, ...likesAuthorityMetadata(job) },
        },
        update: {
          ownerFanId: fanId, username: clean(fan.username, 160), displayName: clean(fan.displayName || fan.name, 200), contentUrl: post.contentUrl,
          postedAt: post.postedAt, canViewMedia: post.canViewMedia, isFavorite: preserveLiked ? true : post.isFavorite,
          state: preserveLiked ? existing.state : post.state,
          eligibilityReason: preserveLiked ? existing.eligibilityReason : post.reason,
          skipReason: preserveLiked ? existing.skipReason : (post.state === "SKIPPED" ? post.reason : null),
          snapshotRunId, metadata: { ...object(existing?.metadata), ...post.metadata, ...likesAuthorityMetadata(job) },
        },
      });
      applied += 1;
    }
    const sourceErrors = Array.isArray(payload.sourceErrors) ? payload.sourceErrors.map((item) => object(item)).slice(0, 10) : [];
    const failed = posts.length === 0 && sourceErrors.length >= 3;
    if (fanId) {
      const authorityMetadata = likesAuthorityMetadata(job);
      await tx.automationContentDiscoveryState.upsert({
        where: { creatorId_ownerFanId_sourceKey: { creatorId: job.creatorId, ownerFanId: fanId, sourceKey: "fan_posts" } },
        create: {
          agencyId: job.agencyId, creatorId: job.creatorId, ownerFanId: fanId, sourceKey: "fan_posts",
          snapshotRunId, status: failed ? "FAILED" : "READY", contentCount: posts.length, sourceErrors,
          lastScannedAt: now, lastSuccessAt: failed ? null : now,
          metadata: { ...authorityMetadata, latestChunkKind: clean(payload.kind, 80) },
        },
        update: {
          snapshotRunId, status: failed ? "FAILED" : "READY", contentCount: posts.length, sourceErrors,
          lastScannedAt: now, ...(failed ? {} : { lastSuccessAt: now }),
          metadata: { ...object(discoveryState?.metadata), ...authorityMetadata, latestChunkKind: clean(payload.kind, 80) },
        },
      });
    }
    return { type: "likes_content", fanId, posts: posts.length, applied, sourceErrors: sourceErrors.length, status: failed ? "FAILED" : "READY" };
  });
}

async function applyLikesDiscoveryCompletion({ job, result, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) throw new Error("Likes discovery job is missing creator scope");
  return withCreatorLock(db, job.agencyId, job.creatorId, async (tx) => {
    const snapshotRunId = clean(object(job.params).snapshotRunId || object(result).snapshotRunId, 160);
    const snapshot = await currentSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db: tx });
    if (snapshotRunId && snapshot?.currentRunId !== snapshotRunId) {
      return { type: "likes_discovery", applied: false, stale: true, sideEffect: "STALE_NOOP", snapshotRunId, currentSnapshotRunId: snapshot?.currentRunId || null };
    }
    if (snapshotRunId) {
      await Promise.all([
        tx.automationContentCandidate.updateMany({
          where: {
            agencyId: job.agencyId,
            creatorId: job.creatorId,
            snapshotRunId: { not: snapshotRunId },
            state: { notIn: ["LIKED", "ALREADY_LIKED", "IGNORED", "BLOCKED"] },
          },
          data: { state: "STALE", eligibilityReason: "stale_candidate", latestStatus: "STALE" },
        }),
        tx.automationContentDiscoveryState.updateMany({
          where: { agencyId: job.agencyId, creatorId: job.creatorId, snapshotRunId: { not: snapshotRunId }, status: { not: "STALE" } },
          data: { status: "STALE" },
        }),
      ]);
    }
    let planning = null;
    try {
      const control = await getAutomationControlSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db: tx });
      if (control.effective.likesEnabled && control.modules.likes.settings.automatic) {
        planning = await planLikes({ agencyId: job.agencyId, creatorId: job.creatorId, source: "discovery_complete", manual: false, db: tx });
      }
    } catch (error) {
      planning = { ok: false, reason: error?.code || "planning_failed", error: error?.message || String(error) };
    }
    return { type: "likes_discovery", applied: true, result: object(result), planning };
  });
}

async function recordLikesDiscoveryFailure({ job, error, db = prisma }) {
  if (!job?.creatorId || !job?.agencyId) return null;
  return withCreatorLock(db, job.agencyId, job.creatorId, async (tx) => {
    const now = new Date();
    const message = clean(error?.message || error, 2000) || "likes_discovery_failed";
    const failureCode = clean(error?.code, 120) || "likes_discovery_failed";
    const snapshotRunId = clean(object(job.params).snapshotRunId, 160);
    const snapshot = await currentSnapshot({ agencyId: job.agencyId, creatorId: job.creatorId, db: tx });
    if (snapshotRunId && snapshot?.currentRunId !== snapshotRunId) {
      return { type: "likes_discovery", creatorId: job.creatorId, recorded: false, stale: true, sideEffect: "STALE_NOOP", failureCode };
    }
    const fans = Array.isArray(object(job.params).fans) ? object(job.params).fans : [];
    let recorded = 0;
    for (const fan of fans.slice(0, 500)) {
      const ownerFanId = clean(object(fan).fanId, 160);
      if (!ownerFanId) continue;
      const existing = await tx.automationContentDiscoveryState.findUnique({
        where: { creatorId_ownerFanId_sourceKey: { creatorId: job.creatorId, ownerFanId, sourceKey: "fan_posts" } },
      });
      if (existing && await likesStateSupersedesJob({ db: tx, state: existing, job })) continue;
      const metadata = { ...object(existing?.metadata), ...likesAuthorityMetadata(job), failureCode };
      await tx.automationContentDiscoveryState.upsert({
        where: { creatorId_ownerFanId_sourceKey: { creatorId: job.creatorId, ownerFanId, sourceKey: "fan_posts" } },
        create: {
          agencyId: job.agencyId, creatorId: job.creatorId, ownerFanId, sourceKey: "fan_posts", snapshotRunId,
          status: "FAILED", contentCount: 0, sourceErrors: [{ source: "job", code: failureCode }],
          lastScannedAt: now, metadata,
        },
        update: {
          snapshotRunId, status: "FAILED", sourceErrors: [{ source: "job", code: failureCode }],
          lastScannedAt: now, metadata,
        },
      });
      recorded += 1;
    }
    return { type: "likes_discovery", creatorId: job.creatorId, error: message, failureCode, recorded };
  });
}

async function currentBlockedFans({ agencyId, creatorId, fanIds, db }) {
  if (!fanIds.length) return new Set();
  const hidden = await db.hiddenOnlineUser.findMany({
    where: { agencyId, creatorId, fanId: { in: fanIds }, status: { in: ["ignored", "blocked"] } },
    select: { fanId: true },
  });
  return new Set(hidden.map((row) => row.fanId));
}

async function planLikesLocked({ db, agencyId, creatorId, userId = null, candidateIds = [], source = "manual", manual = true, priority = 60 }) {
  const control = await assertAutomationEnabled({ agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, db });
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  const snapshot = await currentSnapshot({ agencyId, creatorId, db });
  if (!snapshot?.currentRunId) return { ok: false, created: false, reason: "snapshot_not_ready", planned: 0, skipped: {} };
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
  const take = Math.min(500, Math.max(capacity * 4, 100));
  const findPage = ({ afterKey, take: pageSize }) => db.automationContentCandidate.findMany({
    where: {
      agencyId, creatorId, contentType: "post", snapshotRunId: snapshot.currentRunId,
      ...(ids.length ? { id: { in: ids } } : {}),
      ...(afterKey ? { contentId: { gt: afterKey } } : {}),
    },
    orderBy: { contentId: "asc" }, take: pageSize,
  });
  const page = ids.length ? await findPage({ take }) : await readFanConsumerPage({ db, agencyId, creatorId,
    runId: snapshot.currentRunId, consumerKey: "likes:planning", limit: take, findPage, keyOf: (row) => row.contentId, stableAcrossPublications: true });
  // Filter after bounded indexed enumeration, so an ineligible prefix cannot
  // force an unbounded scan or hide the rest of the current publication.
  const candidates = page.filter((row) => ["ELIGIBLE", "DISCOVERED"].includes(row.state)
    && (!row.cooldownUntil || row.cooldownUntil <= now)
    && row.canToggleFavorite !== false && row.canViewMedia !== false
    && (!settings.onlyUnliked || row.isFavorite !== true)
    && (!row.publishedAt || row.publishedAt >= cutoff));
  const blocked = await currentBlockedFans({ agencyId, creatorId, fanIds: [...new Set(candidates.map((row) => row.ownerFanId))], db });
  const skipped = {};
  const refreshFanIds = new Set();
  if (blocked.size) {
    const blockedIds = candidates.filter((candidate) => blocked.has(candidate.ownerFanId)).map((candidate) => candidate.id);
    await db.automationContentCandidate.updateMany({
      where: { agencyId, creatorId, contentType: "post", id: { in: blockedIds }, state: { in: ["ELIGIBLE", "DISCOVERED"] } },
      data: { state: "BLOCKED", skipReason: "blocked", eligibilityReason: "blocked", latestError: "blocked" },
    });
    skipped.blocked = candidates.filter((candidate) => blocked.has(candidate.ownerFanId)).length;
  }
  const available = candidates.filter((candidate) => !blocked.has(candidate.ownerFanId));
  const currentByFan = await readFanCurrentMap(db, {
    agencyId,
    creatorId,
    fanIds: [...new Set(available.map((candidate) => candidate.ownerFanId).filter(Boolean))],
  });
  const currentEligible = [];
  for (const candidate of available) {
    const eligibility = evaluateLikesCurrent(currentByFan.get(String(candidate.ownerFanId || "")) || null, settings, now);
    if (!eligibility.eligible) {
      skipped[eligibility.code] = (skipped[eligibility.code] || 0) + 1;
      if (eligibility.refreshRequired === true && candidate.ownerFanId) refreshFanIds.add(String(candidate.ownerFanId));
      continue;
    }
    currentEligible.push(candidate);
  }
  let selected;
  if (ids.length) {
    selected = currentEligible.slice(0, capacity);
  } else {
    const byFan = new Map();
    for (const candidate of currentEligible) {
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
    const existing = assertAutomationDeliveryAdoption(await db.automationDelivery.findUnique({ where: { idempotencyKey } }), { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE });
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
        agencyId, creatorId, originKind: "AUTOMATION", moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE,
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
  return {
    ok: true,
    created: planned > 0,
    reason: planned ? "planned" : "no_eligible_candidates",
    planned,
    skipped,
    refreshFanIds: [...refreshFanIds].slice(0, 500),
  };
}

async function scheduleLikesCurrentRefresh({
  agencyId,
  creatorId,
  fanIds = [],
  priority = 60,
  trigger = "planning",
  reason = "likes_current_unknown",
  refreshFields = [],
  scheduleFanRefresh = scheduleFanDataPointRefresh,
} = {}) {
  return scheduleDurableFanDataRefreshDebt({
    agencyId, creatorId, fanIds, consumer: "likes", reason,
    priority: Math.max(85, Number(priority) || 60), trigger, refreshFields, scheduleFanRefresh,
  });
}

async function planLikes(input) {
  const {
    db = prisma,
    agencyId,
    creatorId,
    priority = 60,
    scheduleFanRefresh = scheduleFanDataPointRefresh,
  } = input;
  const result = await withCreatorLock(db, agencyId, creatorId, (tx) => planLikesLocked({ ...input, db: tx }));

  // Refresh scheduling happens only after the planning transaction releases its
  // creator advisory lock. Unknown current facts therefore fail closed first,
  // then request one bounded canonical refresh batch out of transaction.
  const fanRefresh = await scheduleLikesCurrentRefresh({
    agencyId,
    creatorId,
    fanIds: result.refreshFanIds,
    priority,
    scheduleFanRefresh,
  });
  if (!fanRefresh.requested) return { ...result, refreshFanIds: [] };
  return { ...result, refreshFanIds: fanRefresh.fanIds, fanRefresh };
}

function resolveAutomaticLikesResult({ discovery, planning }) {
  const created = Boolean(discovery?.created || planning?.created);
  if (planning?.fanRefresh?.requested > 0 && planning.fanRefresh.durable !== true) {
    return { ok: false, created, reason: "fan_refresh_debt_not_durable", discovery, planning };
  }
  const failed = [discovery, planning].find((decision) => decision?.ok === false);
  if (failed) {
    return { ok: false, created, reason: failed.reason || failed.code || "likes_substep_failed", discovery, planning };
  }
  if (!discovery || !planning || typeof discovery.ok !== "boolean" || typeof planning.ok !== "boolean") {
    return { ok: false, created, reason: "likes_substep_malformed", discovery, planning };
  }
  return { ok: true, created, reason: created ? "planned" : "nothing_due", discovery, planning };
}

async function ensureAutomaticLikes({ agencyId, creatorId, source = "automatic", db = prisma }) {
  let control;
  try { control = await getAutomationControlSnapshot({ agencyId, creatorId, db }); }
  catch (error) { return { ok: false, created: false, reason: error?.code || "control_unavailable" }; }
  if (!control.effective.likesEnabled) return { ok: true, created: false, reason: "module_disabled" };
  const settings = normalizeLikesSettings(control.modules.likes.settings);
  if (!settings.automatic) return { ok: true, created: false, reason: "automatic_disabled" };
  const discovery = await scheduleLikesDiscovery({
    agencyId, creatorId, source, force: false, maxFans: settings.discoveryBatchSize * 2, priority: 25, db,
  }).catch((error) => ({ ok: false, created: false, reason: error?.code || error?.message || "likes_discovery_failed" }));
  const planning = await planLikes({
    agencyId, creatorId, source, manual: false, priority: 40, db,
  }).catch((error) => ({ ok: false, created: false, reason: error?.code || error?.message || "likes_planning_failed" }));
  return resolveAutomaticLikesResult({ discovery, planning });
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
  const currentByFan = await readFanCurrentMap(db, {
    agencyId: delivery.agencyId,
    creatorId: delivery.creatorId,
    fanIds: [candidate.ownerFanId],
  });
  const current = currentByFan.get(String(candidate.ownerFanId || "")) || null;
  const currentEligibility = evaluateLikesCurrent(current, settings, now);
  if (!currentEligibility.eligible) {
    return {
      ok: false,
      terminal: currentEligibility.retryable !== true,
      status: "SKIPPED",
      code: currentEligibility.code,
      ...(currentEligibility.retryable === true ? { retryAt: new Date(now.getTime() + 30_000) } : {}),
      ...(currentEligibility.refreshRequired === true ? {
        refreshRequired: true,
        refreshFanIds: candidate.ownerFanId ? [String(candidate.ownerFanId)] : [],
        refreshFields: currentEligibility.refreshFields || [],
        freshnessClass: currentEligibility.freshnessClass || null,
      } : {}),
    };
  }
  const completedToday = await db.automationDelivery.count({
    where: { agencyId: delivery.agencyId, creatorId: delivery.creatorId, moduleKey: LIKES_MODULE_KEY, actionType: LIKE_POST_ACTION_TYPE, status: "COMPLETED", finishedAt: { gte: dayStart(now) }, id: { not: delivery.id } },
  });
  if (completedToday >= settings.dailyLimit) {
    const retryAt = new Date(dayStart(now)); retryAt.setDate(retryAt.getDate() + 1);
    return { ok: false, terminal: false, code: "daily_limit", retryAt };
  }
  return {
    ok: true,
    candidate,
    fanCurrentFence: buildFanCurrentFieldFence(current, likesRequiredFields(settings, current)),
  };
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

async function countCanonicalEligibleLikeCandidates({ agencyId, creatorId, settings, db = prisma }) {
  const allowActive = settings?.activeSubscribers === true;
  const allowExpired = settings?.expiredSubscribers === true;
  const allowFree = settings?.freeSubscribers === true;
  const allowPaid = settings?.paidSubscribers === true;
  if (!allowActive && !allowExpired) return 0;
  const rows = await db.$queryRawUnsafe(
    `
    SELECT COUNT(*)::bigint AS "count"
    FROM "AutomationContentCandidate" c
    JOIN "CreatorFanRelationshipCurrent" r
      ON r."creatorId" = c."creatorId" AND r."onlyFansUserId" = c."ownerFanId"
    WHERE c."agencyId" = $1
      AND c."creatorId" = $2
      AND c."contentType" = 'post'
      AND c."state" IN ('ELIGIBLE', 'DISCOVERED')
      AND r."fanSubscriptionActiveAuthorityVersion" IS NOT NULL
      AND (NOT $7 OR r."fanSubscriptionActive" IS FALSE OR r."fanSubscriptionTypeAuthorityVersion" IS NOT NULL)
      AND CASE
        WHEN r."fanSubscriptionActive" IS FALSE THEN $4
        WHEN r."fanSubscriptionActive" IS TRUE THEN
          $3 AND CASE
            WHEN $5 AND $6 THEN true
            WHEN $5 THEN lower(COALESCE(r."fanSubscriptionType", '')) LIKE '%free%'
            WHEN $6 THEN lower(COALESCE(r."fanSubscriptionType", '')) LIKE '%paid%'
              OR lower(COALESCE(r."fanSubscriptionType", '')) LIKE '%active%'
            ELSE false
          END
        ELSE
          ($3 AND $4) AND CASE
            WHEN $5 AND $6 THEN true
            WHEN $5 THEN lower(COALESCE(r."fanSubscriptionType", '')) LIKE '%free%'
            WHEN $6 THEN lower(COALESCE(r."fanSubscriptionType", '')) LIKE '%paid%'
              OR lower(COALESCE(r."fanSubscriptionType", '')) LIKE '%active%'
            ELSE false
          END
      END
    `,
    agencyId, creatorId, allowActive, allowExpired, allowFree, allowPaid, allowFree !== allowPaid,
  );
  return Number(rows?.[0]?.count || 0);
}

async function listLikes({ agencyId, creatorId, search = "", state = null, offset = 0, limit = 100, db = prisma }) {
  await requireCreator(agencyId, creatorId, db);
  const control = await getAutomationControlSnapshot({ agencyId, creatorId, db });
  const settings = normalizeLikesSettings(control.modules.likes.settings);
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
      countCanonicalEligibleLikeCandidates({ agencyId, creatorId, settings, db }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "QUEUED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "CLAIMED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: { in: ["RUNNING", "COMMITTING", "RECONCILE_REQUIRED"] } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "COMPLETED", finishedAt: { gte: dayStart(now) } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "COMPLETED", finishedAt: { gte: monthStart(now) } } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "FAILED" } }),
      db.automationDelivery.count({ where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, status: "SKIPPED" } }),
    ]),
    sessionWriteWorkerCount({ agencyId, creatorId, db }),
    db.jobInstance.findFirst({ where: { agencyId, creatorId, jobKey: LIKES_DISCOVERY_JOB_KEY }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, progress: true, lastError: true, createdAt: true, completedAt: true } }),
  ]);
  const currentByFan = await readFanCurrentMap(db, {
    agencyId,
    creatorId,
    fanIds: items.map((item) => item.ownerFanId).filter(Boolean),
  });
  const publicItems = items.map((item) => {
    const current = currentByFan.get(String(item.ownerFanId || "")) || null;
    const audience = evaluateLikesCurrent(current, settings, now);
    const workflowEligible = item.state === "ELIGIBLE" || item.state === "DISCOVERED";
    return {
      ...item,
      eligible: workflowEligible && audience.eligible === true,
      currentEligibility: audience.code,
      platformIdentity: current?.platformIdentity || null,
      relationship: current?.relationship || null,
      value: current?.value || null,
    };
  });
  return {
    ok: true, creatorId, control, settings,
    worker: { ready: worker > 0, readyDevices: worker },
    discovery: lastJob,
    metrics: {
      candidates: metrics[0], eligible: metrics[1], queued: metrics[2], claimed: metrics[3], running: metrics[4],
      likedToday: metrics[5], likedThisMonth: metrics[6], failed: metrics[7], skipped: metrics[8],
    },
    items: publicItems, count, offset, nextOffset: offset + publicItems.length, hasMore: offset + publicItems.length < count,
  };
}

async function setLikeCandidateState({ agencyId, creatorId, candidateId, action, db = prisma }) {
  if (action === "restore") {
    const candidate = await db.automationContentCandidate.findFirst({ where: { id: candidateId, agencyId, creatorId } });
    if (!candidate) throw Object.assign(new Error("Like candidate not found"), { code: "candidate_not_found", status: 404 });
    return db.automationContentCandidate.update({ where: { id: candidate.id }, data: { state: candidate.isFavorite ? "ALREADY_LIKED" : "ELIGIBLE", skipReason: null, latestError: null } });
  }
  if (!["ignore", "block"].includes(action)) throw Object.assign(new Error("Unsupported candidate action"), { code: "invalid_candidate_action", status: 400 });
  return runWithAutomationWriteCommitFence({
    db,
    agencyId,
    options: { timeout: 30_000 },
    work: async (tx) => {
      const candidate = await tx.automationContentCandidate.findFirst({ where: { id: candidateId, agencyId, creatorId } });
      if (!candidate) throw Object.assign(new Error("Like candidate not found"), { code: "candidate_not_found", status: 404 });
      const state = action === "ignore" ? "IGNORED" : "BLOCKED";
      await tx.automationDelivery.updateMany({
        where: { agencyId, creatorId, moduleKey: LIKES_MODULE_KEY, targetId: candidate.contentId, status: { in: PRECOMMIT_MUTABLE_STATUSES } },
        data: { status: "CANCELED", failureCode: action === "ignore" ? "ignored" : "blocked", lastError: action, finishedAt: new Date(), claimedByDeviceId: null, claimedAt: null, claimUntil: null, leaseTokenHash: null, leaseRevision: { increment: 1 } },
      });
      return tx.automationContentCandidate.update({ where: { id: candidate.id }, data: { state, skipReason: action, latestError: action } });
    },
  });
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
  scheduleLikesCurrentRefresh,
  ensureAutomaticLikes,
  validateLikeDelivery,
  finalizeLikeSuccess,
  finalizeLikeFailure,
  finalizeLikeTerminal,
  prepareLikeRetry,
  listLikes,
  setLikeCandidateState,
  _test: { resolveAutomaticLikesResult },
};
