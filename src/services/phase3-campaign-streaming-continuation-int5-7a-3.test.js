"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");

test("INT5.7A-3 Campaign collector v8 retains v7 ingest compatibility but owns a new idempotency generation", () => {
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v8"/);
  assert.match(ledger, /new Set\(\["campaigns-v5", "campaigns-v6", "campaigns-v7", CAMPAIGN_COLLECTOR_VERSION\]\)/);
  assert.match(ledger, /completion:v8/);
});

test("INT5.7A-3 completion proof ignores historical v7 batches after a v8 continuation restart", () => {
  const completion = ledger.slice(ledger.indexOf("async function completeCampaignScan"), ledger.indexOf("function normalizeMessageDay"));
  assert.match(completion, /dataType: "CAMPAIGNS",[\s\S]*collectorVersion: payload\.collectorVersion,[\s\S]*idempotencyKey: \{ startsWith: batchPrefix \}/);
  assert.match(completion, /const campaignBatches = pageBatches\.filter\(\(item\) => item\.idempotencyKey\.includes\(":campaigns:"\)\)/);
  assert.match(completion, /const claimerBatches = pageBatches\.filter\(\(item\) => item\.idempotencyKey\.includes\(":claimers:"\)\)/);
});
