"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("V20.22 current schema keeps canonical CreatorSessionState and removes the old runtime-mode switch", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model CreatorSessionState\s*\{/);
  assert.match(schema, /creatorId\s+String\s+@unique/);
  assert.match(schema, /revision\s+Int\s+@default\(1\)/);
  assert.match(schema, /encryptedPayload\s+String\?/);
  assert.doesNotMatch(schema, /enum CreatorSessionMode|sessionMode\s+CreatorSessionMode|LOCAL_PERSISTENT/);
});

test("V20.11 migration is additive and never rewrites existing creator partitions", () => {
  const migration = read("prisma/migrations/20260822213000_creator_session_broker_foundation/migration.sql");
  assert.match(migration, /DEFAULT 'LOCAL_PERSISTENT'/);
  assert.match(migration, /CREATE TABLE "CreatorSessionState"/);
  assert.doesNotMatch(migration, /UPDATE\s+"CreatorAccount"/i);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN|TYPE)/i);
});

test("V20.22 server exposes canonical broker with legacy AccessSnapshot routes physically removed", () => {
  const server = read("src/server.js");
  const route = read("src/routes/creator-sessions.js");
  assert.match(server, /app\.use\("\/api\/creator-sessions", creatorSessionRoutes\)/);
  assert.match(route, /requireCreatorAccess/);
  assert.match(route, /requireAuthDevice/);
  assert.match(route, /CREATOR_SESSION_DEVICE_BOUND_TOKEN_REQUIRED/);
  assert.doesNotMatch(route, /requireRegisteredDevice/, "mutable WorkerDevice telemetry must not be session crypto authority");
  assert.match(route, /baseRevision/);
  assert.match(route, /requestId/);
  assert.doesNotMatch(route, /accessSnapshot/);
  assert.doesNotMatch(server, /access-snapshots|creator-connect|creator-import/);
});

test("creator removal revokes and zeroes the new canonical credential envelope through the centralized retirement lifecycle", () => {
  const creators = read("src/routes/creators.js");
  const admin = read("src/routes/admin.js");
  const retirement = read("src/services/creator-agency-removal.js");
  for (const source of [creators, admin]) {
    assert.match(source, /retireCreatorCryptoMaterialOnRemoval\(\{/);
  }
  assert.match(retirement, /creatorSessionState\.updateMany/);
  assert.match(retirement, /status: "REVOKED"/);
  assert.match(retirement, /encryptedPayload: null/);
  assert.match(retirement, /credentialHash: null/);
  assert.match(retirement, /coherenceHash: null/);
});
