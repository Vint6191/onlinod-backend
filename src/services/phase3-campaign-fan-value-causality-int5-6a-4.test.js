"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ledger = fs.readFileSync(path.join(__dirname, "creator-analytics-ledger-service.js"), "utf8");

test("INT5.6A-4 causal campaign fan values consume exact per-fan token after replay fence", () => {
  const fn = ledger.slice(ledger.indexOf("async function ingestCampaignFanValuesBatchChunk"), ledger.indexOf("async function completeCampaignScan"));
  const replayAt = fn.indexOf('if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status))');
  const consumeAt = fn.indexOf("consumeFanObservationTokensBatch");
  assert.ok(replayAt >= 0 && consumeAt > replayAt, "committed replay must bypass one-shot fan-value token consumption");
  assert.match(fn, /purpose: "campaign_fan_values",[\s\S]*subjects: \[item\.onlyFansUserId\]/);
  assert.match(ledger, /CAMPAIGN_FAN_VALUE_OBSERVATION_TOKEN_REQUIRED/);
  assert.match(ledger, /CAMPAIGN_FAN_VALUE_OBSERVATION_TIME_INVALID/);
  assert.match(ledger, /CAMPAIGN_FAN_VALUE_DUPLICATE_FAN/);
});

test("INT5.6A-4 embedded campaign value is projected under claimer token chronology", () => {
  const claimerSection = ledger.slice(ledger.indexOf("const observationTokenRequired"), ledger.indexOf("function normalizeCampaignFanValueItem"));
  assert.match(claimerSection, /claimer\.embeddedValue\?\.available === true/);
  assert.match(claimerSection, /value: \{[\s\S]*observedAt: identityObservedAt,[\s\S]*source: "CAMPAIGN_CLAIMER"/);
  assert.match(claimerSection, /projectFanObservationBatch\(tx, \{/);
});

test("INT5.6A-4 flattened Desktop claimer contract cannot confuse claimerId with fanId", () => {
  assert.match(ledger, /const hasNestedUser = Object\.keys\(nestedUser\)\.length > 0/);
  assert.match(ledger, /: \(row\.userId \?\? row\.fanId \?\? row\.id\)/);
});
