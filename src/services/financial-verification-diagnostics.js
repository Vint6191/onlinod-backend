"use strict";

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = value => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const KINDS = new Set(["FULL", "HEAD", "GAP", "AUDIT", "FRONTIER", "RESOLUTION"]);
const REJECTION_REASONS = ["SCANNER_REJECTED", "transaction_id_missing", "transaction_type_missing", "occurred_at_invalid",
  "amount_invalid", "currency_invalid", "EXACT_FINANCIAL_MONEY_REQUIRED", "OUTSIDE_REQUESTED_FINANCIAL_WINDOW"];

// Reads the existing bounded completion proof, including pre-diagnostic failed
// jobs. Never forwards profile values, descriptions, payloads or transaction IDs.
function financialVerificationDiagnostics(value) {
  const source = object(value);
  if (source.type !== "financial_transactions" || typeof source.ok !== "boolean") return null;
  const reconciliation = object(source.reconciliation);
  const reasons = new Set();
  const reject = (condition, reason) => { if (!source.ok && condition) reasons.add(reason); };
  reject(source.protocolCurrent === false, "FINANCIAL_RECEIPT_PROTOCOL_REQUIRED");
  reject(source.sourceBoundaryReached === false, "FINANCIAL_SOURCE_BOUNDARY_NOT_REACHED");
  reject(number(source.scannerRejected) > 0, "FINANCIAL_SOURCE_ROWS_REJECTED");
  reject(source.staleGeneration === true, "FINANCIAL_GENERATION_SUPERSEDED");
  const windows = (Array.isArray(source.windows) ? source.windows : []).slice(0, 2).map((value, index) => {
    const row = object(value), chart = object(object(row.charts).total), undo = object(object(row.statusGroups).undo);
    const gross = number(row.grossCents), net = number(row.netCents), count = number(row.count);
    const countUndo = number(object(undo._count)._all) ?? 0;
    const grossUndo = number(object(undo._sum).amountCents) ?? 0, netUndo = number(object(undo._sum).netCents) ?? 0;
    const observed = { count: count === null ? null : count - countUndo,
      grossCents: gross === null ? null : gross - grossUndo, netCents: net === null ? null : net - netUndo };
    const expected = { count: number(chart.transactionsCount), grossCents: number(chart.grossCents), netCents: number(chart.netCents) };
    const chartRequired = row.kind !== "FRONTIER";
    const chartPresent = Object.keys(chart).length > 0;
    reject(number(row.rejected) > 0, "FINANCIAL_SOURCE_ROWS_REJECTED");
    reject(chartRequired && row.exhausted === false, "FINANCIAL_SOURCE_BOUNDARY_NOT_REACHED");
    reject(chartRequired && !chartPresent, "FINANCIAL_CHART_RECEIPT_MISSING");
    for (const [key, reason] of [["count", "FINANCIAL_CHART_COUNT_MISMATCH"], ["grossCents", "FINANCIAL_CHART_GROSS_MISMATCH"], ["netCents", "FINANCIAL_CHART_NET_MISMATCH"]])
      reject(chartRequired && chartPresent && observed[key] !== null && expected[key] !== null && observed[key] !== expected[key], reason);
    return { index, kind: KINDS.has(row.kind) ? row.kind : null, fromAt: iso(row.from), toAt: iso(row.to),
      pages: number(row.pages), received: number(row.received), rejected: number(row.rejected), exhausted: bool(row.exhausted),
      rejectionReasons: Object.fromEntries(REJECTION_REASONS.filter(key => number(object(row.rejectionReasons)[key]) > 0)
        .map(key => [key, number(row.rejectionReasons[key])])),
      matched: bool(row.matched), chartPresent, observed, expected,
      boundaryPage: number(row.boundaryPage), overlapPage: number(row.overlapPage) };
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
    scannerRejected: number(source.scannerRejected), staleGeneration: bool(source.staleGeneration),
    proofKind: ["FRONTIER_PLUS_ONE", "EXHAUSTED_WINDOW_AND_CHART"].includes(reconciliation.proofKind) ? reconciliation.proofKind : null,
    chartReady: bool(reconciliation.chartReady), countMatched: bool(reconciliation.countMatched),
    grossMatched: bool(reconciliation.grossMatched), netMatched: bool(reconciliation.netMatched), windows };
}
module.exports = { financialVerificationDiagnostics };
