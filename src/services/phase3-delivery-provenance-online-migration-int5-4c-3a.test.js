"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const sha256 = (relative) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");

const LEGACY_MIGRATION = "prisma/migrations/20260916222000_phase3_fan_observation_delivery_provenance/migration.sql";
const PREFLIGHT = "scripts/database/phase3-fandata-delivery-provenance-online-preflight.js";

test("INT5.4C-3A keeps the already-issued provenance migration byte-for-byte unchanged", () => {
  assert.equal(
    sha256(LEGACY_MIGRATION),
    "9fcb362d1edd5f1cde19113b4b5fa240458ad8bfa0cbcbffadd2250df6652376",
  );
});

test("INT5.4C-3A production migrate runs provenance online preflight before prisma migrate deploy", () => {
  const pkg = JSON.parse(read("package.json"));
  const command = String(pkg?.scripts?.["prisma:migrate"] || "");
  assert.match(command, /phase3-fandata-delivery-provenance-online-preflight\.js/);
  assert.match(command, /prisma migrate deploy/);
  assert.ok(
    command.indexOf("phase3-fandata-delivery-provenance-online-preflight.js") < command.indexOf("prisma migrate deploy"),
    "hot-table provenance ensure must run before the historical blocking migration can execute",
  );
  assert.ok(
    command.indexOf("prisma migrate deploy") < command.indexOf("actual60-refreshsession-online-index-preflight.js"),
    "existing Actual60 post-deploy index ensure ordering must remain intact",
  );
});

test("INT5.4C-3A populated rollout uses short-lock nullable columns, NOT VALID FKs, validation and concurrent indexes", () => {
  const source = read(PREFLIGHT);
  assert.match(source, /ADD COLUMN IF NOT EXISTS \"sourceDeliveryId\" TEXT/);
  assert.match(source, /NOT VALID/);
  assert.match(source, /VALIDATE CONSTRAINT/);
  assert.match(source, /SET LOCAL lock_timeout = '5s'/);
  assert.match(source, /CREATE INDEX CONCURRENTLY IF NOT EXISTS \"CreatorFanRelationshipCurrent_sourceDeliveryId_idx\"/);
  assert.match(source, /CREATE INDEX CONCURRENTLY IF NOT EXISTS \"CreatorFanValueCurrent_sourceDeliveryId_idx\"/);
  assert.match(source, /DROP INDEX CONCURRENTLY IF EXISTS/);
  assert.match(source, /indisvalid/);
  assert.match(source, /indisready/);

  const concurrentBlocks = source.match(/async function ensureIndex[\s\S]*?\n}\n/g) || [];
  assert.equal(concurrentBlocks.length, 1);
  assert.doesNotMatch(concurrentBlocks[0], /\$transaction\s*\(/, "CREATE INDEX CONCURRENTLY must stay outside transactions");
});

test("INT5.4C-3A populated pending migration is baselined only after schema ensure; fresh empty schema remains Prisma-owned", () => {
  const source = read(PREFLIGHT);
  assert.match(source, /if \(!state\.populated && !applied\)/);
  assert.match(source, /ordinary Prisma migration is effectively free/);
  assert.match(source, /await ensureOnlineSchema\(db\);/);
  assert.match(source, /if \(!applied\)[\s\S]*resolveApplied\(\)/);
  assert.ok(
    source.indexOf("await ensureOnlineSchema(db);") < source.indexOf("resolveApplied();"),
    "migration must never be marked applied before online schema equivalence is proven",
  );
  assert.match(source, /migrate", "resolve", "--applied", MIGRATION/);
});

test("INT5.4C-3A preflight verifies FK/index shape and repairs invalid concurrent index leftovers", () => {
  const source = read(PREFLIGHT);
  assert.match(source, /pg_get_constraintdef/);
  assert.match(source, /references \"automationdelivery\"\(id\)/i);
  assert.match(source, /on update cascade/i);
  assert.match(source, /on delete set null/i);
  assert.match(source, /pg_get_indexdef/);
  assert.match(source, /repair-invalid-index/);
});
