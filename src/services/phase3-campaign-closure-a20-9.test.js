"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

test("A20.9/A20.11 coverage preflight overrides Prisma 5s default for both serialized phases", async () => {
  const options = [];
  const callsByTx = [];
  const fake = {
    $transaction: async (work, txOptions) => {
      options.push(txOptions);
      const calls = [];
      callsByTx.push(calls);
      return work({
        $queryRawUnsafe: async (sql) => { calls.push(String(sql)); return /information_schema\.columns/.test(String(sql)) ? [] : []; },
        $executeRawUnsafe: async (sql) => { calls.push(String(sql)); return 0; },
      });
    },
  };

  await preflight.ensureColumnsAndBackfill(fake);
  assert.equal(options.length, 2);
  for (const txOptions of options) assert.deepEqual(txOptions, {
    maxWait: preflight.PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
    timeout: preflight.PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  });
  assert.ok(preflight.PREFLIGHT_TRANSACTION_MAX_WAIT_MS >= 10_000);
  assert.ok(preflight.PREFLIGHT_TRANSACTION_TIMEOUT_MS >= 120_000);
  assert.match(callsByTx[0][0], /pg_advisory_xact_lock/);
  assert.ok(callsByTx[0].some((row) => /SET LOCAL lock_timeout = '5s'/.test(row)));
  assert.ok(callsByTx[0].some((row) => /ALTER TABLE/.test(row)));
  assert.match(callsByTx[1][0], /pg_advisory_xact_lock/);
  assert.equal(callsByTx[1].some((row) => /ALTER TABLE/.test(row)), false);
});

test("A20.9 physical preflight concurrency proof must hold a contender beyond the historical 5s Prisma timeout", () => {
  const physical = source("scripts/audit/phase3-a20-preflight-concurrency.js");
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  assert.match(physical, /defaultTimeoutFenceMs = 6_250/);
  assert.match(physical, /historical 5s interactive-transaction default/);
  assert.match(physical, /PREFLIGHT_TRANSACTION_TIMEOUT_MS/);
  assert.match(physical, /A20_9_PREFLIGHT_CONCURRENCY_PASS/);
  assert.match(runner, /A20_9_PREFLIGHT_CONCURRENCY_PASS/);
  assert.doesNotMatch(runner, /A20_8_PREFLIGHT_CONCURRENCY_PASS/);
});
