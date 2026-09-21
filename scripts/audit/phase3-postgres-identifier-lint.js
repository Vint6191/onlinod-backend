#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const LEGACY_CUTOFF = "20260921111500_phase3_a30_constraint_name_render_gate_repair_v1";

function quotedIdentifiers(sql) {
  return [...String(sql || "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}
function main() {
  const migrations = fs.readdirSync(MIGRATIONS).sort();
  const oversized = [];
  const truncations = new Map();
  for (const migration of migrations) {
    const file = path.join(MIGRATIONS, migration, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, "utf8");
    for (const identifier of quotedIdentifiers(sql)) {
      const bytes = Buffer.byteLength(identifier, "utf8");
      if (bytes <= POSTGRES_IDENTIFIER_MAX_BYTES) continue;
      const physical = Buffer.from(identifier, "utf8").subarray(0, POSTGRES_IDENTIFIER_MAX_BYTES).toString("utf8");
      const row = { migration, identifier, bytes, physical };
      oversized.push(row);
      const list = truncations.get(physical) || [];
      if (!list.some((item) => item.identifier === identifier)) list.push(row);
      truncations.set(physical, list);
    }
  }
  const collisions = [...truncations.entries()]
    .filter(([, rows]) => new Set(rows.map((row) => row.identifier)).size > 1)
    .map(([physical, rows]) => ({ physical, rows }));
  const newOversized = oversized.filter((row) => row.migration > LEGACY_CUTOFF);
  const result = {
    ok: collisions.length === 0 && newOversized.length === 0,
    maxBytes: POSTGRES_IDENTIFIER_MAX_BYTES,
    historicalOversized: oversized.length,
    newOversized,
    collisions,
  };
  console.log(`PHASE3_POSTGRES_IDENTIFIER_LINT ${JSON.stringify(result)}`);
  if (!result.ok) process.exitCode = 3;
  return result;
}

if (require.main === module) main();
module.exports = { main, quotedIdentifiers, POSTGRES_IDENTIFIER_MAX_BYTES, LEGACY_CUTOFF };
