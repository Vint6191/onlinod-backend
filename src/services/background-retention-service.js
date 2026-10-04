"use strict";

const { runRootCommit } = require("./db-commit-kernel");
const RETENTION_BATCH_SIZE = 200;
const FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS = 24 * 60 * 60_000;
const options = Object.freeze({ maxWait: 1500, timeout: 5000, deadlineMs: 7000, lockTimeoutMs: 1000, statementTimeoutMs: 3000, maxAttempts: 2 });

async function sweep(db, kind) {
  return runRootCommit(db, async ({ tx }) => {
    // Transaction-scoped ownership is released on commit, crash or rollback.
    // Retention never takes the provider gate/creator lock or runs in a caller root.
    const [owner] = await tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS owned`, `background-retention-v1:${kind}`);
    if (!owner?.owned) return { ok: true, skipped: true, reason: "retention_contended", deleted: 0 };
    const token = kind === "fan-observation-token";
    const [clock] = await tx.$queryRawUnsafe(`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`);
    const now = new Date(clock.now);
    if (!Number.isFinite(now.getTime())) throw new Error("RETENTION_DB_TIME_INVALID");
    const cutoff = token ? new Date(now.getTime() - FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS) : now;
    // Only trusted fixed identifiers below. The same expiry predicate is checked
    // at deletion; a renewed waiter cannot be removed using a stale observation.
    const table = token ? '"FanObservationToken"' : '"OfProviderRequestGateWaiter"';
    const id = token ? '"id"' : '"waiterId"';
    const expiry = token ? '"createdAt"' : '"leaseUntil"';
    const comparison = token ? "<" : "<=";
    const rows = await tx.$queryRawUnsafe(`WITH expired AS MATERIALIZED (
      SELECT ${id} FROM ${table} WHERE ${expiry} ${comparison} $1
      ORDER BY ${expiry},${id} LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${table} row USING expired e
      WHERE row.${id}=e.${id} AND row.${expiry} ${comparison} $1 RETURNING row.${id}`, cutoff, RETENTION_BATCH_SIZE);
    return { ok: true, deleted: rows.length, limit: RETENTION_BATCH_SIZE, cutoff };
  }, options);
}
function runFanObservationTokenRetention({ db } = {}) { return sweep(db, "fan-observation-token"); }
function runProviderWaiterRetention({ db } = {}) { return sweep(db, "provider-waiter"); }
module.exports = { runFanObservationTokenRetention, runProviderWaiterRetention, RETENTION_BATCH_SIZE, FAN_OBSERVATION_TOKEN_STALE_RETENTION_MS };
