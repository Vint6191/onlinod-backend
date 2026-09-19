"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const servicePath = path.join(__dirname, "creator-analytics-ledger-service.js");
const source = fs.readFileSync(servicePath, "utf8");

test("INT5.5B-2/A3 campaign claimer identity never uses attribution event time and causal jobs override receipt chronology", () => {
  assert.match(source, /let identityObservedAt = serverReceivedAt;/);
  assert.match(source, /identityObservedAt = strictDate\(consumed\.observedAt\);/);
  assert.match(source, /observedAt: identityObservedAt,/);
  assert.match(source, /activityObservedAt: identityObservedAt,/);
  assert.doesNotMatch(source, /const seenAt = claimer\.attributedAt \|\| serverReceivedAt;/);
});

test("INT5.5B-2 keeps attributedAt as historical campaign membership provenance", () => {
  assert.match(source, /attributedAt: claimer\.attributedAt \? claimer\.attributedAt\.toISOString\(\) : null/);
  assert.match(source, /ELSE LEAST\("CreatorCampaignFan"\."attributedAt", EXCLUDED\."attributedAt"\)/);
  assert.match(source, /NULLIF\(a\."attributedAt", ''\)::timestamptz/);
});

test("INT5.5B-2/A4 campaign value identity uses server-owned authority time and causal jobs consume post-read token chronology", () => {
  assert.match(source, /async function upsertCampaignFanValueTx\([\s\S]*?const observedAt = strictDate\(authorityObservedAt\);/);
  assert.match(source, /projectFanIdentity\(tx, \{[\s\S]*?observedAt,[\s\S]*?source: "CAMPAIGN_CLAIMER"/);
  assert.match(source, /purpose: "campaign_fan_values"/);
  assert.match(source, /const observedAt = strictDate\(consumed\.observedAt\)/);
});
