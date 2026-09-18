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

test("INT5.8A-6 current Campaign protocol is v10 and claim requires resumable-pagination capability", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const route = read("src/routes/jobs.js");
  const lease = read("src/services/job-lease-service.js");
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v10"/);
  assert.match(ledger, /"campaigns-v9", CAMPAIGN_COLLECTOR_VERSION/);
  assert.match(route, /campaignResumablePaginationV1: true/);
  assert.match(route, /campaignResumablePaginationV1: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(lease, /capabilities\?\.campaignResumablePaginationV1 !== true/);
  assert.match(lease, /campaignResumablePaginationVersion: 1/);
});

test("INT5.8A-6 planner/manual producers and claim fence retire the terminal maxClaimerPages contract", () => {
  const orchestrator = read("src/services/creator-analytics-sync-orchestrator.js");
  const manual = read("src/services/campaign-scan-control-service.js");
  const lease = read("src/services/job-lease-service.js");
  assert.doesNotMatch(orchestrator, /maxClaimerPages\s*:/);
  assert.doesNotMatch(manual, /maxClaimerPages\s*:/);
  assert.match(lease, /delete params\.maxClaimerPages/);
});

test("INT5.8A-6 backend accepts page numbers beyond 10k and uses exact current-run membership progress as loop protection", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const claimer = sliceBetween(ledger, "const saved = await tx.creatorCampaign.findUnique", "function normalizeCampaignFanValueItem");
  assert.match(claimer, /const claimerPageNumber = integer\(payload\.pageNumber\);/);
  assert.match(claimer, /sourceScanRunId: true/);
  assert.match(claimer, /alreadyObservedInCurrentRun/);
  assert.match(claimer, /currentRunMembershipProgress \+= 1/);
  assert.match(claimer, /serverNoProgressDetected/);
  assert.match(claimer, /payload\.sourceHasMore === true/);
});

test("INT5.8A-6 completion proof no longer carries the old one-million claimer-page parser ceiling", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(ledger, /claimerBatches: matches \? integer\(row\.campaignProofClaimerBatches\) \?\? 0 : 0/);
  assert.match(ledger, /const expectedClaimerBatches = integer\(payload\.claimerBatchCount\);/);
});
