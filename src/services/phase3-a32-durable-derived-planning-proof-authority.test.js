"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("A32 Subscriber derived work uses the durable outbox and existing FanData scheduling authority", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const fanData = source("src/services/fan-data-authority-service.js");
  const scheduler = source("src/services/job-scheduler.js");
  assert.doesNotMatch(subscriber, /subscriber_maintenance_fenced_deferred/);
  assert.match(subscriber, /ensureSubscriberDerivedPlanningWake/);
  assert.match(subscriber, /SUBSCRIBER_MAINTENANCE_KIND\.DERIVED_PLANNING/);
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
    assert.match(text, /scheduleDurableFanDataRefreshDebt/);
  }
  const fanData = source("src/services/fan-data-authority-service.js");
  assert.match(fanData, /fanDataPointRefreshDecisionDurable/);
  assert.match(fanData, /fan_refresh_not_durable/);
  assert.match(followBack, /refreshDebt[\s\S]*ok: !refreshDebt[\s\S]*fan_refresh_debt_not_durable/);
  assert.match(followAutomation, /refreshDebt[\s\S]*ok: !refreshDebt[\s\S]*fan_refresh_debt_not_durable/);
  assert.match(bumps, /refreshDebt[\s\S]*ok: !refreshDebt[\s\S]*fan_refresh_debt_not_durable/);
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
  assert.match(body, /operationHandler\("maintenance\.subscriber\.requeue"\)/);
  const operation = source('src/services/admin-operational-command-service.js');
  assert.match(operation, /executeAdminCommand/);
  assert.match(operation, /requeuePoisonedSubscriberMaintenanceSignal\(\{db:tx/);
  assert.match(source('src/services/admin-commit-authority-service.js'), /tx\.adminCommandAudit\.create/);
  assert.doesNotMatch(body, /await adminLog\(req/);
});


test("A32 real SQL proof exercises restart, enabled automation and stale outbox rollback", () => {
  const proof = source("scripts/audit/current-subscriber-recovery-liveness-proof.cjs");
  assert.match(proof, /createScaleSqlRuntime/);
  assert.match(proof, /runRecurringCreatorWork/);
  assert.match(proof, /SUBSCRIBER_MAINTENANCE_CLAIM_STALE/);
  assert.match(proof, /lastSubscriberDerivedGeneration/);
  assert.match(proof, /deliveries > 0/);
});

test("A32 physical expectations follow canonical work status and prove index path eligibility without requiring a specific cost-planner winner", () => {
  const proof = source("src/services/phase3-analytics-final-authority-cutover.integration.test.js");
  assert.match(proof, /assert\.equal\(afterWork\?\.status, "SUCCEEDED"\)/);
  assert.match(proof, /assertIndexReady/);
  assert.match(proof, /assertAnyIndexEligible/);
  assert.match(proof, /Index \(\?:Only \)\?Scan\|Bitmap Index Scan/);
  assert.doesNotMatch(proof, /published-generation index not planner-eligible/);
});


test("A32 INT2 Subscriber recovery uses one NULL/expired/future lease authority for decision and fenced CAS", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  assert.match(subscriber, /function subscriberPublicationJobLeaseAuthority/);
  assert.match(subscriber, /active = status === "CLAIMED" && Boolean\(leaseUntil && leaseUntil > now\)/);
  assert.match(subscriber, /casWhere: status === "CLAIMED"[\s\S]*leaseUntil: null[\s\S]*leaseUntil: \{ lte: now \}/);
  assert.match(subscriber, /const leaseAuthority = subscriberPublicationJobLeaseAuthority\(currentJob, now\)/);
  assert.match(subscriber, /\.\.\.leaseAuthority\.casWhere/);
  assert.match(subscriber, /if \(leaseAuthority\.active\)/);
});

test("A32 INT2 FanData refresh identity owns consumer and required field set instead of first-consumer-wins coalescing", () => {
  const fanData = source("src/services/fan-data-authority-service.js");
  assert.match(fanData, /consumerIdentity = text\(params\?\.consumer/);
  assert.match(fanData, /refreshFieldSet = \[\.\.\.new Set/);
  assert.match(fanData, /let rangeKey = causalBarrierHash \? `fan-data:\$\{fanSetHash\}:\$\{causalBarrierHash\}` : `fan-data:\$\{fanSetHash\}`/);
  assert.match(fanData, /rangeKey \+= `:consumer:\$\{consumerHash\}`/);
  assert.match(fanData, /rangeKey \+= `:fields:\$\{refreshFieldHash\}`/);
  assert.match(fanData, /stableParams\.refreshFields = refreshFieldSet/);
});


