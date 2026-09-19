"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const TARGET_MIGRATION = path.join(
  ROOT,
  "prisma/migrations/20260919173000_phase3_campaign_coverage_generation_authority_v1/migration.sql",
);
const TARGET_MIGRATION_SHA256 = "f888657a3c802ddd8d0431c6a3a42ab1c330ec175d99c7552df792fb4a52ea0c";

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("A20.6 keeps the already-shipped A20.2 migration byte-identical and inserts bounded online preflight before migrate deploy", () => {
  assert.equal(sha256(TARGET_MIGRATION), TARGET_MIGRATION_SHA256, "historical migration checksum must never be rewritten");
  const pkg = JSON.parse(source("package.json"));
  const command = String(pkg.scripts?.["prisma:migrate"] || "");
  const preflightIndex = command.indexOf("phase3-campaign-coverage-generation-online-preflight.js");
  const deployIndex = command.indexOf("prisma migrate deploy");
  assert.ok(preflightIndex >= 0, "coverage-generation online preflight must be part of deployment");
  assert.ok(deployIndex > preflightIndex, "online preflight must run before prisma migrate deploy");
  assert.equal(preflight.MIGRATION, "20260919173000_phase3_campaign_coverage_generation_authority_v1");
});

test("A20.6 migration fallback starts from current state and LATERAL-probes only its exact creator+scanRun", () => {
  const sql = preflight.CURRENT_STATE_FALLBACK_BACKFILL_SQL;
  assert.match(sql, /FROM "CreatorCampaignCollectionState" s/);
  assert.match(sql, /JOIN LATERAL/);
  assert.match(sql, /w\."creatorId" = s\."creatorId"/);
  assert.match(sql, /w\."scanRunId" = s\."fanValueCoverageScanRunId"/);
  assert.match(sql, /ORDER BY w\."id"/);
  assert.match(sql, /LIMIT 1/);
  assert.doesNotMatch(sql, /DISTINCT ON/i, "online preflight must not enumerate all historical refresh work");
});

test("A20.6 online preflight applies columns + both backfills as one transaction before migrate resolve", async () => {
  const calls = [];
  const fake = {
    $transaction: async (work) => work({
      $queryRawUnsafe: async (sql, ...args) => {
        const text = String(sql);
        calls.push(text);
        assert.match(text, /pg_advisory_xact_lock/);
        assert.deepEqual(args, [preflight.PREFLIGHT_ADVISORY_LOCK_CLASS, preflight.PREFLIGHT_ADVISORY_LOCK_KEY]);
        return [{ locked: null }];
      },
      $executeRawUnsafe: async (sql) => {
        const text = String(sql);
        calls.push(text);
        if (text.includes('FROM "JobInstance" j')) return 3;
        if (text.includes('JOIN LATERAL')) return 2;
        return 0;
      },
    }),
  };
  const result = await preflight.ensureColumnsAndBackfill(fake);
  assert.equal(result.directUpdated, 3);
  assert.equal(result.fallbackUpdated, 2);
  assert.equal(calls.length, 6);
  assert.match(calls[0], /pg_advisory_xact_lock/, "deployment serialization must happen before the short DDL lock timeout");
  assert.match(calls[1], /SET LOCAL lock_timeout = '5s'/);
  assert.match(calls[2], /ALTER TABLE "CreatorCampaignCollectionState"/);
  assert.match(calls[3], /SET LOCAL lock_timeout = '0'/);
  assert.match(calls[4], /FROM "JobInstance" j/);
  assert.match(calls[5], /JOIN LATERAL/);
});

test("A20.6 PostgreSQL proof is zero-skip gated, persists real timing metrics, and exercises the online-preflight rolling path", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const seeded = source("scripts/audit/phase3-a20-seeded-rolling-coverage.js");
  const terminal = source("src/services/phase3-campaign-closure-a20-5.integration.test.js");

  assert.match(runner, /EXPECTED_PROOF_TEST_COUNT = 23/);
  assert.match(runner, /summary\.skipped !== 0/);
  assert.match(runner, /summary\.fail !== 0/);
  assert.match(runner, /A20_4_POSTGRES_HEALING_SCALE/);
  assert.match(runner, /A20_5_POSTGRES_TERMINAL_SCALE_POINT/);
  assert.match(runner, /seeded-a20-2-online-preflight/);
  assert.match(runner, /A20_6_SEEDED_BACKFILL_EXPLAIN_METRICS/);
  assert.match(runner, /ONLINOD_AUDIT_PROOF_OUTPUT/);

  assert.match(terminal, /performance\.now\(\)/);
  assert.match(terminal, /A20_5_POSTGRES_TERMINAL_SCALE_POINT/);

  assert.match(seeded, /workRowsVisited <= visitBudget/);
  assert.match(seeded, /historyRows \* 0\.10/);
  assert.match(seeded, /CURRENT_STATE_FALLBACK_EXPLAIN_SQL/);
});
