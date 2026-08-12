"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const claimsRoute = fs.readFileSync(path.resolve(__dirname, "../routes/team-claims.js"), "utf8");
const analyticsRoute = fs.readFileSync(path.resolve(__dirname, "../routes/team-analytics.js"), "utf8");

test("V9 tip discovery strips audit payload when money.view_audit is unavailable", () => {
  assert.match(claimsRoute, /TEAM_CAPABILITIES\.VIEW_AUDIT/);
  assert.match(claimsRoute, /function claimRowForViewer/);
  assert.match(claimsRoute, /canViewAudit \|\| isOwnClaimRow\(row, actorMemberId\)/);
  assert.match(claimsRoute, /history: \[\]/);
  assert.match(claimsRoute, /manualResolutions: \[\]/);
  assert.match(claimsRoute, /delete safe\.manualResolution/);
  assert.match(claimsRoute, /delete safe\.manualResolutions/);
  const disputable = claimsRoute.slice(claimsRoute.indexOf('router.get("/disputable"'), claimsRoute.indexOf('// --------------------------------------------------------------------\n// GET /api/team/claims/audit'));
  assert.match(disputable, /claimRowForViewer\(row, \{ actorMemberId: actor\.id, canViewAudit \}\)/);
});

test("V9 PPV conflict list keeps resolution capability separate from audit visibility", () => {
  const managerBlock = analyticsRoute.slice(analyticsRoute.indexOf("async function requirePpvClaimsManager"), analyticsRoute.indexOf('router.get("/ppv/resolve-jobs"'));
  assert.match(managerBlock, /TEAM_CAPABILITIES\.RESOLVE_ATTRIBUTION/);
  assert.match(managerBlock, /TEAM_CAPABILITIES\.VIEW_AUDIT/);
  assert.match(managerBlock, /return \{ agencyId: id, member, canViewAudit, allowedCreatorIds/);
  assert.match(managerBlock, /function ppvClaimForViewer/);
  assert.match(managerBlock, /audit: \[\]/);
  assert.match(managerBlock, /manualResolutions: \[\]/);
  assert.match(managerBlock, /delete result\.manualResolution/);
  assert.match(managerBlock, /delete result\.manualResolutions/);
  const conflictRoute = analyticsRoute.slice(analyticsRoute.indexOf('router.get("/ppv/conflicts"'), analyticsRoute.indexOf("const ppvConflictResolutionSchema"));
  assert.match(conflictRoute, /ppvClaimForViewer\(row, viewer\.canViewAudit\)/);
});
