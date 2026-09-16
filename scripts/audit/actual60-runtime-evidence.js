"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const CRITICAL_FILES = [
  "package.json",
  "prisma/schema.prisma",
  "prisma/migrations/20260915131500_actual59_team_authorization_generation_boundary/migration.sql",
  "prisma/migrations/20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary/migration.sql",
  "prisma/migrations/20260916011500_actual60_refreshsession_hot_cold_scale/migration.sql",
  "prisma/migrations/20260916013000_actual60_refreshsession_live_user_scale/migration.sql",
  "prisma/migrations/20260916014500_actual60_refreshsession_current_write_history_scale/migration.sql",
  "prisma/migrations/20260916034500_actual60_int60_8_authorization_boundary_destructive_fence/migration.sql",
  "prisma/migrations/20260916050000_actual60_int60_10_auth_history_rollout_fence/migration.sql",
  "scripts/audit/actual59-auth-lifecycle-gate.js",
  "scripts/audit/actual60-runtime-evidence.js",
  "scripts/audit/actual60-runtime-evidence-verify.js",
  "scripts/audit/actual60-postgres-fingerprint.js",
  "scripts/audit/actual60-migration-rehearsal.js",
  "scripts/maintenance/actual60-auth-history-purge-activation.js",
  "scripts/database/actual60-refreshsession-online-index-preflight.js",
  "src/middleware/auth.js",
  "src/routes/auth.js",
  "src/routes/admin.js",
  "src/services/auth-service.js",
  "src/services/retention-service.js",
  "src/services/job-scheduler.js",
  "src/services/phase2-destructive-delete-authority-service.js",
  "src/services/authorization-session-authority-service.js",
  "src/services/actual60-authorization-history-rollout-service.js",
  "src/services/settings-service.js",
  "src/services/team-administration-service.js",
  "src/services/telemetry-ingest-service.js",
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
  "src/services/actual60-int60-8-refreshsession-retention.test.js",
  "src/services/actual60-int60-10-rolling-time-authority.test.js",
  "src/services/phase2-actual55-root-e-closure.test.js",
  "src/services/auth-device-session-isolation-v20-21.test.js",
  "src/services/actual59-team-authorization-generation-postgres.integration.test.js",
  "src/services/actual60-int60-10-rollout-postgres.integration.test.js",
  "src/services/actual59-int59-4f-telemetry-scale-postgres.integration.test.js",
  "src/services/actual60-refreshsession-scale-postgres.integration.test.js",
  "src/services/actual60-int60-8-refreshsession-retention-postgres.integration.test.js",
];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceManifest() {
  return Object.fromEntries(CRITICAL_FILES.map((relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`runtime evidence critical file is missing: ${relative}`);
    return [relative, sha256File(file)];
  }));
}

function parseTapSummary(text) {
  const value = String(text || "");
  const number = (key) => {
    const match = value.match(new RegExp(`^# ${key} (\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const tests = number("tests");
  const pass = number("pass");
  const fail = number("fail");
  const skipped = number("skipped");
  return tests === null && pass === null && fail === null && skipped === null
    ? null
    : { tests, pass, fail, skipped };
}

function dependencyVersions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).sort();
  const installed = {};
  for (const name of names) {
    try {
      const packageJson = require.resolve(`${name}/package.json`, { paths: [root] });
      installed[name] = String(JSON.parse(fs.readFileSync(packageJson, "utf8")).version || "unknown");
    } catch (_) {
      installed[name] = null;
    }
  }
  return {
    declared: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) },
    installed,
    packageLockPresent: fs.existsSync(path.join(root, "package-lock.json")),
  };
}

function writeReceipt(filePath, receipt) {
  const target = path.resolve(String(filePath || ""));
  if (!filePath) throw new Error("runtime evidence path is required");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}


const REQUIRED_CLOSURE_GATES = Object.freeze([
  "source-freeze-candidate",
  "postgres-runtime-fingerprint-migration",
  "postgres-migration-rehearsal",
  "postgres-runtime-fingerprint-pg",
  "prisma-migrate-deploy",
  "refreshsession-online-index-ensure",
  "postgres-forced-interleavings",
  "postgres-runtime-fingerprint-scale",
  "postgres-telemetry-scale",
  "postgres-refreshsession-hot-cold-scale",
  "postgres-refreshsession-retention",
]);

function validateClosureReceipt(receipt, { currentSource = false } = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== "object") return { ok: false, errors: ["receipt must be an object"] };
  if (receipt.format !== "ONLINOD_ACTUAL60_AUTH_RUNTIME_EVIDENCE_V2") errors.push("unexpected receipt format");
  if (receipt.status !== "PASSED") errors.push(`status must be PASSED, got ${receipt.status}`);
  if (receipt.mode !== "all") errors.push(`mode must be all, got ${receipt.mode}`);
  const gates = Array.isArray(receipt.gates) ? receipt.gates : [];
  const byLabel = new Map(gates.map((gate) => [gate?.label, gate]));
  for (const label of REQUIRED_CLOSURE_GATES) {
    const gate = byLabel.get(label);
    if (!gate) { errors.push(`missing required gate ${label}`); continue; }
    if (gate.exitCode !== 0) errors.push(`${label} exitCode=${gate.exitCode}`);
    if (["source-freeze-candidate", "postgres-forced-interleavings", "postgres-telemetry-scale", "postgres-refreshsession-hot-cold-scale", "postgres-refreshsession-retention"].includes(label)) {
      const tap = gate.tap;
      if (!tap) { errors.push(`${label} TAP summary missing`); continue; }
      if (tap.fail !== 0) errors.push(`${label} fail=${tap.fail}`);
      if (tap.skipped !== 0) errors.push(`${label} skipped=${tap.skipped}`);
      if (tap.tests !== tap.pass) errors.push(`${label} pass=${tap.pass} tests=${tap.tests}`);
    }
  }
  const sourceTests = byLabel.get("source-freeze-candidate")?.tap?.tests;
  if (!Number.isInteger(sourceTests) || sourceTests < 128) errors.push(`source-freeze-candidate tests=${sourceTests}, expected at least 128`);
  const exactTapCounts = {
    "postgres-forced-interleavings": 13,
    "postgres-telemetry-scale": 3,
    "postgres-refreshsession-hot-cold-scale": 1,
    "postgres-refreshsession-retention": 2,
  };
  for (const [label, expected] of Object.entries(exactTapCounts)) {
    const tests = byLabel.get(label)?.tap?.tests;
    if (tests !== expected) errors.push(`${label} tests=${tests}, expected ${expected}`);
  }
  const targets = receipt.targets || {};
  for (const label of ["migration", "pg", "scale"]) {
    if (!targets[label] || !targets[label].host || !targets[label].database) errors.push(`missing sanitized target ${label}`);
  }
  const targetKeys = ["host", "port", "database", "schema"];
  const targetFingerprints = ["migration", "pg", "scale"].map((label) =>
    targetKeys.map((key) => String(targets[label]?.[key] ?? "")).join("|")
  );
  if (new Set(targetFingerprints).size > 1) errors.push("migration/pg/scale evidence targets are not identical");
  const postgres = receipt.postgres || {};
  for (const label of ["migration", "pg", "scale"]) {
    if (!postgres[label]) errors.push(`missing PostgreSQL fingerprint ${label}`);
  }
  const pgKeys = ["database", "schema", "serverVersionNum", "defaultTransactionIsolation"];
  const pgFingerprints = ["migration", "pg", "scale"].map((label) =>
    pgKeys.map((key) => String(postgres[label]?.[key] ?? "")).join("|")
  );
  if (new Set(pgFingerprints).size > 1) errors.push("migration/pg/scale PostgreSQL fingerprints are inconsistent");
  if (receipt.failure) errors.push("failure must be null for closure evidence");
  if (currentSource) {
    try {
      const current = sourceManifest();
      const recorded = receipt.sourceSha256 || {};
      for (const [file, hash] of Object.entries(current)) {
        if (recorded[file] !== hash) errors.push(`source hash mismatch ${file}`);
      }
      for (const file of Object.keys(recorded)) {
        if (!(file in current)) errors.push(`receipt contains unknown critical file ${file}`);
      }
    } catch (error) {
      errors.push(`current source manifest failed: ${error?.message || error}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CRITICAL_FILES,
  parseTapSummary,
  sourceManifest,
  dependencyVersions,
  writeReceipt,
  REQUIRED_CLOSURE_GATES,
  validateClosureReceipt,
};
