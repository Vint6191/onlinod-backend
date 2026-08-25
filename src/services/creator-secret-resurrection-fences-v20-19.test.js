"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("V20.22 old Creator Connect and Creator Import secret writers are physically absent", () => {
  assert.equal(fs.existsSync(path.join(root, "routes/creator-connect.js")), false);
  assert.equal(fs.existsSync(path.join(root, "routes/creator-import.js")), false);
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.doesNotMatch(server, /creator-connect|creatorConnectRoutes|creator-import/);
});

test("V20.22 AccessSnapshot HTTP payload surface is physically absent", () => {
  assert.equal(fs.existsSync(path.join(root, "routes/access-snapshots.js")), false);
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.doesNotMatch(server, /access-snapshots|accessSnapshotRoutes/);
});
