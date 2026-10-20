"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { financialVerificationDiagnostics: describe } = require("./financial-verification-diagnostics");
const window = { kind: "RESOLUTION", from: "2026-10-17T13:00:00Z", to: "2026-10-17T14:00:00Z",
  pages: 1, received: 2, rejected: 0, exhausted: true, matched: false, count: 2, grossCents: 1000, netCents: 800,
  charts: { total: { transactionsCount: 3, grossCents: 2000, netCents: 1600 } } };
test("old stored completion proof exposes count/gross/net mismatch with no new scan", () => {
  const result = describe({ type: "financial_transactions", ok: false, protocolCurrent: true,
    sourceBoundaryReached: true, scannerRejected: 0, windows: [window],
    reconciliation: { proofKind: "EXHAUSTED_WINDOW_AND_CHART", chartReady: true, countMatched: false, grossMatched: false, netMatched: false } });
  assert.deepEqual(result.reasons, ["FINANCIAL_CHART_COUNT_MISMATCH", "FINANCIAL_CHART_GROSS_MISMATCH", "FINANCIAL_CHART_NET_MISMATCH"]);
  assert.deepEqual(result.windows[0].observed, { count: 2, grossCents: 1000, netCents: 800 });
  assert.deepEqual(result.windows[0].expected, { count: 3, grossCents: 2000, netCents: 1600 });
});
test("comparison excludes undo rows; successful proof never receives a false rejection reason", () => {
  const row = { ...window, count: 3, grossCents: 4000, netCents: 3200, matched: true,
    statusGroups: { undo: { _count: { _all: 1 }, _sum: { amountCents: 2000, netCents: 1600 } } },
    charts: { total: { transactionsCount: 2, grossCents: 2000, netCents: 1600 } } };
  const failed = describe({ type: "financial_transactions", ok: false, windows: [row] });
  assert.deepEqual(failed.reasons, ["FINANCIAL_RECEIPT_INCOMPLETE"]);
  assert.deepEqual(describe({ type: "financial_transactions", ok: true, windows: [row] }).reasons, []);
});
test("diagnostic is bounded, rejects unsafe scalars, and forwards only server rejection codes", () => {
  const secret = "private-provider-value";
  const result = describe({ type: "financial_transactions", ok: false, raw: secret, deviceId: secret,
    scannerRejected: "1", windows: Array.from({ length: 5 }, () => ({ ...window, description: secret,
      kind: secret, from: secret, page: secret, count: Number.MAX_SAFE_INTEGER + 1, rejected: 1,
      rejectionReasons: { [secret]: 1, SCANNER_REJECTED: 2, EXACT_FINANCIAL_MONEY_REQUIRED: 1, currency_invalid: secret } })) });
  assert.equal(result.windows.length, 2); assert.equal(result.scannerRejected, null);
  assert.equal(result.windows[0].kind, null); assert.equal(result.windows[0].observed.count, null);
  assert.deepEqual(result.windows[0].rejectionReasons, { SCANNER_REJECTED: 2, EXACT_FINANCIAL_MONEY_REQUIRED: 1 });
  assert(!JSON.stringify(result).includes(secret));
  assert(result.reasons.includes("FINANCIAL_SOURCE_ROWS_REJECTED"));
});
test("frontier proof does not require a chart; unsupported records remain unavailable", () => {
  const result = describe({ type: "financial_transactions", ok: false, windows: [{ ...window, kind: "FRONTIER", charts: {}, exhausted: false }],
    reconciliation: { proofKind: "FRONTIER_PLUS_ONE", chartReady: false } });
  assert.deepEqual(result.reasons, ["FINANCIAL_RECEIPT_INCOMPLETE"]);
  for (const input of [null, {}, { type: "campaigns", ok: false }, { type: "financial_transactions", ok: "true" }]) assert.equal(describe(input), null);
});
