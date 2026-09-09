"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateCollectionState, evaluateAggregateCollectionState, evaluateDurableCollectorState, stateVocabulary } = require("./analytics-state-evaluator");

test("single collection state separates proven stale data from deferred retry", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const state = evaluateCollectionState({
    status: "COMPLETE",
    proofStatus: "COMMITTED",
    lastVerifiedAt: new Date("2026-09-01T14:00:00.000Z"),
    retryAfterAt: new Date("2026-09-08T15:00:00.000Z"),
    now,
    freshnessMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(state.complete, true);
  assert.equal(state.proven, true);
  assert.equal(state.usable, true);
  assert.equal(state.fresh, false);
  assert.equal(state.stale, true);
  assert.equal(state.deferred, true);
  assert.equal(stateVocabulary(state), "STALE_DEFERRED");
});

test("aggregate state keeps COMPLETE distinct from a proven usable partial current interval", () => {
  const state = evaluateAggregateCollectionState({
    expectedUnits: 7,
    completeUnits: 6,
    provenUsableUnits: 7,
    freshUsableUnits: 7,
    partialUnits: 1,
  });
  assert.equal(state.complete, false);
  assert.equal(state.partial, true);
  assert.equal(state.proven, true);
  assert.equal(state.usable, true);
  assert.equal(state.fresh, true);
  assert.equal(stateVocabulary(state), "FRESH");
});

test("aggregate state never calls incomplete or unproven evidence fresh", () => {
  const incomplete = evaluateAggregateCollectionState({ expectedUnits: 30, completeUnits: 29, provenUsableUnits: 29, freshUsableUnits: 29 });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.proven, false);
  assert.equal(incomplete.fresh, false);
  assert.equal(incomplete.partial, true);

  const unproven = evaluateAggregateCollectionState({ expectedUnits: 30, completeUnits: 30, provenUsableUnits: 29, freshUsableUnits: 29 });
  assert.equal(unproven.complete, true);
  assert.equal(unproven.proven, false);
  assert.equal(unproven.fresh, false);
  assert.equal(unproven.unavailable, false);
});


test("durable collector state keeps completed distinct from proven and exposes deferred retry", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const incompleteProof = evaluateDurableCollectorState({
    status: "PARTIAL",
    baselineCompletedAt: new Date("2026-09-08T10:00:00.000Z"),
    baselineVerifiedAt: null,
    now,
    freshnessMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(incompleteProof.complete, true);
  assert.equal(incompleteProof.proven, false);
  assert.equal(incompleteProof.fresh, false);
  assert.equal(stateVocabulary(incompleteProof), "PARTIAL");

  const deferred = evaluateDurableCollectorState({
    status: "FAILED",
    baselineCompletedAt: new Date("2026-09-01T10:00:00.000Z"),
    baselineVerifiedAt: new Date("2026-09-01T10:00:00.000Z"),
    lastVerifiedAt: new Date("2026-09-01T10:00:00.000Z"),
    retryAfterAt: new Date("2026-09-08T15:00:00.000Z"),
    now,
    freshnessMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(deferred.stale, true);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.failed, true);
  assert.equal(stateVocabulary(deferred), "STALE_DEFERRED");
});


test("future-poisoned durable baseline is not PROVEN or usable", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const poisoned = new Date("2026-09-09T14:00:00.000Z");
  const state = evaluateDurableCollectorState({
    status: "COMPLETE",
    baselineCompletedAt: poisoned,
    baselineVerifiedAt: poisoned,
    lastVerifiedAt: poisoned,
    now,
    freshnessMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(state.complete, true);
  assert.equal(state.proven, false);
  assert.equal(state.usable, false);
  assert.equal(state.fresh, false);
  assert.equal(state.partial, true);
  assert.equal(state.futurePoisoned, true);
  assert.equal(stateVocabulary(state), "PARTIAL");
});
