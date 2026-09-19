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

test("A14 paged oldest-due admission cannot let a deep active head hide a later overdue creator", async () => {
  const blocked = Array.from({ length: 250 }, (_, index) => blockedRow(index));
  const healthy = {
    creatorId: "healthy-overdue",
    campaignDirectoryCampaignCount: 2_000,
    campaignDirectoryDiscoveryDueAt: new Date("2026-09-02T00:00:00Z"),
    status: "COMPLETE",
    retryAfterAt: null,
  };
  const db = {
    creatorCampaignCollectionState: {
      async findMany({ where, take }) {
        assert.equal(take, 250);
        const text = JSON.stringify(where);
        if (!text.includes('blocked-0249')) return blocked;
        return [healthy];
      },
    },
    jobInstance: {
      async findMany({ where }) {
        const ids = where.creatorId.in;
        if (ids.includes("healthy-overdue")) return [];
        return ids.map((creatorId) => ({ creatorId }));
      },
    },
  };
  const result = await scheduler.selectCampaignDirectoryDiscoveryAdmissions({
    db,
    now: new Date("2026-09-19T00:00:00Z"),
    pageBudget: 41,
    maxJobs: 1,
  });
  assert.deepEqual([...result.admittedCreatorIds], ["healthy-overdue"]);
  assert.equal(result.estimatedProviderPages, 41);
  assert.equal(result.considered, 251);
  assert.equal(result.reason, "oldest_due_keyset_budget");
});

test("A14 discovery selector pushes retry/terminal eligibility into DB and removes the fixed 5000 head cap", () => {
  const source = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const fn = source.slice(
    source.indexOf("async function selectCampaignDirectoryDiscoveryAdmissions"),
    source.indexOf("async function runCreatorAnalyticsCatchupSweep"),
  );
  assert.match(fn, /retryAfterAt:\s*\{\s*lte:\s*now\s*\}/);
  assert.match(fn, /status:\s*\{\s*not:\s*"FAILED"\s*\}/);
  assert.match(fn, /nulls:\s*"first"/);
  assert.match(fn, /pageCursor/);
  assert.match(fn, /campaignDirectoryDiscoveryDueAt:\s*pageCursor\.dueAt/);
  assert.doesNotMatch(fn, /\bskip[,)]/);
  assert.match(fn, /while \(admitted\.size < safeMaxJobs/);
  assert.doesNotMatch(fn, /Math\.min\(5000/);
});

test("A14 keyset selector makes NULL dueAt urgent and is stable when an already-scanned head disappears", async () => {
  const first = Array.from({ length: 250 }, (_, index) => ({
    creatorId: `null-${String(index).padStart(4, "0")}`,
    campaignDirectoryCampaignCount: 1,
    campaignDirectoryDiscoveryDueAt: null,
    status: "COMPLETE",
    retryAfterAt: null,
  }));
  const later = { creatorId: "dated-overdue", campaignDirectoryCampaignCount: 1, campaignDirectoryDiscoveryDueAt: new Date("2026-09-01T00:00:00Z"), status: "COMPLETE", retryAfterAt: null };
  let calls = 0;
  const db = {
    creatorCampaignCollectionState: {
      async findMany({ where, orderBy, take }) {
        calls += 1;
        assert.equal(take, 250);
        assert.deepEqual(orderBy[0], { campaignDirectoryDiscoveryDueAt: { sort: "asc", nulls: "first" } });
        if (calls === 1) return first;
        // Some rows from page 1 may disappear or move after the first query.
        // The keyset must still advance from the last tuple, not from offset 250.
        assert.match(JSON.stringify(where), /null-0249/);
        return [later];
      },
    },
    jobInstance: {
      async findMany({ where }) {
        const ids = where.creatorId.in;
        return ids.includes("dated-overdue") ? [] : ids.map((creatorId) => ({ creatorId }));
      },
    },
  };
  const result = await scheduler.selectCampaignDirectoryDiscoveryAdmissions({ db, now: new Date("2026-09-19T00:00:00Z"), pageBudget: 2, maxJobs: 1 });
  assert.deepEqual([...result.admittedCreatorIds], ["dated-overdue"]);
  assert.equal(calls, 2);
});
