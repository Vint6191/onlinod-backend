"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
const migrationFiles = [
  "20260909211500_phase2_current_work_coordination",
  "20260910023000_phase2_authority_execution_consolidation",
  "20260910211500_phase2_actual53_final_closure",
  "20260911142000_phase2_actual55_root_a_execution_authority",
  "20260911150000_phase2_actual55_root_b_temporal_repair",
  "20260911162000_phase2_actual55_root_e_destructive_lifecycle",
  "20260911170000_phase2_actual55_fresh_source_destructive_fences",
  "20260911183000_phase2_actual55_int5_claim_temporal_destructive_closure",
  "20260911190000_phase2_actual55_int7_broad_partition_catalog",
  "20260911210000_phase2_actual56_cut_a_current_work_topology",
  "20260911213000_phase2_actual56_cut_e_lifecycle_access_authority",
  "20260912001000_phase2_actual56_current_partition_conservation",
  "20260912002000_phase2_actual56_management_lock_topology",
  "20260912003000_phase2_actual56_operational_pending_authority",
  "20260912004000_phase2_actual56_creator_management_catalog_authority",
  "20260912005000_phase2_actual56_rolling_release_fence",
  "20260912006000_phase2_actual56_partition_counter_zero_transition",
  "20260912007000_phase2_actual56_team_control_plane_release_activation",
].map((name) => fs.readFileSync(path.join(ROOT, "prisma", "migrations", name, "migration.sql"), "utf8"));
const migration = migrationFiles.join("\n");

function schemaModels() {
  const models = new Map();
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match;
  while ((match = re.exec(schema))) {
    const [, modelName, body] = match;
    const fields = new Set();
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@") || line.includes("@relation(")) continue;
      const fm = line.match(/^(\w+)\s+/);
      if (!fm) continue;
      const mapped = line.match(/@map\("([^"]+)"\)/);
      fields.add(mapped ? mapped[1] : fm[1]);
    }
    models.set(modelName, fields);
  }
  return models;
}

function updateOfTriggers() {
  const out = [];
  const pieces = migration.split(/(?=CREATE TRIGGER\s+)/g);
  for (const piece of pieces) {
    if (!/^CREATE TRIGGER\s+/m.test(piece) || !/UPDATE OF/.test(piece)) continue;
    const header = piece.match(/CREATE TRIGGER\s+(?:"([^"]+)"|([A-Za-z0-9_]+))[\s\S]*?UPDATE OF([\s\S]*?)\s+ON\s+"([^"]+)"/);
    assert.ok(header, `cannot parse UPDATE OF trigger:\n${piece.slice(0, 300)}`);
    out.push({
      name: header[1] || header[2],
      table: header[4],
      columns: Array.from(header[3].matchAll(/"([^"]+)"/g), (m) => m[1]),
    });
  }
  return out;
}

function cumulativeTableColumns(table) {
  const columns = new Set();
  for (const text of migrationFiles) {
    const create = text.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`));
    if (create) {
      for (const match of create[1].matchAll(/^\s*"([^"]+)"\s+/gm)) columns.add(match[1]);
    }
    const alterBlocks = new RegExp(String.raw`ALTER TABLE "${table}"([\s\S]*?);`, "g");
    for (const block of text.matchAll(alterBlocks)) {
      for (const match of block[1].matchAll(/ADD COLUMN IF NOT EXISTS "([^"]+)"/g)) columns.add(match[1]);
    }
  }
  assert.ok(columns.size > 0, `missing cumulative DDL for ${table}`);
  return columns;
}


test("Phase2 trigger UPDATE OF columns exist in current Prisma models", () => {
  const models = schemaModels();
  const triggers = updateOfTriggers();
  assert.ok(triggers.length >= 5, "expected Phase2 current-work UPDATE OF triggers");
  for (const trigger of triggers) {
    const fields = models.get(trigger.table);
    assert.ok(fields, `${trigger.name}: Prisma model ${trigger.table} missing`);
    for (const column of trigger.columns) {
      assert.ok(fields.has(column), `${trigger.name}: ${trigger.table}.${column} missing from schema.prisma`);
    }
  }
});

test("Phase2 current-work table DDL matches Prisma storage fields", () => {
  const models = schemaModels();
  for (const table of ["MaintenanceLaneState", "ProviderOperationalDebt", "DomainWorkItem", "Phase2WorkCoverage", "Phase2DependencyState", "Phase2ReleaseCompatibilityAuthority"]) {
    const ddl = cumulativeTableColumns(table);
    const fields = models.get(table);
    assert.ok(fields, `Prisma model ${table} missing`);
    for (const field of fields) {
      assert.ok(ddl.has(field), `${table}.${field} exists in Prisma but not migration CREATE TABLE`);
    }
    for (const column of ddl) {
      assert.ok(fields.has(column), `${table}.${column} exists in migration but not Prisma model`);
    }
  }
});

test("Phase2 CustomOrder projection fields and mapped indexes stay aligned", () => {
  const models = schemaModels();
  const customOrder = models.get("CustomOrder");
  for (const field of ["providerOperationalDirty", "providerOperationalProjectedAt", "providerOperationalProjectionVersion"]) {
    assert.ok(customOrder?.has(field), `CustomOrder.${field} missing`);
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${field}"`));
  }
  for (const index of [
    "CustomOrder_provider_operational_work_idx",
    "ProviderOperationalDebt_identity_key",
    "ProviderOperationalDebt_account_work_idx",
    "ProviderOperationalDebt_creator_work_idx",
    "ProviderOperationalDebt_order_idx",
    "ProviderOperationalDebt_submission_idx",
    "MaintenanceLaneState_leaseUntil_idx",
    "MaintenanceLaneState_due_idx",
  ]) {
    assert.match(schema, new RegExp(index));
    assert.match(migration, new RegExp(index));
  }
});

test("Phase2 per-agency coverage activates new agencies without reopening global historical readiness", () => {
  const migration = fs.readFileSync(path.join(ROOT, "prisma", "migrations", "20260910023000_phase2_authority_execution_consolidation", "migration.sql"), "utf8");
  assert.match(migration, /Agency_phase2_initial_coverage/);
  assert.match(migration, /NEW_AGENCY_AFTER_PHASE2_CUTOVER/);
  assert.match(migration, /PROVIDER_OPERATIONAL/);
  assert.match(migration, /CUSTOM_EXTERNAL_PROJECTION/);
});
