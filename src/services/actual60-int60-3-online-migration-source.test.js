"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");



test("INT60.4 migration: online ensure builds every F60 current/history index CONCURRENTLY and repairs invalid leftovers", () => {
  const source = read("scripts/database/actual60-refreshsession-online-index-preflight.js");
  for (const name of [
    "RefreshSession_live_authorization_lookup_idx",
    "RefreshSession_live_lineage_lookup_idx",
    "RefreshSession_authorization_history_idx",
    "RefreshSession_live_user_lookup_idx",
    "RefreshSession_live_agency_lookup_idx",
    "RefreshSession_user_history_created_idx",
  ]) {
    assert.match(source, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS \\"${name}\\"`));
  }
  assert.match(source, /indisvalid/);
  assert.match(source, /indisready/);
  assert.match(source, /DROP INDEX CONCURRENTLY IF EXISTS/);
  assert.match(source, /fresh\/empty schema missing prerequisites/);
  assert.match(source, /populated RefreshSession is missing online-index prerequisite columns/);
  assert.match(source, /SELECT EXISTS\(SELECT 1 FROM "RefreshSession" LIMIT 1\)/);
  assert.match(source, /to_regclass\([\s\S]*?\)::text AS relation/, "Prisma raw queries must not return PostgreSQL regclass values directly");
  assert.doesNotMatch(source, /\$transaction\s*\(/, "CREATE INDEX CONCURRENTLY ensure must stay outside Prisma transactions");
});




