"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const preflight = require("../../scripts/database/phase3-campaign-coverage-generation-online-preflight");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function occurrences(text, pattern) { return [...String(text).matchAll(pattern)].length; }

test("final cut has one canonical CreatorFanValueCurrent SQL writer and Subscriber Directory commits through commitFanFacts", () => {
  const authority = source("src/services/fan-data-authority-service.js");
  const subscriber = source("src/services/subscriber-directory-service.js");
  assert.equal(occurrences(authority, /INSERT INTO "CreatorFanValueCurrent"/g), 1, "canonical value table must have one physical SQL writer");
  assert.match(authority, /async function commitFanFacts/);
  assert.match(authority, /projectSubscriberDirectoryItems[\s\S]*return commitFanFacts\(db,/);
  assert.match(subscriber, /projectSubscriberDirectoryItems\(db,/);
  assert.doesNotMatch(subscriber, /projectSubscriberDirectoryRun\(/);
  assert.match(subscriber, /fanProjectionCursorOffset/);
  assert.match(subscriber, /SUBSCRIBER_FAN_FACTS_PROJECTION_INCOMPLETE/);
  assert.match(subscriber, /readyToPublish:\s*true/);
  assert.match(subscriber, /applySubscriberScanCompletion[\s\S]*publishRun\(db, run/);
});

test("final cut canonical Subscriber page projection is bounded and publication is separated from the Campaign-lock transaction", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  assert.match(subscriber, /MAX_PAGE_ITEMS\s*=\s*100/);
  assert.match(subscriber, /SUBSCRIBER_SCAN_PAGE_TOO_LARGE/);
  assert.match(subscriber, /projectSubscriberDirectoryItems[\s\S]*fanProjectionCount:\s*\{ increment: items\.length \}/);
  const chunk = subscriber.slice(subscriber.indexOf("async function applySubscriberScanChunk"), subscriber.indexOf("async function applySubscriberScanCompletion"));
  assert.doesNotMatch(chunk, /publishRun\(db, updatedRun/);
  assert.match(chunk, /readyToPublish:\s*true/);
});

test("final cut recovery is creator-scoped durable signal work, not worker-triggered global scans", () => {
  const queue = source("src/services/campaign-fan-refresh-queue-service.js");
  const leases = source("src/services/job-lease-service.js");
  const scheduler = source("src/services/job-scheduler.js");
  const locks = source("src/services/campaign-transaction-lock-service.js");
  assert.doesNotMatch(leases, /promoteQueuedCampaignFanRefreshDemands/);
  assert.match(scheduler, /campaignFanRefreshPromotion[\s\S]*runCampaignFanRefreshPromotionMaintenance/);
  assert.match(queue, /claimCampaignFanRefreshPromotionSignal[\s\S]*FOR UPDATE OF s SKIP LOCKED[\s\S]*LIMIT 1/);
  assert.match(queue, /claimToken[\s\S]*claimUntil/);
  assert.match(queue, /runCampaignFanRefreshPromotionMaintenance[\s\S]*acquireCampaignTransactionLock\(tx, creatorId\)/);
  assert.doesNotMatch(queue, /SELECT DISTINCT d\."creatorId"|ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY\s+.*creatorId/i);
  assert.doesNotMatch(locks, /acquireCampaignTransactionLocks/);
  assert.match(queue, /repairFailedCampaignFanRefreshDemands[\s\S]*signalCampaignFanRefreshPromotion/);
  assert.doesNotMatch(queue.slice(queue.indexOf("async function repairFailedCampaignFanRefreshDemands"), queue.indexOf("function supportsSetBasedCampaignFanRefreshQueue")), /promoteQueuedCampaignFanRefreshDemands/);
});

test("final cut durable promotion claim never holds signal row while waiting for Campaign creator authority", () => {
  const queue = source("src/services/campaign-fan-refresh-queue-service.js");
  const claim = queue.slice(queue.indexOf("async function claimCampaignFanRefreshPromotionSignal"), queue.indexOf("async function releaseCampaignFanRefreshPromotionClaim"));
  const maintenance = queue.slice(queue.indexOf("async function runCampaignFanRefreshPromotionMaintenance"), queue.indexOf("function supportsSetBasedCampaignFanRefreshTerminal"));
  assert.match(claim, /FOR UPDATE OF s SKIP LOCKED/);
  assert.match(claim, /UPDATE "CampaignFanRefreshPromotionSignal"/);
  assert.match(maintenance, /claimCampaignFanRefreshPromotionSignal\(\{ db: root/);
  assert.match(maintenance, /root\.\$transaction[\s\S]*acquireCampaignTransactionLock\(tx, creatorId\)[\s\S]*campaignFanRefreshPromotionSignal\.findFirst/);
});

test("Billing and legacy Analytics have no active snapshot generation reader/writer while Phase A preserves old writable tables", () => {
  const billing = source("src/services/billing-wallet-service.js");
  const settings = source("src/services/settings-service.js");
  const analyticsRoute = source("src/routes/analytics.js");
  const analyticsService = source("src/services/analytics-snapshot-service.js");
  const schema = source("prisma/schema.prisma");
  const migration = source("prisma/migrations/20260920123000_phase3_analytics_final_authority_cutover_v1/migration.sql");
  const a21Migration = source("prisma/migrations/20260920223000_phase3_analytics_a21_publication_generation_cursor_scale_v1/migration.sql");
  const policy = source("docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md");
  const legacyPreflight = source("scripts/database/phase3-analytics-legacy-snapshot-online-preflight.js");
  const legacyPostflight = source("scripts/database/phase3-analytics-legacy-snapshot-online-postflight.js");
  const repairMigration = source("prisma/migrations/20260920191500_phase3_analytics_legacy_snapshot_phase_a_repair_v1/migration.sql");
  const packageJson = source("package.json");
  assert.doesNotMatch(billing, /creatorEarningsSnapshot\./);
  assert.match(billing, /source:\s*"UNAVAILABLE"/);
  assert.match(settings, /readRolling30dRevenueBatch/);
  assert.doesNotMatch(settings, /creatorEarningsSnapshot|CreatorEarningsSnapshot/);
  assert.doesNotMatch(analyticsRoute, /analytics-snapshot-service|reportAnalyticsSnapshots|getLatestPayload/);
  assert.doesNotMatch(analyticsService, /prisma|analyticsSnapshot\./);
  assert.doesNotMatch(schema, /model\s+(?:CreatorEarningsSnapshot|CreatorCampaignsSnapshot|AnalyticsSnapshot)\b/);
  assert.doesNotMatch(migration, /DROP TABLE IF EXISTS "(?:AnalyticsSnapshot|CreatorCampaignsSnapshot|CreatorEarningsSnapshot)"/);
  assert.doesNotMatch(migration, /CREATE VIEW "(?:AnalyticsSnapshot|CreatorCampaignsSnapshot|CreatorEarningsSnapshot)"/);
  assert.match(migration, /Phase A only[\s\S]*physical legacy tables are preserved/);
  assert.match(policy, /Production repair bridge[\s\S]*repairRequired[\s\S]*postflight[\s\S]*Phase B: destructive purge/);
  assert.match(legacyPreflight, /known_zero_row_legacy_tombstone_view/);
  assert.match(legacyPreflight, /legacyTombstoneView[\s\S]*repairRequired[\s\S]*phaseASafe/);
  assert.match(legacyPreflight, /destructivePurgeAllowed:\s*false/);
  assert.match(repairMigration, /DROP VIEW "AnalyticsSnapshot"/);
  assert.match(repairMigration, /CREATE TABLE IF NOT EXISTS "AnalyticsSnapshot"/);
  assert.match(repairMigration, /CREATE TABLE IF NOT EXISTS "CreatorCampaignsSnapshot"/);
  assert.match(repairMigration, /CREATE TABLE IF NOT EXISTS "CreatorEarningsSnapshot"/);
  assert.match(repairMigration, /Refusing to replace unexpected AnalyticsSnapshot view/);
  assert.match(legacyPostflight, /PHASE_A_POST_MIGRATION_WRITABLE_COMPATIBILITY/);
  assert.match(legacyPostflight, /requiredIndexesPresent/);
  assert.match(packageJson, /phase3-analytics-legacy-snapshot-online-preflight\.js[\s\S]*prisma migrate deploy[\s\S]*phase3-analytics-legacy-snapshot-online-postflight\.js/);
});

test("Subscriber source state machine is exact-offset, payload-bound, CAS fenced and server-derived", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const chunk = subscriber.slice(subscriber.indexOf("async function applySubscriberScanChunk"), subscriber.indexOf("async function applySubscriberScanCompletion"));
  assert.match(chunk, /SELECT \* FROM "SubscriberScanRun" WHERE "id" = \$1 FOR UPDATE/);
  assert.match(chunk, /SUBSCRIBER_SCAN_OFFSET_INVALID/);
  assert.match(chunk, /offset !== expectedOffset[\s\S]*SUBSCRIBER_SCAN_REWIND[\s\S]*SUBSCRIBER_SCAN_GAP/);
  assert.match(chunk, /serverDerivedNextOffset = offset \+ itemsInput\.length/);
  assert.match(chunk, /SUBSCRIBER_SCAN_NEXT_OFFSET_MISMATCH/);
  assert.match(chunk, /providerPayloadHash = hashJson\(itemsInput\)/);
  assert.match(chunk, /SUBSCRIBER_SCAN_REPLAY_CONFLICT/);
  assert.match(chunk, /SUBSCRIBER_SCAN_STALLED_CURSOR/);
  assert.match(chunk, /SUBSCRIBER_SCAN_DUPLICATE_FAN_ACROSS_PAGES/);
  assert.match(chunk, /updateMany\([\s\S]*nextOffset: offset[\s\S]*SUBSCRIBER_SCAN_CURSOR_CONFLICT/);
  assert.doesNotMatch(chunk, /\.slice\(0,\s*100\)/);
});

test("Subscriber non-value outcomes cannot mutate canonical FanValue or satisfy Campaign demand", () => {
  const authority = source("src/services/fan-data-authority-service.js");
  const observer = authority.slice(authority.indexOf("function subscriberDirectoryObservationFromItem"), authority.indexOf("async function projectSubscriberDirectoryItems"));
  const commit = authority.slice(authority.indexOf("async function commitFanFacts"), authority.indexOf("async function projectFanObservationBatch"));
  assert.match(observer, /valueAvailability === VALUE_AVAILABILITY\.AVAILABLE && item\?\.totalSpentCents != null/);
  assert.match(observer, /const value = subscriberValueAvailable \?[\s\S]*:\s*null/);
  assert.match(commit, /const valueFanIds = rows\.filter\(\(row\) => row\.value\)/);
  assert.match(authority, /projectSubscriberDirectoryItems[\s\S]*dbAuthorityNow/);
});

test("scalar Campaign compatibility contract uses the same commitFanFacts writer and no public scalar value escape remains", () => {
  const ledger = source("src/services/creator-analytics-ledger-service.js");
  const authority = source("src/services/fan-data-authority-service.js");
  const scalar = ledger.slice(ledger.indexOf("async function ingestCampaignFanValueChunk"), ledger.indexOf("async function ingestCampaignFanValuesBatchChunk"));
  assert.match(scalar, /upsertCampaignFanValueTx/);
  assert.match(ledger, /async function upsertCampaignFanValueTx[\s\S]*projectFanObservationBatch\(tx,/);
  assert.doesNotMatch(ledger, /projectCampaignFanValueCurrent/);
  assert.doesNotMatch(ledger, /projectFanValue\(/);
  assert.match(authority, /async function projectFanObservationBatch[\s\S]*return commitFanFacts\(db, options\)/);
  const exportsBlock = authority.slice(authority.lastIndexOf("module.exports ="));
  assert.doesNotMatch(exportsBlock, /\n\s*projectFanValue,/, "scalar value projector must not be a top-level production export");
  assert.match(exportsBlock, /_test:\s*Object\.freeze\(\{ projectFanValue \}\)/, "legacy scalar semantics stay reachable only through explicit test hooks");
});

test("Subscriber publication is restartable bounded work outside generic completion/failure transactions", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const leases = source("src/services/job-lease-service.js");
  const scheduler = source("src/services/job-scheduler.js");
  const schema = source("prisma/schema.prisma");
  assert.match(subscriber, /PUBLICATION_BATCH_SIZE\s*=\s*500/);
  assert.match(subscriber, /publicationStatus[\s\S]*PENDING[\s\S]*CURRENT[\s\S]*PREVIOUS[\s\S]*FINALIZE[\s\S]*COMPLETE/);
  assert.match(subscriber, /publicationCursorId/);
  assert.match(subscriber, /publicationTransaction\(db/);
  assert.match(subscriber, /publicationTopology:\s*"durable_chunked_generation_v2"/);
  assert.match(schema, /publicationStatus\s+String\s+@default\("PENDING"\)/);
  assert.match(schema, /publicationCursorId\s+String\?/);
  const subscriberCompletion = leases.slice(leases.indexOf('if (job.jobKey === "subscriber_directory_scan")'), leases.indexOf('if (["fetch_earnings"'));
  assert.match(subscriberCompletion, /JOB_CHUNK_TRANSACTION_OPTIONS/);
  assert.match(subscriberCompletion, /applyJobResult\(\{ db: prisma/);
  assert.doesNotMatch(subscriberCompletion, /applyJobResult\(\{ db: tx/);
  const failStart = leases.indexOf("async function failJob");
  const fail = leases.slice(failStart, leases.indexOf("async function releaseJob(", failStart));
  assert.match(fail, /publicationRecoveryPending/);
  assert.match(fail, /recordJobFailure\(\{ db: prisma/);
  assert.match(subscriber, /subscriberPublicationDebtWhere[\s\S]*fanProjectionStatus:\s*"COMPLETE"[\s\S]*publicationStatus:\s*\{ in:\s*\[\.\.\.SUBSCRIBER_PUBLICATION_IN_PROGRESS_STATUSES\]/);
  assert.match(subscriber, /async function recoverSubscriberPublicationDebt[\s\S]*SUBSCRIBER_RECOVERY_CREATOR_SCOPE_REQUIRED[\s\S]*findSubscriberPublicationDebtForCreator/);
  assert.match(subscriber, /reconcileRecoveredSubscriberPublicationJob[\s\S]*status:\s*"DONE"/);
  assert.match(subscriber, /publicationJobReconciledAt/);
  assert.match(subscriber, /status:\s*\{ in:\s*\["PUBLISHED", "SUPERSEDED"\] \}[\s\S]*publicationStatus:\s*"COMPLETE"[\s\S]*publicationJobReconciledAt:\s*null/);
  assert.match(subscriber, /planSubscriberDerivedAutomation[\s\S]*subscriber_snapshot_recovered/);
  assert.match(scheduler, /subscriberDirectoryMaintenance[\s\S]*runSubscriberDirectoryMaintenance/);
  assert.match(subscriber, /SUBSCRIBER_RECOVERY_CREATOR_SCOPE_REQUIRED/);
});

test("Campaign hot queries have predicate/order-specific indexes and claim SQL matches its expression index", () => {
  const migration = source("prisma/migrations/20260920123000_phase3_analytics_final_authority_cutover_v1/migration.sql");
  const queue = source("src/services/campaign-fan-refresh-queue-service.js");
  assert.match(migration, /CreatorFanRefreshDemand_promoter_ready_idx[\s\S]*status" = 'QUEUED'[\s\S]*activeRefreshJobId" IS NULL/);
  assert.match(migration, /CreatorFanRefreshDemand_recovery_order_idx[\s\S]*COALESCE\("nextRetryAt", "lastFailedAt", "updatedAt"\)[\s\S]*status" = 'FAILED'/);
  assert.match(migration, /CreatorFanRefreshDemand_canonical_heal_idx[\s\S]*status" IN \('QUEUED', 'FAILED'\)/);
  assert.match(migration, /CampaignFanRefreshPromotionSignal_claim_due_idx[\s\S]*COALESCE\("claimUntil", '-infinity'::timestamp\)/);
  assert.match(queue, /COALESCE\(s\."claimUntil", '-infinity'::timestamp\) <= \$1[\s\S]*ORDER BY s\."dueAt" ASC, s\."creatorId" ASC/);
});

test("A21 clean bootstrap, generation CAS and exact Subscriber cursor scale are source-enforced", () => {
  const prerequisite = source("prisma/migrations/20260616_aaa_bump_delivery_claim_prerequisite_v27/migration.sql");
  const a21 = source("prisma/migrations/20260920223000_phase3_analytics_a21_publication_generation_cursor_scale_v1/migration.sql");
  const subscriber = source("src/services/subscriber-directory-service.js");
  const fence = source("src/services/subscriber-publication-fence-service.js");
  const postflight = source("scripts/database/phase3-subscriber-publication-schema-online-postflight.js");
  assert.match(prerequisite, /ADD COLUMN IF NOT EXISTS "cancelAt"[\s\S]*"claimedByDeviceId"[\s\S]*"claimedAt"[\s\S]*"claimUntil"/);
  assert.ok("20260616_aaa_bump_delivery_claim_prerequisite_v27" < "20260616_bump_cancelat_backfill_v26");
  assert.match(a21, /ROW_NUMBER\(\) OVER[\s\S]*PARTITION BY "creatorId"/);
  assert.match(a21, /SubscriberScanItem_run_id_cursor_idx[\s\S]*"runId", "id"/);
  assert.match(a21, /SubscriberScanRun_publication_debt_idx/);
  assert.match(subscriber, /lockSubscriberPublicationCreator[\s\S]*pg_advisory_xact_lock/);
  assert.match(subscriber, /publication_recovery_in_progress/);
  assert.match(subscriber, /publishedGeneration:\s*\{ lt: generation \}/);
  assert.match(subscriber, /SUBSCRIBER_PUBLICATION_GENERATION_CAS_LOST/);
  assert.doesNotMatch(fence, /status:\s*"RUNNING"/);
  assert.match(postflight, /SubscriberScanItem_run_id_cursor_idx/);
  assert.match(postflight, /publicationGeneration[\s\S]*publishedGeneration/);
});

test("index lifecycle contract requires a dedicated ReadCommitted session and bounded one-connection worker", async () => {
  const url = preflight.indexLifecycleWorkerDatabaseUrl("postgresql://u:p@db.example/x?schema=public");
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("connection_limit"), "1");
  assert.equal(parsed.searchParams.get("pool_timeout"), "10");
  assert.equal(parsed.searchParams.get("connect_timeout"), "10");

  await assert.rejects(
    () => preflight.assertIndexLifecycleConnectionContract(
      { $queryRawUnsafe: async () => [{ pid: 9, isolation: "read committed" }] },
      { $queryRawUnsafe: async () => [{ pid: 9, isolation: "read committed" }] },
    ),
    /dedicated PostgreSQL session distinct from the root preflight client/,
  );
  await assert.rejects(
    () => preflight.assertIndexLifecycleConnectionContract(
      { $queryRawUnsafe: async () => [{ pid: 9, isolation: "read committed" }] },
      { $queryRawUnsafe: async () => [{ pid: 10, isolation: "repeatable read" }] },
    ),
    /must use Read Committed/,
  );
});

test("final migration carries bounded subscriber cursor, durable signal lease and retired legacy generations", () => {
  const schema = source("prisma/schema.prisma");
  const migration = source("prisma/migrations/20260920123000_phase3_analytics_final_authority_cutover_v1/migration.sql");
  const a21Migration = source("prisma/migrations/20260920223000_phase3_analytics_a21_publication_generation_cursor_scale_v1/migration.sql");
  assert.match(schema, /fanProjectionCursorOffset\s+Int/);
  assert.match(schema, /publicationStatus\s+String\s+@default\("PENDING"\)/);
  assert.match(schema, /publicationCursorId\s+String\?/);
  assert.match(schema, /pageOffset\s+Int\?/);
  assert.match(schema, /model CampaignFanRefreshPromotionSignal/);
  assert.match(schema, /@@unique\(\[agencyId, creatorId\], map: "CampaignFanRefreshPromotionSignal_agency_creator_key"\)/);
  assert.match(migration, /CONSTRAINT "CampaignFanRefreshPromotionSignal_agency_creator_key" UNIQUE \(\"agencyId\", \"creatorId\"\)/);
  assert.match(schema, /claimToken\s+String\?/);
  assert.match(schema, /claimUntil\s+DateTime\?/);
  assert.match(migration, /CampaignFanRefreshPromotionSignal_due_claim_creator_idx/);
  assert.match(schema, /publicationJobReconciledAt\s+DateTime\?/);
  assert.match(migration, /SubscriberScanRun_publication_job_reconcile_idx/);
  assert.match(migration, /publicationJobReconciledAt/);
  assert.match(migration, /CUTOVER_BACKFILL/);
  assert.match(a21Migration, /publicationGeneration/);
  assert.match(a21Migration, /publishedGeneration/);
  assert.match(a21Migration, /SubscriberScanItem_run_id_cursor_idx/);
  assert.match(a21Migration, /SubscriberScanRun_publication_debt_idx/);
});


test("final physical proof pack is rewritten for the final authority cut and persists proof JSON", () => {
  const proof = source("scripts/audit/phase3-a20-postgres-proof.js");
  const finalPg = source("src/services/phase3-analytics-final-authority-cutover.integration.test.js");
  assert.match(proof, /EXPECTED_PROOF_TEST_COUNT\s*=\s*42/);
  assert.match(proof, /phase3-analytics-final-authority-cutover\.integration\.test\.js/);
  assert.match(proof, /artifacts[\s\S]*audit[\s\S]*phase3-a26-postgres-proof\.json/);
  assert.match(proof, /physical proof JSON was not persisted/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_POINT_REFRESH_RACE_PASS/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_PERSISTED_CONFLICT_PASS/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_LOST_RESPONSE_BARRIER_PASS/);
  assert.match(finalPg, /FINAL_MANUAL_MAINTENANCE_OVERLAP_PASS/);
  assert.match(finalPg, /FINAL_TWO_REPLICA_PROMOTION_SIGNAL_PASS/);
  assert.match(finalPg, /FINAL_CUTOVER_CANONICAL_DEBT_HEAL_PASS/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_CURSOR_PLAN_PROOF/);
  assert.match(finalPg, /two Subscriber recovery replicas serialize one FAILED publication generation/);
});


test("Campaign promotion claim chronology is PostgreSQL-owned and stale claimant cannot mutate a re-claimed signal", async () => {
  const queuePath = require.resolve("./campaign-fan-refresh-queue-service", { paths: [__dirname] });
  const dbTimePath = require.resolve("./db-time-authority-service", { paths: [__dirname] });
  const lockPath = require.resolve("./campaign-transaction-lock-service", { paths: [__dirname] });
  const previousQueue = require.cache[queuePath];
  const previousTime = require.cache[dbTimePath];
  const previousLock = require.cache[lockPath];
  const authorityNow = new Date("2026-09-20T18:00:00.000Z");
  require.cache[dbTimePath] = { id: dbTimePath, filename: dbTimePath, loaded: true, exports: { dbAuthorityNow: async () => authorityNow } };
  require.cache[lockPath] = { id: lockPath, filename: lockPath, loaded: true, exports: { acquireCampaignTransactionLock: async () => null, withCampaignTransactionLock: async ({ work, db }) => work(db) } };
  delete require.cache[queuePath];
  try {
    const queueService = require(queuePath);
    let txCall = 0;
    let destructiveMutationCalls = 0;
    let safeReleaseCalls = 0;
    const signal = {
      id: "signal-1", agencyId: "agency-1", creatorId: "creator-1", dueAt: authorityNow,
      revision: 1, attempts: 0, claimToken: "claim-old", claimUntil: new Date(authorityNow.getTime() + 120_000),
    };
    const claimTx = {
      $queryRawUnsafe: async (sql, nowArg) => {
        assert.equal(nowArg.getTime(), authorityNow.getTime(), "claim due/lease predicate must use DB authority time");
        return [signal];
      },
    };
    const processTx = {
      campaignFanRefreshPromotionSignal: {
        findFirst: async ({ where }) => {
          assert.equal(where.claimToken, "claim-old");
          assert.deepEqual(where.claimUntil, { gt: authorityNow });
          assert.equal(where.revision, 1);
          return null; // a newer producer revision or re-claim invalidated this claimant
        },
        updateMany: async ({ where, data }) => {
          if (data && data.claimToken === null && data.claimUntil === null && Object.keys(data).length === 2) {
            assert.equal(where.id, "signal-1");
            assert.equal(where.claimToken, "claim-old");
            safeReleaseCalls += 1;
            return { count: 1 };
          }
          destructiveMutationCalls += 1;
          return { count: 1 };
        },
        deleteMany: async () => { destructiveMutationCalls += 1; return { count: 1 }; },
      },
    };
    const root = {
      $queryRawUnsafe: async () => [],
      $transaction: async (work) => {
        txCall += 1;
        return work(txCall === 1 ? claimTx : processTx);
      },
    };
    const result = await queueService.runCampaignFanRefreshPromotionMaintenance({ db: root, now: new Date("2099-01-01T00:00:00.000Z"), maxCreators: 1, concurrency: 1 });
    assert.equal(result.processedCreators, 0);
    assert.equal(result.contended, 1);
    assert.equal(safeReleaseCalls, 1, "stale claimant should release only its own old token");
    assert.equal(destructiveMutationCalls, 0, "stale claimant must not reschedule/delete the newer signal");
  } finally {
    delete require.cache[queuePath];
    if (previousQueue) require.cache[queuePath] = previousQueue;
    else delete require.cache[queuePath];
    if (previousTime) require.cache[dbTimePath] = previousTime;
    else delete require.cache[dbTimePath];
    if (previousLock) require.cache[lockPath] = previousLock;
    else delete require.cache[lockPath];
  }
});

test("Campaign promotion signal merge is atomic LEAST and every claimant final mutation is revision fenced", async () => {
  const queue = fs.readFileSync(path.join(__dirname, "campaign-fan-refresh-queue-service.js"), "utf8");
  assert.match(queue, /ON CONFLICT \("creatorId"\) DO UPDATE SET[\s\S]*"dueAt" = LEAST\("CampaignFanRefreshPromotionSignal"\."dueAt", EXCLUDED\."dueAt"\)[\s\S]*"revision" = "CampaignFanRefreshPromotionSignal"\."revision" \+ 1[\s\S]*RETURNING "dueAt", "revision"/);
  assert.match(queue, /findFirst\(\{[\s\S]*claimToken: signal\.claimToken[\s\S]*revision: Number\(signal\.revision \|\| 0\)/);
  assert.match(queue, /updateMany\(\{[\s\S]*where: \{ id: signal\.id, claimToken: signal\.claimToken, revision: Number\(signal\.revision \|\| 0\) \}/);
  assert.match(queue, /deleteMany\(\{[\s\S]*where: \{ id: signal\.id, claimToken: signal\.claimToken, revision: Number\(signal\.revision \|\| 0\) \}/);
  assert.match(queue, /SET "dueAt" = LEAST\("dueAt", \$3\), "claimToken" = NULL/);
});

