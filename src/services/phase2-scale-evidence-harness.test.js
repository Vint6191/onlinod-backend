"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const harness = fs.readFileSync(path.join(ROOT, "scripts", "audit", "phase2-scale-readonly.js"), "utf8");
const executable = harness.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("Phase2 scale evidence harness is explicit opt-in and targets one Agency", () => {
  assert.match(harness, /ONLINOD_PHASE2_SCALE_BENCHMARK=1_REQUIRED/);
  assert.match(harness, /ONLINOD_PHASE2_SCALE_AGENCY_ID/);
  assert.match(harness, /agency\.findUnique/);
  assert.equal(pkg.scripts?.["audit:phase2-scale"], "node scripts/audit/phase2-scale-readonly.js");
});

test("Phase2 scale evidence harness executable code never mutates business rows", () => {
  assert.doesNotMatch(executable, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
  assert.doesNotMatch(executable, /\$executeRaw/);
  assert.doesNotMatch(executable, /`\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

test("Phase2 scale evidence measures all-range money OFF and ON with bounded cardinality checks", () => {
  assert.match(harness, /rangeKey:\s*"all"/);
  assert.match(harness, /includeMoney:\s*false/);
  assert.match(harness, /includeMoney:\s*true/);
  assert.match(harness, /money_off_reads_zero_money_facts/);
  assert.match(harness, /raw_result_cardinality_bounded/);
  assert.match(harness, /top_dialogs_bounded/);
});

test("Phase2 EXPLAIN ANALYZE is separately opt-in and mirrors bounded response/dialog detail", () => {
  assert.match(harness, /ONLINOD_PHASE2_SCALE_EXPLAIN/);
  assert.match(harness, /EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
  assert.match(harness, /responses_retained_detail_grouped_by_member/);
  assert.match(harness, /dialogs_retained_detail_top10_by_member/);
  assert.match(harness, /ONLINOD_PHASE2_SCALE_DETAIL_DAYS/);
});

test("Phase2 large-data qualification is evidence-only and cannot fabricate fixtures", () => {
  assert.match(harness, /ONLINOD_PHASE2_SCALE_REQUIRE_LARGE/);
  assert.match(harness, /members>=100/);
  assert.match(harness, /creatorsTouched>=500/);
  assert.match(harness, /moneyFacts>=1000000/);
  assert.match(harness, /pending>=10000/);
  assert.doesNotMatch(executable, /\b(seed|fixture|generateRows)\s*\(/i);
});

test("Phase2 scale harness refuses to benchmark legacy Team physical sinks", () => {
  assert.match(harness, /TeamResponseCaseCurrent/);
  assert.match(harness, /TeamPendingDialogStateCurrent/);
  assert.match(harness, /PHASE2_SCALE_CURRENT_AUTHORITY_MAPPING_MISMATCH/);
  assert.match(harness, /prismaPhysicalTable/);
  assert.doesNotMatch(
    harness,
    /FROM "TeamResponseCase" r[\s\S]*responses_retained_detail_grouped_by_member/
  );
  assert.doesNotMatch(
    harness,
    /FROM "TeamPendingDialogState" p[\s\S]*pending_current_grouped_by_owner/
  );
});

