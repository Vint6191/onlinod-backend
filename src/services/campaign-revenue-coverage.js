"use strict";

const financialAuthority = require("./financial-receipt-authority");
const { FINANCIAL_COLLECTION_FRESHNESS_MS } = require("./analytics-freshness-policy");

// Projection completion only proves that saved facts were processed. Money
// needs independent evidence that the provider range and memberships exist.
// Freshness expiry does not erase a verified subtotal while catch-up runs.
function campaignRevenueCoverage(financial, campaigns, bounds, now) {
  const state = financialAuthority.evaluateCollection(financial, now, FINANCIAL_COLLECTION_FRESHNESS_MS);
  const date = financialAuthority.date;
  const intervals = [];
  function add(from, to) {
    from = date(from); to = date(to);
    if (from && to && from <= to && to <= now) intervals.push({ from, to });
  }
  if (state.proven) {
    add(financial.baselineRangeFrom, financial.coverageThrough || financial.baselineRangeTo);
    if (financial.receiptCoverageVersion === 1) add(financial.recentRangeFrom, financial.recentRangeTo);
  }
  intervals.sort((a, b) => +a.from - b.from);
  const merged = [];
  for (const interval of intervals) {
    const tail = merged.at(-1);
    if (tail && interval.from <= tail.to) tail.to = new Date(Math.max(+tail.to, +interval.to));
    else merged.push({ ...interval });
  }
  const asOf = merged.at(-1)?.to || null;
  const covered = Boolean(asOf && asOf >= bounds.startAt
    && merged.some(interval => interval.from <= bounds.startAt && interval.to >= asOf));
  const ready = Boolean(state.proven && covered && campaigns.proven);
  const fresh = ready && state.fresh && campaigns.providerFresh;
  return {
    authority: "VERIFIED_FINANCIAL_RANGE_AND_MEMBERSHIPS", ready, fresh,
    status: !ready ? "PENDING" : fresh ? "READY" : "STALE",
    reason: !state.proven ? "FINANCIAL_BASELINE_MISSING" : !covered ? "FINANCIAL_RANGE_GAP"
      : !campaigns.proven ? "CAMPAIGN_MEMBERSHIP_MISSING" : fresh ? "VERIFIED" : "REFRESH_DUE",
    asOf: asOf?.toISOString() || null,
    rangeStartAt: bounds.startAt.toISOString(),
  };
}

module.exports = { campaignRevenueCoverage };
