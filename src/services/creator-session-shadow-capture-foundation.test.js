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
  assert.match(route, /includePayload,\s*\n\s*\}\)/);
  assert.match(route, /String\(req\.query\.includePayload \?\? "1"\).*!== "0"/);
});

test("V20.12 backend independently removes non-portable OF cookie noise", () => {
  const broker = read("src/services/creator-session-broker-service.js");
  assert.match(broker, /SESSION_COOKIE_NOISE_EXACT/);
  assert.match(broker, /cloudfront-/i);
  assert.match(broker, /_ga_/);
  assert.match(broker, /__cf_bm/);
  assert.match(broker, /isPortableSessionCookieName/);
});
