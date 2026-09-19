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

test("INT5.8A-5 exact Campaign frontier fan identities remain bounded after typed-relational cutover", () => {
  const schema = read("prisma/schema.prisma");
  const historicalMigration = read("prisma/migrations/20260918031500_phase3_campaign_deep_frontier/migration.sql");
  const typedMigration = read("prisma/migrations/20260918163000_phase3_campaign_typed_frontier_fans/migration.sql");
  assert.doesNotMatch(schema, /catchupFrontierFanIds\s+Json\?/);
  assert.doesNotMatch(schema, /stagedCatchupFrontierFanIds\s+Json\?/);
  assert.match(schema, /model CreatorCampaignFrontierFan \{/);
  assert.match(schema, /frontierKind\s+CreatorCampaignFrontierKind/);
  assert.match(schema, /onlyFansUserId\s+String\s+@db\.VarChar\(180\)/);
  assert.match(schema, /@@unique\(\[campaignId, frontierKind, onlyFansUserId\]\)/);
  assert.match(schema, /catchupFrontierRunId\s+String\?/);
  assert.match(schema, /catchupFrontierStartedAt\s+DateTime\?/);
  assert.match(historicalMigration, /ADD COLUMN IF NOT EXISTS "catchupFrontierFanIds" JSONB/);
  assert.match(typedMigration, /jsonb_array_elements_text/);
  assert.match(typedMigration, /WHERE rn <= 50/);
  assert.match(typedMigration, /DROP COLUMN IF EXISTS "catchupFrontierFanIds"/);
  assert.match(typedMigration, /DROP COLUMN IF EXISTS "stagedCatchupFrontierFanIds"/);
});

test("INT5.8A-5 exact deep-boundary machinery remains bounded as pre-v12 compatibility but current planner never republishes it", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const claimerTail = sliceBetween(ledger, "const claimerPageNumber = integer(payload.pageNumber", "// Campaign attribution is historical");
  assert.match(ledger, /function campaignClaimerFrontierFanIds\(value\)[\s\S]*slice\(0, 50\)/);
  assert.match(claimerTail, /canonicalFrontierFanIds = frontierFanState\.canonical/);
  assert.match(claimerTail, /pageFrontierFanIds\.some\(\(fanId\) => canonicalFrontierSet\.has\(fanId\)\)/);
  assert.match(ledger, /e\."sourceScanStartedAt" <= \$5::timestamptz/);
  assert.match(claimerTail, /exactAnchorBoundaryReached \|\| historicalMembershipBoundaryReached/);
  assert.match(claimerTail, /serverDeepBoundaryReached/);
  assert.match(claimerTail, /frontierKind: "CANONICAL"/);
  assert.match(claimerTail, /frontierKind: "STAGED"/);
  assert.doesNotMatch(claimerTail, /catchupFrontierFanIds:/);
  assert.doesNotMatch(claimerTail, /stagedCatchupFrontierFanIds:/);
  assert.doesNotMatch(claimerTail, /knownClaimersByCampaign/);

  const planner = read("src/services/creator-analytics-sync-orchestrator.js");
  assert.doesNotMatch(planner, /async function campaignCatchupState/);
  const schedulingStart = planner.indexOf('if (campaignDelegatedRefreshPending(campaignState))');
  const schedulingEnd = planner.indexOf('return { ready: true, initial, created, skipped };', schedulingStart);
  const plannerSlice = planner.slice(schedulingStart, schedulingEnd);
  assert.doesNotMatch(plannerSlice, /catchupFrontierHash|knownClaimerFrontierHashes|catchupFrontierFanIds/);
  assert.match(plannerSlice, /campaignOrderIndependentTraversalVersion: 1/);
});

test("INT5.8A-5 server deep-boundary continuation override remains legacy compatibility while v12 disables that authority", () => {
  const lease = read("src/services/job-lease-service.js");
  assert.match(lease, /function campaignServerBoundaryContinuation/);
  assert.match(lease, /sideEffect\?\.serverDeepBoundaryReached === true/);
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(ledger, /orderIndependentTraversal !== true[\s\S]*serverDeepBoundaryReached/);
  assert.match(lease, /campaignIndex: matchedIndex \+ 1/);
  assert.match(lease, /claimerOffset: 0/);
  assert.match(lease, /claimerPage: 0/);
  assert.match(lease, /campaignBoundaryOverride \|\| campaignSegmentOverride \|\| sideEffect\.jobContinuationOverride/);
});
