"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { selectDurableCollectionProof } = require("./analytics-freshness-policy");
const { evaluateDurableCollectorState, stateVocabulary } = require("./analytics-state-evaluator");
const { collectorPlanningProofAt, buildCollectionPlanningDedupeParams } = require("./analytics-collector-control-service");
const now = new Date("2026-10-01T12:00:00Z");
const hour = 3600000;
const ago = n => new Date(+now - n * hour);
const iso = value => value?.toISOString() || null;
const cases = [
  { name: "new full supersedes old catch-up", baseline: ago(0.5), head: ago(72), latest: ago(0.5), fresh: true },
  { name: "new catch-up refreshes old full", baseline: ago(72), head: ago(0.5), latest: ago(0.5), fresh: true },
  { name: "baseline alone proves recent completion", baseline: ago(0.5), head: null, latest: ago(0.5), fresh: true },
  { name: "catch-up alone cannot prove history", baseline: null, head: ago(0.5), latest: null, fresh: false },
  { name: "stale proofs remain stale", baseline: ago(96), head: ago(72), latest: ago(72), fresh: false },
  { name: "future catch-up cannot hide a valid recent full", baseline: ago(0.5), head: ago(-24), latest: ago(0.5), fresh: true },
  { name: "future full invalidates historical proof", baseline: ago(-24), head: ago(0.5), latest: null, fresh: false },
  { name: "invalid head falls back to proven full", baseline: ago(0.5), head: "bad-date", latest: ago(0.5), fresh: true },
  { name: "exact TTL boundary is still fresh", baseline: ago(72), head: ago(1), latest: ago(1), fresh: true },
];

for (const c of cases) test(c.name + ": readers and planning use the same proof", () => {
  const selected = selectDurableCollectionProof({ baselineVerifiedAt: c.baseline, catchupVerifiedAt: c.head, baselineObservedAt: c.baseline, catchupObservedAt: c.head, now });
  assert.equal(iso(selected.latestAt), iso(c.latest));
  const read = evaluateDurableCollectorState({ status: "COMPLETE", baselineVerifiedAt: c.baseline, lastVerifiedAt: c.head, baselineObservedAt: c.baseline, lastObservedAt: c.head, now, freshnessMs: hour });
  assert.equal(read.fresh, c.fresh);
  assert.equal(iso(read.lastVerifiedAt), iso(c.latest));
  for (const type of ["NOTIFICATIONS", "FINANCIAL", "CAMPAIGNS"]) {
    const state = type === "NOTIFICATIONS"
      ? { fullBackfillVerifiedAt: c.baseline, lastCatchupVerifiedAt: c.head, fullBackfillObservedAt: c.baseline, lastCatchupObservedAt: c.head }
      : { receiptCoverageVersion: 1, baselineVerifiedAt: c.baseline, lastCatchupCompletedAt: c.head, baselineObservedAt: c.baseline, lastCatchupObservedAt: c.head };
    state.activeGeneration = "server-generation";
    const before = JSON.stringify(state);
    assert.equal(iso(collectorPlanningProofAt(type, "catchup", state, now)), iso(c.latest));
    assert.equal(iso(collectorPlanningProofAt(type, "full", state, now)), iso(selected.baselineAt));
    const dedupe = buildCollectionPlanningDedupeParams({ collectorType: type, collectionMode: "catchup", state, now });
    assert.equal(dedupe.planningEpoch, "server-generation:" + (iso(c.latest) || "none"));
    assert.equal(JSON.stringify(state), before, "proof selection preserves full/catch-up provenance");
  }
});

test("unverified notification completion never becomes a planning proof", () => {
  const state = { fullBackfillVerifiedAt: ago(72), lastCatchupVerifiedAt: ago(48), fullBackfillObservedAt: ago(72), lastCatchupObservedAt: ago(48), lastCatchupCompletedAt: ago(0.1) };
  assert.equal(iso(collectorPlanningProofAt("NOTIFICATIONS", "catchup", state, now)), iso(ago(48)));
});

test("attempt failure, retry and partial baseline keep their authority", () => {
  const input = { baselineVerifiedAt: ago(72), lastVerifiedAt: ago(48), baselineObservedAt: ago(72), lastObservedAt: ago(48), now, freshnessMs: hour };
  const deferred = evaluateDurableCollectorState({ ...input, status: "FAILED", retryAfterAt: ago(-1) });
  assert.equal(stateVocabulary(deferred), "STALE_DEFERRED");
  assert.equal(deferred.due, false);
  const terminal = evaluateDurableCollectorState({ ...input, status: "FAILED" });
  assert.equal(terminal.due, false);
  assert.equal(stateVocabulary(terminal), "FAILED");
  const partial = evaluateDurableCollectorState({ status: "PARTIAL", baselineCompletedAt: ago(0.1), now, freshnessMs: hour });
  assert.equal(partial.proven, false);
  assert.equal(stateVocabulary(partial), "PARTIAL");
  assert.equal(evaluateDurableCollectorState({ ...input, status: "SCANNING" }).collecting, true);
});
