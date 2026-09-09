"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(ROOT, "prisma", "migrations", "20260909211500_phase2_current_work_coordination", "migration.sql"), "utf8");

function schemaModels() {
  const models = new Map();
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match;
  while ((match = re.exec(schema))) {
    const [, modelName, body] = match;
    const fields = new Set();
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
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
    const table = piece.match(/\nON\s+"([^"]+)"/);
    const cols = piece.match(/UPDATE OF([\s\S]*?)\nON\s+"[^"]+"/);
    const name = piece.match(/CREATE TRIGGER\s+"([^"]+)"/);
    assert.ok(table && cols && name, `cannot parse UPDATE OF trigger:\n${piece.slice(0, 300)}`);
    out.push({
      name: name[1],
      table: table[1],
      columns: Array.from(cols[1].matchAll(/"([^"]+)"/g), (m) => m[1]),
    });
  }
  return out;
}

function createTableColumns(table) {
  const match = migration.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `missing CREATE TABLE ${table}`);
  return new Set(Array.from(match[1].matchAll(/^\s*"([^"]+)"\s+/gm), (m) => m[1]));
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
  for (const table of ["MaintenanceLaneState", "ProviderOperationalDebt"]) {
    const ddl = createTableColumns(table);
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
