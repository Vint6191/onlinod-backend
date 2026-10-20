"use strict";
const { performance } = require("node:perf_hooks");
const { runDbTransaction } = require("./db-transaction-service");
const { publishDomainWork } = require("./domain-work-authority-service");
const { emitRuntimeDiagnostic } = require("./runtime-diagnostic-log");
const { safeSubscriberDiagnosticError } = require("./subscriber-recovery-diagnostics");

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
  lockSubscriberMaintenanceClaimRow,
  releaseSubscriberDirectoryMaintenanceSignal,
  countPoisonedSubscriberMaintenanceSignals,
  listPoisonedSubscriberMaintenanceSignals,
} = require("./subscriber-directory-maintenance-signal-service");

// Outbox consumer deliberately owns no Subscriber/automation advisory locks.
// The shared order with recurring planning is DWI -> signal. If a publication
// replaces the revision while this transaction waits, both DWI and ack roll
// back; the newer signal remains available for its own owner.
async function dispatchSubscriberDerivedPlanning({ db, signal }) {
  return runDbTransaction(db, async tx => {
    const work = await publishDomainWork({
      db: tx, agencyId: signal.agencyId, creatorId: signal.creatorId,
      workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount",
      objectId: signal.creatorId, partitionKey: signal.creatorId,
    });
    if (!work?.id) throw Object.assign(new Error("Subscriber derived planning work was not persisted"), {
      code: "SUBSCRIBER_DERIVED_WAKE_MISSING",
    });
    const current = await lockSubscriberMaintenanceClaimRow({ db: tx, signal });
    if (!current || !await ackSubscriberDirectoryMaintenanceSignal({ db: tx, signal })) {
      throw Object.assign(new Error("Subscriber derived planning outbox owner is stale"), {
        code: "SUBSCRIBER_MAINTENANCE_CLAIM_STALE",
      });
    }
    return { dispatched: true, workId: work.id };
  }, { maxWait: 5_000, timeout: 20_000, lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 });
}

async function runSubscriberDirectoryMaintenance({
  db,
  now = new Date(),
  maxSignals = 16,
  concurrency = 4,
  maxRuntimeMs = 5_000,
  recoveryStepsPerRun = 4,
  retentionKeep = 2,
  retentionBatch = 50,
  monotonicNow = () => performance.now(),
} = {}) {
  if (typeof db?.$transaction !== "function" || typeof db?.$queryRawUnsafe !== "function") {
    return { ok: true, processedSignals: 0, reason: "adapter_unsupported" };
  }
  const limit = Math.max(1, Math.min(100, Number(maxSignals) || 16));
  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || 4, limit));
  const budgetMs = Math.max(750, Math.min(30_000, Number(maxRuntimeMs) || 5_000));
  const started = monotonicNow();
  const totals = {
    processedSignals: 0,
    recoverySignals: 0,
    retentionSignals: 0,
    derivedPlanningSignals: 0,
    recoveredRuns: 0,
    advancedSteps: 0,
    reconciledJobs: 0,
    deletedRuns: 0,
    stateRepairs: 0,
    errors: 0,
    contended: 0,
    errorDetails: [],
  };
  let reserved = 0;
  let drained = false;

  function recordError(error, signal = null) {
    totals.errors += 1;
    const diagnostic = safeSubscriberDiagnosticError(error);
    emitRuntimeDiagnostic("subscriber recovery error", `${signal?.creatorId || "admission"}:${signal?.kind || "claim"}`, {
      agencyId: signal?.agencyId || null, creatorId: signal?.creatorId || null,
      signalId: signal?.id || null, kind: signal?.kind || null,
      revision: Number(signal?.revision || 0), attempts: Number(signal?.attempts || 0),
      claimUntil: signal?.claimUntil || null, error: diagnostic,
    });
    if (totals.errorDetails.length < 5) {
      totals.errorDetails.push({
        signalId: signal?.id || null,
        agencyId: signal?.agencyId || null,
        creatorId: signal?.creatorId || null,
        kind: signal?.kind || null,
        code: diagnostic?.code || null,
        message: diagnostic?.category || "RECORDED_FAILURE",
        fingerprint: diagnostic?.fingerprint || null,
      });
    }
  }

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
        monotonicNow,
      });
    } catch (error) {
      if (error?.code === "SUBSCRIBER_MAINTENANCE_CLAIM_STALE") {
        totals.contended += 1;
        return { reason: "claim_stale" };
      }
      throw error;
    }
    totals.recoveredRuns += Number(result?.recoveredRuns || 0);
    totals.advancedSteps += Number(result?.advancedSteps || 0);
    totals.reconciledJobs += Number(result?.reconciledJobs || 0);
    totals.stateRepairs += Number(result?.stateRepairs || 0);
    const debtRemains = await hasSubscriberPublicationDebt({ db, agencyId: signal.agencyId, creatorId: signal.creatorId });
    if (debtRemains) {
      // More bounded work is a continuation, not a failed attempt.
      const released = await releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now, retryMs: 2_000, retryAt: result?.retryAt || null });
      return { ...result, debtRemains, signalReleased: Boolean(released) };
    }
    await signalSubscriberDirectoryMaintenance({
      db,
      agencyId: signal.agencyId,
      creatorId: signal.creatorId,
      kind: SUBSCRIBER_MAINTENANCE_KIND.RETENTION,
      reason: "RECOVERY_CONVERGED",
    });
    const acknowledged = await ackSubscriberDirectoryMaintenanceSignal({ db, signal });
    return { ...result, debtRemains, signalAcknowledged: Boolean(acknowledged) };
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
        db, signal, now, retryMs: 30_000,
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
    const remainingMs = budgetMs - (monotonicNow() - started);
    const unitStarted = monotonicNow();
    const diagnosticScope = {
      signalId: signal.id, agencyId: signal.agencyId, creatorId: signal.creatorId,
      kind: signal.kind, revision: Number(signal.revision || 0), attempts: Number(signal.attempts || 0),
      claimUntil: signal.claimUntil || null,
    };
    if (signal.kind !== SUBSCRIBER_MAINTENANCE_KIND.RETENTION) {
      emitRuntimeDiagnostic("subscriber recovery started", `${signal.creatorId}:${signal.kind}`, diagnosticScope, { level: "info" });
    }
    // Claim admission already reserved one bounded unit. Network/lock latency
    // may use the soft slice, but must not turn every owned unit into a no-op.
    try {
      let observed = null;
      if (signal.kind === SUBSCRIBER_MAINTENANCE_KIND.RECOVERY) {
        totals.recoverySignals += 1;
        observed = await processRecovery(signal, remainingMs);
      } else if (signal.kind === SUBSCRIBER_MAINTENANCE_KIND.DERIVED_PLANNING) {
        totals.derivedPlanningSignals += 1;
        observed = await dispatchSubscriberDerivedPlanning({ db, signal });
      } else if (signal.kind === SUBSCRIBER_MAINTENANCE_KIND.RETENTION) {
        totals.retentionSignals += 1;
        await processRetention(signal);
      } else {
        throw Object.assign(new Error(`Unknown Subscriber maintenance signal kind ${signal.kind}`), { code: "SUBSCRIBER_MAINTENANCE_KIND_INVALID" });
      }
      if (observed) emitRuntimeDiagnostic("subscriber recovery step", `${signal.creatorId}:${signal.kind}:${observed.lastStep?.phase || observed.reason || "dispatched"}`, {
        ...diagnosticScope, durationMs: Math.round(monotonicNow() - unitStarted),
        reason: observed.reason || (observed.dispatched ? "derived_planning_dispatched" : "processed"),
        advancedSteps: Number(observed.advancedSteps || 0), recoveredRuns: Number(observed.recoveredRuns || 0),
        reconciledJobs: Number(observed.reconciledJobs || 0), stateRepairs: Number(observed.stateRepairs || 0),
        debtRemains: observed.debtRemains ?? null, signalReleased: observed.signalReleased ?? null,
        signalAcknowledged: observed.signalAcknowledged ?? null, retryAt: observed.retryAt || null,
        replacementJobId: observed.replacementJobId || null, replacementRunId: observed.replacementRunId || null,
        recoveryCause: observed.recoveryCause || null, workId: observed.workId || null,
        lastStep: observed.lastStep || null,
      }, { level: "info" });
      totals.processedSignals += 1;
    } catch (error) {
      recordError(error, signal);
      await releaseSubscriberDirectoryMaintenanceSignal({ db, signal, now, error, retryMs: 60_000 }).catch(releaseError => {
        recordError(releaseError, signal);
      });
    }
  }

  async function worker(initialSignal = null) {
    let nextSignal = initialSignal;
    for (;;) {
      const remainingMs = budgetMs - (monotonicNow() - started);
      let signal = nextSignal;
      nextSignal = null;
      // A sibling finding an empty queue only stops NEW claims. Never abandon
      // an owned signal until it is processed, released or fenced as stale.
      if (!signal && (drained || remainingMs < 400)) return;
      if (!signal && reserved >= limit) return;
      if (!signal) {
        reserved += 1;
        try {
          signal = await claimSubscriberDirectoryMaintenanceSignal({ db, now, statementTimeoutMs: Math.min(2_000, remainingMs) });
        } catch (error) {
          // Admission failure stops new claims, but does not end the lane while
          // a sibling still owns durable publication work. The scheduler and
          // graceful shutdown must continue to await those owners.
          drained = true;
          recordError(error);
          return;
        }
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
    statementTimeoutMs: Math.min(2_000, Math.max(400, budgetMs - (monotonicNow() - started))),
  });
  if (!firstSignal) {
    drained = true;
  } else {
    const additionalWorkers = Math.max(0, workerCount - 1);
    const workers = await Promise.allSettled([
      worker(firstSignal),
      ...Array.from({ length: additionalWorkers }, () => worker()),
    ]);
    for (const workerResult of workers) {
      if (workerResult.status === "rejected") recordError(workerResult.reason);
    }
  }
  const budgetExhausted = !drained && monotonicNow() - started >= budgetMs;
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
      attempts: row.attempts, dueAt: row.dueAt, lastError: safeSubscriberDiagnosticError(row.lastError),
    })),
    claimedSlots: reserved,
    concurrency: workerCount,
    budgetExhausted,
    reason: totals.processedSignals ? "processed" : (totals.contended ? "contended" : (budgetExhausted ? "budget_exhausted" : "none_due")),
  };
}

module.exports = { runSubscriberDirectoryMaintenance, _test: { dispatchSubscriberDerivedPlanning } };
