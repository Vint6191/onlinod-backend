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

test("A20.8 coverage-generation preflight serializes overlapping deploys before enabling DDL lock timeout", async () => {
  const calls = [];
  const fake = {
    $transaction: async (work) => work({
      $queryRawUnsafe: async (sql, ...args) => {
        calls.push({ kind: "query", sql: String(sql), args });
        return [{ locked: null }];
      },
      $executeRawUnsafe: async (sql, ...args) => {
        calls.push({ kind: "execute", sql: String(sql), args });
        return 0;
      },
    }),
  };
  const result = await preflight.ensureColumnsAndBackfill(fake);
  assert.deepEqual(result, { directUpdated: 0, fallbackUpdated: 0 });
  assert.equal(calls[0].kind, "execute");
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].args, [preflight.PREFLIGHT_ADVISORY_LOCK_CLASS, preflight.PREFLIGHT_ADVISORY_LOCK_KEY]);
  assert.match(calls[1].sql, /SET LOCAL lock_timeout = '5s'/);
  assert.ok(calls.findIndex((row) => /pg_advisory_xact_lock/.test(row.sql)) < calls.findIndex((row) => /SET LOCAL lock_timeout/.test(row.sql)));
  const ddlTimeoutIndex = calls.findIndex((row) => /SET LOCAL lock_timeout = '5s'/.test(row.sql));
  const alterIndex = calls.findIndex((row) => /ALTER TABLE/.test(row.sql));
  const resetTimeoutIndex = calls.findIndex((row) => /SET LOCAL lock_timeout = '0'/.test(row.sql));
  const directBackfillIndex = calls.findIndex((row) => /FROM "JobInstance" j/.test(row.sql));
  assert.ok(ddlTimeoutIndex < alterIndex);
  assert.ok(alterIndex < resetTimeoutIndex);
  assert.ok(resetTimeoutIndex < directBackfillIndex);
});

test("A20.8 physical proof runner executes dedicated overlapping-preflight concurrency proof", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const physical = source("scripts/audit/phase3-a20-preflight-concurrency.js");
  assert.match(runner, /PREFLIGHT_CONCURRENCY_PROOF/);
  assert.match(runner, /clean-current-preflight-concurrency/);
  assert.match(runner, /A20_(?:8|9)_PREFLIGHT_CONCURRENCY_PASS/);
  assert.match(physical, /pg_locks/);
  assert.match(physical, /NOT granted/);
  assert.match(physical, /contender must remain blocked/);
  assert.match(physical, /await owner/);
  assert.match(physical, /await contender/);
});
