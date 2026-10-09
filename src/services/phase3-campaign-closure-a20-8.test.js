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

test("A20.8/A20.11 coverage preflight serializes both phases and releases DDL lock before backfill", async () => {
  const transactions = [];
  const fake = {
    $transaction: async (work) => {
      const calls = [];
      transactions.push(calls);
      return work({
        $queryRawUnsafe: async (sql, ...args) => {
          calls.push({ kind: "query", sql: String(sql), args });
          if (/information_schema\.columns/.test(String(sql))) return [];
          return [];
        },
        $executeRawUnsafe: async (sql, ...args) => { calls.push({ kind: "execute", sql: String(sql), args }); return 0; },
      });
    },
  };
  const result = await preflight.ensureColumnsAndBackfill(fake);
  assert.deepEqual(result, { directUpdated: 0, fallbackUpdated: 0, ddlAltered: true });
  assert.equal(transactions.length, 2);
  for (const calls of transactions) {
    const lock = calls.find((row) => /pg_advisory_xact_lock/.test(row.sql));
    assert.ok(lock && lock.kind === "execute");
  }
  const ddlCalls = transactions[0];
  assert.ok(ddlCalls.findIndex((row) => /SET LOCAL lock_timeout = '5s'/.test(row.sql)) < ddlCalls.findIndex((row) => /ALTER TABLE/.test(row.sql)));
  assert.equal(ddlCalls.some((row) => /FROM "JobInstance" j|JOIN LATERAL/.test(row.sql)), false);
  const backfillCalls = transactions[1];
  assert.equal(backfillCalls.some((row) => /ALTER TABLE/.test(row.sql)), false);
  assert.ok(backfillCalls.some((row) => /FROM "JobInstance" j/.test(row.sql)));
});


