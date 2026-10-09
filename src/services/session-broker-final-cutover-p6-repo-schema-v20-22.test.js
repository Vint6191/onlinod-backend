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





test("V20.22 keyring exposes security-debt only, with no migration-status compatibility route", () => {
  const route = read("src/routes/client-e2e-keyring.js");
  assert.match(route, /router\.get\("\/security-debt"/);
  assert.match(route, /getCryptoSecurityDebt/);
  assert.doesNotMatch(route, /migration-status|enforce-opaque|migrate-opaque/);
});



test("retired delivery cleanup entry points fail without loading a database or mutating data", () => {
  const { spawnSync } = require('node:child_process');
  for (const rel of ['dedupe-deliveries.js', 'purge-stuck-deliveries.js', 'scripts/maintenance/dedupe-deliveries.js', 'scripts/maintenance/purge-stuck-deliveries.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /require\(|deleteMany|\$executeRaw/);
    for (const args of [[], ['--apply']]) {
      const result = spawnSync(process.execPath, [path.join(root, rel), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr.trim()).code, 'LEGACY_DELIVERY_CLEANUP_RETIRED');
    }
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
