"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260910211500_phase2_actual53_final_closure/migration.sql"), "utf8");

function section(start, end) {
  const a = migration.indexOf(start);
  const b = migration.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `migration section ${start}..${end} must exist`);
  return migration.slice(a, b);
}

test("F53-09 live PPV projection classifies the whole canonical peer set instead of promoting one row", () => {
  const ppv = section("CREATE OR REPLACE FUNCTION onlinod_project_team_ppv_fact_v2()", "CREATE OR REPLACE FUNCTION onlinod_project_team_tip_fact_v2()");
  assert.match(ppv, /PEER_SET_RECLASSIFICATION_PENDING/);
  assert.match(ppv, /phase2_reclassify_team_money_peer_set\"\(NEW\.\"agencyId\", 'PPV', business_key\)/);
  assert.match(ppv, /previous_business_key IS DISTINCT FROM business_key/);
  assert.match(ppv, /phase2_reclassify_team_money_peer_set\"\(NEW\.\"agencyId\", 'PPV', previous_business_key\)/);
});

test("F53-09 peer-set classifier cannot call a multi-peer business identity CANONICAL", () => {
  const classifier = section('CREATE OR REPLACE FUNCTION "phase2_reclassify_team_money_peer_set"', "CREATE OR REPLACE FUNCTION onlinod_project_team_ppv_fact_v2()");
  assert.match(classifier, /LIMIT 2/);
  assert.match(classifier, /IF peer_count = 1 THEN[\s\S]*next_state := 'CANONICAL'/);
  assert.match(classifier, /ELSIF peer_count > 1 THEN[\s\S]*next_state := 'AMBIGUOUS'/);
  assert.match(classifier, /UPDATE "TeamMoneyAttributionFact"[\s\S]*"canonicalBusinessKey" = p_business_key/);
});
