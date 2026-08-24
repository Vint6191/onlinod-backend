"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260823190000_client_e2e_key_hierarchy", "migration.sql"), "utf8");

function modelBlock(name) {
  const start = schema.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `${name} model missing`);
  const next = schema.indexOf("\nmodel ", start + 1);
  return schema.slice(start, next >= 0 ? next : schema.length);
}

test("V20.19.1 owner key wraps follow the actual durable FK model", () => {
  const rootModel = modelBlock("AgencyCryptoRoot");
  const wrapModel = modelBlock("AgencyCryptoOwnerKeyWrap");

  assert.match(wrapModel, /agency\s+Agency\s+@relation\(fields: \[agencyId\], references: \[id\], onDelete: Cascade\)/);
  assert.doesNotMatch(wrapModel, /root\s+AgencyCryptoRoot\s+@relation\(fields: \[agencyId\]/);
  assert.doesNotMatch(rootModel, /ownerKeyWraps\s+AgencyCryptoOwnerKeyWrap\[\]/);

  assert.match(migration, /AgencyCryptoOwnerKeyWrap_agencyId_fkey/);
  assert.doesNotMatch(migration, /AgencyCryptoOwnerKeyWrap_root/);
});

test("V20.19.1 historical rootVersion remains metadata, not a fake FK to the mutable current root row", () => {
  const wrapModel = modelBlock("AgencyCryptoOwnerKeyWrap");
  assert.match(wrapModel, /rootVersion\s+Int/);
  assert.match(wrapModel, /rootVersion is historical key-generation metadata/);
});
