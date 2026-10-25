"use strict";

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = value => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const KINDS = new Set(["FULL", "HEAD", "GAP", "AUDIT", "FRONTIER", "RESOLUTION"]);
const REJECTION_REASONS = ["SCANNER_REJECTED", "transaction_id_missing", "transaction_type_missing", "occurred_at_invalid",
  "amount_invalid", "net_invalid", "currency_invalid", "EXACT_FINANCIAL_MONEY_REQUIRED", "OUTSIDE_REQUESTED_FINANCIAL_WINDOW"];

function rawTotals(value) {
  const row = object(value), count = number(row.count);
  return { count, grossCents: count === null || (row.grossKnown ?? count) !== count ? null : number(row.grossCents), netCents: number(row.netCents) };
}
function refundTotals(value) {
  const undo = object(object(object(value).statusGroups).undo), count = number(object(undo._count)._all) ?? 0;
  return { count, grossCents: (undo.grossKnown ?? count) !== count ? null : number(object(undo._sum).amountCents) ?? 0,
    netCents: number(object(undo._sum).netCents) ?? 0 };
}
function subtract(a, b) {
  return Object.fromEntries(["count", "grossCents", "netCents"].map(key => [key,
    a[key] === null || b[key] === null ? null : number(a[key] - b[key])]));
}

// Reads the existing bounded completion proof, including pre-diagnostic failed
// jobs. Never forwards profile values, descriptions, payloads or transaction IDs.
function financialVerificationDiagnostics(value) {
  const source = object(value);
  if (source.type !== "financial_transactions" || typeof source.ok !== "boolean") return null;
  const reconciliation = object(source.reconciliation);
  const reasons = new Set();
  const reject = (condition, reason) => { if (!source.ok && condition) reasons.add(reason); };
  reject(source.error === "FINANCIAL_LEGACY_FILTERED_HISTORY", "FINANCIAL_LEGACY_FILTERED_HISTORY");
  reject(source.error === "FINANCIAL_LEGACY_FRONTIER_INCOMPLETE", "FINANCIAL_LEGACY_FRONTIER_INCOMPLETE");
  reject(source.error === "FINANCIAL_FRONTIER_COVERAGE_GAP", "FINANCIAL_FRONTIER_COVERAGE_GAP");
  reject(source.protocolCurrent === false, "FINANCIAL_RECEIPT_PROTOCOL_REQUIRED");
  reject(source.sourceBoundaryReached === false && source.traversalComplete !== true, "FINANCIAL_SOURCE_BOUNDARY_NOT_REACHED");
  reject(source.verification === "UNAVAILABLE", "FINANCIAL_COMPARISON_SCOPE_UNAVAILABLE");
  reject(number(source.scannerRejected) > 0, "FINANCIAL_SOURCE_ROWS_REJECTED");
  reject(source.staleGeneration === true, "FINANCIAL_GENERATION_SUPERSEDED");
  const windows = (Array.isArray(source.windows) ? source.windows : []).slice(0, 2).map((value, index) => {
    const row = object(value), chart = object(object(row.charts).total);
    const comparison = row.comparisonTotals ? object(row.comparisonTotals) : row;
    const comparisonUndo = object(object(comparison.statusGroups).undo);
    const gross = number(comparison.grossCents), net = number(comparison.netCents), count = number(comparison.count);
    const countUndo = number(object(comparisonUndo._count)._all) ?? 0;
    const grossUndo = number(object(comparisonUndo._sum).amountCents) ?? 0, netUndo = number(object(comparisonUndo._sum).netCents) ?? 0;
    const observed = { count: count === null ? null : count - countUndo,
      grossCents: gross === null || (comparison.grossKnown ?? count) - (comparisonUndo.grossKnown ?? countUndo) !== count - countUndo ? null : gross - grossUndo, netCents: net === null ? null : net - netUndo };
    const expected = { count: number(chart.transactionsCount), grossCents: number(chart.grossCents), netCents: number(chart.netCents) };
    // These fixed-size aggregates also work for already-failed receipts. They
    // distinguish excluded overlap/history from refunds without logging rows,
    // transaction IDs or asking the provider for the same history again.
    const allObserved = rawTotals(row), comparedObserved = rawTotals(comparison);
    const chartRequired = row.kind !== "FRONTIER" || reconciliation.proofKind === "FRONTIER_PLUS_TWO_AND_CHART";
    const chartPresent = Object.keys(chart).length > 0;
    reject(number(row.rejected) > 0, "FINANCIAL_SOURCE_ROWS_REJECTED");
    reject(chartRequired && row.exhausted === false && row.traversalComplete !== true, "FINANCIAL_SOURCE_BOUNDARY_NOT_REACHED");
    reject(row.comparable === false, "FINANCIAL_COMPARISON_SCOPE_UNAVAILABLE");
    reject(chartRequired && !chartPresent, "FINANCIAL_CHART_RECEIPT_MISSING");
    for (const [key, reason] of [["count", "FINANCIAL_CHART_COUNT_MISMATCH"], ["grossCents", "FINANCIAL_CHART_GROSS_MISMATCH"], ["netCents", "FINANCIAL_CHART_NET_MISMATCH"]])
      reject(chartRequired && chartPresent && observed[key] !== null && expected[key] !== null && observed[key] !== expected[key], reason);
    return { index, kind: KINDS.has(row.kind) ? row.kind : null, fromAt: iso(row.from), toAt: iso(row.to),
      pages: number(row.pages), received: number(row.received), rejected: number(row.rejected), exhausted: bool(row.exhausted),
      rejectionReasons: Object.fromEntries(REJECTION_REASONS.filter(key => number(object(row.rejectionReasons)[key]) > 0)
        .map(key => [key, number(row.rejectionReasons[key])])),
      matched: bool(row.matched), chartPresent, comparable: bool(row.comparable),
      comparisonFromAt: iso(row.comparisonFrom || row.from), comparisonToAt: iso(row.comparisonTo || row.to), observed, expected,
      timeAuthority: "UTC", oldestObservedAt: iso(row.oldestAt), newestObservedAt: iso(row.newestAt),
      allObserved, comparedIncludingRefunds: comparedObserved, excludedBeforeComparison: subtract(allObserved, comparedObserved),
      comparedRefunds: refundTotals(comparison), expectedMinusObserved: subtract(expected, observed),
      boundaryPage: number(row.boundaryPage), overlapPage: number(row.overlapPage), overlapPages: number(row.overlapPages) };
  });
  if (reconciliation.proofKind !== "FRONTIER_PLUS_ONE") {
    reject(reconciliation.chartReady === false, "FINANCIAL_CHART_RECEIPT_MISSING");
    reject(reconciliation.chartReady === true && reconciliation.countMatched === false, "FINANCIAL_CHART_COUNT_MISMATCH");
    reject(reconciliation.chartReady === true && reconciliation.grossMatched === false, "FINANCIAL_CHART_GROSS_MISMATCH");
    reject(reconciliation.chartReady === true && reconciliation.netMatched === false, "FINANCIAL_CHART_NET_MISMATCH");
  }
  reject(!reasons.size, "FINANCIAL_RECEIPT_INCOMPLETE");
  return { version: 1, outcome: source.ok ? "VERIFIED" : "REJECTED", reasons: [...reasons],
    protocolCurrent: bool(source.protocolCurrent), sourceBoundaryReached: bool(source.sourceBoundaryReached),
    historyRead: bool(source.historyRead), traversalComplete: bool(source.traversalComplete),
    verification: ["PENDING", "UNAVAILABLE", "MISMATCH", "VERIFIED"].includes(source.verification) ? source.verification : null, published: bool(source.published),
    scannerRejected: number(source.scannerRejected), staleGeneration: bool(source.staleGeneration),
    proofKind: ["FRONTIER_PLUS_ONE", "FRONTIER_PLUS_TWO_AND_CHART", "EXHAUSTED_WINDOW_AND_CHART"].includes(reconciliation.proofKind) ? reconciliation.proofKind : null,
    chartReady: bool(reconciliation.chartReady), countMatched: bool(reconciliation.countMatched),
    grossMatched: bool(reconciliation.grossMatched), netMatched: bool(reconciliation.netMatched), windows };
}
module.exports = { financialVerificationDiagnostics };
