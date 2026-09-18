"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");

test("INT5.7A-3 Campaign current collector advances beyond v8 while retaining v8 ingest compatibility", () => {
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v10"/);
  assert.match(ledger, /new Set\(\["campaigns-v5", "campaigns-v6", "campaigns-v7", "campaigns-v8", "campaigns-v9", CAMPAIGN_COLLECTOR_VERSION\]\)/);
  assert.match(ledger, /completion:\$\{payload\.collectorVersion\}/);
});

test("INT5.7A-3 completion proof ignores historical v7 batches after a v8 continuation restart", () => {
  const completion = ledger.slice(ledger.indexOf("async function completeCampaignScan"), ledger.indexOf("function normalizeMessageDay"));
  assert.match(completion, /campaignCompletionProofFromState\(generation\.state, scanRunId, payload\.collectorVersion\)/);
  assert.doesNotMatch(completion, /analyticsIngestBatch\.findMany/);
  assert.match(completion, /incrementalProof\.campaignBatches === expectedCampaignBatches/);
  assert.match(completion, /incrementalProof\.claimerBatches === expectedClaimerBatches/);
});
