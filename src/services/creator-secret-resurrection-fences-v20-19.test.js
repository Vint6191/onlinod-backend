"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const connectSource = fs.readFileSync(path.join(root, "routes/creator-connect.js"), "utf8");
const importSource = fs.readFileSync(path.join(root, "routes/creator-import.js"), "utf8");

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("V20.19 every legacy Creator Connect snapshot writer revalidates live creator and connect-session inside its transaction", () => {
  assert.match(connectSource, /function requireLiveCreatorConnectSecretTarget|async function requireLiveCreatorConnectSecretTarget/);
  assert.ok(
    count(connectSource, /await requireLiveCreatorConnectSecretTarget\s*\(\s*\{/g) >= 3,
    "all three AccessSnapshot writer transactions must fence creator deletion/connect cancellation before writing secrets",
  );
  const createPositions = [...connectSource.matchAll(/await tx\.accessSnapshot\.create\s*\(/g)].map((match) => match.index);
  assert.equal(createPositions.length, 3, "expected all three current Creator Connect snapshot writers to remain covered");
  for (const pos of createPositions) {
    const prefix = connectSource.slice(Math.max(0, pos - 2200), pos);
    assert.match(prefix, /await requireLiveCreatorConnectSecretTarget\s*\(/, "secret create must be preceded by a fresh transactional lifecycle fence");
  }
});

test("V20.19 Creator Import never matches soft-deleted history and revalidates a live creator before writing AccessSnapshot", () => {
  assert.match(importSource, /findExistingCreator\s*\(\s*\{\s*tx,/);
  assert.match(importSource, /async function findExistingCreator\s*\(\s*\{\s*tx,/);
  assert.ok(count(importSource, /deletedAt:\s*null/g) >= 3, "remoteId, username, and partition lookup paths must exclude soft-deleted creators");
  assert.match(importSource, /async function saveImportedSnapshot[\s\S]*?await requireLiveCreatorSecretTarget\s*\(/);
  assert.ok(importSource.indexOf("await requireLiveCreatorSecretTarget") < importSource.indexOf("return tx.accessSnapshot.create"), "live creator fence must run before imported snapshot creation");
});
