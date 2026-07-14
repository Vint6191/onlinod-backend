"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateCandidate } = require("./follow-back-rules");

const settings = {
  activeSubscribers: true, freeSubscribers: true, paidSubscribers: true, expiredSubscribers: false,
};

test("Follow Back eligibility preserves alpha subscribedBy semantics", () => {
  assert.deepEqual(evaluateCandidate({ state: "CANDIDATE", isActive: true, subscribedByCreator: false }, settings), { eligible: true, code: "active_subscriber" });
  assert.deepEqual(evaluateCandidate({ state: "FOLLOWED", isActive: true, subscribedByCreator: true }, settings), { eligible: false, code: "already_followed" });
});

test("Follow Back rejects blocked, ignored and stale candidates before planning", () => {
  assert.equal(evaluateCandidate({ blocked: true }, settings).code, "blocked");
  assert.equal(evaluateCandidate({ ignored: true }, settings).code, "ignored");
  assert.equal(evaluateCandidate({ state: "STALE" }, settings).code, "stale_candidate");
});

test("Follow Back respects segment settings", () => {
  assert.equal(evaluateCandidate({ state: "CANDIDATE", isActive: true, subscriptionType: "free" }, { ...settings, freeSubscribers: false }).code, "free_subscribers_disabled");
  assert.equal(evaluateCandidate({ state: "CANDIDATE", isActive: false, subscriptionType: "expired" }, settings).code, "expired_subscribers_disabled");
});

test("Follow Back keeps refollow as a separate future action type", () => {
  assert.equal(
    evaluateCandidate({ state: "CANDIDATE", generation: 2, isActive: true, subscribedByCreator: false }, { ...settings, refollowEnabled: false }).code,
    "refollow_disabled",
  );
  assert.equal(
    evaluateCandidate({ state: "CANDIDATE", generation: 2, isActive: true, subscribedByCreator: false }, { ...settings, refollowEnabled: true }).code,
    "refollow_action_pending",
  );
});
