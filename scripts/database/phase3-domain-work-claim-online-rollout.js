#!/usr/bin/env node
"use strict";

const TOPOLOGY_ID = "phase3_domain_work_claim_topology_a36_v1";
const DOMAIN_WORK_EXECUTOR_GENERATION = "phase3_domain_executor_v5_a36_claim_topology";
const REQUIRED_BASE_TABLES = Object.freeze([
  "DomainWorkItem",
  "Phase2WorkBroadClaimPartitionState",
  "Phase2WorkGenerationAuthority",
  "AgencyMember",
  "CreatorAccount",
]);
const REQUIRED_DWI_COLUMNS = Object.freeze([
  "id", "agencyId", "workClass", "partitionKey", "activeGeneration",
  "state", "isOutstanding", "availableAt", "nextAttemptAt", "leaseUntil",
]);
const PARTITION_EXPAND_COLUMNS = Object.freeze(["claimShard", "nextClaimableAt", "revision"]);
const CLAIM_SHARD_CONSTRAINT = "Phase2WorkBroadClaimPartitionState_claimShard_check";
const MEMBER_SCOPE_CARDINALITY_CONSTRAINT = "AgencyMember_assignedCreators_cardinality_check";
const ROLLOUT_LOCK_CLASS = 132987241;
const ROLLOUT_LOCK_KEY = 20260922;
const ROLLOUT_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const ROLLOUT_LOCK_POLL_MS = 250;
const INDEX_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const INDEX_BUILD_POLL_MS = 500;
const DEFAULT_BACKFILL_BATCH_SIZE = 1000;
const MAX_BACKFILL_BATCH_SIZE = 10_000;
const DEFAULT_MEMBER_BACKFILL_BATCH_SIZE = 10;
const MAX_MEMBER_BACKFILL_BATCH_SIZE = 25;
const DEFAULT_BACKFILL_PAUSE_MS = 10;

const CLAIM_SHARD_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION "phase3_domain_work_claim_shard"(p_partition TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (((hashtextextended(COALESCE(p_partition,''),0) % 128) + 128) % 128)::INTEGER;
$$`;

const CLAIMABLE_AT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION "phase3_domain_work_claimable_at"(
  p_state TEXT,
  p_available_at TIMESTAMP(3),
  p_next_attempt_at TIMESTAMP(3),
  p_lease_until TIMESTAMP(3)
)
RETURNS TIMESTAMP(3)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_state='READY' THEN GREATEST(p_available_at,COALESCE(p_next_attempt_at,p_available_at))
    WHEN p_state='CLAIMED' THEN GREATEST(
      p_available_at,
      COALESCE(p_next_attempt_at,p_available_at),
      COALESCE(p_lease_until,p_available_at)
    )
    ELSE NULL
  END;
$$`;

const INDEX_SPECS = Object.freeze([
  Object.freeze({
    name: "DomainWorkItem_claimable_global_a36_idx",
    table: "DomainWorkItem",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "DomainWorkItem_claimable_global_a36_idx"
      ON "DomainWorkItem"(
        "workClass","activeGeneration",
        "phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),
        "agencyId","partitionKey","id"
      ) WHERE "isOutstanding"=TRUE AND "state" IN ('READY','CLAIMED')`,
    orderedMarkers: [
      "workclass", "activegeneration", "phase3_domain_work_claimable_at",
      "state", "availableat", "nextattemptat", "leaseuntil",
      "agencyid", "partitionkey", "id", "isoutstanding", "ready", "claimed",
    ],
    keyMarkers: [
      ["workclass"], ["activegeneration"],
      ["phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil"],
      ["agencyid"], ["partitionkey"], ["id"],
    ],
    predicateMarkers: ["isoutstanding", "true", "state", "ready", "claimed"],
  }),
  Object.freeze({
    name: "DomainWorkItem_claimable_partition_a36_idx",
    table: "DomainWorkItem",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "DomainWorkItem_claimable_partition_a36_idx"
      ON "DomainWorkItem"(
        "agencyId","workClass","activeGeneration","partitionKey",
        "phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),"id"
      ) WHERE "isOutstanding"=TRUE AND "state" IN ('READY','CLAIMED')`,
    orderedMarkers: [
      "agencyid", "workclass", "activegeneration", "partitionkey",
      "phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil",
      "id", "isoutstanding", "ready", "claimed",
    ],
    keyMarkers: [
      ["agencyid"], ["workclass"], ["activegeneration"], ["partitionkey"],
      ["phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil"],
      ["id"],
    ],
    predicateMarkers: ["isoutstanding", "true", "state", "ready", "claimed"],
  }),
  Object.freeze({
    name: "DomainWorkItem_claimable_agency_shard_a36_idx",
    table: "DomainWorkItem",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "DomainWorkItem_claimable_agency_shard_a36_idx"
      ON "DomainWorkItem"(
        "agencyId","workClass","activeGeneration",
        "phase3_domain_work_claim_shard"("partitionKey"),
        "phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),
        "partitionKey","id"
      ) WHERE "isOutstanding"=TRUE AND "state" IN ('READY','CLAIMED')`,
    orderedMarkers: [
      "agencyid", "workclass", "activegeneration", "phase3_domain_work_claim_shard", "partitionkey",
      "phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil",
      "partitionkey", "id", "isoutstanding", "ready", "claimed",
    ],
    keyMarkers: [
      ["agencyid"], ["workclass"], ["activegeneration"],
      ["phase3_domain_work_claim_shard", "partitionkey"],
      ["phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil"],
      ["partitionkey"], ["id"],
    ],
    predicateMarkers: ["isoutstanding", "true", "state", "ready", "claimed"],
  }),
  Object.freeze({
    name: "DomainWorkItem_claimable_creator_a36_idx",
    table: "DomainWorkItem",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "DomainWorkItem_claimable_creator_a36_idx"
      ON "DomainWorkItem"(
        "agencyId","workClass","activeGeneration","creatorId",
        "phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),"id"
      ) WHERE "isOutstanding"=TRUE AND "creatorId" IS NOT NULL AND "state" IN ('READY','CLAIMED')`,
    orderedMarkers: [
      "agencyid", "workclass", "activegeneration", "creatorid",
      "phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil",
      "id", "isoutstanding", "true", "creatorid", "null", "state", "ready", "claimed",
    ],
    keyMarkers: [
      ["agencyid"], ["workclass"], ["activegeneration"], ["creatorid"],
      ["phase3_domain_work_claimable_at", "state", "availableat", "nextattemptat", "leaseuntil"],
      ["id"],
    ],
    predicateMarkers: ["isoutstanding", "true", "creatorid", "null", "state", "ready", "claimed"],
  }),
  Object.freeze({
    name: "DomainWorkItem_current_activation_a36_idx",
    table: "DomainWorkItem",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "DomainWorkItem_current_activation_a36_idx"
      ON "DomainWorkItem"("agencyId","workClass","partitionKey","activeGeneration","id")
      WHERE "isOutstanding"=TRUE`,
    orderedMarkers: ["agencyid", "workclass", "partitionkey", "activegeneration", "id", "isoutstanding", "true"],
    keyMarkers: [["agencyid"], ["workclass"], ["partitionkey"], ["activegeneration"], ["id"]],
    predicateMarkers: ["isoutstanding", "true"],
  }),
  Object.freeze({
    name: "Phase2WorkBroadClaimPartitionState_shard_due_idx",
    table: "Phase2WorkBroadClaimPartitionState",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Phase2WorkBroadClaimPartitionState_shard_due_idx"
      ON "Phase2WorkBroadClaimPartitionState"(
        "agencyId","workClass","activeGeneration","claimShard",
        "nextClaimableAt","revision","partitionKey"
      )`,
    orderedMarkers: [
      "agencyid", "workclass", "activegeneration", "claimshard",
      "nextclaimableat", "revision", "partitionkey",
    ],
    keyMarkers: [
      ["agencyid"], ["workclass"], ["activegeneration"], ["claimshard"],
      ["nextclaimableat"], ["revision"], ["partitionkey"],
    ],
    predicateMarkers: [],
  }),
  Object.freeze({
    name: "AgencyMember_current_activation_a36_idx",
    table: "AgencyMember",
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "AgencyMember_current_activation_a36_idx"
      ON "AgencyMember"("id")
      WHERE "deletedAt" IS NULL AND "deactivatedAt" IS NULL`,
    orderedMarkers: ["id", "deletedat", "null", "deactivatedat", "null"],
    keyMarkers: [["id"]],
    predicateMarkers: ["deletedat", "null", "deactivatedat", "null"],
  }),
]);

const BACKFILL_BATCH_SQL = `
WITH batch AS MATERIALIZED (
  SELECT selected."agencyId",selected."workClass",selected."partitionKey",selected."activeGeneration"
    FROM jsonb_to_recordset($1::jsonb) AS selected(
      "agencyId" text,"workClass" text,"partitionKey" text,"activeGeneration" text
   )
   ORDER BY selected."agencyId",selected."workClass",selected."partitionKey"
), partitions AS MATERIALIZED (
  SELECT DISTINCT ON (b."agencyId",b."workClass",b."partitionKey") b.*
    FROM batch b
   ORDER BY b."agencyId",b."workClass",b."partitionKey",b."activeGeneration"
), partition_reconciled AS MATERIALIZED (
  SELECT b.*,
         "phase3_reconcile_domain_work_claim_partition"(
           b."agencyId",b."workClass",b."activeGeneration",b."partitionKey",CURRENT_TIMESTAMP
         ) AS reconciled
    FROM partitions b
   ORDER BY b."agencyId",b."workClass",b."partitionKey"
), shard_keys AS MATERIALIZED (
  SELECT DISTINCT p."agencyId",p."workClass",p."activeGeneration",
         "phase3_domain_work_claim_shard"(p."partitionKey") AS "claimShard"
    FROM partition_reconciled p
   ORDER BY p."agencyId",p."workClass","claimShard"
), shard_reconciled AS MATERIALIZED (
  SELECT s.*,
         "phase3_reconcile_domain_work_claim_shard"(
           s."agencyId",s."workClass",s."activeGeneration",s."claimShard",CURRENT_TIMESTAMP
         ) AS reconciled
    FROM shard_keys s
   ORDER BY s."agencyId",s."workClass",s."claimShard"
), agency_keys AS MATERIALIZED (
  SELECT DISTINCT s."agencyId",s."workClass",s."activeGeneration"
    FROM shard_reconciled s
   ORDER BY s."agencyId",s."workClass",s."activeGeneration"
), agency_reconciled AS MATERIALIZED (
  SELECT a.*,
         "phase3_reconcile_domain_work_claim_agency"(
           a."agencyId",a."workClass",a."activeGeneration",CURRENT_TIMESTAMP
         ) AS reconciled
    FROM agency_keys a
   ORDER BY a."agencyId",a."workClass",a."activeGeneration"
)
SELECT (SELECT COUNT(*)::int FROM partition_reconciled) AS "updated",
       (SELECT COUNT(*)::int FROM shard_reconciled) AS "shardsSeeded",
       (SELECT COUNT(*)::int FROM agency_reconciled) AS "agenciesSeeded"
`;

function fail(message) {
  const error = new Error(String(message));
  error.code = "PHASE3_DOMAIN_WORK_CLAIM_ONLINE_ROLLOUT_FAILED";
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function boundedInteger(value, fallback, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function singleConnectionUrl(databaseUrl) {
  const raw = String(databaseUrl || "").trim();
  try {
    const url = new URL(raw);
    url.searchParams.set("connection_limit", "1");
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "10");
    if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", "10");
    return url.toString();
  } catch (_) {
    return raw;
  }
}

async function relationExists(db, table) {
  const rows = await db.$queryRawUnsafe(
    `SELECT to_regclass(format('%I.%I',current_schema(),$1))::text AS relation`,
    table,
  );
  return Boolean(rows?.[0]?.relation);
}

async function tableColumns(db, table) {
  const rows = await db.$queryRawUnsafe(`
    SELECT "column_name" AS name
      FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name=$1
     ORDER BY ordinal_position`, table);
  return new Set((rows || []).map((row) => String(row.name)));
}

async function prerequisiteState(db) {
  const tables = {};
  for (const table of REQUIRED_BASE_TABLES) tables[table] = await relationExists(db, table);
  if (!REQUIRED_BASE_TABLES.every((table) => tables[table])) return { ready: false, tables, missingDwiColumns: [] };
  const columns = await tableColumns(db, "DomainWorkItem");
  const missingDwiColumns = REQUIRED_DWI_COLUMNS.filter((column) => !columns.has(column));
  return { ready: missingDwiColumns.length === 0, tables, missingDwiColumns };
}

async function sessionState(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT pg_backend_pid()::int AS pid,current_setting('transaction_isolation') AS isolation`);
  return { pid: Number(rows?.[0]?.pid), isolation: String(rows?.[0]?.isolation || "") };
}

async function acquireRolloutAuthority(db, {
  timeoutMs = ROLLOUT_LOCK_TIMEOUT_MS,
  pollMs = ROLLOUT_LOCK_POLL_MS,
} = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    const rows = await db.$queryRawUnsafe(`
      SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired,pg_backend_pid()::int AS pid`,
    ROLLOUT_LOCK_CLASS, ROLLOUT_LOCK_KEY);
    if (rows?.[0]?.acquired === true) {
      return { pid: Number(rows[0].pid), attempts, waitMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) fail(`rollout authority was unavailable for ${timeoutMs}ms`);
    await sleep(pollMs);
  }
}

async function releaseRolloutAuthority(db, expectedPid) {
  const rows = await db.$queryRawUnsafe(`
    SELECT pg_backend_pid()::int AS pid,pg_advisory_unlock($1::int,$2::int) AS released`,
  ROLLOUT_LOCK_CLASS, ROLLOUT_LOCK_KEY);
  const pid = Number(rows?.[0]?.pid);
  if (pid !== Number(expectedPid)) fail(`rollout authority session changed expected=${expectedPid} actual=${pid}`);
  if (rows?.[0]?.released !== true) fail("rollout authority was not held at release");
}

async function withRolloutAuthority(db, work, options = undefined) {
  const authority = await acquireRolloutAuthority(db, options);
  let workError = null;
  try {
    const state = await sessionState(db);
    if (state.pid !== authority.pid) fail(`one-connection rollout contract failed expected=${authority.pid} actual=${state.pid}`);
    if (state.isolation.toLowerCase() !== "read committed") fail(`rollout requires Read Committed; got=${state.isolation}`);
    return await work({ ...authority, isolation: state.isolation });
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    try { await releaseRolloutAuthority(db, authority.pid); }
    catch (releaseError) {
      if (!workError) throw releaseError;
      console.error(`# PHASE3_DOMAIN_WORK_CLAIM_ROLLOUT_RELEASE_FAIL ${releaseError?.stack || releaseError}`);
    }
  }
}

async function ensureExpandColumns(db) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
    await tx.$executeRawUnsafe(`
      ALTER TABLE "Phase2WorkBroadClaimPartitionState"
        ADD COLUMN IF NOT EXISTS "claimShard" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "nextClaimableAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "revision" BIGINT NOT NULL DEFAULT 1`);
  }, { maxWait: 30_000, timeout: 30_000 });
  const columns = await tableColumns(db, "Phase2WorkBroadClaimPartitionState");
  const missing = PARTITION_EXPAND_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length) fail(`partition EXPAND columns missing after preflight: ${missing.join(",")}`);
}

async function currentShardConstraint(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT c.convalidated AS validated,pg_get_constraintdef(c.oid,true) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=current_schema()
       AND t.relname='Phase2WorkBroadClaimPartitionState'
       AND c.conname=$1
     LIMIT 1`, CLAIM_SHARD_CONSTRAINT);
  return rows?.[0] || null;
}

function assertShardConstraint(row, { requireValidated = true } = {}) {
  if (!row) fail(`${CLAIM_SHARD_CONSTRAINT} is missing`);
  const definition = canonical(row.definition);
  if (!definition.includes("check") || !definition.includes("claimshard>=0") || !definition.includes("claimshard<128")) {
    fail(`${CLAIM_SHARD_CONSTRAINT} definition mismatch: ${row.definition}`);
  }
  if (requireValidated && row.validated !== true) fail(`${CLAIM_SHARD_CONSTRAINT} is not validated`);
  return true;
}

async function ensureShardConstraint(db) {
  let row = await currentShardConstraint(db);
  if (row) assertShardConstraint(row, { requireValidated: false });
  if (!row) {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
      await tx.$executeRawUnsafe(`
        ALTER TABLE "Phase2WorkBroadClaimPartitionState"
          ADD CONSTRAINT "Phase2WorkBroadClaimPartitionState_claimShard_check"
          CHECK ("claimShard" >= 0 AND "claimShard" < 128) NOT VALID`);
    }, { maxWait: 30_000, timeout: 30_000 });
    row = await currentShardConstraint(db);
    assertShardConstraint(row, { requireValidated: false });
  }
  // NOT VALID already fences every new or changed locator.  Existing current
  // locators are rewritten by the bounded/resumable DWI keyset pass; stale
  // locator hints are never execution authority.  A global VALIDATE here would
  // be an unbounded O(A*C) deployment scan disguised as preflight.
  assertShardConstraint(row, { requireValidated: false });
  return row;
}

async function currentMemberScopeCardinalityConstraint(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT c.convalidated AS validated,pg_get_constraintdef(c.oid,true) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=current_schema()
       AND t.relname='AgencyMember'
       AND c.conname=$1
     LIMIT 1`, MEMBER_SCOPE_CARDINALITY_CONSTRAINT);
  return rows?.[0] || null;
}

function assertMemberScopeCardinalityConstraint(row, { requireValidated = true } = {}) {
  if (!row) fail(`${MEMBER_SCOPE_CARDINALITY_CONSTRAINT} is missing`);
  const definition = canonical(row.definition);
  if (!definition.includes("check")
      || !definition.includes("cardinalityphase2_scope_creator_idsassignedcreators<=10000")) {
    fail(`${MEMBER_SCOPE_CARDINALITY_CONSTRAINT} definition mismatch: ${row.definition}`);
  }
  if (requireValidated && row.validated !== true) fail(`${MEMBER_SCOPE_CARDINALITY_CONSTRAINT} is not validated`);
  return true;
}

async function ensureMemberScopeCardinalityConstraint(db) {
  let row = await currentMemberScopeCardinalityConstraint(db);
  if (row) assertMemberScopeCardinalityConstraint(row, { requireValidated: false });
  if (!row) {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
      await tx.$executeRawUnsafe(`
        ALTER TABLE "AgencyMember"
          ADD CONSTRAINT "AgencyMember_assignedCreators_cardinality_check"
          CHECK (cardinality("phase2_scope_creator_ids"("assignedCreators")) <= 10000) NOT VALID`);
    }, { maxWait: 30_000, timeout: 30_000 });
    row = await currentMemberScopeCardinalityConstraint(db);
    assertMemberScopeCardinalityConstraint(row, { requireValidated: false });
  }
  // NOT VALID still fences every new/changed row. Existing current members are
  // checked one keyset batch at a time by the activator; validating the whole
  // table here would reintroduce an unbounded deployment scan of membership
  // history.
  assertMemberScopeCardinalityConstraint(row, { requireValidated: false });
  return row;
}

function canonical(value) {
  return String(value || "").toLowerCase().replace(/[\s"'(),:[\]]+/g, "");
}

async function currentIndex(db, spec) {
  const rows = await db.$queryRawUnsafe(`
    SELECT idx.relname AS name,tbl.relname AS "tableName",am.amname AS "accessMethod",
           i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
           i.indnkeyatts::int AS "keyCount",
           pg_get_expr(i.indpred,i.indrelid) AS predicate,
           ARRAY(
             SELECT pg_get_indexdef(i.indexrelid,ord,true)
               FROM generate_series(1,i.indnkeyatts) AS ord
              ORDER BY ord
           ) AS "keyExpressions",
           pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class tbl ON tbl.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=tbl.relnamespace
      JOIN pg_am am ON am.oid=idx.relam
     WHERE n.nspname=current_schema() AND idx.relname=$1
     LIMIT 1`, spec.name);
  return rows?.[0] || null;
}

function assertIndex(spec, row) {
  if (!row) fail(`${spec.name} is missing`);
  if (String(row.tableName) !== spec.table) fail(`${spec.name} belongs to ${row.tableName}, expected ${spec.table}`);
  if (String(row.accessMethod).toLowerCase() !== "btree") fail(`${spec.name} is not btree`);
  if (row.valid !== true || row.ready !== true) fail(`${spec.name} is not valid/ready`);
  if (row.unique === true) fail(`${spec.name} must be non-unique`);
  const keyExpressions = Array.isArray(row.keyExpressions) ? row.keyExpressions : [];
  if (Number(row.keyCount) !== spec.keyMarkers.length || keyExpressions.length !== spec.keyMarkers.length) {
    fail(`${spec.name} key count mismatch expected=${spec.keyMarkers.length} actual=${row.keyCount}`);
  }
  spec.keyMarkers.forEach((markers, index) => {
    const expression = canonical(keyExpressions[index]);
    if (markers.length === 1) {
      if (expression !== canonical(markers[0])) {
        fail(`${spec.name} key ${index + 1} mismatch expected=${markers[0]} actual=${keyExpressions[index]}`);
      }
      return;
    }
    let expressionCursor = -1;
    for (const marker of markers) {
      const next = expression.indexOf(canonical(marker), expressionCursor + 1);
      if (next < 0) fail(`${spec.name} key ${index + 1} expression mismatch at ${marker}; actual=${keyExpressions[index]}`);
      expressionCursor = next;
    }
  });
  const predicate = canonical(row.predicate);
  if (!spec.predicateMarkers.length && predicate) fail(`${spec.name} must be non-partial; predicate=${row.predicate}`);
  if (spec.predicateMarkers.length && !predicate) fail(`${spec.name} partial predicate is missing`);
  for (const marker of spec.predicateMarkers) {
    if (!predicate.includes(canonical(marker))) fail(`${spec.name} predicate mismatch at ${marker}; actual=${row.predicate}`);
  }
  const definition = canonical(row.definition);
  let cursor = -1;
  for (const marker of spec.orderedMarkers) {
    const next = definition.indexOf(canonical(marker), cursor + 1);
    if (next < 0) fail(`${spec.name} definition/order mismatch at ${marker}; got=${row.definition}`);
    cursor = next;
  }
  return true;
}

async function indexBuildProgress(db, table) {
  const rows = await db.$queryRawUnsafe(`
    SELECT p.pid::int AS pid,p.phase,p.command
      FROM pg_stat_progress_create_index p
      JOIN pg_class tbl ON tbl.oid=p.relid
      JOIN pg_namespace n ON n.oid=tbl.relnamespace
     WHERE n.nspname=current_schema() AND tbl.relname=$1
     ORDER BY p.pid LIMIT 1`, table);
  return rows?.[0] || null;
}

async function waitForIndexPeer(db, table, {
  timeoutMs = INDEX_BUILD_TIMEOUT_MS,
  pollMs = INDEX_BUILD_POLL_MS,
} = {}) {
  const startedAt = Date.now();
  let progress = await indexBuildProgress(db, table);
  if (!progress) return { waited: false, waitMs: 0 };
  while (progress) {
    if (Date.now() - startedAt >= timeoutMs) fail(`peer index build on ${table} exceeded ${timeoutMs}ms`);
    await sleep(pollMs);
    progress = await indexBuildProgress(db, table);
  }
  return { waited: true, waitMs: Date.now() - startedAt };
}

async function ensureIndex(db, spec) {
  await waitForIndexPeer(db, spec.table);
  let row = await currentIndex(db, spec);
  let exact = false;
  if (row) {
    try { assertIndex(spec, row); exact = true; }
    catch (error) {
      console.warn(`# PHASE3_DOMAIN_WORK_CLAIM_INDEX repair ${spec.name} reason=${JSON.stringify(error.message)}`);
    }
  }
  if (exact) return { name: spec.name, created: false };
  if (row) {
    await waitForIndexPeer(db, spec.table);
    await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
  }
  console.log(`# PHASE3_DOMAIN_WORK_CLAIM_INDEX create-concurrently ${spec.name}`);
  await db.$executeRawUnsafe(spec.createSql);
  await waitForIndexPeer(db, spec.table);
  row = await currentIndex(db, spec);
  assertIndex(spec, row);
  return { name: spec.name, created: true };
}

async function runPreflight(db) {
  const prerequisites = await prerequisiteState(db);
  if (!prerequisites.ready) {
    const anyBaseTable = Object.values(prerequisites.tables).some(Boolean);
    if (anyBaseTable && prerequisites.missingDwiColumns.length) {
      fail(`partial populated prerequisite schema is missing DWI columns: ${prerequisites.missingDwiColumns.join(",")}`);
    }
    console.log(`# PHASE3_DOMAIN_WORK_CLAIM_PREFLIGHT_SKIP fresh schema tables=${JSON.stringify(prerequisites.tables)}`);
    return { skipped: true, prerequisites };
  }
  await db.$executeRawUnsafe(CLAIM_SHARD_FUNCTION_SQL);
  await db.$executeRawUnsafe(CLAIMABLE_AT_FUNCTION_SQL);
  await ensureExpandColumns(db);
  await ensureShardConstraint(db);
  await ensureMemberScopeCardinalityConstraint(db);
  const indexes = [];
  for (const spec of INDEX_SPECS) indexes.push(await ensureIndex(db, spec));
  console.log(`# PHASE3_DOMAIN_WORK_CLAIM_PREFLIGHT_PASS indexes=${indexes.length}`);
  return { skipped: false, indexes };
}

async function topologyState(db, { forUpdate = false } = {}) {
  const rows = await db.$queryRawUnsafe(`
    SELECT "id","generation","activationState","cursorAgencyId","cursorWorkClass","cursorPartitionKey",
           "cursorActiveGeneration","cursorWorkId",
           "backfilledPartitions","partitionsBackfilledAt","cursorMemberId","backfilledMembers","membersBackfilledAt",
           "startedAt","activatedAt","lastError","revision"
      FROM "DomainWorkClaimTopologyState"
     WHERE "id"=$1${forUpdate ? " FOR UPDATE" : ""}`, TOPOLOGY_ID);
  return rows?.[0] || null;
}

async function selectBackfillCandidates(tx, state, batchSize) {
  return tx.$queryRawUnsafe(`
    SELECT d."agencyId",d."workClass",d."partitionKey",d."activeGeneration",d."id"
      FROM "DomainWorkItem" d
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=d."workClass"
     WHERE ($1::text IS NULL
        OR (d."agencyId",d."workClass",d."partitionKey",d."activeGeneration",d."id")
           > ($1::text,$2::text,$3::text,$4::text,$5::text))
       AND d."isOutstanding"=TRUE
       AND (g."activeGeneration" IS NULL OR g."activeGeneration"=d."activeGeneration")
     ORDER BY d."agencyId",d."workClass",d."partitionKey",d."activeGeneration",d."id"
     LIMIT $6`,
  state.cursorAgencyId, state.cursorWorkClass, state.cursorPartitionKey,
  state.cursorActiveGeneration, state.cursorWorkId, batchSize);
}

async function lockBackfillAgencyLifecycles(tx, candidates) {
  const agencyIds = Array.from(new Set((candidates || []).map((row) => String(row.agencyId)))).sort();
  if (!agencyIds.length) return [];
  await tx.$queryRawUnsafe(`
    SELECT pg_advisory_xact_lock_shared(hashtext('agency-lifecycle:' || ordered."agencyId")) AS locked
      FROM (
        SELECT DISTINCT value AS "agencyId"
          FROM unnest($1::text[]) AS ids(value)
         ORDER BY value
      ) ordered
     ORDER BY ordered."agencyId"`, agencyIds);
  return agencyIds;
}

async function backfillBatch(db, batchSize = DEFAULT_BACKFILL_BATCH_SIZE) {
  return db.$transaction(async (tx) => {
    const state = await topologyState(tx, { forUpdate: true });
    if (!state) fail(`topology authority ${TOPOLOGY_ID} is missing`);
    if (state.generation !== TOPOLOGY_ID) fail(`unexpected topology generation ${state.generation}`);
    if (state.activationState === "ACTIVE") return { done: true, active: true, processed: 0 };
    if (state.activationState !== "BUILDING") fail(`unsupported topology state ${state.activationState}`);

    const candidates = await selectBackfillCandidates(tx, state, batchSize);
    if (!candidates.length) {
      await tx.$executeRawUnsafe(`
        UPDATE "DomainWorkClaimTopologyState"
           SET "partitionsBackfilledAt"=COALESCE("partitionsBackfilledAt",CURRENT_TIMESTAMP),
               "lastError"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$1`, TOPOLOGY_ID);
      return { done: true, active: false, processed: 0 };
    }
    await lockBackfillAgencyLifecycles(tx, candidates);
    const rows = await tx.$queryRawUnsafe(
      BACKFILL_BATCH_SQL,
      JSON.stringify(candidates.map((row) => ({
        agencyId: String(row.agencyId),
        workClass: String(row.workClass),
        partitionKey: String(row.partitionKey),
        activeGeneration: String(row.activeGeneration),
      }))),
    );
    const batch = rows?.[0] || {};
    const processed = candidates.length;
    const last = candidates[candidates.length - 1];
    await tx.$executeRawUnsafe(`
      UPDATE "DomainWorkClaimTopologyState"
         SET "cursorAgencyId"=$2,"cursorWorkClass"=$3,"cursorPartitionKey"=$4,
             "cursorActiveGeneration"=$5,"cursorWorkId"=$6,
             "backfilledPartitions"="backfilledPartitions"+$7::bigint,
             "lastError"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1`,
    TOPOLOGY_ID, last.agencyId, last.workClass, last.partitionKey,
    last.activeGeneration, last.id, Number(batch.updated || 0));
    return {
      done: false,
      active: false,
      processed,
      updated: Number(batch.updated || 0),
      shardsSeeded: Number(batch.shardsSeeded || 0),
      agenciesSeeded: Number(batch.agenciesSeeded || 0),
      cursor: {
        agencyId: last.agencyId,
        workClass: last.workClass,
        partitionKey: last.partitionKey,
        activeGeneration: last.activeGeneration,
        workId: last.id,
      },
    };
  }, { maxWait: 30_000, timeout: 300_000 });
}

async function selectMemberBackfillCandidates(tx, state, batchSize) {
  return tx.$queryRawUnsafe(`
    SELECT m."id",cardinality("phase2_scope_creator_ids"(m."assignedCreators"))::int AS "scopeCardinality"
      FROM "AgencyMember" m
     WHERE m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
       AND ($1::text IS NULL OR m."id">$1)
     ORDER BY m."id"
     FOR SHARE OF m
     LIMIT $2`, state.cursorMemberId, batchSize);
}

async function backfillMemberBatch(db, batchSize = DEFAULT_MEMBER_BACKFILL_BATCH_SIZE) {
  return db.$transaction(async (tx) => {
    const state = await topologyState(tx, { forUpdate: true });
    if (!state) fail(`topology authority ${TOPOLOGY_ID} is missing`);
    if (state.generation !== TOPOLOGY_ID) fail(`unexpected topology generation ${state.generation}`);
    if (state.activationState === "ACTIVE") return { done: true, active: true, processed: 0, grants: 0 };
    if (state.activationState !== "BUILDING") fail(`unsupported topology state ${state.activationState}`);

    const candidates = await selectMemberBackfillCandidates(tx, state, batchSize);
    if (!candidates.length) {
      await tx.$executeRawUnsafe(`
        UPDATE "DomainWorkClaimTopologyState"
           SET "membersBackfilledAt"=COALESCE("membersBackfilledAt",CURRENT_TIMESTAMP),
               "lastError"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$1`, TOPOLOGY_ID);
      return { done: true, active: false, processed: 0, grants: 0 };
    }
    const oversized = candidates.find((row) => Number(row.scopeCardinality || 0) > 10_000);
    if (oversized) {
      fail(`current member scope exceeds 10000 member=${String(oversized.id)} cardinality=${Number(oversized.scopeCardinality)}`);
    }
    let grants = 0;
    for (const candidate of candidates) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT "phase3_refresh_member_creator_scope"($1)::int AS grants`, String(candidate.id),
      );
      grants += Number(rows?.[0]?.grants || 0);
    }
    const last = String(candidates[candidates.length - 1].id);
    await tx.$executeRawUnsafe(`
      UPDATE "DomainWorkClaimTopologyState"
         SET "cursorMemberId"=$2,
             "backfilledMembers"="backfilledMembers"+$3::bigint,
             "lastError"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1`, TOPOLOGY_ID, last, candidates.length);
    return { done: false, active: false, processed: candidates.length, grants, cursor: { memberId: last } };
  }, { maxWait: 30_000, timeout: 300_000 });
}

async function validateRolloutCatalog(db) {
  for (const spec of INDEX_SPECS) assertIndex(spec, await currentIndex(db, spec));
  assertShardConstraint(await currentShardConstraint(db), { requireValidated: false });
  assertMemberScopeCardinalityConstraint(
    await currentMemberScopeCardinalityConstraint(db),
    { requireValidated: false },
  );
  const triggerRows = await db.$queryRawUnsafe(`
    SELECT t.tgname AS name,c.relname AS "tableName",t.tgenabled AS enabled,
           t.tgdeferrable AS deferrable,t.tginitdeferred AS "initiallyDeferred"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND NOT t.tgisinternal
       AND t.tgname=ANY($1::text[])
     ORDER BY t.tgname`, [
    "trg_phase3_domain_work_claim_locator_mutation_flush",
    "trg_phase3_domain_work_claim_locators_delete",
    "trg_phase3_domain_work_claim_locators_insert",
    "trg_phase3_domain_work_claim_locators_update",
  ]);
  if (triggerRows.length !== 4 || triggerRows.some((row) => row.enabled !== "O")) {
    fail(`A36 live producer triggers are missing/disabled: ${JSON.stringify(triggerRows)}`);
  }
  const retiredPartitionTriggerRows = await db.$queryRawUnsafe(`
    SELECT t.tgname AS name,c.relname AS "tableName",t.tgenabled AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND NOT t.tgisinternal
       AND t.tgname='trg_phase2_domain_work_current_partition'`);
  if (retiredPartitionTriggerRows.length !== 0) {
    fail(`A36 retired row-level partition writer is still reachable: ${JSON.stringify(retiredPartitionTriggerRows)}`);
  }
  const flush = triggerRows.find((row) => row.name === "trg_phase3_domain_work_claim_locator_mutation_flush");
  if (!flush || flush.tableName !== "DomainWorkClaimLocatorMutationBatch"
      || flush.deferrable !== true || flush.initiallyDeferred !== true) {
    fail(`A36 deferred flush trigger contract mismatch: ${JSON.stringify(flush || null)}`);
  }
  const dwiTriggers = triggerRows.filter((row) => row.name !== "trg_phase3_domain_work_claim_locator_mutation_flush");
  if (dwiTriggers.some((row) => row.tableName !== "DomainWorkItem" || row.deferrable === true)) {
    fail(`A36 DWI producer trigger contract mismatch: ${JSON.stringify(dwiTriggers)}`);
  }
  const stagingRows = await db.$queryRawUnsafe(`
    SELECT c.relname AS name,c.relpersistence AS persistence
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema()
       AND c.relname=ANY($1::text[])
     ORDER BY c.relname`, ["DomainWorkClaimLocatorMutationBatch", "DomainWorkClaimLocatorMutationIntent"]);
  if (stagingRows.length !== 2 || stagingRows.some((row) => row.persistence !== "u")) {
    fail(`A36 transaction staging catalog mismatch: ${JSON.stringify(stagingRows)}`);
  }
  const scopeTriggerRows = await db.$queryRawUnsafe(`
    SELECT t.tgname AS name,c.relname AS "tableName",t.tgenabled AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND NOT t.tgisinternal
       AND t.tgname=ANY($1::text[])
     ORDER BY t.tgname`, [
    "AgencyMember_phase3_access_epoch_fence",
    "AgencyMember_phase3_scope_projection_delete",
    "AgencyMember_phase3_scope_projection_insert",
    "AgencyMember_phase3_scope_projection_update",
  ]);
  if (scopeTriggerRows.length !== 4
      || scopeTriggerRows.some((row) => row.tableName !== "AgencyMember" || row.enabled !== "O")) {
    fail(`A36 member-scope producer triggers are missing/disabled: ${JSON.stringify(scopeTriggerRows)}`);
  }
  const generationTriggerRows = await db.$queryRawUnsafe(`
    SELECT t.tgname AS name,c.relname AS "tableName",t.tgenabled AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND NOT t.tgisinternal
       AND t.tgname='Phase2WorkGenerationAuthority_phase3_claim_invalidate'`);
  if (generationTriggerRows.length !== 1
      || generationTriggerRows[0].tableName !== "Phase2WorkGenerationAuthority"
      || generationTriggerRows[0].enabled !== "O") {
    fail(`A36 generation invalidation trigger is missing/disabled: ${JSON.stringify(generationTriggerRows)}`);
  }
  const projectionRows = await db.$queryRawUnsafe(`
    SELECT c.relname AS name,c.relpersistence AS persistence
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema()
       AND c.relname=ANY($1::text[])
     ORDER BY c.relname`, ["AgencyMemberCreatorAccessCurrent", "DomainWorkMemberScopeShardState"]);
  if (projectionRows.length !== 2 || projectionRows.some((row) => row.persistence !== "p")) {
    fail(`A36 member-scope projection catalog mismatch: ${JSON.stringify(projectionRows)}`);
  }
  const dependencyIndexRows = await db.$queryRawUnsafe(`
    SELECT i.indisvalid AS valid,i.indisready AS ready
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class tbl ON tbl.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=tbl.relnamespace
     WHERE n.nspname=current_schema()
       AND tbl.relname='DomainWorkItem'
       AND idx.relname='DomainWorkItem_blocked_dependency_partial_idx'`);
  if (dependencyIndexRows.length !== 1
      || dependencyIndexRows[0].valid !== true
      || dependencyIndexRows[0].ready !== true) {
    fail(`A36 bounded dependency wake index is missing/invalid: ${JSON.stringify(dependencyIndexRows)}`);
  }
  const dependencyFunctions = await db.$queryRawUnsafe(`
    SELECT p.proname AS name,
           pg_catalog.oidvectortypes(p.proargtypes) AS arguments,
           pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=current_schema()
       AND p.proname=ANY($1::text[])
     ORDER BY p.proname,pg_catalog.oidvectortypes(p.proargtypes)`, [
    "phase2_bump_dependency",
    "phase3_reconcile_domain_work_claim_shard",
    "phase3_wake_domain_dependency_batch",
  ]);
  const functionDefinition = (name, args) => String(dependencyFunctions.find(
    (row) => row.name === name && row.arguments === args,
  )?.definition || "");
  const bumpDefinition = functionDefinition("phase2_bump_dependency", "text, text, text");
  const wakeDefinition = functionDefinition(
    "phase3_wake_domain_dependency_batch",
    "text, text, text, bigint, integer",
  );
  const wakePrismaDefinition = functionDefinition(
    "phase3_wake_domain_dependency_batch",
    "text, text, text, bigint, bigint",
  );
  const shardStorageDefinition = functionDefinition(
    "phase3_reconcile_domain_work_claim_shard",
    "text, text, text, integer, timestamp without time zone",
  );
  const shardPrismaDefinition = functionDefinition(
    "phase3_reconcile_domain_work_claim_shard",
    "text, text, text, bigint, timestamp with time zone",
  );
  if (!bumpDefinition.includes("'DEPENDENCY_WAKE'") || /UPDATE\s+"DomainWorkItem"/i.test(bumpDefinition)) {
    fail("A36 dependency producer is not a revision-only durable wake publisher");
  }
  if (!/LIMIT\s+v_limit/i.test(wakeDefinition)
      || !/FOR UPDATE(?: OF d)? SKIP LOCKED/i.test(wakeDefinition)
      || !/v_remaining/i.test(wakeDefinition)) {
    fail("A36 bounded dependency wake function contract is incomplete");
  }
  if (!wakePrismaDefinition
      || !/LEAST\s*\(\s*COALESCE\s*\(\s*p_limit\s*,\s*100::bigint\s*\)\s*,\s*500::bigint\s*\)/i.test(wakePrismaDefinition)
      || !/\)::integer/i.test(wakePrismaDefinition)) {
    fail("A36 Prisma int8 dependency-wake ABI is missing or does not bound before narrowing");
  }
  if (!shardStorageDefinition
      || !shardPrismaDefinition
      || !/p_shard::integer/i.test(shardPrismaDefinition)
      || !/phase3_utc_timestamp/i.test(shardPrismaDefinition)) {
    fail("A36 Prisma int8/timestamptz claim-shard ABI is missing or does not delegate to storage authority");
  }
  const dependencyAuthority = await db.$queryRawUnsafe(`
    SELECT "activeGeneration","projectionVersion"
      FROM "Phase2WorkGenerationAuthority"
     WHERE "workClass"='DEPENDENCY_WAKE'`);
  if (dependencyAuthority.length !== 1
      || dependencyAuthority[0].activeGeneration !== "phase2_domain_work_v3_actual55"
      || dependencyAuthority[0].projectionVersion !== "phase2_domain_work_v3_actual55") {
    fail(`A36 dependency wake generation authority is missing/invalid: ${JSON.stringify(dependencyAuthority)}`);
  }
  return {
    valid: true,
    triggerRows,
    retiredPartitionTriggerRows,
    stagingRows,
    scopeTriggerRows,
    generationTriggerRows,
    projectionRows,
    dependencyIndexRows,
    dependencyFunctions,
    dependencyAuthority,
  };
}

async function validateTopology(db) {
  await validateRolloutCatalog(db);
  const state = await topologyState(db);
  if (!state) return { valid: false, reason: "topology_state_missing" };
  if (state.activationState === "ACTIVE") return { valid: true, alreadyActive: true, state };
  if (state.activationState !== "BUILDING") {
    return { valid: false, reason: `unsupported_topology_state:${state.activationState}`, state };
  }
  if (!state.partitionsBackfilledAt || !state.membersBackfilledAt) {
    return { valid: false, reason: "bounded_backfill_incomplete", state };
  }

  // Completion is proven at the same durable cursor boundary that performed
  // each bounded pass. Rows committed behind a cursor are covered by the live
  // DWI/AgencyMember producers installed before enumeration; rows ahead of it
  // would be returned by these index-backed one-row tail probes.
  const partitionTail = await selectBackfillCandidates(db, state, 1);
  const memberTail = await selectMemberBackfillCandidates(db, state, 1);
  const valid = partitionTail.length === 0 && memberTail.length === 0;
  return {
    valid,
    reason: valid ? null : "bounded_backfill_tail_present",
    partitionTail: partitionTail[0] || null,
    memberTail: memberTail[0] || null,
    state,
  };
}

async function activateTopologyExecutorFence(db) {
  return db.$transaction(async (tx) => {
    const locked = await topologyState(tx, { forUpdate: true });
    if (!locked || !["BUILDING", "ACTIVE"].includes(String(locked.activationState))) {
      fail(`topology activation state changed unexpectedly: ${locked?.activationState || "missing"}`);
    }
    if (locked.activationState === "BUILDING"
        && (!locked.partitionsBackfilledAt || !locked.membersBackfilledAt)) {
      fail("topology activation attempted before bounded backfill completion markers");
    }

    // This release-generation switch and topology visibility are one commit.
    // A pre-A36 replica can claim while BUILDING, but after this commit its v4
    // token cannot acquire another DWI. Claims already held under v4 are visible
    // to legacyExecutorDrainStatus and may only settle/drain.
    const authority = await tx.$queryRawUnsafe(`
      UPDATE "Phase2ReleaseCompatibilityAuthority"
         SET "requiredGeneration"=$1,
             "activationState"='ACTIVE',
             "drainStartedAt"=CASE
               WHEN "requiredGeneration" IS DISTINCT FROM $1 THEN CURRENT_TIMESTAMP
               ELSE "drainStartedAt" END,
             "activatedAt"=CURRENT_TIMESTAMP,
             "activationConfirmedAt"=CURRENT_TIMESTAMP,
             "updatedAt"=CURRENT_TIMESTAMP
       WHERE "scope"='DOMAIN_WORK_EXECUTOR'
      RETURNING "requiredGeneration","activationState"`, DOMAIN_WORK_EXECUTOR_GENERATION);
    if (!Array.isArray(authority) || authority.length !== 1
        || authority[0].requiredGeneration !== DOMAIN_WORK_EXECUTOR_GENERATION
        || authority[0].activationState !== "ACTIVE") {
      fail(`A36 DomainWork executor release authority is missing or invalid: ${JSON.stringify(authority || [])}`);
    }

    if (locked.activationState === "BUILDING") {
      const changed = await tx.$executeRawUnsafe(`
        UPDATE "DomainWorkClaimTopologyState"
           SET "activationState"='ACTIVE',"activatedAt"=CURRENT_TIMESTAMP,"lastError"=NULL,
               "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$1 AND "activationState"='BUILDING'`, TOPOLOGY_ID);
      if (Number(changed) !== 1) fail("A36 topology activation compare-and-set failed");
    }
    return { alreadyActive: locked.activationState === "ACTIVE", authority: authority[0] };
  }, { maxWait: 30_000, timeout: 30_000 });
}

async function runBuildingDependencyWakeUnit(db) {
  // The migration switches dependency producers to bounded durable wake work
  // before the potentially long A*C/member backfill.  New application replicas
  // also pump this class, but rollout correctness cannot depend on their start
  // order: the activator executes one fixed unit between every backfill commit.
  const { runDomainDependencyWakeSweep } = require("../../src/services/domain-work-authority-service");
  const report = await runDomainDependencyWakeSweep({
    db,
    now: new Date(),
    claimLimit: 20,
    wakeLimit: 100,
  });
  if (report?.ok !== true) {
    fail(`A36 dependency-wake rollout maintenance failed: ${JSON.stringify(report || {})}`);
  }
  if (report?.skipped === true
      && report?.reason !== "domain_work_dependency_wake_bridge_transition") {
    fail(`A36 dependency-wake rollout bridge unavailable: ${JSON.stringify(report || {})}`);
  }
  return report;
}

async function activateTopology(db, {
  batchSize = boundedInteger(process.env.ONLINOD_DOMAIN_WORK_CLAIM_BACKFILL_BATCH_SIZE, DEFAULT_BACKFILL_BATCH_SIZE, MAX_BACKFILL_BATCH_SIZE),
  memberBatchSize = boundedInteger(
    process.env.ONLINOD_DOMAIN_WORK_MEMBER_SCOPE_BACKFILL_BATCH_SIZE,
    DEFAULT_MEMBER_BACKFILL_BATCH_SIZE,
    MAX_MEMBER_BACKFILL_BATCH_SIZE,
  ),
  pauseMs = boundedInteger(process.env.ONLINOD_DOMAIN_WORK_CLAIM_BACKFILL_PAUSE_MS, DEFAULT_BACKFILL_PAUSE_MS, 60_000),
  onBatch = null,
} = {}) {
  if (!await relationExists(db, "DomainWorkClaimTopologyState")) {
    fail("A36 topology state is absent after migration deploy");
  }
  let state = await topologyState(db);
  if (!state) fail(`topology authority ${TOPOLOGY_ID} is missing`);
  if (state.generation !== TOPOLOGY_ID) fail(`unexpected topology generation ${state.generation}`);
  if (state.activationState === "ACTIVE") {
    await validateRolloutCatalog(db);
    await activateTopologyExecutorFence(db);
    state = await topologyState(db);
    console.log(`# PHASE3_DOMAIN_WORK_CLAIM_ACTIVATION_PASS alreadyActive=true backfilled=${String(state.backfilledPartitions)}`);
    return { alreadyActive: true, executorGeneration: DOMAIN_WORK_EXECUTOR_GENERATION, state };
  }

  let batches = 0;
  let processed = 0;
  let dependencyWakeSweeps = 0;
  let dependencyWakeSelected = 0;
  let dependencyRowsWoken = 0;
  const maintainDependencyWake = async () => {
    const report = await runBuildingDependencyWakeUnit(db);
    dependencyWakeSweeps += 1;
    dependencyWakeSelected += Number(report?.selected || 0);
    dependencyRowsWoken += Number(report?.woken || 0);
    return report;
  };

  await maintainDependencyWake();
  while (true) {
    const batch = await backfillBatch(db, batchSize);
    if (batch.done) break;
    batches += 1;
    processed += batch.processed;
    if (typeof onBatch === "function") await onBatch({ ...batch, phase: "PARTITIONS" }, { batches, processed });
    await maintainDependencyWake();
    if (pauseMs > 0) await sleep(pauseMs);
  }

  await maintainDependencyWake();
  let memberBatches = 0;
  let processedMembers = 0;
  let projectedGrants = 0;
  while (true) {
    const batch = await backfillMemberBatch(db, memberBatchSize);
    if (batch.done) break;
    memberBatches += 1;
    processedMembers += batch.processed;
    projectedGrants += batch.grants;
    if (typeof onBatch === "function") {
      await onBatch(
        { ...batch, phase: "MEMBER_SCOPES" },
        { batches, processed, memberBatches, processedMembers, projectedGrants },
      );
    }
    await maintainDependencyWake();
    if (pauseMs > 0) await sleep(pauseMs);
  }

  await maintainDependencyWake();
  const validation = await validateTopology(db);
  if (!validation.valid) fail(`A36 topology validation failed: ${JSON.stringify(validation)}`);
  await activateTopologyExecutorFence(db);
  state = await topologyState(db);
  if (state?.activationState !== "ACTIVE") fail("topology did not become ACTIVE");
  console.log(`# PHASE3_DOMAIN_WORK_CLAIM_ACTIVATION_PASS alreadyActive=false partitionBatches=${batches} partitions=${processed} memberBatches=${memberBatches} members=${processedMembers} grants=${projectedGrants} dependencyWakeSweeps=${dependencyWakeSweeps} dependencyWakeSelected=${dependencyWakeSelected} dependencyRowsWoken=${dependencyRowsWoken} backfilledPartitions=${String(state.backfilledPartitions)} backfilledMembers=${String(state.backfilledMembers)}`);
  return { alreadyActive: false, executorGeneration: DOMAIN_WORK_EXECUTOR_GENERATION, batches, processed, memberBatches, processedMembers, projectedGrants, dependencyWakeSweeps, dependencyWakeSelected, dependencyRowsWoken, validation, state };
}

async function recordActivationError(db, error) {
  try {
    if (!await relationExists(db, "DomainWorkClaimTopologyState")) return;
    await db.$executeRawUnsafe(`
      UPDATE "DomainWorkClaimTopologyState"
         SET "lastError"=$2,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP
       WHERE "id"=$1 AND "activationState"<>'ACTIVE'`,
    TOPOLOGY_ID, String(error?.message || error).slice(0, 4000));
  } catch (_) {
    // Preserve the original rollout failure.
  }
}

async function main() {
  const mode = String(process.argv[2] || "").trim();
  if (!["--preflight", "--activate"].includes(mode)) fail("usage: phase3-domain-work-claim-online-rollout.js --preflight|--activate");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: singleConnectionUrl(databaseUrl) } } });
  try {
    await db.$connect();
    await withRolloutAuthority(db, async (authority) => {
      console.log(`# PHASE3_DOMAIN_WORK_CLAIM_ROLLOUT_AUTHORITY mode=${mode} pid=${authority.pid} attempts=${authority.attempts} waitMs=${authority.waitMs}`);
      if (mode === "--preflight") return runPreflight(db);
      try { return await activateTopology(db); }
      catch (error) { await recordActivationError(db, error); throw error; }
    });
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# PHASE3_DOMAIN_WORK_CLAIM_ROLLOUT_FAIL ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  TOPOLOGY_ID,
  DOMAIN_WORK_EXECUTOR_GENERATION,
  REQUIRED_BASE_TABLES,
  REQUIRED_DWI_COLUMNS,
  PARTITION_EXPAND_COLUMNS,
  CLAIM_SHARD_CONSTRAINT,
  MEMBER_SCOPE_CARDINALITY_CONSTRAINT,
  ROLLOUT_LOCK_CLASS,
  ROLLOUT_LOCK_KEY,
  INDEX_SPECS,
  BACKFILL_BATCH_SQL,
  prerequisiteState,
  ensureExpandColumns,
  currentShardConstraint,
  assertShardConstraint,
  ensureShardConstraint,
  currentMemberScopeCardinalityConstraint,
  assertMemberScopeCardinalityConstraint,
  ensureMemberScopeCardinalityConstraint,
  currentIndex,
  assertIndex,
  ensureIndex,
  runPreflight,
  topologyState,
  selectBackfillCandidates,
  lockBackfillAgencyLifecycles,
  backfillBatch,
  selectMemberBackfillCandidates,
  backfillMemberBatch,
  validateTopology,
  validateRolloutCatalog,
  activateTopologyExecutorFence,
  runBuildingDependencyWakeUnit,
  activateTopology,
  acquireRolloutAuthority,
  releaseRolloutAuthority,
  withRolloutAuthority,
  singleConnectionUrl,
};
