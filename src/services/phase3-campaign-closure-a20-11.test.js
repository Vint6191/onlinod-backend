"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");
function source(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }

test("Current refresh generation is established under Campaign authority before Work binding", () => {
  const text = source("src/services/campaign-fan-refresh-queue-service.js");
  const start = text.indexOf("async function enqueueUniqueCampaignFanRefreshes");
  const end = text.indexOf("\nasync function promoteQueuedCampaignFanRefreshDemands", start);
  const body = text.slice(start, end);
  const demandAdvance = body.indexOf("advanceCampaignFanRefreshDemandsSetBased");
  const workCreate = body.indexOf("creatorCampaignFanRefreshWork.createMany", demandAdvance);
  const coverageIncrement = body.lastIndexOf("incrementCoverage(db");
  assert.ok(demandAdvance >= 0 && workCreate > demandAdvance && coverageIncrement > workCreate);
  assert.match(body.slice(coverageIncrement), /state: coverageState/);
  const lock = body.indexOf("acquireCampaignTransactionLock(db, creatorId)");
  const coverage = body.indexOf("const coverageState = await ensureCoverageRun");
  assert.ok(lock >= 0 && coverage > lock && coverage < demandAdvance);
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




