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
    { migrationName: "20261009000000_current_baseline", finishedAt: new Date("2026-09-18T00:30:00.000Z"), rolledBackAt: null },
    { migrationName: "20261009000000_current_baseline", finishedAt: new Date("2026-09-18T15:00:00.000Z"), rolledBackAt: null },
  ];
}



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








test("INT5.9A-2 claim path sets DB generation marker inside the same transaction before SCHEDULED to CLAIMED DML", () => {
  const source = read("src/services/job-lease-service.js");
  const start = source.indexOf("const claimWork = async (db) =>");
  const end = source.indexOf("if (!claimed) continue;", start);
  assert.ok(start >= 0 && end > start);
  const slice = source.slice(start, end);
  const enterAt = slice.indexOf("enterCampaignClaimGeneration({ db })");
  const updateAt = slice.indexOf("db.jobInstance.updateMany");
  assert.ok(enterAt >= 0 && updateAt > enterAt);
  assert.match(slice, /runRootCommit\(prisma, \(\{ tx \}\) => claimWork\(tx\)/);
  assert.match(source, /CAMPAIGN_CLAIM_GENERATION_RETIRED/);
});
