#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  CURRENT_RUN_INDEX_NAME,
  currentRunIndex,
  assertCurrentRunIndex,
} = require("../database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");
const PREFLIGHT = path.join(ROOT, "scripts/database/phase3-campaign-coverage-generation-online-preflight.js");
const scenario = String(process.argv[2] || "absent").trim().toLowerCase();

function fail(message) { throw new Error(String(message)); }
function runPreflight(label, databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PREFLIGHT], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) return reject(new Error(`${label} failed code=${code} signal=${signal || "none"}\n${stderr || stdout}`));
      if (!stdout.includes("PHASE3_CAMPAIGN_COVERAGE_INDEX_CONNECTION_CONTRACT_PASS") || !stdout.includes("authority=session_try_lock")) {
        return reject(new Error(`${label} did not prove nonblocking session lifecycle authority on the dedicated PostgreSQL index connection`));
      }
      resolve({ label, stdout, stderr });
    });
  });
}

async function exactIndex(db) {
  const row = await currentRunIndex(db);
  if (!row) fail(`${CURRENT_RUN_INDEX_NAME} missing after lifecycle proof`);
  assertCurrentRunIndex(row);
  return row;
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    if (scenario === "absent") {
      await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${CURRENT_RUN_INDEX_NAME}"`);
      if (await currentRunIndex(db)) fail("absent-index proof could not remove current-run index");
      const peers = await Promise.all([
        runPreflight("a20.12-absent-peer-a", databaseUrl),
        runPreflight("a20.12-absent-peer-b", databaseUrl),
      ]);
      if (peers.length !== 2) fail("absent-index proof did not complete both full preflight processes");
      await exactIndex(db);
      console.log("# A20_12_INDEX_ABSENT_CONCURRENCY_PASS");
      return;
    }

    if (scenario === "invalid") {
      await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${CURRENT_RUN_INDEX_NAME}"`);
      let failedBuild = false;
      try {
        // Deterministically manufacture the same catalog state left by an
        // interrupted CREATE INDEX CONCURRENTLY: an index row exists but is
        // invalid. The seeded proof contains many work rows for one creator, so
        // this intentionally-invalid UNIQUE build must fail on duplicates.
        await db.$executeRawUnsafe(
          `CREATE UNIQUE INDEX CONCURRENTLY "${CURRENT_RUN_INDEX_NAME}" ON "CreatorCampaignFanRefreshWork" ("creatorId")`,
        );
      } catch (error) {
        failedBuild = true;
        console.log(`# A20_12_INDEX_EXPECTED_FAILED_BUILD ${JSON.stringify(String(error?.message || error))}`);
      }
      if (!failedBuild) fail("invalid-index proof expected the deliberately conflicting concurrent build to fail");
      const abandoned = await currentRunIndex(db);
      if (!abandoned) fail("failed concurrent build did not leave an inspectable index catalog row");
      if (abandoned.valid === true && abandoned.ready === true) fail("failed concurrent build unexpectedly produced a valid/ready index");

      const peers = await Promise.all([
        runPreflight("a20.12-invalid-peer-a", databaseUrl),
        runPreflight("a20.12-invalid-peer-b", databaseUrl),
      ]);
      if (peers.length !== 2) fail("invalid-index proof did not complete both full preflight processes");
      await exactIndex(db);
      console.log("# A20_12_INDEX_INVALID_RECOVERY_PASS");
      return;
    }

    fail(`unknown scenario ${scenario}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`# A20_12_INDEX_LIFECYCLE_FAIL ${error?.stack || error?.message || error}`);
  process.exitCode = 3;
});
