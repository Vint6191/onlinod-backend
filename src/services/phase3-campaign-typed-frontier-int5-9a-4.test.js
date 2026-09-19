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

test("INT5.9A-4 CreatorCampaign frontier anchors are typed relational and business JSON is physically removed", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918163000_phase3_campaign_typed_frontier_fans/migration.sql");
  const creatorCampaign = sliceBetween(schema, "model CreatorCampaign {", "model CreatorCampaignFrontierFan {");
  const frontier = sliceBetween(schema, "model CreatorCampaignFrontierFan {", "model CreatorCampaignFan {");

  assert.doesNotMatch(creatorCampaign, /\bJson\??\b/);
  assert.match(creatorCampaign, /frontierFans\s+CreatorCampaignFrontierFan\[\]/);
  assert.match(frontier, /frontierKind\s+CreatorCampaignFrontierKind/);
  assert.match(frontier, /onlyFansUserId\s+String\s+@db\.VarChar\(180\)/);
  assert.match(frontier, /sourceScanRunId\s+String\?/);
  assert.match(frontier, /sourceScanStartedAt\s+DateTime\?/);
  assert.match(frontier, /@@unique\(\[campaignId, frontierKind, onlyFansUserId\]\)/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "CreatorCampaignFrontierFan"/);
  assert.match(migration, /jsonb_array_elements_text/);
  assert.equal((migration.match(/WHERE rn <= 50/g) || []).length, 2);
  assert.match(migration, /'CANONICAL'::"CreatorCampaignFrontierKind"/);
  assert.match(migration, /'STAGED'::"CreatorCampaignFrontierKind"/);
  assert.match(migration, /DROP COLUMN IF EXISTS "catchupFrontierFanIds"/);
  assert.match(migration, /DROP COLUMN IF EXISTS "stagedCatchupFrontierFanIds"/);
});

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
  const schedulingStart = planner.indexOf('if (campaignDelegatedRefreshPending(campaignState))');
  const schedulingEnd = planner.indexOf('return { ready: true, initial, created, skipped };', schedulingStart);
  const slice = planner.slice(schedulingStart, schedulingEnd);
  assert.doesNotMatch(slice, /CreatorCampaignFrontierFan|knownClaimerFrontierHashes|catchupFrontierHash/);
  assert.match(slice, /campaignOrderIndependentTraversalVersion: 1/);
});
