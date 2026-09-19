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
  assert.match(ledger, /return \{ batchId: batch\.id, complete, providerTraversalComplete,/);
  assert.match(resultService, /if \(completion\.providerTraversalComplete !== true\)/);
  assert.match(resultService, /refreshPending: completion\.complete !== true/);
  assert.doesNotMatch(resultService, /if \(completion\.complete !== true\) \{\s*return \{ ok: false, type: "campaigns"/);
});

test("INT5.9A-8 planner refuses a second Campaign provider job while delegated refresh is outstanding", () => {
  assert.match(orchestrator, /function campaignDelegatedRefreshPending\(state\)/);
  assert.match(orchestrator, /coverageRunId === activeGeneration && expected > 0 && freshness !== "COMPLETE"/);
  assert.match(orchestrator, /campaigns_catchup:fan_refresh_pending/);
  assert.match(orchestrator, /reason: "fan_refresh_pending"/);
  assert.match(orchestrator, /sideEffect\?\.completion\?\.complete !== true/);
});
