"use strict";

const prisma = require("../prisma");

const DAILY_VAULT_INTELLIGENCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAILY_VAULT_INTELLIGENCE_SOURCE = "daily_vault_intelligence";
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "PAUSED"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}
function timestamp(value) {
  if (!value) return NaN;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function mostRecent(values) {
  const times = values.map(timestamp).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : null;
}
function isDue(lastAt, now, intervalMs = DAILY_VAULT_INTELLIGENCE_INTERVAL_MS) {
  const time = timestamp(lastAt);
  return Number.isFinite(time) && now.getTime() - time >= intervalMs;
}
function historyControl(run) {
  const control = object(object(run?.continuation).historyControl);
  return {
    state: clean(control.state, 40).toUpperCase(),
    at: control.at || run?.completedAt || run?.updatedAt || null,
  };
}

async function loadDailyVaultIntelligenceState({ agencyId, creatorId, db = prisma }) {
  const [snapshot, latestDiscovery, latestCompletedDiscovery, activeDialogRun, activeCatalogJob] = await Promise.all([
    db.vaultUnsortedSnapshot.findUnique({
      where: { agencyId_creatorId: { agencyId, creatorId } },
      select: { payload: true, capturedAt: true, updatedAt: true },
    }),
    db.dialogScanRun.findFirst({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, completedAt: true, updatedAt: true, continuation: true, generation: true },
    }),
    // A failed/cancelled maintenance attempt must not erase the timestamp of
    // the last authoritative discovery baseline. Keep this query separate from
    // latestDiscovery, which is still used for durable pause/cancel control.
    db.dialogScanRun.findFirst({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__", status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { id: true, status: true, completedAt: true, updatedAt: true, continuation: true, generation: true },
    }),
    db.dialogScanRun.findFirst({
      where: { agencyId, creatorId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, dialogId: true, status: true, updatedAt: true },
    }),
    db.jobInstance.findFirst({
      where: { agencyId, creatorId, jobKey: "vault_unsorted_scan", status: { in: ["SCHEDULED", "CLAIMED"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true, updatedAt: true },
    }),
  ]);

  const payload = object(snapshot?.payload);
  const scan = object(payload.scan);
  const catalogCompletedAt = mostRecent([
    payload.lastFullScanAt,
    payload.lastIncrementalScanAt,
    payload.lastMergeScanAt,
    clean(scan.status, 40).toUpperCase() === "COMPLETED" ? scan.completedAt : null,
  ]);
  const discoveryCompletedAt = latestCompletedDiscovery
    ? mostRecent([latestCompletedDiscovery.completedAt, latestCompletedDiscovery.updatedAt])
    : null;

  return {
    snapshot,
    latestDiscovery,
    latestCompletedDiscovery,
    activeDialogRun,
    activeCatalogJob,
    catalogCompletedAt,
    discoveryCompletedAt,
    historyControl: historyControl(latestDiscovery),
    catalogControl: {
      state: clean(scan.status, 40).toUpperCase(),
      at: scan.completedAt || snapshot?.updatedAt || null,
    },
  };
}

async function ensureDailyVaultIntelligenceCycle({
  agencyId,
  creatorId,
  now = new Date(),
  db = prisma,
  intervalMs = DAILY_VAULT_INTELLIGENCE_INTERVAL_MS,
  forceDialogs = false,
  scheduleCatalog = null,
  scheduleDialogs = null,
} = {}) {
  if (!agencyId || !creatorId) return { ok: false, created: 0, reason: "missing_scope" };
  const state = await loadDailyVaultIntelligenceState({ agencyId, creatorId, db });

  // Daily maintenance is deliberately incremental. It must never create the
  // first heavy scan behind the operator's back; both authoritative baselines
  // must exist before automatic maintenance is allowed.
  if (!state.catalogCompletedAt || !state.discoveryCompletedAt) {
    return {
      ok: true,
      created: 0,
      reason: "baseline_missing",
      catalogBaseline: Boolean(state.catalogCompletedAt),
      dialogBaseline: Boolean(state.discoveryCompletedAt),
    };
  }

  const catalogDue = isDue(state.catalogCompletedAt, now, intervalMs);
  // Dialog history is maintained by realtime WS. Automatic discovery is only
  // allowed when a caller explicitly requests recovery (for example after every
  // device for the creator was offline for more than one hour).
  const dialogsDue = forceDialogs === true;
  if (!catalogDue && !dialogsDue) {
    return {
      ok: true,
      created: 0,
      reason: "fresh",
      catalogCompletedAt: state.catalogCompletedAt.toISOString(),
      discoveryCompletedAt: state.discoveryCompletedAt.toISOString(),
      dialogMaintenance: "realtime_ws",
    };
  }

  const result = {
    ok: true,
    created: 0,
    reason: "daily_due",
    catalog: null,
    dialogs: null,
  };

  if (catalogDue) {
    const catalogCancelledRecently = state.catalogControl.state === "CANCELLED"
      && !isDue(state.catalogControl.at, now, intervalMs);
    if (state.catalogControl.state === "PAUSED") {
      result.catalog = { created: false, reason: "catalog_paused" };
    } else if (catalogCancelledRecently) {
      result.catalog = { created: false, reason: "catalog_cancelled_recently" };
    } else if (state.activeDialogRun) {
      result.catalog = {
        created: false,
        reason: "waiting_for_dialogs",
        runId: state.activeDialogRun.id,
        status: state.activeDialogRun.status,
      };
    } else if (state.activeCatalogJob) {
      result.catalog = { created: false, reason: "already_in_flight", jobId: state.activeCatalogJob.id };
    } else {
      const startCatalog = scheduleCatalog || require("./vault-unsorted-service").scheduleVaultUnsortedScan;
      result.catalog = await startCatalog({
        agencyId,
        creatorId,
        userId: null,
        // Full traversal refreshes every expiring preview/source URL. The
        // completion path is merge-only and never removes previously known ids.
        mode: "full",
        source: DAILY_VAULT_INTELLIGENCE_SOURCE,
        priority: 45,
      });
      if (result.catalog?.created === true) result.created += 1;
    }
  }

  if (dialogsDue) {
    // Explicit recovery still waits for the catalog lane because both consume
    // the same creator runtime and OF read budget. Ordinary daily maintenance no
    // longer reaches this branch: realtime WS owns dialog freshness.
    if (state.activeCatalogJob || result.catalog?.created === true) {
      result.dialogs = { created: false, reason: "waiting_for_catalog" };
    } else if (state.historyControl.state === "PAUSED") {
      result.dialogs = { created: false, reason: "history_paused" };
    } else if (["CANCELLED", "CANCELED"].includes(state.historyControl.state)
      && !isDue(state.historyControl.at, now, intervalMs)) {
      // Cancel stops the current maintenance attempt and suppresses automatic
      // recreation for the rest of the 24-hour window. It is not a permanent
      // disable switch; a later daily cycle may run normally.
      result.dialogs = { created: false, reason: "history_cancelled_recently" };
    } else if (state.activeDialogRun) {
      result.dialogs = {
        created: false,
        reason: "already_in_flight",
        runId: state.activeDialogRun.id,
        status: state.activeDialogRun.status,
      };
    } else {
      const startDialogs = scheduleDialogs || require("./dialog-intelligence-service").restartCreatorDialogPlan;
      result.dialogs = await startDialogs({
        agencyId,
        creatorId,
        childMode: "incremental",
        forceChildFull: false,
        source: DAILY_VAULT_INTELLIGENCE_SOURCE,
        generation: null,
        pageLimit: 50,
        overlapPages: 2,
        maxPages: 10_000,
        priority: 55,
        knownMessageThreshold: 1,
        userId: null,
      });
      if (result.dialogs?.created === true) result.created += 1;
    }
  }

  if (result.created === 0) {
    const reasons = [result.catalog?.reason, result.dialogs?.reason].filter(Boolean);
    result.reason = reasons.length ? reasons.join("+") : "nothing_scheduled";
  }
  return result;
}

module.exports = {
  DAILY_VAULT_INTELLIGENCE_INTERVAL_MS,
  DAILY_VAULT_INTELLIGENCE_SOURCE,
  loadDailyVaultIntelligenceState,
  ensureDailyVaultIntelligenceCycle,
  isDue,
};
