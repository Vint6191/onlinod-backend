"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20261009000000_current_baseline/migration.sql");
const projector = read("src/services/team-pending-projection-service.js");
const ingest = read("src/services/telemetry-ingest-service.js");
const scheduler = read("src/services/job-scheduler.js");
const analytics = read("src/services/team-analytics-service.js");
const routes = read("src/routes/team-analytics.js");

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}



test("pending projection is part of durable ingest and automation cannot clear human queue", () => {
  assert.match(ingest, /applyTeamPendingProjection/);
  assert.match(projector, /MESSAGE_SEND_CONFIRMED/);
  assert.match(projector, /actionSource[^\n]+MANUAL/);
  assert.match(projector, /non_manual_send/);
  assert.match(projector, /DIALOG_SEEN_HANDOFF/);
  assert.match(projector, /messageId[\s\S]{0,120}localId[\s\S]{0,120}id/);
});

test("historical pending repair is per-agency bounded DomainWork coverage, not a recurring current writer", () => {
  assert.match(projector, /backfillTeamPendingProjectionBatch/);
  assert.match(scheduler, /runTeamDialogCoverageEnumerationUnit/);
  assert.match(scheduler, /listUnprojectedRelevantDialogEvents/);
  assert.match(scheduler, /limit:\s*100/);
  assert.match(scheduler, /PHASE2_COVERAGE_FAMILY\.TEAM_DIALOG_PROJECTION/);
  assert.match(scheduler, /yieldDomainWorkClaim/);
  const compatibilityStart = scheduler.indexOf("async function maybeBackfillTeamPendingProjection");
  const compatibilityEnd = scheduler.indexOf("async function maybeRepairLegacyTeamPendingBootstrap", compatibilityStart);
  const compatibility = scheduler.slice(compatibilityStart, compatibilityEnd);
  assert.match(compatibility, /runTeamDialogProjectionSweep/);
  assert.doesNotMatch(compatibility, /runMaintenanceLane|TEAM_PENDING_PROJECTION_LANE_KEY/);
});

test("overview switches unanswered source to projected queue and exposes scoped pending diagnostics", () => {
  assert.match(analytics, /unansweredSource: hasProjectedPending \? "team_pending_dialog_v1"/);
  assert.match(analytics, /unassignedUnansweredCount/);
  assert.match(analytics, /oldestUnansweredSeconds/);
  assert.match(routes, /router\.get\("\/pending"/);
  assert.match(routes, /requireTeamAnalyticsViewer/);
});
