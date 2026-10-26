"use strict";

// A zero baseline has no finite percentage increase. Signed NET can be negative
// after refunds: divide by its magnitude so a smaller loss is an improvement.
function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function revenueComparison(current, previous, ready) {
  const known = ready === true && Number.isSafeInteger(current) && Number.isSafeInteger(previous)
    && Number.isSafeInteger(current - previous);
  return {
    comparisonReady: known,
    previousRevenueCents: known ? previous : null,
    revenueDeltaCents: known ? current - previous : null,
    revenueDeltaPct: known ? percentChange(current, previous) : null,
  };
}

module.exports = { percentChange, revenueComparison };
