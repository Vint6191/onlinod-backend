"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("A32 Subscriber fenced derived planning persists real FanData refresh jobs inside the caller transaction", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const fanData = source("src/services/fan-data-authority-service.js");
  const scheduler = source("src/services/job-scheduler.js");
  assert.doesNotMatch(subscriber, /subscriber_maintenance_fenced_deferred/);
  assert.match(subscriber, /refreshScheduler = typeof scheduleFanRefresh[\s\S]*fencedRefreshScheduler[\s\S]*refreshScheduler\(\{[\s\S]*db,[\s\S]*causalBarrierKey/);
  assert.match(fanData, /scheduleFanDataPointRefresh\(\{ db = null/);
  assert.match(fanData, /ensureSingleJob\(\{[\s\S]*\.\.\.\(db \? \{ db \} : \{\}\)[\s\S]*jobKey: FAN_DATA_POINT_REFRESH_JOB_KEY/);
  assert.match(scheduler, /ensureSingleJob\(\{ db = prisma/);
  assert.match(scheduler, /db\.jobInstance\.findUnique/);
  assert.match(scheduler, /createPlannedJobIfAbsent\(\{[\s\S]*db,/);
});

test("A32 Follow Back / Follow Automation / Bumps cannot report planning convergence when required refresh debt is not durable", () => {
  const followBack = source("src/services/follow-back-service.js");
  const followAutomation = source("src/services/follow-automation-service.js");
  const bumps = source("src/services/bump-service.js");
  for (const text of [followBack, followAutomation, bumps]) {
    assert.match(text, /fanDataPointRefreshDecisionDurable/);
    assert.match(text, /fan_refresh_not_durable/);
  }
  assert.match(followBack, /refreshDebt[\s\S]*ok: !refreshDebt[\s\S]*fan_refresh_debt_not_durable/);
  assert.match(followAutomation, /refreshDebt[\s\S]*ok: !refreshDebt[\s\S]*fan_refresh_debt_not_durable/);
  assert.match(bumps, /refreshDebt[\s\S]*ok: !refreshDebt[\s\S]*fan_refresh_debt_not_durable/);
});

test("A32 physical proof uses a pinned file/test-name manifest and preserves actual totals on red scenarios", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const manifest = JSON.parse(source("scripts/audit/phase3-a32-expected-proof-manifest.json"));
  assert.equal(manifest.version, "A32");
  assert.equal(manifest.testCount, 49);
  assert.equal(manifest.files.length, 12);
  assert.match(runner, /EXPECTED_PROOF_MANIFEST_FILE/);
  assert.match(runner, /manifestSha256/);
  assert.match(runner, /PHASE3_A32_PROOF_MANIFEST_MISMATCH/);
  assert.match(runner, /error\.proof = partialProof/);
  assert.match(runner, /scenarios\[name\] = \{ ok: false, failure, proof: failure\.proof \|\| null \}/);
  assert.match(runner, /expectedProofTestsPerScenario/);
  assert.match(runner, /proofTestsPerScenario: Object\.fromEntries/);
});

test("A32 TAP failure parser emits self-contained error/location/stack instead of nullable diagnostics", () => {
  const { parseTapFailures } = require("../../scripts/audit/phase3-a20-postgres-proof");
  const tap = [
    "TAP version 13",
    "# Subtest: index eligibility",
    "not ok 9 - index eligibility",
    "  ---",
    "  duration_ms: 12.3",
    "  location: '/srv/test.js:55:3'",
    "  failureType: 'testCodeFailure'",
    "  error: `expected planner eligibility but got Seq Scan`",
    "  code: 'ERR_ASSERTION'",
    "  stack: |-",
    "    AssertionError: expected planner eligibility",
    "        at TestContext.<anonymous> (/srv/test.js:55:3)",
    "  ...",
    "1..1",
  ].join("\n");
  const failures = parseTapFailures(tap);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "index eligibility");
  assert.equal(failures[0].code, "ERR_ASSERTION");
  assert.equal(failures[0].error, "expected planner eligibility but got Seq Scan");
  assert.equal(failures[0].location, "/srv/test.js:55:3");
  assert.match(failures[0].stack, /AssertionError/);
});

test("A32 fixture leak authority is schema-derived across tenant roots/FK descendants and break-glass mutation+audit is atomic", () => {
  const leak = source("scripts/audit/phase3-a26-fixture-leak-snapshot.js");
  assert.match(leak, /WITH RECURSIVE tenant_roots/);
  assert.match(leak, /a\.attname IN \('agencyId', 'creatorId'\)/);
  assert.match(leak, /JOIN owned parent ON parent\.oid = fk\.confrelid/);
  assert.match(leak, /child\.relname <> '_prisma_migrations'/);
  assert.match(leak, /row_to_json\(t\)::text/);
  assert.doesNotMatch(leak, /const TABLES = Object\.freeze/);
  const admin = source("src/routes/admin.js");
  const start = admin.indexOf('router.post("/maintenance/subscriber-signals/:id/requeue"');
  const body = admin.slice(start, admin.indexOf("module.exports = router", start));
  assert.match(body, /prisma\.\$transaction\(async \(tx\)/);
  assert.match(body, /requeuePoisonedSubscriberMaintenanceSignal\(\{[\s\S]*db: tx/);
  assert.match(body, /tx\.adminActionLog\.create/);
  assert.doesNotMatch(body, /await adminLog\(req/);
});


test("A32 transient scheduler proof seam reaches real recovery without changing production defaults", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const maintenance = source("src/services/subscriber-directory-maintenance-service.js");
  assert.match(subscriber, /planSubscriberDerivedAutomation\(\{[\s\S]*scheduleFanRefresh = null/);
  assert.match(subscriber, /refreshScheduler = typeof scheduleFanRefresh === "function" \? scheduleFanRefresh : scheduleFanDataPointRefresh/);
  assert.match(subscriber, /recoverSubscriberPublicationDebt\(\{[\s\S]*scheduleFanRefresh = null/);
  assert.match(subscriber, /fencedMaintenance: true,[\s\S]*scheduleFanRefresh,/);
  assert.match(maintenance, /runSubscriberDirectoryMaintenance\(\{[\s\S]*scheduleFanRefresh = null/);
  assert.match(maintenance, /maintenanceSignal: signal,[\s\S]*scheduleFanRefresh,/);
});

test("A32 physical expectations follow canonical work status and prove index path eligibility without requiring a specific cost-planner winner", () => {
  const proof = source("src/services/phase3-analytics-final-authority-cutover.integration.test.js");
  assert.match(proof, /assert\.equal\(afterWork\?\.status, "SUCCEEDED"\)/);
  assert.match(proof, /assertIndexReady/);
  assert.match(proof, /assertAnyIndexEligible/);
  assert.match(proof, /Index \(\?:Only \)\?Scan\|Bitmap Index Scan/);
  assert.doesNotMatch(proof, /published-generation index not planner-eligible/);
});
