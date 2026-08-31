"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("served Web UI has zero legacy creator-connect or dev-import enrollment authority", () => {
  const home = read("public/pages/home.js");
  assert.doesNotMatch(home, /\/api\/creator-connect/);
  assert.doesNotMatch(home, /\/api\/dev-migration\/import-local/);
  assert.doesNotMatch(home, /onlinod:\/\/connect|onlinod:\/\/migrate-local/);
  assert.match(home, /Creator enrollment is owned by ONLINOD Desktop/);
  assert.match(home, /Open ONLINOD Desktop/);
});

test("legacy enrollment generation is physically absent from the production tree", () => {
  assert.equal(fs.existsSync(path.join(root, "server.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/routes/creator-connect.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/routes/creator-import.js")), false);
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts?.start, "node src/server.js");
});

test("DB migration is the final active identity uniqueness authority", () => {
  const migration = read("prisma/migrations/20260831190000_creator_enrollment_authority_cutover/migration.sql");
  assert.match(migration, /CreatorAccount_active_remote_identity_unique/);
  assert.match(migration, /ON "CreatorAccount" \("agencyId", "remoteId"\)/);
  assert.match(migration, /WHERE "deletedAt" IS NULL AND "remoteId" IS NOT NULL/);
  assert.match(migration, /CreatorAccount_active_username_identity_unique/);
  assert.match(migration, /lower\(COALESCE\("platformUsername", "enrollmentExpectedUsername", "username"\)\)/);
});

test("connection routes delegate lifecycle authority to one enrollment service", () => {
  const routes = read("src/routes/creators.js");
  assert.match(routes, /beginCreatorConnection/);
  assert.match(routes, /completeCreatorConnection/);
  assert.match(routes, /observeCreatorPlatformProfile/);
  assert.match(routes, /router\.post\("\/:id\/begin-connection", creatorManagementRequired, creatorAccessRequired/);
  assert.match(routes, /router\.post\("\/:id\/complete-connection", creatorManagementRequired, creatorAccessRequired/);
  assert.match(routes, /router\.post\("\/:id\/platform-profile", creatorAccessRequired/);
});
