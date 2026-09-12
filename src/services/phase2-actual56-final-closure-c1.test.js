"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260912001000_phase2_actual56_current_partition_conservation/migration.sql");
const zeroTransitionMigration = read("prisma/migrations/20260912006000_phase2_actual56_partition_counter_zero_transition/migration.sql");
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

test("C1 exceptional physical fallback serializes repair with the same partition transition fence", () => {
  for (const sql of [migration, zeroTransitionMigration]) {
    assert.match(sql, /phase2_domain_work_current_partition_lock_key/);
    assert.match(sql, /hashtextextended\([\s\S]*phase2:domain-work-current-partition:v1:/);
    assert.match(sql, /pg_advisory_xact_lock\(LEAST\(v_old_partition_lock,v_new_partition_lock\)\)/);
    assert.match(sql, /pg_advisory_xact_lock\(GREATEST\(v_old_partition_lock,v_new_partition_lock\)\)/);
    assert.match(sql, /phase2_lock_domain_work_current_partition/);
  }

  const rowLock = domainWork.indexOf('FOR UPDATE OF d SKIP LOCKED\n              LIMIT 1`');
  const partitionLock = domainWork.indexOf('SELECT "phase2_lock_domain_work_current_partition"($1,$2,$3)');
  const repairCount = domainWork.indexOf('partition_repair AS MATERIALIZED', partitionLock);
  assert.ok(rowLock >= 0 && partitionLock > rowLock && repairCount > partitionLock,
    "repair must own a DWI row, then wait for the partition fence, then COUNT in a later statement");
  assert.match(domainWork, /WHERE d\."id"=\$7[\s\S]*d\."partitionKey"=\$8/);
  assert.match(domainWork, /SELECT \$8::text AS "partitionKey",COUNT\(d\."id"\)::INTEGER AS "outstandingCount"/);
  assert.match(domainWork, /WHERE c\."outstandingCount" > 0/);
  assert.match(domainWork, /"activeGeneration","outstandingCount","lastClaimedAt"/);
  assert.match(domainWork, /"outstandingCount"=EXCLUDED\."outstandingCount"/);
  assert.doesNotMatch(domainWork, /\$queryRawUnsafe\s*\([\s\S]{0,180}?pg_advisory_xact_lock/);
});
