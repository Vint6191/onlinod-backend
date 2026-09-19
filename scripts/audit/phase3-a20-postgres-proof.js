#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const PRISMA_DIR = path.join(ROOT, "prisma");
const A13_CUTOFF = "20260919010000_phase3_provider_gate_durable_waiter_fairness_v1";
const PROOF_TESTS = [
  path.join(ROOT, "src/services/phase3-provider-capacity-postgres-int5-9a-15.integration.test.js"),
  path.join(ROOT, "src/services/phase3-provider-topology-postgres-int5-9a-16.integration.test.js"),
  path.join(ROOT, "src/services/phase3-provider-actual-category-postgres-int5-9a-17.integration.test.js"),
  path.join(ROOT, "src/services/phase3-provider-future-debt-postgres-int5-9a-18.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a19.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-3.integration.test.js"),
  path.join(ROOT, "src/services/phase3-campaign-closure-a20-4.integration.test.js"),
];

function fail(message, code = 3) {
  console.error(`# PHASE3_A20_POSTGRES_PROOF_FAIL ${message}`);
  process.exit(code);
}
function normalizedDbIdentity(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch (_) { return null; }
}
function auditUrl() {
  const audit = String(process.env.ONLINOD_AUDIT_DATABASE_URL || "").trim();
  const primary = String(process.env.DATABASE_URL || "").trim();
  if (!audit) fail("ONLINOD_AUDIT_DATABASE_URL is required; refusing to mutate the primary database implicitly");
  if (primary && normalizedDbIdentity(primary) === normalizedDbIdentity(audit) && process.env.ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE !== "1") {
    fail("ONLINOD_AUDIT_DATABASE_URL resolves to the primary physical database; use a disposable PostgreSQL database or explicitly opt in");
  }
  return audit;
}
function localPrismaCli() {
  const bin = process.platform === "win32" ? "prisma.cmd" : "prisma";
  const file = path.join(ROOT, "node_modules", ".bin", bin);
  if (!fs.existsSync(file)) fail("local Prisma CLI is unavailable; run npm install in the Backend proof environment");
  return file;
}
function withSchema(url, schema) {
  const u = new URL(url);
  u.searchParams.set("schema", schema);
  return u.toString();
}
function run(label, command, args, env, input = undefined) {
  const out = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(out.stdout || "");
  process.stderr.write(out.stderr || "");
  if (out.error || out.status !== 0) fail(`${label} failed (${out.error?.message || `exit ${out.status}`})`, out.status || 4);
}
function clonePrisma(targetRoot, cutoff = null) {
  const target = path.join(targetRoot, "prisma");
  fs.mkdirSync(path.join(target, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(PRISMA_DIR, "schema.prisma"), path.join(target, "schema.prisma"));
  for (const name of fs.readdirSync(path.join(PRISMA_DIR, "migrations")).sort()) {
    if (cutoff && name > cutoff) continue;
    fs.cpSync(path.join(PRISMA_DIR, "migrations", name), path.join(target, "migrations", name), { recursive: true });
  }
  return target;
}
function addMigrationsAfter(targetPrisma, cutoff) {
  for (const name of fs.readdirSync(path.join(PRISMA_DIR, "migrations")).sort()) {
    if (name <= cutoff) continue;
    const dest = path.join(targetPrisma, "migrations", name);
    if (!fs.existsSync(dest)) fs.cpSync(path.join(PRISMA_DIR, "migrations", name), dest, { recursive: true });
  }
}
function dropSchema(cli, audit, schema, schemaFile) {
  const sql = `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`;
  const base = withSchema(audit, "public");
  const out = spawnSync(cli, ["db", "execute", "--stdin", "--schema", schemaFile], { cwd: ROOT, env: { ...process.env, DATABASE_URL: base }, input: sql, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (out.status !== 0) console.warn(`# PHASE3_A20_POSTGRES_PROOF_CLEANUP_WARN ${schema}: ${out.stderr || out.stdout}`);
}

(function main() {
  const audit = auditUrl();
  const cli = localPrismaCli();
  const nonce = crypto.randomBytes(5).toString("hex");
  const cleanSchema = `onlinod_a20_clean_${nonce}`;
  const rollingSchema = `onlinod_a20_roll_${nonce}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-a20-pg-"));
  const cleanRoot = path.join(temp, "clean");
  const rollingRoot = path.join(temp, "rolling");
  const cleanPrisma = clonePrisma(cleanRoot);
  const rollingPrisma = clonePrisma(rollingRoot, A13_CUTOFF);
  const cleanSchemaFile = path.join(cleanPrisma, "schema.prisma");
  const rollingSchemaFile = path.join(rollingPrisma, "schema.prisma");
  try {
    const cleanUrl = withSchema(audit, cleanSchema);
    run("clean-current-migrate", cli, ["migrate", "deploy", "--schema", cleanSchemaFile], { DATABASE_URL: cleanUrl });
    run("clean-current-proof", process.execPath, ["--test", ...PROOF_TESTS], { DATABASE_URL: cleanUrl, ONLINOD_POSTGRES_INTEGRATION: "1" });

    const rollingUrl = withSchema(audit, rollingSchema);
    run("rolling-a13-migrate", cli, ["migrate", "deploy", "--schema", rollingSchemaFile], { DATABASE_URL: rollingUrl });
    addMigrationsAfter(rollingPrisma, A13_CUTOFF);
    run("rolling-a13-to-current-migrate", cli, ["migrate", "deploy", "--schema", rollingSchemaFile], { DATABASE_URL: rollingUrl });
    run("rolling-a13-to-current-proof", process.execPath, ["--test", ...PROOF_TESTS], { DATABASE_URL: rollingUrl, ONLINOD_POSTGRES_INTEGRATION: "1" });

    console.log(`# PHASE3_A20_POSTGRES_PROOF_JSON ${JSON.stringify({ ok: true, cleanSchema, rollingSchema, a13Cutoff: A13_CUTOFF })}`);
  } finally {
    dropSchema(cli, audit, cleanSchema, cleanSchemaFile);
    dropSchema(cli, audit, rollingSchema, rollingSchemaFile);
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
