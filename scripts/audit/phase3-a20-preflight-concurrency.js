#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { PrismaClient } = require("@prisma/client");
const {
  PREFLIGHT_ADVISORY_LOCK_CLASS,
  PREFLIGHT_ADVISORY_LOCK_KEY,
  PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
  PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  ensureColumnsAndBackfill,
} = require("../database/phase3-campaign-coverage-generation-online-preflight");

async function main() {
  const a = new PrismaClient();
  const b = new PrismaClient();
  const observer = new PrismaClient();
  let releaseOwner;
  let ownerLockedResolve;
  const ownerLocked = new Promise((resolve) => { ownerLockedResolve = resolve; });
  const release = new Promise((resolve) => { releaseOwner = resolve; });
  try {
    const owner = a.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
        PREFLIGHT_ADVISORY_LOCK_CLASS,
        PREFLIGHT_ADVISORY_LOCK_KEY,
      );
      ownerLockedResolve();
      await release;
    }, {
      maxWait: PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
      timeout: PREFLIGHT_TRANSACTION_TIMEOUT_MS,
    });
    await ownerLocked;

    let contenderSettled = false;
    const contender = ensureColumnsAndBackfill(b).then(
      (value) => { contenderSettled = true; return value; },
      (error) => { contenderSettled = true; throw error; },
    );

    let waiting = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rows = await observer.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS waiting
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = $1::int::oid
          AND objid = $2::int::oid
          AND objsubid = 2
          AND NOT granted
      `, PREFLIGHT_ADVISORY_LOCK_CLASS, PREFLIGHT_ADVISORY_LOCK_KEY);
      waiting = Math.max(0, Number(rows?.[0]?.waiting || 0));
      if (waiting > 0) break;
      await delay(25);
    }
    assert.ok(waiting > 0, "concurrent coverage preflight must wait on the dedicated advisory owner");
    assert.equal(contenderSettled, false, "contender must remain blocked while peer owns the preflight advisory lock");

    // Prisma interactive transactions default to a 5s timeout. Hold the owner
    // beyond that historical default so this physical proof fails on A20.8 and
    // proves A20.9's explicit transaction timeout is actually effective.
    const defaultTimeoutFenceMs = 6_250;
    const blockedAt = Date.now();
    await delay(defaultTimeoutFenceMs);
    assert.equal(contenderSettled, false, "contender must survive beyond Prisma's historical 5s interactive-transaction default");

    releaseOwner();
    await owner;
    const result = await contender;
    assert.equal(contenderSettled, true);
    assert.ok(result && Number.isFinite(Number(result.directUpdated)) && Number.isFinite(Number(result.fallbackUpdated)));
    console.log(`# A20_9_PREFLIGHT_CONCURRENCY_PASS ${JSON.stringify({ waitingObserved: waiting, blockedMs: Date.now() - blockedAt, transactionTimeoutMs: PREFLIGHT_TRANSACTION_TIMEOUT_MS, directUpdated: Number(result.directUpdated || 0), fallbackUpdated: Number(result.fallbackUpdated || 0) })}`);
  } finally {
    if (releaseOwner) releaseOwner();
    await Promise.allSettled([a.$disconnect(), b.$disconnect(), observer.$disconnect()]);
  }
}

main().catch((error) => {
  console.error(`# A20_9_PREFLIGHT_CONCURRENCY_FAIL ${error?.stack || error}`);
  process.exitCode = 1;
});
