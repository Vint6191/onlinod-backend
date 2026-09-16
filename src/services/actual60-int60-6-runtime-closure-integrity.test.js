"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const gatePath = path.join(root, "scripts/audit/actual59-auth-lifecycle-gate.js");
const source = fs.readFileSync(gatePath, "utf8");
const evidence = require(path.join(root, "scripts/audit/actual60-runtime-evidence.js"));

function runGate(mode, env = {}) {
  return spawnSync(process.execPath, [gatePath, mode], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: "",
      ONLINOD_AUDIT_DATABASE_URL: "",
      ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE: "",
      ONLINOD_AUDIT_EVIDENCE_PATH: "",
      ...env,
    },
    encoding: "utf8",
  });
}

test("INT60.6 closure integrity: same physical production DB is rejected even when audit schema differs", () => {
  const result = runGate("pg", {
    DATABASE_URL: "postgresql://prod:one@db.example.test:5432/onlinod?schema=public",
    ONLINOD_AUDIT_DATABASE_URL: "postgresql://audit:two@DB.EXAMPLE.TEST:5432/onlinod?schema=audit60",
  });
  assert.equal(result.status, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /same physical database/);
});

test("INT60.6 closure integrity: complete all run requires a durable evidence path before doing any work", () => {
  const result = runGate("all", {
    ONLINOD_AUDIT_DATABASE_URL: "postgresql://audit:secret@audit.example.test:5432/onlinod_audit?schema=public",
  });
  assert.equal(result.status, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /ONLINOD_AUDIT_EVIDENCE_PATH is required/);
});

test("INT60.6 closure integrity: a blocked run overwrites a stale green receipt with BLOCKED evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-a60-blocked-"));
  const receiptPath = path.join(dir, "receipt.json");
  fs.writeFileSync(receiptPath, JSON.stringify({ status: "PASSED", stale: true }));
  const result = runGate("pg", {
    DATABASE_URL: "postgresql://prod:secret@prod.example.test:5432/onlinod?schema=public",
    ONLINOD_AUDIT_EVIDENCE_PATH: receiptPath,
  });
  assert.equal(result.status, 3);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.format, "ONLINOD_ACTUAL60_AUTH_RUNTIME_EVIDENCE_V2");
  assert.equal(receipt.status, "BLOCKED");
  assert.equal(receipt.closureEvidenceValid, false);
  assert.equal(receipt.failure.code, 3);
  assert.equal(receipt.stale, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("INT60.6 closure integrity: empirical TAP gates reject skips and pin exact PG/scale test counts", () => {
  assert.match(source, /empirical closure does not accept skipped tests/);
  assert.match(source, /postgres-forced-interleavings[\s\S]*exactTests:\s*13/);
  assert.match(source, /postgres-telemetry-scale[\s\S]*exactTests:\s*3/);
  assert.match(source, /postgres-refreshsession-hot-cold-scale[\s\S]*exactTests:\s*1/);
  assert.match(source, /postgres-refreshsession-retention[\s\S]*exactTests:\s*2/);
});

test("INT60.6 closure integrity: all mode self-migrates disposable audit DB before correctness and scale", () => {
  const pgStart = source.indexOf("function pgGate()");
  const pgEnd = source.indexOf("function scaleGate()", pgStart);
  const block = source.slice(pgStart, pgEnd);
  assert.match(block, /mode === "all"/);
  assert.match(block, /prisma-migrate-deploy/);
  assert.match(block, /refreshsession-online-index-ensure/);
  assert.ok(block.indexOf("prisma-migrate-deploy") < block.indexOf("postgres-forced-interleavings"));
});

test("INT60.10 closure integrity: standalone verifier applies zero-skip semantics to retention evidence too", () => {
  const evidenceSource = fs.readFileSync(path.join(root, "scripts/audit/actual60-runtime-evidence.js"), "utf8");
  assert.match(evidenceSource, /postgres-refreshsession-retention/);
  assert.match(evidenceSource, /\["source-freeze-candidate", "postgres-forced-interleavings", "postgres-telemetry-scale", "postgres-refreshsession-hot-cold-scale", "postgres-refreshsession-retention"\]\.includes\(label\)/);
});

test("INT60.6 closure integrity: verifier rejects skipped empirical evidence and missing required gates", () => {
  const bad = {
    format: "ONLINOD_ACTUAL60_AUTH_RUNTIME_EVIDENCE_V2",
    status: "PASSED",
    mode: "all",
    gates: [{ label: "postgres-forced-interleavings", exitCode: 0, tap: { tests: 13, pass: 0, fail: 0, skipped: 13 } }],
    targets: {}, postgres: {}, failure: null, sourceSha256: {},
  };
  const result = evidence.validateClosureReceipt(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => /skipped=13/.test(entry)));
  assert.ok(result.errors.some((entry) => /missing required gate/.test(entry)));
});


test("INT60.6 closure integrity: postgres:// and postgresql:// cannot bypass same-database safety", () => {
  const result = runGate("pg", {
    DATABASE_URL: "postgres://prod:one@db.example.test:5432/onlinod?schema=public",
    ONLINOD_AUDIT_DATABASE_URL: "postgresql://audit:two@DB.EXAMPLE.TEST:5432/onlinod?schema=audit60",
  });
  assert.equal(result.status, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /same physical database/);
});

test("INT60.6 closure integrity: top-level source receipt path is not inherited by nested source tests", () => {
  const start = source.indexOf("function sourceGate()");
  const end = source.indexOf("function migrationGate()", start);
  const block = source.slice(start, end);
  assert.match(block, /ONLINOD_AUDIT_EVIDENCE_PATH:\s*""/);
});

test("INT60.6 closure integrity: failed final receipt validation is rewritten as FAILED instead of leaving RUNNING", () => {
  assert.match(source, /ACTUAL59_GATE_RECEIPT_FAIL/);
  assert.match(source, /receiptObject\("FAILED", terminalError\)/);
  assert.match(source, /ACTUAL59_GATE_EVIDENCE status=FAILED/);
});

test("INT60.6 closure integrity: standalone verifier is pinned by the source manifest", () => {
  const manifest = evidence.sourceManifest();
  assert.match(manifest["scripts/audit/actual60-runtime-evidence-verify.js"] || "", /^[a-f0-9]{64}$/);
});

test("INT60.6 closure integrity: source gate is hermetic and cannot inherit database/load flags", () => {
  const start = source.indexOf("function sourceGate()");
  const end = source.indexOf("function migrationGate()", start);
  const block = source.slice(start, end);
  for (const name of [
    "DATABASE_URL",
    "ONLINOD_AUDIT_DATABASE_URL",
    "ONLINOD_POSTGRES_INTEGRATION",
    "ONLINOD_ACTUAL59_SCALE_INTEGRATION",
    "ONLINOD_ACTUAL60_REFRESHSESSION_SCALE_INTEGRATION",
    "ONLINOD_ACTUAL60_MIGRATION_REHEARSAL",
  ]) assert.match(block, new RegExp(`${name}:\\s*\"\"`));
});

test("INT60.6 closure integrity: migration evidence uses only the installed local Prisma CLI and never npx fallback", () => {
  const rehearsal = fs.readFileSync(path.join(root, "scripts/audit/actual60-migration-rehearsal.js"), "utf8");
  assert.match(source, /requireLocalPrismaCli\(\)/);
  assert.match(rehearsal, /requireLocalPrismaCli\(\)/);
  assert.doesNotMatch(source, /\bnpx(?:\.cmd)?\b/);
  assert.doesNotMatch(rehearsal, /\bnpx(?:\.cmd)?\b/);
  assert.match(source, /run npm install before PostgreSQL closure evidence/);
  assert.match(rehearsal, /run npm install before migration rehearsal/);
});

test("INT60.6 closure integrity: receipt pins source-gate tests as well as production and PG harnesses", () => {
  const manifest = evidence.sourceManifest();
  for (const required of [
    "src/services/actual59-int59-4f-freeze-candidate.test.js",
    "src/services/actual60-int60-5-runtime-database-safety.test.js",
    "src/services/actual60-int60-6-runtime-closure-integrity.test.js",
    "src/services/actual59-team-authorization-generation-postgres.integration.test.js",
    "src/services/actual60-refreshsession-scale-postgres.integration.test.js",
  ]) assert.match(manifest[required] || "", /^[a-f0-9]{64}$/);
});

test("INT60.6 closure integrity: current-source verification rejects a tampered pinned hash even with otherwise complete green gates", () => {
  const sourceSha256 = evidence.sourceManifest();
  const required = evidence.REQUIRED_CLOSURE_GATES.map((label) => {
    const counts = label === "postgres-forced-interleavings" ? 10
      : label === "postgres-telemetry-scale" ? 3
        : label === "postgres-refreshsession-hot-cold-scale" ? 1
          : label === "source-freeze-candidate" ? 141
            : null;
    return { label, exitCode: 0, durationMs: 1, tap: counts == null ? null : { tests: counts, pass: counts, fail: 0, skipped: 0 } };
  });
  const target = { host: "audit.example.test", port: "5432", database: "onlinod_audit", schema: "public", source: "ONLINOD_AUDIT_DATABASE_URL" };
  const pg = { database: "onlinod_audit", schema: "public", serverVersion: "17.0", serverVersionNum: "170000", defaultTransactionIsolation: "read committed" };
  const file = Object.keys(sourceSha256)[0];
  sourceSha256[file] = "0".repeat(64);
  const receipt = {
    format: "ONLINOD_ACTUAL60_AUTH_RUNTIME_EVIDENCE_V2",
    status: "PASSED",
    mode: "all",
    completeClosureRun: true,
    closureEvidenceValid: true,
    gates: required,
    targets: { migration: target, pg: target, scale: target },
    postgres: { migration: pg, pg, scale: pg },
    failure: null,
    sourceSha256,
  };
  const result = evidence.validateClosureReceipt(receipt, { currentSource: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes(`source hash mismatch ${file}`)));
});
