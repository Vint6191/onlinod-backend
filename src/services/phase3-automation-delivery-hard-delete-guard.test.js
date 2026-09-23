"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  candidateNoLongerNeedsFollowProof,
  partitionAutomationDeliveryHardDeleteCandidates,
} = require("./automation-delivery-hard-delete-guard");

function follow(overrides = {}) {
  return {
    id: "follow-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    moduleKey: "sfs",
    actionType: "SFS_FOLLOW_TARGET",
    payload: { candidateId: "candidate-1" },
    generation: 3,
    fanId: "fan-1",
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    id: "candidate-1",
    generation: 3,
    state: "UNFOLLOW_DUE",
    usedForever: false,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

test("Phase3 hard-delete guard retains the pre-INT4.3C SFS follow proof while cleanup is active", async () => {
  const row = follow();
  const db = { sfsTargetCandidate: { findMany: async () => [candidate()] } };
  const result = await partitionAutomationDeliveryHardDeleteCandidates({ db, rows: [row] });
  assert.deepEqual(result.deletable, []);
  assert.deepEqual(result.protected, [row]);
});

test("Phase3 hard-delete guard releases current, completed, legacy and superseded SFS proof", async () => {
  const row = follow();
  assert.equal(candidateNoLongerNeedsFollowProof(candidate({
    metadata: { followEffectOwnership: "OWNED", followEffectDeliveryId: row.id },
  }), row), true);
  assert.equal(candidateNoLongerNeedsFollowProof(candidate({ state: "COMPLETED", completedAt: new Date() }), row), true);
  assert.equal(candidateNoLongerNeedsFollowProof(candidate({ metadata: { legacyMigration: true } }), row), true);
  assert.equal(candidateNoLongerNeedsFollowProof(candidate({ generation: 4 }), row), true);

  const db = { sfsTargetCandidate: { findMany: async () => [candidate({
    metadata: { followEffectOwnership: "OWNED", followEffectDeliveryId: row.id },
  })] } };
  const result = await partitionAutomationDeliveryHardDeleteCandidates({ db, rows: [row] });
  assert.deepEqual(result.deletable, [row]);
  assert.deepEqual(result.protected, []);
});

test("Phase3 hard-delete guard fails closed for malformed SFS proof and missing candidate authority", async () => {
  const malformed = follow({ id: "malformed", payload: {} });
  const ordinary = { id: "ordinary", moduleKey: "bumps", actionType: "SEND_MESSAGE" };
  const unavailable = await partitionAutomationDeliveryHardDeleteCandidates({ db: {}, rows: [malformed, ordinary] });
  assert.deepEqual(unavailable.deletable, [ordinary]);
  assert.deepEqual(unavailable.protected, [malformed]);

  const db = { sfsTargetCandidate: { findMany: async () => [] } };
  const missing = await partitionAutomationDeliveryHardDeleteCandidates({ db, rows: [follow(), malformed, ordinary] });
  assert.deepEqual(missing.deletable.map((row) => row.id), ["follow-1", "ordinary"]);
  assert.deepEqual(missing.protected.map((row) => row.id), ["malformed"]);
});

