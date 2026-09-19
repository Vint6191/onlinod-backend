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

test("INT5.9A-5 current Campaign collector is order-independent and only source exhaustion proves membership completion", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const claimer = sliceBetween(ledger, "const claimerPageNumber = integer(payload.pageNumber", "// Campaign attribution is historical");
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v13"/);
  assert.match(claimer, /const orderIndependentTraversal = CAMPAIGN_ORDER_INDEPENDENT_COLLECTOR_VERSIONS\.has\(payload\.collectorVersion\)/);
  assert.match(claimer, /serverDeepBoundaryReached =[\s\S]*orderIndependentTraversal !== true/);
  assert.match(claimer, /knownBoundaryReached = orderIndependentTraversal[\s\S]*\? false/);
  assert.match(claimer, /campaignComplete = orderIndependentTraversal[\s\S]*payload\.sourceHasMore !== true && payload\.campaignComplete === true && rejected === 0/);
  assert.match(claimer, /serverNoProgressDetected[\s\S]*currentRunMembershipProgress === 0/);
});

test("INT5.9A-5 current planner and claim fence publish no historical claimer skip hints", () => {
  const orchestrator = read("src/services/creator-analytics-sync-orchestrator.js");
  const lease = read("src/services/job-lease-service.js");
  assert.doesNotMatch(orchestrator, /async function campaignCatchupState/);
  const schedulingStart = orchestrator.indexOf('if (campaignDelegatedRefreshPending(campaignState))');
  const schedulingEnd = orchestrator.indexOf('return { ready: true, initial, created, skipped };', schedulingStart);
  const scheduling = orchestrator.slice(schedulingStart, schedulingEnd);
  assert.doesNotMatch(scheduling, /knownClaimerFrontierHashes|knownClaimersByCampaign|knownCampaignFanCounts/);
  assert.match(scheduling, /campaignOrderIndependentTraversalVersion: 1/);
  assert.match(lease, /delete params\.knownCampaignFanCounts/);
  assert.match(lease, /delete params\.knownClaimersByCampaign/);
  assert.match(lease, /delete params\.knownClaimerFrontierHashes/);
});

test("INT5.9A-5 rolling wire requires explicit order-independent traversal capability and server ACK", () => {
  const route = read("src/routes/jobs.js");
  const lease = read("src/services/job-lease-service.js");
  assert.match(route, /campaignOrderIndependentTraversalV1: true/);
  assert.match(route, /campaignOrderIndependentTraversalV1: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(lease, /capabilities\?\.campaignOrderIndependentTraversalV1 !== true/);
  assert.match(lease, /campaignOrderIndependentTraversalVersion: 1/);
  assert.match(lease, /sideEffect\?\.completion\?\.protocolCurrent === false/);
  assert.match(lease, /fetch_campaigns_protocol_superseded/);
  assert.match(lease, /protocolSuperseded: true/);
});
