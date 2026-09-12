"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const c1 = read("prisma/migrations/20260912001000_phase2_actual56_current_partition_conservation/migration.sql");
const c6 = read("prisma/migrations/20260912004000_phase2_actual56_creator_management_catalog_authority/migration.sql");
const m1 = read("prisma/migrations/20260912005000_phase2_actual56_rolling_release_fence/migration.sql");
const c1Followup = read("prisma/migrations/20260912006000_phase2_actual56_partition_counter_zero_transition/migration.sql");

function isExplicitTransaction(sql) {
  return /^\s*(?:--[^\n]*\n\s*)*BEGIN;/m.test(sql) && /COMMIT;\s*$/.test(sql);
}

test("Phase2 C1 publishes a valid conserved projection in one rolling-safe migration", () => {
  assert.equal(isExplicitTransaction(c1), true, "C1 baseline rebuild must be one PostgreSQL transaction");
  const dwiLock = c1.indexOf('LOCK TABLE "DomainWorkItem" IN SHARE ROW EXCLUSIVE MODE');
  const projectionLock = c1.indexOf('LOCK TABLE "Phase2WorkBroadClaimPartitionState" IN SHARE ROW EXCLUSIVE MODE');
  const rebuild = c1.indexOf('DELETE FROM "Phase2WorkBroadClaimPartitionState"');
  assert.ok(dwiLock >= 0 && projectionLock > dwiLock && rebuild > projectionLock,
    "migration must fence DWI writers before rebuilding projection truth");

  // The first externally visible C1 schema must already support the legal 1 -> absent
  // transition. It may not rely on a later migration to repair an interval where the
  // CHECK(outstandingCount > 0) makes ordinary final settlement fail.
  assert.match(c1, /f\."outstandingCount" > 1/);
  assert.match(c1, /IF NOT FOUND THEN[\s\S]*f\."outstandingCount" = 1/);
  assert.doesNotMatch(c1, /GREATEST\(0,f\."outstandingCount"-1\)/);
  assert.match(c1, /CHECK \("outstandingCount" > 0\)/);
  assert.match(c1, /CREATE OR REPLACE FUNCTION "phase2_domain_work_current_partition_lock_key"/);
  assert.match(c1, /hashtextextended\([\s\S]*phase2:domain-work-current-partition:v1:/);
  assert.match(c1, /pg_advisory_xact_lock\(LEAST\(v_old_partition_lock,v_new_partition_lock\)\)/);
  assert.match(c1, /CREATE OR REPLACE FUNCTION "phase2_lock_domain_work_current_partition"/);

  // The follow-up remains idempotent compatibility hardening, not the first point at
  // which the migration chain becomes valid.
  assert.doesNotMatch(c1Followup, /GREATEST\(0,f\."outstandingCount"-1\)/);
  assert.match(c1Followup, /f\."outstandingCount" > 1/);
});

test("Phase2 C6 creator-catalog baseline and membership trigger become visible atomically", () => {
  assert.equal(isExplicitTransaction(c6), true, "creator catalog cutover must be transactional");
  const lock = c6.indexOf('LOCK TABLE "CreatorAccount" IN SHARE ROW EXCLUSIVE MODE');
  const baseline = c6.indexOf('INSERT INTO "AgencyCreatorCatalogState"');
  const trigger = c6.indexOf('CREATE TRIGGER trg_phase2_creator_catalog_generation');
  assert.ok(lock >= 0 && baseline > lock && trigger > baseline,
    "CreatorAccount writers must be fenced between catalog snapshot and trigger publication");
});

test("Phase2 M1 release authority and all DB writer fences publish as one cutover", () => {
  assert.equal(isExplicitTransaction(m1), true, "M1 authority migration must be transactional");
  const authority = m1.indexOf('INSERT INTO "Phase2ReleaseCompatibilityAuthority"');
  const creatorFence = m1.indexOf('CREATE TRIGGER "trg_phase2_creator_account_release_writer"');
  const memberFence = m1.indexOf('CREATE TRIGGER "trg_phase2_agency_member_physical_delete"');
  const executorFence = m1.indexOf('CREATE TRIGGER "trg_phase2_domain_work_executor_release"');
  assert.ok(authority >= 0 && creatorFence > authority && memberFence > creatorFence && executorFence > memberFence,
    "release generation and retired-writer triggers must share one atomic visibility boundary");
});
