"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIGRATION = "20260919173000_phase3_campaign_coverage_generation_authority_v1";
const REQUIRED_TABLES = ["CreatorCampaignCollectionState", "CreatorCampaignFanRefreshWork", "JobInstance"];
const PREFLIGHT_ADVISORY_LOCK_CLASS = 132987241;
const PREFLIGHT_ADVISORY_LOCK_KEY = 201917300;
const PREFLIGHT_TRANSACTION_MAX_WAIT_MS = 30_000;
const PREFLIGHT_TRANSACTION_TIMEOUT_MS = 300_000;
const AUTHORITY_COLUMNS = [
  "fanValueCoverageDelegated",
  "fanValueCoverageOwnerKind",
  "fanValueCoverageCollectorVersion",
  "fanValueCoverageSourceJobId",
];

function fail(message) {
  const error = new Error(message);
  error.code = "PHASE3_CAMPAIGN_COVERAGE_GENERATION_ONLINE_PREFLIGHT_FAILED";
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
  if (!await relationExists(db, "_prisma_migrations")) return false;
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
  const tables = {};
  for (const table of REQUIRED_TABLES) tables[table] = await relationExists(db, table);
  const ready = REQUIRED_TABLES.every((table) => tables[table] === true);
  const statePopulated = ready ? await tablePopulated(db, "CreatorCampaignCollectionState") : false;
  return { ready, tables, statePopulated };
}

async function currentAuthorityColumns(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT "column_name"
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'CreatorCampaignCollectionState'
       AND "column_name" = ANY($1::text[])
  `, AUTHORITY_COLUMNS);
  return new Set((rows || []).map((row) => String(row.column_name)));
}

const DIRECT_SOURCE_JOB_BACKFILL_SQL = `
UPDATE "CreatorCampaignCollectionState" s
SET "fanValueCoverageDelegated" = CASE
      WHEN COALESCE(j."params"->>'campaignFreshnessCoverageVersion', '') ~ '^[0-9]+$'
       AND (j."params"->>'campaignFreshnessCoverageVersion')::int >= 1 THEN true
      ELSE s."fanValueCoverageDelegated"
    END,
    "fanValueCoverageOwnerKind" = COALESCE(
      s."fanValueCoverageOwnerKind",
      CASE WHEN j."params"->>'manualCampaignScan' = 'true' THEN 'MANUAL' ELSE 'AUTOMATIC' END
    ),
    "fanValueCoverageCollectorVersion" = COALESCE(
      s."fanValueCoverageCollectorVersion",
      j."continuation"->'jobContinuation'->>'collectorVersion',
      j."continuation"->>'collectorVersion',
      j."result"->>'collectorVersion'
    ),
    "fanValueCoverageSourceJobId" = COALESCE(s."fanValueCoverageSourceJobId", s."sourceJobId")
FROM "JobInstance" j
WHERE s."sourceJobId" = j."id"
  AND s."fanValueCoverageScanRunId" IS NOT NULL
`;

// Migration-lineage-safe replacement for the historical migration's all-history
// DISTINCT ON fallback. Start from the single current collection-state row per
// creator, then probe only that exact creator+scanRun through the existing
// (creatorId, scanRunId, ...) indexes. Historical work from superseded runs is
// never enumerated just to discover the current generation's source job.
const CURRENT_STATE_FALLBACK_BACKFILL_SQL = `
WITH coverage_job AS (
  SELECT
    s."creatorId",
    s."fanValueCoverageScanRunId" AS "scanRunId",
    picked."campaignJobId",
    j."params",
    j."continuation",
    j."result"
  FROM "CreatorCampaignCollectionState" s
  JOIN LATERAL (
    SELECT w."campaignJobId"
    FROM "CreatorCampaignFanRefreshWork" w
    WHERE w."creatorId" = s."creatorId"
      AND w."scanRunId" = s."fanValueCoverageScanRunId"
    ORDER BY w."id"
    LIMIT 1
  ) picked ON TRUE
  JOIN "JobInstance" j ON j."id" = picked."campaignJobId"
  WHERE s."fanValueCoverageScanRunId" IS NOT NULL
)
UPDATE "CreatorCampaignCollectionState" s
SET "fanValueCoverageDelegated" = true,
    "fanValueCoverageOwnerKind" = COALESCE(
      s."fanValueCoverageOwnerKind",
      CASE WHEN coverage_job."params"->>'manualCampaignScan' = 'true' THEN 'MANUAL' ELSE 'AUTOMATIC' END
    ),
    "fanValueCoverageCollectorVersion" = COALESCE(
      s."fanValueCoverageCollectorVersion",
      coverage_job."continuation"->'jobContinuation'->>'collectorVersion',
      coverage_job."continuation"->>'collectorVersion',
      coverage_job."result"->>'collectorVersion'
    ),
    "fanValueCoverageSourceJobId" = COALESCE(s."fanValueCoverageSourceJobId", coverage_job."campaignJobId")
FROM coverage_job
WHERE s."creatorId" = coverage_job."creatorId"
  AND s."fanValueCoverageScanRunId" = coverage_job."scanRunId"
`;

const CURRENT_STATE_FALLBACK_EXPLAIN_SQL = `
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
WITH coverage_job AS (
  SELECT
    s."creatorId",
    s."fanValueCoverageScanRunId" AS "scanRunId",
    picked."campaignJobId",
    j."id" AS "joinedJobId"
  FROM "CreatorCampaignCollectionState" s
  JOIN LATERAL (
    SELECT w."campaignJobId"
    FROM "CreatorCampaignFanRefreshWork" w
    WHERE w."creatorId" = s."creatorId"
      AND w."scanRunId" = s."fanValueCoverageScanRunId"
    ORDER BY w."id"
    LIMIT 1
  ) picked ON TRUE
  JOIN "JobInstance" j ON j."id" = picked."campaignJobId"
  WHERE s."fanValueCoverageScanRunId" IS NOT NULL
)
SELECT COUNT(*)::int AS "count" FROM coverage_job
`;

async function ensureColumnsAndBackfill(db) {
  return db.$transaction(async (tx) => {
    // Serialize concurrent deploy preflights before enabling the short DDL lock
    // timeout. Without this transaction-scoped advisory lock, two deploys can
    // both observe the migration as unapplied and the second can spend the 5s
    // lock_timeout waiting on the first deploy's ALTER/backfill, producing a
    // false deployment failure even though the peer is making valid progress.
    // The advisory wait itself is intentionally outside the local lock_timeout;
    // once ownership is acquired, the 5s timeout still protects real table-lock
    // contention from unrelated writers.
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
      PREFLIGHT_ADVISORY_LOCK_CLASS,
      PREFLIGHT_ADVISORY_LOCK_KEY,
    );
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.$executeRawUnsafe(`
      ALTER TABLE "CreatorCampaignCollectionState"
        ADD COLUMN IF NOT EXISTS "fanValueCoverageDelegated" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "fanValueCoverageOwnerKind" VARCHAR(32),
        ADD COLUMN IF NOT EXISTS "fanValueCoverageCollectorVersion" VARCHAR(80),
        ADD COLUMN IF NOT EXISTS "fanValueCoverageSourceJobId" TEXT
    `);
    // The short lock timeout is only a DDL acquisition fence. PostgreSQL applies
    // lock_timeout to row locks too, so leaving it enabled during backfill would
    // turn ordinary runtime row-lock contention into a false migration failure.
    // The explicit Prisma transaction timeout above remains the bounded liveness
    // fence for the backfill itself.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '0'`);
    const directUpdated = await tx.$executeRawUnsafe(DIRECT_SOURCE_JOB_BACKFILL_SQL);
    const fallbackUpdated = await tx.$executeRawUnsafe(CURRENT_STATE_FALLBACK_BACKFILL_SQL);
    return {
      directUpdated: Math.max(0, Number(directUpdated || 0)),
      fallbackUpdated: Math.max(0, Number(fallbackUpdated || 0)),
    };
  }, {
    // Prisma interactive transactions default to a 5s runtime timeout. That
    // would re-introduce the exact overlapping-deploy false failure that the
    // advisory lock is meant to remove whenever the peer preflight takes more
    // than five seconds. Keep pool acquisition bounded, but allow the serialized
    // migration/backfill transaction enough time to wait for a valid peer and
    // finish its own bounded current-state work. PostgreSQL lock_timeout remains
    // the authority for unrelated table-lock contention after advisory ownership.
    maxWait: PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
    timeout: PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  });
}

async function verifyAuthorityColumns(db) {
  const found = await currentAuthorityColumns(db);
  const missing = AUTHORITY_COLUMNS.filter((column) => !found.has(column));
  if (missing.length) fail(`coverage authority columns missing after online preflight: ${missing.join(",")}`);
}

async function resolveApplied({ db, spawn = spawnSync, prismaEntry = null, isApplied = migrationApplied } = {}) {
  const entry = prismaEntry || require.resolve("prisma");
  const result = spawn(
    process.execPath,
    [entry, "migrate", "resolve", "--applied", MIGRATION],
    { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "inherit" },
  );
  if (!result?.error && result?.status === 0) return { resolved: true, concurrentPeer: false };

  // Online deploys may overlap. If a peer completed the exact same preflight and
  // marked the migration applied after our initial migrationApplied() read, Prisma
  // returns P3008/non-zero here even though the desired durable state is already
  // reached. Re-read migration history before failing the deployment; only accept
  // the non-zero result when the same migration is now successfully applied.
  if (db && await isApplied(db)) {
    console.warn(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT resolve-race migration already applied by peer ${MIGRATION}`);
    return { resolved: false, concurrentPeer: true };
  }
  if (result?.error) fail(`prisma migrate resolve failed: ${result.error.message}`);
  fail(`prisma migrate resolve exited ${result?.status}`);
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const prerequisites = await prerequisiteState(db);
    if (!prerequisites.ready) {
      console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_SKIP fresh schema prerequisites absent tables=${JSON.stringify(prerequisites.tables)}`);
      return;
    }

    const applied = await migrationApplied(db);
    if (applied) {
      await verifyAuthorityColumns(db);
      console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_PASS migrationApplied=true action=verify-only`);
      return;
    }

    if (!prerequisites.statePopulated) {
      console.log("# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_SKIP empty collection state; ordinary Prisma migration is effectively free");
      return;
    }

    const result = await ensureColumnsAndBackfill(db);
    await verifyAuthorityColumns(db);
    console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT resolve-applied ${MIGRATION}`);
    const resolved = await resolveApplied({ db });
    console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_PASS migrationApplied=false action=bounded-current-state-backfill directUpdated=${result.directUpdated} fallbackUpdated=${result.fallbackUpdated} concurrentPeer=${resolved.concurrentPeer === true}`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_FAIL ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  MIGRATION,
  REQUIRED_TABLES,
  PREFLIGHT_ADVISORY_LOCK_CLASS,
  PREFLIGHT_ADVISORY_LOCK_KEY,
  PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
  PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  AUTHORITY_COLUMNS,
  DIRECT_SOURCE_JOB_BACKFILL_SQL,
  CURRENT_STATE_FALLBACK_BACKFILL_SQL,
  CURRENT_STATE_FALLBACK_EXPLAIN_SQL,
  relationExists,
  tablePopulated,
  migrationApplied,
  prerequisiteState,
  currentAuthorityColumns,
  ensureColumnsAndBackfill,
  verifyAuthorityColumns,
  resolveApplied,
};
