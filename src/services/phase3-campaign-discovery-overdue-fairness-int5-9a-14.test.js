"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prismaModulePath = require.resolve("../prisma");
require.cache[prismaModulePath] = { id: prismaModulePath, filename: prismaModulePath, loaded: true, exports: {} };
const scheduler = require("./job-scheduler");

function blockedRow(index) {
  return {
    creatorId: `blocked-${String(index).padStart(4, "0")}`,
    campaignDirectoryCampaignCount: 2_000,
    campaignDirectoryDiscoveryDueAt: new Date("2026-09-01T00:00:00Z"),
    status: "COMPLETE",
    retryAfterAt: null,
  };
}

test("discovery compatibility helper rejects global enumeration before querying", async () => {
  const db = { creatorCampaignCollectionState: { findMany: async () => { throw new Error("global scan"); } } };
  await assert.rejects(() => scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db }), { code: "ANALYTICS_BOUNDED_SCOPE_REQUIRED" });
  await assert.rejects(() => scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db, creatorIds: Array(101).fill("x") }), { code: "ANALYTICS_BOUNDED_SCOPE_REQUIRED" });
});

test("bounded discovery selection excludes busy head without consulting unrelated creators", async () => {
  const rows = [blockedRow(0), { ...blockedRow(1), creatorId: "eligible" }];
  let reads = 0;
  const db = {
    creatorCampaignCollectionState: { findMany: async ({ where, take }) => {
      reads += 1; assert.deepEqual(where.creatorId.in, rows.map((r) => r.creatorId)); assert.equal(take, 2); return rows;
    } },
    jobInstance: { findMany: async () => [{ creatorId: rows[0].creatorId }] },
  };
  const result = await scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db, creatorIds: rows.map((r) => r.creatorId), pageBudget: 41 });
  assert.equal(reads, 1);
  assert.deepEqual([...result.admittedCreatorIds], ["eligible"]);
});

test("bounded discovery keeps retry and terminal exclusions in its database predicate", async () => {
  const db = { creatorCampaignCollectionState: { findMany: async ({ where }) => {
    assert.match(JSON.stringify(where), /retryAfterAt/);
    assert.match(JSON.stringify(where), /FAILED/);
    return [];
  } } };
  const result = await scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db, creatorIds: ["one"] });
  assert.equal(result.considered, 0);
});
