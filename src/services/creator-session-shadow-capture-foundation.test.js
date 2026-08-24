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

test("V20.12 backend independently removes non-portable OF cookie noise", () => {
  const broker = read("src/services/creator-session-broker-service.js");
  assert.match(broker, /SESSION_COOKIE_NOISE_EXACT/);
  assert.match(broker, /cloudfront-/i);
  assert.match(broker, /_ga_/);
  assert.match(broker, /__cf_bm/);
  assert.match(broker, /startsWith\("__cf"\)/);
  assert.match(broker, /startsWith\("cf_"\)/);
  assert.match(broker, /isPortableSessionCookieName/);
});


test("V20.13.2 broker read defaults to metadata-only and active access is enforced separately from revoke", () => {
  const route = read("src/routes/creator-sessions.js");
  assert.match(route, /includePayload = String\(req\.query\.includePayload \?\? "0"\).*=== "1"/);
  assert.match(route, /if \(requireActive\) assertCreatorSessionTargetActive\(creator\)/);
  assert.match(route, /authorize\(req, req\.params\.creatorId, input\.deviceId, \{ requireActive: false \}\)/);
});
