"use strict";

const REQUIRED_COLUMNS = [
  "userId",
  "agencyId",
  "deviceId",
  "authorizationSessionId",
  "expiresAt",
  "revokedAt",
  "lastUsedAt",
  "createdAt",
];

const INDEXES = [
  {
    name: "RefreshSession_live_authorization_lookup_idx",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshSession_live_authorization_lookup_idx"
      ON "RefreshSession"(
        "userId", "agencyId", "deviceId", "authorizationSessionId", "expiresAt" DESC
      ) INCLUDE ("id")
      WHERE "revokedAt" IS NULL`,
    markers: ["userid", "agencyid", "deviceid", "authorizationsessionid", "expiresat", "revokedat"],
  },
  {
    name: "RefreshSession_live_lineage_lookup_idx",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshSession_live_lineage_lookup_idx"
      ON "RefreshSession"(
        "authorizationSessionId", "userId", "agencyId", "deviceId", "expiresAt" DESC
      ) INCLUDE ("id")
      WHERE "revokedAt" IS NULL AND "authorizationSessionId" IS NOT NULL`,
    markers: ["authorizationsessionid", "userid", "agencyid", "deviceid", "expiresat", "revokedat", "is not null"],
  },
  {
    name: "RefreshSession_authorization_history_idx",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshSession_authorization_history_idx"
      ON "RefreshSession"(
        "authorizationSessionId", "agencyId", "userId", "expiresAt" DESC
      )
      WHERE "authorizationSessionId" IS NOT NULL`,
    markers: ["authorizationsessionid", "agencyid", "userid", "expiresat", "is not null"],
  },
  {
    name: "RefreshSession_live_user_lookup_idx",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshSession_live_user_lookup_idx"
      ON "RefreshSession"(
        "userId", "expiresAt" DESC, "lastUsedAt" DESC, "createdAt" DESC
      ) INCLUDE (
        "id", "agencyId", "deviceId", "authorizationSessionId", "rememberDevice"
      )
      WHERE "revokedAt" IS NULL`,
    markers: ["userid", "expiresat", "lastusedat", "createdat", "revokedat"],
  },
  {
    name: "RefreshSession_live_agency_lookup_idx",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshSession_live_agency_lookup_idx"
      ON "RefreshSession"(
        "agencyId", "expiresAt" DESC, "userId", "deviceId"
      ) INCLUDE ("id", "authorizationSessionId")
      WHERE "revokedAt" IS NULL`,
    markers: ["agencyid", "expiresat", "userid", "deviceid", "revokedat"],
  },
  {
    name: "RefreshSession_user_history_created_idx",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshSession_user_history_created_idx"
      ON "RefreshSession"("userId", "createdAt" DESC)`,
    markers: ["userid", "createdat"],
  },
];

function fail(message) {
  const error = new Error(message);
  error.code = "ACTUAL60_ONLINE_INDEX_ENSURE_FAILED";
  throw error;
}

function compact(value) {
  return String(value || "").toLowerCase().replace(/[\s"(),]/g, "");
}

async function currentIndex(db, name) {
  const rows = await db.$queryRawUnsafe(`
    SELECT
      c.relname AS name,
      i.indisvalid AS valid,
      i.indisready AS ready,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'RefreshSession'
      AND c.relname = $1
    LIMIT 1
  `, name);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function assertDefinition(spec, row) {
  if (!row?.valid || !row?.ready) fail(`${spec.name} is not valid/ready`);
  const normalized = compact(row.definition);
  let cursor = -1;
  for (const marker of spec.markers) {
    const needle = compact(marker);
    const next = normalized.indexOf(needle, cursor + 1);
    if (next < 0) {
      fail(`${spec.name} definition/order mismatch at ${marker}; got=${row.definition}`);
    }
    cursor = next;
  }
}

async function prerequisiteState(db) {
  const tableRows = await db.$queryRawUnsafe(`
    SELECT to_regclass(format('%I.%I', current_schema(), 'RefreshSession')) AS relation
  `);
  if (!tableRows?.[0]?.relation) return { ready: false, tableExists: false, populated: false, missingColumns: REQUIRED_COLUMNS };
  const columnRows = await db.$queryRawUnsafe(`
    SELECT "column_name"
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'RefreshSession'
       AND "column_name" IN (
         'userId', 'agencyId', 'deviceId', 'authorizationSessionId',
         'expiresAt', 'revokedAt', 'lastUsedAt', 'createdAt'
       )
  `);
  const found = new Set((columnRows || []).map((row) => String(row.column_name)));
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !found.has(column));
  if (!missingColumns.length) return { ready: true, tableExists: true, populated: true, missingColumns: [] };
  const populatedRows = await db.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM "RefreshSession" LIMIT 1) AS populated`);
  return {
    ready: false,
    tableExists: true,
    populated: populatedRows?.[0]?.populated === true,
    missingColumns,
  };
}

async function ensureIndex(db, spec) {
  let existing = await currentIndex(db, spec.name);
  if (existing && (!existing.valid || !existing.ready)) {
    console.warn(`# ACTUAL60_ONLINE_INDEX_ENSURE repair-invalid ${spec.name}`);
    await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
    existing = null;
  }
  if (existing) {
    assertDefinition(spec, existing);
    console.log(`# ACTUAL60_ONLINE_INDEX_ENSURE already-valid ${spec.name}`);
    return;
  }
  console.log(`# ACTUAL60_ONLINE_INDEX_ENSURE create-concurrently ${spec.name}`);
  await db.$executeRawUnsafe(spec.createSql);
  const created = await currentIndex(db, spec.name);
  if (!created) fail(`${spec.name} was not created`);
  assertDefinition(spec, created);
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const state = await prerequisiteState(db);
    if (!state.ready) {
      if (state.tableExists && state.populated) {
        fail(`populated RefreshSession is missing online-index prerequisite columns: ${state.missingColumns.join(",")}; stage prerequisite migrations before INT60 scale indexes`);
      }
      console.log(`# ACTUAL60_ONLINE_INDEX_ENSURE_SKIP fresh/empty schema missing prerequisites=${state.missingColumns.join(",")}`);
      return;
    }
    for (const spec of INDEXES) await ensureIndex(db, spec);
    console.log(`# ACTUAL60_ONLINE_INDEX_ENSURE_PASS indexes=${INDEXES.length}`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# ACTUAL60_ONLINE_INDEX_ENSURE_FAIL ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_COLUMNS,
  INDEXES,
  prerequisiteState,
  currentIndex,
  ensureIndex,
};
