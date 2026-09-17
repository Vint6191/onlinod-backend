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
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260917234500_phase3_campaign_catchup_frontier_hash/migration.sql"), "utf8");

function functionSlice(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} source slice missing`);
  return source.slice(start, end);
}

test("INT5.7A-4 Campaign catch-up planner is bounded to 2,000 compact CreatorCampaign rows and never walks fan history", () => {
  const planner = functionSlice(orchestrator, "campaignCatchupState", "retryDisposition");
  assert.match(planner, /take: CAMPAIGN_CATCHUP_HINT_CAMPAIGN_LIMIT/);
  assert.match(orchestrator, /CAMPAIGN_CATCHUP_HINT_CAMPAIGN_LIMIT = 2_000/);
  assert.match(planner, /select: \{ externalCampaignId: true, catchupFrontierHash: true \}/);
  assert.doesNotMatch(planner, /creatorCampaignFan|\$queryRawUnsafe|_count|groupBy/);
  assert.match(orchestrator, /knownClaimerFrontierHashes: catchup\.knownClaimerFrontierHashes/);
  const scheduling = orchestrator.slice(orchestrator.indexOf("const catchup = await campaignCatchupState"), orchestrator.indexOf("const scheduled = await scheduleIfIdle", orchestrator.indexOf("const catchup = await campaignCatchupState")));
  assert.doesNotMatch(scheduling, /knownCampaignFanCounts|knownClaimersByCampaign/);
});

test("INT5.7A-4 stores a compact server-derived first-page frontier fingerprint, never fan-id history", () => {
  assert.match(schema, /catchupFrontierHash\s+String\?\s+@db\.VarChar\(64\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "catchupFrontierHash" VARCHAR\(64\)/);
  assert.match(ledger, /function campaignClaimerFrontierHash\(fanIds\)[\s\S]*new Set[\s\S]*\.sort\(\)[\s\S]*checksum\(normalized\)/);
  assert.match(ledger, /claimerPageNumber === 1 && rejected === 0[\s\S]*catchupFrontierHash: campaignClaimerFrontierHash\(\[\.\.\.uniqueClaimers\.keys\(\)\]\)/);
});

test("INT5.7A-4 claim fence strips legacy unbounded fan/count maps from already queued Campaign jobs", () => {
  assert.match(lease, /delete params\.knownCampaignFanCounts/);
  assert.match(lease, /delete params\.knownClaimersByCampaign/);
  assert.match(lease, /boundedCampaignFrontierHashes/);
  assert.match(lease, /count >= 2_000/);
  assert.match(lease, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(lease, /candidate\.jobKey[\s\S]*=== "fetch_campaigns" \? campaignClaimParams\(candidate\.params\)/);
});

test("INT5.7A-4 worst legal compact planner payload stays comfortably below one MiB", () => {
  const hashes = {};
  for (let i = 0; i < 2_000; i += 1) {
    const campaignId = `${String(i).padStart(4, "0")}${"c".repeat(216)}`.slice(0, 220);
    hashes[campaignId] = "a".repeat(64);
  }
  const params = {
    analyticsSyncKind: "catchup",
    analyticsSyncVersion: 1,
    analyticsSyncStage: "campaigns",
    campaignMode: "catchup",
    reason: "creator_analytics_catchup",
    collectionContractVersion: 1,
    collectionType: "CAMPAIGNS",
    collectionMode: "catchup",
    collectionGeneration: "g".repeat(120),
    collectionRequestedAt: "2026-09-17T20:00:00.000Z",
    pageSize: 50,
    maxPages: 40,
    claimerPageSize: 50,
    maxClaimerPages: 10_000,
    fanValueBatchSize: 20,
    observationTokenVersion: 1,
    observationReadLeaseVersion: 1,
    knownClaimerFrontierHashes: hashes,
  };
  const bytes = Buffer.byteLength(JSON.stringify({ job: { params } }), "utf8");
  assert.equal(Object.keys(hashes).length, 2_000);
  assert.ok(bytes < 1024 * 1024, `compact 2,000-Campaign planner payload is ${bytes} bytes`);
});
