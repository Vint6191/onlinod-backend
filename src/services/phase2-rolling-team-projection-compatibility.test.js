"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

test("A46 rolling Team projection uses physical expand/contract compatibility tables", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260910144500_phase2_fresh_source_closure/migration.sql");
  const pendingRead = read("src/services/team-pending-read-service.js");
  const analytics = read("src/services/team-analytics-service.js");
  const scheduleScale = read("src/services/team-schedule-scale-read-service.js");

  assert.match(schema, /model TeamResponseCase \{[\s\S]*@@map\("TeamResponseCaseCurrent"\)/);
  assert.match(schema, /model TeamPendingDialogState \{[\s\S]*@@map\("TeamPendingDialogStateCurrent"\)/);

  // Metadata rename preserves already-built historical/current rows without a global copy.
  assert.match(migration, /ALTER TABLE "TeamResponseCase" RENAME TO "TeamResponseCaseCurrent"/);
  assert.match(migration, /ALTER TABLE "TeamPendingDialogState" RENAME TO "TeamPendingDialogStateCurrent"/);
  assert.doesNotMatch(migration, /INSERT INTO "TeamResponseCaseCurrent"\s+SELECT/i);
  assert.doesNotMatch(migration, /INSERT INTO "TeamPendingDialogStateCurrent"\s+SELECT/i);

  // Actual52's generated ON CONFLICT targets continue to exist on compatibility sinks.
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "TeamResponseCase_agencyId_replyMessageId_key"[\s\S]*ON "TeamResponseCase"\("agencyId","replyMessageId"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "TeamPendingDialogStateLegacy_identity_key"[\s\S]*ON "TeamPendingDialogState"\("agencyId","creatorId","dialogId"\)/);
  assert.match(migration, /DEFAULT 'team_response_v1'/);
  assert.match(migration, /DEFAULT 'team_pending_v1'/);

  // Current raw-SQL readers never hit the compatibility sinks.
  for (const source of [pendingRead, analytics, scheduleScale]) {
    assert.doesNotMatch(source, /FROM "TeamPendingDialogState"(?:\s|$)/);
    assert.doesNotMatch(source, /FROM "TeamResponseCase"(?:\s|$)/);
    assert.doesNotMatch(source, /JOIN "TeamResponseCase"(?:\s|$)/);
  }
  assert.match(pendingRead, /"TeamPendingDialogStateCurrent"/);
  assert.match(analytics, /"TeamResponseCaseCurrent"/);
  assert.match(scheduleScale, /"TeamResponseCaseCurrent"/);

  // Raw telemetry remains the independent producer for current-generation repair.
  const producer = read("prisma/migrations/20260910130000_phase2_final_current_work_ownership/migration.sql");
  assert.match(producer, /TeamActivityEvent_phase2_dialog_work/);
  assert.match(producer, /'TEAM_DIALOG_PROJECTION'/);
  assert.match(producer, /'TEAM_RESPONSE_RANGE_REPAIR'/);
});

test("A46 compatibility table DDL keeps old response identity while current model keeps creator scope", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260910144500_phase2_fresh_source_closure/migration.sql");
  const current = schema.match(/model TeamResponseCase \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(current, /@@unique\(\[agencyId, creatorId, replyMessageId\]\)/);
  assert.match(current, /@@map\("TeamResponseCaseCurrent"\)/);
  assert.match(migration, /ON "TeamResponseCase"\("agencyId","replyMessageId"\)/);
});
