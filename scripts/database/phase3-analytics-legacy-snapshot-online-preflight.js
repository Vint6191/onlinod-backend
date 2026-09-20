"use strict";

const prisma = require("../../src/prisma");

const LEGACY_RELATIONS = Object.freeze([
  "AnalyticsSnapshot",
  "CreatorCampaignsSnapshot",
  "CreatorEarningsSnapshot",
]);

async function relationState(name) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT c.relkind::text AS "relkind"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = $1
    LIMIT 1
  `, name);
  const relkind = rows?.[0]?.relkind || null;
  let rowCount = null;
  if (relkind === "r") {
    const quoted = `"${String(name).replace(/"/g, '""')}"`;
    const counts = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS "count" FROM ${quoted}`);
    rowCount = Number(counts?.[0]?.count || 0);
  }
  return { name, relkind, rowCount, physicalTable: relkind === "r" };
}

async function main() {
  const states = [];
  for (const name of LEGACY_RELATIONS) states.push(await relationState(name));
  const invalid = states.filter((state) => !state.physicalTable);
  console.log(JSON.stringify({
    ok: invalid.length === 0,
    phase: "PHASE_A_ROLLING_COMPATIBILITY",
    relations: states,
    destructivePurgeAllowed: false,
    phaseBPolicy: "docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md",
  }, null, 2));
  if (invalid.length) {
    const error = new Error(`Phase 3 legacy snapshot preflight failed: expected physical tables: ${invalid.map((row) => `${row.name}:${row.relkind || "missing"}`).join(", ")}`);
    error.code = "PHASE3_LEGACY_SNAPSHOT_PHASE_A_INCOMPATIBLE";
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
