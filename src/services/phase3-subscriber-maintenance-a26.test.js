"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("A26 Subscriber maintenance uses a durable creator-scoped oldest-due SKIP LOCKED authority", () => {
  const signals = source("src/services/subscriber-directory-maintenance-signal-service.js");
  const maintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const subscriber = source("src/services/subscriber-directory-service.js");
  const scheduler = source("src/services/job-scheduler.js");

  assert.match(signals, /SubscriberDirectoryMaintenanceSignal/);
  assert.match(signals, /FOR UPDATE OF s SKIP LOCKED/);
  assert.match(signals, /ORDER BY s\."dueAt" ASC, s\."creatorId" ASC, s\."kind" ASC/);
  assert.match(signals, /"revision"="SubscriberDirectoryMaintenanceSignal"\."revision"\+1/);
  assert.match(signals, /"attempts"=0/);
  assert.match(signals, /WHERE "id"=\$1 AND "claimToken"=\$2 AND "revision"=\$5/);
  assert.match(signals, /SET "dueAt"=\$3, "claimToken"=NULL/);
  assert.doesNotMatch(signals, /SET "dueAt"=LEAST\("dueAt",\$3\)/);
  assert.match(signals, /dueAt = null/);
  assert.match(signals, /authorityNow = await dbAuthorityNow/);
  assert.match(signals, /dueAt == null \? authorityNow/);

  assert.match(subscriber, /SUBSCRIBER_RECOVERY_CREATOR_SCOPE_REQUIRED/);
  assert.match(subscriber, /findSubscriberPublicationDebtForCreator/);
  assert.match(maintenance, /claimSubscriberDirectoryMaintenanceSignal/);
  assert.match(maintenance, /beforePlanning = \(\) => subscriberMaintenanceClaimCurrent/);
  assert.match(scheduler, /subscriberDirectoryMaintenance[\s\S]*runSubscriberDirectoryMaintenance/);
  assert.doesNotMatch(scheduler, /subscriberPublicationRecovery[\s\S]*recoverSubscriberPublicationDebt/);
});

test("A26 retention cannot delete unfinished publication debt and is no longer fire-and-forget", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const maintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const resultService = source("src/services/job-result-service.js");

  const cleanupStart = subscriber.indexOf("async function cleanupSubscriberScanHistory");
  const cleanupEnd = subscriber.indexOf("async function getSubscriberDirectoryStatus", cleanupStart);
  const cleanup = subscriber.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /subscriberPublicationDebtWhere/);
  assert.match(cleanup, /blockedByPublicationDebt/);
  assert.match(cleanup, /publicationStatus:\s*"COMPLETE"/);
  assert.match(cleanup, /maxRuns/);
  assert.match(maintenance, /RETENTION_BLOCKED_BY_PUBLICATION_DEBT/);
  assert.match(maintenance, /signalSubscriberDirectoryMaintenance[\s\S]*RECOVERY/);
  assert.doesNotMatch(resultService, /cleanupSubscriberScanHistory/);
});

test("A26 migration and postflight prove maintenance queue, state repair and real index shape", () => {
  const migration = source("prisma/migrations/20260921030000_phase3_a26_subscriber_maintenance_authority_v1/migration.sql");
  const postflight = source("scripts/database/phase3-subscriber-publication-schema-online-postflight.js");
  assert.match(migration, /SubscriberDirectoryMaintenanceSignal_due_claim_idx/);
  assert.match(migration, /SubscriberScanRun_retention_eligible_idx/);
  assert.match(migration, /SubscriberScanRun_creator_reconcile_idx/);
  assert.match(migration, /A26_BACKFILL_PUBLICATION_DEBT/);
  assert.match(postflight, /indisvalid/);
  assert.match(postflight, /indisready/);
  assert.match(postflight, /pg_get_indexdef/);
  assert.match(postflight, /pg_get_expr/);
  assert.match(postflight, /missingStateCount/);
  assert.match(postflight, /stateBehindCount/);
  assert.match(postflight, /missingRecoverySignalCount/);
  assert.match(postflight, /SubscriberDirectoryMaintenanceSignal_due_claim_idx/);
  assert.match(postflight, /EXPLAIN \(COSTS OFF, FORMAT JSON\)/);
});

test("A26 physical closure is hermetic, exhaustive and separated from production deploy", () => {
  const runner = source("scripts/audit/phase3-a20-postgres-proof.js");
  const pkg = JSON.parse(source("package.json"));
  assert.match(runner, /EXPECTED_PROOF_TEST_COUNT = 42/);
  assert.match(runner, /requires a disposable physical PostgreSQL database and has no production opt-in bypass/);
  assert.doesNotMatch(runner, /ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE/);
  assert.match(runner, /search_path=\$\{safeSchema\},pg_catalog/);
  assert.doesNotMatch(runner, /search_path=\$\{safeSchema\},pg_catalog,public/);
  assert.match(runner, /A26_FIXTURE_LEAK_SNAPSHOT/);
  const leakSnapshot = source("scripts/audit/phase3-a26-fixture-leak-snapshot.js");
  assert.match(leakSnapshot, /identityDigest/);
  assert.match(runner, /beforeIdentityDigest/);
  assert.match(runner, /phase3-a26-failure-manifest\.json/);
  assert.match(runner, /scenario\("clean-current"/);
  assert.match(runner, /scenario\("rolling-a13-to-current"/);
  assert.match(runner, /scenario\("seeded-pre-a20-2-to-current"/);
  assert.equal(pkg.scripts["audit:phase3-a26-postgres"], "node scripts/audit/phase3-a20-postgres-proof.js");
  assert.doesNotMatch(pkg.scripts["prisma:migrate"], /audit:phase3-a(?:20|26)-postgres/);
});

test("A26 changed-JS gate makes syntax/no-undef a release requirement for the cut", () => {
  const gate = source("scripts/audit/phase3-a26-changed-js-gate.js");
  const pkg = JSON.parse(source("package.json"));
  assert.match(gate, /new Linter/);
  assert.doesNotMatch(gate, /require\(["']globals["']\)/);
  assert.match(gate, /"no-undef": "error"/);
  assert.match(gate, /phase3-analytics-final-authority-cutover\.integration\.test\.js/);
  assert.match(gate, /subscriber-directory-maintenance-service\.js/);
  assert.equal(pkg.scripts["audit:phase3-a26-changed-js"], "node scripts/audit/phase3-a26-changed-js-gate.js");
});

test("A27 Render wrapper self-provisions and destroys a disposable database for one-command free-tier proof", () => {
  const wrapper = source("scripts/audit/phase3-a26-render-disposable.js");
  const pkg = JSON.parse(source("package.json"));

  assert.match(wrapper, /CREATE DATABASE/);
  assert.match(wrapper, /DROP DATABASE/);
  assert.match(wrapper, /WITH \(FORCE\)/);
  assert.match(wrapper, /ONLINOD_AUDIT_DATABASE_URL:\s*disposableUrl/);
  assert.match(wrapper, /DATABASE_URL:\s*primaryUrl/);
  assert.match(wrapper, /PHASE3_A26_DISPOSABLE_DATABASE_CREATE_UNSUPPORTED/);
  assert.match(wrapper, /PHASE3_A26_DISPOSABLE_DATABASE_CLEANUP_FAIL/);
  assert.match(wrapper, /stale-active-skip/);
  assert.match(wrapper, /stale-dropped/);
  assert.match(wrapper, /FROM pg_database/);
  assert.match(wrapper, /PHASE3_A26_RENDER_DISPOSABLE_RESULT/);
  assert.doesNotMatch(wrapper, /ONLINOD_AUDIT_ALLOW_PRIMARY_DATABASE:\s*["']1["']/);
  assert.match(wrapper, /-pooler/);
  assert.match(wrapper, /u\.searchParams\.delete\("schema"\)/);
  assert.match(wrapper, /u\.searchParams\.delete\("options"\)/);
  assert.equal(pkg.scripts["audit:phase3-a26-render"], "node scripts/audit/phase3-a26-render-disposable.js");
});
