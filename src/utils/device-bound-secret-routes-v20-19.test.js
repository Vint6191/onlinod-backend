"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

test("E2E secret routes bind the logical actor to the signed JWT device claim", () => {
  const keyring = source("routes/client-e2e-keyring.js");
  const sessions = source("routes/creator-sessions.js");
  const network = source("routes/network-profiles.js");

  assert.match(keyring, /requireAuthDevice/);
  assert.match(keyring, /function actorDevice\([\s\S]*?requireAuthDevice\(/);
  assert.match(sessions, /requireAuthDevice/);
  assert.match(sessions, /const boundDeviceId = requireAuthDevice\(/);
  assert.match(network, /requireAuthDevice/);
  assert.match(network, /const boundDeviceId = requireAuthDevice\(/);
});

test("Session and proxy E2E routes never use mutable WorkerDevice as crypto authority", () => {
  const sessions = source("routes/creator-sessions.js");
  const network = source("routes/network-profiles.js");

  assert.doesNotMatch(sessions, /requireRegisteredDevice/);
  assert.doesNotMatch(network, /requireRegisteredDevice/);
  assert.doesNotMatch(sessions, /workerDevice\./);
  assert.doesNotMatch(network, /workerDevice\./);

  // The service layer is the second fence for CLIENT_E2E_V1 material.
  const broker = source("services/creator-session-broker-service.js");
  const profiles = source("services/creator-network-profile-service.js");
  assert.match(broker, /CLIENT_E2E_V1[\s\S]*?assertDeviceCanUseCreatorKey|assertDeviceCanUseCreatorKey[\s\S]*?CLIENT_E2E_V1/);
  assert.match(profiles, /assertDeviceCanUseCreatorKey/);
});

test("refresh-session device binding cannot be moved to a different logical device", () => {
  const authService = source("services/auth-service.js");
  const authMiddleware = source("middleware/auth.js");
  assert.match(authService, /resolveRefreshDeviceBinding\(session\.deviceId, deviceId\)/);
  assert.match(authService, /deviceId:\s*effectiveDeviceId/);
  assert.match(authMiddleware, /deviceId:\s*decoded\.deviceId/);
});

test("destructive owner crypto routes require an AMK-possession actorProof", () => {
  const keyring = source("routes/client-e2e-keyring.js");
  for (const route of [
    '/devices/:deviceId/approve',
    '/root-rotation/begin',
    '/root-rotation/finalize',
    '/creators/:creatorId/rotate',
    '/enforce-opaque',
    '/devices/:deviceId/revoke',
  ]) {
    assert.ok(keyring.includes(`router.post("${route}"`), `missing route ${route}`);
  }
  assert.match(keyring, /const actorProof = recoveryProof/);
  assert.match(keyring, /expectedRootVersion:[\s\S]*actorProof/);
  assert.match(keyring, /root-rotation\/begin[\s\S]*actorProof/);
  assert.match(keyring, /root-rotation\/finalize[\s\S]*actorProof/);
  assert.match(keyring, /creators\/:creatorId\/rotate[\s\S]*actorProof/);
  assert.match(keyring, /enforce-opaque[\s\S]*actorProof/);
  assert.match(keyring, /devices\/:deviceId\/revoke[\s\S]*actorProof/);
});
