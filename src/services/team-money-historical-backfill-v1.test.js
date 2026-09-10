"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const scheduler = read("src/services/job-scheduler.js");
const service = read("src/services/team-money-reconciliation-service.js");
const claims = read("src/routes/team-claims.js");

function functionBlock(name, nextName) {
  const start = scheduler.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = nextName ? scheduler.indexOf(`async function ${nextName}`, start + 1) : -1;
  return scheduler.slice(start, end > start ? end : undefined);
}

test("historical Team money no longer exposes a direct global reconciliation writer", () => {
  assert.doesNotMatch(service, /async function reconcileHistoricalTeamMoneyBatch|reconcileHistoricalTeamMoneyBatch\s*,/);
  assert.doesNotMatch(claims, /reconcileHistoricalTeamMoneyBatch|reconcileCreatorSalesToTeam|reconcileCreatorTipsToTeam/);
});

test("historical sales/tips are enumerated per agency in bounded pages and publish exact DomainWork", () => {
  const body = functionBlock("runTeamMoneyReconciliationCoverageEnumerationUnit", "runTeamReadSummaryCoverageEnumerationUnit");
  assert.match(body, /const agencyId = String\(item\.agencyId\)/);
  assert.match(body, /phase === "sales" \|\| phase === "tips"/);
  assert.match(body, /where = \{ agencyId/);
  assert.match(body, /where\.saleType = "MESSAGE"/);
  assert.match(body, /orderBy: \{ id: "asc" \}, take: 100/);
  assert.match(body, /PHASE2_WORK_CLASS\.TEAM_MONEY_RECONCILIATION/);
  assert.match(body, /objectType: phase === "sales" \? "CreatorSale" : "CreatorTip"/);
  assert.match(body, /yieldDomainWorkClaim/);
});

test("historical enumeration does not activate until exact money work has converged", () => {
  const body = functionBlock("runTeamMoneyReconciliationCoverageEnumerationUnit", "runTeamReadSummaryCoverageEnumerationUnit");
  assert.match(body, /hasOutstandingDomainWork/);
  assert.match(body, /PHASE2_WORK_CLASS\.TEAM_MONEY_RECONCILIATION/);
  assert.match(body, /if \(outstanding\)/);
  assert.ok(body.indexOf("if (outstanding)") < body.indexOf("markPhase2CoverageComplete"));
});
