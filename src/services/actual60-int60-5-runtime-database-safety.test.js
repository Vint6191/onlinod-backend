"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const gatePath = path.join(root, "scripts/audit/actual59-auth-lifecycle-gate.js");
const source = fs.readFileSync(gatePath, "utf8");

function runGate(mode, env = {}) {
  return spawnSync(process.execPath, [gatePath, mode], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: "",
      ONLINOD_AUDIT_DATABASE_URL: "",
      ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE: "",
      ...env,
    },
    encoding: "utf8",
  });
}

test("INT60.5 runtime evidence: mutating PG gates require an explicit disposable audit database", () => {
  for (const mode of ["migration", "pg", "scale"]) {
    const result = runGate(mode, {
      DATABASE_URL: "postgresql://prod:secret@prod.example.test:5432/onlinod?schema=public",
    });
    assert.equal(result.status, 3, `${mode} must block when only primary DATABASE_URL is configured`);
    assert.match(`${result.stdout}\n${result.stderr}`, /refusing to run mutating audit against DATABASE_URL/);
  }
});

test("INT60.5 runtime evidence: audit URL that resolves to the primary database/schema is rejected without destructive opt-in", () => {
  const result = runGate("pg", {
    DATABASE_URL: "postgresql://prod:one@db.example.test:5432/onlinod?schema=public",
    ONLINOD_AUDIT_DATABASE_URL: "postgresql://audit:two@DB.EXAMPLE.TEST:5432/onlinod?schema=public",
  });
  assert.equal(result.status, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /same physical database/);
});

test("INT60.5 runtime evidence: explicit primary override remains possible but is visibly exceptional", () => {
  assert.match(source, /ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE/);
  assert.match(source, /DATABASE_URL_EXPLICIT_OVERRIDE/);
  assert.match(source, /ONLINOD_AUDIT_DATABASE_URL/);
});

test("INT60.5 runtime evidence: audit DATABASE_URL is propagated to migration, correctness and scale children", () => {
  assert.match(source, /DATABASE_URL:\s*auditDatabaseUrl[\s\S]*ONLINOD_ACTUAL60_MIGRATION_REHEARSAL/);
  assert.match(source, /postgres-forced-interleavings[\s\S]*DATABASE_URL:\s*auditDatabaseUrl/);
  assert.match(source, /postgres-telemetry-scale[\s\S]*DATABASE_URL:\s*auditDatabaseUrl/);
  assert.match(source, /postgres-refreshsession-hot-cold-scale[\s\S]*DATABASE_URL:\s*auditDatabaseUrl/);
});

test("INT60.5 runtime evidence: optional pg migration applies online RefreshSession indexes too", () => {
  const pgStart = source.indexOf("function pgGate()");
  const pgEnd = source.indexOf("function scaleGate()", pgStart);
  const pgBlock = source.slice(pgStart, pgEnd);
  assert.match(pgBlock, /prisma-migrate-deploy/);
  assert.match(pgBlock, /actual60-refreshsession-online-index-preflight\.js/);
  assert.match(pgBlock, /DATABASE_URL:\s*auditDatabaseUrl/);
});
