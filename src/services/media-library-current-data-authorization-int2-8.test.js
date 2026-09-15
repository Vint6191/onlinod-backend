"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const route = fs.readFileSync(path.join(root, "routes/media-library.js"), "utf8");
const service = fs.readFileSync(path.join(root, "services/media-library-service.js"), "utf8");

test("INT2.8 usage route carries exact current accessEpoch into a commit-time execution fence", () => {
  const block = route.slice(route.indexOf('async function putCurrentAuthorizedUsageSources'), route.indexOf('router.post("/:creatorId/folders/mutate"'));
  assert.match(route, /accessEpoch:\s*z\.number\(\)\.int\(\)\.min\(0\)/);
  assert.match(route, /router\.put\("\/:creatorId\/usage-sources\/current-authorized", putCurrentAuthorizedUsageSources\)/);
  assert.match(route, /router\.put\("\/:creatorId\/usage-sources", putCurrentAuthorizedUsageSources\)/);
  assert.match(block, /const admittedAccessEpoch = currentAccessEpoch\(req\)/);
  assert.match(block, /input\.accessEpoch !== admittedAccessEpoch/);
  assert.match(block, /assertExecutionAccessFence\(\{[\s\S]*accessEpoch:\s*input\.accessEpoch[\s\S]*creatorId[\s\S]*lock:\s*true/);
  assert.match(block, /replaceUsageSources\(\{[\s\S]*commitGuard/);
});

test("INT2.8 service invokes generation guard inside each source transaction before sourceRevision/media ordering", () => {
  const block = service.slice(service.indexOf("async function replaceUsageSources"), service.indexOf("async function mutateFolderMembership"));
  const txAt = block.indexOf("db.$transaction");
  const guardAt = block.indexOf('if (typeof commitGuard === "function") await commitGuard(tx)');
  const replaceAt = block.indexOf("replaceUsageSourceTx(tx");
  assert.ok(txAt >= 0 && guardAt > txAt && replaceAt > guardAt);
  assert.match(service, /compareRevisions\(source\.sourceRevision, state\.sourceRevision\)/);
});
