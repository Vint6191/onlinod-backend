"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { classifyCollectorReadFailure, collectionFailureRetry, retryDelay, MAX_RETRY_MS } = require("./collector-retry-policy");
const job = { id: "failed-job", agencyId: "agency", creatorId: "creator", jobKey: "financial_transactions_scan", attempts: 5 };
const message = "exact retained transport failure";
const failure = (code, status, extra = {}) => ({ code, status, method: "GET", retryable: true, message, ...extra });

test("only reviewed provider reads classify exact lease and structured transport interruptions", () => {
  for (const jobKey of ["catchup_notifications_scan", "financial_transactions_scan", "fetch_campaigns", "subscriber_directory_scan"]) {
    const source = { ...job, jobKey };
    assert.equal(classifyCollectorReadFailure({ job: source, error: "lease expired" }).code, "LEASE_EXPIRED");
    for (const [code, status] of [["SESSION_FETCH_TIMEOUT", 0], ["SESSION_FETCH_FAILED", 0],
      ["OF_REQUEST_FAILED", 408], ["OF_REQUEST_FAILED", 425], ["OF_REQUEST_FAILED", 429], ["OF_REQUEST_FAILED", 503]])
      assert.equal(classifyCollectorReadFailure({ job: source, error: message, failure: failure(code, status) }).waitingForSession, false);
    assert.equal(classifyCollectorReadFailure({ job: source, error: message,
      failure: failure("OF_REQUEST_FAILED", 401, { retryable: false }) }).waitingForSession, true);
  }
});

test("subscriber replacement GET 503 is recoverable with the same bounded retry delay", () => {
  const source = { ...job, jobKey: "subscriber_directory_scan", attempts: 100 };
  assert.deepEqual(classifyCollectorReadFailure({ job: source, error: message, failure: failure("OF_REQUEST_FAILED", 503) }),
    { code: "PROVIDER_HTTP_503", waitingForSession: false });
  assert.equal(retryDelay(source), MAX_RETRY_MS);
});

test("subscriber replacement schema error is not recoverable even when marked retryable", () => {
  const source = { ...job, jobKey: "subscriber_directory_scan" };
  assert.equal(classifyCollectorReadFailure({ job: source, error: message,
    failure: failure("SUBSCRIBER_SCHEMA_INVALID", 0) }), null);
});

test("contract errors, generic retryable flags, stale error metadata and write methods stay terminal", () => {
  for (const details of [failure("PROOF_INVALID", 0), failure("OF_REQUEST_FAILED", 403),
    failure("OF_REQUEST_FAILED", 503, { method: "POST" }), failure("SESSION_FETCH_FAILED", null),
    failure("OF_REQUEST_FAILED", 503.5), failure("SESSION_FETCH_FAILED", "0"),
    failure("SESSION_FETCH_FAILED", 0, { message: "previous attempt" }),
    failure("SESSION_FETCH_FAILED", 0, { retryable: false })])
    assert.equal(classifyCollectorReadFailure({ job, error: message, failure: details }), null);
  assert.equal(classifyCollectorReadFailure({ job, error: "provider network timeout; lease expired" }), null);
  assert.equal(classifyCollectorReadFailure({ job: { ...job, jobKey: "send_message" }, error: "lease expired" }), null);
  assert.equal(classifyCollectorReadFailure({ job: { ...job, params: { moneyResolutionVersion: 1 } }, error: "lease expired" }), null);
});

test("new failures use the current exact failed job and bound generation backoff to fifteen minutes", async () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const current = { ...job, status: "FAILED", lastError: message, result: { failure: failure("SESSION_FETCH_FAILED", 0) } };
  const classify = source => collectionFailureRetry({ db: { jobInstance: { findUnique: async () => source } }, job, error: message, terminal: true, now });
  const result = await classify(current);
  assert.equal(+result.retryAt - +now, MAX_RETRY_MS);
  for (const source of [{ ...current, creatorId: "other" }, { ...current, agencyId: "other" },
    { ...current, status: "CLAIMED" }, { ...current, lastError: "previous attempt" },
    { ...current, id: "other" }, { ...current, jobKey: "send_message" }]) assert.equal(await classify(source), null);
  const auth = await classify({ ...current, result: { failure: failure("OF_REQUEST_FAILED", 401, { retryable: false }) } });
  assert.equal(auth.waitingForSession, true); assert.equal(auth.retryAt, null);
});
