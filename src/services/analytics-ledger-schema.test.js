"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260805215500_analytics_ledger_core_v1/migration.sql"),
  "utf8",
);
const hardeningMigration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260806002400_analytics_ledger_core_v1_hardening/migration.sql"),
  "utf8",
);

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test("analytics ledger core is relational and contains no business JSON fields", () => {
  for (const name of ["CreatorFan", "AnalyticsIngestBatch", "AnalyticsCoverage"]) {
    const body = modelBody(name);
    assert.doesNotMatch(body, /\bJson\??\b/, `${name} must not store JSON`);
  }
});

test("creator fan identity is creator-scoped and normal soft deletion preserves it", () => {
  const fan = modelBody("CreatorFan");
  assert.match(fan, /onlyFansUserId\s+String/);
  assert.match(fan, /@@unique\(\[creatorId, onlyFansUserId\]\)/);
  assert.match(fan, /creator CreatorAccount @relation\(fields: \[agencyId, creatorId\], references: \[agencyId, id\], onDelete: Cascade\)/);
  assert.match(hardeningMigration, /CreatorFan_seen_range_check/);
  assert.match(hardeningMigration, /CreatorFan_identity_length_check/);
});

test("ingest batches are versioned, checksummed, idempotent and traceable to a job", () => {
  const ingest = modelBody("AnalyticsIngestBatch");
  assert.match(ingest, /sourceJobId\s+String\?/);
  assert.match(ingest, /sourceJob\s+JobInstance\?/);
  assert.match(ingest, /idempotencyKey\s+String\s+@unique/);
  assert.match(ingest, /payloadChecksum\s+String/);
  assert.match(ingest, /collectorVersion\s+String/);
  assert.match(ingest, /schemaVersion\s+Int/);
  assert.match(migration, /AnalyticsIngestBatch_valid_range_check/);
  assert.match(migration, /AnalyticsIngestBatch_non_negative_counts_check/);
  assert.match(migration, /AnalyticsIngestBatch_processed_counts_check/);
  assert.match(migration, /AnalyticsIngestBatch_checksum_check/);
  assert.match(hardeningMigration, /AnalyticsIngestBatch_sourceJobId_fkey/);
  assert.match(hardeningMigration, /AnalyticsIngestBatch_terminal_state_check/);
  assert.match(hardeningMigration, /AnalyticsIngestBatch_committed_counts_check/);
  assert.match(hardeningMigration, /AnalyticsIngestBatch_rejected_counts_check/);
  assert.match(hardeningMigration, /AnalyticsIngestBatch_failed_error_check/);
});

test("coverage is day-scoped, timezone-aware and cannot claim contradictory terminal states", () => {
  const coverage = modelBody("AnalyticsCoverage");
  assert.match(coverage, /coverageDate\s+DateTime\s+@db\.Date/);
  assert.match(coverage, /sourceTimezone\s+String/);
  assert.match(coverage, /status\s+AnalyticsCoverageStatus/);
  assert.match(coverage, /sourceCursorStart\s+String\?/);
  assert.match(coverage, /sourceCursorEnd\s+String\?/);
  assert.match(coverage, /@@unique\(\[creatorId, dataType, coverageDate, sourceTimezone\]/);
  assert.match(migration, /AnalyticsCoverage_valid_interval_check/);
  assert.match(hardeningMigration, /AnalyticsCoverage_verified_state_check/);
  assert.match(hardeningMigration, /AnalyticsCoverage_partial_evidence_check/);
  assert.match(hardeningMigration, /AnalyticsCoverage_error_state_check/);
  assert.match(hardeningMigration, /AnalyticsCoverage_complete_state_check/);
  assert.match(hardeningMigration, /AnalyticsCoverage_missing_state_check/);
});

test("first migration creates explicit enums and the hardening migration preserves explicit hard delete", () => {
  assert.match(migration, /CREATE TYPE "AnalyticsDataType" AS ENUM/);
  assert.match(migration, /CREATE UNIQUE INDEX "CreatorFan_creatorId_onlyFansUserId_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "AnalyticsCoverage_creator_day_key"/);
  assert.match(schema, /@@unique\(\[agencyId, id\], map: "CreatorAccount_agencyId_id_key"\)/);
  assert.match(hardeningMigration, /FOREIGN KEY \("agencyId", "creatorId"\)[\s\S]*REFERENCES "CreatorAccount"\("agencyId", "id"\) ON DELETE CASCADE/);
  assert.match(migration, /REFERENCES "WorkerDevice"\("id"\) ON DELETE SET NULL/);
  assert.match(hardeningMigration, /REFERENCES "JobInstance"\("id"\) ON DELETE SET NULL/);
});
