"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.includes("/src/services/")) return {};
  if (request === "./desktop-control-events") return { publishDesktopControlEvent: () => null };
  return originalLoad.call(this, request, parent, isMain);
};
const planner = require("./analytics-collection-planner");
Module._load = originalLoad;

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function daysInclusive(start, end) {
  const rows = [];
  for (let day = new Date(start); day <= end; day = new Date(day.getTime() + 86_400_000)) rows.push(new Date(day));
  return rows;
}

function addSweepLeaseStore(db) {
  let lease = null;
  db.$transaction = async (work) => work(db);
  db.$executeRawUnsafe = async () => 1;
  db.analyticsCollectionLease = {
    findUnique: async () => lease ? { ...lease } : null,
    create: async ({ data }) => {
      lease = { ...data, createdAt: new Date(), updatedAt: new Date() };
      return { ...lease };
    },
    update: async ({ data }) => {
      if (!lease) throw new Error("LEASE_NOT_FOUND");
      lease = { ...lease, ...data, updatedAt: new Date() };
      return { ...lease };
    },
    updateMany: async ({ where, data }) => {
      if (!lease) return { count: 0 };
      if (where.key && lease.key !== where.key) return { count: 0 };
      if (where.ownerToken && lease.ownerToken !== where.ownerToken) return { count: 0 };
      if (where.cycleKey && lease.cycleKey !== where.cycleKey) return { count: 0 };
      if (where.completedAt === null && lease.completedAt != null) return { count: 0 };
      lease = { ...lease, ...data, updatedAt: new Date() };
      return { count: 1 };
    },
  };
  return { get: () => lease ? { ...lease } : null };
}


const DEMAND_ACTOR = Object.freeze({ requestedByMemberId: "member-1", requestedAccessEpoch: 7 });

function addDemandAuthority(db, overrides = {}) {
  let live = {
    id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OWNER", roleKey: "owner",
    permissions: {}, assignedCreators: "all", accessEpoch: 7, deletedAt: null, deactivatedAt: null,
    ...overrides,
  };
  db.agencyMember = {
    findFirst: async ({ where = {} } = {}) => {
      if (!live || live.deletedAt || live.deactivatedAt) return null;
      if (where.id && String(where.id) !== String(live.id)) return null;
      if (where.agencyId && String(where.agencyId) !== String(live.agencyId)) return null;
      if (where.accessEpoch != null && Number(where.accessEpoch) !== Number(live.accessEpoch)) return null;
      return { ...live };
    },
  };
  return { get: () => live ? { ...live } : null, set: (patch) => { live = live ? { ...live, ...patch } : patch; }, revoke: () => { live = null; } };
}

function addDemandStore(db) {
  const rows = new Map();
  db.$transaction = db.$transaction || (async (work) => work(db));
  db.$executeRawUnsafe = db.$executeRawUnsafe || (async () => 1);
  db.analyticsCollectionDemand = {
    findUnique: async ({ where }) => rows.has(where.key) ? { ...rows.get(where.key) } : null,
    create: async ({ data }) => {
      const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
      rows.set(row.key, row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const current = rows.get(where.key);
      if (!current) throw new Error("DEMAND_NOT_FOUND");
      const row = { ...current, ...data, updatedAt: new Date() };
      rows.set(where.key, row);
      return { ...row };
    },
    updateMany: async ({ where, data }) => {
      const current = rows.get(where.key);
      if (!current) return { count: 0 };
      if (where.claimToken && current.claimToken !== where.claimToken) return { count: 0 };
      if (where.claimedRevision != null && Number(current.claimedRevision) !== Number(where.claimedRevision)) return { count: 0 };
      if (where.completedAt === null && current.completedAt != null) return { count: 0 };
      rows.set(where.key, { ...current, ...data, updatedAt: new Date() });
      return { count: 1 };
    },
    findFirst: async ({ where }) => {
      const now = where.OR?.find((item) => item.claimUntil?.lte)?.claimUntil?.lte || new Date();
      const candidates = [...rows.values()].filter((row) => row.completedAt == null && (row.claimUntil == null || new Date(row.claimUntil) <= now));
      candidates.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || new Date(a.requestedAt) - new Date(b.requestedAt) || String(a.key).localeCompare(String(b.key)));
      return candidates.length ? { ...candidates[0] } : null;
    },
  };
  return {
    get: (key) => rows.has(key) ? { ...rows.get(key) } : null,
    all: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

test("operational freshness window covers today plus the previous 30 fully closed UTC days", () => {
  const window = planner.operationalFreshnessWindow(new Date("2026-09-08T14:00:00.000Z"));
  assert.equal(isoDay(window.startDay), "2026-08-09");
  assert.equal(isoDay(window.endDay), "2026-09-08");
  assert.equal(daysInclusive(window.startDay, window.endDay).length, 31);
});

test("freshness requires a COMMITTED durable scan proof, not merely a proof id", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const day = new Date("2026-09-07T00:00:00.000Z");
  const base = {
    status: "COMPLETE",
    lastVerifiedAt: new Date("2026-09-08T13:00:00.000Z"),
    retryAfterAt: null,
    scanProofId: "proof-1",
  };
  assert.equal(planner.coverageFresh({ ...base, scanProof: { status: "PARTIAL" } }, day, now), false);
  assert.equal(planner.coverageFresh({ ...base, scanProof: { status: "COMMITTED" } }, day, now), true);
});

test("old earnings are never FINAL and are periodically reverified for provider corrections", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const oldDay = new Date("2026-05-01T00:00:00.000Z");
  const proof = { status: "COMMITTED" };
  const freshOld = {
    coverageDate: oldDay, status: "COMPLETE", scanProofId: "proof-old", scanProof: proof,
    lastVerifiedAt: new Date(now.getTime() - 29 * 86_400_000), retryAfterAt: null,
  };
  const staleOld = { ...freshOld, lastVerifiedAt: new Date(now.getTime() - 31 * 86_400_000) };
  assert.equal(planner.coverageFresh(freshOld, oldDay, now), true);
  assert.equal(planner.coverageFresh(staleOld, oldDay, now), false);
});

test("missing daily coverage becomes bounded aligned reconciliation windows instead of a display-range rescan", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const due = [new Date("2026-08-18T00:00:00Z"), new Date("2026-08-19T00:00:00Z"), new Date("2026-08-20T00:00:00Z")];
  const windows = planner.windowsForDueDays(due, now);
  assert.equal(windows.length, 1);
  assert.ok((windows[0].scanTo - windows[0].scanFrom) / 86_400_000 <= 6);
  assert.ok(windows[0].scanFrom <= due[0]);
  assert.ok(windows[0].scanTo >= due.at(-1));
});

test("planner merges an exact claimed scan across generation buckets under a creator-local database lock", async () => {
  const lockCalls = [];
  let createCalls = 0;
  let current = {
    id: "job-existing",
    idempotencyKey: "old-bucket-key",
    jobKey: "fetch_earnings",
    creatorId: "creator-1",
    agencyId: "agency-1",
    status: "CLAIMED",
    priority: 30,
    params: {
      analyticsContractVersion: 1,
      scanFrom: "2026-09-01",
      scanTo: "2026-09-07",
      sourceTimezone: "UTC",
      requestedAt: "2026-09-08T13:00:00.000Z",
      scanGeneration: "2026-09-08T13:00:00.000Z",
      collectionReason: "RECURRING",
    },
    nextRunAt: new Date("2026-09-08T13:00:00.000Z"),
    leaseRevision: 4,
  };
  const db = {
    $transaction: async (work) => work(db),
    $executeRawUnsafe: async (sql, key) => { lockCalls.push([sql, key]); return 1; },
    jobInstance: {
      findMany: async () => [{ ...current }],
      updateMany: async ({ where, data }) => {
        assert.equal(where.id, current.id);
        current = { ...current, ...data };
        return { count: 1 };
      },
      findUnique: async ({ where }) => where.id === current.id ? { ...current } : null,
      createMany: async () => { createCalls += 1; return { count: 1 }; },
    },
  };

  const result = await planner.planWindow({
    db,
    creatorId: "creator-1",
    agencyId: "agency-1",
    displayRangeKey: "7d",
    scanFrom: new Date("2026-09-01T00:00:00.000Z"),
    scanTo: new Date("2026-09-07T00:00:00.000Z"),
    collectionReason: "INTERACTIVE_REFRESH",
    priority: 100,
    now: new Date("2026-09-08T14:01:00.000Z"),
  });

  assert.equal(result.created, false);
  assert.equal(result.job.id, "job-existing");
  assert.equal(result.job.priority, 100);
  assert.equal(createCalls, 0);
  assert.equal(lockCalls.length, 1);
  assert.match(lockCalls[0][0], /pg_advisory_xact_lock/);
  assert.equal(lockCalls[0][1], "analytics-plan:creator-1");
  assert.equal(current.params.requestedAt, "2026-09-08T13:00:00.000Z", "claimed scan contract stays immutable");
});

test("still-due exact window reschedules a terminal attempt inside the same idempotency bucket", async () => {
  let lockTaken = false;
  let current = {
    id: "job-terminal",
    idempotencyKey: null,
    jobKey: "fetch_earnings",
    creatorId: "creator-1",
    agencyId: "agency-1",
    status: "FAILED",
    priority: 30,
    params: {},
    leaseRevision: 2,
    completedAt: new Date("2026-09-08T14:01:00.000Z"),
  };
  const db = {
    $transaction: async (work) => work(db),
    $executeRawUnsafe: async () => { lockTaken = true; return 1; },
    jobInstance: {
      findMany: async () => [],
      createMany: async ({ data }) => { current.idempotencyKey = data[0].idempotencyKey; current.params = data[0].params; return { count: 0 }; },
      findUnique: async () => ({ ...current }),
      updateMany: async ({ where, data }) => {
        assert.equal(lockTaken, true);
        assert.equal(where.id, "job-terminal");
        current = { ...current, ...data, leaseRevision: current.leaseRevision + 1 };
        if (data.leaseRevision && typeof data.leaseRevision === "object") current.leaseRevision = 3;
        return { count: 1 };
      },
    },
  };

  const result = await planner.planWindow({
    db,
    creatorId: "creator-1",
    agencyId: "agency-1",
    displayRangeKey: "7d",
    scanFrom: new Date("2026-09-01T00:00:00.000Z"),
    scanTo: new Date("2026-09-07T00:00:00.000Z"),
    collectionReason: "INTERACTIVE_REFRESH",
    priority: 100,
    now: new Date("2026-09-08T14:05:00.000Z"),
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, "terminal_window_rescheduled");
  assert.equal(result.job.status, "SCHEDULED");
  assert.equal(result.job.priority, 100);
  assert.equal(result.job.params.scanFrom, "2026-09-01");
  assert.equal(result.job.params.scanTo, "2026-09-07");
  assert.equal(result.job.params.collectionReason, "INTERACTIVE_REFRESH");
});

test("one UTC-hour analytics sweep cycle has one durable owner across backend replicas", async () => {
  const db = {};
  addSweepLeaseStore(db);
  const cycleNow = new Date("2026-09-08T14:10:00.000Z");
  const wall = new Date("2026-09-08T14:10:00.000Z");

  const first = await planner.claimAnalyticsSweepCycle({ db, now: cycleNow, ownerToken: "replica-a", leaseNow: wall });
  assert.equal(first.acquired, true);
  assert.equal(first.cycleKey, "2026-09-08T14:00:00.000Z");

  const second = await planner.claimAnalyticsSweepCycle({
    db, now: new Date("2026-09-08T14:40:00.000Z"), ownerToken: "replica-b", leaseNow: new Date("2026-09-08T14:11:00.000Z"),
  });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "cycle_lease_held");

  assert.equal(await planner.completeAnalyticsSweepCycle({
    db, ownerToken: "replica-a", cycleKey: first.cycleKey, cursorCreatorId: "creator-250", completedAt: new Date("2026-09-08T14:12:00.000Z"),
  }), true);

  const lateSameCycle = await planner.claimAnalyticsSweepCycle({
    db, now: new Date("2026-09-08T14:55:00.000Z"), ownerToken: "replica-c", leaseNow: new Date("2026-09-08T14:50:00.000Z"),
  });
  assert.equal(lateSameCycle.acquired, false);
  assert.equal(lateSameCycle.reason, "cycle_completed");

  const nextCycle = await planner.claimAnalyticsSweepCycle({
    db, now: new Date("2026-09-08T15:01:00.000Z"), ownerToken: "replica-d", leaseNow: new Date("2026-09-08T15:01:00.000Z"),
  });
  assert.equal(nextCycle.acquired, true);
  assert.equal(nextCycle.reason, "new_cycle_claimed");
  assert.equal(nextCycle.cursorCreatorId, null);
});

test("expired analytics sweep lease is recoverable in the same cycle and resumes its cursor", async () => {
  const db = {};
  const store = addSweepLeaseStore(db);
  const first = await planner.claimAnalyticsSweepCycle({
    db, now: new Date("2026-09-08T14:05:00.000Z"), ownerToken: "replica-a", leaseNow: new Date("2026-09-08T14:05:00.000Z"),
  });
  assert.equal(first.acquired, true);
  assert.equal(await planner.renewAnalyticsSweepLease({
    db, ownerToken: "replica-a", cycleKey: first.cycleKey, cursorCreatorId: "creator-500", leaseNow: new Date("2026-09-08T14:06:00.000Z"),
  }), true);
  assert.equal(store.get().cursorCreatorId, "creator-500");

  const recovered = await planner.claimAnalyticsSweepCycle({
    db, now: new Date("2026-09-08T14:45:00.000Z"), ownerToken: "replica-b", leaseNow: new Date("2026-09-08T14:30:00.000Z"),
  });
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.reason, "cycle_lease_recovered");
  assert.equal(recovered.cursorCreatorId, "creator-500");
  assert.equal(recovered.cycleNow.toISOString(), "2026-09-08T14:05:00.000Z", "recovery keeps the original server-pinned cycle clock");
});

test("analytics recurring sweep cursor-pages every READY creator instead of silently stopping at 10k", async () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const creators = Array.from({ length: 55 }, (_, index) => ({
    id: `creator-${String(index + 1).padStart(3, "0")}`,
    agencyId: `agency-${index % 3}`,
  }));
  const window = planner.operationalFreshnessWindow(now);
  const allDays = daysInclusive(window.startDay, window.endDay);
  let creatorQueries = 0;
  const db = {
    creatorAccount: {
      findMany: async ({ where, take }) => {
        creatorQueries += 1;
        const after = where.id?.gt || null;
        const start = after ? creators.findIndex((row) => row.id === after) + 1 : 0;
        return creators.slice(start, start + take);
      },
    },
    analyticsCoverage: {
      findMany: async ({ where }) => {
        const ids = new Set(where.creatorId.in);
        return creators.filter((creator) => ids.has(creator.id)).flatMap((creator) => allDays.map((coverageDate) => ({
          creatorId: creator.id,
          coverageDate,
          status: coverageDate.getTime() === window.endDay.getTime() ? "PARTIAL" : "COMPLETE",
          lastVerifiedAt: now,
          retryAfterAt: null,
          scanProofId: `proof-${creator.id}-${isoDay(coverageDate)}`,
          scanProof: { status: "COMMITTED" },
        })));
      },
    },
  };
  addSweepLeaseStore(db);

  const result = await planner.runAnalyticsCollectionSweep({ db, now, pageSize: 25 });
  assert.equal(result.creators, 55);
  assert.equal(result.pages, 3);
  assert.equal(result.created, 0);
  assert.equal(result.dueDays, 0);
  assert.ok(creatorQueries >= 3);
});

test("next UTC-hour analytics cycle cannot preempt a still-live previous cycle lease", async () => {
  const db = {};
  addSweepLeaseStore(db);

  const first = await planner.claimAnalyticsSweepCycle({
    db,
    now: new Date("2026-09-08T14:59:50.000Z"),
    ownerToken: "replica-a",
    leaseNow: new Date("2026-09-08T14:59:50.000Z"),
  });
  assert.equal(first.acquired, true);
  assert.equal(first.cycleKey, "2026-09-08T14:00:00.000Z");

  const boundary = await planner.claimAnalyticsSweepCycle({
    db,
    now: new Date("2026-09-08T15:00:10.000Z"),
    ownerToken: "replica-b",
    leaseNow: new Date("2026-09-08T15:00:10.000Z"),
  });
  assert.equal(boundary.acquired, false);
  assert.equal(boundary.reason, "previous_cycle_lease_held");
  assert.equal(boundary.activeCycleKey, "2026-09-08T14:00:00.000Z");

  const afterExpiry = await planner.claimAnalyticsSweepCycle({
    db,
    now: new Date("2026-09-08T15:16:00.000Z"),
    ownerToken: "replica-c",
    leaseNow: new Date("2026-09-08T15:16:00.000Z"),
  });
  assert.equal(afterExpiry.acquired, true);
  assert.equal(afterExpiry.reason, "new_cycle_claimed");
  assert.equal(afterExpiry.cycleKey, "2026-09-08T15:00:00.000Z");
});


test("Home agency refresh enqueue is one durable demand and never loops creators inside the HTTP path", async () => {
  let creatorQueries = 0;
  const db = {
    creatorAccount: { findMany: async () => { creatorQueries += 1; throw new Error("creator loop must not run during enqueue"); } },
  };
  const store = addDemandStore(db);
  const result = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db,
    agencyId: "agency-1",
    creatorIds: null,
    rangeKey: "7d",
    includePrevious: true,
    ...DEMAND_ACTOR,
    now: new Date("2026-09-08T14:00:00.000Z"),
  });
  assert.equal(result.queued, true);
  assert.equal(result.coalesced, false);
  assert.equal(creatorQueries, 0);
  const row = store.get(result.key);
  assert.equal(isoDay(row.coverageFrom), "2026-08-26");
  assert.equal(isoDay(row.coverageTo), "2026-09-08");
  assert.equal(row.rangeKey, "7d");
  assert.equal(row.requestedByMemberId, "member-1");
  assert.equal(row.requestedAccessEpoch, 7);
  assert.equal(row.requestRevision, 1);
});

test("a refresh arriving during a claimed agency demand is not lost and schedules a new revision pass", async () => {
  const db = {};
  const store = addDemandStore(db);
  const first = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:00.000Z"),
  });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:01.000Z"), ownerToken: "replica-a" });
  assert.equal(claimed.claimedRevision, 1);

  const second = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:02.000Z"),
  });
  assert.equal(second.key, first.key);
  assert.equal(second.requestRevision, 2);
  assert.equal(store.get(first.key).claimToken, "replica-a", "live claim is not stolen by enqueue");

  const settled = await planner.settleAnalyticsDemand({ db, demand: claimed, completedAt: new Date("2026-09-08T14:00:03.000Z") });
  assert.equal(settled.completed, false);
  assert.equal(settled.reason, "newer_revision_pending");
  const pending = store.get(first.key);
  assert.equal(pending.completedAt, null);
  assert.equal(pending.cursorCreatorId, null);

  const reclaimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:04.000Z"), ownerToken: "replica-b" });
  assert.equal(reclaimed.claimedRevision, 2);
  assert.equal(reclaimed.cursorCreatorId, null);
});

test("durable agency demand processing is cursor-paginated and does not create provider work for fresh coverage", async () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const creators = Array.from({ length: 55 }, (_, index) => ({ id: `creator-${String(index + 1).padStart(3, "0")}`, agencyId: "agency-1" }));
  let creatorQueries = 0;
  const db = {
    creatorAccount: {
      findMany: async ({ where, take }) => {
        creatorQueries += 1;
        const after = where.id?.gt || null;
        const start = after ? creators.findIndex((row) => row.id === after) + 1 : 0;
        return creators.slice(start, start + take);
      },
    },
    analyticsCoverage: {
      findMany: async ({ where }) => {
        const ids = new Set(where.creatorId.in);
        return creators.filter((creator) => ids.has(creator.id)).flatMap((creator) => daysInclusive(where.coverageDate.gte, where.coverageDate.lte).map((coverageDate) => ({
          creatorId: creator.id,
          coverageDate,
          status: isoDay(coverageDate) === isoDay(where.coverageDate.lte) ? "PARTIAL" : "COMPLETE",
          lastVerifiedAt: now,
          retryAfterAt: null,
          scanProofId: `proof-${creator.id}-${isoDay(coverageDate)}`,
          scanProof: { status: "COMMITTED" },
        })));
      },
    },
  };
  addDemandAuthority(db);
  const store = addDemandStore(db);
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: "agency-1", rangeKey: "7d", includePrevious: true, ...DEMAND_ACTOR, now });
  const result = await planner.runAnalyticsCollectionDemandSweep({ db, now: new Date("2026-09-08T14:00:01.000Z"), maxDemands: 1, pageSize: 25 });
  assert.equal(result.demands, 1);
  assert.equal(result.creators, 55);
  assert.equal(result.pages, 3);
  assert.equal(result.created, 0);
  assert.equal(result.dueDays, 0);
  assert.ok(creatorQueries >= 3);
  const row = store.get(queued.key);
  assert.equal(row.completedRevision, 1);
  assert.ok(row.completedAt instanceof Date);
});


test("deferred Home refresh is cancelled before creator scheduling when requester accessEpoch changes", async () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  let creatorQueries = 0;
  const db = {
    creatorAccount: { findMany: async () => { creatorQueries += 1; return []; } },
    analyticsCoverage: { findMany: async () => [] },
  };
  const authority = addDemandAuthority(db);
  const store = addDemandStore(db);
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now,
  });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date(now.getTime() + 1000), ownerToken: "replica-a" });
  authority.set({ accessEpoch: 8 });

  const result = await planner.processAnalyticsDemand({ db, demand: claimed, now: new Date(now.getTime() + 2000) });
  assert.equal(result.accessDenied, true);
  assert.equal(result.created, 0);
  assert.equal(creatorQueries, 0, "stale access must be fenced before any creator/provider planning query");
  const row = store.get(queued.key);
  assert.equal(row.completedRevision, 1);
  assert.ok(row.completedAt instanceof Date);
  assert.equal(row.lastError, "ANALYTICS_DEMAND_ACCESS_EPOCH_CHANGED");
});

test("deferred Home refresh is cancelled when requester is deactivated or refresh permission is revoked", async () => {
  for (const scenario of ["deactivated", "permission"]) {
    const now = new Date("2026-09-08T14:00:00.000Z");
    let creatorQueries = 0;
    const db = {
      creatorAccount: { findMany: async () => { creatorQueries += 1; return []; } },
      analyticsCoverage: { findMany: async () => [] },
    };
    const authority = addDemandAuthority(db, scenario === "permission" ? { role: "OPERATOR", roleKey: "chatter", permissions: { "creator_analytics.refresh": false } } : {});
    const store = addDemandStore(db);
    const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now });
    const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date(now.getTime() + 1000), ownerToken: `replica-${scenario}` });
    if (scenario === "deactivated") authority.set({ deactivatedAt: new Date(now.getTime() + 1500) });

    const result = await planner.processAnalyticsDemand({ db, demand: claimed, now: new Date(now.getTime() + 2000) });
    assert.equal(result.accessDenied, true);
    assert.equal(result.created, 0);
    assert.equal(creatorQueries, 0);
    assert.match(store.get(queued.key).lastError, /ANALYTICS_DEMAND_(MEMBER_REVOKED|PERMISSION_REVOKED)/);
  }
});

test("accessEpoch revocation during a large demand is fenced within the 25-creator heartbeat chunk", async () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const creators = Array.from({ length: 55 }, (_, index) => ({ id: `creator-${String(index + 1).padStart(3, "0")}`, agencyId: "agency-1" }));
  let fenceReads = 0;
  const db = {
    creatorAccount: { findMany: async ({ take }) => creators.slice(0, take) },
    analyticsCoverage: { findMany: async ({ where }) => {
      const ids = new Set(where.creatorId.in);
      return creators.filter((creator) => ids.has(creator.id)).flatMap((creator) => daysInclusive(where.coverageDate.gte, where.coverageDate.lte).map((coverageDate) => ({
        creatorId: creator.id, coverageDate, status: isoDay(coverageDate) === isoDay(where.coverageDate.lte) ? "PARTIAL" : "COMPLETE",
        lastVerifiedAt: now, retryAfterAt: null, scanProofId: `proof-${creator.id}-${isoDay(coverageDate)}`, scanProof: { status: "COMMITTED" },
      })));
    } },
  };
  const authority = addDemandAuthority(db);
  const originalFind = db.agencyMember.findFirst;
  db.agencyMember.findFirst = async (args) => {
    fenceReads += 1;
    // 1 = full authority resolve, 2 = page-start epoch fence, 3 = 25-creator fence.
    if (fenceReads === 3) authority.set({ accessEpoch: 8 });
    return originalFind(args);
  };
  const store = addDemandStore(db);
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date(now.getTime() + 1000), ownerToken: "replica-a" });
  const result = await planner.processAnalyticsDemand({ db, demand: claimed, pageSize: 100, now: new Date(now.getTime() + 2000) });
  assert.equal(result.accessDenied, true);
  assert.equal(store.get(queued.key).lastError, "ANALYTICS_DEMAND_ACCESS_EPOCH_CHANGED");
  assert.ok(fenceReads >= 3);
});

test("newer demand revision wins over stale actor cancellation instead of being lost", async () => {
  const db = {};
  const authority = addDemandAuthority(db);
  const store = addDemandStore(db);
  const first = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:00.000Z"),
  });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:01.000Z"), ownerToken: "replica-old" });
  authority.set({ id: "member-2", userId: "user-2", accessEpoch: 12, role: "OWNER", roleKey: "owner", assignedCreators: "all", permissions: {} });
  await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", requestedByMemberId: "member-2", requestedAccessEpoch: 12,
    now: new Date("2026-09-08T14:00:02.000Z"),
  });
  // The claimed revision still carries member-1; it is now stale. Settlement must release for revision 2.
  const result = await planner.processAnalyticsDemand({ db, demand: claimed, now: new Date("2026-09-08T14:00:03.000Z") });
  assert.equal(result.accessDenied, true);
  assert.equal(result.settled.completed, false);
  assert.equal(result.settled.reason, "newer_revision_pending");
  const row = store.get(first.key);
  assert.equal(row.requestRevision, 2);
  assert.equal(row.completedAt, null);
  assert.equal(row.requestedByMemberId, "member-2");
});
