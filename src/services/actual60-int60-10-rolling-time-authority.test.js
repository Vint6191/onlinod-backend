"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");





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


