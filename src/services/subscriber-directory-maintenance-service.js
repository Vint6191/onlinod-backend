"use strict";

const {
  recoverSubscriberPublicationDebt,
  cleanupSubscriberScanHistory,
  hasSubscriberPublicationDebt,
} = require("./subscriber-directory-service");
const {
  SUBSCRIBER_MAINTENANCE_KIND,
  signalSubscriberDirectoryMaintenance,
  claimSubscriberDirectoryMaintenanceSignal,
  ackSubscriberDirectoryMaintenanceSignal,
  releaseSubscriberDirectoryMaintenanceSignal,
  countPoisonedSubscriberMaintenanceSignals,
  listPoisonedSubscriberMaintenanceSignals,
} = require("./subscriber-directory-maintenance-signal-service");

async function runSubscriberDirectoryMaintenance({
  db,
  now = new Date(),
  maxSignals = 16,
  concurrency = 4,
  maxRuntimeMs = 5_000,
  recoveryStepsPerRun = 4,
  retentionKeep = 2,
  retentionBatch = 50,
} = {}) {
  if (typeof db?.$transaction !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    return { ok: true, processedSignals: 0, reason: "adapter_unsupported" };
  }
  const limit = Math.max(1, Math.min(100, Number(maxSignals) || 16));
  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || 4, limit));
  const budgetMs = Math.max(750, Math.min(30_000, Number(maxRuntimeMs) || 5_000));
  const started = Date.now();
  const totals = {
    processedSignals: 0,
    recoverySignals: 0,
    retentionSignals: 0,
    recoveredRuns: 0,
    reconciledJobs: 0,
    deletedRuns: 0,
    stateRepairs: 0,
    errors: 0,
    contended: 0,
    errorDetails: [],
  };
  let reserved = 0;
  let drained = false;

  async function processRecovery(signal, remainingMs) {
    let result;
    try {
      result = await recoverSubscriberPublicationDebt({
        db,
        agencyId: signal.agencyId,
        creatorId: signal.creatorId,
        now,
        maxRuns: 4,
        maxStepsPerRun: recoveryStepsPerRun,
        maxRuntimeMs: Math.max(500, Math.min(remainingMs, 4_000)),
        maintenanceSignal: signal,
      });
    } catch (error) {
      if (error?.code === "SUBSCRIBER_MAINTENANCE_CLAIM_STALE") {
        totals.contended += 1;
        return;
      }
      throw error;
    }
    totals.recoveredRuns += Number(result?.recoveredRuns || 0);
    totals.reconciledJobs += Number(result?.reconciledJobs || 0);
    totals.stateRepairs += Number(result?.stateRepairs || 0);
    const debtRemains = await hasSubscriberPublicationDebt({ db, agencyId: signal.agencyId, creatorId: signal.creatorId });
    if (debtRemains || result?.budgetExhausted) {
      await releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now, retryMs: 2_000, error: result?.budgetExhausted ? "subscriber_recovery_budget_exhausted" : null });
      return;
    }
    await signalSubscriberDirectoryMaintenance({
      db,
      agencyId: signal.agencyId,
      creatorId: signal.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RETENTION,
      reason: "RECOVERY_CONVERGED",
    });
    await ackSubscriberDirectoryMaintenanceSignal({ db, signal });
  }

  async function processRetention(signal) {
    let result;
    try {
      result = await cleanupSubscriberScanHistory({
        db,
        agencyId: signal.agencyId,
        creatorId: signal.creatorId,
        keep: retentionKeep,
        maxRuns: retentionBatch,
        maintenanceSignal: signal,
      });
    } catch (error) {
      if (error?.code === "SUBSCRIBER_MAINTENANCE_CLAIM_STALE") {
        totals.contended += 1;
        return;
      }
      throw error;
    }

    totals.deletedRuns += Number(result?.deletedRuns || 0);
    if (result?.blockedByPublicationDebt) {
      await signalSubscriberDirectoryMaintenance({
        db,
        agencyId: signal.agencyId,
        creatorId: signal.creatorId,
        kind: SUBSCRIBER_MAINTENANCE_KIND.RECOVERY,
        reason: "RETENTION_BLOCKED_BY_PUBLICATION_DEBT",
      });
      await releaseSubscriberDirectoryMaintenanceSignal({
        db, signal, now, retryMs: 30_000, error: "publication_debt",
      });
      return;
    }
    if (result?.hasMore) {
      await releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now, retryMs: 1_000 });
      return;
    }
    await ackSubscriberDirectoryMaintenanceSignal({ db, signal });
  }

  async function processSignal(signal) {
    const remainingMs = budgetMs - (Date.now() - started);
    if (remainingMs < 500) {
      await releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now, retryMs: 1_000, error: "maintenance_budget_exhausted" });
      return;
    }
    try {
      if (signal.kind === SUBSCRIBER_MAINTENANCE_KIND.RECOVERY) {
        totals.recoverySignals += 1;
        await processRecovery(signal, remainingMs);
      } else if (signal.kind === SUBSCRIBER_MAINTENANCE_KIND.RETENTION) {
        totals.retentionSignals += 1;
        await processRetention(signal);
      } else {
        throw Object.assign(new Error(`Unknown Subscriber maintenance signal kind ${signal.kind}`), { code: "SUBSCRIBER_MAINTENANCE_KIND_INVALID" });
      }
      totals.processedSignals += 1;
    } catch (error) {
      totals.errors += 1;
      if (totals.errorDetails.length < 5) {
        totals.errorDetails.push({
          signalId: signal?.id || null,
          agencyId: signal?.agencyId || null,
          creatorId: signal?.creatorId || null,
          kind: signal?.kind || null,
          code: error?.code || null,
          message: String(error?.message || error || "subscriber_maintenance_error").slice(0, 500),
        });
      }
      await releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now, error, retryMs: 60_000 }).catch(() => null);
    }
  }

  async function worker(initialSignal = null) {
    let nextSignal = initialSignal;
    for (;;) {
      if (drained || Date.now() - started >= budgetMs) return;
      const remainingMs = budgetMs - (Date.now() - started);
      if (remainingMs < 400) return;
      let signal = nextSignal;
      nextSignal = null;
      if (!signal && reserved >= limit) return;
      if (!signal) {
        reserved += 1;
        signal = await claimSubscriberDirectoryMaintenanceSignal({ db, now, statementTimeoutMs: Math.min(2_000, remainingMs) });
      }
      if (!signal) { drained = true; return; }
      await processSignal(signal);
    }
  }

  // Free-tier empty-queue path: perform exactly one claim transaction first.
  // Only fan out workers after real durable work is observed.
  reserved += 1;
  const firstSignal = await claimSubscriberDirectoryMaintenanceSignal({
    db,
    now,
    statementTimeoutMs: Math.min(2_000, Math.max(400, budgetMs - (Date.now() - started))),
  });
  if (!firstSignal) {
    drained = true;
  } else {
    const additionalWorkers = Math.max(0, workerCount - 1);
    await Promise.all([
      worker(firstSignal),
      ...Array.from({ length: additionalWorkers }, () => worker()),
    ]);
  }
  const budgetExhausted = !drained && Date.now() - started >= budgetMs;
  const poisonedSignals = await countPoisonedSubscriberMaintenanceSignals({ db });
  const poisonedSample = poisonedSignals > 0
    ? await listPoisonedSubscriberMaintenanceSignals({ db, limit: 5 })
    : [];
  return {
    ok: totals.errors === 0 && poisonedSignals === 0,
    ...totals,
    poisonedSignals,
    poisonedSample: poisonedSample.map((row) => ({
      id: row.id, agencyId: row.agencyId, creatorId: row.creatorId, kind: row.kind,
      attempts: row.attempts, dueAt: row.dueAt, lastError: row.lastError,
    })),
    claimedSlots: reserved,
    concurrency: workerCount,
    budgetExhausted,
    reason: totals.processedSignals ? "processed" : (totals.contended ? "contended" : (budgetExhausted ? "budget_exhausted" : "none_due")),
  };
}

module.exports = { runSubscriberDirectoryMaintenance };
