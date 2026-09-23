"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };
const orchestrator = require("./creator-analytics-sync-orchestrator");
const scheduler = require("./job-scheduler");
const campaignControl = require("./campaign-scan-control-service");

function directoryState(overrides = {}) {
  return {
    campaignDirectoryGeneration: "directory-g1",
    campaignDirectoryRequestedAt: new Date("2026-09-18T00:00:00.000Z"),
    campaignDirectoryVerifiedAt: new Date("2026-09-18T01:00:00.000Z"),
    campaignDirectoryRevision: 4,
    campaignDirectoryCampaignCount: 2_000,
    campaignDirectoryDiscoveryDueAt: new Date("2026-09-21T01:00:00.000Z"),
    campaignDirectoryDiscoveryRequestedRevision: 2,
    campaignDirectoryDiscoveryCompletedRevision: 2,
    campaignFrontierFreshnessStatus: "COMPLETE",
    campaignFrontierNextDueAt: new Date("2026-09-18T06:00:00.000Z"),
    ...overrides,
  };
}

test("INT5.9A-10 schema/migration persists independent directory discovery SLA authority", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918223000_phase3_campaign_directory_discovery_sla_v1/migration.sql");
  for (const field of [
    "campaignDirectoryDiscoveryDueAt",
    "campaignDirectoryDiscoveryRequestedAt",
    "campaignDirectoryDiscoveryRequestedRevision",
    "campaignDirectoryDiscoveryCompletedRevision",
  ]) {
    assert.match(schema, new RegExp(`${field}\\s+`));
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.match(schema, /CreatorCampaignCollectionState_directory_due_idx/);
  assert.match(migration, /INTERVAL '72 hours'/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});

test("INT5.9A-10 frontier due can reuse a fresh directory while pending discovery demand invalidates reuse", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const state = directoryState();
  assert.equal(orchestrator.campaignFrontierWorkDue(state, now), true);
  assert.equal(orchestrator.campaignDirectoryDiscoveryDue(state, now), false);
  assert.deepEqual(orchestrator.campaignDirectoryReuseBinding(state, now), {
    campaignDirectoryReuseGeneration: "directory-g1",
    campaignDirectoryReuseRequestedAt: "2026-09-18T00:00:00.000Z",
    campaignDirectoryReuseRevision: 4,
    campaignDirectoryReuseCampaignCount: 2_000,
  });

  const forced = directoryState({ campaignDirectoryDiscoveryRequestedRevision: 3 });
  assert.equal(orchestrator.campaignDirectoryDiscoveryDue(forced, now), true);
  assert.equal(orchestrator.campaignDirectoryReuseBinding(forced, now), null);
});

test("INT5.9A-10 recurring discovery admission is oldest-due and bounded by estimated provider pages", async () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const candidates = [
    { creatorId: "creator-a", campaignDirectoryCampaignCount: 2_000, campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T00:00:00Z") },
    { creatorId: "creator-b", campaignDirectoryCampaignCount: 2_000, campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T01:00:00Z") },
    { creatorId: "creator-c", campaignDirectoryCampaignCount: 2_000, campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T02:00:00Z") },
    { creatorId: "creator-d", campaignDirectoryCampaignCount: 50, campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T03:00:00Z") },
  ];
  const db = {
    creatorCampaignCollectionState: { findMany: async () => candidates },
    jobInstance: { findMany: async () => [] },
  };
  const result = await scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db, now, creatorIds: candidates.map((r) => r.creatorId), pageBudget: 82, maxJobs: 10 });
  // 2,000 campaigns reserve 41 calls including the terminal page. Two oldest
  // creators consume the entire 82-call budget; later due creators cannot jump ahead.
  assert.deepEqual([...result.admittedCreatorIds], ["creator-a", "creator-b"]);
  assert.equal(result.estimatedProviderPages, 82);
});

test("INT5.9A-10 active Campaign work does not waste a directory admission slot", async () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const db = {
    creatorCampaignCollectionState: { findMany: async () => [
      { creatorId: "creator-a", campaignDirectoryCampaignCount: 2_000, campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T00:00:00Z") },
      { creatorId: "creator-b", campaignDirectoryCampaignCount: 2_000, campaignDirectoryDiscoveryDueAt: new Date("2026-09-18T01:00:00Z") },
    ] },
    jobInstance: { findMany: async () => [{ creatorId: "creator-a" }] },
  };
  const result = await scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db, now, creatorIds: ["creator-a", "creator-b"], pageBudget: 41, maxJobs: 1 });
  assert.deepEqual([...result.admittedCreatorIds], ["creator-b"]);
});

test("INT5.9A-10 source has claim-time global discovery concurrency fence and manual discovery demand", () => {
  const lease = read("src/services/job-lease-service.js");
  const manual = read("src/services/campaign-scan-control-service.js");
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(lease, /CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS/);
  assert.match(lease, /campaign-directory-discovery-claim-admission-v1/);
  assert.match(lease, /CAMPAIGN_DIRECTORY_DISCOVERY_MAX_NON_RECURRING_ACTIVE_CLAIMS/);
  assert.match(lease, /activeNonRecurringDiscovery/);
  assert.match(lease, /creator_analytics_catchup/);
  assert.match(lease, /lockDbAdvisoryXact/);
  assert.match(lease, /campaignDirectoryReuseGeneration/);
  assert.match(lease, /"jobKey" = 'fetch_campaigns'/);
  assert.match(lease, /"status" = 'CLAIMED'/);
  assert.match(manual, /campaignDirectoryDiscoveryRequestedRevision/);
  assert.match(manual, /campaignDirectoryDiscoveryDueAt: authorityNow/);
  assert.match(ledger, /campaignDirectoryDiscoveryCompletedRevision/);
  assert.match(ledger, /CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS/);
});

test("INT5.9A-10 default admission math leaves provider headroom and gives deterministic population bounds", () => {
  assert.equal(scheduler.CAMPAIGN_DIRECTORY_DISCOVERY_PAGE_BUDGET_PER_SWEEP, 2400);
  assert.equal(scheduler.CAMPAIGN_DIRECTORY_DISCOVERY_MAX_JOBS_PER_SWEEP, 100);
  const pagesPerTwoThousandCampaigns = scheduler.estimatedCampaignDirectoryPages({ campaignDirectoryCampaignCount: 2_000 });
  assert.equal(pagesPerTwoThousandCampaigns, 41);
  const admittedPerHour = Math.floor(2400 / pagesPerTwoThousandCampaigns);
  assert.equal(admittedPerHour, 58);
  assert.ok(Math.ceil(500 / admittedPerHour) <= 9);
  assert.ok(Math.ceil(4000 / admittedPerHour) <= 69);
});


test("INT5.9A-10 rolling claim cap classifies pre-marker discovery and counts legacy CLAIMED jobs", () => {
  const lease = read("src/services/job-lease-service.js");
  assert.match(lease, /return !\(Number\(value\.campaignDirectoryReuseVersion \|\| 0\) >= 1/);
  assert.match(lease, /campaignDirectoryReuseGeneration/);
  assert.match(lease, /\$queryRawUnsafe/);
  assert.match(lease, /COUNT\(\*\) FILTER \(WHERE discovery\)::bigint AS "activeDiscovery"/);
  assert.match(lease, /activeNonRecurringDiscovery/);
  assert.match(lease, /"jobKey" = 'fetch_campaigns'/);
  assert.match(lease, /campaignDirectoryReuseGeneration/);
  assert.doesNotMatch(lease, /take: CAMPAIGN_DIRECTORY_DISCOVERY_MAX_ACTIVE_CLAIMS/);
});

test("INT5.9A-10 explicit manual FULL immediately invalidates an active provider-free reuse generation", async () => {
  const now = new Date("2026-09-19T00:30:00.000Z");
  const active = {
    id: "reuse-active", creatorId: "creator-1", agencyId: "agency-1", jobKey: "fetch_campaigns",
    status: "CLAIMED", priority: 50, createdAt: new Date("2026-09-19T00:00:00.000Z"),
    params: {
      campaignDirectoryReuseVersion: 1,
      campaignDirectoryReuseGeneration: "directory-g1",
      collectionMode: "catchup",
    },
  };
  let state = directoryState({
    campaignDirectoryDiscoveryRequestedRevision: 2,
    campaignDirectoryDiscoveryCompletedRevision: 2,
  });
  let updates = 0;
  const db = {
    jobInstance: { async findMany() { return [active]; } },
    creatorCampaignCollectionState: {
      async findUnique() { return state; },
      async update({ data }) { updates += 1; state = { ...state, ...data }; return state; },
    },
  };
  const result = await campaignControl.startManualCampaignScan({
    db,
    creator: { id: "creator-1", agencyId: "agency-1" },
    requestedByUserId: "user-1",
    now,
  });
  assert.equal(result.action, "already_running");
  assert.equal(result.job.id, active.id);
  assert.equal(updates, 1);
  assert.equal(state.campaignDirectoryDiscoveryRequestedRevision, 3);
  assert.equal(state.campaignDirectoryDiscoveryDueAt.toISOString(), now.toISOString());
  assert.equal(orchestrator.campaignDirectoryReuseBinding(state, now), null, "manual FULL must invalidate reuse immediately");
});
