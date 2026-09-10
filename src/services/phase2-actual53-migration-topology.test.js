"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260910211500_phase2_actual53_final_closure/migration.sql"), "utf8");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");

test("Actual53 current-work locator indexes stay partial migration-only indexes instead of lying in Prisma schema", () => {
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_partition_idx"[\s\S]*?WHERE "isOutstanding"=TRUE;/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_class_idx"[\s\S]*?WHERE "isOutstanding"=TRUE;/);
  assert.doesNotMatch(schema, /map:\s*"DomainWorkItem_current_partition_idx"/);
  assert.doesNotMatch(schema, /map:\s*"DomainWorkItem_current_class_idx"/);
});

test("Actual53 migration seeds live family state and ready heads after outstanding work is moved to the active generation", () => {
  const generationMove = migration.indexOf('UPDATE "DomainWorkItem" d');
  const familySeed = migration.indexOf('INSERT INTO "Phase2WorkFamilyState"');
  const partitionSeed = migration.indexOf('INSERT INTO "DomainWorkReadyPartition"', familySeed);
  const readyTrigger = migration.indexOf('CREATE TRIGGER "trg_phase2_domain_work_ready_head"');
  assert.ok(generationMove >= 0 && familySeed > generationMove, "family-state seed must follow generation cutover");
  assert.ok(partitionSeed > familySeed, "ready-partition seed must follow family-state bootstrap");
  assert.ok(readyTrigger > partitionSeed, "initial ready heads must be bootstrapped before incremental trigger takes over");
});
