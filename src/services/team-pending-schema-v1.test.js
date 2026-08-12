"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260812101500_team_pending_projector_v1/migration.sql");
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

test("pending queue has one durable current state per agency/creator/dialog and raw projection cursor", () => {
  const body = modelBody("TeamPendingDialogState");
  assert.match(body, /@@unique\(\[agencyId, creatorId, dialogId\]\)/);
  assert.match(body, /firstIncomingMessageId\s+String\?/);
  assert.match(body, /firstSeenMemberId\s+String\?/);
  assert.match(body, /ownerMemberId\s+String\?/);
  assert.match(body, /ownerReason\s+String\?/);
  assert.match(body, /repliedByMemberId\s+String\?/);
  const event = modelBody("TeamActivityEvent");
  assert.match(event, /pendingProjectionVersion\s+String\?/);
  assert.match(event, /pendingProjectedAt\s+DateTime\?/);
  assert.match(migration, /CREATE TABLE "TeamPendingDialogState"/);
  assert.doesNotMatch(migration, /DROP\s|TRUNCATE\s|DELETE\s+FROM/i);
});

test("pending projection is part of durable ingest and automation cannot clear human queue", () => {
  assert.match(ingest, /applyTeamPendingProjection/);
  assert.match(projector, /MESSAGE_SEND_CONFIRMED/);
  assert.match(projector, /actionSource[^\n]+MANUAL/);
  assert.match(projector, /non_manual_send/);
  assert.match(projector, /DIALOG_SEEN_HANDOFF/);
  assert.match(projector, /messageId[\s\S]{0,120}localId[\s\S]{0,120}id/);
});

test("historical pending repair is DB-only, cursor-driven and scheduled as non-blocking maintenance", () => {
  assert.match(projector, /pendingProjectionVersion: null/);
  assert.match(projector, /backfillTeamPendingProjectionBatch/);
  assert.match(scheduler, /TEAM_PENDING_BACKFILL_BATCH_SIZE = 500/);
  assert.match(scheduler, /maybeBackfillTeamPendingProjection/);
  assert.match(scheduler, /Team pending projection backfill failed/);
});

test("overview switches unanswered source to projected queue and exposes scoped pending diagnostics", () => {
  assert.match(analytics, /unansweredSource: hasProjectedPending \? "team_pending_dialog_v1"/);
  assert.match(analytics, /unassignedUnansweredCount/);
  assert.match(analytics, /oldestUnansweredSeconds/);
  assert.match(routes, /router\.get\("\/pending"/);
  assert.match(routes, /requireTeamAnalyticsViewer/);
});
