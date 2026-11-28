#!/usr/bin/env node
"use strict";
require("dotenv").config();
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const contract = require("../../src/services/database-contract.json");
const { migrations, validMigrationPrefix, currentContract } = require("../../src/services/database-migration-chain");
const { assertDatabaseContract } = require("../../src/services/database-contract-service");
const { annotateFailure, reportFailure, deploymentFailure, preservePrimaryFailure } = require("./install-diagnostics");
const root = path.resolve(__dirname, "../..");
const legacyResetTarget = "20261009000000_current_baseline";
const legacyResetFlag = "--reset-legacy-test-database";
function fail(code) { throw Object.assign(new Error(code), { code }); }

// A source overlay can leave retired directories beside the current baseline.
// Prisma must never discover that mixed tree. Give it the explicit verified migration chain
// in a private temporary directory; the repository itself is never rewritten.
function prepareDeployment(sourceRoot = root) {
  const sources = migrations.map(migration => {
    try {
      const sql = fs.readFileSync(path.join(sourceRoot, "prisma/migrations", migration.migration, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
      if (crypto.createHash("sha256").update(sql).digest("hex") !== migration.checksum) fail("BASELINE_SOURCE_CHECKSUM_MISMATCH");
      return { ...migration, sql };
    } catch (error) {
      throw annotateFailure(error, { phase: "SOURCE_PREPARATION", domain: "core", migration: migration.migration });
    }
  });
  const schema = fs.readFileSync(path.join(sourceRoot, "prisma/schema.prisma"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nod-current-install-"));
  try {
    for (const source of sources) {
      const migrationDirectory = path.join(directory, "migrations", source.migration);
      fs.mkdirSync(migrationDirectory, { recursive: true });
      fs.writeFileSync(path.join(migrationDirectory, "migration.sql"), source.sql);
    }
    fs.writeFileSync(path.join(directory, "migrations/migration_lock.toml"), 'provider = "postgresql"\n');
    const schemaPath = path.join(directory, "schema.prisma");
    fs.writeFileSync(schemaPath, schema);
    return { schemaPath, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    let failure = error;
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch (cleanup) { failure = preservePrimaryFailure(failure, cleanup, { phase: "SOURCE_CLEANUP", domain: "core" }); }
    throw failure;
  }
}

async function inspectInstallation(db) {
  const tables = await db.$queryRawUnsafe(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')`);
  if (!tables.some(row => row.name === "_prisma_migrations")) {
    if (tables.length) fail("EMPTY_DATABASE_REQUIRED");
    return { fresh: true };
  }
  const rows = await db.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations"');
  if (rows.some(row => !migrations.some(expected => row.migration_name === expected.migration && row.checksum === expected.checksum))) fail("CURRENT_BASELINE_DATABASE_REQUIRED");
  if (rows.some(row => !row.finished_at && !row.rolled_back_at)) fail("BASELINE_INSTALLATION_INCOMPLETE");
  const applied = rows.filter(row => row.finished_at && !row.rolled_back_at);
  if (!validMigrationPrefix(rows)) {
    const activeNames = rows.filter(row => !row.rolled_back_at).map(row => row.migration_name);
    fail(new Set(activeNames).size !== activeNames.length ? "DUPLICATE_BASELINE_RECEIPT" : "NONCONTIGUOUS_BASELINE_RECEIPTS");
  }
  if (!applied.length && tables.some(row => row.name !== "_prisma_migrations")) fail("EMPTY_DATABASE_REQUIRED");
  return { fresh: applied.length === 0 };
}

// Explicit, pre-release reset of the OLD test schema in the SAME database.
// Keep this tied to the original baseline: a flag left in a Render build command
// must never turn into a general reset when a later release changes the contract.
async function resetLegacyTestDatabase(db) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '15s'");
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(20261009, 153)");
    try {
      return { ...await inspectInstallation(tx), legacyReset: false };
    } catch (error) {
      if (error.code !== "CURRENT_BASELINE_DATABASE_REQUIRED") throw error;
    }
    const rows = await tx.$queryRawUnsafe('SELECT migration_name FROM "public"."_prisma_migrations"');
    if (contract.migration !== legacyResetTarget || !rows.length || rows.some(row =>
      !/^\d{8}(?:\d{6})?_[a-zA-Z0-9_]+$/.test(row.migration_name) || row.migration_name >= legacyResetTarget
    )) fail("LEGACY_TEST_RESET_NOT_APPLICABLE");
    // The history check and schema replacement share one transaction. Failed
    // DDL rolls back the old schema; another reset rechecks after taking the lock.
    console.log("RESETTING_LEGACY_TEST_DATABASE: deleting the old public schema and its test data.");
    await tx.$executeRawUnsafe('DROP SCHEMA "public" CASCADE');
    await tx.$executeRawUnsafe('CREATE SCHEMA "public"');
    return { fresh: true, legacyReset: true };
  }, { maxWait: 15000, timeout: 120000 });
}

function deploy(schemaPath, installationUrl) {
  return new Promise((resolve, reject) => {
    const cli = path.join(root, "node_modules/prisma/build/index.js");
    // A missing CLI is a source/dependency failure, not a database error. Node's
    // raw module-not-found stack must not become the deployment diagnostic.
    fs.accessSync(cli, fs.constants.R_OK);
    const child = spawn(process.execPath, [cli, "migrate", "deploy", "--schema", schemaPath], {
      cwd: root, env: { ...process.env, DATABASE_URL: installationUrl, CHECKPOINT_DISABLE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", settled = false;
    const capture = chunk => { output = (output + chunk).slice(-256 * 1024); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const forward = signal => () => child.kill(signal);
    const interrupt = forward("SIGINT"), terminate = forward("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    child.once("error", error => { settled = true; cleanup(); reject(error); });
    // close waits for both output pipes. No raw Prisma/SQL output is logged:
    // migration errors can contain row values and connection identifiers.
    child.once("close", (code, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (code === 0 && !signal) resolve();
      else reject(deploymentFailure(output, code, signal, migrations.map(item => item.migration)));
    });
  });
}
function connectionIdentity(raw, setting) {
  const invalid = setting === "DIRECT_URL" ? "DIRECT_DATABASE_URL_INVALID" : "DATABASE_URL_REQUIRED";
  try {
    let url;
    try { url = new URL(raw); } catch { fail(invalid); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/") fail(invalid);
    if (url.searchParams.getAll("schema").some(schema => schema && schema !== "public")) fail("PUBLIC_SCHEMA_REQUIRED");
    // This release pins Prisma 5.22: it treats the URL database pathname as a
    // literal name. Decoding %xx here could authorize a different physical DB.
    return { host: url.hostname.toLowerCase().replace("-pooler.", "."), port: url.port || "5432", database: url.pathname.slice(1), schema: "public" };
  } catch (error) {
    throw annotateFailure(error, { phase: "CONFIGURATION", domain: "core", connectionSetting: setting });
  }
}
function validateConfiguration(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== legacyResetFlag)) fail("UNKNOWN_INSTALL_ARGUMENT");
  const runtime = connectionIdentity(env.DATABASE_URL, "DATABASE_URL");
  if (env.DIRECT_URL) {
    const direct = connectionIdentity(env.DIRECT_URL, "DIRECT_URL");
    if (JSON.stringify(runtime) !== JSON.stringify(direct)) throw annotateFailure(Object.assign(new Error("DIRECT_DATABASE_IDENTITY_MISMATCH"), {
      code: "DIRECT_DATABASE_IDENTITY_MISMATCH",
    }), { phase: "CONFIGURATION", domain: "core", connectionSetting: "DIRECT_URL" });
    return { installationUrl: env.DIRECT_URL, connectionSetting: "DIRECT_URL" };
  }
  return { installationUrl: env.DATABASE_URL, connectionSetting: "DATABASE_URL" };
}

async function installAnalyticsTrafficIndexes(installationUrl) {
  // Concurrent index builds must use autocommit on the direct installation
  // connection. A single physical session also owns the deployment lock for
  // the whole check/build/verify sequence, including simultaneous installers.
  const url = new URL(installationUrl);
  url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  let primary, result;
  try {
    await db.$connect();
    await db.$executeRawUnsafe("SET lock_timeout='5s'");
    await db.$executeRawUnsafe("SET statement_timeout='10min'");
    const trafficIndexes = require("./analytics-traffic-indexes");
    await trafficIndexes.acquireBuildLock(db);
    result = await trafficIndexes.ensureIndexes(db, { create: true });
  } catch (error) { primary = error; }
  finally {
    // Disconnect releases the session lock even after a failed build. An
    // invalid existing index remains explicit operator-visible repair work.
    try { await db.$disconnect(); }
    catch (error) { primary = preservePrimaryFailure(primary, error, { phase: "DATABASE_DISCONNECT", domain: "core" }); }
  }
  if (primary) throw primary;
  return result;
}

async function main(args = process.argv.slice(2)) {
  let phase = "CONFIGURATION", deployment, db, primary, result, connection;
  try {
    connection = validateConfiguration(args);
    const resetLegacy = args.includes(legacyResetFlag);
    phase = "SOURCE_PREPARATION";
    deployment = prepareDeployment();
    phase = "CORE_CONNECT";
    // DIRECT_URL is optional and installer-only. Do not mutate the runtime
    // DATABASE_URL or alter Prisma schema datasource configuration.
    db = new PrismaClient({ datasources: { db: { url: connection.installationUrl } } });
    // Prisma 5 lazy raw-query initialization can omit errorCode. Explicit
    // connection preserves the engine's stable P1000/P1001/P1003 diagnosis.
    await db.$connect();
    phase = resetLegacy ? "CORE_LEGACY_RESET" : "CORE_INSPECT";
    const installation = resetLegacy ? await resetLegacyTestDatabase(db) : await inspectInstallation(db);
    phase = "DATABASE_DISCONNECT";
    await db.$disconnect();
    phase = "CORE_DEPLOY";
    console.log(JSON.stringify({ phase, domain: "core", status: "STARTED", connectionSetting: connection.connectionSetting }));
    await deploy(deployment.schemaPath, connection.installationUrl);
    phase = "CORE_ONLINE_INDEXES";
    const indexes = await installAnalyticsTrafficIndexes(connection.installationUrl);
    phase = "CORE_VERIFY";
    await db.$connect();
    await assertDatabaseContract(db);
    result = { ok: true, domain: "core", ...installation, version: currentContract().version, indexes };
  } catch (error) {
    primary = annotateFailure(error, { phase, domain: "core", connectionSetting: connection?.connectionSetting });
  } finally {
    if (db) {
      try { await db.$disconnect(); }
      catch (error) { primary = preservePrimaryFailure(primary, error, { phase: "DATABASE_DISCONNECT", domain: "core" }); }
    }
    if (deployment) {
      try { deployment.dispose(); }
      catch (error) { primary = preservePrimaryFailure(primary, error, { phase: "SOURCE_CLEANUP", domain: "core" }); }
    }
  }
  if (primary) throw primary;
  console.log(JSON.stringify(result));
  return result;
}
module.exports = { prepareDeployment, inspectInstallation, resetLegacyTestDatabase, validateConfiguration, installAnalyticsTrafficIndexes, main, reportFailure };
if (require.main === module) main().catch(error => { reportFailure(error); process.exitCode = 1; });
