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
} = require("./dialog-offline-recovery-service");

const NOW = new Date("2026-07-25T10:00:00.000Z");

function dbFixture({ baseline = true, latest = null, active = null } = {}) {
  return {
    dialogScanRun: {
      async findFirst({ where }) {
        if (where.status === "COMPLETED") {
          return baseline ? {
            id: "baseline-run",
            generation: 7,
            completedAt: new Date("2026-07-24T00:00:00.000Z"),
          } : null;
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
