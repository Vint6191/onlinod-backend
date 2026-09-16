"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const migrationsRoot = path.join(root, "prisma", "migrations");
const schemaSource = path.join(root, "prisma", "schema.prisma");
const lineageMigration = "20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary";
const scaleMigration = "20260916011500_actual60_refreshsession_hot_cold_scale";
const liveUserMigration = "20260916013000_actual60_refreshsession_live_user_scale";
const throughMigration = "20260916014500_actual60_refreshsession_current_write_history_scale";
const enabled = process.env.ONLINOD_ACTUAL60_MIGRATION_REHEARSAL === "1";
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const prismaCli = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function requireLocalPrismaCli() {
  if (!fs.existsSync(prismaCli)) fail(`local Prisma CLI is missing at ${prismaCli}; run npm install before migration rehearsal`, 3);
  return prismaCli;
}

function safeIdentifier(value) {
  return String(value).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 55);
}

function withSchema(urlText, schemaName) {
  const url = new URL(urlText);
  url.searchParams.set("schema", schemaName);
  return url.toString();
}

function withApplicationName(urlText, applicationName) {
  const url = new URL(urlText);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(label, command, args, env) {
  console.log(`# ACTUAL60_MIGRATION_REHEARSAL ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${label} exit=${result.status}`);
}


function runAsync(label, command, args, env) {
  console.log(`# ACTUAL60_MIGRATION_REHEARSAL ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code == null ? 1 : code, signal }));
  });
}

async function proveOnlineIndexEnsure({ rehearsalUrl, schemaName, admin }) {
  const { PrismaClient } = require("@prisma/client");
  const blocker = new PrismaClient({ datasources: { db: { url: rehearsalUrl } } });
  const appName = `onlinod_a60_online_idx_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const childUrl = withApplicationName(rehearsalUrl, appName);
  let releaseBlocker;
  let blockerLocked;
  const blockerReady = new Promise((resolve) => { blockerLocked = resolve; });
  const blockerRelease = new Promise((resolve) => { releaseBlocker = resolve; });
  let txError = null;
  const blockerTx = blocker.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE "RefreshSession" IN ROW EXCLUSIVE MODE`);
    blockerLocked();
    await blockerRelease;
  }, { maxWait: 5_000, timeout: 30_000 }).catch((error) => {
    txError = error;
    blockerLocked();
  });

  try {
    await blockerReady;
    if (txError) throw txError;

    let childDone = false;
    let childResult = null;
    let childError = null;
    const childPromise = runAsync(
      "online-index-ensure-under-row-exclusive",
      process.execPath,
      ["scripts/database/actual60-refreshsession-online-index-preflight.js"],
      { DATABASE_URL: childUrl },
    ).then((result) => { childDone = true; childResult = result; return result; })
      .catch((error) => { childDone = true; childError = error; throw error; });

    let observedCompatibleLock = false;
    const deadline = Date.now() + 10_000;
    while (!childDone && Date.now() < deadline) {
      const rows = await admin.$queryRawUnsafe(`
        SELECT l.mode, l.granted
          FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid
          JOIN pg_class c ON c.oid = l.relation
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE a.application_name = $1
           AND n.nspname = $2
           AND c.relname = 'RefreshSession'
           AND l.granted = true
      `, appName, schemaName);
      observedCompatibleLock = Array.isArray(rows) && rows.some((row) => String(row.mode) === "ShareUpdateExclusiveLock");
      if (observedCompatibleLock) break;
      await sleep(25);
    }

    if (!childDone && !observedCompatibleLock) {
      fail("online index ensure did not acquire a write-compatible ShareUpdateExclusiveLock while ROW EXCLUSIVE was held");
    }

    releaseBlocker();
    await blockerTx;
    if (txError) throw txError;
    if (childError) throw childError;
    childResult = childResult || await childPromise;
    if (childResult.code !== 0) fail(`online index ensure exit=${childResult.code}`);
    console.log(`# ACTUAL60_MIGRATION_REHEARSAL_ONLINE_INDEX_PASS observedLock=${observedCompatibleLock} childCompletedWhileBlocked=${childDone && !observedCompatibleLock}`);
  } finally {
    try { releaseBlocker(); } catch (_) {}
    try { await blockerTx; } catch (_) {}
    try { await blocker.$disconnect(); } catch (_) {}
  }
}

function copyMigrationSet(workspace, predicate) {
  const prismaDir = path.join(workspace, "prisma");
  const outMigrations = path.join(prismaDir, "migrations");
  fs.mkdirSync(outMigrations, { recursive: true });
  fs.copyFileSync(schemaSource, path.join(prismaDir, "schema.prisma"));
  const names = fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    if (!predicate(name)) continue;
    fs.cpSync(path.join(migrationsRoot, name), path.join(outMigrations, name), { recursive: true });
  }
  return path.join(prismaDir, "schema.prisma");
}

async function main() {
  if (!enabled) fail("ONLINOD_ACTUAL60_MIGRATION_REHEARSAL=1 is required", 3);
  if (!databaseUrl) fail("DATABASE_URL is required", 3);
  if (!fs.existsSync(schemaSource)) fail("prisma/schema.prisma is missing");
  for (const requiredMigration of [lineageMigration, scaleMigration, liveUserMigration, throughMigration]) {
    if (!fs.existsSync(path.join(migrationsRoot, requiredMigration, "migration.sql"))) {
      fail(`target migration ${requiredMigration} is missing`);
    }
  }

  const { PrismaClient } = require("@prisma/client");
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const schemaName = safeIdentifier(`onlinod_a60_rehearsal_${stamp}`);
  const rehearsalUrl = withSchema(databaseUrl, schemaName);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-a60-migrate-"));
  const legacyWorkspace = path.join(tmpRoot, "legacy");
  const preScaleWorkspace = path.join(tmpRoot, "pre-scale");
  const fullWorkspace = path.join(tmpRoot, "full");
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.mkdirSync(preScaleWorkspace, { recursive: true });
  fs.mkdirSync(fullWorkspace, { recursive: true });

  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let rehearsal = null;
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);

    // Stage A: start from a genuinely older populated database, before
    // authorizationSessionId exists. This is the upgrade shape that exposed
    // the INT60.3 preflight-before-migrate dead-end.
    const legacySchema = copyMigrationSet(legacyWorkspace, (name) => name < lineageMigration);
    run("deploy-pre-lineage", requireLocalPrismaCli(),
      ["migrate", "deploy", "--schema", legacySchema],
      { DATABASE_URL: rehearsalUrl });

    const userId = `a60_rehearsal_user_${stamp}`;
    const agencyId = `a60_rehearsal_agency_${stamp}`;
    const deviceId = `a60_rehearsal_device_${stamp}`;
    const lineage = `a60_rehearsal_lineage_${stamp}`;
    const legacyDeviceId = `a60_rehearsal_legacy_device_${stamp}`;
    const legacySessionId = `a60_prelineage_legacy_${stamp}`;

    rehearsal = new PrismaClient({ datasources: { db: { url: rehearsalUrl } } });
    await rehearsal.$executeRawUnsafe(`
      INSERT INTO "User"("id","email","passwordHash","emailVerifiedAt","createdAt","updatedAt")
      VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp(),clock_timestamp())
    `, userId, `${userId}@example.test`, "migration-rehearsal");
    await rehearsal.$executeRawUnsafe(`
      INSERT INTO "RefreshSession"(
        "id","userId","agencyId","tokenHash","deviceId","client","rememberDevice",
        "expiresAt","revokedAt","createdAt","lastUsedAt"
      ) VALUES ($1,$2,$3,$4,$5,$6,true,clock_timestamp() + interval '1 day',NULL,clock_timestamp(),clock_timestamp())
    `, legacySessionId, userId, agencyId, `a60_prelineage_hash_${stamp}`, legacyDeviceId, "legacy-desktop");
    await rehearsal.$disconnect();
    rehearsal = null;

    // Stage B: apply all schema prerequisites through the lineage/boundary
    // migrations, but stop before F60 scale migrations. The old row must
    // survive with NULL lineage rather than being guessed/adopted.
    const preScaleSchema = copyMigrationSet(preScaleWorkspace, (name) => name < scaleMigration);
    run("deploy-pre-scale-prerequisites", requireLocalPrismaCli(),
      ["migrate", "deploy", "--schema", preScaleSchema],
      { DATABASE_URL: rehearsalUrl });

    rehearsal = new PrismaClient({ datasources: { db: { url: rehearsalUrl } } });
    const legacyAfterPrereqs = await rehearsal.refreshSession.findUnique({ where: { id: legacySessionId } });
    if (!legacyAfterPrereqs) fail("pre-lineage legacy RefreshSession was lost by prerequisite migrations");
    if (legacyAfterPrereqs.authorizationSessionId !== null) {
      fail(`pre-lineage legacy RefreshSession was silently reclassified lineage=${legacyAfterPrereqs.authorizationSessionId}`);
    }

    // Add production-like retained history only after the lineage column is
    // available. This gives the F60 migration a large populated table while
    // preserving a real pre-cutover NULL-lineage row from Stage A.
    const base = Date.now() - 5_000 * 60_000;
    const history = [];
    for (let i = 0; i < 2_000; i += 1) {
      history.push({
        id: `a60_hist_${stamp}_${i}`,
        userId,
        agencyId,
        tokenHash: `a60_hash_${stamp}_${i}`,
        deviceId,
        authorizationSessionId: lineage,
        rememberDevice: true,
        createdAt: new Date(base + i * 60_000),
        expiresAt: new Date(base + (i + 1) * 60_000),
        revokedAt: new Date(base + (i + 1) * 60_000 - 1000),
      });
      if (history.length === 250) {
        await rehearsal.refreshSession.createMany({ data: history });
        history.length = 0;
      }
    }
    if (history.length) await rehearsal.refreshSession.createMany({ data: history });

    const expiredUnrevoked = [];
    for (let i = 0; i < 1_000; i += 1) {
      expiredUnrevoked.push({
        id: `a60_expired_${stamp}_${i}`,
        userId,
        agencyId,
        tokenHash: `a60_expired_hash_${stamp}_${i}`,
        deviceId: `a60_expired_device_${stamp}_${i}`,
        authorizationSessionId: `a60_expired_lineage_${stamp}_${i}`,
        rememberDevice: true,
        createdAt: new Date(base - (i + 2) * 60_000),
        expiresAt: new Date(base - (i + 1) * 60_000),
        revokedAt: null,
      });
      if (expiredUnrevoked.length === 250) {
        await rehearsal.refreshSession.createMany({ data: expiredUnrevoked });
        expiredUnrevoked.length = 0;
      }
    }
    if (expiredUnrevoked.length) await rehearsal.refreshSession.createMany({ data: expiredUnrevoked });

    await rehearsal.refreshSession.create({ data: {
      id: `a60_live_${stamp}`,
      userId,
      agencyId,
      tokenHash: `a60_live_hash_${stamp}`,
      deviceId,
      authorizationSessionId: lineage,
      rememberDevice: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    } });

    const before = {
      total: await rehearsal.refreshSession.count({ where: { userId } }),
      nullLineage: await rehearsal.refreshSession.count({ where: { userId, authorizationSessionId: null } }),
      lineage: await rehearsal.refreshSession.count({ where: { userId, authorizationSessionId: lineage } }),
      unrevoked: await rehearsal.refreshSession.count({ where: { userId, revokedAt: null } }),
      unexpired: await rehearsal.refreshSession.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    };

    await rehearsal.$disconnect();
    rehearsal = null;

    // Stage C: the production order is schema migrations FIRST. On a populated
    // table the F60 migration SQL must not build blocking indexes; it records
    // the migration step and leaves physical construction to Stage D.
    const fullSchema = copyMigrationSet(fullWorkspace, (name) => name <= throughMigration);
    run("deploy-through-int60.4-schema-first", requireLocalPrismaCli(),
      ["migrate", "deploy", "--schema", fullSchema],
      { DATABASE_URL: rehearsalUrl });

    rehearsal = new PrismaClient({ datasources: { db: { url: rehearsalUrl } } });
    const expectedIndexes = [
      "RefreshSession_authorization_history_idx",
      "RefreshSession_live_agency_lookup_idx",
      "RefreshSession_live_authorization_lookup_idx",
      "RefreshSession_live_lineage_lookup_idx",
      "RefreshSession_live_user_lookup_idx",
      "RefreshSession_user_history_created_idx",
    ];
    const prematureIndexes = await rehearsal.$queryRawUnsafe(`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = $1
         AND indexname IN ($2,$3,$4,$5,$6,$7)
       ORDER BY indexname
    `, schemaName, ...expectedIndexes);
    if (prematureIndexes.length) {
      fail(`populated-table F60 migration built indexes before online ensure: ${JSON.stringify(prematureIndexes)}`);
    }
    await rehearsal.$disconnect();
    rehearsal = null;

    // Stage D: build/repair physical indexes online, while a concurrent writer
    // holds ROW EXCLUSIVE. CREATE INDEX CONCURRENTLY must remain write-compatible.
    await proveOnlineIndexEnsure({ rehearsalUrl, schemaName, admin });

    rehearsal = new PrismaClient({ datasources: { db: { url: rehearsalUrl } } });
    const after = {
      total: await rehearsal.refreshSession.count({ where: { userId } }),
      nullLineage: await rehearsal.refreshSession.count({ where: { userId, authorizationSessionId: null } }),
      lineage: await rehearsal.refreshSession.count({ where: { userId, authorizationSessionId: lineage } }),
      unrevoked: await rehearsal.refreshSession.count({ where: { userId, revokedAt: null } }),
      unexpired: await rehearsal.refreshSession.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    };

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail(`historical state changed across migration before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
    if (after.nullLineage !== 1) fail(`legacy NULL-lineage row was reclassified count=${after.nullLineage}`);
    if (after.lineage !== 2001) fail(`lineage rotation history changed count=${after.lineage}`);

    const indexRows = await rehearsal.$queryRawUnsafe(`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = $1
         AND indexname IN ($2,$3,$4,$5,$6,$7)
       ORDER BY indexname
    `, schemaName, ...expectedIndexes);
    const indexes = indexRows.map((row) => row.indexname);
    if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) {
      fail(`INT60.4 index set mismatch got=${JSON.stringify(indexes)}`);
    }

    const indexHealth = await rehearsal.$queryRawUnsafe(`
      SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1
         AND t.relname = 'RefreshSession'
         AND c.relname IN ($2,$3,$4,$5,$6,$7)
       ORDER BY c.relname
    `, schemaName, ...expectedIndexes);
    if (indexHealth.length !== expectedIndexes.length
        || indexHealth.some((row) => row.valid !== true || row.ready !== true)) {
      fail(`index health mismatch got=${JSON.stringify(indexHealth)}`);
    }

    // Simulate a deploy interruption between concurrent index builds. A later
    // `npm run prisma:migrate` must recreate a missing physical index even
    // though the Prisma migration ledger is already complete.
    await rehearsal.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "RefreshSession_user_history_created_idx"`);
    run("recover-missing-online-index", process.execPath,
      ["scripts/database/actual60-refreshsession-online-index-preflight.js"],
      { DATABASE_URL: rehearsalUrl });
    const recoveredIndex = await rehearsal.$queryRawUnsafe(`
      SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname=$1
         AND t.relname='RefreshSession'
         AND c.relname='RefreshSession_user_history_created_idx'
       LIMIT 1
    `, schemaName);
    if (recoveredIndex.length !== 1 || recoveredIndex[0].valid !== true || recoveredIndex[0].ready !== true) {
      fail(`missing-index recovery failed got=${JSON.stringify(recoveredIndex)}`);
    }

    const migrationLedger = await rehearsal.$queryRawUnsafe(`
      SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations"
       WHERE migration_name IN ($1, $2, $3, $4)
       ORDER BY migration_name
    `, lineageMigration, scaleMigration, liveUserMigration, throughMigration);
    const ledgerNames = migrationLedger.map((row) => row.migration_name);
    if (JSON.stringify(ledgerNames) !== JSON.stringify([lineageMigration, scaleMigration, liveUserMigration, throughMigration])
        || migrationLedger.some((row) => !row.finished_at || row.rolled_back_at)) {
      fail(`migration ledger mismatch got=${JSON.stringify(migrationLedger)}`);
    }

    const triggerRows = await rehearsal.$queryRawUnsafe(`
      SELECT t.tgname AS name, c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND NOT t.tgisinternal
         AND t.tgname IN (
           'AgencyMember_capture_access_epoch_boundary',
           'RefreshSession_capture_authorization_boundary',
           'AgencyCreatorCatalogState_capture_generation_boundary'
         )
       ORDER BY t.tgname
    `, schemaName);
    const triggerNames = triggerRows.map((row) => row.name);
    const expectedTriggers = [
      "AgencyCreatorCatalogState_capture_generation_boundary",
      "AgencyMember_capture_access_epoch_boundary",
      "RefreshSession_capture_authorization_boundary",
    ];
    if (JSON.stringify(triggerNames) !== JSON.stringify(expectedTriggers)) {
      fail(`boundary trigger set mismatch got=${JSON.stringify(triggerNames)}`);
    }

    // Re-run BOTH stages, matching npm run prisma:migrate idempotence rather
    // than testing Prisma ledger idempotence in isolation.
    run("redeploy-idempotence-schema", requireLocalPrismaCli(),
      ["migrate", "deploy", "--schema", fullSchema],
      { DATABASE_URL: rehearsalUrl });
    run("redeploy-idempotence-online-index-ensure", process.execPath,
      ["scripts/database/actual60-refreshsession-online-index-preflight.js"],
      { DATABASE_URL: rehearsalUrl });

    const duplicateIndexes = await rehearsal.$queryRawUnsafe(`
      SELECT indexname, count(*)::int AS count
        FROM pg_indexes
       WHERE schemaname = $1
         AND indexname IN ($2,$3,$4,$5,$6,$7)
       GROUP BY indexname
      HAVING count(*) <> 1
    `, schemaName, ...expectedIndexes);
    if (duplicateIndexes.length) fail(`index duplication detected ${JSON.stringify(duplicateIndexes)}`);

    const duplicateTriggers = await rehearsal.$queryRawUnsafe(`
      SELECT t.tgname AS name, count(*)::int AS count
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND NOT t.tgisinternal
         AND t.tgname IN (
           'AgencyMember_capture_access_epoch_boundary',
           'RefreshSession_capture_authorization_boundary',
           'AgencyCreatorCatalogState_capture_generation_boundary'
         )
       GROUP BY t.tgname
      HAVING count(*) <> 1
    `, schemaName);
    if (duplicateTriggers.length) fail(`trigger duplication detected ${JSON.stringify(duplicateTriggers)}`);

    console.log(`# ACTUAL60_MIGRATION_REHEARSAL_PASS schema=${schemaName} rows=${after.total} history=${after.lineage} legacyNull=${after.nullLineage} unrevoked=${after.unrevoked} unexpired=${after.unexpired} deployOrder=schema-first-online-index-second`);
  } finally {
    if (rehearsal) {
      try { await rehearsal.$disconnect(); } catch (_) {}
    }
    try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); } catch (error) {
      console.error(`# ACTUAL60_MIGRATION_REHEARSAL_CLEANUP_WARN ${error?.message || error}`);
    }
    try { await admin.$disconnect(); } catch (_) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => {
  console.error(`# ACTUAL60_MIGRATION_REHEARSAL_FAIL ${error?.stack || error?.message || String(error)}`);
  process.exitCode = Number(error?.exitCode || 1);
});
