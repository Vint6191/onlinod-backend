"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("A31 Subscriber durable mutation lock order fences repair/publication before any maintenance mutation", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const maintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const signals = source("src/services/subscriber-directory-maintenance-signal-service.js");
  const start = subscriber.indexOf("async function publicationTransaction");
  const end = subscriber.indexOf("async function projectHiddenOnlineChunk", start);
  const body = subscriber.slice(start, end);
  const agency = body.indexOf("lockAutomationWriteCommitFence");
  const creator = body.indexOf("lockSubscriberPublicationCreator");
  const signal = body.indexOf("lockSubscriberMaintenanceClaimRow");
  assert.ok(start >= 0 && agency > 0 && creator > agency && signal > creator,
    "canonical lock order must be automation agency -> subscriber creator -> maintenance signal row");
  assert.match(subscriber, /repairSubscriberDirectoryStateGeneration[\s\S]*maintenanceSignal/);
  assert.match(subscriber, /advanceSubscriberPublication[\s\S]*maintenanceSignal/);
  assert.doesNotMatch(maintenance, /withSubscriberMaintenanceClaimFence/,
    "maintenance worker must not lock the signal row before creator publication authority");
  assert.match(signals, /"claimUntil" > clock_timestamp\(\)[\s\S]*FOR UPDATE/);
});

test("A31 recovered automation planning remains durable debt and Bumps cannot escape the fenced transaction", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const bumps = source("src/services/bump-service.js");
  assert.match(subscriber, /subscriberDerivedPlanningConverged/);
  assert.match(subscriber, /reason: "planning_failed", durableRetryRequired: true/);
  assert.match(subscriber, /fencedMaintenance[\s\S]*scheduleFanRefresh: fencedRefreshScheduler/);
  assert.match(bumps, /scheduleFanRefresh = scheduleFanDataPointRefresh/);
  assert.match(bumps, /planBumps\([\s\S]*scheduleFanRefresh/);
  assert.match(subscriber, /DERIVED_AUTOMATION_PLANNING_FAILED/);
  assert.match(subscriber, /publicationJobReconciledAt:\s*null/);
});

test("A31 generation repair and completion work are bounded instead of O(all history) / 100000 phase loops", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const migration = source("prisma/migrations/20260921130000_phase3_a31_subscriber_lease_scale_authority_v1/migration.sql");
  const finalPg = source("src/services/phase3-analytics-final-authority-cutover.integration.test.js");
  const repairStart = subscriber.indexOf("async function repairSubscriberDirectoryStateGeneration");
  const repairEnd = subscriber.indexOf("async function findSubscriberPublicationDebtForCreator", repairStart);
  const repair = subscriber.slice(repairStart, repairEnd);
  assert.doesNotMatch(repair, /SELECT\s+MAX\s*\(/i);
  assert.match(repair, /ORDER BY r\."publicationGeneration" DESC, r\."id" DESC[\s\S]*LIMIT 1/);
  assert.match(migration, /SubscriberScanRun_creator_published_generation_idx/);
  assert.match(subscriber, /maxSteps = 8/);
  assert.match(subscriber, /Math\.min\(32/);
  assert.doesNotMatch(subscriber, /100000/);
  assert.match(finalPg, /generationRepairMs/);
  assert.match(finalPg, /SubscriberScanRun_creator_published_generation_idx/);
  assert.match(finalPg, /expired real Subscriber recovery cannot mutate generation, run, projections, or jobs/);
});

test("A31/A32 fixture/proof authority owns full identity lifecycle, structured TAP failures and pinned manifest coverage", () => {
  const fixture = source("scripts/audit/phase3-postgres-proof-fixture-authority.js");
  const leak = source("scripts/audit/phase3-a26-fixture-leak-snapshot.js");
  const a2012 = source("src/services/phase3-campaign-closure-a20-12.integration.test.js");
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  assert.match(fixture, /cleanupPhase3PostgresFixtureGraph/);
  assert.match(fixture, /creatorAccount\.deleteMany[\s\S]*agency\.deleteMany[\s\S]*user\.deleteMany/);
  assert.match(a2012, /cleanupPhase3PostgresFixtureGraph/);
  assert.doesNotMatch(a2012, /db\.user\.deleteMany/);
  assert.match(leak, /tenant_roots/);
  assert.match(leak, /c\.relname IN \('User', 'WorkerDevice', 'Agency', 'CreatorAccount'\)/);
  assert.match(leak, /JOIN owned parent ON parent\.oid = fk\.confrelid/);
  assert.doesNotMatch(leak, /const TABLES = Object\.freeze/);
  assert.match(runner, /parseTapFailures/);
  assert.match(runner, /PHASE3_A31_TAP_FAILURE/);
  assert.match(runner, /testNames/);
  assert.match(runner, /EXPECTED_PROOF_MANIFEST_FILE/);
  assert.match(runner, /PHASE3_A32_PROOF_MANIFEST_MISMATCH/);
  assert.doesNotMatch(runner, /EXPECTED_PROOF_TEST_COUNT/);
});

test("A31 maintenance failures/poison debt are visible and recoverable without Render shell", () => {
  const subscriberMaintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const campaign = source("src/services/campaign-fan-refresh-queue-service.js");
  const scheduler = source("src/services/job-scheduler.js");
  const admin = source("src/routes/admin.js");
  assert.match(subscriberMaintenance, /poisonedSignals/);
  assert.match(subscriberMaintenance, /poisonedSample/);
  assert.match(subscriberMaintenance, /ok: totals\.errors === 0 && poisonedSignals === 0/);
  assert.match(campaign, /ok: totals\.errors === 0/);
  assert.match(scheduler, /Phase2 maintenance degraded/);
  assert.match(scheduler, /poisonedSignals/);
  assert.match(admin, /maintenance\/subscriber-signals/);
  assert.match(admin, /maintenance\/subscriber-signals\/:id\/requeue/);
  assert.match(admin, /ensureSuperAdmin/);
  assert.match(admin, /admin\.subscriber_maintenance_signal_requeued/);
});

test("A31 disposable cleanup cannot reap a parallel live proof during zero-connection gaps", () => {
  const disposable = source("scripts/audit/phase3-a26-render-disposable.js");
  assert.match(disposable, /STALE_DISPOSABLE_MIN_AGE_MS = 6 \* 60 \* 60 \* 1000/);
  assert.match(disposable, /disposableDatabaseCreatedAt/);
  assert.match(disposable, /stale-too-young-skip/);
  assert.match(disposable, /ageMs < staleAgeMs/);
  assert.match(disposable, /activeSessions > 0/);
});

test("A31 pre-migrate repair normalizes A26 signal drift before A29 constraints validate", () => {
  const preflight = source("scripts/database/phase3-a29-maintenance-check-online-preflight.js");
  const pkg = JSON.parse(source("package.json"));
  assert.match(preflight, /to_regclass/);
  assert.match(preflight, /ELSE 'RECOVERY'/);
  assert.match(preflight, /GREATEST\(COALESCE\("revision", 0\), 1\)/);
  assert.match(preflight, /GREATEST\(COALESCE\("attempts", 0\), 0\)/);
  const command = String(pkg.scripts["prisma:migrate"] || "");
  const preflightPos = command.indexOf("phase3-a29-maintenance-check-online-preflight.js");
  const deployPos = command.indexOf("prisma migrate deploy");
  assert.ok(preflightPos >= 0 && deployPos > preflightPos, "signal drift repair must run before migrate deploy");
});

test("A31 Render changed-JS gate covers the new authority surface before disposable proof", () => {
  const gate = source("scripts/audit/phase3-a26-changed-js-gate.js");
  for (const file of [
    "scripts/audit/phase3-postgres-identifier-lint.js",
    "scripts/database/phase3-a29-maintenance-check-online-preflight.js",
    "src/routes/admin.js",
    "src/services/bump-service.js",
    "src/services/phase3-a31-physical-proof-subscriber-lease-authority.test.js",
  ]) assert.match(gate, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("A31 identifier lint owns the entire migration history and forbids new oversized PostgreSQL names", () => {
  const lint = source("scripts/audit/phase3-postgres-identifier-lint.js");
  const gate = source("scripts/audit/phase3-a29-render-gate.js");
  const migration = source("prisma/migrations/20260921130000_phase3_a31_subscriber_lease_scale_authority_v1/migration.sql");
  assert.match(lint, /POSTGRES_IDENTIFIER_MAX_BYTES = 63/);
  assert.match(lint, /historicalOversized/);
  assert.match(lint, /newOversized/);
  assert.match(lint, /collisions/);
  assert.match(gate, /phase3-postgres-identifier-lint\.js/);
  assert.match(gate, /identifier-lint-pass/);
  assert.match(migration, /CampaignFrontierFan_campaign_kind_user_uq/);
  assert.match(migration, /CampaignFrontierFan_creator_campaign_kind_idx/);
});
