"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  parseTapSummary,
  sourceManifest,
  dependencyVersions,
  writeReceipt,
  validateClosureReceipt,
} = require("./actual60-runtime-evidence");

const root = path.resolve(__dirname, "../..");
const mode = String(process.argv[2] || "source").toLowerCase();
const valid = new Set(["source", "migration", "pg", "scale", "all"]);
const startedAt = new Date();
const runId = crypto.randomUUID();
const evidencePath = String(process.env.ONLINOD_AUDIT_EVIDENCE_PATH || "").trim();
const evidenceGates = [];
const evidenceTargets = new Map();
const evidencePostgres = new Map();
const prismaCli = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");

class GateFailure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "GateFailure";
    this.code = Number(code) || 1;
  }
}

function fail(message, code = 1) {
  throw new GateFailure(message, code);
}

function requireLocalPrismaCli() {
  if (!fs.existsSync(prismaCli)) {
    fail(`local Prisma CLI is missing at ${prismaCli}; run npm install before PostgreSQL closure evidence`, 3);
  }
  return prismaCli;
}

if (!valid.has(mode)) {
  console.error("usage: node scripts/audit/actual59-auth-lifecycle-gate.js [source|migration|pg|scale|all]");
  process.exit(2);
}
if (mode === "all" && !evidencePath) {
  console.error("# ACTUAL59_GATE_BLOCKED all: ONLINOD_AUDIT_EVIDENCE_PATH is required for a complete closure run");
  process.exit(3);
}

function safeSourceManifest() {
  try { return sourceManifest(); } catch (error) { return { __error: String(error?.message || error) }; }
}
function safeDependencies() {
  try { return dependencyVersions(); } catch (error) { return { __error: String(error?.message || error) }; }
}

function receiptObject(status, error = null) {
  const passed = status === "PASSED";
  const receipt = {
    format: "ONLINOD_ACTUAL60_AUTH_RUNTIME_EVIDENCE_V2",
    runId,
    status,
    mode,
    completeClosureRun: passed && mode === "all",
    startedAt: startedAt.toISOString(),
    finishedAt: status === "RUNNING" ? null : new Date().toISOString(),
    node: process.version,
    targets: Object.fromEntries(evidenceTargets),
    postgres: Object.fromEntries(evidencePostgres),
    gates: evidenceGates,
    sourceSha256: status === "RUNNING" ? null : safeSourceManifest(),
    dependencies: status === "RUNNING" ? null : safeDependencies(),
    failure: error ? { message: String(error.message || error), code: Number(error.code || 1) } : null,
  };
  if (passed && mode === "all") {
    const validation = validateClosureReceipt(receipt, { currentSource: true });
    if (!validation.ok) {
      fail(`complete closure receipt validation failed: ${validation.errors.join("; ")}`);
    }
    receipt.closureEvidenceValid = true;
  } else {
    receipt.closureEvidenceValid = false;
  }
  return receipt;
}

function persistReceipt(status, error = null) {
  if (!evidencePath) return null;
  const written = writeReceipt(evidencePath, receiptObject(status, error));
  console.log(`# ACTUAL59_GATE_EVIDENCE status=${status} path=${written}`);
  return written;
}

// Overwrite any old green receipt before the first gate starts. A hard-killed run
// therefore leaves RUNNING evidence, never a stale PASSED artifact.
persistReceipt("RUNNING");

function assertTapContract(label, tap, contract) {
  if (!contract) return;
  if (!tap) fail(`${label}: TAP summary missing`);
  for (const field of ["tests", "pass", "fail", "skipped"]) {
    if (!Number.isInteger(tap[field])) fail(`${label}: TAP ${field} is missing`);
  }
  if (tap.fail !== 0) fail(`${label}: TAP fail=${tap.fail}`);
  if (tap.skipped !== 0) fail(`${label}: TAP skipped=${tap.skipped}; empirical closure does not accept skipped tests`);
  if (tap.pass !== tap.tests) fail(`${label}: TAP pass=${tap.pass} tests=${tap.tests}`);
  if (Number.isInteger(contract.exactTests) && tap.tests !== contract.exactTests) {
    fail(`${label}: TAP tests=${tap.tests}, expected exactly ${contract.exactTests}`);
  }
  if (Number.isInteger(contract.minTests) && tap.tests < contract.minTests) {
    fail(`${label}: TAP tests=${tap.tests}, expected at least ${contract.minTests}`);
  }
}

function run(label, command, args, env = {}, tapContract = null) {
  console.log(`\n# ACTUAL59_GATE ${label}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`${label}: spawn failed: ${result.error.message}`);
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const tap = parseTapSummary(combined);
  evidenceGates.push({
    label,
    exitCode: result.status,
    durationMs: Date.now() - started,
    tap,
  });
  if (result.status !== 0) fail(`${label}: child exit=${result.status}`, result.status || 1);
  assertTapContract(label, tap, tapContract);
  console.log(`# ACTUAL59_GATE_PASS ${label}`);
  return { combined, result, tap };
}

function canonicalDatabaseTarget(urlText) {
  try {
    const url = new URL(String(urlText || ""));
    return {
      protocol: url.protocol,
      host: url.hostname.toLowerCase(),
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      schema: String(url.searchParams.get("schema") || "public"),
    };
  } catch (_) {
    return null;
  }
}

function samePhysicalDatabase(a, b) {
  const left = canonicalDatabaseTarget(a);
  const right = canonicalDatabaseTarget(b);
  if (!left || !right) return String(a || "").trim() === String(b || "").trim();
  return left.host === right.host
    && left.port === right.port
    && left.database === right.database;
}

function resolveAuditDatabase(label) {
  const primary = String(process.env.DATABASE_URL || "").trim();
  const audit = String(process.env.ONLINOD_AUDIT_DATABASE_URL || "").trim();
  const allowPrimary = process.env.ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE === "1";

  if (!audit && !primary) {
    fail(`${label}: ONLINOD_AUDIT_DATABASE_URL is required for mutating PostgreSQL evidence`, 3);
  }
  if (!audit && primary && !allowPrimary) {
    fail(`${label}: refusing to run mutating audit against DATABASE_URL; set ONLINOD_AUDIT_DATABASE_URL to a disposable PostgreSQL database (or explicitly set ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE=1)`, 3);
  }

  const selected = audit || primary;
  if (audit && primary && samePhysicalDatabase(audit, primary) && !allowPrimary) {
    fail(`${label}: ONLINOD_AUDIT_DATABASE_URL resolves to the same physical database as DATABASE_URL; a different schema is not sufficient isolation for migration/load evidence`, 3);
  }

  const target = canonicalDatabaseTarget(selected);
  const safeTarget = {
    host: target?.host || "unknown",
    port: target?.port || "unknown",
    database: target?.database || "unknown",
    schema: target?.schema || "unknown",
    source: audit ? "ONLINOD_AUDIT_DATABASE_URL" : "DATABASE_URL_EXPLICIT_OVERRIDE",
  };
  evidenceTargets.set(label, safeTarget);
  console.log(`# ACTUAL59_GATE_DATABASE ${label} host=${safeTarget.host} port=${safeTarget.port} database=${safeTarget.database} schema=${safeTarget.schema} source=${safeTarget.source}`);
  return selected;
}

function fingerprintDatabase(label, auditDatabaseUrl) {
  const output = run(`postgres-runtime-fingerprint-${label}`, process.execPath, ["scripts/audit/actual60-postgres-fingerprint.js"], {
    DATABASE_URL: auditDatabaseUrl,
  });
  const match = output.combined.match(/^# ACTUAL60_POSTGRES_FINGERPRINT_JSON (\{.*\})$/m);
  if (!match) fail(`${label}: PostgreSQL fingerprint output missing`);
  try {
    evidencePostgres.set(label, JSON.parse(match[1]));
  } catch (error) {
    fail(`${label}: invalid PostgreSQL fingerprint JSON ${error?.message || error}`);
  }
}

function sourceGate() {
  run("source-freeze-candidate", process.execPath, ["--test",
    "src/services/actual59-int59-4f-freeze-candidate.test.js",
    "src/services/actual59-int59-4c-auth-writer-matrix.test.js",
    "src/services/actual59-int59-4e-migration-activation.test.js",
    "src/services/actual59-int59-3-auth-lineage.test.js",
    "src/routes/actual59-int59-4d-auth-rolling-http.test.js",
    "src/middleware/auth-device-logout-v20-21.test.js",
    "src/services/actual59-team-authorization-generation-closure.test.js",
    "src/services/team-performance-authorization-generation-int2-6.test.js",
    "src/services/team-telemetry-provenance-v13.test.js",
    "src/services/actual60-refreshsession-hot-cold-scale.test.js",
    "src/services/actual60-migration-rehearsal-source.test.js",
    "src/services/actual60-int60-3-online-migration-source.test.js",
    "src/services/actual60-int60-3-refreshsession-antimap.test.js",
    "src/services/actual60-int60-4-current-session-writer-scale.test.js",
    "src/services/actual60-int60-5-runtime-database-safety.test.js",
    "src/services/actual60-int60-5-runtime-evidence-receipt.test.js",
    "src/services/actual60-int60-5-refreshsession-mutation-antimap.test.js",
    "src/services/actual60-int60-6-runtime-closure-integrity.test.js",
    "src/services/actual60-int60-7-prisma-regclass-preflight.test.js",
    "src/services/actual60-int60-8-refreshsession-retention.test.js",
    "src/services/actual60-int60-10-rolling-time-authority.test.js",
    "src/services/phase2-actual55-root-e-closure.test.js",
    "src/services/auth-device-session-isolation-v20-21.test.js",
  ], {
    ONLINOD_AUDIT_EVIDENCE_PATH: "",
    DATABASE_URL: "",
    ONLINOD_AUDIT_DATABASE_URL: "",
    ONLINOD_POSTGRES_INTEGRATION: "",
    ONLINOD_ACTUAL59_SCALE_INTEGRATION: "",
    ONLINOD_ACTUAL60_REFRESHSESSION_SCALE_INTEGRATION: "",
    ONLINOD_ACTUAL60_MIGRATION_REHEARSAL: "",
  }, { minTests: 128 });
}

function migrationGate() {
  const auditDatabaseUrl = resolveAuditDatabase("migration");
  fingerprintDatabase("migration", auditDatabaseUrl);
  run("postgres-migration-rehearsal", process.execPath, ["scripts/audit/actual60-migration-rehearsal.js"], {
    DATABASE_URL: auditDatabaseUrl,
    ONLINOD_ACTUAL60_MIGRATION_REHEARSAL: "1",
  });
}

function pgGate() {
  const auditDatabaseUrl = resolveAuditDatabase("pg");
  fingerprintDatabase("pg", auditDatabaseUrl);
  if (mode === "all" || process.env.ONLINOD_ACTUAL59_GATE_MIGRATE === "1") {
    run("prisma-migrate-deploy", requireLocalPrismaCli(), ["migrate", "deploy"], { DATABASE_URL: auditDatabaseUrl });
    run("refreshsession-online-index-ensure", process.execPath, ["scripts/database/actual60-refreshsession-online-index-preflight.js"], { DATABASE_URL: auditDatabaseUrl });
  }
  run("postgres-forced-interleavings", process.execPath, ["--test", "src/services/actual59-team-authorization-generation-postgres.integration.test.js", "src/services/actual60-int60-10-rollout-postgres.integration.test.js"], {
    DATABASE_URL: auditDatabaseUrl,
    ONLINOD_POSTGRES_INTEGRATION: "1",
  }, { exactTests: 13 });
}

function scaleGate() {
  const auditDatabaseUrl = resolveAuditDatabase("scale");
  fingerprintDatabase("scale", auditDatabaseUrl);
  run("postgres-telemetry-scale", process.execPath, ["--test", "src/services/actual59-int59-4f-telemetry-scale-postgres.integration.test.js"], {
    DATABASE_URL: auditDatabaseUrl,
    ONLINOD_ACTUAL59_SCALE_INTEGRATION: "1",
  }, { exactTests: 3 });
  run("postgres-refreshsession-hot-cold-scale", process.execPath, ["--test", "src/services/actual60-refreshsession-scale-postgres.integration.test.js"], {
    DATABASE_URL: auditDatabaseUrl,
    ONLINOD_ACTUAL60_REFRESHSESSION_SCALE_INTEGRATION: "1",
  }, { exactTests: 1 });
  run("postgres-refreshsession-retention", process.execPath, ["--test", "src/services/actual60-int60-8-refreshsession-retention-postgres.integration.test.js"], {
    DATABASE_URL: auditDatabaseUrl,
    ONLINOD_ACTUAL60_REFRESHSESSION_RETENTION_INTEGRATION: "1",
  }, { exactTests: 2 });
}

let terminalStatus = "PASSED";
let terminalError = null;
try {
  if (mode === "source" || mode === "all") sourceGate();
  if (mode === "migration" || mode === "all") migrationGate();
  if (mode === "pg" || mode === "all") pgGate();
  if (mode === "scale" || mode === "all") scaleGate();
  // Force manifest/dependency collection before declaring success.
  sourceManifest();
  dependencyVersions();
} catch (error) {
  terminalError = error instanceof GateFailure ? error : new GateFailure(String(error?.stack || error), 1);
  terminalStatus = terminalError.code === 3 ? "BLOCKED" : "FAILED";
  console.error(`# ACTUAL59_GATE_${terminalStatus} ${terminalError.message}`);
}

try {
  persistReceipt(terminalStatus, terminalError);
} catch (receiptError) {
  console.error(`# ACTUAL59_GATE_RECEIPT_FAIL ${receiptError?.stack || receiptError}`);
  if (!terminalError) {
    terminalError = new GateFailure(`evidence receipt failed: ${receiptError?.message || receiptError}`, 1);
    terminalStatus = "FAILED";
  }
  if (evidencePath) {
    try {
      const written = writeReceipt(evidencePath, receiptObject("FAILED", terminalError));
      console.log(`# ACTUAL59_GATE_EVIDENCE status=FAILED path=${written}`);
    } catch (secondary) {
      console.error(`# ACTUAL59_GATE_RECEIPT_SECONDARY_FAIL ${secondary?.stack || secondary}`);
    }
  }
}

if (terminalError) process.exitCode = terminalError.code || 1;
