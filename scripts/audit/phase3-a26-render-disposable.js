#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "../..");
const PROOF = path.join(ROOT, "scripts/audit/phase3-a20-postgres-proof.js");
const DATABASE_PREFIX = "onlinod_a26_render_";
const STALE_DISPOSABLE_MIN_AGE_MS = 6 * 60 * 60 * 1000;

function fail(message, code = 3) {
  const error = new Error(String(message));
  error.exitCode = Number.isInteger(Number(code)) ? Number(code) : 3;
  throw error;
}

function safeError(error) {
  const message = String(error?.message || error || "unknown error")
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://<redacted>@")
    .slice(0, 2000);
  return {
    name: error?.name || null,
    code: error?.code || error?.meta?.code || null,
    message,
  };
}

function quoteIdentifier(value) {
  const text = String(value || "");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(text)) fail(`invalid disposable database identifier: ${text || "<empty>"}`);
  return `"${text}"`;
}

function directAdminUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) fail("DATABASE_URL is required for the Render disposable-database proof wrapper");
  const u = new URL(raw);
  const originalHost = u.hostname;
  // Neon pooled hosts contain `-pooler`. CREATE/DROP DATABASE are cluster-level
  // administrative statements and must use the direct endpoint. Neon direct and
  // pooled endpoints share credentials/database identity, so derive the direct
  // hostname when Render was configured with the pooled URL.
  if (/-pooler(?=\.|$)/i.test(u.hostname)) {
    u.hostname = u.hostname.replace(/-pooler(?=\.|$)/i, "");
  }
  u.searchParams.delete("schema");
  u.searchParams.delete("options");
  return { url: u.toString(), directHostDerived: originalHost !== u.hostname, host: u.hostname, database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
}


function disposableDatabaseCreatedAt(database) {
  const name = String(database || "");
  if (!name.startsWith(DATABASE_PREFIX)) return null;
  const suffix = name.slice(DATABASE_PREFIX.length);
  const encoded = suffix.split("_")[0];
  if (!/^[0-9a-z]+$/i.test(encoded)) return null;
  const millis = Number.parseInt(encoded, 36);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const createdAt = new Date(millis);
  return Number.isFinite(createdAt.getTime()) ? createdAt : null;
}

function withDatabase(value, database) {
  quoteIdentifier(database);
  const u = new URL(value);
  u.pathname = `/${database}`;
  u.searchParams.delete("schema");
  u.searchParams.delete("options");
  return u.toString();
}

function adminClient(url) {
  return new PrismaClient({ datasources: { db: { url } }, log: [] });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeDatabase(url, expectedDatabase) {
  let lastError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const db = adminClient(url);
    try {
      const rows = await db.$queryRawUnsafe(`SELECT current_database() AS database_name`);
      const current = String(rows?.[0]?.database_name || "");
      if (current !== expectedDatabase) fail(`disposable database probe reached ${current || "<unknown>"}, expected ${expectedDatabase}`);
      return { attempt, database: current };
    } catch (error) {
      lastError = error;
      if (attempt === 20) break;
      await sleep(Math.min(1000, 100 + (attempt * 100)));
    } finally {
      await db.$disconnect().catch(() => {});
    }
  }
  throw lastError || new Error("disposable database did not become reachable");
}

function runProof(primaryUrl, disposableUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROOF], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: primaryUrl,
        ONLINOD_AUDIT_DATABASE_URL: disposableUrl,
        ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE: "",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: Number.isInteger(code) ? code : 4, signal: signal || null }));
  });
}

async function createDisposableDatabase(admin, database) {
  const quoted = quoteIdentifier(database);
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quoted}`);
  } catch (error) {
    const safe = safeError(error);
    console.error(`# PHASE3_A26_DISPOSABLE_DATABASE_CREATE_UNSUPPORTED ${JSON.stringify({ database, ...safe })}`);
    const wrapped = new Error(`Unable to create disposable PostgreSQL database ${database}; the configured Neon role/endpoint does not permit CREATE DATABASE`);
    wrapped.cause = error;
    wrapped.exitCode = 3;
    throw wrapped;
  }
}

async function cleanupStaleDisposableDatabases(admin, { now = new Date(), minAgeMs = STALE_DISPOSABLE_MIN_AGE_MS } = {}) {
  const authorityNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const staleAgeMs = Math.max(60_000, Number(minAgeMs) || STALE_DISPOSABLE_MIN_AGE_MS);
  const rows = await admin.$queryRawUnsafe(
    `SELECT d.datname AS database_name,
            COUNT(a.pid)::int AS active_sessions
       FROM pg_database d
       LEFT JOIN pg_stat_activity a ON a.datname = d.datname
      WHERE d.datname LIKE $1
      GROUP BY d.datname
      ORDER BY d.datname`,
    `${DATABASE_PREFIX}%`,
  );
  const results = [];
  for (const row of rows || []) {
    const database = String(row?.database_name || "");
    const activeSessions = Number(row?.active_sessions || 0);
    if (!database.startsWith(DATABASE_PREFIX)) continue;
    const createdAt = disposableDatabaseCreatedAt(database);
    const ageMs = createdAt ? Math.max(0, authorityNow.getTime() - createdAt.getTime()) : null;
    if (!createdAt || ageMs < staleAgeMs) {
      const result = { database, action: "stale-too-young-skip", activeSessions, ageMs, minAgeMs: staleAgeMs };
      results.push(result);
      console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "stale-too-young-skip", ...result })}`);
      continue;
    }
    if (activeSessions > 0) {
      const result = { database, action: "stale-active-skip", activeSessions, ageMs, minAgeMs: staleAgeMs };
      results.push(result);
      console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "stale-active-skip", ...result })}`);
      continue;
    }
    const cleanup = await dropDisposableDatabase(admin, database);
    const result = { database, action: "stale-dropped", activeSessions, ageMs, minAgeMs: staleAgeMs, mode: cleanup.mode };
    results.push(result);
    console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "stale-dropped", ...result })}`);
  }
  return results;
}

async function dropDisposableDatabase(admin, database) {
  const quoted = quoteIdentifier(database);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE ${quoted} WITH (FORCE)`);
    return { mode: "force" };
  } catch (forceError) {
    try {
      await admin.$queryRawUnsafe(
        `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        database,
      );
      await admin.$executeRawUnsafe(`DROP DATABASE ${quoted}`);
      return { mode: "terminate_then_drop" };
    } catch (fallbackError) {
      const wrapped = new Error(`Unable to remove disposable PostgreSQL database ${database}: ${safeError(fallbackError).message}`);
      wrapped.cause = { forceError, fallbackError };
      wrapped.exitCode = 5;
      throw wrapped;
    }
  }
}

async function main() {
  const primary = directAdminUrl(process.env.DATABASE_URL);
  const nonce = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`.toLowerCase();
  const database = `${DATABASE_PREFIX}${nonce}`.slice(0, 63);
  const disposableUrl = withDatabase(primary.url, database);
  const admin = adminClient(primary.url);
  let created = false;
  let proof = null;
  let cleanup = null;
  let failure = null;

  console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "prepare", database, adminDatabase: primary.database, host: primary.host, directHostDerived: primary.directHostDerived })}`);

  try {
    await cleanupStaleDisposableDatabases(admin);
    await createDisposableDatabase(admin, database);
    created = true;
    console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "created", database })}`);

    const probe = await probeDatabase(disposableUrl, database);
    console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "reachable", database, attempt: probe.attempt })}`);

    proof = await runProof(process.env.DATABASE_URL, disposableUrl);
    console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "proof-finished", database, status: proof.code, signal: proof.signal })}`);
    if (proof.code !== 0) {
      const error = new Error(`A26 physical proof failed in disposable database ${database} with exit ${proof.code}`);
      error.exitCode = proof.code || 4;
      throw error;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      try {
        cleanup = await dropDisposableDatabase(admin, database);
        console.log(`# PHASE3_A26_RENDER_DISPOSABLE ${JSON.stringify({ phase: "dropped", database, mode: cleanup.mode })}`);
      } catch (cleanupError) {
        console.error(`# PHASE3_A26_DISPOSABLE_DATABASE_CLEANUP_FAIL ${JSON.stringify({ database, ...safeError(cleanupError) })}`);
        if (!failure) failure = cleanupError;
      }
    }
    await admin.$disconnect().catch(() => {});
  }

  const result = {
    ok: !failure,
    database,
    created,
    proofStatus: proof?.code ?? null,
    cleanupMode: cleanup?.mode || null,
    cleanupOk: created ? Boolean(cleanup) : true,
  };
  console.log(`# PHASE3_A26_RENDER_DISPOSABLE_RESULT ${JSON.stringify(result)}`);
  if (failure) throw failure;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`# PHASE3_A26_RENDER_DISPOSABLE_FAIL ${JSON.stringify(safeError(error))}`);
    process.exitCode = Number.isInteger(Number(error?.exitCode)) ? Number(error.exitCode) : 3;
  });
}

module.exports = {
  DATABASE_PREFIX,
  STALE_DISPOSABLE_MIN_AGE_MS,
  disposableDatabaseCreatedAt,
  quoteIdentifier,
  directAdminUrl,
  withDatabase,
  probeDatabase,
  createDisposableDatabase,
  dropDisposableDatabase,
  cleanupStaleDisposableDatabases,
  runProof,
  main,
};
