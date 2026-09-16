"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("Actual60 F60-SCALE-1: migration separates live authorization lookup from lineage history", () => {
  const migration = read("prisma/migrations/20260916011500_actual60_refreshsession_hot_cold_scale/migration.sql");
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "RefreshSession_live_authorization_lookup_idx"/);
  assert.match(migration, /"userId"[\s\S]*"agencyId"[\s\S]*"deviceId"[\s\S]*"authorizationSessionId"[\s\S]*"expiresAt" DESC/);
  assert.match(migration, /WHERE "revokedAt" IS NULL/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "RefreshSession_live_lineage_lookup_idx"/);
  assert.match(migration, /"authorizationSessionId"[\s\S]*"userId"[\s\S]*"agencyId"[\s\S]*"deviceId"[\s\S]*"expiresAt" DESC/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "RefreshSession_authorization_history_idx"/);
  assert.match(migration, /"authorizationSessionId"[\s\S]*"agencyId"[\s\S]*"userId"[\s\S]*"expiresAt" DESC/);
  assert.match(migration, /WHERE "authorizationSessionId" IS NOT NULL/);
  const liveUserMigration = read("prisma/migrations/20260916013000_actual60_refreshsession_live_user_scale/migration.sql");
  assert.match(liveUserMigration, /RefreshSession_live_user_lookup_idx/);
  assert.match(liveUserMigration, /"userId"[\s\S]*"expiresAt" DESC[\s\S]*"lastUsedAt" DESC[\s\S]*"createdAt" DESC/);
  assert.match(liveUserMigration, /WHERE "revokedAt" IS NULL/);
});

test("Actual60 F60-SCALE-1: authRequired live lineage proof has exact current-state predicates", () => {
  const source = read("src/middleware/auth.js");
  const start = source.indexOf("refreshSessions:");
  assert.ok(start >= 0, "authRequired must query RefreshSession liveness for a bound access token");
  const block = source.slice(start, start + 900);
  assert.match(block, /agencyId:\s*decoded\.agencyId/);
  assert.match(block, /deviceId:\s*boundDeviceId/);
  assert.match(block, /revokedAt:\s*null/);
  assert.match(block, /expiresAt:\s*\{\s*gt:\s*authorizationNow\s*\}/);
  assert.match(block, /authorizationSessionId/);
  assert.match(block, /take:\s*1/);
});

test("Actual60 F60-SCALE-1: Team human commit fence uses only current live lineage rows", () => {
  const source = read("src/services/telemetry-ingest-service.js");
  const start = source.indexOf("async function lockLiveAuthorizationSession");
  const end = source.indexOf("async function lockCreatorCatalogGeneration", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /"userId"=\$1/);
  assert.match(block, /"agencyId"=\$2/);
  assert.match(block, /"deviceId"=\$3/);
  assert.match(block, /"authorizationSessionId"=\$4/);
  assert.match(block, /"revokedAt" IS NULL/);
  assert.match(block, /"expiresAt" > clock_timestamp\(\)/);
  assert.match(block, /LIMIT 1[\s\S]*FOR SHARE/);
  assert.doesNotMatch(block, /ORDER BY "createdAt"/);
});

test("Actual60 F60-SCALE-1: natural lineage end is top-1 indexed history lookup, not MAX scan", () => {
  const source = read("src/services/telemetry-ingest-service.js");
  const start = source.indexOf("async function authorizationSessionEndedAt");
  const end = source.indexOf("async function creatorCatalogGenerationEndedAt", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /MAX\s*\(\s*r\."expiresAt"\s*\)/i);
  assert.match(block, /ORDER BY r\."expiresAt" DESC[\s\S]*LIMIT 1/);
  assert.match(block, /"authorizationSessionId"=\$1/);
  assert.match(block, /"agencyId"=\$2/);
  assert.match(block, /"userId"=\$3/);
});


test("Actual60 F60-SCALE-1: boundary trigger's live-lineage existence check is covered by current-state predicates", () => {
  const migration = read("prisma/migrations/20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary/migration.sql");
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION "capture_authorization_session_boundary"');
  const end = migration.indexOf('DROP TRIGGER IF EXISTS "RefreshSession_capture_authorization_boundary"', start);
  assert.ok(start >= 0 && end > start);
  const block = migration.slice(start, end);
  assert.match(block, /r\."authorizationSessionId" = NEW\."authorizationSessionId"/);
  assert.match(block, /r\."revokedAt" IS NULL/);
  assert.match(block, /r\."expiresAt" > clock_timestamp\(\)/);
  const scaleMigration = read("prisma/migrations/20260916011500_actual60_refreshsession_hot_cold_scale/migration.sql");
  assert.match(scaleMigration, /RefreshSession_live_lineage_lookup_idx/);
  assert.match(scaleMigration, /WHERE "revokedAt" IS NULL[\s\S]*"authorizationSessionId" IS NOT NULL/);
});

test("Actual60 F60-SCALE-1: real-PG EXPLAIN gate rejects seq scans and unbounded filtered-row work", () => {
  const source = read("src/services/actual60-refreshsession-scale-postgres.integration.test.js");
  assert.match(source, /function assertBoundedLookupPlan/);
  assert.match(source, /Seq Scan/);
  assert.match(source, /Rows Removed by Filter/);
  assert.match(source, /Actual Rows/);
  assert.match(source, /Shared Hit Blocks/);
  assert.match(source, /maxBufferBlocks/);
  assert.match(source, /live authorization/);
  assert.match(source, /legacy current-device/);
  assert.match(source, /terminal lineage history/);
});


test("Actual60 F60-SCALE-1: Settings current-session listing is current-state filtered and has a user-live index", () => {
  const source = read("src/services/settings-service.js");
  const start = source.indexOf("async function getAccountSettings");
  const end = source.indexOf("async function updateAccountProfile", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /refreshSession\.findMany/);
  assert.match(block, /where:\s*\{\s*userId,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);
  assert.match(block, /orderBy:\s*\[\{\s*lastUsedAt:\s*"desc"\s*\},\s*\{\s*createdAt:\s*"desc"\s*\}\]/);
  const migration = read("prisma/migrations/20260916013000_actual60_refreshsession_live_user_scale/migration.sql");
  assert.match(migration, /RefreshSession_live_user_lookup_idx/);
});

test("Actual60 F60-SCALE-1: real-PG scale gate includes expired-unrevoked history and user-level live listing", () => {
  const source = read("src/services/actual60-refreshsession-scale-postgres.integration.test.js");
  assert.match(source, /expiredUnrevokedRows/);
  assert.match(source, /revokedAt:\s*null/);
  assert.match(source, /RefreshSession_live_user_lookup_idx/);
  assert.match(source, /current user session listing/);
  assert.match(source, /RefreshSession_live_agency_lookup_idx/);
  assert.match(source, /agency current lifecycle/);
  assert.match(source, /RefreshSession_user_history_created_idx/);
  assert.match(source, /user session history/);
});


test("Actual60 F60-SCALE-1: current-session mutation paths ignore expired-unrevoked history", () => {
  const auth = read("src/services/auth-service.js");
  const settings = read("src/services/settings-service.js");

  const loginStart = auth.indexOf("async function issueLoginTokens");
  const loginEnd = auth.indexOf("async function verifyEmailByToken", loginStart);
  const login = auth.slice(loginStart, loginEnd);
  assert.match(login, /deviceId:\s*boundDeviceId[\s\S]*revokedAt:\s*null[\s\S]*expiresAt:\s*\{\s*gt:\s*publicationNow\s*\}/);

  const reuseStart = auth.indexOf("async function revokeRefreshReuseScope");
  const reuseEnd = auth.indexOf("async function refreshAccessToken", reuseStart);
  const reuse = auth.slice(reuseStart, reuseEnd);
  assert.match(reuse, /revokedAt:\s*null[\s\S]*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const refreshStart = auth.indexOf("async function refreshAccessToken");
  const refreshEnd = auth.indexOf("async function revokeRefreshToken", refreshStart);
  const refresh = auth.slice(refreshStart, refreshEnd);
  assert.match(refresh, /expiresAt:\s*\{\s*gt:\s*rotationNow\s*\}[\s\S]*authorizationSessionId:\s*null/);

  const passwordStart = settings.indexOf("async function changeAccountPassword");
  const passwordEnd = settings.indexOf("async function requestAccountPasswordReset", passwordStart);
  assert.match(settings.slice(passwordStart, passwordEnd), /revokedAt:\s*null[\s\S]*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const deviceStart = settings.indexOf("async function logoutAccountDevice");
  const deviceEnd = settings.indexOf("async function logoutOtherAccountDevices", deviceStart);
  assert.match(settings.slice(deviceStart, deviceEnd), /deviceId:\s*target[\s\S]*revokedAt:\s*null[\s\S]*expiresAt:\s*\{\s*gt:\s*now\s*\}/);

  const otherStart = settings.indexOf("async function logoutOtherAccountDevices");
  const otherEnd = settings.indexOf("async function revokeAccountSession", otherStart);
  const other = settings.slice(otherStart, otherEnd);
  assert.match(other, /refreshSession\.findMany[\s\S]*expiresAt:\s*\{\s*gt:\s*now\s*\}/);
  assert.match(other, /refreshSession\.updateMany[\s\S]*expiresAt:\s*\{\s*gt:\s*now\s*\}/);
});


test("Actual60 INT60.4: agency-wide live lifecycle work and user history have dedicated bounded indexes", () => {
  const migration = read("prisma/migrations/20260916014500_actual60_refreshsession_current_write_history_scale/migration.sql");
  assert.match(migration, /RefreshSession_live_agency_lookup_idx/);
  assert.match(migration, /"agencyId"[\s\S]*"expiresAt" DESC[\s\S]*"userId"[\s\S]*"deviceId"/);
  assert.match(migration, /WHERE "revokedAt" IS NULL/);
  assert.match(migration, /RefreshSession_user_history_created_idx/);
  assert.match(migration, /"userId", "createdAt" DESC/);
});
