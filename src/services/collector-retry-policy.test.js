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

test("terminal failure keeps its budget exhausted even when the transport error was retryable", async () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const current = { ...job, status: "FAILED", lastError: message, result: { failure: failure("SESSION_FETCH_FAILED", 0) } };
  const classify = source => collectionFailureRetry({ db: { jobInstance: { findUnique: async () => source } }, job, error: message, terminal: true, now });
  const result = await classify(current);
  assert.equal(result.retryAt, null);
  assert.equal(result.terminal, true);
  for (const source of [{ ...current, creatorId: "other" }, { ...current, agencyId: "other" },
    { ...current, status: "CLAIMED" }, { ...current, lastError: "previous attempt" },
    { ...current, id: "other" }, { ...current, jobKey: "send_message" }]) assert.equal(await classify(source), null);
  const auth = await classify({ ...current, result: { failure: failure("OF_REQUEST_FAILED", 401, { retryable: false }) } });
  assert.equal(auth.waitingForSession, true); assert.equal(auth.retryAt, null);
});


test("a new process or ready binding cannot resurrect a stopped collector", async () => {
  const state = { status: "FAILED", sourceJobId: "source", activeGeneration: "episode", retryAfterAt: null };
  const { recoverTerminalCollector } = require("./collector-retry-policy");
  for (let restart = 0; restart < 5; restart++) {
    const result = await recoverTerminalCollector({ db: new Proxy({}, { get() { throw new Error("must not mutate stopped episode"); } }), state,
      type: "FINANCIAL", agencyId: "a", creatorId: "c", now: new Date() });
    assert.equal(result.state, state); assert.equal(result.recovered, false);
  }
});
test("same-job nonterminal retry uses the committed deadline", async () => {
  const now = new Date("2026-10-20T12:00:00Z"), nextRunAt = new Date(+now+60000);
  const current = { ...job, status: "SCHEDULED", nextRunAt, lastError: message, result: { failure: failure("SESSION_FETCH_FAILED", 0) } };
  const result = await collectionFailureRetry({db:{jobInstance:{findUnique:async()=>current}},job,error:message,terminal:false,now});
  assert.equal(+result.retryAt,+nextRunAt); assert.equal(result.terminal,false);
});

test("legacy retry deadlines cannot replenish an exhausted or missing source episode", async () => {
  const { recoverTerminalCollector } = require("./collector-retry-policy");
  const source = { ...job, params: { collectionGeneration: "episode" }, status: "FAILED" };
  for (const retryAfterAt of [new Date("2020-01-01"), new Date("2099-01-01"), "invalid"])
    for (const stored of [source, null, { ...source, status: "COMPLETED" }, { ...source, status: "CANCELLED" },
      { ...source, status: "SCHEDULED", agencyId: "other" }, { ...source, status: "SCHEDULED", creatorId: "other" },
      { ...source, status: "SCHEDULED", jobKey: "fetch_campaigns" },
      { ...source, status: "SCHEDULED", params: { collectionGeneration: "different" } }]) {
      const state = { status: "FAILED", sourceJobId: job.id, activeGeneration: "episode", retryAfterAt };
      const result = await recoverTerminalCollector({ db: { jobInstance: { findUnique: async () => stored } },
        state, type: "FINANCIAL", agencyId: job.agencyId, creatorId: job.creatorId });
      assert.equal(result.terminal, true); assert.equal(result.active, undefined); assert.equal(result.state, state);
    }
});

test("only the exact active source job preserves a bounded retry episode", async () => {
  const { recoverTerminalCollector } = require("./collector-retry-policy");
  for (const status of ["SCHEDULED", "CLAIMED", "PUBLISHING", "PAUSED"])
    for (const retryAfterAt of [new Date("2020-01-01"), new Date("2099-01-01")]) {
      const state = { status: "FAILED", sourceJobId: job.id, activeGeneration: "episode", retryAfterAt };
      const result = await recoverTerminalCollector({ db: { jobInstance: { findUnique: async () => ({ ...job, status,
        params: { collectionGeneration: "episode" } }) } }, state, type: "FINANCIAL", agencyId: job.agencyId, creatorId: job.creatorId });
      assert.equal(result.active, true); assert.equal(result.terminal, undefined); assert.equal(result.recovered, false);
      assert.equal(result.state, state);
    }
});
