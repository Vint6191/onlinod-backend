"use strict";

const prisma = require("../../src/prisma");

const LEGACY_RELATIONS = Object.freeze([
  Object.freeze({
    name: "AnalyticsSnapshot",
    requiredColumns: Object.freeze(["id", "agencyId", "scope", "rangeKey", "payload", "capturedAt", "createdAt", "updatedAt"]),
    requiredIndexes: Object.freeze(["AnalyticsSnapshot_pkey", "AnalyticsSnapshot_agencyId_scope_rangeKey_key"]),
  }),
  Object.freeze({
    name: "CreatorCampaignsSnapshot",
    requiredColumns: Object.freeze(["id", "creatorId", "agencyId", "rangeKey", "campaigns", "totalActive", "totalClaimers", "totalClicks", "capturedAt", "capturedByDeviceId", "capturedByUserId", "createdAt", "updatedAt"]),
    requiredIndexes: Object.freeze(["CreatorCampaignsSnapshot_pkey", "CreatorCampaignsSnapshot_creatorId_key"]),
  }),
  Object.freeze({
    name: "CreatorEarningsSnapshot",
    requiredColumns: Object.freeze(["id", "creatorId", "agencyId", "rangeKey", "rangeStartAt", "rangeEndAt", "totalCents", "grossCents", "deltaCents", "salesCount", "uniqueFans", "avgSaleCents", "fanLtvCents", "raw", "capturedAt", "capturedByDeviceId", "capturedByUserId", "createdAt", "updatedAt"]),
    requiredIndexes: Object.freeze(["CreatorEarningsSnapshot_pkey", "CreatorEarningsSnapshot_creator_range_key"]),
  }),
]);

function containsAll(values, requiredValues) {
  const present = new Set((values || []).map(String));
  return requiredValues.every((value) => present.has(value));
}

async function relationState(definition, db = prisma) {
  const rows = await db.$queryRawUnsafe(`
    SELECT c.relkind::text AS "relkind"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = $1
    LIMIT 1
  `, definition.name);
  const relkind = rows?.[0]?.relkind || null;
  const columnRows = relkind ? await db.$queryRawUnsafe(`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1
    ORDER BY ordinal_position ASC
  `, definition.name) : [];
  const indexRows = relkind === "r" ? await db.$queryRawUnsafe(`
    SELECT indexname AS "indexName"
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = $1
    ORDER BY indexname ASC
  `, definition.name) : [];
  const columns = columnRows.map((row) => row.columnName);
  const indexes = indexRows.map((row) => row.indexName);
  const valid = relkind === "r"
    && containsAll(columns, definition.requiredColumns)
    && containsAll(indexes, definition.requiredIndexes);
  return {
    name: definition.name,
    relkind,
    physicalTable: relkind === "r",
    requiredColumnsPresent: containsAll(columns, definition.requiredColumns),
    requiredIndexesPresent: containsAll(indexes, definition.requiredIndexes),
    indexes,
    valid,
  };
}

async function main({ db = prisma } = {}) {
  const states = [];
  for (const definition of LEGACY_RELATIONS) states.push(await relationState(definition, db));
  const invalid = states.filter((state) => !state.valid);
  console.log(JSON.stringify({
    ok: invalid.length === 0,
    phase: "PHASE_A_POST_MIGRATION_WRITABLE_COMPATIBILITY",
    relations: states,
    destructivePurgeAllowed: false,
  }, null, 2));
  if (invalid.length) {
    const error = new Error(`Phase 3 legacy snapshot postflight failed: writable compatibility was not restored: ${invalid.map((row) => `${row.name}:${row.relkind || "missing"}`).join(", ")}`);
    error.code = "PHASE3_LEGACY_SNAPSHOT_PHASE_A_POSTFLIGHT_FAILED";
    throw error;
  }
}

module.exports = { LEGACY_RELATIONS, containsAll, relationState, main };

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => null);
    });
}
