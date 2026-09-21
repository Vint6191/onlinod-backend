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
  assert.match(maintenance, /maintenanceSignal:\s*signal/);
  assert.match(signals, /withSubscriberMaintenanceClaimFence/);
  assert.match(signals, /"claimUntil" > clock_timestamp\(\)/);
  assert.match(signals, /FOR UPDATE/);
  assert.match(maintenance, /if \(!signal && reserved >= limit\) return/);
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
  assert.match(runner, /EXPECTED_PROOF_TEST_COUNT = 44/);
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
  assert.match(runner, /clean-current-subscriber-postflight/);
  assert.match(runner, /rolling-current-subscriber-postflight/);
  assert.match(runner, /seeded-current-subscriber-postflight/);
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

test("A28 postflight validates PostgreSQL index semantics instead of pg_get_indexdef quote formatting", () => {
  const postflight = require("../../scripts/database/phase3-subscriber-publication-schema-online-postflight");

  assert.equal(postflight.canonicalIndexSql('"status"'), "status");
  assert.equal(postflight.canonicalIndexSql("status"), "status");
  assert.equal(postflight.canonicalIndexSql('"publicationStatus"'), "publicationstatus");

  const validRow = (overrides = {}) => ({
    accessMethod: "btree",
    isValid: true,
    isReady: true,
    isUnique: false,
    indexDef: "CREATE INDEX x",
    keyOrders: [],
    predicate: "",
    ...overrides,
  });

  const recovery = postflight.validateIndexRow(
    "SubscriberScanRun_publication_recovery_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanRun_publication_recovery_idx,
    validRow({
      tableName: "SubscriberScanRun",
      indexDef: 'CREATE INDEX "SubscriberScanRun_publication_recovery_idx" ON public."SubscriberScanRun" USING btree (status, "publicationStatus", "updatedAt")',
      keyExpressions: ["status", '"publicationStatus"', '"updatedAt"'],
      keyOrders: ["ASC", "ASC", "ASC"],
    }),
  );
  assert.deepEqual(recovery.problems, []);

  const reconcile = postflight.validateIndexRow(
    "SubscriberScanRun_publication_job_reconcile_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanRun_publication_job_reconcile_idx,
    validRow({
      tableName: "SubscriberScanRun",
      indexDef: 'CREATE INDEX x ON public."SubscriberScanRun" USING btree ("updatedAt", id) WHERE ((status = ANY (ARRAY[\'PUBLISHED\'::text, \'SUPERSEDED\'::text])) AND ("publicationStatus" = \'COMPLETE\'::text) AND ("publicationJobReconciledAt" IS NULL))',
      keyExpressions: ['"updatedAt"', "id"],
      keyOrders: ["ASC", "ASC"],
      predicate: '((status = ANY (ARRAY[\'PUBLISHED\'::text, \'SUPERSEDED\'::text])) AND ("publicationStatus" = \'COMPLETE\'::text) AND ("publicationJobReconciledAt" IS NULL))',
    }),
  );
  assert.deepEqual(reconcile.problems, []);

  const retention = postflight.validateIndexRow(
    "SubscriberScanRun_retention_eligible_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanRun_retention_eligible_idx,
    validRow({
      tableName: "SubscriberScanRun",
      keyExpressions: ['"creatorId"', '"createdAt"', "id"],
      keyOrders: ["ASC", "DESC", "ASC"],
      predicate: '((status = ANY (ARRAY[\'SUPERSEDED\'::text, \'FAILED\'::text])) AND ("publicationStatus" = \'COMPLETE\'::text))',
    }),
  );
  assert.deepEqual(retention.problems, []);

  const expressionIndex = postflight.validateIndexRow(
    "CreatorFanRefreshDemand_recovery_order_idx",
    postflight.REQUIRED_INDEX_SPECS.CreatorFanRefreshDemand_recovery_order_idx,
    validRow({
      tableName: "CreatorFanRefreshDemand",
      keyExpressions: ['"creatorId"', 'COALESCE("nextRetryAt", "lastFailedAt", "updatedAt")', "id"],
      keyOrders: ["ASC", "ASC", "ASC"],
      predicate: '((status = \'FAILED\'::text) AND ("activeRefreshJobId" IS NULL))',
    }),
  );
  assert.deepEqual(expressionIndex.problems, []);

  const wrongOrder = postflight.validateIndexRow(
    "SubscriberScanItem_run_id_cursor_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanItem_run_id_cursor_idx,
    validRow({
      tableName: "SubscriberScanItem",
      keyExpressions: ["id", '"runId"'],
      keyOrders: ["ASC", "ASC"],
    }),
  );
  assert.ok(wrongOrder.problems.length > 0, "ordered index-key mismatch must remain fail-closed");

  const wrongDirection = postflight.validateIndexRow(
    "SubscriberScanRun_retention_eligible_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanRun_retention_eligible_idx,
    validRow({
      tableName: "SubscriberScanRun",
      keyExpressions: ['"creatorId"', '"createdAt"', "id"],
      keyOrders: ["ASC", "ASC", "ASC"],
      predicate: '((status = ANY (ARRAY[\'SUPERSEDED\'::text, \'FAILED\'::text])) AND ("publicationStatus" = \'COMPLETE\'::text))',
    }),
  );
  assert.ok(wrongDirection.problems.some((problem) => problem.includes("order-2")));

  const unexpectedPartial = postflight.validateIndexRow(
    "SubscriberScanItem_run_id_cursor_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanItem_run_id_cursor_idx,
    validRow({
      tableName: "SubscriberScanItem",
      keyExpressions: ['"runId"', "id"],
      keyOrders: ["ASC", "ASC"],
      predicate: '(id IS NOT NULL)',
    }),
  );
  assert.ok(unexpectedPartial.problems.includes("unexpected-predicate"));

  const wrongAccessMethod = postflight.validateIndexRow(
    "SubscriberScanItem_run_id_cursor_idx",
    postflight.REQUIRED_INDEX_SPECS.SubscriberScanItem_run_id_cursor_idx,
    validRow({
      tableName: "SubscriberScanItem",
      accessMethod: "hash",
      keyExpressions: ['"runId"', "id"],
      keyOrders: ["ASC", "ASC"],
    }),
  );
  assert.ok(wrongAccessMethod.problems.some((problem) => problem.includes("access-method")));
});


test("A29 closure repairs scoped constraints, poison recovery, canonical debt and release ordering", () => {
  const migration = source("prisma/migrations/20260921103000_phase3_a29_subscriber_campaign_authority_closure_v1/migration.sql");
  const postflight = source("scripts/database/phase3-subscriber-publication-schema-online-postflight.js");
  const signals = source("src/services/subscriber-directory-maintenance-signal-service.js");
  const maintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const subscriber = source("src/services/subscriber-directory-service.js");
  const campaign = source("src/services/campaign-fan-refresh-queue-service.js");
  const wrapper = source("scripts/audit/phase3-a29-render-gate.js");
  const gate = source("scripts/audit/phase3-a26-changed-js-gate.js");
  const pkg = JSON.parse(source("package.json"));

  assert.match(migration, /ALTER TABLE "SubscriberDirectoryMaintenanceSignal"[\s\S]*SubscriberDirectoryMaintenanceSignal_creator_fkey/);
  assert.match(migration, /VALIDATE CONSTRAINT "SubscriberDirectoryMaintenanceSignal_creator_fkey"/);
  assert.match(migration, /CreatorCampaignFrontierFan_creatorId_campaignId_fkey/);
  assert.match(migration, /CreatorCampaignCollectionState_completion_proof_nonnegative_check/);
  assert.match(migration, /SubscriberDirectoryMaintenanceSignal_poison_idx/);
  assert.match(postflight, /REQUIRED_CONSTRAINT_SPECS/);
  assert.match(postflight, /convalidated/);
  assert.match(postflight, /missingConstraints/);
  assert.match(postflight, /invalidConstraints/);

  assert.match(signals, /listPoisonedSubscriberMaintenanceSignals/);
  assert.match(signals, /requeuePoisonedSubscriberMaintenanceSignal/);
  assert.match(signals, /attempts:\s*\{ gte: SUBSCRIBER_MAINTENANCE_MAX_ATTEMPTS \}/);
  assert.match(maintenance, /errorDetails/);
  assert.match(campaign, /errorDetails/);
  assert.match(campaign, /v\."fetchedAt"/);
  assert.doesNotMatch(campaign, /v\."valueObservedAt"/);
  assert.match(campaign, /if \(!signal && reservedSlots >= max\) return/);
  assert.match(campaign, /SET "dueAt" = \$3, "claimToken" = NULL, "claimUntil" = NULL[\s\S]*"revision" = \$5/);
  assert.doesNotMatch(campaign, /SET "dueAt" = LEAST\("dueAt", \$3\)[\s\S]*"revision" = \$5/);
  assert.match(signals, /typeof db\?\.\$queryRawUnsafe !== "function"\) return \{ requeued: false, reason: "signal_missing" \}/);
  assert.match(subscriber, /subscriberPublicationDebtWhere/);
  assert.match(subscriber, /publicationJobReconciledAt:\s*null/);
  assert.match(subscriber, /GREATEST\("publicationGeneration", \$3\)/);
  assert.match(subscriber, /GREATEST\("publishedGeneration", \$4\)/);

  const changedPos = wrapper.indexOf("CHANGED_GATE");
  const proofPos = wrapper.indexOf("runProof(primaryUrl, disposableUrl)");
  const dropPos = wrapper.indexOf("dropDisposableDatabase(admin, database)");
  const migratePos = wrapper.indexOf('["run", "prisma:migrate"]');
  assert.ok(changedPos >= 0 && proofPos > changedPos && dropPos > proofPos && migratePos > dropPos,
    "A29 release gate must run static -> disposable proof -> cleanup -> primary migrate");
  assert.equal(pkg.scripts["audit:phase3-a29-render"], "node scripts/audit/phase3-a29-render-gate.js");
  assert.equal(pkg.scripts["maintenance:subscriber-signals"], "node scripts/maintenance/phase3-subscriber-maintenance-signals.js");
  assert.match(gate, /phase3-a29-render-gate\.js/);
  assert.match(gate, /campaign-fan-refresh-queue-service\.js/);
});
