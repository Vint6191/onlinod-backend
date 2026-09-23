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
      if (where.leaseUntil?.gt && !(lease.leaseUntil > where.leaseUntil.gt)) return { count: 0 };
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
      if (where.claimUntil?.gt && !(current.claimUntil > where.claimUntil.gt)) return { count: 0 };
      if (where.quarantinedAt === null && current.quarantinedAt != null) return { count: 0 };
      rows.set(where.key, { ...current, ...data, updatedAt: new Date() });
      return { count: 1 };
    },
    findFirst: async ({ where }) => {
      const andRows = Array.isArray(where.AND) ? where.AND : [];
      const claimNow = andRows.flatMap((entry) => entry.OR || []).find((item) => item.claimUntil?.lte)?.claimUntil?.lte || new Date();
      const retryNow = andRows.flatMap((entry) => entry.OR || []).find((item) => item.nextAttemptAt?.lte)?.nextAttemptAt?.lte || claimNow;
      const candidates = [...rows.values()].filter((row) => row.completedAt == null
        && row.quarantinedAt == null
        && !(where.agencyId?.notIn || []).includes(row.agencyId)
        && (row.claimUntil == null || new Date(row.claimUntil) <= claimNow)
        && (row.nextAttemptAt == null || new Date(row.nextAttemptAt) <= retryNow));
      candidates.sort((a, b) => Number(new Date(a.nextAttemptAt || 0)) - Number(new Date(b.nextAttemptAt || 0)) || Number(b.priority || 0) - Number(a.priority || 0) || new Date(a.requestedAt) - new Date(b.requestedAt) || String(a.key).localeCompare(String(b.key)));
      return candidates.length ? { ...candidates[0] } : null;
    },
  };
  return {
    get: (key) => rows.has(key) ? { ...rows.get(key) } : null,
    all: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

for (const operation of ["renew", "complete"]) {
  test(`Analytics ${operation} rejects an expired owner even without a replacement`, async () => {
    const db = {};
    const store = addSweepLeaseStore(db);
    const now = new Date("2026-09-08T14:59:00Z");
    const claim = await planner.claimAnalyticsSweepCycle({ db, now, leaseNow: now, ownerToken: "old", leaseMs: 1000 });
    const before = store.get();
    const expired = new Date(now.getTime() + 1000);
    const args = { db, ownerToken: claim.ownerToken, cycleKey: claim.cycleKey, cursorCreatorId: "must-not-commit", leaseNow: expired, completedAt: expired };
    const result = operation === "renew" ? await planner.renewAnalyticsSweepLease(args) : await planner.completeAnalyticsSweepCycle(args);
    assert.equal(result, false);
    assert.deepEqual(store.get(), before);
  });
}

test("Analytics restart across hours preserves unfinished cursor and original cycle time", async () => {
  const db = {};
  addSweepLeaseStore(db);
  const now = new Date("2026-09-08T14:00:00Z");
  const first = await planner.claimAnalyticsSweepCycle({ db, now, leaseNow: now, ownerToken: "old" });
  await planner.renewAnalyticsSweepLease({ db, ...first, leaseNow: now, cursorCreatorId: "creator-500" });
  const restartAt = new Date("2026-09-08T16:00:00Z");
  const recovered = await planner.claimAnalyticsSweepCycle({ db, now: restartAt, leaseNow: restartAt, ownerToken: "replacement" });
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.cursorCreatorId, "creator-500");
  assert.equal(recovered.cycleKey, first.cycleKey);
  assert.deepEqual(recovered.cycleNow, first.cycleNow);
  assert.equal(await planner.completeAnalyticsSweepCycle({ db, ...recovered, completedAt: restartAt }), true);
  const next = await planner.claimAnalyticsSweepCycle({ db, now: restartAt, leaseNow: restartAt, ownerToken: "next" });
  assert.equal(next.cycleKey, "2026-09-08T16:00:00.000Z");
  assert.equal(next.cursorCreatorId, null);
});

for (const operation of ["renew", "complete", "quarantine", "yield"]) {
  test(`Home demand ${operation} rejects expiry without changing durable state`, async () => {
    const db = {};
    const store = addDemandStore(db);
    const now = new Date("2026-09-08T14:00:00Z");
    await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: "agency-1", ...DEMAND_ACTOR, now });
    const demand = await planner.claimNextAnalyticsDemand({ db, now, ownerToken: "old" });
    const before = store.get(demand.key);
    const expired = new Date(now.getTime() + planner.DEMAND_LEASE_MS);
    if (operation === "renew") {
      assert.equal(await planner.renewAnalyticsDemandLease({ db, ...demand, now: expired }), false);
    } else {
      const error = operation === "quarantine" ? Object.assign(new Error("bad range"), { code: "ANALYTICS_DEMAND_RANGE_INVALID" }) : null;
      assert.deepEqual(await planner.settleAnalyticsDemand({ db, demand, completedAt: expired, error, yieldContinuation: operation === "yield" }), { settled: false, reason: "claim_lost" });
    }
    assert.deepEqual(store.get(demand.key), before);
  });
}

test("Analytics lease checks database time after waiting for the row lock", async () => {
  const db = {};
  addSweepLeaseStore(db);
  const now = new Date("2026-09-08T14:00:00Z");
  const claim = await planner.claimAnalyticsSweepCycle({ db, now, leaseNow: now, ownerToken: "old", leaseMs: 1000 });
  let clock = now;
  const events = [];
  db.$queryRawUnsafe = async (sql) => {
    if (/FOR UPDATE/.test(sql)) { events.push("lock"); clock = new Date(now.getTime() + 1000); return [{ key: planner.SWEEP_LEASE_KEY }]; }
    assert.match(sql, /clock_timestamp/);
    events.push("clock");
    return [{ authorityNow: clock }];
  };
  assert.equal(await planner.renewAnalyticsSweepLease({ db, ...claim, leaseNow: now }), false);
  assert.deepEqual(events, ["lock", "clock"]);
});

test("Home claim re-reads completion after locking its selected candidate", async () => {
  const db = {};
  addDemandStore(db);
  const now = new Date("2026-09-08T14:00:00Z");
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: "agency-1", ...DEMAND_ACTOR, now });
  db.$queryRawUnsafe = async (sql) => {
    if (/FOR UPDATE/.test(sql)) {
      await db.analyticsCollectionDemand.update({ where: { key: queued.key }, data: { completedAt: now } });
      return [{ key: queued.key }];
    }
    assert.match(sql, /clock_timestamp/);
    return [{ authorityNow: now }];
  };
  assert.equal(await planner.claimNextAnalyticsDemand({ db, now }), null);
});

test("Home sweep reports processing failure instead of a healthy success", async () => {
  const db = {};
  addDemandStore(db);
  addDemandAuthority(db);
  const now = new Date("2026-09-08T14:00:00Z");
  await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: "agency-1", ...DEMAND_ACTOR, now });
  db.creatorAccount = { findMany: async () => { throw Object.assign(new Error("database unavailable"), { code: "P1001" }); } };
  const result = await planner.runAnalyticsCollectionDemandSweep({ db, now, maxDemands: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.failures, 1);
});

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

test("dense missing earnings history uses proven 30-day provider windows while sparse gaps stay narrow", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const start = new Date("2026-06-01T00:00:00.000Z");
  const dense = Array.from({ length: 90 }, (_, index) => new Date(start.getTime() + index * 86_400_000));
  const windows = planner.windowsForDueDays(dense, now);
  assert.equal(windows.length, 3);
  assert.ok(windows.every((window) => ((window.scanTo - window.scanFrom) / 86_400_000) + 1 <= 30));
  assert.equal(windows[0].scanFrom.toISOString().slice(0, 10), "2026-06-01");
  assert.equal(windows.at(-1).scanTo.toISOString().slice(0, 10), "2026-08-29");
  assert.equal(planner.DENSE_BACKFILL_MAX_DAYS, 30);
});

test("old earnings reconciliation policy is explicit: recurring owns only current plus 30 closed days and older history is interactive-demand driven", () => {
  const now = new Date("2026-09-08T14:00:00.000Z");
  const window = planner.operationalFreshnessWindow(now);
  assert.equal(window.startDay.toISOString().slice(0, 10), "2026-08-09");
  assert.equal(window.endDay.toISOString().slice(0, 10), "2026-09-08");
  assert.equal(planner.EARNINGS_RECONCILIATION_POLICY.oldHistoryMode, "INTERACTIVE_DEMAND");
  assert.equal(planner.EARNINGS_RECONCILIATION_POLICY.recurringClosedDays, 30);
  assert.equal(planner.EARNINGS_RECONCILIATION_POLICY.denseBackfillMaxDays, 30);
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
  assert.equal(afterExpiry.reason, "previous_cycle_recovered");
  assert.equal(afterExpiry.cycleKey, first.cycleKey);
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

test("Home demand yields bounded slices and resumes its durable cursor across three workers", async () => {
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
  for (const [index, count] of [25, 25, 5].entries()) {
    // The default maxDemands=4 must not reclaim this same agency in one pulse.
    const result = await planner.runAnalyticsCollectionDemandSweep({ db, now: new Date(now.getTime() + (index + 1) * 1000), pageSize: 25 });
    assert.equal(result.ok, true);
    assert.equal(result.demands, 1);
    assert.equal(result.creators, count);
    assert.equal(result.pages, 1);
    assert.equal(result.created, 0);
    assert.equal(result.dueDays, 0);
    assert.equal(result.yielded, index < 2 ? 1 : 0);
    const progress = store.get(queued.key);
    assert.equal(progress.cursorCreatorId, creators[Math.min((index + 1) * 25, 55) - 1].id);
    assert.equal(progress.claimToken, null);
    if (index < 2) assert.equal(progress.completedAt, null);
  }
  assert.equal(creatorQueries, 3);
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

test("accessEpoch revocation during demand processing is checked before each creator", async () => {
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
    // 1 = full authority resolve, 2 = page-start fence, 3 = first creator fence.
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


test("a terminal failure from an old claimed revision cannot quarantine a newer refresh revision", async () => {
  const db = {};
  const store = addDemandStore(db);
  const first = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:00.000Z"),
  });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:01.000Z"), ownerToken: "replica-old" });
  const second = await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:02.000Z"),
  });
  assert.equal(second.key, first.key);
  assert.equal(second.requestRevision, 2);
  const terminal = Object.assign(new Error("old revision contract failure"), { code: "ANALYTICS_DEMAND_SCOPE_CORRUPT" });
  const settled = await planner.settleAnalyticsDemand({
    db, demand: claimed, completedAt: new Date("2026-09-08T14:00:03.000Z"), error: terminal,
  });
  assert.equal(settled.completed, false);
  assert.equal(settled.retry, true);
  assert.equal(settled.reason, "newer_revision_pending");
  const pending = store.get(first.key);
  assert.equal(pending.requestRevision, 2);
  assert.equal(pending.completedAt, null);
  assert.equal(pending.attempts, 0);
  assert.equal(pending.nextAttemptAt.toISOString(), "2026-09-08T14:00:03.000Z");
  assert.equal(pending.quarantinedAt, null);
  assert.equal(pending.lastErrorClass, null);
  const reclaimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:04.000Z"), ownerToken: "replica-new" });
  assert.equal(reclaimed.claimedRevision, 2);
});

test("transient analytics demand failures back off and are not immediately reclaimable", async () => {
  const db = {};
  const store = addDemandStore(db);
  await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:00.000Z"),
  });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:01.000Z"), ownerToken: "replica-a" });
  const error = Object.assign(new Error("database temporarily unavailable"), { code: "P1001" });
  claimed.cursorCreatorId = "creator-025";
  const settled = await planner.settleAnalyticsDemand({ db, demand: claimed, completedAt: new Date("2026-09-08T14:00:02.000Z"), error });
  assert.equal(settled.retry, true);
  assert.equal(settled.quarantined, false);
  assert.equal(settled.errorClass, "TRANSIENT");
  assert.equal(settled.attempts, 1);
  assert.equal(settled.nextAttemptAt.toISOString(), "2026-09-08T14:00:32.000Z");
  const row = store.get(claimed.key);
  assert.equal(row.lastErrorClass, "TRANSIENT");
  assert.equal(await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:10.000Z"), ownerToken: "replica-b" }), null);
  const retry = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:33.000Z"), ownerToken: "replica-b" });
  assert.equal(retry.key, claimed.key);
  assert.equal(retry.claimedRevision, claimed.claimedRevision);
  assert.equal(retry.cursorCreatorId, "creator-025", "retry must retain completed creator progress");
});

test("persistent analytics demand contract corruption quarantines immediately", async () => {
  const db = {};
  const store = addDemandStore(db);
  await planner.enqueueAgencyAnalyticsFreshnessDemand({
    db, agencyId: "agency-1", rangeKey: "7d", ...DEMAND_ACTOR, now: new Date("2026-09-08T14:00:00.000Z"),
  });
  const claimed = await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-08T14:00:01.000Z"), ownerToken: "replica-a" });
  const error = Object.assign(new Error("creator scope payload is corrupt"), { code: "ANALYTICS_DEMAND_SCOPE_CORRUPT" });
  const settled = await planner.settleAnalyticsDemand({ db, demand: claimed, completedAt: new Date("2026-09-08T14:00:02.000Z"), error });
  assert.equal(settled.retry, false);
  assert.equal(settled.quarantined, true);
  assert.equal(settled.errorClass, "CONTRACT");
  const row = store.get(claimed.key);
  assert.equal(row.lastErrorClass, "CONTRACT");
  assert.ok(row.quarantinedAt instanceof Date);
  assert.equal(row.nextAttemptAt, null);
  assert.equal(await planner.claimNextAnalyticsDemand({ db, now: new Date("2026-09-09T14:00:00.000Z"), ownerToken: "replica-b" }), null);
});

function boundedDemandFixture(count = 10, member = {}) {
  const now = new Date("2026-09-08T14:00:00Z");
  const creators = Array.from({ length: count }, (_, index) => ({ id: `creator-${String(index).padStart(3, "0")}`, agencyId: "agency-1" }));
  const reads = [];
  const covered = [];
  const db = {
    creatorAccount: { findMany: async (query) => {
      reads.push(query);
      const { where, take } = query;
      return creators.filter((c) => c.agencyId === where.agencyId && (!where.id?.in || where.id.in.includes(c.id)) && (!where.id?.gt || c.id > where.id.gt)).slice(0, take);
    } },
    analyticsCoverage: { findMany: async ({ where }) => {
      covered.push(...where.creatorId.in);
      return where.creatorId.in.flatMap((creatorId) => daysInclusive(where.coverageDate.gte, where.coverageDate.lte).map((coverageDate) => ({
        creatorId, coverageDate, status: "COMPLETE", lastVerifiedAt: now,
        scanProofId: "committed", scanProof: { status: "COMMITTED" },
      })));
    } },
  };
  const store = addDemandStore(db);
  addDemandAuthority(db, member);
  return { db, store, now, creators, reads, covered };
}

test("Home demand processes only explicitly requested creators within current authority", async () => {
  for (const scoped of [false, true]) {
    const f = boundedDemandFixture(10, scoped ? { role: "MANAGER", roleKey: "manager", permissions: { "creator_analytics.refresh": true }, assignedCreators: ["creator-002", "creator-003"] } : {});
    await planner.enqueueAgencyAnalyticsFreshnessDemand({ db: f.db, agencyId: "agency-1", ...DEMAND_ACTOR, now: f.now, creatorIds: ["creator-002", "creator-009", "foreign-creator"] });
    const result = await planner.runAnalyticsCollectionDemandSweep({ db: f.db, now: f.now });
    assert.equal(result.ok, true);
    assert.deepEqual(f.covered, scoped ? ["creator-002"] : ["creator-002", "creator-009"]);
    assert.equal(result.yielded, 0);
  }
});

test("Home demand clamps large slice requests and persists the exact bounded continuation", async () => {
  const f = boundedDemandFixture(1000);
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db: f.db, agencyId: "agency-1", ...DEMAND_ACTOR, now: f.now });
  const result = await planner.runAnalyticsCollectionDemandSweep({ db: f.db, now: f.now, maxCreators: 4000, pageSize: 4000 });
  assert.equal(result.creators, 100);
  assert.equal(result.yielded, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].take, 101);
  assert.equal(f.covered.length, 100);
  assert.equal(f.store.get(queued.key).cursorCreatorId, "creator-099");
  assert.equal(f.store.get(queued.key).completedAt, null);
});

test("Home demand failure after one successful creator preserves progress and retry resumes the unfinished creator", async () => {
  const f = boundedDemandFixture(3);
  const freshCoverage = f.db.analyticsCoverage.findMany;
  f.db.analyticsCoverage.findMany = async (args) => (await freshCoverage(args)).filter((row) => row.creatorId === "creator-000");
  f.db.jobInstance = { findMany: async () => { throw Object.assign(new Error("connection reset during planning"), { code: "P1001" }); } };
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db: f.db, agencyId: "agency-1", ...DEMAND_ACTOR, now: f.now, rangeKey: "today", includePrevious: false });
  const result = await planner.runAnalyticsCollectionDemandSweep({ db: f.db, now: f.now });
  assert.equal(result.ok, false);
  const failed = f.store.get(queued.key);
  assert.equal(failed.cursorCreatorId, "creator-000");
  assert.equal(failed.lastErrorCode, "P1001");
  f.db.analyticsCoverage.findMany = freshCoverage;
  const retry = await planner.runAnalyticsCollectionDemandSweep({ db: f.db, now: new Date(f.now.getTime() + 31_000) });
  assert.equal(retry.ok, true);
  assert.equal(retry.creators, 2);
  assert.equal(f.reads.at(-1).where.id.gt, "creator-000");
  assert.ok(f.store.get(queued.key).completedAt);
});

test("Home demand time budget yields after progress without dropping the next creator", async (t) => {
  const f = boundedDemandFixture();
  const { performance } = require("node:perf_hooks");
  let clock = 0;
  t.mock.method(performance, "now", () => { clock += 100; return clock; });
  const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db: f.db, agencyId: "agency-1", ...DEMAND_ACTOR, now: f.now });
  const result = await planner.runAnalyticsCollectionDemandSweep({ db: f.db, now: f.now, budgetMs: 1 });
  assert.equal(result.creators, 1);
  assert.equal(result.yielded, 1);
  const retry = await planner.claimNextAnalyticsDemand({ db: f.db, now: f.now });
  assert.equal(retry.key, queued.key);
  assert.equal(retry.cursorCreatorId, "creator-000");
});

test("Home demand rotates yielded work behind another due agency and newer revision resets progress", async () => {
  const db = {};
  addDemandStore(db);
  const now = new Date("2026-09-08T14:00:00Z");
  for (const agencyId of ["agency-1", "agency-2"]) await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId, ...DEMAND_ACTOR, now });
  const first = await planner.claimNextAnalyticsDemand({ db, now });
  first.cursorCreatorId = "creator-025";
  await planner.settleAnalyticsDemand({ db, demand: first, completedAt: new Date(now.getTime() + 1000), yieldContinuation: true });
  const other = await planner.claimNextAnalyticsDemand({ db, now: new Date(now.getTime() + 2000) });
  assert.notEqual(other.agencyId, first.agencyId);
  const resumed = await planner.claimNextAnalyticsDemand({ db, now: new Date(now.getTime() + 3000) });
  assert.equal(resumed.cursorCreatorId, "creator-025");
  await planner.enqueueAgencyAnalyticsFreshnessDemand({ db, agencyId: first.agencyId, ...DEMAND_ACTOR, now: new Date(now.getTime() + 4000) });
  const settlement = await planner.settleAnalyticsDemand({ db, demand: resumed, completedAt: new Date(now.getTime() + 5000), yieldContinuation: true });
  assert.equal(settlement.reason, "newer_revision_pending");
  const next = await planner.claimNextAnalyticsDemand({ db, now: new Date(now.getTime() + 6000) });
  assert.equal(next.claimedRevision, 2);
  assert.equal(next.cursorCreatorId, null);
});

test("Home demand rejects all-history admission and quarantines corrupt persisted scope or range before creator reads", async () => {
  for (const badData of [{ coverageFrom: new Date("2016-01-01") }, { creatorIds: { all: true } }]) {
    const f = boundedDemandFixture();
    await assert.rejects(() => planner.enqueueAgencyAnalyticsFreshnessDemand({ db: f.db, agencyId: "agency-1", ...DEMAND_ACTOR, now: f.now, rangeKey: "all" }), { code: "HOME_RANGE_UNSUPPORTED" });
    const queued = await planner.enqueueAgencyAnalyticsFreshnessDemand({ db: f.db, agencyId: "agency-1", ...DEMAND_ACTOR, now: f.now });
    await f.db.analyticsCollectionDemand.update({ where: { key: queued.key }, data: badData });
    const result = await planner.runAnalyticsCollectionDemandSweep({ db: f.db, now: f.now });
    assert.equal(result.ok, false);
    assert.equal(f.reads.length, 0);
    assert.equal(f.store.get(queued.key).lastErrorClass, "CONTRACT");
    assert.ok(f.store.get(queued.key).quarantinedAt);
  }
});
