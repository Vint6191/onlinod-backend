"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(name) { return fs.readFileSync(path.join(__dirname, name), "utf8"); }

test("Team snapshot authority aggregates heavy summary work in PostgreSQL", () => {
  const analytics = source("team-analytics-service.js");
  assert.match(analytics, /buildTeamAnalyticsSnapshot/);
  assert.match(analytics, /GROUP BY d\."memberId"/);
  assert.match(analytics, /percentile_cont\(0\.5\)/);
  assert.match(analytics, /ROW_NUMBER\(\) OVER \(PARTITION BY g\."memberId"/);
  assert.match(analytics, /GROUP BY GROUPING SETS \(\(p\."ownerMemberId"\), \(\)\)/);
  assert.match(analytics, /includeMoney \? loadMoneySummarySql[\s\S]*: Promise\.resolve\(\[\]\)/);
  assert.doesNotMatch(analytics, /for \(let i = 0; i < num\(m\.responseSamples/);
});

test("Team pending GET is a pure read and legacy bootstrap repair is maintenance-owned", () => {
  const pending = source("team-pending-read-service.js");
  const listStart = pending.indexOf("async function listTeamPendingDialogs");
  const listEnd = pending.indexOf("module.exports", listStart);
  const listBody = pending.slice(listStart, listEnd);
  assert.doesNotMatch(listBody, /repairStaleLegacyBootstrapPending\(/);
  assert.match(pending, /repairStaleLegacyBootstrapPendingBatch/);
  assert.match(pending, /FOR UPDATE OF p SKIP LOCKED/);

  const scheduler = source("job-scheduler.js");
  assert.match(scheduler, /TEAM_LEGACY_PENDING_REPAIR_LANE_KEY/);
  assert.match(scheduler, /runMaintenanceLane/);
  assert.match(scheduler, /maybeRepairLegacyTeamPendingBootstrap/);
});

test("maintenance ownership is durable DB state rather than recurringSweepPromise", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const authority = source("maintenance-work-authority.js");
  assert.match(schema, /model MaintenanceLaneState/);
  assert.match(schema, /ownerToken[\s\S]*leaseUntil[\s\S]*nextRunAt[\s\S]*completedAt/);
  assert.match(authority, /dbAuthorityNow/);
  assert.match(authority, /withDbAdvisoryXactLock/);
  assert.match(authority, /generation_complete/);
});
