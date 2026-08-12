"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const route = fs.readFileSync(path.join(__dirname, "../routes/telemetry.js"), "utf8");

test("raw Team telemetry diagnostics require analytics capability and assigned creator scope", () => {
  assert.match(route, /TEAM_CAPABILITIES\.VIEW_ANALYTICS/);
  assert.match(route, /canUseTeamCapability/);
  assert.match(route, /assignedCreators/);
  assert.match(route, /creatorId:\s*\{\s*in:/);
  assert.match(route, /moneyVisible/);
  assert.match(route, /priceCents:\s*null/);
  assert.doesNotMatch(route, /findMany\(\{\s*where:\s*\{\s*agencyId:\s*req\.auth\.agencyId\s*\}\s*,\s*orderBy/s);
});

test("v13 ingest returns per-row acknowledgement identities for durable outbox reconciliation", () => {
  const service = fs.readFileSync(path.join(__dirname, "telemetry-ingest-service.js"), "utf8");
  assert.match(service, /acknowledgedLocalIds/);
  assert.match(service, /rejectedEvents/);
  assert.match(service, /human_actor_mismatch/);
  assert.match(service, /creator_not_found/);
});

test("coverage recompute has no fixed reply-count truncation", () => {
  const projection = fs.readFileSync(path.join(__dirname, "team-response-projection-service.js"), "utf8");
  assert.doesNotMatch(projection, /MAX_RECOMPUTE_REPLIES/);
  const block = projection.match(/async function recomputeRepliesForCoverage[\s\S]*?return count;\n\}/)?.[0] || "";
  assert.ok(block, "recomputeRepliesForCoverage exists");
  assert.doesNotMatch(block, /take:\s*\d+/);
});
