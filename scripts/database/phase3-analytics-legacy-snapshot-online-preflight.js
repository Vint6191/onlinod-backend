"use strict";

const prisma = require("../../src/prisma");

const TOMBSTONE_COMMENT = "Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain";
const LEGACY_RELATIONS = Object.freeze([
  Object.freeze({
    name: "AnalyticsSnapshot",
    requiredColumns: Object.freeze(["id", "agencyId", "scope", "rangeKey", "payload", "capturedAt", "createdAt", "updatedAt"]),
  }),
  Object.freeze({
    name: "CreatorCampaignsSnapshot",
    requiredColumns: Object.freeze(["id", "creatorId", "agencyId", "rangeKey", "campaigns", "totalActive", "totalClaimers", "totalClicks", "capturedAt", "capturedByDeviceId", "capturedByUserId", "createdAt", "updatedAt"]),
  }),
  Object.freeze({
    name: "CreatorEarningsSnapshot",
    requiredColumns: Object.freeze(["id", "creatorId", "agencyId", "rangeKey", "rangeStartAt", "rangeEndAt", "totalCents", "grossCents", "deltaCents", "salesCount", "uniqueFans", "avgSaleCents", "fanLtvCents", "raw", "capturedAt", "capturedByDeviceId", "capturedByUserId", "createdAt", "updatedAt"]),
  }),
]);

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function containsRequiredColumns(columns, requiredColumns) {
  const present = new Set((columns || []).map(String));
  return requiredColumns.every((column) => present.has(column));
}

function classifyLegacyRelation({ relkind, rowCount, comment, columns, requiredColumns }) {
  const physicalTable = relkind === "r" && containsRequiredColumns(columns, requiredColumns);
  const legacyTombstoneView = relkind === "v"
    && Number(rowCount) === 0
    && comment === TOMBSTONE_COMMENT
    && containsRequiredColumns(columns, requiredColumns);
  return {
    physicalTable,
    legacyTombstoneView,
    repairRequired: legacyTombstoneView,
    phaseASafe: physicalTable || legacyTombstoneView,
  };
}

async function relationState(definition, db = prisma) {
  const { name, requiredColumns } = definition;
  const rows = await db.$queryRawUnsafe(`
    SELECT c.relkind::text AS "relkind",
           obj_description(c.oid, 'pg_class') AS "comment"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = $1
    LIMIT 1
  `, name);
  const relkind = rows?.[0]?.relkind || null;
  const comment = rows?.[0]?.comment || null;

  const columnRows = relkind ? await db.$queryRawUnsafe(`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1
    ORDER BY ordinal_position ASC
  `, name) : [];
  const columns = columnRows.map((row) => row.columnName);

  let rowCount = null;
  if (relkind === "r" || relkind === "v") {
    const counts = await db.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS "count" FROM ${quoteIdentifier(name)}`);
    rowCount = Number(counts?.[0]?.count || 0);
  }

  const classification = classifyLegacyRelation({ relkind, rowCount, comment, columns, requiredColumns });
  return {
    name,
    relkind,
    rowCount,
    comment,
    columns,
    ...classification,
  };
}

async function main({ db = prisma } = {}) {
  const states = [];
  for (const definition of LEGACY_RELATIONS) states.push(await relationState(definition, db));
  const invalid = states.filter((state) => !state.phaseASafe);
  const repairRequired = states.some((state) => state.repairRequired);
  console.log(JSON.stringify({
    ok: invalid.length === 0,
    phase: "PHASE_A_ROLLING_COMPATIBILITY",
    relations: states,
    repairRequired,
    acceptedStates: ["physical_table", "known_zero_row_legacy_tombstone_view"],
    destructivePurgeAllowed: false,
    phaseBPolicy: "docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md",
  }, null, 2));
  if (invalid.length) {
    const error = new Error(`Phase 3 legacy snapshot preflight failed: expected physical tables or known zero-row tombstone views: ${invalid.map((row) => `${row.name}:${row.relkind || "missing"}`).join(", ")}`);
    error.code = "PHASE3_LEGACY_SNAPSHOT_PHASE_A_INCOMPATIBLE";
    throw error;
  }
}

module.exports = {
  TOMBSTONE_COMMENT,
  LEGACY_RELATIONS,
  containsRequiredColumns,
  classifyLegacyRelation,
  relationState,
  main,
};

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
