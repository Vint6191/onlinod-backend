"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("V20.12 metadata read can omit plaintext payload while preserving managed-read compatibility", () => {
  const route = read("src/routes/creator-sessions.js");
  assert.match(route, /req\.query\.includePayload/);
  assert.match(route, /getCreatorSession\(\{[\s\S]*?includePayload,[\s\S]*?\}\)/);
  assert.match(route, /String\(req\.query\.includePayload \?\? "0"\).*=== "1"/);
});

test("V20.22 backend no longer parses plaintext OF cookie jars after CLIENT_E2E cutover", () => {
  const broker = read("src/services/creator-session-broker-service.js");
  assert.doesNotMatch(broker, /SESSION_COOKIE_NOISE_EXACT|isPortableSessionCookieName|normalizeCookie|normalizePayload/);
  assert.doesNotMatch(broker, /__cf_bm|cf_clearance|auth_id|cookies/);
  assert.match(broker, /opaquePayload/);
  assert.match(broker, /portableReady/);
});


test("V20.13.2 broker read defaults to metadata-only and active access is enforced separately from revoke", () => {
  const route = read("src/routes/creator-sessions.js");
  assert.match(route, /includePayload = String\(req\.query\.includePayload \?\? "0"\).*=== "1"/);
  assert.match(route, /if \(requireActive\) assertCreatorSessionTargetActive\(creator\)/);
  assert.match(route, /authorize\(req, req\.params\.creatorId, input\.deviceId, \{ requireActive: false \}\)/);
});
