"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDiscoveredLikePost,
  likeDeliveryIdempotencyKey,
  isPlannableLikeCandidateState,
} = require("./likes-rules");

const FAN = { fanId: "fan-7", username: "alice", displayName: "Alice" };

test("Likes discovery turns a visible unliked Alpha post into an eligible candidate", () => {
  const row = normalizeDiscoveredLikePost({ id: "post-1", authorId: "fan-7", canToggleFavorite: true, canViewMedia: true }, FAN, "2026-07-15T10:00:00Z");
  assert.equal(row.state, "ELIGIBLE");
  assert.equal(row.reason, "unliked_visible_post");
  assert.equal(row.contentId, "post-1");
  assert.equal(row.ownerFanId, "fan-7");
});

test("Likes discovery preserves already-liked as idempotent terminal state", () => {
  const row = normalizeDiscoveredLikePost({ id: "post-2", isFavorite: true }, FAN);
  assert.equal(row.state, "ALREADY_LIKED");
  assert.equal(row.reason, "already_liked");
  assert.equal(row.isFavorite, true);
});

test("Likes discovery records explicit cannot-like and cannot-view skip reasons", () => {
  const cannotLike = normalizeDiscoveredLikePost({ id: "post-3", canToggleFavorite: false }, FAN);
  const cannotView = normalizeDiscoveredLikePost({ id: "post-4", canToggleFavorite: true, canViewMedia: false }, FAN);
  assert.deepEqual([cannotLike.state, cannotLike.reason], ["SKIPPED", "cannot_like"]);
  assert.deepEqual([cannotView.state, cannotView.reason], ["SKIPPED", "cannot_view"]);
});

test("Like idempotency is stable per creator and content", () => {
  assert.equal(likeDeliveryIdempotencyKey({ creatorId: "creator-1", contentId: "post-1" }), "like_post:creator-1:post-1");
  assert.notEqual(
    likeDeliveryIdempotencyKey({ creatorId: "creator-1", contentId: "post-1" }),
    likeDeliveryIdempotencyKey({ creatorId: "creator-2", contentId: "post-1" }),
  );
});

test("Only fresh discovery states are automatically plannable", () => {
  assert.equal(isPlannableLikeCandidateState("DISCOVERED"), true);
  assert.equal(isPlannableLikeCandidateState("ELIGIBLE"), true);
  assert.equal(isPlannableLikeCandidateState("FAILED"), false);
  assert.equal(isPlannableLikeCandidateState("SKIPPED"), false);
  assert.equal(isPlannableLikeCandidateState("BLOCKED"), false);
});
