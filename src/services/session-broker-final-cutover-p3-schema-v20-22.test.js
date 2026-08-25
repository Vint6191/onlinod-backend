"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const repo = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

test("V20.22 P3 schema has one canonical session architecture and no backend Chromium partition switch", () => {
  const schema = read("prisma/schema.prisma");
  assert.doesNotMatch(schema, /model\s+AccessSnapshot\b|model\s+CreatorConnectSession\b/);
  assert.doesNotMatch(schema, /enum\s+(AccessSnapshotType|ConnectSessionStatus|CreatorSessionMode)\b/);
  const creator = schema.match(/model CreatorAccount \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(creator, /\bpartition\b|\bsessionMode\b|accessSnapshots|connectSessions/);
  assert.match(creator, /sessionState\s+CreatorSessionState\?/);
  const root = schema.match(/model AgencyCryptoRoot \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(root, /enforceOpaqueSecrets|enforcedAt/);
});

test("V20.22 P3 migration destroys legacy tables and removes migration columns/types", () => {
  const migration = read("prisma/migrations/20260824223000_remove_legacy_session_subsystem_v20_22/migration.sql");
  for (const token of ["DROP TABLE IF EXISTS \"AccessSnapshot\"", "DROP TABLE IF EXISTS \"CreatorConnectSession\"", "DROP COLUMN IF EXISTS \"partition\"", "DROP COLUMN IF EXISTS \"sessionMode\"", "DROP TYPE IF EXISTS \"CreatorSessionMode\""]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
});

test("V20.22 P3 production sources no longer query legacy AccessSnapshot/CreatorConnectSession models", () => {
  for (const rel of ["src/routes/creators.js", "src/routes/workspace.js", "src/routes/admin.js", "src/services/creator-agency-removal.js", "src/services/job-lease-service.js", "src/services/client-e2e-keyring-service.js"]) {
    const source = read(rel);
    assert.doesNotMatch(source, /accessSnapshot|accessSnapshots|creatorConnectSession|CreatorConnectSession/);
  }
  assert.equal(fs.existsSync(path.join(repo, "src/services/legacy-access-snapshot-policy.js")), false);
});

test("V20.22 P3 keyring exposes security debt, not migration/enforcement mode", () => {
  const route = read("src/routes/client-e2e-keyring.js");
  const service = read("src/services/client-e2e-keyring-service.js");
  assert.match(route, /\/security-debt/);
  assert.doesNotMatch(route, /migration-status|enforce-opaque/);
  assert.match(service, /getCryptoSecurityDebt/);
  assert.doesNotMatch(service, /enforceOpaqueSecrets|AccessSnapshot/);
});
