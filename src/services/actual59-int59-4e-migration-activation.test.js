"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const lineageMigration = fs.readFileSync(path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"), "utf8");
const memberMigration = fs.readFileSync(path.join(root, "prisma/migrations/20261009000000_current_baseline/migration.sql"), "utf8");
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const authRoute = fs.readFileSync(path.join(root, "src/routes/auth.js"), "utf8");
const authService = fs.readFileSync(path.join(root, "src/services/auth-service.js"), "utf8");
const telemetryRoute = fs.readFileSync(path.join(root, "src/routes/telemetry.js"), "utf8");

function bodyBetween(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${start} .. ${end} block missing`);
  return text.slice(a, b);
}



test("INT59.4E DB boundary functions use physical DB clock and conflict-safe one-way history", () => {
  assert.match(lineageMigration, /capture_authorization_session_boundary[\s\S]*?clock_timestamp\(\)/);
  assert.match(lineageMigration, /capture_creator_catalog_generation_boundary[\s\S]*?clock_timestamp\(\)/);
  assert.match(lineageMigration, /capture_agency_member_access_epoch_boundary[\s\S]*?clock_timestamp\(\)/);
  assert.match(lineageMigration, /ON CONFLICT \("authorizationSessionId"\) DO NOTHING/);
  assert.match(lineageMigration, /ON CONFLICT \("agencyId", "generation"\) DO NOTHING/);
  assert.match(lineageMigration, /ON CONFLICT \("memberId", "accessEpoch"\) DO NOTHING/);
  const executableSql = lineageMigration.replace(/--.*$/gm, "");
  assert.doesNotMatch(executableSql, /statement_timestamp\(\)/);
});



test("INT59.4E rolling activation is symmetric for fresh login and refresh", () => {
  const loginSchema = bodyBetween(authRoute, "const loginSchema", "const verifyCodeSchema");
  const refreshSchema = bodyBetween(authRoute, "const refreshSchema", "const resetPasswordSchema");
  assert.match(loginSchema, /authorizationScopeIncarnation/);
  assert.match(refreshSchema, /authorizationScopeIncarnation/);

  const loginRoute = bodyBetween(authRoute, 'router.post("/login"', 'router.post("/refresh"');
  assert.match(loginRoute, /authorizationScopeIncarnation:\s*input\.authorizationScopeIncarnation\s*\|\|\s*null/);
  const issueLogin = bodyBetween(authService, "async function issueLoginTokens", "async function verifyEmailByToken");
  assert.match(issueLogin, /requestedAuthorizationSessionId/);
  assert.match(issueLogin, /const authorizationSessionId = requestedAuthorizationSessionId/);
  assert.doesNotMatch(issueLogin, /randomUUID\(/,
    "legacy fresh login must remain NULL-lineage instead of inventing a hidden server generation");
});

test("INT59.4E legacy telemetry activation remains retry-gated while generation-aware endpoint is strict", () => {
  assert.match(telemetryRoute, /router\.post\("\/events\/ingest"[\s\S]*?TELEMETRY_CLIENT_UPGRADE_REQUIRED/);
  assert.match(telemetryRoute, /router\.post\("\/events\/ingest\/current-authorized"[\s\S]*?AUTHORIZATION_SESSION_REQUIRED/);
});
