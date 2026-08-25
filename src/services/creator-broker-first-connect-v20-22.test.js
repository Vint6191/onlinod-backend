"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "routes", "creators.js"), "utf8");
const createRoute = source.slice(source.indexOf('router.post("/", creatorManagementRequired'), source.indexOf('router.get("/:id"'));
const completionRoute = source.slice(source.indexOf('router.post("/:id/complete-connection"'), source.indexOf('router.post("/:id/avatar"'));

test("V20.22 DRAFT creation no longer allocates a backend-owned Chromium partition", () => {
  assert.doesNotMatch(createRoute, /\bpartition\b/);
  assert.doesNotMatch(createRoute, /persist:acct_|persist:creator_|makePartition/);
});

test("V20.22 completion is gated by canonical broker identity rather than partition equality", () => {
  assert.match(completionRoute, /creatorSessionState\.findUnique/);
  assert.match(completionRoute, /canonical\.status === "ACTIVE"/);
  assert.match(completionRoute, /Number\(canonical\.revision\) > 0/);
  assert.match(completionRoute, /Number\(canonical\.payloadVersion\) === 1/);
  assert.match(completionRoute, /canonical\.portableReady === true/);
  assert.match(completionRoute, /canonical\.platformUserId/);
  assert.match(completionRoute, /CREATOR_CANONICAL_SESSION_REQUIRED/);
  assert.doesNotMatch(completionRoute, /CREATOR_PARTITION_MISMATCH|expectedPartition|makePartition/);
  assert.doesNotMatch(completionRoute, /\bpartition\s*:/);
});
