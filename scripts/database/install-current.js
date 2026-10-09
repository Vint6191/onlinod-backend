#!/usr/bin/env node
"use strict";
require("dotenv").config();
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const contract = require("../../src/services/database-contract.json");
const { assertDatabaseContract } = require("../../src/services/database-contract-service");
const root = path.resolve(__dirname, "../..");
const legacyResetTarget = "20261009000000_current_baseline";
const legacyResetFlag = "--reset-legacy-test-database";
function fail(code) { throw Object.assign(new Error(code), { code }); }

// A source overlay can leave retired directories beside the current baseline.
// Prisma must never discover that mixed tree. Give it one verified migration
// in a private temporary directory; the repository itself is never rewritten.
function prepareDeployment(sourceRoot = root) {
  const sql = fs.readFileSync(path.join(sourceRoot, "prisma/migrations", contract.migration, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
  if (crypto.createHash("sha256").update(sql).digest("hex") !== contract.checksum) fail("BASELINE_SOURCE_CHECKSUM_MISMATCH");
  const schema = fs.readFileSync(path.join(sourceRoot, "prisma/schema.prisma"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-current-install-"));
  try {
    const migrationDirectory = path.join(directory, "migrations", contract.migration);
    fs.mkdirSync(migrationDirectory, { recursive: true });
    fs.writeFileSync(path.join(migrationDirectory, "migration.sql"), sql);
    fs.writeFileSync(path.join(directory, "migrations/migration_lock.toml"), 'provider = "postgresql"\n');
    const schemaPath = path.join(directory, "schema.prisma");
    fs.writeFileSync(schemaPath, schema);
    return { schemaPath, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
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
  if (rows.some(row => row.migration_name !== contract.migration || row.checksum !== contract.checksum)) fail("CURRENT_BASELINE_DATABASE_REQUIRED");
  if (rows.some(row => !row.finished_at && !row.rolled_back_at)) fail("BASELINE_INSTALLATION_INCOMPLETE");
  const applied = rows.filter(row => row.finished_at && !row.rolled_back_at);
  if (applied.length > 1) fail("DUPLICATE_BASELINE_RECEIPT");
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

function deploy(schemaPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schemaPath], { cwd: root, stdio: "inherit" });
    const forward = signal => () => child.kill(signal);
    const interrupt = forward("SIGINT"), terminate = forward("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0 && !signal) resolve();
      else reject(Object.assign(new Error("BASELINE_DEPLOY_FAILED"), { code: "BASELINE_DEPLOY_FAILED", exitCode: code, signal }));
    });
  });
}
async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== legacyResetFlag)) fail("UNKNOWN_INSTALL_ARGUMENT");
  const resetLegacy = args.includes(legacyResetFlag);
  let databaseUrl;
  try { databaseUrl = new URL(process.env.DATABASE_URL); } catch { fail("DATABASE_URL_REQUIRED"); }
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) fail("DATABASE_URL_REQUIRED");
  const configuredSchema = databaseUrl.searchParams.get("schema");
  if (configuredSchema && configuredSchema !== "public") fail("PUBLIC_SCHEMA_REQUIRED");
  const deployment = prepareDeployment();
  let db;
  try {
    db = new PrismaClient();
    const installation = resetLegacy ? await resetLegacyTestDatabase(db) : await inspectInstallation(db);
    await db.$disconnect();
    await deploy(deployment.schemaPath);
    await assertDatabaseContract(db);
    console.log(JSON.stringify({ ok: true, ...installation, version: contract.version }));
  } finally {
    try { if (db) await db.$disconnect(); } finally { deployment.dispose(); }
  }
}
function reportFailure(error) {
  const messages = {
    UNKNOWN_INSTALL_ARGUMENT: `The only supported option is ${legacyResetFlag}, which discards the pre-153 TEST database schema and its data.`,
    DATABASE_URL_REQUIRED: "Set DATABASE_URL to a PostgreSQL connection URL.",
    PUBLIC_SCHEMA_REQUIRED: "The current installation requires the public schema.",
    BASELINE_SOURCE_CHECKSUM_MISMATCH: "The current migration does not match its contract. Reapply the complete Backend package.",
    EMPTY_DATABASE_REQUIRED: "This database already contains an earlier schema. Set DATABASE_URL to a NEW EMPTY database; existing data was not changed.",
    CURRENT_BASELINE_DATABASE_REQUIRED: `Migration history differs from the current baseline; existing data was not changed. To discard a pre-153 TEST schema in this same database, run npm run prisma:migrate -- ${legacyResetFlag}. This deletes its old test data.`,
    LEGACY_TEST_RESET_NOT_APPLICABLE: "Reset refused: the history is not exclusively pre-153 migrations. A recorded current baseline (including a failed or changed one) is never reset by this option. Existing data was not changed.",
    BASELINE_INSTALLATION_INCOMPLETE: "A previous installation is incomplete. Inspect its Prisma migration receipt before retrying.",
    DUPLICATE_BASELINE_RECEIPT: "The database has duplicate baseline receipts. Installation was stopped.",
    BASELINE_DEPLOY_FAILED: "Prisma could not apply the current baseline. See its error above.",
    DATABASE_CONTRACT_REQUIRED: "The installed database differs from the current contract. Run the installer against a new empty database.",
  };
  console.error(error.code || "DATABASE_INSTALL_FAILED");
  if (messages[error.code]) console.error(messages[error.code]);
  if (error.problems?.length) console.error(JSON.stringify({ problems: error.problems }));
}
module.exports = { prepareDeployment, inspectInstallation, resetLegacyTestDatabase, main, reportFailure };
if (require.main === module) main().catch(error => { reportFailure(error); process.exitCode = 1; });
