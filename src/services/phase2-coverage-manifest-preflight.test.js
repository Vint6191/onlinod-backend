"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const manifestSource = fs.readFileSync(path.join(__dirname, "phase2-coverage-manifest.js"), "utf8");
const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
const preflight = fs.readFileSync(path.join(ROOT, "scripts", "audit", "phase2-coverage-preflight-readonly.js"), "utf8");
const executablePreflight = preflight.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("Actual53 coverage seed is versioned by one immutable manifest authority", () => {
  assert.match(manifestSource, /COVERAGE_MANIFEST_VERSION\s*=\s*"phase2_coverage_manifest_actual53_v1"/);
  assert.match(manifestSource, /COVERAGE_SEED_GENERATION\s*=\s*`\$\{COVERAGE_MANIFEST_VERSION\}:seed_v1`/);
  assert.match(manifestSource, /FAMILY\.CUSTOM_SOURCE_PIPELINE/);
  assert.match(manifestSource, /FAMILY\.TEAM_DIALOG_PROJECTION/);
  assert.match(manifestSource, /FAMILY\.TEAM_MONEY_ROOT_CLASSIFICATION/);
  assert.match(manifestSource, /FAMILY\.TELEGRAM_INBOUND_PROJECTION/);
  assert.match(scheduler, /PHASE2_COVERAGE_MANIFEST/);
  assert.match(scheduler, /coverageManifestFingerprint\(\)/);
  assert.doesNotMatch(scheduler, /for \(const \[family, generation\] of \[\s*\[PHASE2_COVERAGE_FAMILY/);
});

test("M53-01 preflight is explicit read-only and compares legacy seed with current manifest", () => {
  assert.equal(pkg.scripts?.["audit:phase2-coverage-preflight"], "node scripts/audit/phase2-coverage-preflight-readonly.js");
  assert.match(preflight, /ONLINOD_PHASE2_COVERAGE_PREFLIGHT=1_REQUIRED/);
  assert.match(preflight, /phase2_coverage_seed_v2/);
  assert.match(preflight, /LEGACY_SEED_COMPLETE_REQUIRES_CURRENT_MANIFEST_RESEED/);
  assert.match(preflight, /CURRENT_SEED_MANIFEST_IDENTITY_MISMATCH/);
  assert.match(preflight, /currentManifestIdentityMatches/);
  assert.match(preflight, /manifestVersion/);
  assert.match(preflight, /manifestFingerprint/);
  assert.match(preflight, /CURRENT_MANIFEST_ROWS_MISSING/);
  assert.match(preflight, /CURRENT_MANIFEST_COVERAGE_NOT_CONVERGED/);
  assert.doesNotMatch(executablePreflight, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
  assert.doesNotMatch(executablePreflight, /\$executeRaw/);
  assert.doesNotMatch(executablePreflight, /`\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

test("M53-01 preflight checks every active Agency against every final family/generation pair", () => {
  assert.match(preflight, /deletedAt:\s*null/);
  assert.match(preflight, /COVERAGE_MANIFEST\.map/);
  assert.match(preflight, /expectedManifestRows:\s*scannedAgencies \* COVERAGE_MANIFEST\.length/);
  assert.match(preflight, /missingCount/);
  assert.match(preflight, /incompleteCount/);
  assert.match(preflight, /manifestSeeded/);
  assert.match(preflight, /convergenceComplete/);
});
