"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `source slice missing: ${startNeedle}`);
  return source.slice(start, end);
}



test("INT5.8A-3 page commits advance durable proof while terminal replay returns before a second increment", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const ingest = sliceBetween(ledger, "async function ingestCampaignChunk", "function normalizeCampaignFanValueItem");
  assert.match(ingest, /if \(replay && \["COMMITTED", "PARTIAL"\]\.includes\(batch\.status\)\)[\s\S]*return \{ replay: true/);
  const increments = ingest.match(/recordCampaignCompletionProofBatch\(tx/g) || [];
  assert.equal(increments.length, 2, "campaign and claimer page terminal commits must each advance the proof exactly once");
});

test("INT5.8A-3 Campaign completion consumes one state row and never materializes all ingest history", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const completion = sliceBetween(ledger, "async function completeCampaignScan", "function normalizeMessageDay");
  assert.match(completion, /campaignCompletionProofFromState\(generation\.state, scanRunId, payload\.collectorVersion\)/);
  assert.match(completion, /incrementalProof\.campaignBatches === expectedCampaignBatches/);
  assert.match(completion, /incrementalProof\.claimerBatches === expectedClaimerBatches/);
  assert.match(completion, /incrementalProof\.rejectedBatches === 0/);
  assert.doesNotMatch(completion, /analyticsIngestBatch\.findMany/);
  assert.doesNotMatch(completion, /pageBatches\.filter/);
});

test("INT5.8A-3 proof is isolated by both scanRunId and collectorVersion", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const helper = sliceBetween(ledger, "function campaignCompletionProofFromState", "async function recordCampaignCompletionProofBatch");
  assert.match(helper, /campaignProofScanRunId[\s\S]*=== scanRunId/);
  assert.match(helper, /campaignProofCollectorVersion[\s\S]*=== collectorVersion/);
  assert.match(helper, /matches \? integer\(row\.campaignProofCampaignBatches/);
});
