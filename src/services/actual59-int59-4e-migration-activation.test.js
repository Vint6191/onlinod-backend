"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const lineageMigration = fs.readFileSync(path.join(root, "prisma/migrations/20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary/migration.sql"), "utf8");
const memberMigration = fs.readFileSync(path.join(root, "prisma/migrations/20260915131500_actual59_team_authorization_generation_boundary/migration.sql"), "utf8");
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

test("INT59.4E migration activation preserves legacy NULL lineages instead of silently backfilling them current", () => {
  assert.match(lineageMigration, /ADD COLUMN IF NOT EXISTS "authorizationSessionId" TEXT/);
  assert.doesNotMatch(lineageMigration, /UPDATE\s+"RefreshSession"[\s\S]{0,300}?"authorizationSessionId"\s*=/i,
    "migration must not invent authorization lineage for historical refresh rows");
  assert.match(schema, /authorizationSessionId\s+String\?/);
});

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

test("INT59.4E migration owns exactly one installed trigger per authorization boundary family", () => {
  for (const trigger of [
    "RefreshSession_capture_authorization_boundary",
    "AgencyCreatorCatalogState_capture_generation_boundary",
  ]) {
    assert.match(lineageMigration, new RegExp(`DROP TRIGGER IF EXISTS "${trigger}"`));
    assert.match(lineageMigration, new RegExp(`CREATE TRIGGER "${trigger}"`));
  }
  assert.match(memberMigration, /CREATE TRIGGER "AgencyMember_capture_access_epoch_boundary"/);
  assert.match(lineageMigration, /CREATE OR REPLACE FUNCTION "capture_agency_member_access_epoch_boundary"/,
    "later migration must replace the INT59.2 member boundary body rather than install a competing trigger");
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
