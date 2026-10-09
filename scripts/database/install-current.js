#!/usr/bin/env node
"use strict";
require("dotenv").config();
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const contract = require("../../src/services/database-contract.json");
const { assertDatabaseContract } = require("../../src/services/database-contract-service");
const root = path.resolve(__dirname, "../..");
function fail(code) { throw Object.assign(new Error(code), { code }); }

async function inspectInstallation(db) {
  const sql = fs.readFileSync(path.join(root, "prisma/migrations", contract.migration, "migration.sql"));
  if (crypto.createHash("sha256").update(sql).digest("hex") !== contract.checksum) fail("BASELINE_SOURCE_CHECKSUM_MISMATCH");
  const names = fs.readdirSync(path.join(root, "prisma/migrations"), { withFileTypes: true }).filter(row => row.isDirectory()).map(row => row.name);
  if (names.length !== 1 || names[0] !== contract.migration) fail("RETIRED_MIGRATION_FILES_PRESENT");
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
function deploy() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: root, stdio: "inherit" });
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
async function main() {
  const configuredSchema = new URL(process.env.DATABASE_URL).searchParams.get("schema");
  if (configuredSchema && configuredSchema !== "public") fail("PUBLIC_SCHEMA_REQUIRED");
  const db = new PrismaClient();
  try {
    const installation = await inspectInstallation(db);
    await db.$disconnect();
    await deploy();
    await assertDatabaseContract(db);
    console.log(JSON.stringify({ ok: true, ...installation, version: contract.version }));
  } finally { await db.$disconnect(); }
}
module.exports = { inspectInstallation, main };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
