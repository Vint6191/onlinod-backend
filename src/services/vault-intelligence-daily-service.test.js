"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./vault-intelligence-daily-service")];
const {
  DAILY_VAULT_INTELLIGENCE_INTERVAL_MS,
  DAILY_VAULT_INTELLIGENCE_SOURCE,
  loadDailyVaultIntelligenceState,
  ensureDailyVaultIntelligenceCycle,
} = require("./vault-intelligence-daily-service");

const DAY = DAILY_VAULT_INTELLIGENCE_INTERVAL_MS;
const NOW = new Date("2026-07-22T12:00:00.000Z");

function database({
  catalogAt = new Date(NOW.getTime() - DAY - 1),
  completedDiscoveryAt = new Date(NOW.getTime() - DAY - 1),
  latestDiscovery = null,
  activeDialogRun = null,
  activeCatalogJob = null,
  catalogStatus = "COMPLETED",
} = {}) {
  const payload = catalogAt ? {
    lastFullScanAt: catalogAt.toISOString(),
    scan: { status: catalogStatus, completedAt: catalogAt.toISOString() },
  } : {};
  const latestCompletedDiscovery = completedDiscoveryAt ? {
    id: "discovery-complete",
    status: "COMPLETED",
    completedAt: completedDiscoveryAt,
    updatedAt: completedDiscoveryAt,
    continuation: {},
    generation: 7,
  } : null;
  const newest = latestDiscovery === undefined
    ? latestCompletedDiscovery
    : latestDiscovery;
  let discoveryQuery = 0;
  return {
    vaultUnsortedSnapshot: {
      findUnique: async () => catalogAt ? { payload, capturedAt: catalogAt, updatedAt: catalogAt } : null,
    },
    dialogScanRun: {
      findFirst: async ({ where }) => {
        if (where.dialogId === "__dialog_discovery__" && where.status === "COMPLETED") {
          return latestCompletedDiscovery;
        }
        if (where.dialogId === "__dialog_discovery__") {
          discoveryQuery += 1;
          return newest;
        }
        if (where.status?.in) return activeDialogRun;
        return null;
      },
    },
    jobInstance: {
      findFirst: async () => activeCatalogJob,
    },
    _discoveryQueryCount: () => discoveryQuery,
  };
}

function recorder() {
  const calls = { catalog: [], dialogs: [] };
  return {
    calls,
    scheduleCatalog: async (input) => {
      calls.catalog.push(input);
      return { ok: true, created: true, reason: "created", job: { id: "catalog-job" } };
    },
    scheduleDialogs: async (input) => {
      calls.dialogs.push(input);
      return { ok: true, created: true, reason: "created", run: { id: "dialog-run" } };
    },
  };
}

test("daily maintenance never creates the first heavy baseline automatically", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({ catalogAt: null, completedDiscoveryAt: null }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(result.reason, "baseline_missing");
  assert.equal(result.created, 0);
  assert.equal(rec.calls.catalog.length, 0);
  assert.equal(rec.calls.dialogs.length, 0);
});

test("latest failed discovery does not erase the last completed daily baseline", async () => {
  const completedAt = new Date(NOW.getTime() - DAY - 1);
  const db = database({
    catalogAt: new Date(NOW.getTime() - 1_000),
    completedDiscoveryAt: completedAt,
    latestDiscovery: {
      id: "discovery-failed",
      status: "FAILED",
      completedAt: NOW,
      updatedAt: NOW,
      continuation: {},
      generation: 8,
    },
  });
  const state = await loadDailyVaultIntelligenceState({ agencyId: "agency-1", creatorId: "creator-1", db });
  assert.equal(state.latestDiscovery.status, "FAILED");
  assert.equal(state.latestCompletedDiscovery.status, "COMPLETED");
  assert.equal(state.discoveryCompletedAt.toISOString(), completedAt.toISOString());
});

test("fresh authoritative baselines schedule nothing", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({
      catalogAt: new Date(NOW.getTime() - DAY + 60_000),
      completedDiscoveryAt: new Date(NOW.getTime() - DAY + 60_000),
    }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(result.reason, "fresh");
  assert.equal(result.created, 0);
});

test("a due daily cycle starts a non-destructive full catalog traversal first", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database(),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(result.created, 1);
  assert.equal(rec.calls.catalog.length, 1);
  assert.equal(rec.calls.catalog[0].mode, "full");
  assert.equal(rec.calls.catalog[0].source, DAILY_VAULT_INTELLIGENCE_SOURCE);
  assert.equal(rec.calls.dialogs.length, 0, "dialog discovery waits for catalog completion");
  assert.equal(result.dialogs.reason, "waiting_for_catalog");
});

test("catalog completion can force the dialog phase immediately even when clocks drift", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    forceDialogs: true,
    db: database({
      catalogAt: new Date(NOW.getTime() - 1_000),
      completedDiscoveryAt: new Date(NOW.getTime() - DAY + 60 * 60_000),
    }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(rec.calls.catalog.length, 0);
  assert.equal(rec.calls.dialogs.length, 1);
  assert.equal(result.created, 1);
  assert.equal(rec.calls.dialogs[0].childMode, "incremental");
  assert.equal(rec.calls.dialogs[0].forceChildFull, false);
  assert.equal(rec.calls.dialogs[0].source, DAILY_VAULT_INTELLIGENCE_SOURCE);
  assert.equal(rec.calls.dialogs[0].maxPages, 10_000, "the shuffled dialog list is rebuilt to hasMore=false");
});

test("a durably paused catalog is never restarted by daily maintenance", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({ catalogStatus: "PAUSED" }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(rec.calls.catalog.length, 0);
  assert.equal(rec.calls.dialogs.length, 1, "dialog maintenance can still proceed independently");
  assert.equal(result.catalog.reason, "catalog_paused");
});

test("durable pause blocks dialog history without disabling catalog maintenance", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({
      latestDiscovery: {
        id: "paused-discovery",
        status: "COMPLETED",
        completedAt: new Date(NOW.getTime() - DAY - 1),
        updatedAt: new Date(NOW.getTime() - DAY - 1),
        generation: 7,
        continuation: { historyControl: { state: "PAUSED" } },
      },
    }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(rec.calls.catalog.length, 1);
  assert.equal(rec.calls.dialogs.length, 0);
  assert.equal(result.dialogs.reason, "waiting_for_catalog");
});

test("durable pause blocks a dialog-only due pass", async () => {
  const rec = recorder();
  const old = new Date(NOW.getTime() - DAY - 1);
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({
      catalogAt: new Date(NOW.getTime() - 1_000),
      completedDiscoveryAt: old,
      latestDiscovery: {
        id: "paused-discovery",
        status: "COMPLETED",
        completedAt: old,
        updatedAt: old,
        generation: 7,
        continuation: { historyControl: { state: "PAUSED", at: NOW.toISOString() } },
      },
    }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(rec.calls.catalog.length, 0);
  assert.equal(rec.calls.dialogs.length, 0);
  assert.equal(result.dialogs.reason, "history_paused");
});

test("an active catalog phase is never duplicated and keeps dialog discovery behind it", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({
      activeCatalogJob: { id: "catalog-active", status: "CLAIMED" },
    }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(result.created, 0);
  assert.equal(result.catalog.reason, "already_in_flight");
  assert.equal(result.dialogs.reason, "waiting_for_catalog");
  assert.equal(rec.calls.catalog.length, 0);
  assert.equal(rec.calls.dialogs.length, 0);
});

test("an active dialog phase postpones the catalog traversal instead of competing for OF reads", async () => {
  const rec = recorder();
  const result = await ensureDailyVaultIntelligenceCycle({
    agencyId: "agency-1",
    creatorId: "creator-1",
    now: NOW,
    db: database({
      activeDialogRun: { id: "dialog-active", status: "RUNNING", dialogId: "__dialog_discovery__" },
    }),
    scheduleCatalog: rec.scheduleCatalog,
    scheduleDialogs: rec.scheduleDialogs,
  });
  assert.equal(result.created, 0);
  assert.equal(result.catalog.reason, "waiting_for_dialogs");
  assert.equal(result.dialogs.reason, "already_in_flight");
  assert.equal(rec.calls.catalog.length, 0);
  assert.equal(rec.calls.dialogs.length, 0);
});
