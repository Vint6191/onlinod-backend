"use strict";

const { pinPhase3AuditSchema } = require("../audit/phase3-postgres-proof-fixture-authority");

// Both transactions must finish their first write before either starts its
// second. A sleep only makes overlap probable and can falsely prove lock order.
// Always settle both clients before fixture cleanup, including setup failures.
async function runPhase3InterleavedTransactions({
  dbA, dbB, firstA, secondA, firstB, secondB, barrierTimeoutMs = 10_000,
}) {
  let arrive;
  let abort;
  let failed = false;
  let firstFailure;
  let arrivals = 0;
  const barrier = new Promise((resolve, reject) => { arrive = resolve; abort = reject; });
  // The first transaction can fail before its peer has reached the barrier.
  barrier.catch(() => undefined);
  const rejectBarrier = (error) => {
    if (!failed) {
      failed = true;
      firstFailure = error;
    }
    abort(error);
  };
  const timeout = setTimeout(() => rejectBarrier(Object.assign(
    new Error("Both PostgreSQL first writes did not reach the interleave barrier"),
    { code: "PHASE3_PROOF_INTERLEAVE_TIMEOUT" },
  )), barrierTimeoutMs);
  const run = (db, first, second) => Promise.resolve().then(() => db.$transaction(async (tx) => {
    await pinPhase3AuditSchema(tx);
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await first(tx);
    arrivals += 1;
    if (arrivals === 2) {
      clearTimeout(timeout);
      arrive();
    }
    await barrier;
    await second(tx);
  }, { maxWait: 10_000, timeout: 30_000 })).catch((error) => {
    rejectBarrier(error);
    throw error;
  });
  try {
    const results = await Promise.allSettled([run(dbA, firstA, secondA), run(dbB, firstB, secondB)]);
    if (failed) throw firstFailure;
    return results.map((row) => row.value);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { runPhase3InterleavedTransactions };
