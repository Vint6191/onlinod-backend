"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("F60-MIG-1 raw history purge is DRAINING until a tombstone-aware publisher generation is explicitly activated", () => {
  const migration = read("prisma/migrations/20260916050000_actual60_int60_10_auth_history_rollout_fence/migration.sql");
  const rollout = read("src/services/actual60-authorization-history-rollout-service.js");
  const retention = read("src/services/retention-service.js");
  const auth = read("src/services/auth-service.js");
  const pkg = JSON.parse(read("package.json"));

  assert.match(migration, /'AUTHORIZATION_HISTORY_PURGE'/);
  assert.match(migration, /'actual60_auth_history_publisher_v1'/);
  assert.match(migration, /'DRAINING'/);
  assert.match(migration, /actual60_require_auth_history_publisher_generation/);
  assert.match(migration, /current_setting\('onlinod\.actual60_auth_history_generation', true\)/);
  assert.match(migration, /activation_state='ACTIVE'/);
  assert.match(migration, /ACTUAL60_INCOMPATIBLE_AUTH_HISTORY_PUBLISHER/);
  assert.match(migration, /BEFORE INSERT ON "RefreshSession"/);
  assert.match(migration, /BEFORE UPDATE OF "authorizationSessionId" ON "RefreshSession"/);

  assert.match(rollout, /AUTH_HISTORY_RELEASE_FENCE_KEY/);
  assert.match(rollout, /mode: "shared"/);
  assert.match(rollout, /mode: "exclusive"/);
  assert.match(rollout, /set_config\(\$1,\$2,true\)/);
  assert.match(rollout, /activationState"='ACTIVE'/);

  assert.match(retention, /authorizationHistoryPurgeActivationStatus/);
  assert.match(retention, /refreshSession\.raw_purge_activation_pending/);
  assert.match(auth, /authorizeAuthorizationHistoryPublisher\(tx\)/);
  assert.equal(pkg.scripts["maintenance:auth-history-purge"], "node scripts/maintenance/actual60-auth-history-purge-activation.js");
});

test("F60-MIG-1 activation CLI makes expand -> all-new publishers -> activate -> purge an explicit operator contract", () => {
  const cli = read("scripts/maintenance/actual60-auth-history-purge-activation.js");
  assert.match(cli, /deploy migration in DRAINING/);
  assert.match(cli, /deploy tombstone-aware publisher binaries to every backend replica/);
  assert.match(cli, /confirm old publisher replicas are drained/);
  assert.match(cli, /ACTIVE DB trigger fences any old publisher/);
  assert.match(cli, /--activate/);
});

test("F60-RUNTIME-1 current RefreshSession liveness and revoke paths use PostgreSQL time authority instead of direct process-time predicates", () => {
  const files = [
    "src/middleware/auth.js",
    "src/services/auth-service.js",
    "src/routes/admin.js",
    "src/routes/auth.js",
    "src/services/settings-service.js",
    "src/services/team-administration-service.js",
    "src/services/client-e2e-keyring-service.js",
  ];
  for (const file of files) {
    const source = read(file);
    if (/refreshSession/i.test(source)) assert.match(source, /dbAuthorityNow/);
  }
  const middleware = read("src/middleware/auth.js");
  assert.match(middleware, /authorizationNow = boundDeviceId \? await dbAuthorityNow/);
  assert.match(middleware, /expiresAt: \{ gt: authorizationNow \}/);

  const auth = read("src/services/auth-service.js");
  assert.match(auth, /rotationNow = await dbAuthorityNow/);
  assert.match(auth, /revokeNow = await dbAuthorityNow/);
  assert.doesNotMatch(auth, /refreshSession[\s\S]{0,450}expiresAt: \{ gt: new Date\(\) \}/);
});

test("retention checks rolling activation before any raw-history delete loop", () => {
  const retention = read("src/services/retention-service.js");
  const fnStart = retention.indexOf("async function runRefreshSessionRetentionSweep");
  const fnEnd = retention.indexOf("function maxDate", fnStart);
  const block = retention.slice(fnStart, fnEnd);
  const activationIndex = block.indexOf("authorizationHistoryPurgeActivationStatus");
  const pendingIndex = block.indexOf("refreshSession.raw_purge_activation_pending");
  const purgeIndex = block.indexOf("purgeRefreshSessionHistoryBatch");
  assert.ok(activationIndex >= 0 && pendingIndex > activationIndex);
  assert.ok(purgeIndex > pendingIndex, "purge loop must be unreachable before activation check");
});
