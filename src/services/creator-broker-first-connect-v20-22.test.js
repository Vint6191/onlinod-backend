"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "creators.js"), "utf8");
const authority = fs.readFileSync(path.join(__dirname, "creator-enrollment-authority-service.js"), "utf8");
const createRoute = routes.slice(routes.indexOf('router.post("/", creatorManagementRequired'), routes.indexOf('router.get("/:id"'));
const completionRoute = routes.slice(routes.indexOf('router.post("/:id/complete-connection"'), routes.indexOf('router.post("/:id/avatar"'));

test("V20.22 DRAFT creation no longer allocates a backend-owned Chromium partition", () => {
  assert.doesNotMatch(createRoute, /\bpartition\b/);
  assert.doesNotMatch(createRoute, /persist:acct_|persist:creator_|makePartition/);
});

test("V20.22 completion delegates to Audit14 atomic canonical identity authority rather than partition equality", () => {
  assert.match(completionRoute, /completeCreatorConnection\(\{/);
  assert.match(completionRoute, /connectionGeneration: input\.connectionGeneration/);
  assert.match(authority, /creatorSessionState\.findUnique/);
  assert.match(authority, /canonical\.status !== "ACTIVE"/);
  assert.match(authority, /Number\(canonical\.revision\) <= 0/);
  assert.match(authority, /Number\(canonical\.payloadVersion\) !== 1/);
  assert.match(authority, /canonical\.portableReady !== true/);
  assert.match(authority, /canonical\.platformUserId/);
  assert.match(authority, /CREATOR_CANONICAL_SESSION_REQUIRED/);
  assert.match(authority, /CREATOR_CONNECTION_GENERATION_STALE/);
  assert.match(authority, /creatorConnectionLockKey\(agencyId, creatorId\)/);
  assert.doesNotMatch(completionRoute, /CREATOR_PARTITION_MISMATCH|expectedPartition|makePartition/);
  assert.doesNotMatch(completionRoute, /\bpartition\s*:/);
});
