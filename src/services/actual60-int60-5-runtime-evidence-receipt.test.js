"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const gate = fs.readFileSync(path.join(root, "scripts/audit/actual59-auth-lifecycle-gate.js"), "utf8");
const evidence = require(path.join(root, "scripts/audit/actual60-runtime-evidence.js"));

test("INT60.5 runtime evidence receipt: TAP summaries are machine readable", () => {
  assert.deepEqual(evidence.parseTapSummary("# tests 14\n# pass 14\n# fail 0\n# skipped 0\n"), {
    tests: 14, pass: 14, fail: 0, skipped: 0,
  });
  assert.equal(evidence.parseTapSummary("not TAP"), null);
});

test("INT60.5 runtime evidence receipt: critical source manifest is SHA-256 and contains no credentials", () => {
  const manifest = evidence.sourceManifest();
  assert.ok(Object.keys(manifest).length >= 21);
  for (const [file, hash] of Object.entries(manifest)) {
    assert.match(file, /^[^\\]+$/);
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
  assert.equal(Object.keys(manifest).some((file) => /\.env/i.test(file)), false);
  for (const required of [
    "scripts/audit/actual60-runtime-evidence.js",
    "scripts/audit/actual60-postgres-fingerprint.js",
    "src/services/actual59-team-authorization-generation-postgres.integration.test.js",
    "src/services/actual59-int59-4f-telemetry-scale-postgres.integration.test.js",
    "src/services/actual60-refreshsession-scale-postgres.integration.test.js",
  ]) assert.match(manifest[required] || "", /^[a-f0-9]{64}$/);
});

test("INT60.5 runtime evidence receipt: dependency versions are captured even without a repository lockfile", () => {
  const deps = evidence.dependencyVersions();
  assert.equal(deps.declared["@prisma/client"], "5.22.0");
  assert.equal(deps.declared.prisma, "5.22.0");
  assert.equal(typeof deps.packageLockPresent, "boolean");
  if (deps.installed["@prisma/client"] !== null) assert.equal(deps.installed["@prisma/client"], "5.22.0");
});

test("INT60.5 runtime evidence receipt: write is atomic and owner-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onlinod-a60-evidence-"));
  const file = path.join(dir, "receipt.json");
  const written = evidence.writeReceipt(file, { format: "TEST", ok: true });
  assert.equal(written, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { format: "TEST", ok: true });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("INT60.5 runtime evidence receipt: runner records only sanitized DB target metadata", () => {
  assert.match(gate, /safeTarget = \{/);
  assert.match(gate, /host:/);
  assert.match(gate, /database:/);
  assert.match(gate, /schema:/);
  assert.doesNotMatch(gate, /safeTarget[\s\S]{0,300}password/);
  assert.match(gate, /ONLINOD_AUDIT_EVIDENCE_PATH/);
  assert.match(gate, /completeClosureRun:\s*passed && mode === "all"/);
  assert.match(gate, /sourceSha256:\s*status === "RUNNING" \? null : safeSourceManifest\(\)/);
  assert.match(gate, /dependencies:\s*status === "RUNNING" \? null : safeDependencies\(\)/);
  assert.match(gate, /postgres:\s*Object\.fromEntries\(evidencePostgres\)/);
  assert.match(gate, /actual60-postgres-fingerprint\.js/);
  assert.match(gate, /ACTUAL60_POSTGRES_FINGERPRINT_JSON/);
});
