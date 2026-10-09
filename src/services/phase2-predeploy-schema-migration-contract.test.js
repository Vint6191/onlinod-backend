"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
const migrationFiles = [
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
  "20261009000000_current_baseline",
].map((name) => fs.readFileSync(path.join(ROOT, "prisma", "migrations", name, "migration.sql"), "utf8"));
const migration = migrationFiles.join("\n");
const allMigrationFiles = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).sort().map(name => path.join(ROOT, 'prisma/migrations', name, 'migration.sql')).filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8'));

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
  for (const text of allMigrationFiles) {
    const create = text.match(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? "${table}" \\(([\\s\\S]*?)\\n\\);`));
    if (create) {
      for (const match of create[1].matchAll(/^\s*"([^"]+)"\s+/gm)) columns.add(match[1]);
    }
    const alterBlocks = new RegExp(String.raw`ALTER TABLE "${table}"([\s\S]*?);`, "g");
    for (const block of text.matchAll(alterBlocks)) {
      for (const match of block[1].matchAll(/ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/g)) columns.add(match[1]);
      for (const match of block[1].matchAll(/DROP COLUMN(?: IF EXISTS)? "([^"]+)"/g)) columns.delete(match[1]);
      for (const match of block[1].matchAll(/RENAME COLUMN "([^"]+)" TO "([^"]+)"/g)) { columns.delete(match[1]); columns.add(match[2]); }
    }
  }
  assert.ok(columns.size > 0, `missing cumulative DDL for ${table}`);
  return columns;
}








test("Phase2 per-agency coverage activates new agencies without reopening global historical readiness", () => {
  const migration = fs.readFileSync(path.join(ROOT, "prisma", "migrations", "20261009000000_current_baseline", "migration.sql"), "utf8");
  assert.match(migration, /Agency_phase2_initial_coverage/);
  assert.match(migration, /NEW_AGENCY_AFTER_PHASE2_CUTOVER/);
  assert.match(migration, /PROVIDER_OPERATIONAL/);
  assert.match(migration, /CUSTOM_EXTERNAL_PROJECTION/);
});
