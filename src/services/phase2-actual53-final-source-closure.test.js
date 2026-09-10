"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BACKEND = path.resolve(ROOT, "..");
const FINAL_MIGRATION = path.join(BACKEND, "prisma", "migrations", "20260910211500_phase2_actual53_final_closure", "migration.sql");

function productionJsFiles(dir = ROOT) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(BACKEND, file).replaceAll(path.sep, "/");
}

test("Actual53 final source: retired DomainWork generation and wrong tx-key claim calls are unreachable", () => {
  const generationLeaks = [];
  const claimArgumentLeaks = [];
  for (const file of productionJsFiles()) {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("phase2_domain_work_v1")) generationLeaks.push(relative(file));
    if (/lockDomainWorkClaimForCommit\s*\(\s*\{\s*tx\b/.test(source)) claimArgumentLeaks.push(relative(file));
  }
  assert.deepEqual(generationLeaks, []);
  assert.deepEqual(claimArgumentLeaks, []);
});

test("Actual53 final source: every scheduler coverage COMPLETE commit carries exact DomainWork claim authority", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const calls = [...scheduler.matchAll(/markPhase2CoverageComplete\(\{([\s\S]*?)\}\)/g)];
  assert.ok(calls.length >= 10);
  for (const match of calls) {
    assert.match(match[1], /\bworkItem\s*:\s*item\b/);
    assert.match(match[1], /\bownerToken\b/);
  }
});

test("Actual53 final source: Team hot readers and scale evidence target Current physical projection tables", () => {
  for (const name of ["team-analytics-service.js", "team-pending-read-service.js", "team-response-read-service.js", "team-schedule-scale-read-service.js"]) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    assert.doesNotMatch(source, /FROM\s+"TeamResponseCase"\b|JOIN\s+"TeamResponseCase"\b|FROM\s+"TeamPendingDialogState"\b|JOIN\s+"TeamPendingDialogState"\b/);
  }
  const scale = fs.readFileSync(path.join(BACKEND, "scripts", "audit", "phase2-scale-readonly.js"), "utf8");
  assert.match(scale, /TeamResponseCaseCurrent/);
  assert.match(scale, /TeamPendingDialogStateCurrent/);
  assert.match(scale, /prismaPhysicalTable/);
});

test("Actual53 final source: physical Creator hard delete exists only behind bounded destructive worker", () => {
  const hits = [];
  for (const file of productionJsFiles()) {
    const source = fs.readFileSync(file, "utf8");
    if (/creatorAccount\.delete\s*\(/.test(source)) hits.push(relative(file));
  }
  assert.deepEqual(hits, ["src/services/phase2-destructive-delete-authority-service.js"]);
  const destructive = fs.readFileSync(path.join(__dirname, "phase2-destructive-delete-authority-service.js"), "utf8");
  assert.match(destructive, /DESTRUCTIVE_CREATOR_CLEANUP/);
  assert.match(destructive, /Math\.min\(1000/);
  assert.match(destructive, /lockDomainWorkClaimForCommit\(\{\s*db:\s*tx,/);
  assert.match(destructive, /phase2CreatorResidualRowsRemain/);
  assert.match(destructive, /creatorCascadeRowsRemain/);
});

test("Actual53 final source: effective DomainWork SQL publisher accepts CURRENT_TIMESTAMP timestamptz", () => {
  const migration = fs.readFileSync(FINAL_MIGRATION, "utf8");
  assert.match(migration, /DROP FUNCTION IF EXISTS "phase2_publish_domain_work"\([\s\S]*TIMESTAMP WITHOUT TIME ZONE[\s\S]*\);/);
  const createAt = migration.lastIndexOf('CREATE OR REPLACE FUNCTION "phase2_publish_domain_work"(');
  assert.ok(createAt >= 0);
  const body = migration.slice(createAt, migration.indexOf("$$ LANGUAGE plpgsql;", createAt) + "$$ LANGUAGE plpgsql;".length);
  assert.match(body, /p_available_at\s+TIMESTAMPTZ\s+DEFAULT CURRENT_TIMESTAMP/);
});
