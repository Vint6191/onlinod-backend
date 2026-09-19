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

test("A20.9 coverage preflight overrides Prisma's 5s interactive transaction default around advisory serialization", async () => {
  let options = null;
  const calls = [];
  const fake = {
    $transaction: async (work, txOptions) => {
      options = txOptions;
      return work({
        $queryRawUnsafe: async (sql) => {
          calls.push(String(sql));
          return [{ locked: null }];
        },
        $executeRawUnsafe: async (sql) => {
          calls.push(String(sql));
          return 0;
        },
      });
    },
  };

  await preflight.ensureColumnsAndBackfill(fake);
  assert.deepEqual(options, {
    maxWait: preflight.PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
    timeout: preflight.PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  });
  assert.ok(preflight.PREFLIGHT_TRANSACTION_MAX_WAIT_MS >= 10_000);
  assert.ok(preflight.PREFLIGHT_TRANSACTION_TIMEOUT_MS > 5_000);
  assert.ok(preflight.PREFLIGHT_TRANSACTION_TIMEOUT_MS >= 120_000);
  assert.match(calls[0], /pg_advisory_xact_lock/);
  assert.match(calls[1], /SET LOCAL lock_timeout = '5s'/);
  const alterIndex = calls.findIndex((row) => /ALTER TABLE/.test(row));
  const resetIndex = calls.findIndex((row) => /SET LOCAL lock_timeout = '0'/.test(row));
  const backfillIndex = calls.findIndex((row) => /FROM "JobInstance" j/.test(row));
  assert.ok(alterIndex >= 0 && resetIndex > alterIndex && backfillIndex > resetIndex);
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
