"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSfsSettings, extractSfsUsernames, normalizeSfsTarget, targetEligibility,
  isRealUserComment, classifySfsFollowEffectOwnership, shouldStartSfsSagaAfterFollow, sfsCommentKey,
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

test("SFS eligibility is explicit and UNKNOWN fails closed", () => {
  const settings = normalizeSfsSettings({});
  const fresh = new Date();
  assert.equal(targetEligibility({ usedForever: true }, settings, fresh), "used_forever");
  assert.equal(targetEligibility({ subscribePriceCents: 100, discoveryObservedAt: fresh }, settings, fresh), "paid_target");
  assert.equal(targetEligibility({ subscribePriceCents: 0, creatorFollowing: false, isWantComments: false, discoveryObservedAt: fresh }, settings, fresh), "comments_disabled");
  assert.equal(targetEligibility({ subscribePriceCents: null, creatorFollowing: false, isWantComments: true, discoveryObservedAt: fresh }, settings, fresh), "price_unknown");
  assert.equal(targetEligibility({ subscribePriceCents: 0, creatorFollowing: null, isWantComments: true, discoveryObservedAt: fresh }, settings, fresh), "following_unknown");
  assert.equal(targetEligibility({ subscribePriceCents: 0, creatorFollowing: false, isWantComments: null, discoveryObservedAt: fresh }, settings, fresh), "comments_unknown");
  assert.equal(targetEligibility({ subscribePriceCents: 0, creatorFollowing: false, isWantComments: true, discoveryObservedAt: fresh, state: "CANDIDATE" }, settings, fresh), "eligible");
});

test("SFS likes only normal user comments", () => {
  assert.equal(isRealUserComment({ id: "c1", author: { id: "u1", username: "fan" } }, { creatorRemoteId: "me", targetUserId: "target" }).eligible, true);
  assert.equal(isRealUserComment({ id: "c2", author: { id: "target" } }, { creatorRemoteId: "me", targetUserId: "target" }).reason, "target_comment");
  assert.equal(isRealUserComment({ id: "c3", author: { id: "x", isPerformer: true } }, { creatorRemoteId: "me", targetUserId: "target" }).reason, "performer_comment");
});

test("SFS idempotency includes generation", () => {
  assert.equal(sfsCommentKey("c", "u", "p", 2), "sfs_comment:c:u:p:2");
});


test("SFS cleanup starts only from a server-committed direct follow success", () => {
  const committed = { writeCommitAt: new Date("2026-09-16T10:00:00.000Z") };
  assert.equal(classifySfsFollowEffectOwnership({ outcomeCode: "followed", delivery: committed }), "OWNED");
  assert.equal(classifySfsFollowEffectOwnership({ outcomeCode: "followed", delivery: {} }), "UNPROVEN");
  assert.equal(classifySfsFollowEffectOwnership({ outcomeCode: "already_followed", delivery: committed }), "PREEXISTING");
  assert.equal(classifySfsFollowEffectOwnership({ outcomeCode: "followed_recovered", result: { recoveredAfterAmbiguousWrite: true }, delivery: committed }), "AMBIGUOUS_UNOWNED");
  assert.equal(shouldStartSfsSagaAfterFollow("already_followed", {}, committed), false);
  assert.equal(shouldStartSfsSagaAfterFollow("followed_recovered", { recoveredAfterAmbiguousWrite: true }, committed), false);
  assert.equal(shouldStartSfsSagaAfterFollow("followed", {}, committed), true);
});

test("SFS does not follow targets when every action is disabled", () => {
  const candidate = { subscribePriceCents: 0, creatorFollowing: false, isWantComments: true, state: "CANDIDATE" };
  const settings = normalizeSfsSettings({ commentsEnabled: false, commentLikesEnabled: false });
  assert.equal(targetEligibility(candidate, settings), "actions_disabled");
});
