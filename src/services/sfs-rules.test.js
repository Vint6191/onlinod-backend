"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSfsSettings, extractSfsUsernames, normalizeSfsTarget, targetEligibility,
  isRealUserComment, shouldStartSfsSagaAfterFollow, sfsCommentKey,
} = require("./sfs-rules");

test("SFS defaults keep safe pacing and cleanup", () => {
  const settings = normalizeSfsSettings({ minimumIntervalMs: 3000, maximumIntervalMs: 9000 });
  assert.equal(settings.minimumIntervalMs, 15000);
  assert.equal(settings.maximumIntervalMs, 15000);
  assert.equal(settings.safetyUnfollowMs, 15 * 60_000);
  assert.equal(settings.oneTargetForever, true);
});

test("SFS usernames are extracted and sanitized", () => {
  assert.deepEqual(extractSfsUsernames('hi @Alice and <a href="/Bob_2">x</a> @api2'), ["alice", "bob_2"]);
});

test("SFS target normalization preserves free and comments flags", () => {
  const row = normalizeSfsTarget({ id: 12, username: "@Model", subscribePrice: 0, isWantComments: true }, ["p1"]);
  assert.equal(row.targetUserId, "12");
  assert.equal(row.username, "model");
  assert.equal(row.subscribePriceCents, 0);
  assert.equal(row.isWantComments, true);
});

test("SFS eligibility is explicit", () => {
  const settings = normalizeSfsSettings({});
  assert.equal(targetEligibility({ usedForever: true }, settings), "used_forever");
  assert.equal(targetEligibility({ subscribePriceCents: 100 }, settings), "paid_target");
  assert.equal(targetEligibility({ isWantComments: false }, settings), "comments_disabled");
  assert.equal(targetEligibility({ state: "CANDIDATE" }, settings), "eligible");
});

test("SFS likes only normal user comments", () => {
  assert.equal(isRealUserComment({ id: "c1", author: { id: "u1", username: "fan" } }, { creatorRemoteId: "me", targetUserId: "target" }).eligible, true);
  assert.equal(isRealUserComment({ id: "c2", author: { id: "target" } }, { creatorRemoteId: "me", targetUserId: "target" }).reason, "target_comment");
  assert.equal(isRealUserComment({ id: "c3", author: { id: "x", isPerformer: true } }, { creatorRemoteId: "me", targetUserId: "target" }).reason, "performer_comment");
});

test("SFS idempotency includes generation", () => {
  assert.equal(sfsCommentKey("c", "u", "p", 2), "sfs_comment:c:u:p:2");
});


test("manual already-followed target does not start an SFS cleanup saga", () => {
  assert.equal(shouldStartSfsSagaAfterFollow("already_followed", {}), false);
  assert.equal(shouldStartSfsSagaAfterFollow("already_followed", { recoveredAfterAmbiguousWrite: true }), true);
  assert.equal(shouldStartSfsSagaAfterFollow("followed", {}), true);
});

test("SFS does not follow targets when every action is disabled", () => {
  const candidate = { subscribePriceCents: 0, creatorFollowing: false, isWantComments: true, state: "CANDIDATE" };
  const settings = normalizeSfsSettings({ commentsEnabled: false, commentLikesEnabled: false });
  assert.equal(targetEligibility(candidate, settings), "actions_disabled");
});
