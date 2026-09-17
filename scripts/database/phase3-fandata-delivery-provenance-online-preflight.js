"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIGRATION = "20260916222000_phase3_fan_observation_delivery_provenance";
const TABLES = ["CreatorFanRelationshipCurrent", "CreatorFanValueCurrent"];
const CONSTRAINTS = [
  {
    table: "CreatorFanRelationshipCurrent",
    name: "CreatorFanRelationshipCurrent_sourceDeliveryId_fkey",
  },
  {
    table: "CreatorFanValueCurrent",
    name: "CreatorFanValueCurrent_sourceDeliveryId_fkey",
  },
];
const INDEXES = [
  {
    table: "CreatorFanRelationshipCurrent",
    name: "CreatorFanRelationshipCurrent_sourceDeliveryId_idx",
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "CreatorFanRelationshipCurrent_sourceDeliveryId_idx" ON "CreatorFanRelationshipCurrent"("sourceDeliveryId")',
  },
  {
    table: "CreatorFanValueCurrent",
    name: "CreatorFanValueCurrent_sourceDeliveryId_idx",
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "CreatorFanValueCurrent_sourceDeliveryId_idx" ON "CreatorFanValueCurrent"("sourceDeliveryId")',
  },
];

function fail(message) {
  const error = new Error(message);
  error.code = "PHASE3_DELIVERY_PROVENANCE_ONLINE_PREFLIGHT_FAILED";
  throw error;
}

async function relationExists(db, table) {
  const rows = await db.$queryRawUnsafe(
    `SELECT to_regclass(format('%I.%I', current_schema(), $1))::text AS relation`,
    table,
  );
  return Boolean(rows?.[0]?.relation);
}

async function tablePopulated(db, table) {
  const rows = await db.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM "${table}" LIMIT 1) AS populated`);
  return rows?.[0]?.populated === true;
}

async function migrationApplied(db) {
  const exists = await relationExists(db, "_prisma_migrations");
  if (!exists) return false;
  const rows = await db.$queryRawUnsafe(
    `SELECT "finished_at", "rolled_back_at"
       FROM "_prisma_migrations"
      WHERE "migration_name" = $1
      ORDER BY "started_at" DESC
      LIMIT 1`,
    MIGRATION,
  );
  const row = rows?.[0];
  return Boolean(row?.finished_at && !row?.rolled_back_at);
}

async function prerequisiteState(db) {
  const tableStates = {};
  for (const table of TABLES) {
    const exists = await relationExists(db, table);
    tableStates[table] = { exists, populated: exists ? await tablePopulated(db, table) : false };
  }
  const deliveryExists = await relationExists(db, "AutomationDelivery");
  const populated = TABLES.some((table) => tableStates[table].populated);
  return { tableStates, deliveryExists, populated };
}

async function ensureColumnsAndNotValidConstraints(db) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.$executeRawUnsafe(`ALTER TABLE "CreatorFanRelationshipCurrent" ADD COLUMN IF NOT EXISTS "sourceDeliveryId" TEXT`);
    await tx.$executeRawUnsafe(`ALTER TABLE "CreatorFanValueCurrent" ADD COLUMN IF NOT EXISTS "sourceDeliveryId" TEXT`);

    await tx.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CreatorFanRelationshipCurrent_sourceDeliveryId_fkey'
             AND conrelid = '"CreatorFanRelationshipCurrent"'::regclass
        ) THEN
          ALTER TABLE "CreatorFanRelationshipCurrent"
            ADD CONSTRAINT "CreatorFanRelationshipCurrent_sourceDeliveryId_fkey"
            FOREIGN KEY ("sourceDeliveryId") REFERENCES "AutomationDelivery"("id")
            ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
        END IF;
      END $$
    `);

    await tx.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CreatorFanValueCurrent_sourceDeliveryId_fkey'
             AND conrelid = '"CreatorFanValueCurrent"'::regclass
        ) THEN
          ALTER TABLE "CreatorFanValueCurrent"
            ADD CONSTRAINT "CreatorFanValueCurrent_sourceDeliveryId_fkey"
            FOREIGN KEY ("sourceDeliveryId") REFERENCES "AutomationDelivery"("id")
            ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
        END IF;
      END $$
    `);
  });
}

async function constraintState(db, spec) {
  const rows = await db.$queryRawUnsafe(
    `SELECT c.convalidated AS validated,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = $1
        AND c.conname = $2
      LIMIT 1`,
    spec.table,
    spec.name,
  );
  return rows?.[0] || null;
}

function assertConstraintDefinition(spec, row) {
  if (!row) fail(`${spec.name} is missing`);
  const normalized = String(row.definition || "").replace(/\s+/g, " ").toLowerCase();
  if (!normalized.includes('foreign key ("sourcedeliveryid")')) fail(`${spec.name} foreign-key column mismatch: ${row.definition}`);
  if (!normalized.includes('references "automationdelivery"(id)')) fail(`${spec.name} target mismatch: ${row.definition}`);
  if (!normalized.includes("on update cascade")) fail(`${spec.name} ON UPDATE mismatch: ${row.definition}`);
  if (!normalized.includes("on delete set null")) fail(`${spec.name} ON DELETE mismatch: ${row.definition}`);
}

async function validateConstraint(db, spec) {
  const state = await constraintState(db, spec);
  assertConstraintDefinition(spec, state);
  if (state.validated) {
    console.log(`# PHASE3_DELIVERY_PROVENANCE already-validated ${spec.name}`);
    return;
  }
  console.log(`# PHASE3_DELIVERY_PROVENANCE validate ${spec.name}`);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.$executeRawUnsafe(`ALTER TABLE "${spec.table}" VALIDATE CONSTRAINT "${spec.name}"`);
  });
  const validated = await constraintState(db, spec);
  assertConstraintDefinition(spec, validated);
  if (!validated?.validated) fail(`${spec.name} did not validate`);
}

async function currentIndex(db, spec) {
  const rows = await db.$queryRawUnsafe(
    `SELECT i.indisvalid AS valid,
            i.indisready AS ready,
            pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema()
        AND t.relname = $1
        AND c.relname = $2
      LIMIT 1`,
    spec.table,
    spec.name,
  );
  return rows?.[0] || null;
}

function assertIndexDefinition(spec, row) {
  if (!row?.valid || !row?.ready) fail(`${spec.name} is not valid/ready`);
  const normalized = String(row.definition || "").replace(/[\s"(),]/g, "").toLowerCase();
  if (!normalized.includes(spec.table.toLowerCase())) fail(`${spec.name} table mismatch: ${row.definition}`);
  if (!normalized.includes("sourcedeliveryid")) fail(`${spec.name} column mismatch: ${row.definition}`);
}

async function ensureIndex(db, spec) {
  let row = await currentIndex(db, spec);
  if (row && (!row.valid || !row.ready)) {
    console.warn(`# PHASE3_DELIVERY_PROVENANCE repair-invalid-index ${spec.name}`);
    await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
    row = null;
  }
  if (!row) {
    console.log(`# PHASE3_DELIVERY_PROVENANCE create-concurrently ${spec.name}`);
    await db.$executeRawUnsafe(spec.createSql);
    row = await currentIndex(db, spec);
  }
  assertIndexDefinition(spec, row);
}

function resolveApplied() {
  const prismaEntry = require.resolve("prisma");
  const result = spawnSync(
    process.execPath,
    [prismaEntry, "migrate", "resolve", "--applied", MIGRATION],
    { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "inherit" },
  );
  if (result.error) fail(`prisma migrate resolve failed: ${result.error.message}`);
  if (result.status !== 0) fail(`prisma migrate resolve exited ${result.status}`);
}

async function ensureOnlineSchema(db) {
  await ensureColumnsAndNotValidConstraints(db);
  for (const spec of CONSTRAINTS) await validateConstraint(db, spec);
  for (const spec of INDEXES) await ensureIndex(db, spec);
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const state = await prerequisiteState(db);
    if (!state.deliveryExists || TABLES.some((table) => !state.tableStates[table].exists)) {
      console.log("# PHASE3_DELIVERY_PROVENANCE_SKIP schema prerequisites absent; prisma migrate deploy owns fresh schema creation");
      return;
    }

    const applied = await migrationApplied(db);
    if (!state.populated && !applied) {
      console.log("# PHASE3_DELIVERY_PROVENANCE_SKIP empty current tables; ordinary Prisma migration is effectively free");
      return;
    }

    await ensureOnlineSchema(db);
    if (!applied) {
      console.log(`# PHASE3_DELIVERY_PROVENANCE resolve-applied ${MIGRATION}`);
      resolveApplied();
    }
    console.log(`# PHASE3_DELIVERY_PROVENANCE_PASS populated=${state.populated} migrationApplied=${applied}`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# PHASE3_DELIVERY_PROVENANCE_FAIL ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  MIGRATION,
  TABLES,
  CONSTRAINTS,
  INDEXES,
  prerequisiteState,
  migrationApplied,
  ensureColumnsAndNotValidConstraints,
  constraintState,
  validateConstraint,
  currentIndex,
  ensureIndex,
  ensureOnlineSchema,
  resolveApplied,
};
