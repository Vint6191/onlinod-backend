"use strict";

const { createHash } = require("node:crypto");
const { classifyDatabaseFailure, classifyStoredDatabaseFailure } = require("./db-retry-policy");
const { MAINTENANCE_ADMISSION_GENERATION } = require("./maintenance-lane-registry");

// These are read-only observations, never a second recovery authority. No fan
// rows, provider payloads, session secrets or raw exception messages are emitted.
const RUN_SELECT = Object.freeze({
  id: true, jobId: true, status: true, hasMore: true, nextOffset: true, scannedCount: true, pageCount: true,
  fanProjectionStatus: true, fanProjectionCursorOffset: true, fanProjectionCount: true, fanProjectionCompletedAt: true,
  publicationStatus: true, publicationGeneration: true, publicationCursorId: true, publicationPreviousRunId: true,
  publicationAddedCount: true, publicationChangedCount: true, publicationDisappearedCount: true,
  publicationStartedAt: true, publicationCompletedAt: true, publicationJobReconciledAt: true,
  publicationLastError: true, fanProjectionLastError: true, lastError: true, updatedAt: true,
});
const JOB_SELECT = Object.freeze({
  id: true, jobKey: true, status: true, params: true, progress: true, attempts: true, nextRunAt: true,
  claimedAt: true, claimedByDeviceId: true, leaseUntil: true, leaseRevision: true,
  lastProgressAt: true, updatedAt: true, lastError: true,
});
const RUN_COLUMNS = Object.keys(RUN_SELECT).map(column => `"${column}"`).join(",");
// Publication/recollection use their scoped partial indexes. Completed-run
// reconciliation is inspected only through current/previous/latest run IDs and
// the requested/current source jobs. A historical OR + LIMIT can scan every
// settled row or another agency's reconciliation index. The exact PK/unique-key
// probes below cannot do that, and the final sort sees <=4 rows. A null sample
// is deliberately NOT a proof that all historical reconciliation has finished.
const SUBSCRIBER_DEBT_DIAGNOSTIC_SQL = `WITH run_refs AS MATERIALIZED (
  SELECT DISTINCT id FROM unnest($3::text[]) AS refs(id) LIMIT 3
), job_refs AS MATERIALIZED (
  SELECT DISTINCT id FROM unnest($4::text[]) AS refs(id) LIMIT 3
) SELECT * FROM (
  (SELECT ${RUN_COLUMNS} FROM "SubscriberScanRun"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "publicationStatus"='RECOLLECTING'
    ORDER BY "publicationGeneration" DESC,"id" ASC LIMIT 1)
  UNION ALL
  (SELECT ${RUN_COLUMNS} FROM "SubscriberScanRun"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "hasMore"=false AND "fanProjectionStatus"='COMPLETE'
      AND "publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE')
    ORDER BY "updatedAt" ASC,"id" ASC LIMIT 1)
  UNION ALL
  (SELECT ${Object.keys(RUN_SELECT).map(column => `r."${column}"`).join(",")}
    FROM run_refs refs JOIN LATERAL (
      SELECT ${RUN_COLUMNS} FROM "SubscriberScanRun" WHERE "id"=refs.id AND "agencyId"=$1 AND "creatorId"=$2 LIMIT 1
    ) r ON true
    WHERE r."status" IN ('PUBLISHED','SUPERSEDED')
      AND r."publicationStatus"='COMPLETE' AND r."publicationJobReconciledAt" IS NULL LIMIT 1)
  UNION ALL
  (SELECT ${Object.keys(RUN_SELECT).map(column => `r."${column}"`).join(",")}
    FROM job_refs refs JOIN LATERAL (
      SELECT ${RUN_COLUMNS} FROM "SubscriberScanRun" WHERE "jobId"=refs.id AND "agencyId"=$1 AND "creatorId"=$2 LIMIT 1
    ) r ON true
    WHERE r."status" IN ('PUBLISHED','SUPERSEDED')
      AND r."publicationStatus"='COMPLETE' AND r."publicationJobReconciledAt" IS NULL LIMIT 1)
) candidate ORDER BY "publicationGeneration" DESC LIMIT 1`;

function text(value, limit = 180) { return value == null ? null : String(value).slice(0, limit); }
function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(+date) ? date.toISOString() : null;
}
function age(value, now) { const stamp = iso(value); return stamp ? Math.max(0, +now - +new Date(stamp)) : null; }
function fingerprint(value) {
  return value == null || value === "" ? null : createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}
function oneOf(value, allowed) { return allowed.includes(value) ? value : (value == null ? null : "UNRECOGNIZED"); }
function machineLabel(value, max = 64) {
  const label = String(value || "");
  return label.length <= max && /^[A-Z][A-Z0-9_]+$/.test(label) ? label : null;
}
function knownCode(value) {
  const code = String(value || "");
  return /^(?:P\d{4}|[0-9]{2}[0-9A-Z]{3}|(?:SUBSCRIBER|FINANCIAL|MAINTENANCE|DB|JOB|LEASE|PHASE2|ANALYTICS|FAN|CREATOR)_[A-Z0-9_]{2,110})$/.test(code) ? code : null;
}
function safeSubscriberDiagnosticError(value) {
  if (value == null || value === "") return null;
  const message = String(value?.message || value);
  const transient = typeof value === "object" ? classifyDatabaseFailure(value) : classifyStoredDatabaseFailure({ message });
  let code = knownCode(transient?.code) || knownCode(value?.code) || knownCode(message);
  const sqlState = value?.code === "P2010" ? knownCode(value?.meta?.code)
    : knownCode(/Raw query failed\. Code: [`'"]([0-9A-Z]{5})[`'"]/.exec(message)?.[1]);
  if (!code && /^Subscriber publication generation [0-9]+ is stale behind allocated generation [0-9]+$/.test(message)) {
    code = "SUBSCRIBER_PUBLICATION_GENERATION_STALE";
  }
  return { code, ...(sqlState ? { sqlState } : {}), category: transient ? "TRANSIENT_DATABASE" : "RECORDED_FAILURE", fingerprint: fingerprint(message) };
}
function ownerState(owner, leaseUntil, now) {
  const until = iso(leaseUntil);
  return {
    present: Boolean(owner), fingerprint: fingerprint(owner), leaseUntil: until,
    leaseActive: Boolean(owner && until && +new Date(until) > +now),
    leaseExpired: Boolean(owner && until && +new Date(until) <= +now),
  };
}
function summarizeRun(run, state, now) {
  if (!run) return null;
  const { subscriberRecollectionCause } = require("./subscriber-directory-service");
  return {
    id: text(run.id), jobId: text(run.jobId), status: text(run.status, 40), phase: text(run.publicationStatus, 40),
    generation: Number(run.publicationGeneration || 0), cursorId: text(run.publicationCursorId),
    previousRunId: text(run.publicationPreviousRunId), hasMore: run.hasMore ?? null,
    nextOffset: Number(run.nextOffset || 0), scannedCount: Number(run.scannedCount || 0), pageCount: Number(run.pageCount || 0),
    sourceProjection: {
      phase: text(run.fanProjectionStatus, 40), cursorOffset: Number(run.fanProjectionCursorOffset || 0),
      projectedCount: Number(run.fanProjectionCount || 0), completedAt: iso(run.fanProjectionCompletedAt),
      lastError: safeSubscriberDiagnosticError(run.fanProjectionLastError),
    },
    recollectionCause: subscriberRecollectionCause(run, state),
    addedCount: Number(run.publicationAddedCount || 0), changedCount: Number(run.publicationChangedCount || 0),
    disappearedCount: Number(run.publicationDisappearedCount || 0),
    startedAt: iso(run.publicationStartedAt), completedAt: iso(run.publicationCompletedAt),
    jobReconciledAt: iso(run.publicationJobReconciledAt), lastProgressAt: iso(run.updatedAt),
    progressAgeMs: age(run.updatedAt, now),
    lastError: safeSubscriberDiagnosticError(run.publicationLastError || run.lastError),
  };
}
function summarizeJob(job, now) {
  return {
    id: text(job.id), jobKey: text(job.jobKey, 80), status: text(job.status, 40),
    scanRunId: text(job.params?.scanRunId), attempts: Number(job.attempts || 0),
    nextRunAt: iso(job.nextRunAt), claimedAt: iso(job.claimedAt),
    ownerDeviceId: text(job.claimedByDeviceId), leaseUntil: iso(job.leaseUntil),
    leaseRevision: Number(job.leaseRevision || 0),
    leaseActive: Boolean(job.status === "CLAIMED" && iso(job.leaseUntil) && +new Date(job.leaseUntil) > +now),
    lastProgressAt: iso(job.lastProgressAt), progressAgeMs: age(job.lastProgressAt || job.updatedAt, now),
    updatedAt: iso(job.updatedAt),
    progress: {
      stage: oneOf(job.progress?.stage, ["PUBLICATION", "RECOVERY", "SUBSCRIBERS", "FETCH", "FETCHING", "COLLECTING", "SCANNING", "INGEST", "INGESTING"]),
      waitKind: oneOf(job.progress?.waitKind, ["PUBLICATION", "creator_context", "worker_shutdown", "worker_release"]),
      publicationPhase: oneOf(job.progress?.publicationPhase, ["PENDING", "CURRENT", "PREVIOUS", "FINALIZE", "RECOLLECTING", "COMPLETE"]),
      publicationBatchRows: Number(job.progress?.publicationBatchRows || 0),
    },
    lastError: safeSubscriberDiagnosticError(job.lastError),
  };
}

async function inspectSubscriberRecoveryDiagnostics(db, { agencyId, creatorId, now = new Date(), jobId = null, strictReads = true } = {}) {
  if (typeof agencyId !== "string" || !agencyId || agencyId.length > 180 ||
      typeof creatorId !== "string" || !creatorId || creatorId.length > 180) {
    throw Object.assign(new Error("SUBSCRIBER_DIAGNOSTIC_SCOPE_REQUIRED"), { code: "SUBSCRIBER_DIAGNOSTIC_SCOPE_REQUIRED" });
  }
  const observedAt = iso(now);
  if (!observedAt) throw Object.assign(new Error("SUBSCRIBER_DIAGNOSTIC_TIME_INVALID"), { code: "SUBSCRIBER_DIAGNOSTIC_TIME_INVALID" });
  now = new Date(observedAt);
  const scope = { agencyId, creatorId };
  const readFailures = [];
  const read = async (name, work) => {
    try { return await work(); }
    catch (error) {
      // PostgreSQL aborts the entire transaction after a statement failure.
      // Preserve that FIRST cause instead of continuing into 25P02 noise. An
      // explicit best-effort caller outside a transaction may request partials.
      if (strictReads) {
        if (error && typeof error === "object") {
          try { Object.defineProperty(error, "diagnosticRead", { value: name, configurable: true }); } catch (_) { /* immutable error */ }
        }
        throw error;
      }
      readFailures.push({ read: name, error: safeSubscriberDiagnosticError(error) }); return null;
    }
  };
  // Every row probe is scope/index backed and bounded; never enumerate history,
  // count scan items or read provider/user content while diagnosing a stalled UI.
  const sourceReads = [
    () => read("directoryState", () => db.subscriberDirectoryState.findFirst({ where: scope, select: {
      id: true, status: true, currentRunId: true, previousRunId: true, lastJobId: true, publishedAt: true,
      nextScanAt: true, publicationGeneration: true, publishedGeneration: true, totalCount: true, updatedAt: true, lastError: true,
    } })),
    () => read("latestRun", () => db.subscriberScanRun.findFirst({ where: scope,
      orderBy: { publicationGeneration: "desc" }, select: RUN_SELECT })),
  ];
  const source = [];
  if (strictReads) for (const operation of sourceReads) source.push(await operation());
  else source.push(...await Promise.all(sourceReads.map(operation => operation())));
  const [state, latestRun] = source;
  const runRefs = [...new Set([state?.currentRunId, state?.previousRunId, latestRun?.id].filter(Boolean))].slice(0, 3);
  const jobRefs = [...new Set([jobId, state?.lastJobId, latestRun?.jobId].filter(Boolean))].slice(0, 3);
  const reads = [
    () => read("publicationDebt", async () => (await db.$queryRawUnsafe(SUBSCRIBER_DEBT_DIAGNOSTIC_SQL,
      agencyId, creatorId, runRefs, jobRefs))[0] || null),
    () => read("maintenanceSignals", () => db.subscriberDirectoryMaintenanceSignal.findMany({ where: scope,
      orderBy: { kind: "asc" }, take: 3, select: {
        id: true, kind: true, reason: true, dueAt: true, revision: true, attempts: true,
        claimToken: true, claimUntil: true, lastError: true, updatedAt: true,
      } })),
    () => read("recurringWork", () => db.domainWorkItem.findFirst({ where: {
      ...scope, workClass: "CREATOR_RECURRING_PLANNING", objectType: "CreatorAccount", objectId: creatorId,
    }, select: {
      id: true, state: true, isOutstanding: true, activeGeneration: true, requestedRevision: true, completedRevision: true,
      claimedRevision: true, ownerToken: true, claimFence: true, leaseUntil: true, availableAt: true, nextAttemptAt: true,
      attempts: true, consecutiveFailures: true, lastFailureAt: true, errorClass: true, lastError: true,
      terminalCause: true, updatedAt: true, progressCursor: true,
    } })),
    () => read("maintenanceAdmission", () => db.maintenanceAdmissionClassState.findUnique({
      where: { generation_laneName: { generation: MAINTENANCE_ADMISSION_GENERATION, laneName: "subscriberDirectoryMaintenance" } },
      select: { generation: true, laneName: true, turnCount: true, lastAdmittedAt: true },
    })),
  ];
  // Prisma operations are lazy promises. Parallel reads in a single PostgreSQL
  // transaction still execute serially, but their rejection ordering can expose
  // 25P02 before the actual failed statement. Strict mode dispatches one read at
  // a time so the recorded read name always belongs to the original exception.
  const observed = [];
  if (strictReads) for (const operation of reads) observed.push(await operation());
  else observed.push(...await Promise.all(reads.map(operation => operation())));
  const [debtRun, signalRows, work, admission] = observed;
  const jobIds = [...new Set([jobId, state?.lastJobId, debtRun?.jobId, latestRun?.jobId].filter(Boolean))].slice(0, 4);
  const jobRows = jobIds.length ? await read("sourceJobs", () => db.jobInstance.findMany({
    where: { ...scope, jobKey: "subscriber_directory_scan", id: { in: jobIds } }, take: 4,
    orderBy: { id: "asc" }, select: JOB_SELECT,
  })) : [];
  const signals = (signalRows || []).map(signal => ({
    id: text(signal.id), kind: oneOf(signal.kind, ["RECOVERY", "RETENTION", "DERIVED_PLANNING"]), reason: machineLabel(signal.reason),
    revision: Number(signal.revision || 0), attempts: Number(signal.attempts || 0),
    dueAt: iso(signal.dueAt), overdueMs: age(signal.dueAt, now),
    due: Boolean(iso(signal.dueAt) && +new Date(signal.dueAt) <= +now),
    owner: ownerState(signal.claimToken, signal.claimUntil, now),
    updatedAt: iso(signal.updatedAt), lastError: safeSubscriberDiagnosticError(signal.lastError),
  }));
  const jobs = (jobRows || []).map(job => summarizeJob(job, now));
  const blockers = [];
  const recovery = signals.find(signal => signal.kind === "RECOVERY");
  if (debtRun) {
    if (!recovery && !readFailures.some(item => item.read === "maintenanceSignals")) blockers.push("RECOVERY_SIGNAL_MISSING");
    if (recovery?.attempts >= 100) blockers.push("RECOVERY_ATTEMPT_LIMIT_REACHED");
    if (recovery?.owner.leaseActive) blockers.push("RECOVERY_OWNER_ACTIVE");
    if (recovery?.owner.leaseExpired) blockers.push("RECOVERY_OWNER_EXPIRED");
    if (recovery && !recovery.due) blockers.push("RECOVERY_BACKOFF");
    if (debtRun.publicationStatus === "RECOLLECTING") blockers.push("WAITING_FOR_RECOLLECTION");
    if (debtRun.publicationStatus === "COMPLETE" && !debtRun.publicationJobReconciledAt) blockers.push("WAITING_FOR_JOB_RECONCILIATION");
    if (debtRun.jobId && jobRows && !jobRows.some(job => job.id === debtRun.jobId)) blockers.push("SOURCE_JOB_MISSING_OR_OUT_OF_SCOPE");
    if (admission && age(admission.lastAdmittedAt, now) > 120_000) blockers.push("MAINTENANCE_ADMISSION_STALE");
  }
  if (!debtRun && jobs.some(job => job.status === "PUBLISHING") && !readFailures.some(item => item.read === "publicationDebt")) {
    blockers.push("PUBLISHING_JOB_WITHOUT_ELIGIBLE_DEBT_RUN");
  }
  if (work?.state === "BLOCKED" || work?.state === "RECONCILE_REQUIRED") blockers.push("RECURRING_PLANNING_BLOCKED");
  if (readFailures.length) blockers.push("DIAGNOSTIC_READ_INCOMPLETE");
  return {
    version: 1, readOnly: true, observedAt, scope, blockers, readFailures,
    reconciliationSearch: "REFERENCED_RUNS_AND_JOBS_ONLY",
    state: state ? {
      id: text(state.id), status: text(state.status, 40), currentRunId: text(state.currentRunId), previousRunId: text(state.previousRunId),
      lastJobId: text(state.lastJobId), allocatedGeneration: Number(state.publicationGeneration || 0),
      publishedGeneration: Number(state.publishedGeneration || 0), totalCount: Number(state.totalCount || 0),
      publishedAt: iso(state.publishedAt), nextScanAt: iso(state.nextScanAt), updatedAt: iso(state.updatedAt),
      lastError: safeSubscriberDiagnosticError(state.lastError),
    } : null,
    debtRun: summarizeRun(debtRun, state, now), latestRun: summarizeRun(latestRun, state, now), jobs, signals,
    recurringWork: work ? {
      id: text(work.id), state: text(work.state, 40), outstanding: Boolean(work.isOutstanding),
      generation: text(work.activeGeneration, 120), requestedRevision: String(work.requestedRevision ?? 0),
      completedRevision: String(work.completedRevision ?? 0), claimedRevision: String(work.claimedRevision ?? 0),
      claimFence: String(work.claimFence ?? 0), owner: ownerState(work.ownerToken, work.leaseUntil, now),
      availableAt: iso(work.availableAt), nextAttemptAt: iso(work.nextAttemptAt), attempts: Number(work.attempts || 0),
      consecutiveFailures: Number(work.consecutiveFailures || 0), lastFailureAt: iso(work.lastFailureAt), updatedAt: iso(work.updatedAt),
      errorClass: knownCode(work.errorClass), terminalCause: safeSubscriberDiagnosticError(work.terminalCause),
      lastError: safeSubscriberDiagnosticError(work.lastError),
      lastPlanningCycleAt: iso(work.progressCursor?.lastPlanningCycleAt), nextPlanningCycleAt: iso(work.progressCursor?.nextPlanningCycleAt),
      lastFullPlanningAt: iso(work.progressCursor?.lastFullPlanningAt),
      lastSubscriberDerivedGeneration: Number(work.progressCursor?.lastSubscriberDerivedGeneration || 0),
    } : null,
    maintenanceAdmission: admission ? {
      generation: text(admission.generation, 80), lane: text(admission.laneName, 120), turnCount: String(admission.turnCount ?? 0),
      lastAdmittedAt: iso(admission.lastAdmittedAt), ageMs: age(admission.lastAdmittedAt, now),
      meaning: "dispatch_opportunity_not_completed_work",
    } : null,
  };
}

module.exports = { inspectSubscriberRecoveryDiagnostics, safeSubscriberDiagnosticError,
  _test: { SUBSCRIBER_DEBT_DIAGNOSTIC_SQL } };
