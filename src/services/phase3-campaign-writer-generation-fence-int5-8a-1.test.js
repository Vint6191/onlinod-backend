"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function loadActivationService() {
  const prismaModule = require.resolve("../prisma");
  require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
  delete require.cache[require.resolve("./campaign-causal-activation-service")];
  return require("./campaign-causal-activation-service");
}

test("INT5.8A-1 migration installs an inactive rolling-safe physical Campaign writer generation fence", () => {
  const migration = read("prisma/migrations/20260918003000_phase3_campaign_writer_generation_fence/migration.sql");
  assert.match(migration, /writerGenerationActive/);
  assert.match(migration, /writerGenerationActive":false/);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "AnalyticsIngestBatch"/);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "CreatorFan"/);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "CreatorFanValueCurrent"/);
  assert.match(migration, /identityAuthorityVersion[\s\S]*CAMPAIGN_CLAIMER/);
  assert.match(migration, /valueAuthorityVersion[\s\S]*CAMPAIGN_CLAIMER/);
  assert.match(migration, /NEW\."dataType"::text = 'CAMPAIGNS'/);
  assert.match(migration, /SystemSetting[\s\S]*FOR SHARE/);
  assert.match(migration, /current_setting\('onlinod\.campaign_writer_generation', true\)/);
  assert.match(migration, /CAMPAIGN_WRITER_GENERATION_RETIRED/);
  assert.doesNotMatch(migration, /writerGenerationActive":true/);
});

test("INT5.8A-1 new Campaign transaction enters the exact activated writer generation", async () => {
  const { enterCampaignWriterGeneration, CAMPAIGN_WRITER_GENERATION_GUC } = loadActivationService();
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql, ...args) {
      calls.push([String(sql), ...args]);
      if (/SystemSetting/.test(sql)) {
        return [{ value: { active: true, epoch: 4, writerGenerationActive: true, writerGeneration: 7 } }];
      }
      if (/set_config/.test(sql)) return [{ campaignWriterGeneration: "7" }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const state = await enterCampaignWriterGeneration({ db });
  assert.equal(state.active, true);
  assert.equal(state.writerGenerationActive, true);
  assert.equal(state.writerGeneration, 7);
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /FOR SHARE/);
  assert.match(calls[1][0], /set_config/);
  assert.equal(calls[1][1], CAMPAIGN_WRITER_GENERATION_GUC);
  assert.equal(calls[1][2], "7");
});

test("INT5.8A-1 inactive bridge does not require a session generation marker", async () => {
  const { enterCampaignWriterGeneration } = loadActivationService();
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql) {
      calls.push(String(sql));
      return [{ value: { active: true, epoch: 4, writerGenerationActive: false } }];
    },
  };
  const state = await enterCampaignWriterGeneration({ db });
  assert.equal(state.active, true);
  assert.equal(state.writerGenerationActive, false);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /set_config/);
});

test("INT5.8A-1 activation uses JobInstance -> barrier lock order and bounded retry", async () => {
  const { activateCampaignCausalV1 } = loadActivationService();
  let transactionAttempts = 0;
  const raw = [];
  const tx = {
    async $queryRawUnsafe(sql) {
      const text = String(sql);
      raw.push(text);
      if (/FROM "JobInstance"/.test(text) && /FOR UPDATE/.test(text) && !/WITH claimed/.test(text)) return [];
      if (/FROM "SystemSetting"/.test(text) && /FOR UPDATE/.test(text)) {
        return [{ value: { active: true, epoch: 5, writerGenerationActive: false, claimGenerationActive: false, writerGeneration: 3 } }];
      }
      if (/FROM pg_trigger/.test(text)) return [
        { triggerName: "phase3_campaign_writer_generation_ingest_guard_trg", tableName: "AnalyticsIngestBatch", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
        { triggerName: "phase3_campaign_writer_generation_identity_guard_trg", tableName: "CreatorFan", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
        { triggerName: "phase3_campaign_writer_generation_value_guard_trg", tableName: "CreatorFanValueCurrent", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
        { triggerName: "phase3_campaign_claim_generation_guard_trg", tableName: "JobInstance", enabled: "O", functionName: "phase3_campaign_claim_generation_guard", functionDefinition: "current_setting(onlinod.campaign_claim_generation) CAMPAIGN_CLAIM_GENERATION_RETIRED" },
      ];
      if (/FROM "_prisma_migrations"/.test(text)) return [
        { migrationName: "20260918003000_phase3_campaign_writer_generation_fence", finishedAt: new Date(), rolledBackAt: null },
        { migrationName: "20260918150000_phase3_campaign_claim_generation_fence", finishedAt: new Date(), rolledBackAt: null },
      ];
      if (/WITH claimed/.test(text)) return [{ revoked: 2, stamped: 4 }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    systemSetting: {
      async update({ data }) { return data; },
    },
  };
  const db = {
    async $transaction(work, options) {
      transactionAttempts += 1;
      assert.equal(options.isolationLevel, "ReadCommitted");
      assert.ok(options.maxWait > 0 && options.maxWait <= 10_000);
      assert.ok(options.timeout > 100_000 && options.timeout <= 110_000, "admission and execution share the 120s root deadline");
      if (transactionAttempts === 1) {
        const error = new Error("deadlock detected");
        error.code = "40P01";
        throw error;
      }
      return work(tx);
    },
  };
  const result = await activateCampaignCausalV1({ db, activatedBy: "test", maxAttempts: 3, retryBaseMs: 0 });
  assert.equal(transactionAttempts, 2);
  assert.equal(result.active, true);
  assert.equal(result.writerGenerationActive, true);
  assert.equal(result.claimGenerationActive, true);
  assert.equal(result.writerGeneration, 4);
  assert.equal(result.epoch, 5, "re-activating an already-causal barrier must not invent a new causal epoch");
  assert.equal(result.revoked, 2);
  assert.equal(raw.length, 5);
  assert.match(raw[0], /JobInstance[\s\S]*FOR UPDATE/);
  assert.match(raw[1], /SystemSetting[\s\S]*FOR UPDATE/);
  assert.match(raw[2], /FROM pg_trigger/);
  assert.match(raw[3], /FROM "_prisma_migrations"/);
});

test("INT5.8A-1 all Campaign ingest/completion transactions enter the writer generation before batch work", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  for (const [name, next] of [
    ["ingestCampaignChunk", "ingestCampaignFanValueChunk"],
    ["ingestCampaignFanValueChunk", "ingestCampaignFanValuesBatchChunk"],
    ["ingestCampaignFanValuesBatchChunk", "completeCampaignScan"],
    ["completeCampaignScan", "normalizeMessageDay"],
  ]) {
    const start = ledger.indexOf(`async function ${name}`);
    const end = ledger.indexOf(next === "normalizeMessageDay" ? `function ${next}` : `async function ${next}`, start + 1);
    assert.ok(start >= 0 && end > start, `${name} source slice must exist`);
    const slice = ledger.slice(start, end);
    const enterAt = slice.indexOf("enterCampaignWriterGeneration({ db: tx })");
    const batchAt = slice.indexOf("beginBatch(tx");
    assert.ok(enterAt >= 0, `${name} must enter the DB writer generation`);
    if (batchAt >= 0) assert.ok(enterAt < batchAt, `${name} must enter generation before ingest-batch DML`);
  }
});
