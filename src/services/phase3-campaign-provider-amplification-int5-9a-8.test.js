"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const ledger = fs.readFileSync(path.join(root, "src/services/creator-analytics-ledger-service.js"), "utf8");
const resultService = fs.readFileSync(path.join(root, "src/services/job-result-service.js"), "utf8");
const orchestrator = fs.readFileSync(path.join(root, "src/services/creator-analytics-sync-orchestrator.js"), "utf8");

test("INT5.9A-8 decouples provider traversal success from delegated FanData freshness", () => {
  assert.match(ledger, /const providerTraversalComplete = membershipComplete;/);
  assert.match(ledger, /const complete = currentMembershipComplete && fanValuesComplete;/);
  assert.match(ledger, /return \{ batchId: batch\.id, complete, membershipComplete: currentMembershipComplete, providerTraversalComplete,/);
  assert.match(resultService, /if \(completion\.providerTraversalComplete !== true\)/);
  assert.match(resultService, /refreshPending: completion\.complete !== true/);
  assert.doesNotMatch(resultService, /if \(completion\.complete !== true\) \{\s*return \{ ok: false, type: "campaigns"/);
});

test("current traversal debt and global FanData debt retain separate freshness decisions", () => {
  const { evaluateCampaignCollectionState } = require("./campaign-freshness-service");
  const now = new Date("2026-10-04T12:00:00Z");
  const state = {status:"PARTIAL", membershipBaselineVerifiedAt:now, membershipBaselineObservedAt:now, membershipBaselineGeneration:"g",
    activeGeneration:"g",campaignFrontierPlanRunId:"g",campaignFrontierObservationVersion:1,
    campaignFrontierFreshnessStatus:"COMPLETE",membershipCoverageStatus:"COMPLETE",campaignDirectoryGeneration:"d",
    campaignDirectoryRevision:1,campaignDirectoryRequestedAt:now,campaignDirectoryVerifiedAt:now,
    campaignDirectoryDiscoveryDueAt:new Date(+now+3600000),campaignDirectoryCampaignCount:0};
  const pending = evaluateCampaignCollectionState(state, now, {queued:true,failed:false});
  assert.equal(pending.providerFresh,true); assert.equal(pending.fresh,false); assert.equal(pending.due,false);
  const due = evaluateCampaignCollectionState({...state,campaignFrontierDeferredCount:1}, now, {queued:true,failed:false});
  assert.equal(due.providerFresh,false); assert.equal(due.due,true); assert.equal(due.fanRefreshPending,true);
});
