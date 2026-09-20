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
  assert.match(subscriber, /itemsInput[\s\S]*slice\(0, MAX_PAGE_ITEMS\)/);
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

test("Billing and legacy Analytics have no active snapshot generation reader/writer", () => {
  const billing = source("src/services/billing-wallet-service.js");
  const settings = source("src/services/settings-service.js");
  const analyticsRoute = source("src/routes/analytics.js");
  const analyticsService = source("src/services/analytics-snapshot-service.js");
  const schema = source("prisma/schema.prisma");
  const migration = source("prisma/migrations/20260920123000_phase3_analytics_final_authority_cutover_v1/migration.sql");
  assert.doesNotMatch(billing, /creatorEarningsSnapshot\./);
  assert.match(billing, /source:\s*"UNAVAILABLE"/);
  assert.match(settings, /readRolling30dRevenueBatch/);
  assert.doesNotMatch(settings, /creatorEarningsSnapshot|CreatorEarningsSnapshot/);
  assert.doesNotMatch(analyticsRoute, /analytics-snapshot-service|reportAnalyticsSnapshots|getLatestPayload/);
  assert.doesNotMatch(analyticsService, /prisma|analyticsSnapshot\./);
  assert.doesNotMatch(schema, /model\s+(?:CreatorEarningsSnapshot|CreatorCampaignsSnapshot|AnalyticsSnapshot)\b/);
  assert.match(migration, /DROP TABLE IF EXISTS "AnalyticsSnapshot" CASCADE/);
  assert.match(migration, /DROP TABLE IF EXISTS "CreatorCampaignsSnapshot" CASCADE/);
  assert.match(migration, /DROP TABLE IF EXISTS "CreatorEarningsSnapshot" CASCADE/);
  assert.match(migration, /CREATE VIEW "CreatorEarningsSnapshot" AS[\s\S]*WHERE FALSE/);
  assert.match(migration, /CREATE VIEW "CreatorCampaignsSnapshot" AS[\s\S]*WHERE FALSE/);
  assert.match(migration, /CREATE VIEW "AnalyticsSnapshot" AS[\s\S]*WHERE FALSE/);
  assert.match(migration, /rolling-deploy tombstone; zero rows/);
});

test("index lifecycle contract requires distinct sessions, explicit ReadCommitted owner and bounded worker connection", async () => {
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
    /two distinct PostgreSQL sessions/,
  );
  await assert.rejects(
    () => preflight.assertIndexLifecycleConnectionContract(
      { $queryRawUnsafe: async () => [{ pid: 9, isolation: "repeatable read" }] },
      { $queryRawUnsafe: async () => [{ pid: 10, isolation: "read committed" }] },
    ),
    /must use Read Committed/,
  );
});

test("final migration carries bounded subscriber cursor, durable signal lease and retired legacy generations", () => {
  const schema = source("prisma/schema.prisma");
  const migration = source("prisma/migrations/20260920123000_phase3_analytics_final_authority_cutover_v1/migration.sql");
  assert.match(schema, /fanProjectionCursorOffset\s+Int/);
  assert.match(schema, /pageOffset\s+Int\?/);
  assert.match(schema, /model CampaignFanRefreshPromotionSignal/);
  assert.match(schema, /claimToken\s+String\?/);
  assert.match(schema, /claimUntil\s+DateTime\?/);
  assert.match(migration, /CampaignFanRefreshPromotionSignal_due_claim_creator_idx/);
  assert.match(migration, /CUTOVER_BACKFILL/);
});


test("final physical proof pack is rewritten for the final authority cut and persists proof JSON", () => {
  const proof = source("scripts/audit/phase3-a20-postgres-proof.js");
  const finalPg = source("src/services/phase3-analytics-final-authority-cutover.integration.test.js");
  assert.match(proof, /EXPECTED_PROOF_TEST_COUNT\s*=\s*34/);
  assert.match(proof, /phase3-analytics-final-authority-cutover\.integration\.test\.js/);
  assert.match(proof, /artifacts[\s\S]*audit[\s\S]*phase3-a20-postgres-proof\.json/);
  assert.match(proof, /physical proof JSON was not persisted/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_POINT_REFRESH_RACE_PASS/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_PERSISTED_CONFLICT_PASS/);
  assert.match(finalPg, /FINAL_SUBSCRIBER_LOST_RESPONSE_BARRIER_PASS/);
  assert.match(finalPg, /FINAL_MANUAL_MAINTENANCE_OVERLAP_PASS/);
  assert.match(finalPg, /FINAL_TWO_REPLICA_PROMOTION_SIGNAL_PASS/);
  assert.match(finalPg, /FINAL_CUTOVER_CANONICAL_DEBT_HEAL_PASS/);
});
