"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };
const { loadCampaignDirectorySegment } = require("./creator-analytics-ledger-service");

test("INT5.9A-8 schema/migration installs revisioned frontier authority and bounded plan state", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260918194500_phase3_campaign_frontier_scheduling_v1/migration.sql");
  assert.match(schema, /claimerRevision\s+Int\s+@default\(1\)/);
  assert.match(schema, /claimerVerifiedRevision\s+Int\s+@default\(0\)/);
  assert.match(schema, /claimersNextDueAt\s+DateTime\?/);
  assert.match(schema, /claimersTargetRunId\s+String\?\s+@db\.VarChar\(120\)/);
  assert.match(schema, /campaignFrontierDeferredCount\s+Int\s+@default\(0\)/);
  assert.match(schema, /CreatorCampaign_frontier_due_idx/);
  assert.match(migration, /UPDATE "CreatorCampaign"[\s\S]*"claimersNextDueAt" = COALESCE/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});

test("INT5.9A-8 claim wire fences selective frontier scheduling behind a seventh capability", () => {
  const route = read("src/routes/jobs.js");
  const lease = read("src/services/job-lease-service.js");
  assert.match(route, /campaignFrontierSchedulingV1: true/);
  assert.match(route, /campaignFrontierSchedulingV1: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(lease, /capabilities\?\.campaignFrontierSchedulingV1 !== true/);
  assert.match(lease, /campaignFrontierSchedulingVersion: 1/);
  assert.match(lease, /typeof row\.scanClaimers === "boolean"/);
});

test("INT5.9A-8 catch-up selects one durable due budget and emits scanClaimers=false for deferred Campaigns", async () => {
  const requestedAt = new Date("2026-09-18T18:00:00.000Z");
  const state = {
    campaignFrontierPlanRunId: null,
    campaignFrontierFreshnessStatus: "MISSING",
    campaignFrontierDueCount: 0,
    campaignFrontierTargetCount: 0,
    campaignFrontierCompletedCount: 0,
    campaignFrontierDeferredCount: 0,
  };
  const selected = new Set();
  let selectionReads = 0;
  const planAuthorityNow = new Date("2026-09-18T18:05:00.000Z");
  const dueBoundaries = [];
  const dueIds = Array.from({ length: 25 }, (_, i) => `row-${String(i * 2 + 1).padStart(4, "0")}`);
  const segmentRows = Array.from({ length: 51 }, (_, i) => ({
    id: `row-${String(i + 1).padStart(4, "0")}`,
    externalCampaignId: `campaign-${String(i + 1).padStart(4, "0")}`,
  }));
  const db = {
    $queryRawUnsafe: async () => [{ authorityNow: planAuthorityNow }],
    creatorCampaignCollectionState: {
      findUnique: async () => ({ ...state }),
      update: async ({ data }) => { Object.assign(state, data); return { ...state }; },
    },
    creatorCampaign: {
      count: async ({ where }) => {
        if (where.OR) {
          dueBoundaries.push(where.OR[1]?.claimersNextDueAt?.lte);
          return 120;
        }
        return 2_500;
      },
      findMany: async ({ where, take }) => {
        if (where.OR) {
          selectionReads += 1;
          dueBoundaries.push(where.OR[1]?.claimersNextDueAt?.lte);
          assert.equal(take, 25);
          return dueIds.map((id) => ({ id }));
        }
        assert.equal(take, 51);
        return segmentRows.map((row) => ({
          externalCampaignId: row.externalCampaignId,
          claimersTargetRunId: selected.has(row.id) ? "run-a8" : null,
        }));
      },
      updateMany: async ({ where, data }) => {
        for (const id of where.id.in) selected.add(id);
        assert.equal(data.claimersTargetRunId, "run-a8");
        return { count: where.id.in.length };
      },
      findFirst: async ({ where }) => {
        if (where.OR) dueBoundaries.push(where.OR[1]?.claimersNextDueAt?.lte);
        return { claimersNextDueAt: new Date("2026-09-18T12:00:00.000Z") };
      },
    },
  };
  const job = {
    id: "job-a8", creatorId: "creator-1", agencyId: "agency-1",
    params: {
      collectionContractVersion: 1, collectionType: "CAMPAIGNS", collectionGeneration: "run-a8",
      collectionRequestedAt: requestedAt.toISOString(), collectionMode: "catchup",
      campaignFrontierSchedulingVersion: 1, campaignFrontierBudget: 25,
    },
    continuation: { driverPhase: "execute", jobContinuation: {
      collectorVersion: "campaigns-v13", scanRunId: "run-a8", phase: "segment",
      directorySourceExhausted: true, campaignPagesComplete: true, truncated: false, segmentCursor: null,
    } },
  };
  const chunk = { kind: "campaign_directory_segment", schemaVersion: 4, collectorVersion: "campaigns-v13", scanRunId: "run-a8", cursor: null };
  const result = await loadCampaignDirectorySegment({ db, job, chunk });
  assert.equal(result.campaignDirectorySegment.campaigns.length, 50);
  assert.equal(result.campaignDirectorySegment.campaigns.filter((row) => row.scanClaimers).length, 25);
  assert.equal(result.campaignDirectorySegment.campaigns.filter((row) => !row.scanClaimers).length, 25);
  assert.deepEqual(result.campaignDirectorySegment.frontierPlan, { status: "QUEUED", due: 120, target: 25, completed: 0, deferred: 95 });
  assert.equal(state.campaignFrontierPlanRunId, "run-a8");
  assert.equal(state.campaignFrontierDeferredCount, 95);
  assert.equal(selectionReads, 1);
  assert.ok(dueBoundaries.length >= 3);
  for (const boundary of dueBoundaries) {
    assert.equal(new Date(boundary).toISOString(), planAuthorityNow.toISOString(),
      "frontier due selection must include Campaign metadata changes observed after collectionRequestedAt but before planning");
  }

  const replayJob = structuredClone(job);
  replayJob.continuation = { driverPhase: "execute", jobContinuation: {
    ...job.continuation.jobContinuation,
    phase: "claimers", segmentRequestCursor: null, segmentCursor: "campaign-0050",
  } };
  await loadCampaignDirectorySegment({ db, job: replayJob, chunk });
  assert.equal(selectionReads, 1, "lost-response replay must reuse the durable plan instead of selecting a new budget");
});

test("INT5.9A-8 source fences catch-up claimer writes to the server-selected run target", () => {
  const ledger = read("src/services/creator-analytics-ledger-service.js");
  assert.match(ledger, /frontierSchedulingCurrent && command\.mode === "catchup" && saved\.claimersTargetRunId !== scanRunId/);
  assert.match(ledger, /CAMPAIGN_FRONTIER_NOT_TARGETED/);
  assert.match(ledger, /claimersTargetRunId: null/);
  assert.match(ledger, /campaignFrontierFreshnessStatus: completed >= target \? \(deferred > 0 \? "PARTIAL" : "COMPLETE"\) : "SCANNING"/);
  assert.match(ledger, /const currentMembershipComplete = membershipComplete && frontierFreshnessComplete/);
  const queue = read("src/services/campaign-fan-refresh-queue-service.js");
  assert.match(queue, /const cutoff = new Date\(runStartedAt\.getTime\(\) - CAMPAIGN_FAN_VALUE_FRESHNESS_MS\)/);
  assert.match(ledger, /const fanCutoff = new Date\(command\.requestedAt\.getTime\(\) - CAMPAIGN_FAN_VALUE_FRESHNESS_MS\)/);
});
