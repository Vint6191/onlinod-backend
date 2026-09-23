"use strict";

const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");

// Observe actual PostgreSQL blocking, not merely two callbacks that have started.
// Use with the interleaved transaction helper so failures settle both clients
// before fixture teardown. The observer must be a third independent client.
async function waitForPhase3PostgresBlock({ db, holderPid, waiterPid, timeoutMs = 5000 }) {
  if (!Number.isSafeInteger(holderPid) || holderPid < 1
    || !Number.isSafeInteger(waiterPid) || waiterPid < 1 || holderPid === waiterPid) {
    throw Object.assign(new Error("Distinct PostgreSQL backend PIDs are required"), { code: "PHASE3_PROOF_LOCK_PIDS_INVALID" });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    throw Object.assign(new Error("PostgreSQL block observer timeout must be bounded"), { code: "PHASE3_PROOF_LOCK_TIMEOUT_INVALID" });
  }
  const deadline = performance.now() + timeoutMs;
  do {
    const rows = await db.$queryRawUnsafe(
      'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS "blocked", clock_timestamp() AS "authorityNow"',
      holderPid, waiterPid,
    );
    if (rows?.[0]?.blocked === true) return rows[0];
    await delay(Math.min(20, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw Object.assign(new Error("PostgreSQL did not confirm the intended row-lock wait"), { code: "PHASE3_PROOF_LOCK_WAIT_NOT_OBSERVED" });
}

async function waitUntilPhase3DatabaseTime(tx, deadline) {
  if (!(deadline instanceof Date) || !Number.isFinite(deadline.getTime())) {
    throw Object.assign(new Error("Valid PostgreSQL lease deadline is required"), { code: "PHASE3_PROOF_LEASE_DEADLINE_INVALID" });
  }
  // This sleep advances time only AFTER pg_blocking_pids proved the overlap.
  // executeRaw is mandatory: pg_sleep returns void, which Prisma cannot decode.
  await tx.$executeRawUnsafe(
    'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())))::double precision + 0.02)',
    deadline,
  );
}

module.exports = { waitForPhase3PostgresBlock, waitUntilPhase3DatabaseTime };
