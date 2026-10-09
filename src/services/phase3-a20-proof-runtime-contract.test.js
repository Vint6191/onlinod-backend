"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");













test("A25 fixture lifecycle derives coverage from current Phase2 authority and tears Creators down before Agency", () => {
  const isolation = source("scripts/audit/phase3-a20-schema-isolation.js");
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  assert.match(isolation, /FAMILY, GENERATION/);
  assert.match(isolation, /Object\.values\(FAMILY\)/);
  assert.doesNotMatch(isolation, /coverageRows\.length\s*!==\s*2/);
  assert.match(isolation, /canonical current Phase2 coverage graph/);
  const creatorDelete = fixture.indexOf("tx.creatorAccount.deleteMany");
  const agencyDelete = fixture.indexOf("tx.agency.deleteMany");
  assert.ok(creatorDelete >= 0 && agencyDelete > creatorDelete, "fixture teardown must delete Creators before Agency");
  assert.match(fixture, /onlinod\.phase2_destructive_agency_id/);
  assert.match(fixture, /creatorAccount\.deleteMany/);
});
