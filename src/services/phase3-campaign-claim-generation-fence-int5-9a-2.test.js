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

function healthyTriggerRows() {
  return [
    { triggerName: "phase3_campaign_writer_generation_ingest_guard_trg", tableName: "AnalyticsIngestBatch", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
    { triggerName: "phase3_campaign_writer_generation_identity_guard_trg", tableName: "CreatorFan", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
    { triggerName: "phase3_campaign_writer_generation_value_guard_trg", tableName: "CreatorFanValueCurrent", enabled: "O", functionName: "phase3_campaign_writer_generation_guard", functionDefinition: "current_setting(onlinod.campaign_writer_generation) CAMPAIGN_WRITER_GENERATION_RETIRED" },
    { triggerName: "phase3_campaign_claim_generation_guard_trg", tableName: "JobInstance", enabled: "O", functionName: "phase3_campaign_claim_generation_guard", functionDefinition: "current_setting(onlinod.campaign_claim_generation) CAMPAIGN_CLAIM_GENERATION_RETIRED" },
  ];
}

function healthyMigrationRows() {
  return [
    { migrationName: "20260918003000_phase3_campaign_writer_generation_fence", finishedAt: new Date("2026-09-18T00:30:00.000Z"), rolledBackAt: null },
    { migrationName: "20260918150000_phase3_campaign_claim_generation_fence", finishedAt: new Date("2026-09-18T15:00:00.000Z"), rolledBackAt: null },
  ];
}

test("INT5.9A-2 migration installs an inactive physical fetch_campaigns claim-generation fence", () => {
  const sql = read("prisma/migrations/20260918150000_phase3_campaign_claim_generation_fence/migration.sql");
  assert.match(sql, /claimGenerationActive/);
  assert.match(sql, /claimGenerationActive\\?":false|claimGenerationActive":false/);
  assert.match(sql, /phase3_campaign_claim_generation_guard/);
  assert.match(sql, /BEFORE UPDATE OF "status" ON "JobInstance"/);
  assert.match(sql, /NEW\."jobKey" = 'fetch_campaigns'/);
  assert.match(sql, /NEW\."status" = 'CLAIMED'/);
  assert.match(sql, /OLD\."status" IS DISTINCT FROM 'CLAIMED'/);
  assert.match(sql, /current_setting\('onlinod\.campaign_claim_generation', true\)/);
  assert.match(sql, /CAMPAIGN_CLAIM_GENERATION_RETIRED/);
  assert.doesNotMatch(sql, /claimGenerationActive":true/);
});

test("INT5.9A-2 new Backend enters exact claim generation while inactive bridge requires no marker", async () => {
  const { enterCampaignClaimGeneration, CAMPAIGN_CLAIM_GENERATION_GUC } = loadActivationService();
  const calls = [];
  const activeDb = {
    systemSetting: {
      findUnique: async () => ({ value: { active: true, writerGenerationActive: true, claimGenerationActive: true, writerGeneration: 9 } }),
    },
    $queryRawUnsafe: async (sql, ...args) => {
      calls.push([String(sql), ...args]);
      return [{ campaignClaimGeneration: "9" }];
    },
  };
  const state = await enterCampaignClaimGeneration({ db: activeDb });
  assert.equal(state.claimGenerationActive, true);
  assert.equal(state.writerGeneration, 9);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /set_config/);
  assert.equal(calls[0][1], CAMPAIGN_CLAIM_GENERATION_GUC);
  assert.equal(calls[0][2], "9");

  const inactiveCalls = [];
  const inactiveDb = {
    systemSetting: { findUnique: async () => ({ value: { active: true, writerGenerationActive: true, claimGenerationActive: false, writerGeneration: 9 } }) },
    $queryRawUnsafe: async (...args) => { inactiveCalls.push(args); return []; },
  };
  const bridge = await enterCampaignClaimGeneration({ db: inactiveDb });
  assert.equal(bridge.claimGenerationActive, false);
  assert.equal(inactiveCalls.length, 0);
});

test("INT5.9A-2 activation physical preflight rejects disabled/missing trigger and incomplete migration", async () => {
  const { assertCampaignActivationPhysicalFences } = loadActivationService();
  const disabled = healthyTriggerRows();
  disabled[3] = { ...disabled[3], enabled: "D" };
  await assert.rejects(
    () => assertCampaignActivationPhysicalFences({ db: { $queryRawUnsafe: async (sql) => /pg_trigger/.test(String(sql)) ? disabled : healthyMigrationRows() } }),
    /CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED/,
  );

  const missing = healthyTriggerRows().slice(0, 3);
  await assert.rejects(
    () => assertCampaignActivationPhysicalFences({ db: { $queryRawUnsafe: async (sql) => /pg_trigger/.test(String(sql)) ? missing : healthyMigrationRows() } }),
    /missing trigger phase3_campaign_claim_generation_guard_trg/,
  );

  const migrations = healthyMigrationRows();
  migrations[1] = { ...migrations[1], finishedAt: null };
  await assert.rejects(
    () => assertCampaignActivationPhysicalFences({ db: { $queryRawUnsafe: async (sql) => /pg_trigger/.test(String(sql)) ? healthyTriggerRows() : migrations } }),
    /CAMPAIGN_ACTIVATION_MIGRATION_PREFLIGHT_FAILED/,
  );
});

test("INT5.9A-2 Actual67 writer-active state activates physical claim fence without inventing a new writer generation", async () => {
  const { activateCampaignCausalV1 } = loadActivationService();
  const events = [];
  const tx = {
    async $queryRawUnsafe(sql) {
      const text = String(sql);
      events.push(text);
      if (/FROM "JobInstance"/.test(text) && /FOR UPDATE/.test(text) && !/WITH claimed/.test(text)) return [];
      if (/FROM "SystemSetting"/.test(text) && /FOR UPDATE/.test(text)) {
        return [{ value: {
          active: true,
          epoch: 11,
          writerGenerationActive: true,
          writerGeneration: 7,
          writerGenerationActivatedAt: "2026-09-18T01:00:00.000Z",
          writerGenerationActivatedBy: "previous-rollout",
          claimGenerationActive: false,
        } }];
      }
      if (/FROM pg_trigger/.test(text)) return healthyTriggerRows();
      if (/FROM "_prisma_migrations"/.test(text)) return healthyMigrationRows();
      if (/WITH claimed/.test(text)) return [{ revoked: 3, stamped: 5 }];
      throw new Error(`unexpected SQL: ${text}`);
    },
    systemSetting: {
      async update({ data }) { events.push(data.value); return data; },
    },
  };
  const db = { $transaction: async (work) => work(tx) };
  const result = await activateCampaignCausalV1({ db, activatedBy: "int5.9a-2", maxAttempts: 1 });
  assert.equal(result.active, true);
  assert.equal(result.writerGenerationActive, true);
  assert.equal(result.claimGenerationActive, true);
  assert.equal(result.writerGeneration, 7, "claim-only cutover must keep the already-active writer generation");
  assert.equal(result.epoch, 11);
  assert.equal(result.revoked, 3);
  const published = events.find((entry) => entry && typeof entry === "object" && entry.claimGenerationActive === true);
  assert.ok(published);
  assert.equal(published.writerGeneration, 7);
  assert.equal(published.writerGenerationActivatedAt, "2026-09-18T01:00:00.000Z");
  assert.equal(published.writerGenerationActivatedBy, "previous-rollout");
});


test("INT5.9A-2 already-active barrier still fails closed when physical trigger preflight is broken", async () => {
  const { activateCampaignCausalV1 } = loadActivationService();
  const tx = {
    async $queryRawUnsafe(sql) {
      const text = String(sql);
      if (/FROM "JobInstance"/.test(text) && /FOR UPDATE/.test(text)) return [];
      if (/FROM "SystemSetting"/.test(text) && /FOR UPDATE/.test(text)) {
        return [{ value: { active: true, epoch: 12, writerGenerationActive: true, claimGenerationActive: true, writerGeneration: 8 } }];
      }
      if (/FROM pg_trigger/.test(text)) return healthyTriggerRows().slice(0, 3);
      if (/FROM "_prisma_migrations"/.test(text)) return healthyMigrationRows();
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  const db = { $transaction: async (work) => work(tx) };
  await assert.rejects(
    () => activateCampaignCausalV1({ db, maxAttempts: 1 }),
    /CAMPAIGN_ACTIVATION_TRIGGER_PREFLIGHT_FAILED/,
  );
});

test("INT5.9A-2 claim path sets DB generation marker inside the same transaction before SCHEDULED to CLAIMED DML", () => {
  const source = read("src/services/job-lease-service.js");
  const start = source.indexOf("const claimWork = async (db) =>");
  const end = source.indexOf("if (!claimed) continue;", start);
  assert.ok(start >= 0 && end > start);
  const slice = source.slice(start, end);
  const enterAt = slice.indexOf("enterCampaignClaimGeneration({ db })");
  const updateAt = slice.indexOf("db.jobInstance.updateMany");
  assert.ok(enterAt >= 0 && updateAt > enterAt);
  assert.match(slice, /prisma\.\$transaction\(claimWork, JOB_CHUNK_TRANSACTION_OPTIONS\)/);
  assert.match(source, /CAMPAIGN_CLAIM_GENERATION_RETIRED/);
});
