"use strict";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeDiscoveredLikePost(post, fan, observedAt = new Date()) {
  const row = object(post);
  const owner = object(fan);
  const contentId = clean(row.contentId || row.postId || row.id, 160);
  if (!contentId) return null;
  const ownerFanId = clean(row.authorId || row.ownerFanId || owner.fanId, 160);
  if (!ownerFanId) return null;
  const isFavorite = row.isFavorite === true;
  const canToggleFavorite = row.canToggleFavorite === undefined || row.canToggleFavorite === null
    ? null
    : row.canToggleFavorite === true;
  const canViewMedia = row.canViewMedia === undefined || row.canViewMedia === null
    ? null
    : row.canViewMedia === true;
  let state = "ELIGIBLE";
  let reason = "unliked_visible_post";
  if (isFavorite) {
    state = "ALREADY_LIKED";
    reason = "already_liked";
  } else if (canToggleFavorite === false) {
    state = "SKIPPED";
    reason = "cannot_like";
  } else if (canViewMedia === false) {
    state = "SKIPPED";
    reason = "cannot_view";
  }
  const now = dateOrNull(observedAt) || new Date();
  return {
    contentId,
    ownerFanId,
    username: clean(owner.username, 160),
    displayName: clean(owner.displayName, 240),
    avatarUrl: clean(owner.avatarUrl, 1000),
    publishedAt: dateOrNull(row.publishedAt || row.postedAt || row.createdAt),
    canToggleFavorite,
    canViewMedia,
    isFavorite,
    state,
    reason,
    metadata: {
      ...object(row.metadata),
      preview: object(row.preview),
      rawFlags: object(row.rawFlags),
      observedAt: now.toISOString(),
    },
  };
}

function likeDeliveryIdempotencyKey({ creatorId, contentId }) {
  const creator = clean(creatorId, 160);
  const content = clean(contentId, 160);
  if (!creator || !content) return null;
  return `like_post:${creator}:${content}`;
}

function isPlannableLikeCandidateState(value) {
  return value === "ELIGIBLE" || value === "DISCOVERED";
}

module.exports = {
  normalizeDiscoveredLikePost,
  likeDeliveryIdempotencyKey,
  isPlannableLikeCandidateState,
};
