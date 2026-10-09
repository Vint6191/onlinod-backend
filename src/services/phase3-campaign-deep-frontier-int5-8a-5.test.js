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
  const schedulingStart = planner.indexOf('const campaignReady =');
  const schedulingEnd = planner.indexOf('return { ready: initial.ready, initial, created, skipped };', schedulingStart);
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
