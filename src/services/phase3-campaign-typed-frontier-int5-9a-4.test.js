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



test("INT5.9A-4 ledger reads at most 100 typed frontier rows and replaces canonical/staged anchors transactionally", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  const reader = sliceBetween(ledger, "async function readCampaignFrontierFanState", "async function replaceCampaignFrontierFanState");
  const writer = sliceBetween(ledger, "async function replaceCampaignFrontierFanState", "async function projectCampaignMembershipBatch");
  const claimerTail = sliceBetween(ledger, "const claimerPageNumber = integer(payload.pageNumber", "// Campaign attribution is historical");

  assert.match(reader, /creatorCampaignFrontierFan\.findMany/);
  assert.match(reader, /take: 100/);
  assert.match(reader, /frontierKind === "CANONICAL"/);
  assert.match(reader, /frontierKind === "STAGED"/);
  assert.match(reader, /sameInstant\(row\.sourceScanStartedAt, canonicalStartedAt\)/);
  assert.match(reader, /sameInstant\(row\.sourceScanStartedAt, stagedStartedAt\)/);

  assert.match(writer, /creatorCampaignFrontierFan\.deleteMany/);
  assert.match(writer, /creatorCampaignFrontierFan\.createMany/);
  assert.match(writer, /campaignClaimerFrontierFanIds\(fanIds\)/);
  assert.match(writer, /skipDuplicates: true/);

  assert.match(claimerTail, /frontierFanState\.canonical/);
  assert.match(claimerTail, /frontierFanState\.staged/);
  assert.match(claimerTail, /frontierKind: "CANONICAL"/);
  assert.match(claimerTail, /frontierKind: "STAGED"/);
  assert.doesNotMatch(claimerTail, /catchupFrontierFanIds:/);
  assert.doesNotMatch(claimerTail, /stagedCatchupFrontierFanIds:/);
});

test("INT5.9A-4 typed frontier remains server-side and current planner publishes no frontier skip hints", () => {
  const planner = read("src/services/creator-analytics-sync-orchestrator.js");
  assert.doesNotMatch(planner, /async function campaignCatchupState/);
  const schedulingStart = planner.indexOf('const campaignReady =');
  const schedulingEnd = planner.indexOf('return { ready: initial.ready, initial, created, skipped };', schedulingStart);
  const slice = planner.slice(schedulingStart, schedulingEnd);
  assert.doesNotMatch(slice, /CreatorCampaignFrontierFan|knownClaimerFrontierHashes|catchupFrontierHash/);
  assert.match(slice, /campaignOrderIndependentTraversalVersion: 1/);
});
