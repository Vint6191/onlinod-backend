#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  DATABASE_PREFIX,
  directAdminUrl,
  withDatabase,
  createDisposableDatabase,
  dropDisposableDatabase,
  cleanupStaleDisposableDatabases,
  probeDatabase,
  runProof,
} = require("./phase3-a26-render-disposable");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "../..");
const CHANGED_GATE = path.join(ROOT, "scripts/audit/phase3-a26-changed-js-gate.js");
const IDENTIFIER_LINT = path.join(ROOT, "scripts/audit/phase3-postgres-identifier-lint.js");
const CONTRACT_PROOFS = [
  "src/services/analytics-recurring-planning-service.test.js",
  "src/services/analytics-collection-planner.test.js",
  "src/services/phase3-a32-durable-derived-planning-proof-authority.test.js",
  "src/services/phase3-postgres-proof-contract.test.js",
  "src/services/phase3-observation-clock-bridge-int5-7a-2.test.js",
  "src/services/phase3-a34-source-scale-closure.test.js",
  "src/services/phase3-a20-proof-runtime-contract.test.js",
].map((file) => path.join(ROOT, file));

function safeError(error) {
  return {
    name: error?.name || null,
    code: error?.code || error?.meta?.code || null,
    message: String(error?.message || error || "unknown error")
      .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://<redacted>@")
      .slice(0, 1200),
  };
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: Number.isInteger(code) ? code : 4, signal: signal || null }));
  });
}

async function main() {
  const primaryUrl = String(process.env.DATABASE_URL || "").trim();
  if (!primaryUrl) throw new Error("DATABASE_URL is required");

  const identifierLint = await run(process.execPath, [IDENTIFIER_LINT]);
  if (identifierLint.code !== 0) throw Object.assign(new Error(`A31 PostgreSQL identifier lint failed with exit ${identifierLint.code}`), { exitCode: identifierLint.code });
  console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "identifier-lint-pass" })}`);

  const changedGate = await run(process.execPath, [CHANGED_GATE]);
  if (changedGate.code !== 0) throw Object.assign(new Error(`A29 changed-JS gate failed with exit ${changedGate.code}`), { exitCode: changedGate.code });
  console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "changed-js-pass" })}`);

  // Verify the proof harness itself before allocating a database or migrating
  // anything. Static source checks alone cannot establish barrier/cleanup/error
  // behavior. These tests use no database and do not count toward physical proof.
  const contracts = await run(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...CONTRACT_PROOFS]);
  if (contracts.code !== 0) throw Object.assign(new Error(`A29 proof-contract tests failed with exit ${contracts.code}`), { exitCode: contracts.code });
  console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "proof-contracts-pass" })}`);

  const primary = directAdminUrl(primaryUrl);
  const nonce = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`.toLowerCase();
  const database = `${DATABASE_PREFIX}${nonce}`.slice(0, 63);
  const disposableUrl = withDatabase(primary.url, database);
  const admin = new PrismaClient({ datasources: { db: { url: primary.url } }, log: [] });
  let created = false;
  let cleanup = null;
  let proof = null;
  let failure = null;

  console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "prepare-disposable", database, adminDatabase: primary.database, host: primary.host })}`);
  try {
    await cleanupStaleDisposableDatabases(admin);
    await createDisposableDatabase(admin, database);
    created = true;
    console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "disposable-created", database })}`);
    const probe = await probeDatabase(disposableUrl, database);
    console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "disposable-reachable", database, attempt: probe.attempt })}`);
    proof = await runProof(primaryUrl, disposableUrl);
    console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "physical-proof-finished", status: proof.code, signal: proof.signal })}`);
    if (proof.code !== 0) throw Object.assign(new Error(`A29 disposable physical proof failed with exit ${proof.code}`), { exitCode: proof.code || 4 });
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      try {
        cleanup = await dropDisposableDatabase(admin, database);
        console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "disposable-dropped", database, mode: cleanup.mode })}`);
      } catch (error) {
        console.error(`# PHASE3_A29_DISPOSABLE_CLEANUP_FAIL ${JSON.stringify({ database, ...safeError(error) })}`);
        if (!failure) failure = error;
      }
    }
    await admin.$disconnect().catch(() => null);
  }

  if (failure) throw failure;
  if (!cleanup) throw Object.assign(new Error("A29 disposable proof database cleanup was not proven"), { exitCode: 5 });

  // Primary schema is intentionally untouched until static + disposable physical
  // proof + disposable cleanup are all green.
  const migrate = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "prisma:migrate"]);
  console.log(`# PHASE3_A29_RENDER_GATE ${JSON.stringify({ phase: "primary-migrate-finished", status: migrate.code, signal: migrate.signal })}`);
  if (migrate.code !== 0) throw Object.assign(new Error(`Primary migration failed after green disposable proof (exit ${migrate.code})`), { exitCode: migrate.code || 6 });

  const result = { ok: true, database, proofStatus: proof?.code ?? null, cleanupMode: cleanup.mode, primaryMigrationStatus: migrate.code };
  console.log(`# PHASE3_A29_RENDER_GATE_RESULT ${JSON.stringify(result)}`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# PHASE3_A29_RENDER_GATE_FAIL ${JSON.stringify(safeError(error))}`);
    process.exitCode = Number.isInteger(Number(error?.exitCode)) ? Number(error.exitCode) : 3;
  });
}

module.exports = { main, run, CONTRACT_PROOFS };
