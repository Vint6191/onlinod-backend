"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const authService = read("src/services/auth-service.js");
const authAuthority = read("src/services/authorization-session-authority-service.js");
const authMiddleware = read("src/middleware/auth.js");
const authRoute = read("src/routes/auth.js");
const telemetry = read("src/services/telemetry-ingest-service.js");
const telemetryRoute = read("src/routes/telemetry.js");
const lineageMigration = read("prisma/migrations/20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary/migration.sql");
const memberMigration = read("prisma/migrations/20260915131500_actual59_team_authorization_generation_boundary/migration.sql");
const refreshScaleMigration = read("prisma/migrations/20260916011500_actual60_refreshsession_hot_cold_scale/migration.sql");

function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${start} .. ${end} block missing`);
  return text.slice(a, b);
}

function assertOrdered(text, labels) {
  let cursor = -1;
  for (const label of labels) {
    const next = text.indexOf(label, cursor + 1);
    assert.ok(next > cursor, `${label} must appear after the previous authority boundary`);
    cursor = next;
  }
}

test("INT59.4F freeze candidate: login and refresh publish the same durable lineage contract", () => {
  const loginSchema = between(authRoute, "const loginSchema", "const verifyCodeSchema");
  const refreshSchema = between(authRoute, "const refreshSchema", "const resetPasswordSchema");
  const loginRoute = between(authRoute, 'router.post("/login"', 'router.post("/refresh"');
  const refreshRoute = between(authRoute, 'router.post("/refresh"', 'router.post("/logout"');
  assert.match(loginSchema, /authorizationScopeIncarnation/);
  assert.match(refreshSchema, /authorizationScopeIncarnation/);
  assert.match(loginRoute, /authorizationScopeIncarnation:\s*input\.authorizationScopeIncarnation\s*\|\|\s*null/);
  assert.match(refreshRoute, /authorizationScopeIncarnation:\s*input\.authorizationScopeIncarnation\s*\|\|\s*null/);
  assert.match(loginRoute, /authorizationSessionId:\s*tokens\.authorizationSessionId\s*\|\|\s*null/);
  assert.match(refreshRoute, /authorizationSessionId:\s*result\.authorizationSessionId\s*\|\|\s*null/);
});

test("INT59.4F freeze candidate: auth publication lock order is monotonic and refresh re-proves its exact source token", () => {
  const login = between(authService, "async function issueLoginTokens", "async function verifyEmailByToken");
  const refresh = between(authService, "async function refreshAccessToken", "async function revokeRefreshToken");
  assertOrdered(login, [
    "acquireAuthorizationUserLock",
    "acquireAuthorizationDeviceLock",
    "lockCurrentLoginAuthority",
    "acquireAuthorizationLineageLock",
    "createRefreshSession",
  ]);
  assertOrdered(refresh, [
    "acquireAuthorizationUserLock",
    "acquireAuthorizationDeviceLock",
    "lockCurrentLoginAuthority",
    "lockCurrentRefreshSession",
  ]);
  assert.match(refresh, /lockCurrentRefreshSession[\s\S]*?tx\.refreshSession\.create/);
  assert.match(authAuthority, /lockCurrentRefreshSession[\s\S]*?clock_timestamp\(\)[\s\S]*?FOR UPDATE/);
});

test("INT59.4F freeze candidate: access JWT lineage is admitted only through an active exact RefreshSession generation", () => {
  assert.match(authMiddleware, /authorizationSessionId\s*=\s*decoded\.authorizationSessionId/);
  assert.match(authMiddleware, /refreshSessions:[\s\S]*?agencyId:\s*decoded\.agencyId[\s\S]*?deviceId:\s*boundDeviceId[\s\S]*?revokedAt:\s*null[\s\S]*?expiresAt:\s*\{\s*gt:\s*authorizationNow\s*\}/);
  assert.match(authMiddleware, /authorizationSessionId\s*\?\s*\{\s*authorizationSessionId\s*\}\s*:\s*\{\s*authorizationSessionId:\s*null\s*\}/);
  assert.match(authMiddleware, /if \(boundDeviceId\)[\s\S]*?SESSION_REVOKED/);
});

test("INT59.4F freeze candidate: CURRENT_HUMAN commit authority is conjunctive across session, member epoch and creator catalog", () => {
  const ingest = between(telemetry, "async function ingestTeamEvents", "module.exports");
  assertOrdered(ingest, [
    "loadLiveTelemetryMember",
    "lockLiveAuthorizationSession",
    "lockCreatorCatalogGeneration",
    "ingestCanonicalTeamEventInTx",
  ]);
  assert.match(telemetry, /authorizationScopeIncarnation[\s\S]*?accessEpoch[\s\S]*?creatorCatalogGeneration/);
  assert.match(telemetry, /human_authorization_generation_stale/);
  assert.match(telemetry, /TELEMETRY_ACCESS_EPOCH_STALE/);
  assert.match(telemetry, /TELEMETRY_AUTHORIZATION_SESSION_STALE/);
  assert.match(telemetry, /TELEMETRY_CREATOR_CATALOG_STALE/);
});

test("INT59.4F/Actual60 freeze candidate: terminal performance uses server-owned boundaries and indexed lineage expiry history", () => {
  assert.match(telemetry, /AuthorizationSessionBoundary/);
  assert.doesNotMatch(telemetry, /MAX\(r\."expiresAt"\)/);
  assert.match(telemetry, /ORDER BY r\."expiresAt" DESC[\s\S]*LIMIT 1/);
  assert.match(refreshScaleMigration, /RefreshSession_authorization_history_idx/);
  assert.match(refreshScaleMigration, /RefreshSession_live_authorization_lookup_idx/);
  assert.match(telemetry, /AgencyMemberAccessEpochBoundary/);
  assert.match(telemetry, /AgencyCreatorCatalogGenerationBoundary/);
  assert.match(telemetry, /authorization_terminal_closure_unproven/);
  assert.match(telemetry, /Math\.min\(\.\.\.endCandidates\.map/);
});

test("INT59.4F freeze candidate: migration history is one-way, DB-clock based and legacy-safe", () => {
  assert.match(lineageMigration, /^BEGIN;/m);
  assert.match(lineageMigration, /COMMIT;\s*$/m);
  assert.match(lineageMigration, /clock_timestamp\(\)/);
  assert.doesNotMatch(lineageMigration.replace(/--.*$/gm, ""), /statement_timestamp\(\)/);
  assert.match(lineageMigration, /ON CONFLICT \("authorizationSessionId"\) DO NOTHING/);
  assert.match(lineageMigration, /ON CONFLICT \("agencyId", "generation"\) DO NOTHING/);
  assert.match(lineageMigration, /CREATE OR REPLACE FUNCTION "capture_agency_member_access_epoch_boundary"/);
  assert.match(memberMigration, /CREATE TRIGGER "AgencyMember_capture_access_epoch_boundary"/);
  assert.doesNotMatch(lineageMigration, /UPDATE\s+"RefreshSession"[\s\S]{0,400}?"authorizationSessionId"\s*=/i,
    "migration must not silently adopt historical legacy sessions into the current generation");
});

test("INT59.4F freeze candidate: telemetry activation and scale remain bounded/fail-closed", () => {
  const match = telemetry.match(/const TEAM_TELEMETRY_TX_CHUNK_SIZE = (\d+);/);
  assert.ok(match, "bounded telemetry chunk size must remain explicit");
  const chunkSize = Number(match[1]);
  assert.ok(chunkSize > 0 && chunkSize <= 16, `unexpected telemetry transaction chunk size ${chunkSize}`);
  assert.match(telemetryRoute, /router\.post\("\/events\/ingest"[\s\S]*?TELEMETRY_CLIENT_UPGRADE_REQUIRED/);
  assert.match(telemetryRoute, /router\.post\("\/events\/ingest\/current-authorized"[\s\S]*?AUTHORIZATION_SESSION_REQUIRED/);
});

test("INT59.4F freeze candidate: auth authority never creates a second direct pg_advisory query implementation", () => {
  assert.doesNotMatch(authAuthority, /pg_advisory_xact_lock/);
  assert.doesNotMatch(authService, /pg_advisory_xact_lock/);
  assert.match(authAuthority, /lockDbAdvisoryXact/);
});
