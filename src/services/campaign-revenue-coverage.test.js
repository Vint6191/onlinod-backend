"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { campaignRevenueCoverage } = require("./campaign-revenue-coverage");
const { metricsDto } = require("./campaign-read-repository");
const { displayRangeBounds } = require("./analytics-range-contract");
const now = new Date("2026-10-16T00:00:00Z"), day = 86400000;
const campaigns = { proven: true, providerFresh: true };
const baseline = {
  status: "COMPLETE", baselineVerifiedAt: now, baselineObservedAt: now,
  baselineRangeFrom: new Date("2016-01-01Z"), baselineRangeTo: now,
  receiptCoverageVersion: 1, coverageThrough: now, recentRangeFrom: new Date(+now - 7*day), recentRangeTo: now,
  historyAuditObservedAt: now,
};
const coverage = (state, range = "30d", membership = campaigns) => campaignRevenueCoverage(state, membership, displayRangeBounds(range, now), now);

test("local projection completion cannot turn missing financial or membership coverage into zero", () => {
  for (const state of [null, { status: "RUNNING" }, { ...baseline, baselineVerifiedAt: null }]) {
    const proof = coverage(state);
    assert.equal(proof.ready, false); assert.equal(proof.reason, "FINANCIAL_BASELINE_MISSING");
    const metrics = metricsDto({ knownNetCents: "1250", platformReportedFanSpendCents: "9999" }, true, proof.ready);
    assert.equal(metrics.netCents, null); assert.equal(metrics.payingFans, null); assert.equal(metrics.knownNetCents, 1250);
  }
  assert.equal(coverage(baseline, "30d", { proven: false }).reason, "CAMPAIGN_MEMBERSHIP_MISSING");
});

test("a new head after 90 days offline proves seven days but cannot conceal the remaining historical gap", () => {
  const state = { ...baseline, baselineRangeTo: new Date(+now - 90*day), coverageThrough: new Date(+now - 60*day) };
  assert.equal(coverage(state, "7d").ready, true);
  assert.equal(coverage(state, "30d").ready, false);
  assert.equal(coverage(state, "90d").reason, "FINANCIAL_RANGE_GAP");
  assert.equal(coverage({ ...state, coverageThrough: state.recentRangeFrom }, "90d").ready, true);
});

test("verified zero survives refresh failure and stale history is visible as of its real source boundary", () => {
  const state = { ...baseline, status: "RUNNING", baselineObservedAt: new Date(+now - 2*day), historyAuditObservedAt: new Date(+now - 8*day) };
  const proof = coverage(state);
  assert.equal(proof.ready, true); assert.equal(proof.fresh, false); assert.equal(proof.status, "STALE");
  assert.equal(proof.asOf, now.toISOString());
  assert.equal(metricsDto({}, true, proof.ready).netCents, 0);
  assert.equal(coverage({ ...state, status: "FAILED" }).ready, true);
});

test("missing arrival or NET preserves partial sums and does not hide independent current fan value", () => {
  const row = metricsDto({ knownNetCents: "1000", unknownAttributionFans: "1", payingFans: "2", knownPlatformReportedFanSpendCents: "4500" }, true, true);
  assert.equal(row.netCents, null); assert.equal(row.payingFans, null); assert.equal(row.knownNetCents, 1000);
  assert.equal(row.platformReportedFanSpendCents, 4500);
  assert.equal(metricsDto({ knownPlatformReportedFanSpendCents: "4500" }, true, false).platformReportedFanSpendCents, 4500);
  assert.equal(metricsDto({ knownNetCents: "1000", unknownNetTransactions: "1" }, true, true).netCents, null);
});
