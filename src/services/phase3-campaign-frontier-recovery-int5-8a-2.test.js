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
  assert.match(claimerTail, /campaignComplete = \(payload\.campaignComplete === true \|\| serverDeepBoundaryReached\) && rejected === 0/);
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

test("INT5.8A-2 planner only consumes the published canonical frontier, never an unfinished staged frontier", () => {
  const orchestrator = read("src/services/creator-analytics-sync-orchestrator.js");
  const start = orchestrator.indexOf("async function campaignCatchupState");
  const end = orchestrator.indexOf("\nfunction retryDisposition", start);
  assert.ok(start >= 0 && end > start);
  const planner = orchestrator.slice(start, end);
  assert.match(planner, /select: \{ externalCampaignId: true, catchupFrontierHash: true \}/);
  assert.doesNotMatch(planner, /stagedCatchupFrontier/);
});

test("INT5.8A-2 manual Campaign reader converges on v8 fanValuesDiscovered with explicit v7 queue fallback", () => {
  const control = read("src/services/campaign-scan-control-service.js");
  const line = control.split("\n").find((value) => value.includes("fanValuesTotal:"));
  assert.ok(line);
  const resultAt = line.indexOf("result.fanValuesTotal");
  const v8At = line.indexOf("continuation.fanValuesDiscovered");
  const v7At = line.indexOf("continuation.fanValueQueue");
  assert.ok(resultAt >= 0 && v8At > resultAt && v7At > v8At, `unexpected reader precedence: ${line}`);
});
