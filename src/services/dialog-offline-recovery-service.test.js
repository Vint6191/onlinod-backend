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
  scheduleOfflineDialogRecovery,
  shouldPreserveRealtimeCoverage,
} = require("./dialog-offline-recovery-service");

const NOW = new Date("2026-07-25T10:00:00.000Z");

function dbFixture({ baseline = true, latest = null, active = null, unfinished = null, completedBaseline = null } = {}) {
  return {
    dialogScanRun: {
      async findFirst({ where }) {
        if (where.status === "COMPLETED") {
          return baseline ? (completedBaseline || {
            id: "baseline-run",
            source: "initial_full_scan",
            generation: 7,
            createdAt: new Date("2026-07-24T00:00:00.000Z"),
            completedAt: new Date("2026-07-24T00:00:00.000Z"),
          }) : null;
        }
        if (where.status?.in) return active;
        return latest || (baseline ? {
          id: "baseline-run",
          status: "COMPLETED",
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
  assert.equal(shouldPreserveRealtimeCoverage({ ok: true, created: false, reason: "coverage_unknown" }), false);
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
        completedAt: new Date(NOW.getTime() - 5 * 60_000),
      },
      latest: {
        id: "recovery-generation-zero",
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
