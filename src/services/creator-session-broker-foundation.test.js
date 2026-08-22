"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("V20.11 schema expands creator sessions without switching existing runtime mode", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /enum CreatorSessionMode\s*\{\s*LOCAL_PERSISTENT\s*MANAGED_BROKER\s*\}/s);
  assert.match(schema, /sessionMode\s+CreatorSessionMode\s+@default\(LOCAL_PERSISTENT\)/);
  assert.match(schema, /model CreatorSessionState\s*\{/);
  assert.match(schema, /creatorId\s+String\s+@unique/);
  assert.match(schema, /revision\s+Int\s+@default\(1\)/);
  assert.match(schema, /encryptedPayload\s+String\?/);
});

test("V20.11 migration is additive and never rewrites existing creator partitions", () => {
  const migration = read("prisma/migrations/20260822213000_creator_session_broker_foundation/migration.sql");
  assert.match(migration, /DEFAULT 'LOCAL_PERSISTENT'/);
  assert.match(migration, /CREATE TABLE "CreatorSessionState"/);
  assert.doesNotMatch(migration, /UPDATE\s+"CreatorAccount"/i);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN|TYPE)/i);
});

test("V20.11 server exposes broker separately from legacy AccessSnapshot routes", () => {
  const server = read("src/server.js");
  const route = read("src/routes/creator-sessions.js");
  assert.match(server, /app\.use\("\/api\/creator-sessions", creatorSessionRoutes\)/);
  assert.match(route, /requireCreatorAccess/);
  assert.match(route, /requireRegisteredDevice/);
  assert.match(route, /baseRevision/);
  assert.match(route, /requestId/);
  assert.doesNotMatch(route, /accessSnapshot/);
});

test("creator removal revokes and zeroes the new canonical credential envelope", () => {
  const creators = read("src/routes/creators.js");
  const admin = read("src/routes/admin.js");
  for (const source of [creators, admin]) {
    assert.match(source, /creatorSessionState\.updateMany/);
    assert.match(source, /status: "REVOKED"/);
    assert.match(source, /encryptedPayload: null/);
    assert.match(source, /credentialHash: null/);
    assert.match(source, /coherenceHash: null/);
  }
});
