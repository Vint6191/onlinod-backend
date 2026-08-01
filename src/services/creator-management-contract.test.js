"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("changed creator-management backend files pass node syntax checks", () => {
  for (const rel of ["routes/creators.js", "middleware/creator-management-permissions.js"]) {
    execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
  }
});

test("all creator writes require management permission", () => {
  const source = read("routes/creators.js");
  assert.match(source, /router\.post\("\/", creatorManagementRequired/);
  assert.match(source, /router\.patch\("\/:id", creatorManagementRequired/);
  assert.match(source, /router\.delete\("\/:id", creatorManagementRequired/);
  assert.match(source, /router\.post\("\/:id\/complete-runtime", creatorManagementRequired/);
  assert.match(source, /router\.post\("\/:id\/avatar", creatorManagementRequired/);
});

test("creation requires an expected OnlyFans username and a generated persistent partition", () => {
  const source = read("routes/creators.js");
  assert.match(source, /const creatorUsernameSchema = z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.regex/);
  assert.match(source, /username: creatorUsernameSchema/);
  assert.match(source, /persist:acct_/);
  assert.match(source, /CREATOR_ALREADY_EXISTS/);
  assert.match(source, /mode: "insensitive"/);
  const createSchema = source.slice(source.indexOf("const createSchema"), source.indexOf("const completeRuntimeSchema"));
  assert.doesNotMatch(createSchema, /remoteId|partition|status/);
});

test("runtime completion is identity-bound, race-safe and idempotent", () => {
  const source = read("routes/creators.js");
  assert.match(source, /CREATOR_IDENTITY_MISMATCH/);
  assert.match(source, /CREATOR_PARTITION_MISMATCH/);
  assert.match(source, /displayName: existing\.displayName/);
  assert.match(source, /creatorAccount\.updateMany/);
  assert.match(source, /deletedAt: null/);
  assert.match(source, /wasAlreadyConnected/);
  assert.match(source, /if \(!wasAlreadyConnected\)/);
  assert.match(source, /CREATOR_CONNECTION_STALE/);
  assert.match(source, /scheduleInitialJobsForCreator/);
});

test("delete requires exact confirmation and cleans live server work transactionally", () => {
  const source = read("routes/creators.js");
  assert.match(source, /confirmation !== existing\.id/);
  assert.match(source, /prisma\.\$transaction/);
  assert.match(source, /accessSnapshot\.updateMany/);
  assert.match(source, /deviceCreatorBinding\.updateMany/);
  assert.match(source, /creatorConnectSession\.updateMany/);
  assert.match(source, /status: \{ in: \["SCHEDULED", "CLAIMED", "FAILED"\] \}/);
  assert.match(source, /status: "CANCELLED"/);
});
