"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const route = fs.readFileSync(path.resolve(__dirname, "../routes/team-claims.js"), "utf8");

test("Claims mutations enforce granular capabilities instead of role names", () => {
  assert.match(route, /TEAM_CAPABILITIES\.OVERRIDE_ATTRIBUTION/);
  assert.match(route, /TEAM_CAPABILITIES\.CLAIM_OWN/);
  assert.match(route, /TEAM_CAPABILITIES\.RELEASE_OWN/);
  assert.match(route, /CLAIM_FORBIDDEN/);
  assert.match(route, /RELEASE_FORBIDDEN/);
  assert.doesNotMatch(route, /role\s*===\s*["']manager["']/i);
});

test("Claims list can be denied when member has neither agency-wide nor own-claim visibility", () => {
  assert.match(route, /!senior && !canClaimOwn && !canReleaseOwn/);
  assert.match(route, /CLAIMS_VIEW_FORBIDDEN/);
});

test("Claims reads and mutations apply assigned creator scope fail-closed", () => {
  assert.match(route, /assignedCreators:\s*true/);
  assert.match(route, /memberCreatorScope\(actor\)/);
  assert.match(route, /allowedCreatorIds/);
  assert.match(route, /creatorScopeWhere\(allowedCreatorIds\)/);
  assert.match(route, /creatorAllowed\(row\.creatorId, allowedCreatorIds\)/);
});
