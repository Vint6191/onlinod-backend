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

test("A20.10 coverage preflight treats pg_advisory_xact_lock as a command and survives Prisma void-deserialization query drivers", async () => {
  const calls = { query: [], execute: [] };
  const fake = {
    $transaction: async (work) => work({
      $queryRawUnsafe: async (sql, ...args) => {
        calls.query.push({ sql: String(sql), args });
        if (/pg_advisory_xact_lock/.test(String(sql))) throw new Error("Failed to deserialize column of type 'void'");
        return [];
      },
      $executeRawUnsafe: async (sql, ...args) => {
        calls.execute.push({ sql: String(sql), args });
        return 0;
      },
    }),
  };

  await preflight.ensureColumnsAndBackfill(fake);
  assert.equal(calls.query.some((call) => /pg_advisory_xact_lock/.test(call.sql)), false);
  const lock = calls.execute.find((call) => /pg_advisory_xact_lock/.test(call.sql));
  assert.ok(lock, "preflight must acquire its advisory lock through executeRaw");
  assert.equal(lock.sql, "SELECT pg_advisory_xact_lock($1::int, $2::int)");
  assert.deepEqual(lock.args, [preflight.PREFLIGHT_ADVISORY_LOCK_CLASS, preflight.PREFLIGHT_ADVISORY_LOCK_KEY]);
});

test("A20.10 physical preflight owner also uses executeRaw for the void advisory lock", () => {
  const physical = source("scripts/audit/phase3-a20-preflight-concurrency.js");
  assert.match(physical, /\$executeRawUnsafe\(\s*`SELECT pg_advisory_xact_lock\(\$1::int, \$2::int\)`/);
  assert.doesNotMatch(physical, /\$queryRawUnsafe\(\s*`SELECT pg_advisory_xact_lock/);
});

test("A20.10 PostgreSQL proof failures preserve finally cleanup instead of exiting from inside the proof body", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  assert.doesNotMatch(runner, /function fail[\s\S]{0,220}?process\.exit\(/);
  assert.match(runner, /throw error/);
  assert.match(runner, /finally \{[\s\S]*dropSchema\(cli, audit, cleanSchema/);
  assert.match(runner, /process\.exitCode =/);
});
