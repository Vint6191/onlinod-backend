"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIGRATION = "20260919173000_phase3_campaign_coverage_generation_authority_v1";
const CURRENT_RUN_INDEX_MIGRATION = "20260920003000_phase3_campaign_refresh_current_run_lookup_index_v1";
const REQUIRED_TABLES = ["CreatorCampaignCollectionState", "CreatorCampaignFanRefreshWork", "JobInstance"];
const PREFLIGHT_ADVISORY_LOCK_CLASS = 132987241;
const PREFLIGHT_ADVISORY_LOCK_KEY = 201917300;
const PREFLIGHT_TRANSACTION_MAX_WAIT_MS = 30_000;
const PREFLIGHT_TRANSACTION_TIMEOUT_MS = 300_000;
const INDEX_LIFECYCLE_AUTHORITY_TIMEOUT_MS = 60 * 60 * 1000;
const INDEX_PEER_BUILD_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const INDEX_PEER_BUILD_POLL_MS = 250;
const CURRENT_RUN_INDEX_NAME = "CreatorCampaignFanRefreshWork_creator_run_id_idx";
const CURRENT_RUN_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${CURRENT_RUN_INDEX_NAME}"
  ON "CreatorCampaignFanRefreshWork"("creatorId", "scanRunId", "id")`;
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

async function currentRunIndex(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT c.relname AS name,
           i.indisvalid AS valid,
           i.indisready AS ready,
           i.indisunique AS unique,
           i.indnkeyatts::int AS "keyAttributeCount",
           i.indnatts::int AS "attributeCount",
           am.amname AS "accessMethod",
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           pg_get_expr(i.indexprs, i.indrelid) AS expressions,
           ARRAY(
             SELECT a.attname
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = i.indrelid
              AND a.attnum = k.attnum
             WHERE k.ord <= i.indnkeyatts
             ORDER BY k.ord
           ) AS columns,
           pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = c.relam
     WHERE n.nspname = current_schema()
       AND t.relname = 'CreatorCampaignFanRefreshWork'
       AND c.relname = $1
     LIMIT 1
  `, CURRENT_RUN_INDEX_NAME);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function assertCurrentRunIndex(row) {
  if (!row?.valid || !row?.ready) fail(`${CURRENT_RUN_INDEX_NAME} is not valid/ready`);
  const columns = Array.isArray(row.columns) ? row.columns.map((value) => String(value)) : [];
  const exactColumns = columns.length === 3
    && columns[0] === "creatorId"
    && columns[1] === "scanRunId"
    && columns[2] === "id";
  if (String(row.accessMethod || "").toLowerCase() !== "btree") fail(`${CURRENT_RUN_INDEX_NAME} must be btree; got=${row.accessMethod}`);
  if (row.predicate !== null && row.predicate !== undefined) fail(`${CURRENT_RUN_INDEX_NAME} must be non-partial; predicate=${row.predicate}`);
  if (row.expressions !== null && row.expressions !== undefined) fail(`${CURRENT_RUN_INDEX_NAME} must use plain columns; expressions=${row.expressions}`);
  if (row.unique === true) fail(`${CURRENT_RUN_INDEX_NAME} must be non-unique`);
  if (Number(row.keyAttributeCount) !== 3 || Number(row.attributeCount) !== 3 || !exactColumns) {
    fail(`${CURRENT_RUN_INDEX_NAME} exact definition/order mismatch; columns=${JSON.stringify(columns)} definition=${row.definition}`);
  }
}

async function currentRunIndexBuildProgress(db) {
  if (typeof db?.$queryRawUnsafe !== "function") return null;
  const rows = await db.$queryRawUnsafe(`
    SELECT p.pid::int AS pid,
           p.command,
           p.phase,
           p."blocks_total"::bigint AS "blocksTotal",
           p."blocks_done"::bigint AS "blocksDone"
      FROM pg_stat_progress_create_index p
      JOIN pg_class t ON t.oid = p.relid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND t.relname = 'CreatorCampaignFanRefreshWork'
     ORDER BY p.pid
     LIMIT 1
  `);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

async function waitForCurrentRunIndexPeerBuild(db, {
  timeoutMs = INDEX_PEER_BUILD_WAIT_TIMEOUT_MS,
  pollMs = INDEX_PEER_BUILD_POLL_MS,
} = {}) {
  let progress = await currentRunIndexBuildProgress(db);
  if (!progress) return { waited: false, last: null };
  const startedAt = Date.now();
  console.warn(`# PHASE3_CAMPAIGN_COVERAGE_INDEX peer-build-wait pid=${progress.pid ?? "unknown"} phase=${JSON.stringify(progress.phase || null)}`);
  while (progress) {
    if (Date.now() - startedAt >= timeoutMs) {
      fail(`${CURRENT_RUN_INDEX_NAME} peer CREATE INDEX CONCURRENTLY did not settle within ${timeoutMs}ms`);
    }
    await sleep(pollMs);
    progress = await currentRunIndexBuildProgress(db);
  }
  return { waited: true, last: null, durationMs: Date.now() - startedAt };
}

function indexLifecycleWorkerDatabaseUrl(databaseUrl) {
  const raw = String(databaseUrl || "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    // A dedicated one-connection worker makes the deployment topology explicit:
    // owner advisory transaction and CREATE/DROP INDEX CONCURRENTLY can never
    // accidentally share a single pool connection. Tight connection/pool timeouts
    // turn an undersized deployment pool/server limit into an immediate preflight
    // failure instead of an unbounded build hang.
    if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "1");
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "10");
    if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "10");
    return url.toString();
  } catch (_) {
    return raw;
  }
}

async function assertIndexLifecycleConnectionContract(ownerTx, workerDb) {
  if (typeof ownerTx?.$queryRawUnsafe !== "function" || typeof workerDb?.$queryRawUnsafe !== "function") {
    return { verified: false, adapterFallback: true };
  }
  const ownerRows = await ownerTx.$queryRawUnsafe(
    `SELECT pg_backend_pid()::int AS pid, current_setting('transaction_isolation') AS isolation`
  );
  const workerRows = await workerDb.$queryRawUnsafe(
    `SELECT pg_backend_pid()::int AS pid, current_setting('transaction_isolation') AS isolation`
  );
  const owner = ownerRows?.[0] || {};
  const worker = workerRows?.[0] || {};
  if (!Number.isInteger(Number(owner.pid)) || !Number.isInteger(Number(worker.pid))) {
    fail("index lifecycle connection contract could not resolve PostgreSQL backend PIDs");
  }
  if (Number(owner.pid) === Number(worker.pid)) {
    fail("index lifecycle requires two distinct PostgreSQL sessions; owner and concurrent-index worker share one backend PID");
  }
  if (String(owner.isolation || "").toLowerCase() !== "read committed") {
    fail(`index lifecycle owner transaction must use Read Committed; got=${owner.isolation}`);
  }
  return {
    verified: true, ownerPid: Number(owner.pid), workerPid: Number(worker.pid),
    ownerIsolation: String(owner.isolation), workerIsolation: String(worker.isolation || ""),
  };
}

async function withIndexLifecycleAuthority(db, work, { workerDb = null, requireDistinctConnections = false } = {}) {
  if (typeof work !== "function") throw new TypeError("Index lifecycle authority requires work callback");
  const lifecycleDb = workerDb || db;
  if (requireDistinctConnections && lifecycleDb === db) {
    fail("index lifecycle production preflight requires a dedicated concurrent-index Prisma client");
  }
  if (typeof db?.$transaction !== "function") return work(lifecycleDb, { verified: false, adapterFallback: true });
  // CREATE/DROP INDEX CONCURRENTLY cannot execute inside a transaction. Hold the
  // transaction-scoped advisory owner on client A while dedicated client B owns
  // the concurrent-index lifecycle. ReadCommitted is explicit so the owner does
  // not pin a long snapshot while client B waits on old transactions/snapshots.
  return db.$transaction(async (ownerTx) => {
    await acquirePreflightAuthority(ownerTx);
    const contract = await assertIndexLifecycleConnectionContract(ownerTx, lifecycleDb);
    if (requireDistinctConnections && contract.verified !== true) {
      fail("index lifecycle production connection contract was not physically verified");
    }
    return work(lifecycleDb, contract);
  }, {
    maxWait: PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
    timeout: INDEX_LIFECYCLE_AUTHORITY_TIMEOUT_MS,
    isolationLevel: "ReadCommitted",
  });
}

async function ensureCurrentRunLookupIndex(db, peerWaitOptions = undefined) {
  let existing = await currentRunIndex(db);

  // Rolling compatibility: an older/external deploy may already be inside
  // CREATE INDEX CONCURRENTLY and therefore cannot participate in the new
  // A20.12 lifecycle advisory authority. Never DROP an index while PostgreSQL
  // reports an active build on this table. Wait for the builder to settle,
  // re-inspect, and only then decide whether an invalid row is abandoned.
  let peer = await currentRunIndexBuildProgress(db);
  if (peer) {
    await waitForCurrentRunIndexPeerBuild(db, peerWaitOptions);
    existing = await currentRunIndex(db);
  }

  if (existing) {
    let exact = true;
    try { assertCurrentRunIndex(existing); } catch (error) {
      exact = false;
      console.warn(`# PHASE3_CAMPAIGN_COVERAGE_INDEX repair-nonconforming ${CURRENT_RUN_INDEX_NAME} reason=${JSON.stringify(error?.message || String(error))}`);
    }
    if (!exact) {
      // The active-build wait above is the authority boundary between a peer's
      // transient invalid catalog row and an abandoned/nonconforming index.
      // Only an index with no active builder may be dropped/rebuilt here.
      peer = await currentRunIndexBuildProgress(db);
      if (peer) {
        await waitForCurrentRunIndexPeerBuild(db, peerWaitOptions);
        existing = await currentRunIndex(db);
        if (existing) {
          try {
            assertCurrentRunIndex(existing);
            return { ensured: true, name: CURRENT_RUN_INDEX_NAME, peerBuildSettled: true };
          } catch (_) {
            // Peer settled but left an invalid/wrong definition: it is now
            // abandoned and may be repaired under our lifecycle authority.
          }
        }
      }
      await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${CURRENT_RUN_INDEX_NAME}"`);
      existing = null;
    }
  }
  if (!existing) {
    // A builder may have started between the first catalog inspection and this
    // branch if it is an old/non-authority deploy. Check progress one last time
    // before starting our own concurrent build.
    peer = await currentRunIndexBuildProgress(db);
    if (peer) {
      await waitForCurrentRunIndexPeerBuild(db, peerWaitOptions);
      existing = await currentRunIndex(db);
      if (existing) {
        try {
          assertCurrentRunIndex(existing);
          return { ensured: true, name: CURRENT_RUN_INDEX_NAME, peerBuildSettled: true };
        } catch (_) {
          await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${CURRENT_RUN_INDEX_NAME}"`);
          existing = null;
        }
      }
    }
  }
  if (!existing) {
    console.log(`# PHASE3_CAMPAIGN_COVERAGE_INDEX create-concurrently ${CURRENT_RUN_INDEX_NAME}`);
    await db.$executeRawUnsafe(CURRENT_RUN_INDEX_SQL);
    existing = await currentRunIndex(db);

    // IF NOT EXISTS may have observed an index name published moments earlier
    // by a rolling peer that started outside the new lifecycle authority. If
    // that peer is still building, wait rather than treating its transient
    // indisvalid=false state as abandoned. If it settled invalid, repair once
    // under our owner lock.
    if (existing) {
      try {
        assertCurrentRunIndex(existing);
      } catch (_) {
        peer = await currentRunIndexBuildProgress(db);
        if (peer) {
          await waitForCurrentRunIndexPeerBuild(db, peerWaitOptions);
          existing = await currentRunIndex(db);
        }
        let exactAfterPeer = false;
        if (existing) {
          try { assertCurrentRunIndex(existing); exactAfterPeer = true; } catch (_) { exactAfterPeer = false; }
        }
        if (!exactAfterPeer) {
          await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${CURRENT_RUN_INDEX_NAME}"`);
          console.log(`# PHASE3_CAMPAIGN_COVERAGE_INDEX repair-abandoned ${CURRENT_RUN_INDEX_NAME}`);
          await db.$executeRawUnsafe(CURRENT_RUN_INDEX_SQL);
          existing = await currentRunIndex(db);
        }
      }
    }
  }
  if (!existing) fail(`${CURRENT_RUN_INDEX_NAME} was not created`);
  assertCurrentRunIndex(existing);
  return { ensured: true, name: CURRENT_RUN_INDEX_NAME };
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

// Start from current state and probe one exact current-generation work row. The
// A20.11 online index (creatorId, scanRunId, id) makes ORDER BY id LIMIT 1
// bounded by the generation lookup rather than sorting/scanning every fan in a
// large current generation.
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

async function acquirePreflightAuthority(tx) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
    PREFLIGHT_ADVISORY_LOCK_CLASS,
    PREFLIGHT_ADVISORY_LOCK_KEY,
  );
}

async function ensureAuthorityColumns(db) {
  return db.$transaction(async (tx) => {
    await acquirePreflightAuthority(tx);
    const found = await currentAuthorityColumns(tx);
    const missing = AUTHORITY_COLUMNS.filter((column) => !found.has(column));
    if (!missing.length) return { altered: false, missing: [] };
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.$executeRawUnsafe(`
      ALTER TABLE "CreatorCampaignCollectionState"
        ADD COLUMN IF NOT EXISTS "fanValueCoverageDelegated" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "fanValueCoverageOwnerKind" VARCHAR(32),
        ADD COLUMN IF NOT EXISTS "fanValueCoverageCollectorVersion" VARCHAR(80),
        ADD COLUMN IF NOT EXISTS "fanValueCoverageSourceJobId" TEXT
    `);
    // Commit immediately after DDL. ACCESS EXCLUSIVE must never be held across
    // the potentially longer data backfill.
    return { altered: true, missing };
  }, {
    maxWait: PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
    timeout: PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  });
}

async function backfillAuthority(db) {
  return db.$transaction(async (tx) => {
    // Re-acquire the same preflight authority in the data phase. Concurrent
    // deploys can interleave between the short DDL commit and this transaction,
    // but the idempotent backfills themselves remain serialized and no DDL lock
    // is held while runtime readers/writers contend on state rows.
    await acquirePreflightAuthority(tx);
    const directUpdated = await tx.$executeRawUnsafe(DIRECT_SOURCE_JOB_BACKFILL_SQL);
    const fallbackUpdated = await tx.$executeRawUnsafe(CURRENT_STATE_FALLBACK_BACKFILL_SQL);
    return {
      directUpdated: Math.max(0, Number(directUpdated || 0)),
      fallbackUpdated: Math.max(0, Number(fallbackUpdated || 0)),
    };
  }, {
    maxWait: PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
    timeout: PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  });
}

async function ensureColumnsAndBackfill(db) {
  const ddl = await ensureAuthorityColumns(db);
  const backfill = await backfillAuthority(db);
  return { ...backfill, ddlAltered: ddl.altered === true };
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
  let indexDb = null;
  try {
    const prerequisites = await prerequisiteState(db);
    if (!prerequisites.ready) {
      console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_SKIP fresh schema prerequisites absent tables=${JSON.stringify(prerequisites.tables)}`);
      return;
    }

    // Existing/populated installations need the generation lookup index online,
    // before the ordinary migration records the schema step. Fresh databases
    // create the same index from the A20.11 migration itself. Use a dedicated
    // Prisma client for CONCURRENTLY and verify distinct backend sessions while
    // the owner transaction is alive. This is an explicit deployment contract,
    // not an assumption about the root client's pool size.
    indexDb = new PrismaClient({ datasources: { db: { url: indexLifecycleWorkerDatabaseUrl(databaseUrl) } } });
    await indexDb.$connect();
    await withIndexLifecycleAuthority(
      db,
      async (lifecycleDb, contract) => {
        if (contract?.verified !== true) fail("index lifecycle connection contract was not verified before concurrent index work");
        console.log(`# PHASE3_CAMPAIGN_COVERAGE_INDEX_CONNECTION_CONTRACT_PASS ownerPid=${contract.ownerPid} workerPid=${contract.workerPid} isolation=${JSON.stringify(contract.ownerIsolation)}`);
        return ensureCurrentRunLookupIndex(lifecycleDb);
      },
      { workerDb: indexDb, requireDistinctConnections: true },
    );

    const applied = await migrationApplied(db);
    if (applied) {
      await verifyAuthorityColumns(db);
      console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_PASS migrationApplied=true action=verify-only index=${CURRENT_RUN_INDEX_NAME}`);
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
    console.log(`# PHASE3_CAMPAIGN_COVERAGE_PREFLIGHT_PASS migrationApplied=false action=split-ddl-bounded-current-state-backfill directUpdated=${result.directUpdated} fallbackUpdated=${result.fallbackUpdated} ddlAltered=${result.ddlAltered} concurrentPeer=${resolved.concurrentPeer === true} index=${CURRENT_RUN_INDEX_NAME}`);
  } finally {
    if (indexDb) await indexDb.$disconnect().catch(() => {});
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
  CURRENT_RUN_INDEX_MIGRATION,
  REQUIRED_TABLES,
  PREFLIGHT_ADVISORY_LOCK_CLASS,
  PREFLIGHT_ADVISORY_LOCK_KEY,
  PREFLIGHT_TRANSACTION_MAX_WAIT_MS,
  PREFLIGHT_TRANSACTION_TIMEOUT_MS,
  INDEX_LIFECYCLE_AUTHORITY_TIMEOUT_MS,
  INDEX_PEER_BUILD_WAIT_TIMEOUT_MS,
  INDEX_PEER_BUILD_POLL_MS,
  CURRENT_RUN_INDEX_NAME,
  CURRENT_RUN_INDEX_SQL,
  AUTHORITY_COLUMNS,
  DIRECT_SOURCE_JOB_BACKFILL_SQL,
  CURRENT_STATE_FALLBACK_BACKFILL_SQL,
  CURRENT_STATE_FALLBACK_EXPLAIN_SQL,
  relationExists,
  tablePopulated,
  migrationApplied,
  prerequisiteState,
  currentAuthorityColumns,
  currentRunIndex,
  assertCurrentRunIndex,
  currentRunIndexBuildProgress,
  waitForCurrentRunIndexPeerBuild,
  indexLifecycleWorkerDatabaseUrl,
  assertIndexLifecycleConnectionContract,
  withIndexLifecycleAuthority,
  ensureCurrentRunLookupIndex,
  acquirePreflightAuthority,
  ensureAuthorityColumns,
  backfillAuthority,
  ensureColumnsAndBackfill,
  verifyAuthorityColumns,
  resolveApplied,
};
