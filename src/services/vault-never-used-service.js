"use strict";
const { mediaOffset, exactMediaCount, readMediaPage, readMediaSnapshot } = require("./media-read-page");

const prisma = require("../prisma");
const { getVaultUnsortedState } = require("./vault-unsorted-service");
const {
  DIALOG_INTELLIGENCE_JOB_KEY,
  autoRecoverDialogDiscoveryTx,
  autoRecoverDialogHistoryTx,
  repairRegressedDialogDiscoveryTx,
  finalizeCommittedDialogDiscoveryTx,
} = require("./dialog-intelligence-service");
const { DIALOG_HISTORY_BATCH_DIALOG_ID } = require("./dialog-history-batch-service");
const { isTerminalDialogText } = require("./dialog-terminal-outcome");

const PROJECTION_CHUNK_SIZE = 5000;
const LIST_SCAN_CHUNK_SIZE = 500;
// Freshness is maintained by the backend-owned daily cycle. Renderer status
// polling must never turn a three-hour display threshold into an unsolicited
// heavy rescan.
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PROJECTION_CACHE_LIMIT = 500;
const MEDIA_TYPES = new Set(["photo", "video", "audio", "gif", "unknown"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestamp(value) {
  if (!value) return NaN;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function mostRecent(values) {
  const times = values.map(timestamp).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function oldest(values) {
  const times = values.map(timestamp).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function staleAfterMs(value = process.env.ONLINOD_NEVER_USED_STALE_AFTER_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : DEFAULT_STALE_AFTER_MS;
}


function normalizeMediaType(value) {
  const type = clean(value, 20).toLowerCase();
  return MEDIA_TYPES.has(type) ? type : "unknown";
}

async function requireCreator(db, agencyId, creatorId) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    throw error;
  }
  return creator;
}

function isTerminalDialogFailureText(value) {
  return isTerminalDialogText(value);
}

async function resolveLegacyTerminalDialogFailures(db, agencyId, creatorId) {
  if (typeof db?.dialogScanState?.findMany !== "function" || typeof db?.dialogScanState?.updateMany !== "function") {
    return 0;
  }
  const failedRows = await db.dialogScanState.findMany({
    where: {
      agencyId,
      creatorId,
      status: "FAILED",
    },
    select: { dialogId: true, lastError: true },
    take: 10_000,
  });
  const dialogIds = failedRows
    .filter((row) => isTerminalDialogFailureText(row.lastError))
    .map((row) => clean(row.dialogId, 180))
    .filter(Boolean);
  if (!dialogIds.length) return 0;
  const result = await db.dialogScanState.updateMany({
    where: {
      agencyId,
      creatorId,
      dialogId: { in: dialogIds },
      status: "FAILED",
    },
    data: {
      status: "UNAVAILABLE",
      // FAILED is terminal, so any ownership pointer left behind is stale.
      // Clear it while repairing the row; otherwise claim/pause/projection can
      // disagree forever about who owns this dialog.
      activeRunId: null,
      activeJobId: null,
    },
  });
  return number(result?.count);
}

async function readDialogPlanStats(db, agencyId, creatorId, selection, generation, startedAt) {
  const [row] = await db.$queryRawUnsafe(`
    WITH plan AS NOT MATERIALIZED (
      SELECT "dialogId", status, "initialScanComplete", "pagesProcessed", "messagesProcessed",
        "lastIncrementalScanAt", "lastFullScanAt", "lastError", "updatedAt"
      FROM "DialogScanState"
      WHERE "agencyId"=$1 AND "creatorId"=$2 AND "dialogId" <> '__dialog_discovery__'
        AND ($3::text='all' OR ($3::text='generation' AND generation=$4::integer)
          OR ($3::text='since' AND "updatedAt">=$5::timestamp))
    )
    SELECT COUNT(*) AS discovered,
      COUNT(*) FILTER (WHERE "initialScanComplete") AS "initialComplete",
      COUNT(*) FILTER (WHERE UPPER(BTRIM(status)) IN ('READY','COMPLETED')) AS completed,
      COUNT(*) FILTER (WHERE status='PAUSED') AS "pausedCount",
      COUNT(*) FILTER (WHERE status='FAILED') AS failed,
      COUNT(*) FILTER (WHERE status='UNAVAILABLE') AS unavailable,
      COUNT(*) FILTER (WHERE status='PLANNED') AS planned,
      COUNT(*) FILTER (WHERE status='QUEUED') AS "queuedStates",
      COUNT(*) FILTER (WHERE status='RUNNING') AS "runningStates",
      COALESCE(SUM("pagesProcessed"),0) AS "pagesCommitted",
      COALESCE(SUM("messagesProcessed"),0) AS "messagesCommitted",
      MAX("updatedAt") AS "lastUpdatedAt",
      MAX(COALESCE("lastIncrementalScanAt","lastFullScanAt"))
        FILTER (WHERE "initialScanComplete") AS "lastSuccessfulScanAt",
      -- Prisma's timestamp columns store UTC. JSON must carry an explicit zone
      -- too, rather than being parsed as the Node host's local wall-clock time.
      (SELECT jsonb_build_object('dialogId',p."dialogId",'lastError',p."lastError",'updatedAt',p."updatedAt" AT TIME ZONE 'UTC')
       FROM plan p WHERE status='FAILED' AND "lastError" IS NOT NULL AND "lastError"<>''
       ORDER BY "updatedAt" DESC,"dialogId" DESC LIMIT 1) AS "failedState"
    FROM plan
  `, agencyId, creatorId, selection, generation, startedAt);
  const result = { ...row };
  for (const key of ["discovered","initialComplete","completed","pausedCount","failed","unavailable",
    "planned","queuedStates","runningStates","pagesCommitted","messagesCommitted"]) result[key] = exactMediaCount(row[key]);
  return result;
}

async function dialogPipelineState(db, agencyId, creatorId) {
  return readMediaSnapshot(db, tx => readDialogPipelineState(tx, agencyId, creatorId));
}

async function readDialogPipelineState(db, agencyId, creatorId) {
  const [discoveryRuns, activeRuns, activeJobs, latestRun] = await Promise.all([
    db.dialogScanRun.findMany({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        jobId: true,
        mode: true,
        status: true,
        generation: true,
        continuation: true,
        progress: true,
        pagesProcessed: true,
        purchaseSignals: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        lastError: true,
      },
    }),
    db.dialogScanRun.findMany({
      where: {
        agencyId,
        creatorId,
        dialogId: { not: "__dialog_discovery__" },
        status: { in: ["QUEUED", "RUNNING", "PAUSED"] },
      },
      orderBy: { updatedAt: "desc" },
      take: 1000,
      select: {
        id: true,
        jobId: true,
        dialogId: true,
        mode: true,
        status: true,
        generation: true,
        continuation: true,
        progress: true,
        pagesProcessed: true,
        messagesProcessed: true,
        lastError: true,
        lastWorkerDeviceId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.jobInstance.findMany({
      where: {
        agencyId,
        creatorId,
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        status: { in: ["SCHEDULED", "CLAIMED"] },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 1000,
      select: {
        id: true,
        status: true,
        params: true,
        progress: true,
        claimedByDeviceId: true,
        leaseUntil: true,
        nextRunAt: true,
        attempts: true,
        lastError: true,
        result: true,
        lastProgressAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.dialogScanRun.findFirst({
      where: { agencyId, creatorId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, completedAt: true, lastError: true },
    }),
  ]);

  const discoveryJobIds = discoveryRuns.map((run) => clean(run.jobId)).filter(Boolean);
  const discoveryJobs = discoveryJobIds.length
    ? await db.jobInstance.findMany({
        where: { id: { in: discoveryJobIds } },
        select: {
          id: true,
          status: true,
          params: true,
          progress: true,
          result: true,
          claimedByDeviceId: true,
          leaseUntil: true,
          nextRunAt: true,
          attempts: true,
          lastError: true,
          lastProgressAt: true,
          createdAt: true,
          updatedAt: true,
        },
        take: discoveryJobIds.length,
      })
    : [];
  const discoveryJobById = new Map(discoveryJobs.map((job) => [job.id, job]));
  const activeDiscoveryJob = activeJobs.find(
    (job) => clean(object(job.params).dialogId) === "__dialog_discovery__",
  ) || null;
  const activeDiscoveryRunId = clean(object(activeDiscoveryJob?.params).scanRunId, 160);
  const activeDiscoveryRun = activeDiscoveryRunId
    ? discoveryRuns.find((run) => run.id === activeDiscoveryRunId) || null
    : null;
  // Follow the newest creator-wide plan, whether it is the first full pass or
  // a later incremental pass. Initial completeness is validated separately by
  // DialogScanState.initialScanComplete.
  const latestInitialDiscoveryRun = activeDiscoveryRun || discoveryRuns[0] || null;
  const discoveryJob = activeDiscoveryJob || (latestInitialDiscoveryRun?.jobId
    ? discoveryJobById.get(latestInitialDiscoveryRun.jobId) || null
    : null);

  const runDiscoveryProgress = object(latestInitialDiscoveryRun?.progress);
  const jobDiscoveryProgress = object(discoveryJob?.progress);
  const discoveryProgress = { ...jobDiscoveryProgress, ...runDiscoveryProgress };
  const discoveryFailureRaw = object(object(discoveryJob?.result).failure);
  const discoveryControlRaw = object(object(discoveryJob?.result).control);
  const historyControlRaw = object(object(latestInitialDiscoveryRun?.continuation).historyControl);
  const historyControlState = clean(historyControlRaw.state, 40).toUpperCase();
  const runDiscoveryStatus = jobStatus(latestInitialDiscoveryRun?.status);
  const jobDiscoveryStatus = jobStatus(discoveryJob?.status);
  const terminalDiscoveryStatuses = new Set(["PAUSED", "FAILED", "COMPLETED", "CANCELLED", "CANCELED"]);
  const activeJobMatchesSelectedRun = Boolean(activeDiscoveryJob && latestInitialDiscoveryRun && (
    activeDiscoveryRun?.id === latestInitialDiscoveryRun.id
    || activeDiscoveryJob.id === latestInitialDiscoveryRun.jobId
    || clean(object(activeDiscoveryJob.params).scanRunId, 160) === latestInitialDiscoveryRun.id
  ));
  const discoveryStatusRaw = activeDiscoveryJob && !activeJobMatchesSelectedRun
    ? (jobDiscoveryStatus || runDiscoveryStatus || null)
    : terminalDiscoveryStatuses.has(runDiscoveryStatus)
      ? runDiscoveryStatus
      : (jobDiscoveryStatus || runDiscoveryStatus || null);
  const discoveryStatus = discoveryStatusRaw === "CANCELED" ? "CANCELLED" : discoveryStatusRaw;
  const discoveryPages = Math.max(
    number(latestInitialDiscoveryRun?.pagesProcessed),
    number(discoveryProgress.pages),
  );
  const explicitHasMoreKnown = Object.prototype.hasOwnProperty.call(discoveryProgress, "hasMore");
  // Old completed runs did not always persist hasMore. A non-empty completed
  // run still proves that discovery reached its terminal page; a zero-page run
  // must remain unknown instead of being rendered as hasMore=false.
  const legacyCompletedBoundary = !explicitHasMoreKnown
    && discoveryStatus === "COMPLETED"
    && discoveryPages > 0;
  const discoveryHasMoreKnown = explicitHasMoreKnown || legacyCompletedBoundary;
  const discoveryHasMore = explicitHasMoreKnown
    ? discoveryProgress.hasMore === true
    : legacyCompletedBoundary ? false : null;
  const discoveryCompleted = discoveryStatus === "COMPLETED"
    && discoveryHasMoreKnown
    && discoveryHasMore === false;
  const discoveryFailed = discoveryStatus === "FAILED";
  const discoveryPaused = discoveryStatus === "PAUSED";
  const discoveryCancelled = discoveryStatus === "CANCELLED";
  const discoveryActive = ["SCHEDULED", "CLAIMED"].includes(discoveryStatus);
  const discoveryRunning = discoveryStatus === "CLAIMED";
  const discoveryWaitKind = clean(discoveryProgress.waitKind, 80).toLowerCase();
  const discoveryRetrying = discoveryStatus === "SCHEDULED" && Boolean(discoveryJob?.lastError);
  const discoveryWaitingContext = discoveryStatus === "SCHEDULED" && discoveryWaitKind === "creator_context";
  const discoveryQueued = discoveryStatus === "SCHEDULED" && !discoveryRetrying && !discoveryWaitingContext;

  const planGeneration = number(latestInitialDiscoveryRun?.generation);
  const discoveryStartedAt = timestamp(latestInitialDiscoveryRun?.createdAt);
  // Count the whole selected plan in SQL. A capped array of states can hide
  // a pending tail and falsely authorize the Never Used projection.
  const planSelection = !latestInitialDiscoveryRun ? "empty"
    : discoveryActive ? "all" : planGeneration > 0 ? "generation"
      : Number.isFinite(discoveryStartedAt) ? "since" : "all";
  const stats = await readDialogPlanStats(db, agencyId, creatorId, planSelection,
    planGeneration, Number.isFinite(discoveryStartedAt) ? new Date(discoveryStartedAt) : null);

  const historyActiveJobs = activeJobs.filter((job) => {
    const params = object(job.params);
    if (clean(params.dialogId) === "__dialog_discovery__") return false;
    return planGeneration <= 0 || number(params.generation, -1) === planGeneration;
  });
  const activePlanRuns = activeRuns.filter(
    (run) => planGeneration <= 0 || number(run.generation, -1) === planGeneration,
  );
  const activeBatchRuns = activePlanRuns.filter((run) => (
    run.dialogId === DIALOG_HISTORY_BATCH_DIALOG_ID
      && ["QUEUED", "RUNNING"].includes(jobStatus(run.status))
  ));
  const currentBatchRun = activeBatchRuns[0] || null;
  const currentBatchContinuation = object(currentBatchRun?.continuation);
  const currentBatchProgress = object(currentBatchRun?.progress);
  const currentBatchDialogs = Array.isArray(currentBatchContinuation.dialogs)
    ? currentBatchContinuation.dialogs
    : [];
  const waitKindOf = (job) => clean(object(job?.progress).waitKind, 80).toLowerCase();
  const waitingContextJobs = historyActiveJobs.filter(
    (job) => job.status === "SCHEDULED" && waitKindOf(job) === "creator_context",
  );
  const retryingJobs = historyActiveJobs.filter(
    (job) => job.status === "SCHEDULED" && Boolean(job.lastError),
  );
  const queuedJobs = historyActiveJobs.filter(
    (job) => job.status === "SCHEDULED"
      && !waitingContextJobs.includes(job)
      && !retryingJobs.includes(job),
  );
  const runningJobs = historyActiveJobs.filter((job) => job.status === "CLAIMED");
  const runsById = new Map(activePlanRuns.map((run) => [run.id, run]));
  const historyJob = (jobs) => jobs[0] || null;
  const currentJob = historyJob(runningJobs)
    || historyJob(waitingContextJobs)
    || historyJob(retryingJobs)
    || historyJob(queuedJobs)
    || null;
  const currentParams = object(currentJob?.params);
  const currentRun = runsById.get(clean(currentParams.scanRunId, 160)) || null;
  // Job progress is the live worker heartbeat; run progress is the last
  // durable checkpoint. The live value must win or the UI appears frozen at
  // page 0 until a ten-page checkpoint is committed.
  const currentProgress = {
    ...object(currentRun?.progress),
    ...object(currentJob?.progress),
  };
  const currentFailure = object(object(currentJob?.result).failure);

  const { discovered, initialComplete, completed, pausedCount, failed, unavailable,
    planned, queuedStates, runningStates, pagesCommitted, messagesCommitted, failedState } = stats;
  const pending = planned + queuedStates + runningStates + pausedCount;
  // Active rows are diagnostic samples. Saturation must never prove that all
  // workers have drained, even if no sampled row matches the selected plan.
  const activitySampleComplete = activeJobs.length < 1000 && activeRuns.length < 1000;

  const structuredFailure = (raw, fallback = {}) => {
    const source = object(raw);
    if (!Object.keys(source).length && !fallback.error) return null;
    return {
      code: clean(source.code, 120) || fallback.code || null,
      status: Number.isFinite(Number(source.status)) ? Number(source.status) : null,
      retryable: source.retryable === true
        || (source.retryable == null && fallback.retryable === true),
      retryAfterMs: Number.isFinite(Number(source.retryAfterMs)) ? Number(source.retryAfterMs) : null,
      phase: clean(source.phase, 80) || fallback.phase || null,
      endpointKey: clean(source.endpointKey, 120) || null,
      detail: clean(source.detail || source.message || fallback.error, 1000) || null,
      dialogId: clean(source.dialogId, 180) || fallback.dialogId || null,
      page: number(source.page),
      offset: number(source.offset),
      nextOffset: number(source.nextOffset),
      cursorType: clean(source.cursorType, 40) || null,
      cursorIn: clean(source.cursorIn, 240) || null,
    };
  };
  const currentRetrying = currentJob?.status === "SCHEDULED" && Boolean(currentJob.lastError);
  const currentError = (currentRetrying || currentFailure.code || currentFailure.detail || currentFailure.message)
    ? structuredFailure(currentFailure, {
        error: currentJob?.lastError || currentRun?.lastError || null,
        retryable: currentRetrying,
        phase: "dialog_history",
        dialogId: clean(currentParams.dialogId, 180) || currentRun?.dialogId || null,
      })
    : null;
  const discoveryError = (discoveryFailed || discoveryRetrying || Object.keys(discoveryFailureRaw).length)
    ? structuredFailure(discoveryFailureRaw, {
        error: discoveryJob?.lastError || latestInitialDiscoveryRun?.lastError || null,
        retryable: discoveryRetrying,
        phase: "dialog_discovery",
      })
    : null;
  const lastFailure = failedState ? {
    dialogId: failedState.dialogId,
    error: failedState.lastError,
    updatedAt: iso(failedState.updatedAt),
  } : null;
  const lastError = discoveryError?.detail
    || currentError?.detail
    || ((historyActiveJobs.length || activeBatchRuns.length) ? null : failedState?.lastError)
    || null;
  const lastUpdatedAt = mostRecent([
    currentBatchRun?.updatedAt,
    discoveryJob?.lastProgressAt,
    discoveryJob?.updatedAt,
    latestInitialDiscoveryRun?.updatedAt,
    currentJob?.lastProgressAt,
    currentJob?.updatedAt,
    currentRun?.updatedAt,
    latestRun?.updatedAt,
    stats.lastUpdatedAt,
  ]);

  return {
    discovered,
    initialComplete,
    activitySampleComplete,
    active: historyActiveJobs.length + activeBatchRuns.length + (discoveryActive ? 1 : 0) + pausedCount,
    paused: pausedCount > 0 || discoveryPaused || historyControlState === "PAUSED",
    failed,
    unavailable,
    pending,
    pagesCommitted,
    messagesCommitted,
    discoveryCompleted,
    activeJobStatus: currentJob?.status || (currentBatchRun ? "CLAIMED" : null) || discoveryStatus || null,
    claimedByDeviceId: currentJob?.claimedByDeviceId || clean(currentBatchContinuation.claimedByDeviceId, 200) || discoveryJob?.claimedByDeviceId || null,
    leaseUntil: iso(currentJob?.leaseUntil || currentBatchContinuation.leaseUntil || discoveryJob?.leaseUntil),
    nextRunAt: iso(currentJob?.nextRunAt || discoveryJob?.nextRunAt),
    retries: number(currentJob?.attempts ?? discoveryJob?.attempts),
    lastError,
    lastUpdatedAt,
    lastSuccessfulScanAt: mostRecent([
      discoveryCompleted ? latestInitialDiscoveryRun?.completedAt || latestInitialDiscoveryRun?.updatedAt : null,
      stats.lastSuccessfulScanAt,
    ]),
    discoveryActive,
    historyActive: runningJobs.length > 0 || activeBatchRuns.length > 0,
    queue: {
      total: discovered,
      completed,
      pending,
      planned,
      queued: queuedJobs.length + activeBatchRuns.filter((run) => jobStatus(run.status) === "QUEUED").length,
      running: runningJobs.length + activeBatchRuns.filter((run) => jobStatus(run.status) === "RUNNING").length,
      waitingContext: waitingContextJobs.length,
      retrying: retryingJobs.length,
      paused: pausedCount,
      failed,
      unavailable,
    },
    discovery: {
      completed: discoveryCompleted,
      active: discoveryActive,
      running: discoveryRunning,
      queued: discoveryQueued,
      waitingContext: discoveryWaitingContext,
      retrying: discoveryRetrying,
      status: discoveryStatus,
      failed: discoveryFailed,
      paused: discoveryPaused,
      cancelled: discoveryCancelled,
      generation: planGeneration,
      pages: discoveryPages,
      dialogsFound: discovered,
      hasMoreKnown: discoveryHasMoreKnown,
      hasMore: discoveryHasMore,
      offset: number(discoveryProgress.offset),
      nextOffset: number(discoveryProgress.nextOffset),
      nextRunAt: iso(discoveryJob?.nextRunAt),
      retries: number(discoveryJob?.attempts),
      lastError: discoveryError?.detail || null,
      error: discoveryError,
      control: Object.keys(historyControlRaw).length ? {
        kind: historyControlState || null,
        reason: clean(historyControlRaw.reason, 500) || null,
        at: iso(historyControlRaw.at),
      } : Object.keys(discoveryControlRaw).length ? {
        kind: clean(discoveryControlRaw.kind, 80) || null,
        reason: clean(discoveryControlRaw.reason, 500) || null,
        at: iso(discoveryControlRaw.at),
      } : null,
      progress: discoveryProgress,
    },
    current: currentJob ? {
      dialogId: clean(currentParams.dialogId, 180) || currentRun?.dialogId || null,
      mode: clean(currentParams.mode, 40) || currentRun?.mode || null,
      jobStatus: currentJob.status,
      runStatus: currentRun?.status || null,
      page: number(currentProgress.pages ?? currentRun?.pagesProcessed),
      rawMessages: number(currentProgress.rawMessages),
      committedMessages: number(currentProgress.messages),
      skippedMessages: number(currentProgress.skippedMessages),
      cursorType: clean(currentProgress.cursorType, 40) || null,
      cursorIn: clean(currentProgress.cursorIn, 240) || null,
      cursorOut: clean(currentProgress.cursor, 240) || null,
      claimedByDeviceId: currentJob.claimedByDeviceId || null,
      leaseUntil: iso(currentJob.leaseUntil),
      nextRunAt: iso(currentJob.nextRunAt),
      retries: number(currentJob.attempts),
      waitKind: waitKindOf(currentJob) || null,
      waitReason: clean(object(currentJob.progress).waitReason, 500) || null,
      lastError: currentError?.detail || null,
      error: currentError,
      lastProgressAt: iso(currentJob.lastProgressAt || currentRun?.updatedAt || currentJob.updatedAt),
    } : currentBatchRun ? {
      dialogId: clean(currentBatchProgress.dialogId, 180) || null,
      fanId: clean(currentBatchProgress.fanId, 180) || null,
      mode: clean(currentBatchContinuation.mode, 40) || currentBatchRun.mode || "initial",
      jobStatus: "CLAIMED",
      runStatus: currentBatchRun.status,
      stage: clean(currentBatchProgress.stage, 40) || "scanning",
      message: clean(currentBatchProgress.message, 500) || null,
      page: number(currentBatchProgress.pages),
      rawMessages: number(currentBatchProgress.received ?? currentBatchProgress.messages),
      committedMessages: number(currentBatchProgress.inserted ?? currentBatchProgress.messages),
      updatedMessages: number(currentBatchProgress.updated),
      duplicateMessages: number(currentBatchProgress.duplicates),
      media: number(currentBatchProgress.media),
      skippedMessages: number(currentBatchProgress.skippedHistory),
      cursorType: null,
      cursorIn: null,
      cursorOut: null,
      claimedByDeviceId: clean(currentBatchContinuation.claimedByDeviceId, 200) || currentBatchRun.lastWorkerDeviceId || null,
      leaseUntil: iso(currentBatchContinuation.leaseUntil),
      nextRunAt: null,
      retries: 0,
      waitKind: null,
      waitReason: null,
      lastError: clean(currentBatchProgress.lastError, 2_000) || currentBatchRun.lastError || null,
      error: null,
      batchId: currentBatchRun.id,
      batchSize: currentBatchDialogs.length,
      batchIndex: number(currentBatchProgress.current),
      batchCompleted: number(currentBatchProgress.completed),
      batchFailed: number(currentBatchProgress.failed),
      batchReplanned: number(currentBatchProgress.replanned),
      batchSkipped: number(currentBatchProgress.skipped),
      lastProgressAt: iso(currentBatchProgress.updatedAt || currentBatchRun.updatedAt),
    } : null,
    lastFailure,
  };
}

function emptyByType() {
  return { all: 0, photo: 0, video: 0, audio: 0, gif: 0, unknown: 0 };
}

function emptyProjection(snapshot = null, { deferred = false } = {}) {
  const catalogMedia = number(snapshot?.itemsCount);
  return {
    catalogMedia,
    eligibleCreatorMedia: catalogMedia,
    usedCreatorMedia: 0,
    neverUsed: 0,
    notApplicable: 0,
    unknown: 0,
    byType: emptyByType(),
    rebuiltAt: null,
    complete: false,
    deferred,
  };
}

async function usedMediaIdsForBatch(db, agencyId, creatorId, ids) {
  if (!ids.length) return { ids: new Set(), updatedAt: null };
  const rows = await db.creatorMediaAsset.findMany({
    where: {
      agencyId,
      creatorId,
      catalogActive: true,
      sentCount: { gt: 0 },
      mediaId: { in: ids },
    },
    select: { mediaId: true, usageUpdatedAt: true, updatedAt: true },
    take: ids.length,
  });
  const used = new Set(rows.map((row) => clean(row.mediaId)).filter(Boolean));
  const freshness = rows
    .flatMap((row) => [row.usageUpdatedAt, row.updatedAt])
    .map(timestamp)
    .filter(Number.isFinite);
  return {
    ids: used,
    updatedAt: freshness.length ? new Date(Math.max(...freshness)).toISOString() : null,
  };
}

async function projectionCounts(db, agencyId, creatorId) {
  const byType = emptyByType();
  const neverUsedByType = emptyByType();
  let catalogMedia = 0;
  let usedCreatorMedia = 0;
  let newestEvidenceAt = Number.NEGATIVE_INFINITY;
  // One database aggregate replaces a full catalog walk across unrelated
  // snapshots. No asset IDs need to leave the database to count media.
  const rows = await db.$queryRawUnsafe(`
    SELECT "mediaType", COUNT(*) AS total,
      COUNT(*) FILTER (WHERE "sentCount" > 0) AS used,
      MAX("updatedAt") AS "updatedAt", MAX("usageUpdatedAt") AS "usageUpdatedAt"
    FROM "CreatorMediaAsset"
    WHERE "agencyId" = $1 AND "creatorId" = $2 AND "catalogActive" = true
      AND BTRIM("mediaId") <> ''
    GROUP BY "mediaType"
  `, agencyId, creatorId);
  for (const row of rows) {
    const type = normalizeMediaType(row.mediaType);
    const total = exactMediaCount(row.total), used = exactMediaCount(row.used);
    catalogMedia = exactMediaCount(catalogMedia + total);
    usedCreatorMedia = exactMediaCount(usedCreatorMedia + used);
    byType.all = exactMediaCount(byType.all + total);
    byType[type] = exactMediaCount(byType[type] + total);
    neverUsedByType.all = exactMediaCount(neverUsedByType.all + total - used);
    neverUsedByType[type] = exactMediaCount(neverUsedByType[type] + total - used);
    for (const value of [row.updatedAt, row.usageUpdatedAt]) {
      const at = timestamp(value);
      if (Number.isFinite(at)) newestEvidenceAt = Math.max(newestEvidenceAt, at);
    }
  }

  return {
    catalogMedia,
    eligibleCreatorMedia: catalogMedia,
    usedCreatorMedia,
    neverUsed: Math.max(0, catalogMedia - usedCreatorMedia),
    notApplicable: 0,
    unknown: 0,
    byType: neverUsedByType,
    catalogByType: byType,
    rebuiltAt: Number.isFinite(newestEvidenceAt)
      ? new Date(newestEvidenceAt).toISOString()
      : new Date().toISOString(),
    complete: true,
    deferred: false,
  };
}

async function latestSalesUpdatedAt(db, agencyId, creatorId) {
  const row = await db.creatorMediaAsset.findFirst({
    where: { agencyId, creatorId, catalogActive: true, usageUpdatedAt: { not: null } },
    orderBy: { usageUpdatedAt: "desc" },
    select: { usageUpdatedAt: true },
  });
  return iso(row?.usageUpdatedAt);
}


function jobStatus(value) {
  return clean(value, 40).toUpperCase();
}

function stageFrom({ messages, dialogs, authoritative, stale }) {
  const scanStatus = jobStatus(messages?.snapshot?.scan?.status || "IDLE");
  const messagesJob = jobStatus(messages?.activeJob?.status);
  const messagesWaitKind = clean(object(messages?.activeJob?.progress).waitKind, 80).toLowerCase();
  const dialogJob = jobStatus(dialogs.current?.jobStatus || dialogs.activeJobStatus);
  const dialogWaitKind = clean(dialogs.current?.waitKind, 80).toLowerCase();
  const messagesRetrying = messagesJob === "SCHEDULED" && Boolean(messages?.activeJob?.lastError);
  const messagesWaitingContext = messagesJob === "SCHEDULED" && messagesWaitKind === "creator_context";
  const dialogRetrying = dialogJob === "SCHEDULED" && Boolean(dialogs.current?.lastError);
  const dialogWaitingContext = dialogJob === "SCHEDULED" && dialogWaitKind === "creator_context";
  const historyControl = clean(dialogs.discovery?.control?.kind, 40).toUpperCase();

  if (historyControl === "CANCELLED" || historyControl === "CANCELED") return "CANCELLED";
  if (scanStatus === "PAUSED" || dialogs.paused || dialogs.discovery?.paused || historyControl === "PAUSED") return "PAUSED";
  if (messagesJob === "CLAIMED") return "UPDATING_MESSAGES_CATALOG";

  // Discovery is a strict first phase. No dialog-history state may mask it.
  if (!dialogs.discoveryCompleted) {
    if (dialogs.discovery?.cancelled) return "CANCELLED";
    if (dialogs.discovery.running) return "DISCOVERING_DIALOGS";
    if (dialogs.discovery.waitingContext) return "WAITING_FOR_CREATOR_CONTEXT";
    if (dialogs.discovery.retrying) return "RETRYING";
    if (dialogs.discovery.queued) return "WAITING_FOR_WORKER";
    if (dialogs.discovery.failed) return "FAILED";
    if (["QUEUED", "RUNNING", "SCHEDULED", "CLAIMED"].includes(jobStatus(dialogs.discovery.status))) return "STALLED";
    if (messagesWaitingContext) return "WAITING_FOR_CREATOR_CONTEXT";
    if (messagesRetrying) return "RETRYING";
    if (messagesJob === "SCHEDULED" || scanStatus === "QUEUED") return "WAITING_FOR_WORKER";
    if (scanStatus === "FAILED") return "FAILED";
    if (scanStatus === "CANCELLED") return "CANCELLED";
    return "NOT_SCANNED";
  }

  if (dialogJob === "CLAIMED" || dialogs.queue.running > 0 || dialogs.historyActive) return "SCANNING_DIALOG_HISTORY";
  if (messagesWaitingContext || dialogWaitingContext || dialogs.queue.waitingContext > 0) return "WAITING_FOR_CREATOR_CONTEXT";
  if (messagesRetrying || dialogRetrying || dialogs.queue.retrying > 0) return "RETRYING";
  if (messagesJob === "SCHEDULED" || dialogJob === "SCHEDULED" || dialogs.queue.queued > 0 || scanStatus === "QUEUED") return "WAITING_FOR_WORKER";
  if (dialogs.queue.planned > 0 && dialogs.active === 0) return "WAITING_FOR_WORKER";
  if (scanStatus === "FAILED" || (dialogs.failed > 0 && dialogs.pending === 0 && dialogs.active === 0)) return "FAILED";
  if (scanStatus === "CANCELLED") return "CANCELLED";
  if (authoritative && stale) return "STALE";
  if (authoritative) return "UP_TO_DATE";
  if (dialogs.pending > 0) return "WAITING_FOR_WORKER";
  return "NOT_SCANNED";
}

async function loadPipelineSources({ agencyId, creatorId, db }) {
  await requireCreator(db, agencyId, creatorId);
  const [messages, dialogs, salesAt] = await Promise.all([
    getVaultUnsortedState({ agencyId, creatorId, db }),
    dialogPipelineState(db, agencyId, creatorId),
    latestSalesUpdatedAt(db, agencyId, creatorId),
  ]);
  return { messages, dialogs, salesAt };
}

async function getNeverUsedPipelineState({ agencyId, creatorId, db = prisma, now = new Date(), staleAfter = null }) {
  // Recoverable OF discovery anomalies are internal continuation states. Status
  // polling revives the preserved durable checkpoint automatically; operators
  // never need to restart or rebuild thousands of already discovered dialogs.
  try {
    await resolveLegacyTerminalDialogFailures(db, agencyId, creatorId);
    // Final hasMore=false discovery chunks are already durable. Repair the
    // narrow lost-completion gap before any cursor-regression recovery can
    // accidentally reschedule the fully collected list from page zero.
    await finalizeCommittedDialogDiscoveryTx(db, { agencyId, creatorId, now });
    await repairRegressedDialogDiscoveryTx(db, { agencyId, creatorId });
    await autoRecoverDialogDiscoveryTx(db, {
      agencyId,
      creatorId,
      source: "never_used_status_auto_recovery",
      priority: 90,
    });
    await autoRecoverDialogHistoryTx(db, {
      agencyId,
      creatorId,
      source: "never_used_status_history_recovery",
      priority: 60,
    });
  } catch {
    // Status remains readable even if best-effort recovery cannot be scheduled.
  }
  const { messages, dialogs, salesAt } = await loadPipelineSources({ agencyId, creatorId, db });
  const messagesComplete = Boolean(messages.snapshot?.lastFullScanAt && messages.snapshot?.scan?.status === "COMPLETED");
  const dialogsDrained = Boolean(
    dialogs.discoveryCompleted
      && dialogs.activitySampleComplete
      && dialogs.active === 0
      && dialogs.failed === 0
      && dialogs.pending === 0,
  );
  const dialogsComplete = Boolean(
    dialogsDrained
      && dialogs.initialComplete + dialogs.unavailable === dialogs.discovered,
  );
  const authoritative = messagesComplete && dialogsComplete;
  const reasons = [];
  if (!messagesComplete) reasons.push("Messages catalog initial scan is incomplete");
  if (!dialogsDrained) reasons.push("dialog history initial scan is incomplete");

  const messagesAt = messages.snapshot?.lastIncrementalScanAt || messages.snapshot?.lastMergeScanAt || messages.snapshot?.lastFullScanAt || null;
  const dialogsAt = dialogs.lastSuccessfulScanAt || null;
  const sourceOldestAt = authoritative ? oldest([messagesAt, dialogsAt]) : null;
  const thresholdMs = staleAfterMs(staleAfter);
  const nowMs = timestamp(now);
  const oldestMs = timestamp(sourceOldestAt);
  const stale = authoritative && (!Number.isFinite(oldestMs) || (Number.isFinite(nowMs) && nowMs - oldestMs >= thresholdMs));
  const staleSources = [];
  if (stale) {
    for (const [name, value] of [["Messages catalog", messagesAt], ["dialog history", dialogsAt]]) {
      const valueMs = timestamp(value);
      if (!Number.isFinite(valueMs) || nowMs - valueMs >= thresholdMs) staleSources.push(name);
    }
  }

  const stage = stageFrom({ messages, dialogs, authoritative, stale });
  const workActive = [
    "UPDATING_MESSAGES_CATALOG",
    "DISCOVERING_DIALOGS",
    "SCANNING_DIALOG_HISTORY",
    "WAITING_FOR_WORKER",
    "WAITING_FOR_CREATOR_CONTEXT",
    "RETRYING",
    "STALLED",
  ].includes(stage);
  const projection = authoritative && !workActive
    ? await projectionCounts(db, agencyId, creatorId)
    : emptyProjection(messages.snapshot, { deferred: workActive || !authoritative });

  let progressPercent = 0;
  let progressIndeterminate = false;
  if (messagesComplete) progressPercent += 35;
  else if (["UPDATING_MESSAGES_CATALOG", "WAITING_FOR_WORKER", "WAITING_FOR_CREATOR_CONTEXT", "RETRYING", "STALLED"].includes(stage)) {
    progressPercent = 5;
    progressIndeterminate = true;
  }
  if (messagesComplete && dialogs.discoveryCompleted) progressPercent = Math.max(progressPercent, 40);
  if (dialogs.discovered > 0) {
    progressPercent = Math.max(progressPercent, 40 + Math.round(((dialogs.queue.completed + dialogs.queue.unavailable) / dialogs.discovered) * 55));
  } else if (messagesComplete && ["DISCOVERING_DIALOGS", "WAITING_FOR_WORKER", "WAITING_FOR_CREATOR_CONTEXT", "STALLED"].includes(stage)) {
    progressIndeterminate = true;
  }
  if (authoritative) progressPercent = 100;

  const updatedValues = [messages.snapshot?.updatedAt, dialogs.lastUpdatedAt, projection.rebuiltAt, salesAt]
    .map(timestamp)
    .filter(Number.isFinite);

  return {
    ok: true,
    creatorId,
    pipeline: {
      creatorId,
      stage,
      authoritative,
      provisionalReason: authoritative ? null : reasons.join("; "),
      stale,
      staleReason: stale ? `${staleSources.join(", ")} older than ${Math.round(thresholdMs / 3_600_000)}h` : null,
      progressPercent: Math.max(0, Math.min(100, progressPercent)),
      progressIndeterminate,
      messagesCatalog: messages.snapshot,
      unsorted: messages.snapshot,
      dialogs: {
        discovered: dialogs.discovered,
        initialComplete: dialogs.initialComplete,
        active: dialogs.active,
        paused: dialogs.paused,
        failed: dialogs.failed,
        unavailable: dialogs.unavailable,
        pending: dialogs.pending,
        pagesCommitted: dialogs.pagesCommitted,
        messagesCommitted: dialogs.messagesCommitted,
        discoveryCompleted: dialogs.discoveryCompleted,
        activeJobStatus: dialogs.activeJobStatus,
        claimedByDeviceId: dialogs.claimedByDeviceId,
        leaseUntil: dialogs.leaseUntil,
        nextRunAt: dialogs.nextRunAt,
        retries: dialogs.retries,
        lastError: dialogs.lastError,
        lastUpdatedAt: dialogs.lastUpdatedAt,
        lastSuccessfulScanAt: dialogs.lastSuccessfulScanAt,
        queue: dialogs.queue,
        discovery: dialogs.discovery,
        current: dialogs.current,
        lastFailure: dialogs.lastFailure,
      },
      freshness: {
        messagesAt: iso(messagesAt),
        dialogsAt: iso(dialogsAt),
        oldestAt: sourceOldestAt,
        staleAfterMs: thresholdMs,
      },
      projection,
      updatedAt: updatedValues.length ? new Date(Math.max(...updatedValues)).toISOString() : null,
    },
  };
}

function rowToMedia(row) {
  const type = normalizeMediaType(row.mediaType);
  return {
    id: String(row.mediaId),
    type,
    name: `${type === "unknown" ? "media" : type} #${row.mediaId}`,
    createdAt: null,
    duration: integer(row.durationSec, 0, 0, 24 * 60 * 60),
    thumbUrl: row.thumbUrl || "",
    previewUrl: row.previewUrl || row.thumbUrl || "",
    fullUrl: row.fullUrl || row.previewUrl || row.thumbUrl || "",
    folderIds: Array.isArray(row.folderIds) ? row.folderIds : [],
    lastSeenAt: iso(row.lastSeenAt),
  };
}

async function listVaultNeverUsedMedia({ agencyId, creatorId, offset = 0, limit = 40, type = null, db = prisma }) {
  const pipelineResult = await getNeverUsedPipelineState({ agencyId, creatorId, db });
  const pipeline = pipelineResult.pipeline;
  if (!pipeline?.authoritative) {
    return {
      ok: false,
      creatorId,
      media: [],
      total: 0,
      offset: integer(offset),
      nextOffset: integer(offset),
      hasMore: false,
      pipeline,
      code: "VAULT_NEVER_USED_NOT_AUTHORITATIVE",
      error: pipeline?.provisionalReason || "Initial Messages and dialog scans are incomplete",
    };
  }

  const safeOffset = mediaOffset(offset);
  const safeLimit = integer(limit, 40, 1, 100);
  const mediaType = type ? normalizeMediaType(type) : null;
  const where = {
    agencyId,
    creatorId,
    catalogActive: true,
    sentCount: 0,
    ...(mediaType ? { mediaType } : {}),
  };
  const { rows, count: total } = await readMediaPage(db, {
    where, orderBy: [{ lastSeenAt: "desc" }, { mediaId: "desc" }], offset: safeOffset, limit: safeLimit,
  });
  const media = rows.map(rowToMedia);
  const nextOffset = safeOffset + media.length;
  return {
    ok: true,
    creatorId,
    media,
    total,
    offset: safeOffset,
    nextOffset,
    hasMore: nextOffset < total,
    pipeline,
  };
}

module.exports = {
  PROJECTION_CHUNK_SIZE,
  LIST_SCAN_CHUNK_SIZE,
  DEFAULT_STALE_AFTER_MS,
  PROJECTION_CACHE_LIMIT,
  getNeverUsedPipelineState,
  listVaultNeverUsedMedia,
  dialogPipelineState,
  projectionCounts,
  usedMediaIdsForBatch,
  stageFrom,
};
