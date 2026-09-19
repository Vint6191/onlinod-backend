"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");
function source(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }

test("A20.11 enqueue moves collection-state mutation behind demand/work authority", () => {
  const text = source("src/services/campaign-fan-refresh-queue-service.js");
  const start = text.indexOf("async function enqueueUniqueCampaignFanRefreshes");
  const end = text.indexOf("\nasync function promoteQueuedCampaignFanRefreshDemands", start);
  const body = text.slice(start, end);
  const demandAdvance = body.indexOf("advanceCampaignFanRefreshDemandsSetBased");
  const workCreate = body.indexOf("creatorCampaignFanRefreshWork.createMany", demandAdvance);
  const coverageIncrement = body.lastIndexOf("incrementCoverage(db");
  assert.ok(demandAdvance >= 0 && workCreate > demandAdvance && coverageIncrement > workCreate);
  assert.match(body.slice(coverageIncrement), /coverageAuthority/);
  const normalStart = body.indexOf("const fresh = newCandidates.filter");
  assert.ok(normalStart >= 0 && normalStart < demandAdvance);
  assert.doesNotMatch(body.slice(normalStart, demandAdvance), /ensureCoverageRun\(db/, "mutating enqueue path must not lock collection state before demand rows");
});

test("A20.11 preflight commits DDL before beginning serialized data backfill", async () => {
  const transactions = [];
  const fake = {
    $transaction: async (work, options) => {
      const calls = [];
      transactions.push({ calls, options });
      return work({
        $queryRawUnsafe: async (sql) => {
          const text = String(sql);
          calls.push({ kind: "query", sql: text });
          if (/information_schema\.columns/.test(text)) return [];
          return [];
        },
        $executeRawUnsafe: async (sql, ...args) => {
          const text = String(sql);
          calls.push({ kind: "execute", sql: text, args });
          if (/FROM "JobInstance" j/.test(text)) return 3;
          if (/JOIN LATERAL/.test(text)) return 2;
          return 0;
        },
      });
    },
  };
  const result = await preflight.ensureColumnsAndBackfill(fake);
  assert.equal(transactions.length, 2, "DDL and backfill must be separate commits");
  const ddl = transactions[0].calls.map((row) => row.sql).join("\n");
  const backfill = transactions[1].calls.map((row) => row.sql).join("\n");
  assert.match(ddl, /pg_advisory_xact_lock/);
  assert.match(ddl, /ALTER TABLE "CreatorCampaignCollectionState"/);
  assert.doesNotMatch(ddl, /FROM "JobInstance" j/);
  assert.doesNotMatch(ddl, /JOIN LATERAL/);
  assert.match(backfill, /pg_advisory_xact_lock/);
  assert.doesNotMatch(backfill, /ALTER TABLE/);
  assert.match(backfill, /FROM "JobInstance" j/);
  assert.match(backfill, /JOIN LATERAL/);
  assert.deepEqual(result, { directUpdated: 3, fallbackUpdated: 2, ddlAltered: true });
});

test("A20.11 current-generation lookup index is online for populated DBs and migration-backed for fresh DBs", () => {
  const schema = source("prisma/schema.prisma");
  const migration = source("prisma/migrations/20260920003000_phase3_campaign_refresh_current_run_lookup_index_v1/migration.sql");
  const preflightSource = source("scripts/database/phase3-campaign-coverage-generation-online-preflight.js");
  assert.match(schema, /@@index\(\[creatorId, scanRunId, id\], map: "CreatorCampaignFanRefreshWork_creator_run_id_idx"\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_creator_run_id_idx"/);
  assert.match(migration, /IF NOT EXISTS \(SELECT 1 FROM "CreatorCampaignFanRefreshWork" LIMIT 1\)/);
  assert.match(preflightSource, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(preflightSource, /ensureCurrentRunLookupIndex\(db\)/);
  assert.equal(preflight.CURRENT_RUN_INDEX_NAME, "CreatorCampaignFanRefreshWork_creator_run_id_idx");
});

test("A20.11 seeded physical proof models a large current generation and gates index use", () => {
  const seeded = source("scripts/audit/phase3-a20-seeded-rolling-coverage.js");
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  assert.match(seeded, /ONLINOD_A20_SEED_CURRENT_ROWS/);
  assert.match(seeded, /generate_series\(2, \$6::int\)/);
  assert.match(seeded, /currentRunIndexUsed/);
  assert.match(seeded, /CreatorCampaignFanRefreshWork_creator_run_id_idx/);
  assert.match(runner, /ONLINOD_A20_SEED_CURRENT_ROWS/);
  assert.match(runner, /currentGenerationRows/);
  assert.match(runner, /currentRunIndexUsed/);
  assert.match(runner, /EXPECTED_PROOF_TEST_COUNT = 26/);
  assert.match(runner, /phase3-campaign-closure-a20-11\.integration\.test\.js/);
  assert.match(runner, /A20_11_PREFLIGHT_RUNTIME_AVAILABILITY_PASS/);
  const availability = source("scripts/audit/phase3-a20-preflight-runtime-availability.js");
  assert.match(availability, /ensureAuthorityColumns/);
  assert.match(availability, /backfillAuthority/);
  assert.match(availability, /statement_timeout = '1500ms'/);
  assert.match(availability, /A20_11_PREFLIGHT_RUNTIME_AVAILABILITY_PASS/);
});
