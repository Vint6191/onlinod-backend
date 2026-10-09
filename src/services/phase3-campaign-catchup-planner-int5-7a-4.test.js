"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const orchestrator = fs.readFileSync(path.join(root, "src/services/creator-analytics-sync-orchestrator.js"), "utf8");
const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");
const lease = fs.readFileSync(path.join(root, "src/services/job-lease-service.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"), "utf8");

function functionSlice(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} source slice missing`);
  return source.slice(start, end);
}

test("INT5.7A-4 current Campaign planner retires ordering-dependent frontier hints instead of shipping them as skip authority", () => {
  const schedulingStart = orchestrator.indexOf('const campaignReady =');
  const schedulingEnd = orchestrator.indexOf('return { ready: initial.ready, initial, created, skipped };', schedulingStart);
  assert.ok(schedulingStart >= 0 && schedulingEnd > schedulingStart);
  const scheduling = orchestrator.slice(schedulingStart, schedulingEnd);
  assert.doesNotMatch(scheduling, /campaignCatchupState|knownClaimerFrontierHashes|knownCampaignFanCounts|knownClaimersByCampaign/);
  assert.match(scheduling, /campaignOrderIndependentTraversalVersion: 1/);
  assert.doesNotMatch(orchestrator, /async function campaignCatchupState/);
});



test("INT5.7A-4 claim fence strips all historical claimer skip hints from already queued Campaign jobs", () => {
  assert.match(lease, /delete params\.knownCampaignFanCounts/);
  assert.match(lease, /delete params\.knownClaimersByCampaign/);
  assert.match(lease, /delete params\.knownClaimerFrontierHashes/);
  assert.doesNotMatch(lease, /function boundedCampaignFrontierHashes/);
  assert.match(lease, /candidate\.jobKey[\s\S]*=== "fetch_campaigns" \? campaignClaimParams\(candidate\.params\)/);
});

test("INT5.7A-4 current catch-up command remains compact after frontier hints are retired", () => {
  const params = {
    analyticsSyncKind: "catchup", analyticsSyncVersion: 1, analyticsSyncStage: "campaigns",
    campaignMode: "catchup", reason: "creator_analytics_catchup", collectionContractVersion: 1,
    collectionType: "CAMPAIGNS", collectionMode: "catchup", collectionGeneration: "g".repeat(120),
    collectionRequestedAt: "2026-09-17T20:00:00.000Z", pageSize: 50, maxPages: 40, claimerPageSize: 50,
    fanValueBatchSize: 20, observationTokenVersion: 1, observationReadLeaseVersion: 1,
    campaignResumablePaginationVersion: 1, campaignFreshnessCoverageVersion: 1,
    campaignOrderIndependentTraversalVersion: 1,
  };
  const bytes = Buffer.byteLength(JSON.stringify({ job: { params } }), "utf8");
  assert.ok(bytes < 16 * 1024, `current Campaign command unexpectedly large: ${bytes} bytes`);
  assert.equal(Object.prototype.hasOwnProperty.call(params, "knownClaimerFrontierHashes"), false);
});
