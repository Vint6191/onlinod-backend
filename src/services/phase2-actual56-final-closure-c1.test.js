"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260912001000_phase2_actual56_current_partition_conservation/migration.sql");
const zeroTransitionMigration = read("prisma/migrations/20260912006000_phase2_actual56_partition_counter_zero_transition/migration.sql");
const a36Migration = read("prisma/migrations/20260922183000_phase3_a36_domain_work_claim_shard_closure_v1/migration.sql");
const schema = read("prisma/schema.prisma");
const domainWork = read("src/services/domain-work-authority-service.js");

test("C1 current partition membership is a conserved counter, not snapshot NOT EXISTS cleanup", () => {
  assert.match(schema, /model Phase2WorkBroadClaimPartitionState[\s\S]*outstandingCount\s+Int\s+@default\(0\)/);
  assert.match(zeroTransitionMigration, /"outstandingCount"=f\."outstandingCount"-1/);
  assert.match(zeroTransitionMigration, /f\."outstandingCount" > 1/);
  assert.match(zeroTransitionMigration, /IF NOT FOUND THEN[\s\S]*DELETE FROM "Phase2WorkBroadClaimPartitionState"[\s\S]*f\."outstandingCount" = 1/);
  assert.doesNotMatch(zeroTransitionMigration, /GREATEST\(0,f\."outstandingCount"-1\)/);
  assert.match(zeroTransitionMigration, /"outstandingCount"\+1/);
  assert.doesNotMatch(migration, /IF NOT EXISTS\s*\([\s\S]*DomainWorkItem/);
  assert.match(migration, /COUNT\(\*\)::INTEGER[\s\S]*GROUP BY d\."agencyId",d\."workClass",d\."partitionKey",d\."activeGeneration"/);
  assert.match(migration, /CHECK \("outstandingCount" > 0\)/);
});

test("A36 exceptional physical fallback uses lower-only publication and revision-CAS reconciliation", () => {
  for (const sql of [migration, zeroTransitionMigration]) {
    assert.match(sql, /phase2_domain_work_current_partition_lock_key/);
    assert.match(sql, /hashtextextended\([\s\S]*phase2:domain-work-current-partition:v1:/);
    assert.match(sql, /pg_advisory_xact_lock\(LEAST\(v_old_partition_lock,v_new_partition_lock\)\)/);
    assert.match(sql, /pg_advisory_xact_lock\(GREATEST\(v_old_partition_lock,v_new_partition_lock\)\)/);
    assert.match(sql, /phase2_lock_domain_work_current_partition/);
  }

  const repairStart = domainWork.indexOf("Exceptional locator repair claims one physical row only");
  const rowLock = domainWork.indexOf("FOR UPDATE OF d SKIP LOCKED", repairStart);
  const partitionRepair = domainWork.indexOf("phase3_reconcile_domain_work_claim_partition", rowLock);
  const shardRepair = domainWork.indexOf("phase3_reconcile_domain_work_claim_shard", partitionRepair);
  const agencyRepair = domainWork.indexOf("phase3_reconcile_domain_work_claim_agency", shardRepair);
  assert.ok(rowLock >= 0 && partitionRepair > rowLock && shardRepair > partitionRepair && agencyRepair > shardRepair,
    "physical DWI claim must reconcile partition -> shard -> Agency in canonical order");
  assert.match(a36Migration, /"nextClaimableAt"=CASE[\s\S]*LEAST\(f\."nextClaimableAt",v_new_due\)/);
  assert.match(a36Migration, /CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_partition"/);
  assert.match(a36Migration, /p\."revision"=v_revision/);
  assert.match(a36Migration, /CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_shard"/);
  assert.match(a36Migration, /CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_agency"/);
  assert.doesNotMatch(domainWork, /phase2_lock_domain_work_current_partition/);
});
