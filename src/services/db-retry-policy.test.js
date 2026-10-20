"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const retry = require("./db-retry-policy");
const { domainWorkFailureOutcome, DATABASE_RECOVERY_WORK_CLASSES } = require("./domain-work-failure-policy");
const failure = (code, message = "controlled fixture", extra = {}) => Object.assign(new Error(message), { code, ...extra });
const expired = "Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15500 ms passed since the start of the transaction.";

test("temporary SQL failures retain bounded retry only for reviewed durable SQL work", () => {
  for (const workClass of DATABASE_RECOVERY_WORK_CLASSES) for (const error of [
    failure("P2024"), failure("P2034"), failure("P2010", "SQL conflict", { meta: { code: "40001" } }),
    failure("P2028", expired), failure("P2028", "Transaction API error: Unable to start a transaction in the given time."),
  ]) {
    const result = domainWorkFailureOutcome({ workClass, error, consecutiveFailures: 1000 });
    assert.equal(result.state, "READY", `${workClass}:${error.code}`);
    assert.equal(result.errorClass, "TRANSIENT_DATABASE");
    assert.equal(result.delayMs, 900000);
    assert.equal(result.terminalCause, null);
  }
  assert.equal(domainWorkFailureOutcome({ workClass: "CUSTOM_COMMUNICATION", error: failure("P2024"), consecutiveFailures: 8 }).state, "RECONCILE_REQUIRED");
});

test("contract failures, ambiguous transaction states and unknown provider failures remain finite", () => {
  for (const error of [failure("P2028", "Transaction already closed: A query cannot be executed on a committed transaction."),
    failure("P2028", "Transaction not found."), failure("P2010", "SQL failure", { meta: { code: "23503" } }),
    failure("ECONNRESET"), failure("P2024", "explicit domain rejection", { retryable: false }),
    failure("DOMAIN_REJECTED", "masked historical database cause", { cause: failure("P2024") }),
    new TypeError("bad projection"), new Error("transaction failed to commit")]) {
    assert.equal(retry.isTransientDatabaseError(error), false, error.message);
    assert.equal(domainWorkFailureOutcome({ workClass: "CREATOR_RECURRING_PLANNING", error, consecutiveFailures: 8 }).state, "RECONCILE_REQUIRED");
  }
});

test("planner aggregation preserves temporary causes but never conceals a broken substep", () => {
  const aggregate = errors => Object.assign(new AggregateError(errors, "planner degraded"), { code: "CREATOR_RECURRING_PLANNING_DEGRADED" });
  assert.equal(retry.isTransientDatabaseError(aggregate([failure("P2024"), failure("P2034")])), true);
  assert.equal(retry.isTransientDatabaseError(aggregate([failure("P2024"), new TypeError("broken")])), false);
  assert.equal(retry.isTransientDatabaseError(aggregate([])), false);
  assert.equal(retry.isTransientDatabaseError(new Error("wrapper", { cause: failure("P2034") })), true);
  assert.equal(retry.isTransientDatabaseError(failure("DB_TIME_AUTHORITY_QUERY_FAILED", "clock query", { cause: failure("P2024") })), true);
  assert.equal(retry.isTransientDatabaseError(failure("DB_TIME_AUTHORITY_QUERY_FAILED", "clock query", { cause: new TypeError("bad adapter") })), false);
});

test("stored timeout evidence is exact and newly classified errors survive message truncation", () => {
  assert.deepEqual(retry.classifyStoredDatabaseFailure({ code: "P2028", message: expired }), { code: "P2028" });
  assert.deepEqual(retry.classifyStoredDatabaseFailure({ message: expired.replace("A commit", "A query") }), { code: "P2028" });
  assert.equal(retry.classifyStoredDatabaseFailure({ code: "P2028", message: "Transaction not found" }), null);
  assert.equal(retry.classifyStoredDatabaseFailure({ message: "timeout while sending a provider write" }), null);
  assert.equal(retry.classifyStoredDatabaseFailure({ message: "transaction failed to commit" }), null);
  assert.deepEqual(retry.classifyStoredDatabaseFailure({ code: "P2010", message: 'Raw query failed. Code: `40001`. Message: `could not serialize access`' }), { code: "40001" });
  assert.equal(retry.classifyStoredDatabaseFailure({ code: "P2010", message: 'Raw query failed. Code: `23503`. Message: `bad data including 40001`' }), null);
  const saved = retry.describeDatabaseFailure(failure("P2028", expired), 100);
  assert.equal(saved.length, 100);
  assert.deepEqual(retry.classifyStoredDatabaseFailure({ message: saved }), { code: "P2028" });
});

test("Prisma initialization failures retain their real errorCode and exact code-less invocation diagnostics", () => {
  const diagnostic = "Can't reach database server at `127.0.0.1:1`\n\nPlease make sure your database server is running at `127.0.0.1:1`.";
  const init = message => Object.assign(new Error(message), { name: "PrismaClientInitializationError" });
  assert.deepEqual(retry.classifyDatabaseFailure(Object.assign(init(diagnostic), { errorCode: "P1001" })), { code: "P1001" });
  for (const invocation of ["prisma.$queryRawUnsafe()", "prisma.agency.findMany()"] ) {
    const message = `\nInvalid \`${invocation}\` invocation:\n\n\n${diagnostic}`;
    assert.deepEqual(retry.classifyDatabaseFailure(init(message)), { code: "P1001" });
    assert.deepEqual(retry.classifyStoredDatabaseFailure({ message }), { code: "P1001" });
    assert.equal(retry.classifyDatabaseFailure(new Error(message)), null, "an arbitrary application exception is not a typed Prisma initialization failure");
  }
  assert.equal(retry.classifyDatabaseFailure(Object.assign(init(diagnostic), { errorCode: "P1000" })), null);
  assert.equal(retry.classifyStoredDatabaseFailure({ message: "Provider write failed: " + diagnostic }), null);
  assert.equal(retry.classifyDatabaseFailure(init("database connection failed for an unknown reason")), null);
  const cyclic = new AggregateError([], "cycle"); cyclic.errors.push(cyclic);
  assert.equal(retry.classifyDatabaseFailure(cyclic), null);
});
