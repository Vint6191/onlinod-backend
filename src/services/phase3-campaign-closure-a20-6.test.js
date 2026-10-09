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
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
);
const TARGET_MIGRATION_SHA256 = "f888657a3c802ddd8d0431c6a3a42ab1c330ec175d99c7552df792fb4a52ea0c";

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}



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

test("A20.6/A20.11 online preflight commits DDL before the bounded backfill transaction", async () => {
  const transactions = [];
  const fake = {
    $transaction: async (work) => {
      const calls = [];
      transactions.push(calls);
      return work({
        $queryRawUnsafe: async (sql) => {
          calls.push(String(sql));
          if (/information_schema\.columns/.test(String(sql))) return [];
          return [];
        },
        $executeRawUnsafe: async (sql) => {
          const text = String(sql);
          calls.push(text);
          if (text.includes('FROM "JobInstance" j')) return 3;
          if (text.includes('JOIN LATERAL')) return 2;
          return 0;
        },
      });
    },
  };
  const result = await preflight.ensureColumnsAndBackfill(fake);
  assert.equal(result.directUpdated, 3);
  assert.equal(result.fallbackUpdated, 2);
  assert.equal(transactions.length, 2);
  assert.match(transactions[0][0], /pg_advisory_xact_lock/);
  assert.ok(transactions[0].some((text) => /ALTER TABLE "CreatorCampaignCollectionState"/.test(text)));
  assert.equal(transactions[0].some((text) => /FROM "JobInstance" j|JOIN LATERAL/.test(text)), false);
  assert.match(transactions[1][0], /pg_advisory_xact_lock/);
  assert.equal(transactions[1].some((text) => /ALTER TABLE/.test(text)), false);
  assert.ok(transactions[1].some((text) => /FROM "JobInstance" j/.test(text)));
  assert.ok(transactions[1].some((text) => /JOIN LATERAL/.test(text)));
});


