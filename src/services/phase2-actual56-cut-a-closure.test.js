"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const migration = read("prisma/migrations/20260911210000_phase2_actual56_cut_a_current_work_topology/migration.sql");
const conservationMigration = read("prisma/migrations/20260912001000_phase2_actual56_current_partition_conservation/migration.sql");
const zeroTransitionMigration = read("prisma/migrations/20260912006000_phase2_actual56_partition_counter_zero_transition/migration.sql");
const domainWork = read("src/services/domain-work-authority-service.js");
const settings = read("src/services/settings-service.js");
const scheduler = read("src/services/job-scheduler.js");
const retirementFanout = read("src/services/telegram-account-retirement-fanout-service.js");

test("F56-01 partition fairness projection is current-only and race-safe", () => {
  assert.match(migration, /DELETE FROM "Phase2WorkBroadClaimPartitionState";/);
  assert.match(migration, /JOIN "Phase2WorkGenerationAuthority" g/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_broad_due_idx"/);
  assert.match(zeroTransitionMigration, /"outstandingCount"=f\."outstandingCount"-1/);
  assert.match(zeroTransitionMigration, /f\."outstandingCount" > 1/);
  assert.match(zeroTransitionMigration, /f\."outstandingCount" = 1/);
  assert.match(zeroTransitionMigration, /"outstandingCount"\+1/);
  assert.doesNotMatch(conservationMigration, /IF NOT EXISTS \([\s\S]*"DomainWorkItem" d/);
  assert.doesNotMatch(domainWork, /partition_heads|DISTINCT ON \(d\."partitionKey"\)|LIMIT 4096/i);
});

test("F56-03/F56-04 FamilyState is removed from hot current execution and lock graph", () => {
  assert.match(migration, /DROP TRIGGER IF EXISTS "trg_phase2_domain_work_family_state"/);
  assert.doesNotMatch(domainWork, /FROM "Phase2WorkFamilyState" s/);
  assert.doesNotMatch(domainWork, /UPDATE "Phase2WorkFamilyState" s/);
  assert.doesNotMatch(domainWork, /INSERT INTO "Phase2WorkFamilyState"/);
  assert.match(domainWork, /state: "CURRENT_WORK_PRESENT"/);
  assert.match(domainWork, /state: "NO_LIVE_WORK"/);
  assert.match(migration, /DomainWorkItem_current_family_probe_idx/);
});

test("F56-13 Telegram retirement publishes one durable key and detaches creator bindings in bounded worker batches", () => {
  assert.match(settings, /objectType: "TelegramAccountRetirement"/);
  assert.match(settings, /detachPending: true/);
  assert.doesNotMatch(settings, /creatorAccount\.updateMany\(\{ where: \{ agencyId, telegramAccountId: id \}/);
  assert.match(scheduler, /processTelegramAccountRetirementFanout/);
  assert.match(retirementFanout, /Math\.min\(100, Number\(batchSize\) \|\| 50\)/);
  assert.match(retirementFanout, /take,/);
  assert.match(retirementFanout, /telegramAccountId: accountId/);
  assert.match(retirementFanout, /data: \{ telegramAccountId: null \}/);
  assert.match(retirementFanout, /lifecycleState: "RETIRING"/);
});
