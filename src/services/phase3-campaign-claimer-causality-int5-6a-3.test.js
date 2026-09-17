"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ledger = fs.readFileSync(path.join(__dirname, "creator-analytics-ledger-service.js"), "utf8");
test("INT5.6A-3 backend consumes campaign claimer token after replay fence and before current projection", () => {
  const replayIndex = ledger.indexOf('if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status))');
  const consumeIndex = ledger.indexOf('purpose: "campaign_claimers_page"');
  const projectionIndex = ledger.indexOf('source: "CAMPAIGN_CLAIMER"', consumeIndex);
  assert.ok(replayIndex >= 0 && consumeIndex > replayIndex, "committed replay must bypass one-shot token consumption");
  assert.ok(projectionIndex > consumeIndex, "token must be consumed before campaign identity projection");
  assert.match(ledger, /const observationTokenRequired = activation\.active === true \|\| Number\(object\(job\.params\)\.observationTokenVersion \|\| 0\) >= 1/);
  assert.match(ledger, /CAMPAIGN_CLAIMER_OBSERVATION_TOKEN_REQUIRED/);
  assert.match(ledger, /identityObservedAt = strictDate\(consumed\.observedAt\)/);
});
