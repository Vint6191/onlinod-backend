"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const srcRoot = path.join(root, "src");

function productionJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

const expectedTouchpoints = [
  "src/middleware/auth.js",
  "src/routes/admin.js",
  "src/routes/auth.js",
  "src/routes/impersonate.js",
  "src/services/auth-service.js",
  "src/services/authorization-session-authority-service.js",
  "src/services/client-e2e-keyring-service.js",
  "src/services/phase2-destructive-delete-authority-service.js",
  "src/services/settings-service.js",
  "src/services/team-administration-service.js",
  "src/services/telemetry-ingest-service.js",
].sort();

test("INT60.3 RefreshSession anti-map: every production touchpoint is explicitly classified", () => {
  const actual = productionJsFiles(srcRoot)
    .filter((file) => /refreshsessions?/i.test(fs.readFileSync(file, "utf8")))
    .map(rel)
    .sort();
  assert.deepEqual(actual, expectedTouchpoints,
    "a new RefreshSession reader/writer must be explicitly audited before entering frozen authorization source");
});

test("INT60.3 RefreshSession anti-map: hot/current readers remain distinct from historical/admin surfaces", () => {
  const auth = fs.readFileSync(path.join(root, "src/middleware/auth.js"), "utf8");
  const telemetry = fs.readFileSync(path.join(root, "src/services/telemetry-ingest-service.js"), "utf8");
  const settings = fs.readFileSync(path.join(root, "src/services/settings-service.js"), "utf8");
  const impersonate = fs.readFileSync(path.join(root, "src/routes/impersonate.js"), "utf8");

  assert.match(auth, /refreshSessions:[\s\S]*revokedAt:\s*null[\s\S]*expiresAt:\s*\{\s*gt:/);
  assert.match(telemetry, /lockLiveAuthorizationSession[\s\S]*"revokedAt" IS NULL[\s\S]*"expiresAt" > clock_timestamp\(\)/);
  assert.doesNotMatch(telemetry, /MAX\s*\(\s*r\."expiresAt"\s*\)/i);
  assert.match(telemetry, /ORDER BY r\."expiresAt" DESC[\s\S]*LIMIT 1/);
  assert.match(settings, /getAccountSettings[\s\S]*refreshSession\.findMany[\s\S]*expiresAt:\s*\{\s*gt:\s*now/);

  // Admin impersonation remains a separate, intentionally-unbound product
  // surface carried as a master-roadmap lead. It must not be silently folded
  // into the Desktop device-lineage authority by this closure.
  assert.match(impersonate, /impersonatedByAdminId/);
});
