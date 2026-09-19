"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const services = __dirname;
const backend = path.resolve(services, "../..");
const read = (relative) => fs.readFileSync(path.join(backend, relative), "utf8");
const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };
const { loadCampaignDirectorySegment } = require("./creator-analytics-ledger-service");

test("INT5.9A-7 Backend current Campaign protocol is v13 with v12 order-independent compatibility", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(ledger, /CAMPAIGN_COLLECTOR_VERSION = "campaigns-v13"/);
  assert.match(ledger, /CAMPAIGN_ORDER_INDEPENDENT_COLLECTOR_VERSIONS = new Set\(\["campaigns-v12", CAMPAIGN_COLLECTOR_VERSION\]\)/);
  assert.match(ledger, /const orderIndependentTraversal = CAMPAIGN_ORDER_INDEPENDENT_COLLECTOR_VERSIONS\.has\(payload\.collectorVersion\)/);
  assert.match(ledger, /integer\(payload\.campaignBatchCount, 1_000_000\)/);
  assert.match(ledger, /integer\(payload\.campaignCount, 100_000_000\)/);
  assert.match(ledger, /async function loadCampaignDirectorySegment/);
  assert.match(ledger, /orderBy: \{ externalCampaignId: "asc" \}/);
  assert.match(ledger, /take: 51/);
  assert.match(ledger, /emptyCurrentFreshnessComplete = protocolCurrent && membershipComplete && observedCampaignCount === 0/);
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918134500_phase3_campaign_segmented_directory_v13/migration.sql");
  assert.match(schema, /@@index\(\[creatorId, sourceScanRunId, externalCampaignId\], map: "CreatorCampaign_run_segment_idx"\)/);
  assert.match(migration, /CreatorCampaign_run_segment_idx/);
});

test("INT5.9A-7 claim admission fences old Desktop before v13 segmented/fair provider reads", () => {
  const route = read("src/routes/jobs.js");
  const lease = read("src/services/job-lease-service.js");
  assert.match(route, /campaignSegmentedFairTraversalV1: true/);
  assert.match(route, /campaignSegmentedFairTraversalV1: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(lease, /capabilities\?\.campaignSegmentedFairTraversalV1 !== true/);
  assert.match(lease, /campaignSegmentedFairTraversalVersion: 1/);
  assert.match(lease, /"campaigns-v12", "campaigns-v13"/);
});

test("INT5.9A-7 cooperative release is not a failed attempt and cleans the read lease", () => {
  const lease = read("src/services/job-lease-service.js");
  const release = lease.slice(lease.indexOf("async function releaseJob("), lease.indexOf("module.exports"));
  assert.match(release, /status: "SCHEDULED"/);
  assert.match(release, /lastError: null/);
  assert.match(release, /fanObservationReadLease\.deleteMany/);
  assert.match(release, /attempts: job\.attempts/);
  assert.doesNotMatch(release, /attempts:\s*job\.attempts\s*\+/);
});


test("INT5.9A-7 relational segment cursor is bounded, stable and server-counted after directory exhaustion", async () => {
  const requestedAt = new Date("2026-09-18T10:00:00.000Z");
  const ids = Array.from({ length: 51 }, (_, index) => `campaign-${String(index + 1).padStart(4, "0")}`);
  let seenWhere = null;
  const db = {
    creatorCampaign: {
      findMany: async ({ where, take, orderBy }) => {
        seenWhere = where;
        assert.equal(take, 51);
        assert.deepEqual(orderBy, { externalCampaignId: "asc" });
        return ids.map((externalCampaignId) => ({ externalCampaignId }));
      },
      count: async ({ where }) => {
        assert.equal(where.creatorId, "creator-1");
        return 2_501;
      },
    },
  };
  const job = {
    id: "job-1", creatorId: "creator-1", agencyId: "agency-1",
    params: { collectionContractVersion: 1, collectionType: "CAMPAIGNS", collectionGeneration: "run-1", collectionRequestedAt: requestedAt.toISOString() },
    continuation: { driverPhase: "execute", jobContinuation: {
      collectorVersion: "campaigns-v13", scanRunId: "run-1", phase: "segment",
      directorySourceExhausted: true, campaignPagesComplete: true, truncated: false, segmentCursor: null,
    } },
  };
  const result = await loadCampaignDirectorySegment({ db, job, chunk: {
    kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: "run-1", cursor: null,
  } });
  assert.equal(result.campaignDirectorySegment.campaigns.length, 50);
  assert.equal(result.campaignDirectorySegment.hasMore, true);
  assert.equal(result.campaignDirectorySegment.cursor, "campaign-0050");
  assert.equal(result.campaignDirectorySegment.totalCampaignCount, 2_501);
  assert.equal(seenWhere.sourceScanRunId, "run-1");
  assert.equal(seenWhere.sourceScanStartedAt.toISOString(), requestedAt.toISOString());
});

test("INT5.9A-7 segment advance rejects cursor skips but permits exact lost-response replay", async () => {
  const requestedAt = "2026-09-18T10:00:00.000Z";
  let reads = 0;
  const db = { creatorCampaign: {
    findMany: async () => { reads += 1; return [{ externalCampaignId: "campaign-0101" }]; },
    count: async () => 101,
  } };
  const base = {
    id: "job-2", creatorId: "creator-1", agencyId: "agency-1",
    params: { collectionContractVersion: 1, collectionType: "CAMPAIGNS", collectionGeneration: "run-2", collectionRequestedAt: requestedAt },
  };
  await assert.rejects(() => loadCampaignDirectorySegment({ db, job: {
    ...base, continuation: { driverPhase: "execute", jobContinuation: {
      collectorVersion: "campaigns-v13", scanRunId: "run-2", phase: "segment", directorySourceExhausted: true,
      campaignPagesComplete: true, truncated: false, segmentCursor: "campaign-0050",
    } },
  }, chunk: { kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: "run-2", cursor: "campaign-9999" } }), /cursor does not match/);
  assert.equal(reads, 0);

  const replay = await loadCampaignDirectorySegment({ db, job: {
    ...base, continuation: { driverPhase: "execute", jobContinuation: {
      collectorVersion: "campaigns-v13", scanRunId: "run-2", phase: "claimers", directorySourceExhausted: true,
      campaignPagesComplete: true, truncated: false, segmentCursor: "campaign-0101", segmentRequestCursor: "campaign-0050",
    } },
  }, chunk: { kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: "run-2", cursor: "campaign-0050" } });
  assert.equal(replay.campaignDirectorySegment.requestCursor, "campaign-0050");
  assert.equal(reads, 1);
});
