"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `source slice missing: ${startNeedle}`);
  return source.slice(start, end);
}

test("INT5.9A-3 Campaign membership page uses one set-based JSONB upsert instead of scalar Prisma membership writes", () => {
  const helper = sliceBetween(ledger, "async function projectCampaignMembershipBatch", "function campaignCompletionProofFromState");
  assert.match(helper, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(helper, /FROM "CreatorCampaignFan" AS membership[\s\S]*FOR UPDATE/);
  assert.match(helper, /INSERT INTO "CreatorCampaignFan"/);
  assert.match(helper, /ON CONFLICT \("campaignId", "fanId"\) DO UPDATE/);
  assert.match(helper, /LEAST\("CreatorCampaignFan"\."attributedAt", EXCLUDED\."attributedAt"\)/);
  assert.match(helper, /"sourceScanStartedAt" <= EXCLUDED\."sourceScanStartedAt"/);
  assert.match(helper, /"historicalBoundary"/);
  assert.match(helper, /"alreadyObservedInCurrentRun"/);

  const claimerProjection = sliceBetween(ledger, "const fanByOnlyFansUserId", "let fanRefreshQueue = null");
  assert.match(claimerProjection, /projectCampaignMembershipBatch\(tx/);
  assert.doesNotMatch(claimerProjection, /creatorCampaignFan\.findUnique/);
  assert.doesNotMatch(claimerProjection, /creatorCampaignFan\.upsert/);
});

test("INT5.9A-3 bulk result preserves generation counts, exact historical boundary and current-run progress", () => {
  const helper = sliceBetween(ledger, "async function projectCampaignMembershipBatch", "function campaignCompletionProofFromState");
  assert.match(helper, /if \(newerGeneration\)[\s\S]*unchanged \+= 1/);
  assert.match(helper, /if \(row\?\.alreadyObservedInCurrentRun !== true\) currentRunMembershipProgress \+= 1/);
  assert.match(helper, /if \(row\?\.historicalBoundary === true\) historicalMembershipBoundaryReached = true/);
  assert.match(helper, /if \(existed\) updated \+= 1;[\s\S]*else inserted \+= 1/);
  assert.match(helper, /CAMPAIGN_MEMBERSHIP_BULK_RESULT_INCOMPLETE/);
});
