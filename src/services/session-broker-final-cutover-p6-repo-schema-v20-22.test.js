"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

test("V20.22 production repo has no obsolete root server or patch bundles", () => {
  for (const rel of [
    "server.js",
    "routes/server-store-diagnostics.js",
    "_electron_orchestration_v1_patches",
    "_electron_presence_orchestration_patches",
    "_electron_team_v2_renderer_patches",
    "SERVER_STORES_PATCH_DOCS",
  ]) assert.equal(exists(rel), false, `${rel} must not ship in production repo`);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.main, "src/server.js");
  assert.equal(pkg.scripts.start, "node src/server.js");
});

test("V20.22 active README documents broker-first CLIENT_E2E architecture, not legacy connect", () => {
  const readme = read("README.md");
  assert.match(readme, /revisioned canonical CreatorSessionState/);
  assert.match(readme, /CLIENT_E2E_V1 opaque envelope/);
  assert.doesNotMatch(readme, /POST \/api\/creator-connect|access-snapshots|simulate-complete/);
});

test("V20.22 SecretEncryptionMode is structurally CLIENT_E2E-only", () => {
  const schema = read("prisma/schema.prisma");
  const start = schema.indexOf("enum SecretEncryptionMode {");
  const end = schema.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start);
  const block = schema.slice(start, end + 2);
  assert.match(block, /CLIENT_E2E_V1/);
  assert.doesNotMatch(block, /SERVER_V1/);
  assert.match(schema, /encryptionMode\s+SecretEncryptionMode\s+@default\(CLIENT_E2E_V1\)/);

  const migration = read("prisma/migrations/20260825010000_client_e2e_enum_finalization_v20_22/migration.sql");
  assert.match(migration, /SERVER_V1 creator session rows remain/);
  assert.match(migration, /SERVER_V1 proxy rows remain/);
  assert.match(migration, /CREATE TYPE "SecretEncryptionMode" AS ENUM \('CLIENT_E2E_V1'\)/);
  assert.match(migration, /DROP TYPE "SecretEncryptionMode_v20_22_legacy"/);
});



test("V20.22 keyring exposes security-debt only, with no migration-status compatibility route", () => {
  const route = read("src/routes/client-e2e-keyring.js");
  assert.match(route, /router\.get\("\/security-debt"/);
  assert.match(route, /getCryptoSecurityDebt/);
  assert.doesNotMatch(route, /migration-status|enforce-opaque|migrate-opaque/);
});

test("V20.22 keeps historical migrations while clean baseline generation is explicit and non-destructive", () => {
  assert.equal(exists("prisma/migrations/20260822213000_creator_session_broker_foundation/migration.sql"), true);
  assert.equal(exists("prisma/migrations/20260823193000_client_e2e_secret_envelopes/migration.sql"), true);
  const doc = read("docs/PRODUCTION_DATABASE_BASELINE_V20_22.md");
  const generator = read("scripts/database/generate-production-baseline-v20-22.js");
  assert.match(doc, /brand-new public production database only/i);
  assert.match(doc, /Do not squash, delete, rename or edit/i);
  assert.match(generator, /migrate", "diff"/);
  assert.match(generator, /"--from-empty"/);
  assert.doesNotMatch(generator, /DATABASE_URL|migrate deploy|db push/);
});

test("V20.22 maintenance tools are isolated and dry-run by default", () => {
  assert.equal(exists("dedupe-deliveries.js"), false);
  assert.equal(exists("purge-stuck-deliveries.js"), false);
  for (const rel of [
    "scripts/maintenance/dedupe-deliveries.js",
    "scripts/maintenance/purge-stuck-deliveries.js",
  ]) {
    const src = read(rel);
    assert.match(src, /require\("\.\.\/\.\.\/src\/prisma"\)/);
    assert.match(src, /process\.argv\.includes\("--apply"\)/);
  }
});


test("V20.22 production source does not advertise legacy session authorities", () => {
  const sourceFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) sourceFiles.push(abs);
    }
  };
  walk(path.join(root, "src"));
  const joined = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(joined, /LOCAL_PERSISTENT|\/api\/creator-connect|access-snapshots/);
  assert.doesNotMatch(joined, /encryptionMode\s*\|\|\s*["']SERVER_V1["']/);
});
