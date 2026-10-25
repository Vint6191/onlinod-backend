"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const receipts = require("./financial-receipt-authority");

// Coordinates from the 2026-10-25 recovery snapshot: the previous catchup
// failed, then a new offline episode began three days after the last proof.
const through = "2026-10-20T19:09:42.000Z";
const nextGap = "2026-10-23T20:55:30.628Z";
const target = "2026-10-25T14:49:22.000Z";
const requestedAt = "2026-10-25T14:50:36.842Z";
function state(patch = {}) {
  return { creatorId: "creator", status: "FAILED", baselineGeneration: "baseline",
    baselineVerifiedAt: new Date("2026-10-17T15:16:50.249Z"), baselineRangeTo: new Date("2026-10-17T15:16:40Z"),
    lastCatchupGeneration: "last-verified-catchup", lastCatchupCompletedAt: new Date("2026-10-20T19:09:52.779Z"),
    receiptCoverageVersion: 1, coverageThrough: new Date(through), recentRangeTo: new Date(through), ...patch };
}
function job(bound = false) {
  const result = { id: "new-offline-job", jobKey: "financial_transactions_scan", agencyId: "agency", creatorId: "creator", status: "SCHEDULED",
    params: { collectionContractVersion: 1, collectionType: "FINANCIAL", collectionMode: "catchup",
      collectionGeneration: "new-offline-generation", collectionRequestedAt: requestedAt,
      endDate: target, financialFrontierVersion: 2, recoveryGapFrom: nextGap } };
  if (bound) Object.assign(result.params, { financialReceiptVersion: 1, financialTraversalVersion: 2,
    financialWindowGeneration: result.params.collectionGeneration, financialFrontierKnownBefore: requestedAt,
    financialFrontierGapFrom: nextGap, financialFrontierBaselineGeneration: "last-verified-catchup",
    financialWindows: [{ kind: "FRONTIER", from: null, to: target,
      initialMarker: String(Date.parse(target) / 1000), comparisonFrom: "2026-10-23T20:55:30.000Z" }] });
  return result;
}
function row(j) {
  return { id: receipts.runId(j), jobId: j.id, generation: j.params.collectionGeneration, agencyId: j.agencyId, creatorId: j.creatorId,
    windows: structuredClone(j.params.financialWindows), cursor: { phase: "done" },
    proof: { complete: true, traversalComplete: true, kind: "FRONTIER_PLUS_TWO_AND_CHART",
      windows: [{ comparisonFrom: j.params.financialWindows[0].comparisonFrom, traversalComplete: true, matched: true }] } };
}
function db(current, receipt = null) {
  return { creatorFinancialCollectionState: { findUnique: async () => current }, financialReceiptRun: { findUnique: async () => receipt } };
}

test("a new offline episode re-proves from the last continuous financial boundary after a failed catchup", async () => {
  const pending = job(), before = structuredClone(pending), current = state();
  const planned = receipts.planWindows({ ...pending.params, financialTraversalVersion: 2 }, current);
  assert.equal(planned[0].comparisonFrom, through);
  const params = await receipts.claimParams(db(current), pending);
  assert.equal(params.financialFrontierGapFrom, through);
  assert.equal(params.financialWindows[0].comparisonFrom, through);
  assert.equal(params.recoveryGapFrom, nextGap);
  assert.equal(params.collectionGeneration, pending.params.collectionGeneration);
  assert.deepEqual(pending, before);
});

test("a pending command without a receipt widens on claim, preserves identity and restores the correct first cursor", async () => {
  const pending = job(true), original = structuredClone(pending.params), current = state();
  const params = await receipts.claimParams(db(current), pending);
  assert.equal(params.financialWindows[0].comparisonFrom, through);
  assert.equal(params.financialFrontierGapFrom, through);
  for (const key of ["collectionGeneration", "collectionRequestedAt", "financialWindowGeneration", "financialFrontierKnownBefore", "endDate"])
    assert.equal(params[key], original[key]);
  const restored = await receipts.restoreContinuation(db(current), { ...pending, params });
  assert.equal(restored.jobContinuation.comparisonFrom, through);
  assert.equal(restored.jobContinuation.page, 0);
  assert.deepEqual(pending.params, original);
});

test("a narrower immutable receipt stays inspectable but cannot close the unverified three-day interval", async () => {
  const pending = job(true), saved = row(pending), before = structuredClone(saved), current = state();
  const params = await receipts.claimParams(db(current, saved), pending);
  assert.equal(params, pending.params);
  const proof = await receipts.completionProof(db(current, saved), pending);
  assert.equal(proof.complete, false);
  assert.equal(proof.unavailableReason, "FINANCIAL_FRONTIER_COVERAGE_GAP");
  assert.equal(proof.row, saved);
  assert.deepEqual(saved, before);
  assert.throws(() => receipts.coverageUpdate(pending, current, saved, new Date(target), new Date()), error =>
    error.code === "FINANCIAL_FRONTIER_COVERAGE_GAP" && error.retryable === false);
  assert.equal(current.coverageThrough.toISOString(), through);
  const diagnostic = require("./financial-verification-diagnostics").financialVerificationDiagnostics({
    type: "financial_transactions", ok: false, error: proof.unavailableReason, verification: "UNAVAILABLE", windows: [] });
  assert.equal(diagnostic.reasons[0], "FINANCIAL_FRONTIER_COVERAGE_GAP");
});

test("claim repair can widen a pending comparison but never narrows its existing scope", async () => {
  const pending = job(true);
  pending.params.financialWindows[0].comparisonFrom = "2026-10-19T00:00:00.000Z";
  assert.equal(await receipts.claimParams(db(state()), pending), pending.params);
});

test("an earlier proven boundary does not make a future recovery gap a valid command", () => {
  const pending = job(true);
  for (const field of ["financialFrontierGapFrom", "recoveryGapFrom"]) {
    const params = { ...pending.params, [field]: "2026-10-26T00:00:00.000Z" };
    if (field === "recoveryGapFrom") delete params.financialFrontierGapFrom;
    assert.throws(() => receipts.planWindows(params, state()), error =>
      error.code === "FINANCIAL_FRONTIER_BINDING_INVALID" && receipts.invalidClaim(error));
  }
});

test("a continuous wider receipt advances coverage, while the original chart mismatch remains rejected", async () => {
  const pending = job(true), current = state();
  pending.params.financialWindows[0].comparisonFrom = through;
  const saved = row(pending);
  assert.equal((await receipts.completionProof(db(current, saved), pending)).complete, true);
  const next = receipts.coverageUpdate(pending, current, saved, new Date(target), new Date());
  assert.equal(next.coverageThrough.toISOString(), target);
  assert.equal(receipts.coverageView(next).continuous, true);
  saved.proof.complete = false;
  Object.assign(saved.proof.windows[0], { count: 2, grossCents: 2300, netCents: 1840, matched: false,
    charts: { total: { transactionsCount: 3, grossCents: 2600, netCents: 2080 } } });
  assert.equal((await receipts.completionProof(db(current, saved), pending)).complete, false);
  assert.deepEqual(saved.proof.windows[0].charts.total, { transactionsCount: 3, grossCents: 2600, netCents: 2080 });
});

test("a baseline fallback or earlier recovery gap widens the proof; no proven boundary cannot certify continuity", async () => {
  const pending = job(true), baseline = state({ coverageThrough: null });
  const params = await receipts.claimParams(db(baseline), pending);
  assert.equal(params.financialWindows[0].comparisonFrom, baseline.baselineRangeTo.toISOString());
  const earlier = "2026-10-19T01:02:03.987Z";
  const planned = receipts.planWindows({ ...pending.params, financialFrontierGapFrom: earlier }, state());
  assert.equal(planned[0].comparisonFrom, "2026-10-19T01:02:03.000Z");
  const saved = row(pending);
  assert.equal((await receipts.completionProof(db(state({ coverageThrough: null, baselineRangeTo: null }), saved), pending)).complete, false);
});

test("full history and targeted resolution receipts retain their separate proof contracts", async () => {
  for (const kind of ["FULL", "RESOLUTION"]) {
    const pending = job(true), saved = row(pending);
    saved.windows[0] = { kind, from: kind === "FULL" ? null : "2026-10-25T14:00:00.000Z", to: target };
    saved.proof.windows[0].exhausted = true;
    const noCollectorRead = { financialReceiptRun: { findUnique: async () => saved } };
    assert.equal((await receipts.completionProof(noCollectorRead, pending)).complete, true);
  }
});
