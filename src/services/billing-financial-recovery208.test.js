"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const recovery = require("./billing-financial-recovery-service");
const receipts = require("./financial-receipt-authority");
const { assertRecoveryPhysicalRequest } = require("./billing-execution-access-service");
const now = new Date("2026-11-27T12:00:00.000Z");
const params = {
  billingRecoveryVersion: 1, financialReceiptVersion: 1, financialTraversalVersion: 2,
  collectionContractVersion: 1, collectionType: "FINANCIAL", collectionMode: "catchup",
  collectionGeneration: "recovery", collectionRequestedAt: now.toISOString(),
  analyticsContractVersion: 1, sourceTimezone: "UTC", scanFrom: "2026-10-28", scanTo: "2026-11-26",
  startDate: "2026-10-28T00:00:00.000Z", endDate: "2026-11-26T23:59:59.000Z",
};

test("expired recovery proves exactly its closed pricing month and cannot masquerade as full history", () => {
  assert.equal(recovery.windowValid(params, now), true);
  const windows = receipts.planWindows(params, null);
  assert.equal(windows.length, 1); assert.equal(windows[0].kind, "BILLING");
  assert.equal(windows[0].from, params.startDate); assert.equal(windows[0].to, params.endDate);
  assert.equal(receipts.historyRead({ windows, proof: { windows: [{ exhausted: true }] } }), false);
  for (const patch of [
    { collectionMode: "full" }, { financialTraversalVersion: 1 }, { financialReceiptVersion: 0 },
    { startDate: "2016-01-01T00:00:00.000Z" }, { endDate: now.toISOString() },
    { scanTo: "2026-11-27" }, { scanFrom: "2026-10-27" }, { sourceTimezone: "Europe/Kyiv" },
  ]) assert.equal(recovery.windowValid({ ...params, ...patch }, now), false, JSON.stringify(patch));
  assert.equal(recovery.windowValid(params, new Date(+now + 2 * 86400000)), false);
});

test("unpaid financial permits require the current server marker, exact endpoint and receipt phase", () => {
  const job = { params, continuation: { jobContinuation: { phase: "transactions", windowIndex: 0, marker: "opaque:2" } } };
  const path = "/api2/v2/payouts/transactions?startDate=2026-10-28%2000:00:00&marker=opaque%3A2";
  const input = { job, operation: "payouts.transactions", financial: true, physicalRequest: { method: "GET", path } };
  assert.doesNotThrow(() => assertRecoveryPhysicalRequest(input));
  for (const patch of [
    { physicalRequest: { method: "POST", path } },
    { physicalRequest: { method: "GET", path: path.replace("opaque%3A2", "stale") } },
    { physicalRequest: { method: "GET", path: path + "&marker=forged" } },
    { physicalRequest: { method: "GET", path: path + "&all=true" } },
    { physicalRequest: { method: "GET", path: path.replace("2026-10-28", "2016-01-01") } },
    { physicalRequest: { method: "GET", path: "//elsewhere.test" + path } },
    { financial: false }, { operation: "chats.list" },
    { job: { ...job, continuation: { jobContinuation: { phase: "charts", windowIndex: 0, marker: "opaque:2" } } } },
  ]) assert.throws(() => assertRecoveryPhysicalRequest({ ...input, ...patch }), { code: "BILLING_RECOVERY_ENDPOINT_MISMATCH" });
  const chart = { ...input, operation: "earnings.chart", physicalRequest: {
    method: "GET", path: "/api2/v2/earnings/chart?startDate=2026-10-28%2000:00:00&endDate=2026-11-26%2023:59:59&withTotal=true",
  } };
  assert.throws(() => assertRecoveryPhysicalRequest(chart), { code: "BILLING_RECOVERY_ENDPOINT_MISMATCH" });
  job.continuation.jobContinuation.phase = "charts";
  assert.doesNotThrow(() => assertRecoveryPhysicalRequest(chart));
});
