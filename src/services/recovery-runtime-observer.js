"use strict";
const { runDbTransaction } = require("./db-transaction-service");
const { emitRuntimeDiagnostic, diagnosticError } = require("./runtime-diagnostic-log");
const { financialVerificationDiagnostics } = require("./financial-verification-diagnostics");

const code = value => /^[A-Za-z0-9_.:-]{1,120}$/.test(String(value || "")) ? String(value) : null;
const error = value => value ? diagnosticError(Object.assign(new Error(String(value)), { code: value })) : null;
const iso = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toISOString() : null;

async function inspectRecoveryRuntime(db, { agencyId, creatorId, jobId = null }) {
  // Only called after an authorised Stats read. Scope is nevertheless checked
  // again so a moved/deleted creator cannot produce a cross-agency diagnostic.
  const creator = await db.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, select: { id: true } });
  if (!creator) return { scope: { agencyId, creatorId }, scopeUnavailable: true };
  const scope = { agencyId, creatorId };
  const now = await require("./db-time-authority-service").dbAuthorityNow({ db });
  const subscriber = await require("./subscriber-recovery-diagnostics").inspectSubscriberRecoveryDiagnostics(db, { ...scope, jobId, now });
  if (subscriber.readFailures.length) {
    // PostgreSQL aborts the transaction after a statement error. Preserve the
    // first safe diagnostic cause, rather than burying it under later 25P02s.
    throw Object.assign(new Error("RECOVERY_DIAGNOSTIC_READ_INCOMPLETE"), {
      code: "RECOVERY_DIAGNOSTIC_READ_INCOMPLETE", recoveryReadFailures: subscriber.readFailures,
      partialSubscriber: subscriber,
    });
  }
  const financial = await db.creatorFinancialCollectionState.findFirst({ where: scope, select: {
    status: true, mode: true, activeGeneration: true, activeRequestedAt: true, sourceJobId: true,
    baselineVerifiedAt: true, lastCatchupCompletedAt: true, coverageThrough: true,
    retryAfterAt: true, lastErrorCode: true, updatedAt: true,
  } });
  const notifications = await db.creatorNotificationSyncState.findFirst({ where: scope, select: {
    status: true, mode: true, activeGeneration: true, activeRequestedAt: true, sourceJobId: true,
    fullBackfillVerifiedAt: true, lastCatchupCompletedAt: true, lastSocketEventAt: true,
    retryAfterAt: true, lastErrorCode: true, updatedAt: true,
  } });
  const resolution = await db.creatorMoneyResolutionRequest.findFirst({ where: scope, select: {
    queued: true, targetId: true, attempts: true, jobId: true, lastError: true, updatedAt: true,
  } });
  // Per-stream/status prefix of the debt index; include finite stops so an
  // exhausted recovery stays explainable without scanning completed history.
  const intents = await db.$queryRawUnsafe(`SELECT i.* FROM
    (VALUES ('financial'),('notifications'),('campaigns'),('subscribers')) AS stream(name)
    CROSS JOIN (VALUES ('PENDING'),('RUNNING')) AS status(name)
    CROSS JOIN LATERAL (
      SELECT i.id,i.stream,i.status,i.reason,i."gapFrom",i."targetAt",i."jobId",i."updatedAt",
        i."failedAttempts",i."stoppedAt",i."lastProgressAt",i."lastError"
      FROM "CreatorRecoveryIntent" i
      WHERE i."agencyId"=$1 AND i."creatorId"=$2 AND i.stream=stream.name AND i.status=status.name
      ORDER BY i."targetAt",i.id LIMIT 2
    ) i
    UNION ALL
    SELECT i.* FROM
    (VALUES ('financial'),('notifications'),('campaigns'),('subscribers')) AS stream(name)
    CROSS JOIN LATERAL (
      SELECT i.id,i.stream,i.status,i.reason,i."gapFrom",i."targetAt",i."jobId",i."updatedAt",
        i."failedAttempts",i."stoppedAt",i."lastProgressAt",i."lastError"
      FROM "CreatorRecoveryIntent" i
      WHERE i."agencyId"=$1 AND i."creatorId"=$2 AND i.stream=stream.name AND i.status='STOPPED'
      ORDER BY i."targetAt" DESC,i.id DESC LIMIT 2
    ) i`, agencyId, creatorId);
  const ids = [...new Set([jobId, financial?.sourceJobId, notifications?.sourceJobId, resolution?.jobId, ...intents.map(row => row.jobId)].filter(Boolean))].slice(0, 20);
  const rows = ids.length ? await db.jobInstance.findMany({ where: { ...scope, id: { in: ids } }, select: {
    id: true, jobKey: true, status: true, priority: true, nextRunAt: true, startedAt: true,
    lastProgressAt: true, leaseUntil: true, claimedByDeviceId: true, attempts: true, lastError: true, params: true, result: true,
  } }) : [];
  const jobs = rows.map(row => {
    const p = row.params && typeof row.params === "object" ? row.params : {};
    // The failed execution already stores the verification result. Read that
    // exact referenced job; no new provider scan or historical job search is
    // needed. Only the financial allowlist can leave this diagnostic reader.
    const { params: _params, result: storedResult, lastError, ...fields } = row;
    const startDate = iso(p.startDate), endDate = iso(p.endDate);
    return { ...fields, error: error(lastError), collectionGeneration: code(p.collectionGeneration),
      collectionMode: code(p.collectionMode), moneyResolutionVersion: p.moneyResolutionVersion === 1 ? 1 : null,
      startDate, endDate, windowMs: startDate && endDate ? Date.parse(endDate) - Date.parse(startDate) : null,
      ...(row.jobKey === "financial_transactions_scan" ? {
        financialVerification: financialVerificationDiagnostics(storedResult?.completionSideEffect),
      } : {}),
    };
  });
  for (const state of [financial, notifications]) if (state) state.lastErrorCode = code(state.lastErrorCode);
  if (resolution) { resolution.error = error(resolution.lastError); delete resolution.lastError; }
  const recoveryIntents = intents.map(({ lastError, reason, ...row }) => ({ ...row, reason: code(reason), error: error(lastError) }));
  return { scope, observedAt: now.toISOString(), clockAuthority: "DATABASE", subscriber, collectors: { financial, notifications }, moneyResolution: resolution,
    recoveryIntents, referencedJobs: jobs, sampling: "BOUNDED_CURRENT_DEBT_AND_REFERENCED_JOBS" };
}

function createRecoveryRuntimeObserver({ inspect = inspectRecoveryRuntime, emit = emitRuntimeDiagnostic, now = Date.now,
  transaction = (db, work) => runDbTransaction(db, async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return work(tx);
  }, { timeout: 12_000, maxWait: 1_000, lockTimeoutMs: 1_000, statementTimeoutMs: 3_000, isolationLevel: "RepeatableRead" }),
  intervalMs = 60_000, maxPerMinute = 20, concurrency = 1, capacity = 1024,
} = {}) {
  const recent = new Map(), flights = new Set();
  let closed = false, windowStart = null, windowCount = 0;
  function observe({ db, agencyId, creatorId, jobId = null, traceId = null, startupTraceId = null, trigger = "stats" }) {
    if (closed || !db || !agencyId || !creatorId || flights.size >= concurrency) return null;
    const at = now(), key = `${agencyId}:${creatorId}`, previous = recent.get(key);
    if (previous !== undefined && at >= previous && at - previous < intervalMs) return null;
    if (windowStart === null || at < windowStart || at - windowStart >= 60_000) { windowStart = at; windowCount = 0; }
    if (windowCount >= maxPerMinute) return null;
    recent.delete(key); if (recent.size >= capacity) recent.delete(recent.keys().next().value);
    recent.set(key, at); windowCount++;
    const context = { agencyId, creatorId, traceId, startupTraceId, trigger };
    // A diagnostic is independent of the response and owns no work lease. Bound
    // concurrency before opening a transaction; never queue thousands of reads.
    const flight = Promise.resolve().then(() => transaction(db, tx => inspect(tx, { agencyId, creatorId, jobId })))
      .then(snapshot => emit("creator recovery snapshot", key, { ...context, snapshot }, { level: "info" }))
      .catch(failure => emit("creator recovery inspection failed", key, { ...context, error: diagnosticError(failure),
        diagnosticRead: code(failure?.diagnosticRead),
        ...(failure?.recoveryReadFailures ? { readFailures: failure.recoveryReadFailures, partialSubscriber: failure.partialSubscriber } : {}),
      }))
      .finally(() => flights.delete(flight));
    flights.add(flight); return flight;
  }
  return { observe, stop: async () => { closed = true; await Promise.allSettled([...flights]); } };
}
const observer = createRecoveryRuntimeObserver();
module.exports = { inspectRecoveryRuntime, createRecoveryRuntimeObserver,
  observeRecoveryRuntime: observer.observe, stopRecoveryRuntimeObserver: observer.stop };
