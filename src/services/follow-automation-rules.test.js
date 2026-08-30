"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateRefollowCandidate, refollowUnfollowKey, refollowFollowKey } = require("./follow-automation-rules");

const settings = { refollowEnabled: true, maxNudgesPerFan: 1 };
const base = {
  fanId: "fan-1", state: "CANDIDATE", phase: "IDLE", blocked: false, ignored: false,
  ofBlocked: false, restricted: false, performer: false, subscribePriceCents: 0,
  fanSubscriptionActive: false, creatorFollowsFan: true, nudgeCount: 0, cooldownUntil: null,
};

test("expired free fan still followed by creator is eligible for refollow nudge", () => {
  assert.deepEqual(evaluateRefollowCandidate(base, settings), { eligible: true, code: "fan_expired_creator_following" });
});

test("refollow never treats a general unfollow candidate as eligible", () => {
  assert.equal(evaluateRefollowCandidate({ ...base, creatorFollowsFan: false }, settings).code, "creator_not_following");
  assert.equal(evaluateRefollowCandidate({ ...base, fanSubscriptionActive: true }, settings).code, "fan_active");
});

test("Alpha paid/restricted/performer guards are explicit server-side skip codes", () => {
  assert.equal(evaluateRefollowCandidate({ ...base, subscribePriceCents: 100 }, settings).code, "paid_subscription_required");
  assert.equal(evaluateRefollowCandidate({ ...base, restricted: true }, settings).code, "restricted");
  assert.equal(evaluateRefollowCandidate({ ...base, performer: true }, settings).code, "performer");
});

test("cooldown and max nudge cap are shared server-side state", () => {
  assert.equal(evaluateRefollowCandidate({ ...base, cooldownUntil: new Date(Date.now() + 60_000) }, settings).code, "cooldown");
  assert.equal(evaluateRefollowCandidate({ ...base, nudgeCount: 1 }, settings).code, "max_refollow_nudges_reached");
});

test("the two saga steps have distinct stable idempotency keys", () => {
  assert.equal(refollowUnfollowKey({ creatorId: "c", fanId: "f", generation: 2 }), "refollow_unfollow:c:f:2");
  assert.equal(refollowFollowKey({ creatorId: "c", fanId: "f", generation: 2 }), "refollow_follow:c:f:2");
});

const {
  mustPreserveRefollowSaga,
} = require("./follow-automation-constants");

test("compensating follow remains claimable beyond configured attempts", () => {
  assert.equal(mustPreserveRefollowSaga({
    moduleKey: "follow",
    actionType: "FOLLOW_FAN",
    payload: { recovery: true },
    status: "RETRY_SCHEDULED",
    attempts: 20,
    maxAttempts: 10,
  }), true);
});

test("ambiguous running unfollow is preserved, but a clean preflight failure is bounded", () => {
  assert.equal(mustPreserveRefollowSaga({
    moduleKey: "follow",
    actionType: "UNFOLLOW_FAN",
    payload: { recovery: false },
    status: "RUNNING",
    result: { attemptStartedAt: new Date().toISOString() },
  }, "network_error"), true);
  assert.equal(mustPreserveRefollowSaga({
    moduleKey: "follow",
    actionType: "UNFOLLOW_FAN",
    payload: { recovery: false },
    status: "CLAIMED",
    result: {},
  }, "fan_not_found"), false);
});
