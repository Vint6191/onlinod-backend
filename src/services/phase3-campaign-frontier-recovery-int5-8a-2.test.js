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

test("INT5.8A-2 schema and migration add generation-bound staged Campaign frontier fields", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918011500_phase3_campaign_staged_frontier_recovery/migration.sql");
  assert.match(schema, /catchupFrontierHash\s+String\?\s+@db\.VarChar\(64\)/);
  assert.match(schema, /stagedCatchupFrontierHash\s+String\?\s+@db\.VarChar\(64\)/);
  assert.match(schema, /stagedCatchupFrontierRunId\s+String\?\s+@db\.VarChar\(120\)/);
  assert.match(schema, /stagedCatchupFrontierStartedAt\s+DateTime\?/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierHash" VARCHAR\(64\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierRunId" VARCHAR\(120\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierStartedAt" TIMESTAMP\(3\)/);
});

test("INT5.8A-2 page-1 hash is staged and canonical frontier publishes only after a proven Campaign boundary", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const claimerTail = sliceBetween(ledger, "const claimerPageNumber = integer(payload.pageNumber", "// Campaign attribution is historical");
  assert.match(claimerTail, /campaignComplete = orderIndependentTraversal[\s\S]*payload\.sourceHasMore !== true && payload\.campaignComplete === true && rejected === 0/);
  assert.match(claimerTail, /firstPageFrontierFanIds = claimerPageNumber === 1 && rejected === 0/);
  assert.match(claimerTail, /firstPageFrontierHash = firstPageFrontierFanIds/);
  assert.match(claimerTail, /stagedCatchupFrontierRunId === scanRunId/);
  assert.match(claimerTail, /stagedStartedAt\.getTime\(\) === scanStartedAt\.getTime\(\)/);
  assert.match(claimerTail, /if \(firstPageFrontierHash && !campaignComplete\)[\s\S]*stagedCatchupFrontierHash: firstPageFrontierHash/);
  assert.match(claimerTail, /else if \(campaignComplete && frontierToPublish\)[\s\S]*catchupFrontierHash: frontierToPublish/);
  assert.match(claimerTail, /stagedCatchupFrontierHash: null[\s\S]*stagedCatchupFrontierRunId: null[\s\S]*stagedCatchupFrontierStartedAt: null/);

  const stageBranch = sliceBetween(claimerTail, "if (firstPageFrontierHash && !campaignComplete)", "} else if (campaignComplete && frontierToPublish)");
  assert.doesNotMatch(stageBranch, /catchupFrontierHash:/, "an incomplete page-1 observation must never publish the canonical frontier");
});

test("INT5.8A-2 current planner no longer consumes canonical frontier as ordering-dependent skip authority", () => {
  const orchestrator = read("src/services/creator-analytics-sync-orchestrator.js");
  assert.doesNotMatch(orchestrator, /async function campaignCatchupState/);
  const schedulingStart = orchestrator.indexOf('if (campaignDelegatedRefreshPending(campaignState))');
  const schedulingEnd = orchestrator.indexOf('return { ready: true, initial, created, skipped };', schedulingStart);
  const scheduling = orchestrator.slice(schedulingStart, schedulingEnd);
  assert.doesNotMatch(scheduling, /knownClaimerFrontierHashes|stagedCatchupFrontier/);
  assert.match(scheduling, /campaignOrderIndependentTraversalVersion: 1/);
});

test("INT5.8A-2 manual Campaign reader converges on server-owned freshness coverage with legacy result/continuation fallback", () => {
  const control = read("src/services/campaign-scan-control-service.js");
  assert.match(control, /const coverageMatches = Boolean\(resultScanRunId && collectionState\?\.fanValueCoverageScanRunId === resultScanRunId\)/);
  assert.match(control, /const fanValuesExpected = coverageMatches \? integer\(collectionState\.fanValueExpected[\s\S]*?: integer\(result\.fanValuesTotal \?\? continuation\.fanValuesDiscovered/);
  assert.match(control, /const fanValuesComplete = coverageMatches[\s\S]*fanValueFreshnessStatus === "COMPLETE" && campaignFrontierFreshnessStatus === "COMPLETE"[\s\S]*: fanRefreshDelegated \? false : result\.fanValuesComplete === true/);
  assert.match(control, /deriveCampaignPresentationStatus\(\{[\s\S]*collectorStatus[\s\S]*fanValuesComplete[\s\S]*\}\)/);
});
