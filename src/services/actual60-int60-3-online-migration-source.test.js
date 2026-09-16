"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("INT60.4 migration: production prisma:migrate applies schema prerequisites before online RefreshSession index ensure", () => {
  const pkg = JSON.parse(read("package.json"));
  const command = String(pkg?.scripts?.["prisma:migrate"] || "");
  assert.match(command, /prisma migrate deploy/);
  assert.match(command, /actual60-refreshsession-online-index-preflight\.js/);
  assert.ok(
    command.indexOf("prisma migrate deploy") < command.indexOf("actual60-refreshsession-online-index-preflight.js"),
    "schema/lineage prerequisites must deploy before the concurrent F60 index ensure",
  );
});

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

test("INT60.4 migration: populated-table migration SQL records ledger step without blocking index construction", () => {
  for (const relative of [
    "prisma/migrations/20260916011500_actual60_refreshsession_hot_cold_scale/migration.sql",
    "prisma/migrations/20260916013000_actual60_refreshsession_live_user_scale/migration.sql",
    "prisma/migrations/20260916014500_actual60_refreshsession_current_write_history_scale/migration.sql",
  ]) {
    const migration = read(relative);
    assert.match(migration, /IF NOT EXISTS \(SELECT 1 FROM "RefreshSession" LIMIT 1\) THEN/);
    assert.match(migration, /CREATE INDEX IF NOT EXISTS/);
    assert.match(migration, /Fresh\/empty|fresh\/empty/i);
    const executableSql = migration.replace(/^--.*$/gm, "");
    assert.doesNotMatch(executableSql, /CREATE INDEX CONCURRENTLY/i,
      "CONCURRENTLY belongs to the post-migration online ensure, not Prisma migration SQL");
    assert.doesNotMatch(migration, /ALTER TABLE|UPDATE\s+"RefreshSession"|DELETE FROM|TRUNCATE/i);
  }
});

test("INT60.4 migration rehearsal: starts before lineage, preserves legacy NULL row, deploys schema first, then proves concurrent online ensure", () => {
  const source = read("scripts/audit/actual60-migration-rehearsal.js");
  assert.match(source, /20260915193000_actual59_int59_3_authorization_lineage_catalog_boundary/);
  assert.match(source, /deploy-pre-lineage/);
  assert.match(source, /deploy-pre-scale-prerequisites/);
  assert.match(source, /pre-lineage legacy RefreshSession was silently reclassified/);
  assert.match(source, /deploy-through-int60\.8-schema-first/);
  assert.match(source, /populated-table F60 migration built indexes before online ensure/);
  assert.match(source, /LOCK TABLE "RefreshSession" IN ROW EXCLUSIVE MODE/);
  assert.match(source, /ShareUpdateExclusiveLock/);
  assert.match(source, /online-index-ensure-under-row-exclusive/);
  assert.match(source, /actual60-refreshsession-online-index-preflight\.js/);
  assert.match(source, /redeploy-idempotence-online-index-ensure/);
  assert.match(source, /process\.exitCode = Number\(error\?\.exitCode \|\| 1\)/);
  assert.doesNotMatch(source, /function fail[\s\S]{0,180}process\.exit\(/, "rehearsal failures must unwind through finally cleanup");
});
