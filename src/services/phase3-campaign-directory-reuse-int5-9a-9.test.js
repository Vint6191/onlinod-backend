"use strict";
const { commitDatabaseFixture } = require("../../scripts/test-support/commit-database-fixture");


const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };
const { loadCampaignDirectorySegment, ingestCampaignChunk } = require("./creator-analytics-ledger-service");
const { acceptCampaignGeneration } = require("./analytics-collector-control-service");

function campaignJob({ generation = "run-a9", requestedAt = "2026-09-18T20:00:00.000Z", revision = 7 } = {}) {
  return {
    id: "job-a9", creatorId: "creator-1", agencyId: "agency-1",
    params: {
      collectionContractVersion: 1, collectionType: "CAMPAIGNS", collectionGeneration: generation,
      collectionRequestedAt: requestedAt, collectionMode: "catchup", campaignMode: "catchup",
      campaignFrontierSchedulingVersion: 1, campaignDirectoryReuseVersion: 1, campaignFrontierBudget: 50,
      campaignDirectoryReuseGeneration: "directory-g1",
      campaignDirectoryReuseRequestedAt: "2026-09-18T18:00:00.000Z",
      campaignDirectoryReuseRevision: revision,
      campaignDirectoryReuseCampaignCount: 2_500,
    },
    continuation: { driverPhase: "execute", jobContinuation: {
      collectorVersion: "campaigns-v13", scanRunId: generation, scanStartedAt: requestedAt,
      phase: "segment", campaignMode: "catchup", directorySourceExhausted: true,
      campaignPagesComplete: true, truncated: false, totalCampaignCount: 2_500,
      campaignBatchCount: 0, claimerBatchCount: 0, segmentCursor: null,
    } },
  };
}

function reuseDb() {
  const directoryRequestedAt = new Date("2026-09-18T18:00:00.000Z");
  const state = {
    status: "PARTIAL", mode: "catchup", activeGeneration: "prior-tranche", activeRequestedAt: new Date("2026-09-18T19:00:00.000Z"),
    fanValueCoverageScanRunId: "prior-tranche", fanValueExpected: 10, fanValueFreshnessStatus: "COMPLETE",
    campaignDirectoryGeneration: "directory-g1", campaignDirectoryRequestedAt: directoryRequestedAt,
    campaignDirectoryVerifiedAt: new Date("2026-09-18T18:05:00.000Z"), campaignDirectoryRevision: 7, campaignDirectoryCampaignCount: 2_500,
    campaignFrontierPlanRunId: "prior-tranche", campaignFrontierFreshnessStatus: "PARTIAL",
    campaignFrontierDueCount: 120, campaignFrontierTargetCount: 50, campaignFrontierCompletedCount: 50, campaignFrontierDeferredCount: 70,
  };
  const selected = new Set();
  const exactGenerations = [];
  let segmentReads = 0;
  let upserts = 0;
  const db = {
    async $executeRawUnsafe(sql) { assert.match(sql, /pg_advisory_xact_lock/); return 1; },
    creatorCampaignCollectionState: {
      findUnique: async () => ({ ...state }),
      upsert: async ({ update }) => { upserts += 1; Object.assign(state, update); return { ...state }; },
      update: async ({ data }) => { Object.assign(state, data); return { ...state }; },
    },
    creatorCampaign: {
      count: async ({ where }) => {
        exactGenerations.push([where.sourceScanRunId, where.sourceScanStartedAt?.toISOString?.()]);
        if (where.OR) return 70;
        return 2_500;
      },
      findMany: async ({ where, take }) => {
        exactGenerations.push([where.sourceScanRunId, where.sourceScanStartedAt?.toISOString?.()]);
        if (where.OR) return Array.from({ length: 50 }, (_, i) => ({ id: `row-${String(i + 1).padStart(4, "0")}` }));
        segmentReads += 1;
        return Array.from({ length: Math.min(51, take) }, (_, i) => ({
          externalCampaignId: `campaign-${String(i + 1).padStart(4, "0")}`,
          claimersTargetRunId: selected.has(`row-${String(i + 1).padStart(4, "0")}`) ? "run-a9" : null,
        }));
      },
      updateMany: async ({ where, data }) => {
        for (const id of where.id.in) selected.add(id);
        assert.equal(data.claimersTargetRunId, "run-a9");
        return { count: where.id.in.length };
      },
      findFirst: async () => ({ claimersNextDueAt: new Date("2026-09-18T17:00:00.000Z") }),
    },
  };
  return { db: commitDatabaseFixture(db), state, selected, exactGenerations, get segmentReads() { return segmentReads; }, get upserts() { return upserts; } };
}

test("INT5.9A-9 schema/migration persists exact reusable Campaign directory authority", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918210500_phase3_campaign_directory_reuse_v1/migration.sql");
  for (const field of ["campaignDirectoryGeneration", "campaignDirectoryRequestedAt", "campaignDirectoryVerifiedAt", "campaignDirectoryRevision", "campaignDirectoryCampaignCount"]) {
    assert.match(schema, new RegExp(`${field}\\s+`));
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});

test("INT5.9A-9 rolling claim wire requires directory-reuse capability and seeds provider-free segment continuation", () => {
  const route = read("src/routes/jobs.js");
  const lease = read("src/services/job-lease-service.js");
  const client = read("../desktop/apps/desktop/electron/main/services/backend-jobs/backend-job-client.ts");
  assert.match(route, /campaignDirectoryReuseV1: true/);
  assert.match(route, /campaignDirectoryReuseV1: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(lease, /capabilities\?\.campaignDirectoryReuseV1 !== true/);
  assert.match(lease, /campaignDirectoryReuseVersion: 1/);
  assert.match(lease, /campaignDirectoryReuseInitialContinuation/);
  assert.match(lease, /phase: "segment"/);
  assert.match(lease, /directorySourceExhausted: true, campaignPagesComplete: true/);
  assert.match(client, /campaignDirectoryReuseV1: true/);
});

test("INT5.9A-9 same SCANNING Campaign generation is replay, not destructive reinitialization", async () => {
  let upserts = 0;
  const existing = {
    status: "SCANNING", activeGeneration: "run-same", activeRequestedAt: new Date("2026-09-18T20:00:00.000Z"),
    fanValueExpected: 77, campaignFrontierTargetCount: 50,
  };
  const db = {
    async $executeRawUnsafe(sql) { assert.match(sql, /pg_advisory_xact_lock/); return 1; }, creatorCampaignCollectionState: {
    findUnique: async () => ({ ...existing }),
    upsert: async () => { upserts += 1; throw new Error("must not reinitialize current SCANNING generation"); },
  } };
  const job = { id: "job-same", creatorId: "creator-1", agencyId: "agency-1", params: {
    collectionContractVersion: 1, collectionType: "CAMPAIGNS", collectionGeneration: "run-same",
    collectionRequestedAt: "2026-09-18T20:00:00.000Z", collectionMode: "catchup",
  } };
  const result = await acceptCampaignGeneration({ db: commitDatabaseFixture(db), job });
  assert.equal(result.accepted, true);
  assert.equal(result.replay, true);
  assert.equal(result.state.fanValueExpected, 77);
  assert.equal(upserts, 0);
});

test("INT5.9A-9 drains next frontier tranche from exact prior directory generation without OF directory re-read", async () => {
  const harness = reuseDb();
  const job = campaignJob();
  const result = await loadCampaignDirectorySegment({ db: commitDatabaseFixture(harness.db), job, chunk: {
    kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: "run-a9", cursor: null,
  } });
  assert.equal(result.campaignDirectorySegment.totalCampaignCount, 2_500);
  assert.equal(result.campaignDirectorySegment.campaigns.length, 50);
  assert.equal(result.campaignDirectorySegment.campaigns.filter((row) => row.scanClaimers).length, 50);
  assert.deepEqual(result.campaignDirectorySegment.frontierPlan, { status: "QUEUED", due: 70, target: 50, completed: 0, deferred: 20 });
  assert.equal(harness.state.activeGeneration, "run-a9");
  assert.equal(harness.state.campaignDirectoryGeneration, "directory-g1");
  assert.equal(harness.state.campaignDirectoryRevision, 7);
  assert.equal(harness.upserts, 1, "new tranche generation is accepted exactly once");
  assert.ok(harness.segmentReads >= 1);
  for (const [generation, requestedAt] of harness.exactGenerations) {
    assert.equal(generation, "directory-g1");
    assert.equal(requestedAt, "2026-09-18T18:00:00.000Z");
  }
});

test("INT5.9A-9 stale directory revision fails before activating/resetting a new tranche generation", async () => {
  const harness = reuseDb();
  const job = campaignJob({ revision: 6 });
  await assert.rejects(() => loadCampaignDirectorySegment({ db: commitDatabaseFixture(harness.db), job, chunk: {
    kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: "run-a9", cursor: null,
  } }), (error) => error?.code === "CAMPAIGN_DIRECTORY_REUSE_STALE");
  assert.equal(harness.state.activeGeneration, "prior-tranche");
  assert.equal(harness.upserts, 0);
  assert.equal(harness.segmentReads, 0);
});

test("INT5.9A-9 durable directory reuse remains the server-owned source for later frontier tranches", () => {
  const source = read("src/services/creator-analytics-sync-orchestrator.js");
  assert.match(source, /function campaignDirectoryReuseBinding\(state, now = new Date\(\)\)/);
  assert.match(source, /campaignDirectoryDiscoveryDue\(state, now\)/);
  assert.match(source, /campaignDirectoryReuseGeneration: generation/);
  assert.match(source, /campaignDirectoryReuseBinding\(campaignState, now\)/);
  assert.match(source, /\.\.\.\(directoryReuse \|\| \{\}\)/);
});


test("INT5.9A-9 stale reuse claimer write fails before collection generation acceptance", async () => {
  let stateUpserts = 0;
  const state = {
    campaignDirectoryGeneration: "directory-g1",
    campaignDirectoryRequestedAt: new Date("2026-09-18T18:00:00.000Z"),
    campaignDirectoryVerifiedAt: new Date("2026-09-18T18:05:00.000Z"),
    campaignDirectoryRevision: 7,
    campaignDirectoryCampaignCount: 2_500,
    status: "PARTIAL",
    activeGeneration: "prior-tranche",
    activeRequestedAt: new Date("2026-09-18T19:00:00.000Z"),
  };
  const db = {
    async $executeRawUnsafe(sql) { assert.match(sql, /pg_advisory_xact_lock/); return 1; },
    creatorCampaignCollectionState: {
      findUnique: async () => ({ ...state }),
      upsert: async () => { stateUpserts += 1; throw new Error("stale reuse must fail before generation acceptance"); },
    },
    creatorCampaign: {
      findUnique: async () => ({ claimersTargetRunId: "run-a9" }),
    },
  };
  const job = campaignJob({ revision: 6 });
  await assert.rejects(() => ingestCampaignChunk({ db: commitDatabaseFixture(db), job, deviceId: "device-1", chunk: {
    kind: "campaign_claimers_page", batchKey: "run:run-a9:claimers:campaign-1:0",
    scanRunId: "run-a9", schemaVersion: 4, collectorVersion: "campaigns-v13",
    externalCampaignId: "campaign-1", scannerRejected: 0, claimers: [],
  } }), (error) => error?.code === "CAMPAIGN_DIRECTORY_REUSE_STALE");
  assert.equal(stateUpserts, 0);
  assert.equal(state.activeGeneration, "prior-tranche");
});

test("INT5.9A-9 non-target claimer write fails before collection generation acceptance", async () => {
  let stateUpserts = 0;
  const state = {
    campaignDirectoryGeneration: "directory-g1",
    campaignDirectoryRequestedAt: new Date("2026-09-18T18:00:00.000Z"),
    campaignDirectoryVerifiedAt: new Date("2026-09-18T18:05:00.000Z"),
    campaignDirectoryRevision: 7,
    campaignDirectoryCampaignCount: 2_500,
    status: "PARTIAL",
    activeGeneration: "prior-tranche",
    activeRequestedAt: new Date("2026-09-18T19:00:00.000Z"),
  };
  const db = {
    async $executeRawUnsafe(sql) { assert.match(sql, /pg_advisory_xact_lock/); return 1; },
    creatorCampaignCollectionState: {
      findUnique: async () => ({ ...state }),
      upsert: async () => { stateUpserts += 1; throw new Error("non-target write must fail before generation acceptance"); },
    },
    creatorCampaign: {
      findUnique: async () => ({ claimersTargetRunId: "some-other-run" }),
    },
  };
  const job = campaignJob();
  await assert.rejects(() => ingestCampaignChunk({ db: commitDatabaseFixture(db), job, deviceId: "device-1", chunk: {
    kind: "campaign_claimers_page", batchKey: "run:run-a9:claimers:campaign-1:0",
    scanRunId: "run-a9", schemaVersion: 4, collectorVersion: "campaigns-v13",
    externalCampaignId: "campaign-1", scannerRejected: 0, claimers: [],
  } }), (error) => error?.code === "CAMPAIGN_FRONTIER_NOT_TARGETED");
  assert.equal(stateUpserts, 0);
  assert.equal(state.activeGeneration, "prior-tranche");
});
