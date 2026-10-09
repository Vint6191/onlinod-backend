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
  const lane = require('./maintenance-lane-registry').MAINTENANCE_LANES.find(lane => lane.name === 'subscriberDirectoryMaintenance');
  assert.equal(lane.module, './subscriber-directory-maintenance-service'); assert.equal(lane.method, 'runSubscriberDirectoryMaintenance');
  assert.match(scheduler, /resolveMaintenanceLanes/);
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






