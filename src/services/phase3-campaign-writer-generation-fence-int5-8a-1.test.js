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
