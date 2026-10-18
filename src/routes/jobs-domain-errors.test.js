"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const financial = require("../services/financial-receipt-authority");
const notification = require("../services/notification-frontier-authority");
const leaseService = require("../services/job-lease-service");
const { JobLeaseError } = leaseService;

// Exercise the actual authority error producers and HTTP serializer. Only the
// database/lease dispatch is replaced; this test does not claim SQL coverage.
let progressAction;
const inject = (id, exports) => {
  const filename = require.resolve(id);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
inject("../services/job-lease-service", {
  ...leaseService,
  progressJob: async input => progressAction(input),
});
inject("../middleware/auth", { requireAuthDevice() {} });
delete require.cache[require.resolve("./jobs")];
const router = require("./jobs");

function financialConflict() {
  const job = {
    id: "financial-job", jobKey: "financial_transactions_scan", agencyId: "agency", creatorId: "creator",
    params: {
      financialReceiptVersion: 1, collectionMode: "full", collectionGeneration: "financial-generation",
      financialWindowGeneration: "financial-generation", endDate: "2026-10-17T12:00:00.000Z",
    },
  };
  job.params.financialWindows = financial.planWindows(job.params, null);
  const row = {
    id: financial.runId(job), agencyId: job.agencyId, creatorId: job.creatorId,
    generation: job.params.collectionGeneration, windows: job.params.financialWindows,
    cursor: financial.initialCursor(job),
  };
  const db = {
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [{ id: row.id }],
    financialReceiptRun: { upsert: async () => row, findUnique: async () => row },
    financialPageReceipt: { findUnique: async () => ({ payloadHash: "a-different-committed-page" }) },
  };
  const chunk = {
    kind: "financial_transactions_page", collectorVersion: financial.COLLECTOR,
    scanRunId: row.generation, windowIndex: 0, pageNumber: 1,
    markerStart: row.cursor.marker, markerEnd: null, rawReceived: 0,
    scannerRejected: 0, duplicateRows: 0, sourceHasMore: false, transactions: [],
  };
  return { chunk, run: input => financial.beforePage(db, job, input.chunkResult) };
}

function notificationConflict({ replay = false } = {}) {
  const job = {
    agencyId: "agency", creatorId: "creator",
    params: { notificationMode: "catchup", notificationFrontierVersion: 2, collectionGeneration: "notification-generation" },
  };
  const db = {
    $queryRawUnsafe: async () => replay ? [{ digest: "a-different-committed-page" }] : [],
    $executeRawUnsafe: async () => { assert.fail("A rejected notification page must not be inserted"); },
  };
  const chunk = {
    kind: "notifications_page", page: replay ? 1 : 2, cursorStart: null, cursorEnd: null,
    sourcePhase: "all", sourceHasMore: false, sourceExhausted: true,
    stopReason: "source_exhausted", observations: [],
  };
  return { chunk, run: input => notification.commitPage(db, job, input.chunkResult, null) };
}

test("job progress HTTP preserves domain retry policy, lease ownership and unexpected failures", async t => {
  const failures = [];
  const unhandled = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { userId: "user" }; next(); });
  app.use("/jobs", router);
  app.use((error, _req, res, _next) => {
    unhandled.push(error);
    res.status(500).json({ ok: false, code: "SERVER_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function post(action, chunkResult) {
    progressAction = action;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/jobs/job/progress`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device", leaseToken: "fixture-token-long-enough", leaseRevision: 1, chunkResult,
      }),
    });
    const wire = { status: response.status, payload: await response.json(), retryAfter: response.headers.get("Retry-After") };
    failures.push(wire);
    return wire;
  }
  const reject = error => async () => { throw error; };

  await t.test("financial beforePage immutable payload conflict is explicitly terminal", async () => {
    const fixture = financialConflict();
    const wire = await post(fixture.run, fixture.chunk);
    assert.equal(wire.status, 409);
    assert.deepEqual(wire.payload, {
      ok: false, code: "FINANCIAL_RECEIPT_PAYLOAD_CONFLICT", error: "FINANCIAL_RECEIPT_PAYLOAD_CONFLICT", retryable: false,
    });
    assert.equal(wire.retryAfter, null);
  });

  for (const [replay, code] of [[false, "NOTIFICATION_FRONTIER_CURSOR_MISMATCH"], [true, "NOTIFICATION_FRONTIER_PAYLOAD_CONFLICT"]]) {
    await t.test(`real notification frontier rejection ${code} is explicitly terminal`, async () => {
      const fixture = notificationConflict({ replay });
      const wire = await post(fixture.run, fixture.chunk);
      assert.equal(wire.status, 409);
      assert.deepEqual(wire.payload, { ok: false, code, error: code, retryable: false });
      assert.equal(wire.retryAfter, null);
    });
  }

  await t.test("lease busy remains retryable with its bounded Retry-After", async () => {
    const error = Object.assign(new JobLeaseError("JOB_LEASE_BUSY", "Job update is busy; retry the same lease mutation", 503), {
      retryable: true, retryAfterMs: 1000,
    });
    const wire = await post(reject(error));
    assert.deepEqual(wire, {
      status: 503, retryAfter: "1",
      payload: { ok: false, code: error.code, error: error.message, retryable: true, retryAfterMs: 1000 },
    });
  });

  await t.test("explicit retry policy is independent of scheduling metadata and never coerced", async () => {
    const retryable = Object.assign(new JobLeaseError("TEMPORARY_DOMAIN_UNAVAILABLE", "Temporary unavailability", 503), { retryable: true });
    let wire = await post(reject(retryable));
    assert.equal(wire.status, 503);
    assert.equal(wire.payload.retryable, true);
    assert.equal(wire.retryAfter, null);
    assert.equal(Object.hasOwn(wire.payload, "retryAfterMs"), false);
    const malformed = Object.assign(new JobLeaseError("DOMAIN_RETRY_POLICY_UNSPECIFIED", "No boolean retry policy"), { retryable: "false" });
    wire = await post(reject(malformed));
    assert.equal(wire.status, 409);
    assert.equal(Object.hasOwn(wire.payload, "retryable"), false);
    const scheduled = Object.assign(new JobLeaseError("FAN_OBSERVATION_READ_LEASE_BUSY", "Observation read is busy"), { retryAfterMs: 1250 });
    wire = await post(reject(scheduled));
    assert.equal(wire.retryAfter, "2");
    assert.equal(wire.payload.retryAfterMs, 1250);
    assert.equal(wire.payload.retryable, false);
  });

  await t.test("ownership failures retain their original status and code without a fabricated domain retry policy", async () => {
    for (const code of ["JOB_NOT_FOUND", "JOB_NOT_CLAIMED", "JOB_CLAIMED_BY_OTHER", "JOB_LEASE_STALE", "JOB_LEASE_REVISION_STALE", "JOB_LEASE_EXPIRED", "JOB_LEASE_CONFLICT", "JOB_SUPERSEDED"]) {
      const error = new JobLeaseError(code, "Lease is no longer current", code === "JOB_NOT_FOUND" ? 404 : 409);
      const wire = await post(reject(error));
      assert.equal(wire.status, error.status);
      assert.deepEqual(wire.payload, { ok: false, code, error: error.message });
      assert.equal(wire.retryAfter, null);
    }
  });

  await t.test("unexpected SQL failure still reaches the 500 handler without exposing details", async () => {
    const error = Object.assign(new Error("private SQL details"), { code: "P2010", retryable: false });
    const wire = await post(reject(error));
    assert.equal(wire.status, 500);
    assert.deepEqual(wire.payload, { ok: false, code: "SERVER_ERROR" });
    assert.deepEqual(unhandled, [error]);
  });

  if (process.env.ONLINOD_JOB_ERROR_EVIDENCE) {
    const filename = path.resolve(process.env.ONLINOD_JOB_ERROR_EVIDENCE);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify({ failures }, null, 2) + "\n");
  }
});
