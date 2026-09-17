"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const servicePath = path.join(__dirname, "creator-analytics-ledger-service.js");
const source = fs.readFileSync(servicePath, "utf8");

test("INT5.5B-2 campaign claimer identity uses DB receipt chronology, not attribution event time", () => {
  assert.match(source, /const identityObservedAt = serverReceivedAt;/);
  assert.match(source, /observedAt: identityObservedAt,/);
  assert.match(source, /activityObservedAt: identityObservedAt,/);
  assert.doesNotMatch(source, /const seenAt = claimer\.attributedAt \|\| serverReceivedAt;/);
});

test("INT5.5B-2 keeps attributedAt as historical campaign membership provenance", () => {
  assert.match(source, /attributedAt: claimer\.attributedAt,/);
  assert.match(source, /const attributedAt = existingAttributedAt && claimer\.attributedAt/);
  assert.match(source, /attributedAt,\n\s+sourceScanRunId:/);
});

test("INT5.5B-2 campaign value identity already uses server-owned authority receipt time", () => {
  assert.match(source, /async function upsertCampaignFanValueTx\([\s\S]*?const observedAt = strictDate\(authorityObservedAt\);/);
  assert.match(source, /projectFanIdentity\(tx, \{[\s\S]*?observedAt,[\s\S]*?source: "CAMPAIGN_CLAIMER"/);
});
