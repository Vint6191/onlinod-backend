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

test("INT5.8A-5 schema persists bounded exact canonical and staged Campaign frontier fan identities", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918031500_phase3_campaign_deep_frontier/migration.sql");
  assert.match(schema, /catchupFrontierFanIds\s+Json\?/);
  assert.match(schema, /catchupFrontierRunId\s+String\?/);
  assert.match(schema, /catchupFrontierStartedAt\s+DateTime\?/);
  assert.match(schema, /stagedCatchupFrontierFanIds\s+Json\?/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "catchupFrontierFanIds" JSONB/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "stagedCatchupFrontierFanIds" JSONB/);
  assert.match(migration, /Existing hash-only rows intentionally remain without anchors/);
});

test("INT5.8A-5 deep boundary uses exact server-side fan identities and never republishes params-scale fan maps", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const claimerTail = sliceBetween(ledger, "const claimerPageNumber = integer(payload.pageNumber", "// Campaign attribution is historical");
  assert.match(ledger, /function campaignClaimerFrontierFanIds\(value\)[\s\S]*slice\(0, 50\)/);
  assert.match(claimerTail, /canonicalFrontierFanIds = campaignClaimerFrontierFanIds\(saved\.catchupFrontierFanIds\)/);
  assert.match(claimerTail, /pageFrontierFanIds\.some\(\(fanId\) => canonicalFrontierSet\.has\(fanId\)\)/);
  assert.match(ledger, /existingScanStartedAt\.getTime\(\) <= canonicalFrontierStartedAt\.getTime\(\)/);
  assert.match(claimerTail, /exactAnchorBoundaryReached \|\| historicalMembershipBoundaryReached/);
  assert.match(claimerTail, /serverDeepBoundaryReached/);
  assert.match(claimerTail, /catchupFrontierFanIds: frontierFanIdsToPublish \|\| \[\]/);
  assert.match(claimerTail, /stagedCatchupFrontierFanIds: firstPageFrontierFanIds/);
  assert.doesNotMatch(claimerTail, /knownClaimersByCampaign/);

  const planner = read("src/services/creator-analytics-sync-orchestrator.js");
  const plannerSlice = sliceBetween(planner, "async function campaignCatchupState", "function retryDisposition");
  assert.match(plannerSlice, /select: \{ externalCampaignId: true, catchupFrontierHash: true \}/);
  assert.doesNotMatch(plannerSlice, /catchupFrontierFanIds/);
});

test("INT5.8A-5 progress can replace the Desktop's page continuation only after a server-proven exact deep boundary", () => {
  const lease = read("src/services/job-lease-service.js");
  assert.match(lease, /function campaignServerBoundaryContinuation/);
  assert.match(lease, /sideEffect\?\.serverDeepBoundaryReached === true/);
  assert.match(lease, /campaignIndex: matchedIndex \+ 1/);
  assert.match(lease, /claimerOffset: 0/);
  assert.match(lease, /claimerPage: 0/);
  assert.match(lease, /campaignBoundaryOverride \|\| sideEffect\.jobContinuationOverride/);
});
