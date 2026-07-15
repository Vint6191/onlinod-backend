"use strict";

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function clean(value, max = 500) { const text = String(value ?? "").trim(); return text ? text.slice(0, max) : null; }
function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function bool(value, fallback) { return value === undefined || value === null ? fallback : value === true; }

const DEFAULT_SFS_SETTINGS = Object.freeze({
  enabled: false,
  automatic: false,
  huntingEnabled: true,
  commentsEnabled: true,
  commentLikesEnabled: true,
  dailyLimit: 20,
  wallScanPosts: 40,
  discoveryFreshnessHours: 12,
  maxPinnedPosts: 5,
  commentsPageLimit: 20,
  commentsMaxPages: 50,
  commentLikesPerPost: 8,
  commentLikesDailyCap: 800,
  minimumIntervalMs: 15_000,
  maximumIntervalMs: 45_000,
  randomJitter: true,
  maxAttempts: 3,
  followToScanMinMs: 10_000,
  followToScanMaxMs: 30_000,
  unfollowMinMinutes: 3,
  unfollowMaxMinutes: 10,
  quickUnfollowMinMs: 30_000,
  quickUnfollowMaxMs: 90_000,
  safetyUnfollowMs: 15 * 60_000,
  oneTargetForever: true,
  freeTargetsOnly: true,
});

function normalizeSfsSettings(value) {
  const input = object(value);
  const minimumIntervalMs = integer(input.minimumIntervalMs, DEFAULT_SFS_SETTINGS.minimumIntervalMs, 15_000, 30 * 60_000);
  const maximumIntervalMs = integer(input.maximumIntervalMs, DEFAULT_SFS_SETTINGS.maximumIntervalMs, minimumIntervalMs, 60 * 60_000);
  const followToScanMinMs = integer(input.followToScanMinMs, DEFAULT_SFS_SETTINGS.followToScanMinMs, 1_000, 10 * 60_000);
  const followToScanMaxMs = integer(input.followToScanMaxMs, DEFAULT_SFS_SETTINGS.followToScanMaxMs, followToScanMinMs, 30 * 60_000);
  const unfollowMinMinutes = integer(input.unfollowMinMinutes, DEFAULT_SFS_SETTINGS.unfollowMinMinutes, 1, 60);
  const unfollowMaxMinutes = integer(input.unfollowMaxMinutes, DEFAULT_SFS_SETTINGS.unfollowMaxMinutes, unfollowMinMinutes, 120);
  const quickUnfollowMinMs = integer(input.quickUnfollowMinMs, DEFAULT_SFS_SETTINGS.quickUnfollowMinMs, 5_000, 30 * 60_000);
  const quickUnfollowMaxMs = integer(input.quickUnfollowMaxMs, DEFAULT_SFS_SETTINGS.quickUnfollowMaxMs, quickUnfollowMinMs, 60 * 60_000);
  return {
    enabled: bool(input.enabled, DEFAULT_SFS_SETTINGS.enabled),
    automatic: bool(input.automatic, DEFAULT_SFS_SETTINGS.automatic),
    huntingEnabled: bool(input.huntingEnabled, DEFAULT_SFS_SETTINGS.huntingEnabled),
    commentsEnabled: bool(input.commentsEnabled, DEFAULT_SFS_SETTINGS.commentsEnabled),
    commentLikesEnabled: bool(input.commentLikesEnabled, DEFAULT_SFS_SETTINGS.commentLikesEnabled),
    dailyLimit: integer(input.dailyLimit, DEFAULT_SFS_SETTINGS.dailyLimit, 0, 100),
    wallScanPosts: integer(input.wallScanPosts, DEFAULT_SFS_SETTINGS.wallScanPosts, 1, 100),
    discoveryFreshnessHours: integer(input.discoveryFreshnessHours, DEFAULT_SFS_SETTINGS.discoveryFreshnessHours, 1, 168),
    maxPinnedPosts: integer(input.maxPinnedPosts, DEFAULT_SFS_SETTINGS.maxPinnedPosts, 1, 10),
    commentsPageLimit: integer(input.commentsPageLimit, DEFAULT_SFS_SETTINGS.commentsPageLimit, 1, 50),
    commentsMaxPages: integer(input.commentsMaxPages, DEFAULT_SFS_SETTINGS.commentsMaxPages, 1, 100),
    commentLikesPerPost: integer(input.commentLikesPerPost, DEFAULT_SFS_SETTINGS.commentLikesPerPost, 0, 50),
    commentLikesDailyCap: integer(input.commentLikesDailyCap, DEFAULT_SFS_SETTINGS.commentLikesDailyCap, 0, 10_000),
    minimumIntervalMs,
    maximumIntervalMs,
    randomJitter: bool(input.randomJitter, DEFAULT_SFS_SETTINGS.randomJitter),
    maxAttempts: integer(input.maxAttempts, DEFAULT_SFS_SETTINGS.maxAttempts, 1, 10),
    followToScanMinMs,
    followToScanMaxMs,
    unfollowMinMinutes,
    unfollowMaxMinutes,
    quickUnfollowMinMs,
    quickUnfollowMaxMs,
    safetyUnfollowMs: integer(input.safetyUnfollowMs, DEFAULT_SFS_SETTINGS.safetyUnfollowMs, 60_000, 24 * 60 * 60_000),
    oneTargetForever: bool(input.oneTargetForever, DEFAULT_SFS_SETTINGS.oneTargetForever),
    freeTargetsOnly: bool(input.freeTargetsOnly, DEFAULT_SFS_SETTINGS.freeTargetsOnly),
  };
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/gi, "")
    .slice(0, 80);
}

function extractSfsUsernames(text = "") {
  const raw = String(text || "");
  const out = new Set();
  const add = (value) => {
    const username = cleanUsername(value);
    if (!username || username.length < 2) return;
    if (["api2", "my", "posts", "chats", "settings", "notifications", "messages"].includes(username)) return;
    out.add(username);
  };
  for (const match of raw.matchAll(/(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9_.-]{2,80})/g)) add(match[1]);
  for (const match of raw.matchAll(/href=["']\/?([a-zA-Z0-9_.-]{2,80})["']/gi)) add(match[1]);
  return [...out];
}

function normalizeSfsTarget(value, sourcePostIds = []) {
  const row = object(value);
  const targetUserId = clean(row.id ?? row.userId ?? row.fanId, 160);
  const username = cleanUsername(row.username ?? row.userName);
  if (!targetUserId || !username) return null;
  const price = Number(row.subscribePrice ?? row.subscriptionPrice ?? row.price ?? 0);
  return {
    targetUserId,
    username,
    displayName: clean(row.name ?? row.displayName, 240),
    avatarUrl: clean(row.avatar ?? row.avatarUrl, 1000),
    subscribePriceCents: Number.isFinite(price) ? Math.max(0, Math.round(price * 100)) : 0,
    isWantComments: typeof row.isWantComments === "boolean" ? row.isWantComments : null,
    creatorFollowing: row.subscribedBy === true || row.subscribedByCreator === true,
    sourcePostIds: [...new Set((Array.isArray(sourcePostIds) ? sourcePostIds : []).map((id) => clean(id, 160)).filter(Boolean))].slice(0, 100),
  };
}

function targetEligibility(candidate, settings, now = new Date()) {
  if (!candidate) return "invalid_target";
  if (settings?.commentsEnabled === false && settings?.commentLikesEnabled === false) return "actions_disabled";
  if (candidate.blocked) return "blocked";
  if (candidate.ignored) return "ignored";
  if (settings.oneTargetForever && candidate.usedForever) return "used_forever";
  if (settings.freeTargetsOnly && Number(candidate.subscribePriceCents || 0) > 0) return "paid_target";
  if (candidate.creatorFollowing === true) return "already_following";
  if (candidate.isWantComments === false) return "comments_disabled";
  if (candidate.cooldownUntil && new Date(candidate.cooldownUntil).getTime() > now.getTime()) return "cooldown";
  if (["QUEUED", "FOLLOWING", "SCANNING", "ACTING", "UNFOLLOW_DUE", "UNFOLLOWING"].includes(String(candidate.state || ""))) return "active_delivery";
  return "eligible";
}

function isRealUserComment(value, { creatorRemoteId, targetUserId } = {}) {
  const row = object(value);
  const author = object(row.author ?? row.fromUser ?? row.user);
  const authorId = clean(author.id ?? row.authorId, 160);
  if (!authorId) return { eligible: false, reason: "author_missing" };
  if (authorId === clean(creatorRemoteId, 160)) return { eligible: false, reason: "own_comment" };
  if (authorId === clean(targetUserId, 160)) return { eligible: false, reason: "target_comment" };
  if (author.isPerformer === true || author.performer === true || author.isVerified === true || author.canEarn === true) return { eligible: false, reason: "performer_comment" };
  if (author.isDeleted === true || author.deleted === true) return { eligible: false, reason: "deleted_author" };
  if (row.isLiked === true || row.isFavorite === true || row.liked === true) return { eligible: false, reason: "already_liked" };
  if (row.canLike === false || row.canToggleLike === false) return { eligible: false, reason: "cannot_like" };
  const commentId = clean(row.id ?? row.commentId, 160);
  if (!commentId) return { eligible: false, reason: "comment_id_missing" };
  return { eligible: true, reason: "eligible", commentId, authorId, username: clean(author.username, 160) };
}

function shouldStartSfsSagaAfterFollow(outcomeCode, result = {}) {
  const code = String(outcomeCode || "").trim().toLowerCase();
  if (code !== "already_followed") return true;
  return object(result).recoveredAfterAmbiguousWrite === true;
}

function sfsTargetGenerationKey(creatorId, targetUserId, generation) {
  return `sfs_target:${creatorId}:${targetUserId}:${Math.max(1, Number(generation) || 1)}`;
}
function sfsCommentKey(creatorId, targetUserId, postId, generation) {
  return `sfs_comment:${creatorId}:${targetUserId}:${postId}:${Math.max(1, Number(generation) || 1)}`;
}
function sfsCommentLikeKey(creatorId, targetUserId, commentId, generation) {
  return `sfs_comment_like:${creatorId}:${targetUserId}:${commentId}:${Math.max(1, Number(generation) || 1)}`;
}
function sfsUnfollowKey(creatorId, targetUserId, generation) {
  return `sfs_unfollow:${creatorId}:${targetUserId}:${Math.max(1, Number(generation) || 1)}`;
}

module.exports = {
  DEFAULT_SFS_SETTINGS,
  normalizeSfsSettings,
  cleanUsername,
  extractSfsUsernames,
  normalizeSfsTarget,
  targetEligibility,
  isRealUserComment,
  shouldStartSfsSagaAfterFollow,
  sfsTargetGenerationKey,
  sfsCommentKey,
  sfsCommentLikeKey,
  sfsUnfollowKey,
};
