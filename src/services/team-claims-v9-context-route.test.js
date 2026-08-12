"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const route = fs.readFileSync(path.resolve(__dirname, "../routes/team-claims.js"), "utf8");

test("V9 Claims context is server-authoritative and creator-scoped", () => {
  assert.match(route, /router\.get\("\/context"/);
  assert.match(route, /TEAM_CAPABILITIES\.VIEW_ATTRIBUTION/);
  assert.match(route, /TEAM_CAPABILITIES\.RESOLVE_ATTRIBUTION/);
  assert.match(route, /TEAM_CAPABILITIES\.OVERRIDE_ATTRIBUTION/);
  assert.match(route, /Array\.isArray\(allowedCreatorIds\)[\s\S]*id: \{ in:/);
  assert.match(route, /canResolveOthers[\s\S]*id: actor\.id/);
  assert.match(route, /creatorScope: Array\.isArray\(allowedCreatorIds\) \? allowedCreatorIds : "all"/);
});

test("V9 Claims context does not infer manager access from role names", () => {
  const block = route.slice(route.indexOf("async function claimsContext"), route.indexOf("// --------------------------------------------------------------------\n// GET /api/team/claims/context"));
  assert.doesNotMatch(block, /OWNER|MANAGER|ADMIN/);
  assert.match(block, /canUseTeamCapability/);
});


test("V9 Claims context does not turn write-only override into implicit read access", () => {
  const block = route.slice(route.indexOf("async function claimsContext"), route.indexOf("// --------------------------------------------------------------------\n// GET /api/team/claims/context"));
  assert.match(block, /const canViewClaims = viewAttribution \|\| claimOwn \|\| releaseOwn \|\| resolveAttribution \|\| viewAudit/);
  const expression = block.match(/const canViewClaims = ([^;]+);/)?.[1] || "";
  assert.doesNotMatch(expression, /overrideAttribution/);
});


test("V9 tip override accepts the same 120-character TeamTipLedger event hashes as ingest/audit", () => {
  const overrideStart = route.indexOf("const overrideSchema");
  const overrideEnd = route.indexOf('router.post("/override"', overrideStart);
  const overrideBlock = route.slice(overrideStart, overrideEnd);
  assert.match(overrideBlock, /eventHash: z\.string\(\)\.min\(1\)\.max\(120\)/);
});
