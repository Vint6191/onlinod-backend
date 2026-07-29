"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
const intelligenceModule = require.resolve("./dialog-intelligence-service");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
require.cache[intelligenceModule] = {
  id: intelligenceModule,
  filename: intelligenceModule,
  loaded: true,
  exports: { restartCreatorDialogPlan: async () => ({ ok: true, created: true }) },
};
delete require.cache[require.resolve("./dialog-offline-recovery-service")];
const {
  OFFLINE_DIALOG_RECOVERY_GAP_MS,
  hasLongOfflineGap,
  hasRealtimeCoverageClockSkew,
  scheduleOfflineDialogRecovery,
  shouldPreserveRealtimeCoverage,
} = require("./dialog-offline-recovery-service");

const NOW = new Date("2026-07-25T10:00:00.000Z");

function dbFixture({
  baseline = true,
  latest = null,
  active = null,
  unfinished = null,
  completedBaseline = null,
  completedRecovery = undefined,
  latestAfter = undefined,
} = {}) {
  let latestReads = 0;
  const ordinaryBaseline = baseline ? (completedBaseline || {
    id: "baseline-run",
    source: "initial_full_scan",
    generation: 7,
    createdAt: new Date("2026-07-24T00:00:00.000Z"),
    completedAt: new Date("2026-07-24T00:00:00.000Z"),
  }) : null;
  const recoveryBaseline = completedRecovery === undefined
    ? (ordinaryBaseline?.source === "offline_gap_recovery" ? ordinaryBaseline : null)
    : completedRecovery;
  return {
    dialogScanRun: {
      async findFirst({ where }) {
        if (where.status === "COMPLETED" && where.source === "offline_gap_recovery") {
          return recoveryBaseline;
        }
        if (where.status === "COMPLETED") return ordinaryBaseline;
        if (where.status?.in) return active;
        latestReads += 1;
        if (latestReads > 1 && latestAfter !== undefined) return latestAfter;
        return latest || (baseline ? {
          id: "baseline-run",
          status: "COMPLETED",
          source: ordinaryBaseline?.source || "initial_full_scan",
          generation: 7,
          continuation: {},
          createdAt: new Date("2026-07-24T00:00:00.000Z"),
          updatedAt: new Date("2026-07-24T00:00:00.000Z"),
        } : null);
      },
    },
    dialogScanState: {
      async findFirst() { return unfinished; },
    },
  };
}

test("offline gap threshold is one hour across all creator bindings", () => {
  assert.equal(hasLongOfflineGap(new Date(NOW.getTime() - OFFLINE_DIALOG_RECOVERY_GAP_MS + 1), NOW), false);
  assert.equal(hasLongOfflineGap(new Date(NOW.getTime() - OFFLINE_DIALOG_RECOVERY_GAP_MS), NOW), true);
  assert.equal(hasLongOfflineGap(null, NOW), false);
});

test("a short device gap does not schedule dialog recovery", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 30 * 60_000),
    now: NOW,
    db: dbFixture(),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "gap_below_threshold");
  assert.equal(calls, 0);
});

test("recovery waits for an authoritative initial discovery baseline", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({ baseline: false }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "baseline_missing");
  assert.equal(calls, 0);
});

test("the first offline gap uses an ordinary completed baseline and schedules recovery", async () => {
  const calls = [];
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({ completedRecovery: null }),
    schedule: async (input) => {
      calls.push(input);
      return { ok: true, created: true, run: { id: "first-recovery" } };
    },
  });
  assert.equal(result.created, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "offline_gap_recovery");
});

test("a creator-wide gap over one hour schedules one head-aware incremental recovery", async () => {
  const calls = [];
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture(),
    schedule: async (input) => {
      calls.push(input);
      return { ok: true, created: true, run: { id: "recovery-run" } };
    },
  });
  assert.equal(result.created, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].childMode, "incremental");
  assert.equal(calls[0].forceChildFull, false);
  assert.equal(calls[0].source, "offline_gap_recovery");
  assert.equal(calls[0].knownMessageThreshold, 1);
  assert.equal(calls[0].maxPages, 10_000);
});

test("paused or already active history is not duplicated by heartbeat recovery", async () => {
  let calls = 0;
  const paused = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      latest: {
        id: "latest-run",
        status: "COMPLETED",
        continuation: { historyControl: { state: "PAUSED" } },
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(paused.reason, "history_paused");

  const active = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({ active: { id: "active-run", status: "RUNNING", source: "offline_gap_recovery" } }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(active.reason, "already_in_flight");
  assert.equal(calls, 0);
});


test("a settled scan completed after the offline boundary closes the same gap exactly once", async () => {
  let calls = 0;
  const lastCoveredAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt,
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "recovery-complete",
        source: "offline_gap_recovery",
        generation: 9,
        createdAt: new Date(NOW.getTime() - 45 * 60_000),
        completedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
      latest: {
        id: "recovery-complete",
        source: "offline_gap_recovery",
        generation: 9,
        status: "COMPLETED",
        continuation: {},
        createdAt: new Date(NOW.getTime() - 45 * 60_000),
        updatedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "gap_already_recovered");
  assert.equal(calls, 0);
  assert.equal(shouldPreserveRealtimeCoverage(result), false);
});

test("completed discovery does not close coverage while its planned history remains", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "recovery-heads-only",
        source: "offline_gap_recovery",
        generation: 10,
        createdAt: new Date(NOW.getTime() - 40 * 60_000),
        completedAt: new Date(NOW.getTime() - 10 * 60_000),
      },
      latest: {
        id: "recovery-heads-only",
        source: "offline_gap_recovery",
        generation: 10,
        status: "COMPLETED",
        continuation: {},
      },
      unfinished: { id: "dialog-pending" },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(calls, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("a superseded recovery generation cannot look settled after mutable state rows move forward", async () => {
  let calls = 0;
  const oldRecovery = {
    id: "recovery-generation-20",
    source: "offline_gap_recovery",
    generation: 20,
    createdAt: new Date(NOW.getTime() - 50 * 60_000),
    completedAt: new Date(NOW.getTime() - 20 * 60_000),
  };
  const newerDiscovery = {
    id: "ordinary-generation-21",
    source: "manual",
    generation: 21,
    status: "COMPLETED",
    continuation: {},
    createdAt: new Date(NOW.getTime() - 15 * 60_000),
    updatedAt: new Date(NOW.getTime() - 5 * 60_000),
    completedAt: new Date(NOW.getTime() - 5 * 60_000),
  };
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: newerDiscovery,
      completedRecovery: oldRecovery,
      latest: newerDiscovery,
      // DialogScanState is mutable and now contains only generation 21 rows.
      // The old buggy query for generation 20 therefore returned no unfinished
      // state and falsely released the realtime fence.
      unfinished: null,
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(calls, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("a discovery that starts during the settlement check keeps the old recovery fenced", async () => {
  let calls = 0;
  const recovery = {
    id: "recovery-race-30",
    source: "offline_gap_recovery",
    generation: 30,
    status: "COMPLETED",
    continuation: {},
    createdAt: new Date(NOW.getTime() - 45 * 60_000),
    updatedAt: new Date(NOW.getTime() - 5 * 60_000),
    completedAt: new Date(NOW.getTime() - 5 * 60_000),
  };
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: recovery,
      completedRecovery: recovery,
      latest: recovery,
      unfinished: null,
      latestAfter: {
        id: "new-discovery-31",
        source: "manual",
        generation: 31,
        status: "RUNNING",
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "concurrent_creator_plan_won");
  assert.equal(calls, 0);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});


test("a pause applied during the settlement query cannot release or restart the old gap", async () => {
  let calls = 0;
  const recovery = {
    id: "recovery-pause-race",
    source: "offline_gap_recovery",
    generation: 44,
    status: "COMPLETED",
    continuation: {},
    createdAt: new Date(NOW.getTime() - 45 * 60_000),
    updatedAt: new Date(NOW.getTime() - 5 * 60_000),
    completedAt: new Date(NOW.getTime() - 5 * 60_000),
  };
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: recovery,
      completedRecovery: recovery,
      latest: recovery,
      unfinished: null,
      latestAfter: { ...recovery, continuation: { historyControl: { state: "PAUSED" } } },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "history_paused");
  assert.equal(calls, 0);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("only an explicitly recovered or non-existent gap releases the old contiguous boundary", () => {
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "history_paused" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "history_cancelled" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "already_in_flight" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: false, created: false, reason: "recovery_schedule_failed" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "module_disabled" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "concurrent_creator_plan_won" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "durable_run_resumed" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "baseline_missing" }), true);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "gap_already_recovered" }), false);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "gap_below_threshold" }), false);
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "coverage_unknown" }), true);
});


test("generation zero is a valid settled recovery generation", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "recovery-generation-zero",
        source: "offline_gap_recovery",
        generation: 0,
        createdAt: new Date(NOW.getTime() - 45 * 60_000),
        completedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
      latest: {
        id: "recovery-generation-zero",
        source: "offline_gap_recovery",
        status: "COMPLETED",
        generation: 0,
        continuation: {},
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.reason, "gap_already_recovered");
  assert.equal(calls, 0);
});


test("a generic completed discovery never releases an offline recovery fence", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "ordinary-discovery",
        source: "initial_full_scan",
        generation: 12,
        createdAt: new Date(NOW.getTime() - 45 * 60_000),
        completedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
      latest: {
        id: "ordinary-discovery",
        source: "initial_full_scan",
        generation: 12,
        status: "COMPLETED",
        continuation: {},
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(calls, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("an old recovery cannot erase a newer long uncovered tail", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 4 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "old-recovery",
        source: "offline_gap_recovery",
        generation: 13,
        createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
        completedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      },
      latest: {
        id: "old-recovery",
        source: "offline_gap_recovery",
        generation: 13,
        status: "COMPLETED",
        continuation: {},
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(calls, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("a recovery started before the durable boundary cannot close a later gap", async () => {
  let calls = 0;
  const lastCoveredAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt,
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "stale-recovery",
        source: "offline_gap_recovery",
        generation: 14,
        createdAt: new Date(lastCoveredAt.getTime() - 5 * 60_000),
        completedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
      latest: {
        id: "stale-recovery",
        source: "offline_gap_recovery",
        generation: 14,
        status: "COMPLETED",
        continuation: {},
      },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(calls, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("a cancelled child history row keeps the recovered boundary fenced", async () => {
  let calls = 0;
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    now: NOW,
    db: dbFixture({
      completedBaseline: {
        id: "recovery-with-cancelled-child",
        source: "offline_gap_recovery",
        generation: 11,
        createdAt: new Date(NOW.getTime() - 45 * 60_000),
        completedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
      latest: {
        id: "recovery-with-cancelled-child",
        status: "COMPLETED",
        generation: 11,
        continuation: {},
      },
      unfinished: { id: "cancelled-dialog", status: "CANCELLED" },
    }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(calls, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});


test("a far-future realtime boundary is treated as poisoned coverage and forces recovery", async () => {
  const future = new Date(NOW.getTime() + 60_000);
  assert.equal(hasRealtimeCoverageClockSkew(future, NOW), true);
  assert.equal(hasLongOfflineGap(future, NOW), false);
  const calls = [];
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: future,
    now: NOW,
    db: dbFixture({ completedRecovery: null }),
    schedule: async (input) => { calls.push(input); return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(result.coverageClockSkew, true);
  assert.equal(result.offlineSince, null);
  assert.equal(calls.length, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("a completed recovery can release a poisoned future boundary for repair", async () => {
  const future = new Date(NOW.getTime() + 60_000);
  const recovery = {
    id: "clock-recovery",
    source: "offline_gap_recovery",
    generation: 19,
    createdAt: new Date(NOW.getTime() - 45 * 60_000),
    completedAt: new Date(NOW.getTime() - 5 * 60_000),
  };
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: future,
    now: NOW,
    db: dbFixture({
      completedBaseline: recovery,
      latest: { ...recovery, status: "COMPLETED", continuation: {} },
    }),
    schedule: async () => { throw new Error("must not reschedule settled recovery"); },
  });
  assert.equal(result.reason, "gap_already_recovered");
  assert.equal(shouldPreserveRealtimeCoverage(result), false);
});


test("missing realtime coverage waits for a completed discovery baseline", async () => {
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: null,
    now: NOW,
    db: dbFixture({ baseline: false }),
    schedule: async () => { throw new Error("must not scan without a baseline"); },
  });
  assert.equal(result.reason, "baseline_missing");
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});

test("a recent completed baseline can establish initially unknown realtime coverage", async () => {
  let calls = 0;
  const recent = {
    id: "recent-baseline",
    source: "initial_full_scan",
    generation: 21,
    createdAt: new Date(NOW.getTime() - 20 * 60_000),
    completedAt: new Date(NOW.getTime() - 10 * 60_000),
  };
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: null,
    now: NOW,
    db: dbFixture({ completedBaseline: recent, latest: { ...recent, status: "COMPLETED", continuation: {} } }),
    schedule: async () => { calls += 1; return { ok: true, created: true }; },
  });
  assert.equal(result.reason, "gap_below_threshold");
  assert.equal(result.coverageUnknown, true);
  assert.equal(calls, 0);
  assert.equal(shouldPreserveRealtimeCoverage(result), false);
});

test("an old completed baseline forces recovery before initially unknown coverage can advance", async () => {
  const calls = [];
  const result = await scheduleOfflineDialogRecovery({
    agencyId: "agency-1",
    creatorId: "creator-1",
    lastCoveredAt: null,
    now: NOW,
    db: dbFixture({ completedRecovery: null }),
    schedule: async (input) => { calls.push(input); return { ok: true, created: true }; },
  });
  assert.equal(result.created, true);
  assert.equal(result.coverageUnknown, true);
  assert.equal(calls.length, 1);
  assert.equal(shouldPreserveRealtimeCoverage(result), true);
});
