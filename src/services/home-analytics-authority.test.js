"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.includes("/src/services/")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { __test: home } = require("./home-summary-service");
const { displayRangeBounds, previousDisplayRange, dateKey } = require("./analytics-range-contract");
Module._load = originalLoad;

const DAY_MS = 86_400_000;

function countDays(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

function days(from, to) {
  const out = [];
  for (let at = new Date(from); at <= to; at = new Date(at.getTime() + DAY_MS)) out.push(new Date(at));
  return out;
}

test("Home canonical revenue uses distinct date ranges for current/previous periods and groups the agency chart by UTC date", async () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const range = displayRangeBounds("7d", now);
  const previous = previousDisplayRange("7d", now);
  const creators = [
    { id: "creator-a", displayName: "A", username: "a", avatarUrl: null, status: "READY", remoteId: "ra" },
    { id: "creator-b", displayName: "B", username: "b", avatarUrl: null, status: "READY", remoteId: "rb" },
  ];
  const coverageRanges = [];
  const dailyRanges = [];
  const db = {
    analyticsCoverage: {
      async groupBy(args) {
        const { gte, lte } = args.where.coverageDate;
        coverageRanges.push([dateKey(gte), dateKey(lte)]);
        const n = countDays(gte, lte);
        return creators.map((creator) => ({
          creatorId: creator.id,
          _count: { _all: n },
          _min: { lastVerifiedAt: new Date("2026-09-08T13:30:00.000Z") },
        }));
      },
      async findMany(args) {
        assert.equal(dateKey(args.where.coverageDate), "2026-09-08");
        return creators.map((creator) => ({ creatorId: creator.id, status: "PARTIAL", lastVerifiedAt: new Date("2026-09-08T13:55:00.000Z") }));
      },
    },
    jobInstance: { async findMany() { return []; } },
    creatorEarningsDaily: {
      async groupBy(args) {
        const { gte, lte } = args.where.date;
        dailyRanges.push([args.by.join(","), dateKey(gte), dateKey(lte)]);
        if (args.by.length === 1 && args.by[0] === "creatorId") {
          return creators.map((creator) => ({
            creatorId: creator.id,
            _count: { _all: 7 },
            _sum: { totalCents: 700 },
            _max: { collectedAt: new Date("2026-09-08T13:55:00.000Z") },
          }));
        }
        if (args.by.length === 1 && args.by[0] === "date") {
          return days(gte, lte).map((date) => ({ date, _sum: { totalCents: 200 } }));
        }
        throw new Error(`unexpected groupBy: ${args.by.join(",")}`);
      },
      async aggregate(args) {
        const { gte, lte } = args.where.date;
        dailyRanges.push(["previous-aggregate", dateKey(gte), dateKey(lte)]);
        return { _sum: { totalCents: 1000 } };
      },
    },
  };

  const result = await home.readCanonicalRevenue({ db, agencyId: "agency-1", creators, range, previous, now });

  assert.equal(dateKey(range.startDay), "2026-09-02");
  assert.equal(dateKey(range.endDay), "2026-09-08");
  assert.equal(dateKey(previous.startDay), "2026-08-26");
  assert.equal(dateKey(previous.endDay), "2026-09-01");
  assert.deepEqual(dailyRanges, [
    ["creatorId", "2026-09-02", "2026-09-08"],
    ["date", "2026-09-02", "2026-09-08"],
    ["previous-aggregate", "2026-08-26", "2026-09-01"],
  ]);
  assert.equal(result.totalCents, 1400);
  assert.equal(result.deltaPct, 40);
  assert.deepEqual(result.points.map((point) => point.label), [
    "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08",
  ]);
  assert.ok(coverageRanges.some(([from, to]) => from === "2026-08-26" && to === "2026-09-01"));
});

test("Home never publishes a partial agency revenue sum as the complete KPI", async () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const range = displayRangeBounds("7d", now);
  const creators = [
    { id: "creator-a", displayName: "A", username: "a", avatarUrl: null, status: "READY", remoteId: "ra" },
    { id: "creator-b", displayName: "B", username: "b", avatarUrl: null, status: "READY", remoteId: "rb" },
  ];
  const db = {
    analyticsCoverage: {
      async groupBy(args) {
        const { gte, lte } = args.where.coverageDate;
        return [{
          creatorId: "creator-a",
          _count: { _all: countDays(gte, lte) },
          _min: { lastVerifiedAt: new Date("2026-09-08T13:30:00.000Z") },
        }];
      },
      async findMany() {
        return [{ creatorId: "creator-a", status: "PARTIAL", lastVerifiedAt: new Date("2026-09-08T13:55:00.000Z") }];
      },
    },
    jobInstance: { async findMany() { return []; } },
    creatorEarningsDaily: {
      async groupBy(args) {
        if (args.by.length === 1 && args.by[0] === "creatorId") {
          return [{
            creatorId: "creator-a",
            _count: { _all: 7 },
            _sum: { totalCents: 700 },
            _max: { collectedAt: new Date("2026-09-08T13:55:00.000Z") },
          }];
        }
        if (args.by.length === 1 && args.by[0] === "date") {
          return days(args.where.date.gte, args.where.date.lte).map((date) => ({ date, _sum: { totalCents: 100 } }));
        }
        throw new Error(`unexpected groupBy: ${args.by.join(",")}`);
      },
      async aggregate() { throw new Error("previous aggregate should not be requested"); },
    },
  };

  const result = await home.readCanonicalRevenue({ db, agencyId: "agency-1", creators, range, previous: null, now });
  assert.equal(result.reportingCreators, 1);
  assert.equal(result.creators.find((row) => row.id === "creator-a").revenueCents, 700, "verified creator fact stays visible");
  assert.equal(result.creators.find((row) => row.id === "creator-b").revenueCents, null, "missing creator remains unknown");
  assert.equal(result.totalCents, null, "partial agency sum must never masquerade as the full KPI");
  assert.deepEqual(result.points, [], "partial agency chart must not masquerade as complete");
  assert.equal(result.deltaPct, null);
});


test("Home refresh HTTP path enqueues one durable demand instead of looping creator planners", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "home.js"), "utf8");
  assert.match(source, /enqueueAgencyAnalyticsFreshnessDemand/);
  assert.match(source, /requestedByMemberId:\s*member\.id/);
  assert.match(source, /requestedAccessEpoch:\s*Number\(member\.accessEpoch/);
  assert.doesNotMatch(source, /ensureAgencyAnalyticsFreshness/);
  const refreshStart = source.indexOf('router.post("/refresh"');
  const refreshBody = source.slice(refreshStart);
  assert.doesNotMatch(refreshBody, /for\s*\(|Promise\.all\s*\(|creatorAccount\.findMany/);
  assert.match(refreshBody, /demandKey/);
  assert.match(refreshBody, /requestRevision/);
});

test("Home lifecycle projection exposes queued demand before any JobInstance exists", () => {
  const now = new Date("2026-09-08T20:00:00.000Z");
  const result = home.projectCollectionLifecycle({
    creatorIds: ["creator-a", "creator-b"],
    activeJobs: [],
    activeDemands: [{ key: "demand-1", creatorIds: null, claimToken: null, nextAttemptAt: null }],
    now,
  });
  assert.equal(result.size, 2);
  assert.deepEqual(result.get("creator-a"), { jobId: null, reason: "queued" });
  assert.deepEqual(result.get("creator-b"), { jobId: null, reason: "queued" });
});

test("Home lifecycle projection intersects targeted demand with current visible scope", () => {
  const now = new Date("2026-09-08T20:00:00.000Z");
  const result = home.projectCollectionLifecycle({
    creatorIds: ["creator-a", "creator-b"],
    activeJobs: [],
    activeDemands: [{ key: "demand-1", creatorIds: ["creator-b", "creator-hidden"], claimToken: null, nextAttemptAt: null }],
    now,
  });
  assert.deepEqual([...result.keys()], ["creator-b"]);
  assert.equal(result.has("creator-hidden"), false);
});

test("Home lifecycle projection distinguishes planning and deferred demand", () => {
  const now = new Date("2026-09-08T20:00:00.000Z");
  const result = home.projectCollectionLifecycle({
    creatorIds: ["creator-a", "creator-b"],
    activeJobs: [],
    activeDemands: [
      { key: "planning", creatorIds: ["creator-a"], claimToken: "claim-1", nextAttemptAt: null },
      { key: "deferred", creatorIds: ["creator-b"], claimToken: null, nextAttemptAt: new Date("2026-09-08T20:05:00.000Z") },
    ],
    now,
  });
  assert.deepEqual(result.get("creator-a"), { jobId: null, reason: "planning" });
  assert.deepEqual(result.get("creator-b"), { jobId: null, reason: "deferred" });
});

test("Home lifecycle projection gives materialized collection priority over demand state", () => {
  const now = new Date("2026-09-08T20:00:00.000Z");
  const result = home.projectCollectionLifecycle({
    creatorIds: ["creator-a"],
    activeJobs: [{ id: "job-1", creatorId: "creator-a", status: "CLAIMED" }],
    activeDemands: [{ key: "demand-1", creatorIds: ["creator-a"], claimToken: "claim-1", nextAttemptAt: new Date("2026-09-08T20:05:00.000Z") }],
    now,
  });
  assert.deepEqual(result.get("creator-a"), { jobId: "job-1", reason: "collecting" });
});
