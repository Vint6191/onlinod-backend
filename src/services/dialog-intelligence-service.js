"use strict";

const prisma = require("../prisma");

const DIALOG_INTELLIGENCE_JOB_KEY = "dialog_intelligence_scan";
const ACTIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "PAUSED"];
const DIALOG_CONTROL_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 60_000 });
const RECOVERABLE_DISCOVERY_FAILURE_CODES = new Set([
  "DIALOG_DISCOVERY_EMPTY_PAGE_WITH_HAS_MORE",
  // Compatibility with the async-100 build that treated an echoed OF offset as
  // a terminal cursor failure. New Desktop builds own the offset cursor and no
  // longer emit this error, but existing failed runs must resume from their last
  // durable 100-dialog checkpoint instead of forcing a destructive full rescan.
  "DIALOG_DISCOVERY_CURSOR_STALLED",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function list(value) { return Array.isArray(value) ? value : []; }
function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}
function integer(value, fallback = 0, min = 0, max = 2_000_000_000) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function messageUnique(creatorId, messageId) { return { creatorId_messageId: { creatorId, messageId } }; }
const {
  classifyPurchase,
  purchaseCountsAsRevenue,
  purchaseIdempotencyKey,
  allocatePackagePrice,
  evaluateIncrementalStop,
} = require("./dialog-intelligence-domain");

async function assertCreator(db, agencyId, creatorId) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, remoteId: true, status: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  return creator;
}

async function moduleControl(db, agencyId) {
  const row = await db.moduleSetting.findUnique({
    where: { agencyId_moduleKey: { agencyId, moduleKey: "dialog_intelligence" } },
  });
  return {
    enabled: row?.enabled !== false,
    config: object(row?.config),
    status: row?.status || "active",
  };
}

function jobContinuationValue(value) {
  const continuation = object(value);
  if (continuation.driverPhase === "execute") return object(continuation.jobContinuation);
  return continuation;
}

function nonNegativeIntegerOrNull(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function durableDialogDiscoveryCheckpoint(db, input) {
  const run = input?.run;
  if (!run?.id || typeof db?.dialogScanChunkCommit?.findMany !== "function") return null;
  const commits = await db.dialogScanChunkCommit.findMany({
    where: { runId: run.id, mode: "discovery" },
    select: { cursorOut: true, page: true },
    take: 10_000,
  });
  let offset = -1;
  let page = 0;
  for (const commit of commits || []) {
    const cursorOut = nonNegativeIntegerOrNull(commit?.cursorOut);
    if (cursorOut == null) continue;
    const nextPage = integer(commit?.page, 0) + 1;
    if (cursorOut > offset) {
      offset = cursorOut;
      page = nextPage;
    } else if (cursorOut === offset) {
      page = page > 0 ? Math.min(page, nextPage) : nextPage;
    }
  }
  if (offset < 0) return null;

  const runProgress = object(run.progress);
  const runContinuation = object(run.continuation);
  let dialogsFound = Math.max(
    integer(runProgress.dialogsFound ?? runProgress.dialogs, 0),
    integer(runContinuation.dialogsFound, 0),
  );
  if (typeof db?.dialogScanState?.count === "function") {
    const generation = integer(input.generation ?? run.generation, run.generation || 0);
    const count = await db.dialogScanState.count({
      where: {
        agencyId: input.agencyId,
        creatorId: input.creatorId,
        dialogId: { not: "__dialog_discovery__" },
        generation,
      },
    });
    dialogsFound = Math.max(dialogsFound, integer(count, 0));
  }
  return { offset, page, dialogsFound };
}

function discoveryResumeContinuation({ resumeContinuation, fallbackResumeContinuation, checkpoint }) {
  const resume = object(resumeContinuation);
  const fallback = object(fallbackResumeContinuation);
  let merged = Object.keys(resume).length ? { ...resume } : { ...fallback };
  for (const key of ["stage", "mode", "dialogId", "offset", "page", "childMode", "dialogsFound", "maxPages"]) {
    if (merged[key] == null && fallback[key] != null) merged[key] = fallback[key];
  }
  if (checkpoint && integer(merged.offset, 0) < checkpoint.offset) {
    merged = {
      ...merged,
      offset: checkpoint.offset,
      page: checkpoint.page,
      dialogsFound: Math.max(integer(merged.dialogsFound, 0), checkpoint.dialogsFound),
      emptyPageAttempts: 0,
      tailProbeBaseOffset: null,
      tailProbeIndex: 0,
    };
  }
  return merged;
}

async function enqueueReconciliationTarget(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  const dialogId = clean(input.dialogId, 180);
  const messageId = clean(input.messageId ?? input.targetMessageId, 240);
  if (!agencyId || !creatorId || !dialogId || !messageId) return null;
  const now = new Date();
  return db.dialogReconciliationTarget.upsert({
    where: { creatorId_dialogId_messageId: { creatorId, dialogId, messageId } },
    create: {
      agencyId,
      creatorId,
      dialogId,
      messageId,
      fanId: clean(input.fanId, 160),
      source: clean(input.source, 80) || "targeted_reconciliation",
      status: "PENDING",
      priority: integer(input.priority, 120, 0, 200),
      requestedAt: now,
    },
    update: {
      fanId: clean(input.fanId, 160) || undefined,
      source: clean(input.source, 80) || undefined,
      status: "PENDING",
      priority: integer(input.priority, 120, 0, 200),
      requestedAt: now,
      resolvedAt: null,
      lastError: null,
    },
  });
}

async function nextReconciliationTarget(db, input) {
  return db.dialogReconciliationTarget.findFirst({
    where: {
      agencyId: input.agencyId,
      creatorId: input.creatorId,
      dialogId: input.dialogId,
      status: "PENDING",
      ...(input.excludeMessageId ? { messageId: { not: input.excludeMessageId } } : {}),
    },
    orderBy: [{ priority: "desc" }, { requestedAt: "asc" }, { id: "asc" }],
  });
}

async function touchReconciliationTarget(db, target) {
  if (!target?.id) return null;
  return db.dialogReconciliationTarget.update({
    where: { id: target.id },
    data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), lastError: null },
  });
}

function targetedContinuation(target, resumeState, knownMessageThreshold) {
  return {
    stage: "TARGETED_RECONCILIATION",
    mode: "targeted",
    dialogId: target.dialogId,
    cursor: null,
    offset: 0,
    page: 0,
    targetMessageId: target.messageId,
    watermark: clean(object(resumeState).watermark, 240),
    watermarkAt: clean(object(resumeState).watermarkAt, 80),
    watermarkReached: object(resumeState).watermarkReached === true,
    knownUnchangedStreak: 0,
    knownMessageThreshold,
    maxPages: 1,
    resumeState: object(resumeState),
  };
}

async function scheduleDialogScanTx(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  const dialogId = clean(input.dialogId, 180);
  if (!agencyId || !creatorId || !dialogId) throw new Error("agencyId, creatorId and dialogId are required");
  await assertCreator(db, agencyId, creatorId);
  const control = await moduleControl(db, agencyId);
  if (!control.enabled) return { ok: true, created: false, reason: "module_disabled" };

  const state = await db.dialogScanState.findUnique({ where: { creatorId_dialogId: { creatorId, dialogId } } });
  const requestedMode = clean(input.mode, 40) || (state?.initialScanComplete ? "incremental" : "initial");
  const mode = requestedMode === "full" ? "initial" : requestedMode;
  const now = new Date();
  const requestedPriority = integer(input.priority, mode === "targeted" ? 160 : 70, 0, 200);
  const targetMessageId = clean(input.targetMessageId, 240);
  const durableTarget = mode === "targeted" && targetMessageId
    ? await enqueueReconciliationTarget(db, {
        agencyId,
        creatorId,
        dialogId,
        messageId: targetMessageId,
        fanId: input.fanId,
        source: input.source,
        priority: requestedPriority,
      })
    : null;

  let active = await db.dialogScanRun.findFirst({
    where: { agencyId, creatorId, dialogId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: { createdAt: "desc" },
  });

  // Manual/automatic non-destructive starts may recover a terminal job from its
  // last committed continuation. This is intentionally narrow: explicit full
  // rescans still create a clean generation, while transient/retryable failures
  // (including an OF empty page that still advertises hasMore=true) continue
  // from the durable offset instead of throwing away thousands of list pages.
  if (!active && input.forceChildFull !== true) {
    const failedRun = await db.dialogScanRun.findFirst({
      where: { agencyId, creatorId, dialogId, status: "FAILED" },
      orderBy: { createdAt: "desc" },
    });
    const failedJob = failedRun?.jobId
      ? await db.jobInstance.findUnique({ where: { id: failedRun.jobId } })
      : null;
    const failure = object(object(failedJob?.result).failure);
    const failureCode = clean(failure.code, 160);
    const checkpointRecoverable = failure.retryable === true
      || RECOVERABLE_DISCOVERY_FAILURE_CODES.has(failureCode);
    if (failedRun && checkpointRecoverable) active = failedRun;
  }

  if (active) {
    const activeJob = active.jobId ? await db.jobInstance.findUnique({ where: { id: active.jobId } }) : null;
    if (activeJob && ["SCHEDULED", "CLAIMED"].includes(activeJob.status)) {
      const params = object(activeJob.params);
      const updatedJob = await db.jobInstance.update({
        where: { id: activeJob.id },
        data: {
          priority: Math.max(integer(activeJob.priority, 0), requestedPriority),
          nextRunAt: activeJob.status === "SCHEDULED" ? now : undefined,
          params: {
            ...params,
            lastPriorityReason: clean(input.source, 80) || "dialog_open",
            lastPriorityAt: now.toISOString(),
          },
        },
      });
      await db.dialogScanRun.update({
        where: { id: active.id },
        data: { status: active.status === "PAUSED" ? "QUEUED" : undefined, pausedAt: active.status === "PAUSED" ? null : undefined, lastError: null },
      });
      await db.dialogScanState.updateMany({
        where: { creatorId, dialogId },
        data: { status: activeJob.status === "CLAIMED" ? "RUNNING" : "QUEUED", activeRunId: active.id, activeJobId: activeJob.id, lastError: null },
      });
      return {
        ok: true,
        created: false,
        reason: durableTarget ? "targeted_reconciliation_queued" : "active_run_reprioritized",
        run: active,
        job: updatedJob,
      };
    }

    // Resume the same durable run and continuation instead of replacing it.
    const resumeContinuation = object(active.continuation);
    const activeProgress = object(active.progress);
    const activeJobParams = object(activeJob?.params);
    const fallbackResumeContinuation = {
      stage: active.mode === "discovery"
        ? "DIALOG_DISCOVERY"
        : active.mode === "targeted" ? "TARGETED_RECONCILIATION" : "DIALOG_SCAN",
      mode: active.mode,
      dialogId,
      // Chat pagination always starts from the newest page. A saved page cursor
      // is used only to resume an interrupted run; the confirmed watermark is
      // kept separately and must never become the request anchor.
      cursor: active.mode === "initial" ? clean(state?.backwardCursor, 240) : null,
      offset: active.mode === "discovery"
        ? integer(activeProgress.nextOffset ?? object(active.continuation).offset, 0)
        : 0,
      page: integer(active.pagesProcessed ?? activeProgress.pages, 0),
      childMode: active.mode === "discovery"
        ? clean(activeJobParams.childMode ?? input.childMode, 40)
        : null,
      dialogsFound: active.mode === "discovery"
        ? integer(activeProgress.dialogsFound ?? object(active.continuation).dialogsFound, 0)
        : 0,
      watermark: clean(state?.confirmedWatermarkMessageId || state?.forwardCursor || state?.newestMessageId, 240),
      watermarkAt: dateOrNull(state?.confirmedWatermarkAt || state?.newestMessageAt)?.toISOString() || null,
      watermarkReached: false,
      overlapPages: integer(input.overlapPages, 2, 1, 10),
      knownUnchangedStreak: 0,
      knownMessageThreshold: integer(input.knownMessageThreshold, 3, 1, 100),
      maxPages: integer(input.maxPages, active.mode === "initial" ? 5000 : active.mode === "discovery" ? 10000 : 1000, 1, 10000),
    };
    const discoveryCheckpoint = active.mode === "discovery"
      ? await durableDialogDiscoveryCheckpoint(db, {
          agencyId,
          creatorId,
          run: active,
          generation: integer(input.generation, state?.generation || active.generation || 0),
        })
      : null;
    const baseResumeContinuation = active.mode === "discovery"
      ? discoveryResumeContinuation({ resumeContinuation, fallbackResumeContinuation, checkpoint: discoveryCheckpoint })
      : (Object.keys(resumeContinuation).length ? resumeContinuation : fallbackResumeContinuation);
    const scheduledResumeContinuation = durableTarget
      ? targetedContinuation(durableTarget, baseResumeContinuation, fallbackResumeContinuation.knownMessageThreshold)
      : baseResumeContinuation;
    const job = await db.jobInstance.create({
      data: {
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        scope: "creator",
        creatorId,
        agencyId,
        idempotencyKey: `${DIALOG_INTELLIGENCE_JOB_KEY}:resume:${active.id}:${Date.now()}`,
        params: {
          ...object(activeJob?.params),
          scanRunId: active.id,
          dialogId,
          fanId: clean(input.fanId, 160) || active.fanId || null,
          mode: active.mode,
          source: clean(input.source, 80) || "startup_resume",
          pageLimit: integer(input.pageLimit, 50, 1, 100),
          discoveryBatchSize: active.mode === "discovery" ? integer(input.discoveryBatchSize ?? object(activeJob?.params).discoveryBatchSize, 100, 25, 100) : undefined,
          discoveryBatchMaxApiPages: active.mode === "discovery" ? integer(input.discoveryBatchMaxApiPages ?? object(activeJob?.params).discoveryBatchMaxApiPages, 50, 1, 100) : undefined,
          discoveryExecutionTimeBudgetMs: active.mode === "discovery" ? integer(input.discoveryExecutionTimeBudgetMs ?? object(activeJob?.params).discoveryExecutionTimeBudgetMs, 2700000, 60000, 3000000) : undefined,
          overlapPages: integer(input.overlapPages, 2, 0, 10),
          knownMessageThreshold: integer(input.knownMessageThreshold, 3, 1, 100),
          maxPages: integer(input.maxPages, active.mode === "initial" ? 5000 : active.mode === "discovery" ? 10000 : 1000, 1, 10000),
          generation: integer(input.generation, state?.generation || active.generation || 0, 0, 2_000_000_000),
          forceChildFull: input.forceChildFull === true || object(activeJob?.params).forceChildFull === true,
        },
        continuation: scheduledResumeContinuation,
        status: "SCHEDULED",
        priority: requestedPriority,
        scheduledAt: now,
        nextRunAt: now,
      },
    });
    const resumedRun = await db.dialogScanRun.update({
      where: { id: active.id },
      data: { jobId: job.id, status: "QUEUED", pausedAt: null, completedAt: null, lastError: null },
    });
    await db.dialogScanState.upsert({
      where: { creatorId_dialogId: { creatorId, dialogId } },
      create: {
        agencyId,
        creatorId,
        dialogId,
        fanId: clean(input.fanId, 160),
        status: "QUEUED",
        scanMode: active.mode,
        generation: integer(input.generation, 0),
        activeRunId: active.id,
        activeJobId: job.id,
        incrementalGapOpen: active.mode === "incremental",
      },
      update: {
        fanId: clean(input.fanId, 160) || undefined,
        status: "QUEUED",
        scanMode: active.mode,
        activeRunId: active.id,
        activeJobId: job.id,
        incrementalGapOpen: active.mode === "incremental" ? true : undefined,
        lastError: null,
      },
    });
    return { ok: true, created: false, resumed: true, reason: "durable_run_resumed", run: resumedRun, job };
  }

  const run = await db.dialogScanRun.create({
    data: {
      agencyId, creatorId, dialogId, fanId: clean(input.fanId, 160), mode,
      source: clean(input.source, 80) || "manual", status: "QUEUED",
      generation: integer(input.generation, state?.generation || 0, 0, 2_000_000_000),
      createdByUserId: clean(input.userId, 160),
      progress: { stage: mode === "discovery" ? "DIALOG_DISCOVERY" : mode === "targeted" ? "TARGETED_RECONCILIATION" : "DIALOG_SCAN", pages: 0, messages: 0 },
    },
  });
  const forceFull = requestedMode === "full";
  const initialCursor = clean(input.cursor, 240)
    || (mode === "initial" && !forceFull ? clean(state?.backwardCursor, 240) : null);
  const knownMessageThreshold = integer(input.knownMessageThreshold, 3, 1, 100);
  const maxPages = integer(input.maxPages, mode === "initial" ? 5000 : mode === "discovery" ? 10000 : 1000, 1, 10000);
  const job = await db.jobInstance.create({
    data: {
      jobKey: DIALOG_INTELLIGENCE_JOB_KEY, scope: "creator", creatorId, agencyId,
      idempotencyKey: `${DIALOG_INTELLIGENCE_JOB_KEY}:${creatorId}:${dialogId}:${run.id}`,
      params: {
        scanRunId: run.id, dialogId, fanId: clean(input.fanId, 160), mode,
        source: clean(input.source, 80) || "manual", pageLimit: integer(input.pageLimit, 50, 1, 100),
        discoveryBatchSize: mode === "discovery" ? integer(input.discoveryBatchSize, 100, 25, 100) : undefined,
        discoveryBatchMaxApiPages: mode === "discovery" ? integer(input.discoveryBatchMaxApiPages, 50, 1, 100) : undefined,
        discoveryExecutionTimeBudgetMs: mode === "discovery" ? integer(input.discoveryExecutionTimeBudgetMs, 2700000, 60000, 3000000) : undefined,
        targetMessageId, childMode: clean(input.childMode, 40) || null,
        forceChildFull: input.forceChildFull === true,
        childPriority: integer(input.childPriority, clean(input.childMode, 40) === "initial" ? 60 : 50, 0, 200),
        overlapPages: integer(input.overlapPages, 2, 0, 10), knownMessageThreshold, maxPages,
        generation: integer(input.generation, state?.generation || 0, 0, 2_000_000_000),
      },
      continuation: {
        stage: mode === "discovery" ? "DIALOG_DISCOVERY" : mode === "targeted" ? "TARGETED_RECONCILIATION" : "DIALOG_SCAN",
        mode, dialogId, cursor: initialCursor, offset: 0, page: 0,
        childMode: clean(input.childMode, 40) || null,
        watermark: clean(state?.confirmedWatermarkMessageId || state?.forwardCursor || state?.newestMessageId, 240),
        watermarkAt: dateOrNull(state?.confirmedWatermarkAt || state?.newestMessageAt)?.toISOString() || null,
        watermarkReached: false,
        overlapPages: integer(input.overlapPages, 2, 1, 10),
        targetMessageId: durableTarget?.messageId || targetMessageId,
        knownUnchangedStreak: 0,
        knownMessageThreshold,
        maxPages,
      },
      status: "SCHEDULED", priority: requestedPriority, scheduledAt: now, nextRunAt: now,
    },
  });
  const linkedRun = await db.dialogScanRun.update({ where: { id: run.id }, data: { jobId: job.id } });
  await db.dialogScanState.upsert({
    where: { creatorId_dialogId: { creatorId, dialogId } },
    create: {
      agencyId,
      creatorId,
      dialogId,
      fanId: clean(input.fanId, 160),
      status: "QUEUED",
      scanMode: mode,
      generation: integer(input.generation, 0),
      activeRunId: run.id,
      activeJobId: job.id,
      incrementalGapOpen: mode === "incremental",
    },
    update: {
        fanId: clean(input.fanId, 160) || undefined,
        status: "QUEUED",
        scanMode: mode,
        generation: integer(input.generation, state?.generation || 0),
        activeRunId: run.id,
        activeJobId: job.id,
        incrementalGapOpen: mode === "incremental" ? true : undefined,
        lastError: null,
    },
  });
  return { ok: true, created: true, reason: "created", run: linkedRun, job };
}

async function nextCreatorDialogPlanGenerationTx(db, { agencyId, creatorId, requestedGeneration = null }) {
  if (requestedGeneration !== null && requestedGeneration !== undefined) {
    return integer(requestedGeneration, 0, 0, 2_000_000_000);
  }
  // Legacy builds used Unix seconds as the generation, producing values around
  // 1.7 billion. New plans deliberately ignore those legacy timestamp ids and
  // continue a compact monotonic sequence instead.
  const latest = await db.dialogScanRun.findFirst({
    where: { agencyId, creatorId, generation: { lt: 1_000_000_000 } },
    orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
    select: { generation: true },
  });
  return integer(numberOrZero(latest?.generation) + 1, 1, 1, 999_999_999);
}

function numberOrZero(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function supersedeCreatorDialogPlanTx(db, { agencyId, creatorId, reason, includeDiscovery = false }) {
  // Never materialize thousands of run/job ids into an interactive transaction.
  // Large creator plans can contain 10k+ rows; the previous `findMany -> IN (...)`
  // path regularly exceeded Prisma's 5s interactive transaction timeout before
  // the replacement discovery run could be created. Set-based updates keep the
  // restart atomic and cover every active row instead of silently truncating at 10k.
  const now = new Date();
  const jobResult = await db.jobInstance.updateMany({
    where: {
      agencyId,
      creatorId,
      jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
      status: { in: ["SCHEDULED", "CLAIMED"] },
    },
    data: {
      status: "CANCELLED",
      completedAt: now,
      lastError: null,
      result: { control: { kind: "superseded", reason, at: now.toISOString() } },
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      workId: null,
      leaseRevision: { increment: 1 },
    },
  });
  const runResult = await db.dialogScanRun.updateMany({
    where: {
      agencyId,
      creatorId,
      ...(includeDiscovery ? {} : { dialogId: { not: "__dialog_discovery__" } }),
      mode: { in: includeDiscovery ? ["discovery", "initial", "incremental"] : ["initial", "incremental"] },
      status: { in: ACTIVE_RUN_STATUSES },
    },
    data: { status: "CANCELLED", canceledAt: now, completedAt: now, pausedAt: null, lastError: null },
  });
  const stateResult = await db.dialogScanState.updateMany({
    where: {
      agencyId,
      creatorId,
      OR: [
        { status: { in: ACTIVE_RUN_STATUSES } },
        { activeRunId: { not: null } },
        { activeJobId: { not: null } },
      ],
    },
    data: { status: "IDLE", activeRunId: null, activeJobId: null, lastError: null },
  });
  return {
    cancelled: runResult.count,
    cancelledJobs: jobResult.count,
    resetStates: stateResult.count,
  };
}

async function restartCreatorDialogPlanTx(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  if (!agencyId || !creatorId) throw new Error("agencyId and creatorId are required");

  await assertCreator(db, agencyId, creatorId);
  const control = await moduleControl(db, agencyId);
  if (!control.enabled) {
    return { ok: true, created: false, reason: "module_disabled", supersededHistoryRuns: 0 };
  }

  const forceChildFull = input.forceChildFull === true;
  const activeDiscovery = await db.dialogScanRun.findFirst({
    where: {
      agencyId,
      creatorId,
      dialogId: "__dialog_discovery__",
      status: { in: ACTIVE_RUN_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });
  const activeDiscoveryJob = activeDiscovery?.jobId
    ? await db.jobInstance.findUnique({ where: { id: activeDiscovery.jobId } })
    : null;
  const liveFullRescan = forceChildFull
    && activeDiscovery
    && ["QUEUED", "RUNNING"].includes(clean(activeDiscovery.status, 40).toUpperCase())
    && activeDiscoveryJob
    && ["SCHEDULED", "CLAIMED"].includes(clean(activeDiscoveryJob.status, 40).toUpperCase());

  // Full rescan is destructive because it supersedes the current creator plan.
  // A duplicated UI/RPC request, a second Desktop, or a retried POST must never
  // cancel a healthy scan that has already progressed for hours. Operators can
  // still intentionally restart it by pressing Cancel all first; once the live
  // discovery is terminal, a new full generation is created normally.
  if (liveFullRescan) {
    return {
      ok: true,
      created: false,
      reason: "full_rescan_already_active",
      run: activeDiscovery,
      job: activeDiscoveryJob,
      generation: activeDiscovery.generation,
      supersededHistoryRuns: 0,
    };
  }

  const generation = input.generation !== null && input.generation !== undefined
    ? integer(input.generation, 0, 0, 2_000_000_000)
    : (!forceChildFull && activeDiscovery
      ? integer(activeDiscovery.generation, 0, 0, 2_000_000_000)
      : await nextCreatorDialogPlanGenerationTx(db, { agencyId, creatorId }));

  const superseded = forceChildFull
    ? await supersedeCreatorDialogPlanTx(db, {
        agencyId,
        creatorId,
        reason: "superseded by an explicit full dialog rescan",
        includeDiscovery: true,
      })
    : activeDiscovery
      ? { cancelled: 0 }
      : await supersedeCreatorDialogPlanTx(db, {
          agencyId,
          creatorId,
          reason: "superseded by a new complete dialog discovery plan",
          includeDiscovery: false,
        });

  const result = await scheduleDialogScanTx(db, {
    ...input,
    agencyId,
    creatorId,
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    generation,
  });
  return { ...result, generation, supersededHistoryRuns: superseded.cancelled };
}

async function restartCreatorDialogPlan(input) {
  try {
    return await prisma.$transaction((tx) => restartCreatorDialogPlanTx(tx, input), DIALOG_CONTROL_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const active = await prisma.dialogScanRun.findFirst({
      where: {
        agencyId: input.agencyId,
        creatorId: input.creatorId,
        dialogId: "__dialog_discovery__",
        status: { in: ACTIVE_RUN_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!active) throw error;
    const job = active.jobId ? await prisma.jobInstance.findUnique({ where: { id: active.jobId } }) : null;
    return {
      ok: true,
      created: false,
      reason: "concurrent_creator_plan_won",
      run: active,
      job,
      generation: active.generation,
      supersededHistoryRuns: 0,
    };
  }
}

async function scheduleDialogScan(input) {
  try {
    return await prisma.$transaction((tx) => scheduleDialogScanTx(tx, input));
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const active = await prisma.dialogScanRun.findFirst({
      where: {
        agencyId: input.agencyId,
        creatorId: input.creatorId,
        dialogId: input.dialogId,
        status: { in: ACTIVE_RUN_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!active) throw error;
    const job = active.jobId ? await prisma.jobInstance.findUnique({ where: { id: active.jobId } }) : null;
    return { ok: true, created: false, reason: "concurrent_scan_won", run: active, job };
  }
}

async function repairRegressedDialogDiscoveryTx(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  if (!agencyId || !creatorId) return { ok: true, repaired: false, reason: "missing_scope" };

  const run = await db.dialogScanRun.findFirst({
    where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
    orderBy: { createdAt: "desc" },
  });
  if (!run?.jobId) return { ok: true, repaired: false, reason: "no_discovery_run" };
  const job = await db.jobInstance.findUnique({ where: { id: run.jobId } });
  if (!job || !["SCHEDULED", "CLAIMED"].includes(clean(job.status, 40).toUpperCase())) {
    return { ok: true, repaired: false, reason: "discovery_not_active" };
  }

  const params = object(job.params);
  const generation = integer(params.generation ?? run.generation, run.generation || 0);
  const jobContinuation = jobContinuationValue(job.continuation);
  const jobProgress = object(job.progress);
  const runContinuation = object(run.continuation);
  const runProgress = object(run.progress);
  const currentOffset = nonNegativeIntegerOrNull(jobContinuation.offset)
    ?? nonNegativeIntegerOrNull(jobProgress.nextOffset)
    ?? nonNegativeIntegerOrNull(jobProgress.offset)
    ?? 0;
  const hintedDialogsFound = Math.max(
    integer(jobContinuation.dialogsFound, 0),
    integer(jobProgress.dialogsFound ?? jobProgress.dialogs, 0),
    integer(runContinuation.dialogsFound, 0),
    integer(runProgress.dialogsFound ?? runProgress.dialogs, 0),
  );
  // In a valid offset-based traversal the absolute API offset cannot be lower
  // than the number of unique dialogs already accumulated. Avoid reading the
  // chunk ledger on every status poll unless this monotonicity invariant is
  // actually broken (or a non-empty run somehow returned to offset zero).
  const suspiciousRegression = currentOffset < hintedDialogsFound
    || (currentOffset === 0 && integer(run.pagesProcessed, 0) > 0);
  if (!suspiciousRegression) {
    return { ok: true, repaired: false, reason: "checkpoint_not_suspicious", currentOffset, dialogsFound: hintedDialogsFound };
  }

  const checkpoint = await durableDialogDiscoveryCheckpoint(db, { agencyId, creatorId, run, generation });
  if (!checkpoint || checkpoint.offset <= 0) return { ok: true, repaired: false, reason: "no_durable_checkpoint" };
  if (currentOffset >= checkpoint.offset) {
    return { ok: true, repaired: false, reason: "checkpoint_not_regressed", currentOffset, checkpointOffset: checkpoint.offset };
  }

  const fallback = {
    stage: "DIALOG_DISCOVERY",
    mode: "discovery",
    dialogId: "__dialog_discovery__",
    offset: checkpoint.offset,
    page: checkpoint.page,
    childMode: clean(params.childMode, 40) || clean(runContinuation.childMode, 40) || "initial",
    dialogsFound: checkpoint.dialogsFound,
    maxPages: integer(params.maxPages ?? runContinuation.maxPages, 5000, 1, 10000),
  };
  const repairedContinuation = discoveryResumeContinuation({
    resumeContinuation: { ...runContinuation, ...jobContinuation },
    fallbackResumeContinuation: fallback,
    checkpoint,
  });
  const repairedProgress = {
    ...object(run.progress),
    ...jobProgress,
    stage: "DIALOG_DISCOVERY",
    mode: "discovery",
    pages: checkpoint.page,
    current: checkpoint.page,
    total: Math.max(checkpoint.page, 1),
    dialogs: checkpoint.dialogsFound,
    dialogsFound: checkpoint.dialogsFound,
    dialogsOnPage: 0,
    offset: checkpoint.offset,
    nextOffset: checkpoint.offset,
    hasMore: true,
    message: `Dialog checkpoint restored · page ${checkpoint.page} · offset ${checkpoint.offset}`,
    checkpointRecovered: true,
    checkpointRegressedFrom: currentOffset,
  };
  const now = new Date();
  await db.jobInstance.update({
    where: { id: job.id },
    data: {
      status: "SCHEDULED",
      nextRunAt: now,
      claimedAt: null,
      claimedByDeviceId: null,
      leaseUntil: null,
      leaseTokenHash: null,
      leaseRevision: { increment: 1 },
      workId: null,
      continuation: repairedContinuation,
      progress: repairedProgress,
      lastProgressAt: now,
      completedAt: null,
      lastError: null,
    },
  });
  await db.dialogScanRun.update({
    where: { id: run.id },
    data: {
      status: "QUEUED",
      continuation: repairedContinuation,
      progress: repairedProgress,
      pagesProcessed: checkpoint.page,
      completedAt: null,
      lastError: null,
    },
  });
  await db.dialogScanState.updateMany({
    where: { creatorId, dialogId: "__dialog_discovery__" },
    data: {
      status: "QUEUED",
      activeRunId: run.id,
      activeJobId: job.id,
      lastError: null,
    },
  });
  return {
    ok: true,
    repaired: true,
    reason: "discovery_checkpoint_regression_repaired",
    runId: run.id,
    jobId: job.id,
    fromOffset: currentOffset,
    toOffset: checkpoint.offset,
    page: checkpoint.page,
    dialogsFound: checkpoint.dialogsFound,
  };
}

async function autoRecoverDialogDiscoveryTx(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  if (!agencyId || !creatorId) return { ok: true, recovered: false, reason: "missing_scope" };

  const latestRun = await db.dialogScanRun.findFirst({
    where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
    orderBy: { createdAt: "desc" },
  });
  if (!latestRun || clean(latestRun.status, 40).toUpperCase() !== "FAILED" || !latestRun.jobId) {
    return { ok: true, recovered: false, reason: "no_failed_discovery" };
  }

  const failedJob = await db.jobInstance.findUnique({ where: { id: latestRun.jobId } });
  const failure = object(object(failedJob?.result).failure);
  const code = clean(failure.code, 160);
  if (!RECOVERABLE_DISCOVERY_FAILURE_CODES.has(code)) {
    return { ok: true, recovered: false, reason: "failure_not_auto_recoverable" };
  }

  const params = object(failedJob?.params);
  const resumed = await scheduleDialogScanTx(db, {
    agencyId,
    creatorId,
    dialogId: "__dialog_discovery__",
    mode: "discovery",
    childMode: clean(params.childMode, 40) || "initial",
    source: clean(input.source, 80) || "automatic_dialog_discovery_recovery",
    priority: integer(input.priority, 90, 0, 200),
    pageLimit: integer(params.pageLimit, 50, 1, 100),
    maxPages: integer(params.maxPages, 5000, 1, 10000),
    generation: integer(params.generation, latestRun.generation || 0, 0, 2_000_000_000),
  });
  return { ok: true, recovered: true, reason: resumed.reason || "resumed", runId: resumed.run?.id || latestRun.id, jobId: resumed.job?.id || null };
}

async function autoRecoverDialogDiscovery(input) {
  return prisma.$transaction((tx) => autoRecoverDialogDiscoveryTx(tx, input));
}

function normalizedMessage(input, job) {
  const raw = object(input);
  const messageId = clean(raw.messageId ?? raw.id, 240);
  const dialogId = clean(raw.dialogId ?? job.params?.dialogId, 180);
  const createdAtOf = dateOrNull(raw.createdAtOf ?? raw.createdAt);
  if (!messageId || !dialogId || !createdAtOf) return null;
  const direction = clean(raw.direction, 40) || (raw.isFromCreator === true ? "OUTBOUND" : "INBOUND");
  const isFromCreator = raw.isFromCreator === true || direction === "OUTBOUND";
  return {
    messageId,
    dialogId,
    fanId: clean(raw.fanId ?? job.params?.fanId, 160),
    senderId: clean(raw.senderId, 160),
    recipientId: clean(raw.recipientId, 160),
    direction,
    messageType: clean(raw.messageType, 80) || "message",
    text: clean(raw.text, 20_000),
    priceCents: integer(raw.priceCents, 0),
    currency: (clean(raw.currency, 12) || "USD").toUpperCase(),
    isFree: raw.isFree === true || integer(raw.priceCents, 0) <= 0,
    isOpened: raw.isOpened === true,
    isFromCreator,
    isFromFan: raw.isFromFan === true || !isFromCreator,
    createdAtOf,
    changedAtOf: dateOrNull(raw.changedAtOf ?? raw.changedAt),
    deletedAt: dateOrNull(raw.deletedAt),
    source: clean(raw.source, 80) || "dialog_scan",
    contentHash: clean(raw.contentHash, 128),
    metadata: object(raw.metadata),
    media: list(raw.media).map((entry) => {
      const media = object(entry);
      const mediaId = clean(media.mediaId ?? media.id, 240);
      if (!mediaId) return null;
      const ownership = clean(media.ownership, 40) || (media.isFanMedia === true ? "FAN" : "CREATOR");
      return {
        mediaId,
        assetId: clean(media.assetId, 240) || (ownership === "CREATOR" ? mediaId : null),
        mediaType: clean(media.mediaType ?? media.type, 80),
        ownerId: clean(media.ownerId, 160),
        ownership,
        isFanMedia: media.isFanMedia === true || ownership === "FAN",
        preview: object(media.preview),
        durationMs: media.durationMs == null ? null : integer(media.durationMs, 0, 0, 86_400_000),
        canView: typeof media.canView === "boolean" ? media.canView : null,
      };
    }).filter(Boolean),
  };
}

async function upsertMessage(db, { agencyId, creatorId, job, raw, observedAt }) {
  const message = normalizedMessage(raw, job);
  if (!message) return null;
  const existing = await db.dialogMessageLedger.findUnique({
    where: messageUnique(creatorId, message.messageId),
    select: { contentHash: true, changedAtOf: true, deletedAt: true },
  });
  const businessChanged = !existing
    || existing.contentHash !== message.contentHash
    || String(existing.deletedAt || "") !== String(message.deletedAt || "");
  const effectiveChangedAt = message.changedAtOf || (businessChanged ? observedAt : existing?.changedAtOf || null);
  const ledger = await db.dialogMessageLedger.upsert({
    where: messageUnique(creatorId, message.messageId),
    create: {
      agencyId, creatorId, dialogId: message.dialogId, messageId: message.messageId, fanId: message.fanId,
      senderId: message.senderId, recipientId: message.recipientId, direction: message.direction,
      messageType: message.messageType, text: message.text, priceCents: message.priceCents, currency: message.currency,
      isFree: message.isFree, isOpened: message.isOpened, isFromCreator: message.isFromCreator, isFromFan: message.isFromFan,
      createdAtOf: message.createdAtOf, changedAtOf: effectiveChangedAt, deletedAt: message.deletedAt,
      source: message.source, firstSeenAt: observedAt, lastSeenAt: observedAt, contentHash: message.contentHash, metadata: message.metadata,
    },
    update: {
      dialogId: message.dialogId, fanId: message.fanId || undefined, senderId: message.senderId, recipientId: message.recipientId,
      direction: message.direction, messageType: message.messageType, text: message.text, priceCents: message.priceCents,
      currency: message.currency, isFree: message.isFree, isOpened: message.isOpened,
      isFromCreator: message.isFromCreator, isFromFan: message.isFromFan, changedAtOf: effectiveChangedAt,
      deletedAt: message.deletedAt, source: message.source, lastSeenAt: observedAt,
      contentHash: message.contentHash, metadata: message.metadata,
    },
  });
  for (const media of message.media) {
    await db.dialogMessageMedia.upsert({
      where: { messageLedgerId_mediaId: { messageLedgerId: ledger.id, mediaId: media.mediaId } },
      create: {
        agencyId, creatorId, messageLedgerId: ledger.id, messageId: message.messageId,
        mediaId: media.mediaId, assetId: media.assetId, mediaType: media.mediaType, ownerId: media.ownerId,
        ownership: media.ownership, isFanMedia: media.isFanMedia, preview: media.preview,
        durationMs: media.durationMs, canView: media.canView, firstSeenAt: observedAt, lastSeenAt: observedAt,
      },
      update: {
        assetId: media.assetId, mediaType: media.mediaType, ownerId: media.ownerId, ownership: media.ownership,
        isFanMedia: media.isFanMedia, preview: media.preview, durationMs: media.durationMs,
        canView: media.canView, lastSeenAt: observedAt,
      },
    });
  }
  return { ledger, message, mediaCount: message.media.length, isNew: !existing, businessChanged };
}

async function rebuildAssetAggregate(db, agencyId, creatorId, assetId) {
  if (!assetId) return null;
  const relations = await db.vaultPurchaseMedia.findMany({
    where: { agencyId, creatorId, assetId, isFanMedia: false },
    include: { purchase: true },
    take: 100_000,
  });
  let soldCount = 0;
  let totalRevenueCents = 0;
  let openedCount = 0;
  let notOpenedCount = 0;
  let freeCount = 0;
  let lastSoldAt = null;
  const buyers = new Set();
  for (const relation of relations) {
    const purchase = relation.purchase;
    if (purchase.isFree || purchase.priceCents <= 0 || purchase.status === "FREE") freeCount += 1;
    else if (purchase.isOpened) openedCount += 1;
    else notOpenedCount += 1;
    if (purchaseCountsAsRevenue(purchase)) {
      soldCount += 1;
      totalRevenueCents += integer(relation.allocatedCents, 0);
      if (purchase.buyerId) buyers.add(purchase.buyerId);
      if (!lastSoldAt || purchase.purchasedAt > lastSoldAt) lastSoldAt = purchase.purchasedAt;
    }
  }
  const media = await db.dialogMessageMedia.findFirst({
    where: { agencyId, creatorId, assetId, isFanMedia: false },
    orderBy: { lastSeenAt: "desc" },
  });
  return db.vaultAssetSalesAggregate.upsert({
    where: { creatorId_assetId: { creatorId, assetId } },
    create: {
      agencyId, creatorId, assetId, mediaId: media?.mediaId || null, mediaType: media?.mediaType || null,
      preview: object(media?.preview), soldCount, totalRevenueCents, uniqueBuyers: buyers.size,
      averagePriceCents: soldCount > 0 ? Math.round(totalRevenueCents / soldCount) : 0,
      openedCount, notOpenedCount, freeCount, lastSoldAt,
    },
    update: {
      mediaId: media?.mediaId || undefined, mediaType: media?.mediaType || undefined, preview: object(media?.preview),
      soldCount, totalRevenueCents, uniqueBuyers: buyers.size,
      averagePriceCents: soldCount > 0 ? Math.round(totalRevenueCents / soldCount) : 0,
      openedCount, notOpenedCount, freeCount, lastSoldAt,
    },
  });
}

async function projectSignal(db, signal) {
  const message = signal.sourceMessageId
    ? await db.dialogMessageLedger.findUnique({ where: messageUnique(signal.creatorId, signal.sourceMessageId), include: { media: true } })
    : null;
  const media = message?.media || [];
  const creatorMedia = media.filter((item) => !item.isFanMedia);
  const fanMedia = media.filter((item) => item.isFanMedia);
  const status = classifyPurchase({
    messageResolved: Boolean(message), deletedMessage: signal.resolveState === "DELETED_MESSAGE" || Boolean(message?.deletedAt), mediaResolved: media.length > 0,
    hasCreatorMedia: creatorMedia.length > 0, hasFanMedia: fanMedia.length > 0,
    priceCents: signal.amountCents > 0 ? signal.amountCents : message?.priceCents,
    isFree: message?.isFree === true, isOpened: message?.isOpened === true, deletedUser: signal.buyerDeleted === true,
  });
  const priceCents = integer(signal.amountCents > 0 ? signal.amountCents : message?.priceCents, 0);
  const resolveState = status.startsWith("UNRESOLVED") ? status : "RESOLVED";
  const idempotencyKey = purchaseIdempotencyKey(signal);
  const purchase = await db.vaultPurchaseLedger.upsert({
    where: { idempotencyKey },
    create: {
      agencyId: signal.agencyId, creatorId: signal.creatorId, messageLedgerId: message?.id || null,
      idempotencyKey, sourceEventId: signal.sourceEventId, sourceMessageId: signal.sourceMessageId,
      dialogId: signal.dialogId || message?.dialogId || null, buyerId: signal.buyerId,
      buyerUsername: signal.buyerUsername, buyerDisplayName: signal.buyerDisplayName,
      purchasedAt: signal.occurredAt, priceCents, currency: signal.currency,
      isOpened: message?.isOpened === true, isFree: message?.isFree === true || priceCents <= 0,
      status, resolveState, buyerDeleted: signal.buyerDeleted === true, sourceDeleted: Boolean(message?.deletedAt),
      resolvedAt: resolveState === "RESOLVED" ? new Date() : null,
      metadata: { signalId: signal.id },
    },
    update: {
      messageLedgerId: message?.id || undefined, sourceMessageId: signal.sourceMessageId || undefined,
      dialogId: signal.dialogId || message?.dialogId || undefined, buyerId: signal.buyerId || undefined,
      buyerUsername: signal.buyerUsername || undefined, buyerDisplayName: signal.buyerDisplayName || undefined,
      purchasedAt: signal.occurredAt, priceCents, currency: signal.currency,
      isOpened: message?.isOpened === true, isFree: message?.isFree === true || priceCents <= 0,
      status, resolveState, buyerDeleted: signal.buyerDeleted === true, sourceDeleted: Boolean(message?.deletedAt),
      lastSeenAt: new Date(), resolvedAt: resolveState === "RESOLVED" ? new Date() : undefined,
    },
  });

  const allocations = allocatePackagePrice(priceCents, media);
  const affectedAssets = new Set();
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    const allocatedCents = allocations[index] || 0;
    const assetId = item.assetId || (!item.isFanMedia ? item.mediaId : null);
    await db.vaultPurchaseMedia.upsert({
      where: { purchaseId_mediaId: { purchaseId: purchase.id, mediaId: item.mediaId } },
      create: {
        agencyId: signal.agencyId, creatorId: signal.creatorId, purchaseId: purchase.id,
        mediaId: item.mediaId, assetId, mediaType: item.mediaType, isFanMedia: item.isFanMedia,
        resolutionStatus: item.isFanMedia ? "EXCLUDED_FAN_MEDIA" : (assetId ? "RESOLVED" : "UNRESOLVED_MEDIA"),
        allocatedCents,
      },
      update: {
        assetId, mediaType: item.mediaType, isFanMedia: item.isFanMedia,
        resolutionStatus: item.isFanMedia ? "EXCLUDED_FAN_MEDIA" : (assetId ? "RESOLVED" : "UNRESOLVED_MEDIA"),
        allocatedCents,
      },
    });
    if (assetId && !item.isFanMedia) affectedAssets.add(assetId);
  }
  await db.dialogPurchaseSignal.update({
    where: { id: signal.id },
    data: { resolveState, resolvedAt: resolveState === "RESOLVED" ? new Date() : null, lastSeenAt: new Date() },
  });
  for (const assetId of affectedAssets) await rebuildAssetAggregate(db, signal.agencyId, signal.creatorId, assetId);
  return { purchase, status, affectedAssets: [...affectedAssets] };
}


async function scheduleNextPlannedDialogTx(db, input) {
  const agencyId = clean(input.agencyId, 160);
  const creatorId = clean(input.creatorId, 160);
  const generation = integer(input.generation, 0);
  const childMode = clean(input.childMode, 40) || "initial";
  if (!agencyId || !creatorId) return { created: false, reason: "missing_scope" };

  // A creator plan is deliberately sequential: there may be only one live
  // history run for the current generation. Old builds could leave a run in
  // QUEUED/RUNNING after its JobInstance was already cancelled or deleted.
  // Such an orphan must not block the whole plan forever.
  for (let guard = 0; guard < 100; guard += 1) {
    const active = await db.dialogScanRun.findFirst({
      where: {
        agencyId,
        creatorId,
        dialogId: { not: "__dialog_discovery__" },
        generation,
        status: { in: ACTIVE_RUN_STATUSES },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!active) break;
    if (active.status === "PAUSED") {
      return { created: false, reason: "history_plan_paused", run: active };
    }
    const activeJob = active.jobId
      ? await db.jobInstance.findUnique({ where: { id: active.jobId } })
      : null;
    if (activeJob && ["SCHEDULED", "CLAIMED"].includes(activeJob.status)) {
      return { created: false, reason: "history_job_active", run: active, job: activeJob };
    }

    const orphanReason = "orphaned history run recovered: active run has no live job";
    await db.dialogScanRun.update({
      where: { id: active.id },
      data: { status: "FAILED", completedAt: new Date(), lastError: orphanReason },
    });
    await db.dialogScanState.updateMany({
      where: { creatorId, dialogId: active.dialogId },
      data: {
        status: "FAILED",
        activeRunId: null,
        activeJobId: null,
        lastError: orphanReason,
      },
    });
  }

  const planned = await db.dialogScanState.findFirst({
    where: {
      agencyId,
      creatorId,
      dialogId: { not: "__dialog_discovery__" },
      generation,
      status: "PLANNED",
      ...(childMode === "initial" ? { initialScanComplete: false } : {}),
    },
    // updatedAt is refreshed while discovery walks the list page-by-page, so
    // this preserves the frozen discovery order much better than the row's
    // original creation date (which may be months old).
    orderBy: [{ updatedAt: "asc" }, { dialogId: "asc" }],
  });
  if (!planned) return { created: false, reason: "history_plan_drained" };

  return scheduleDialogScanTx(db, {
    agencyId,
    creatorId,
    dialogId: planned.dialogId,
    fanId: planned.fanId,
    mode: childMode === "initial" && planned.initialScanComplete ? "incremental" : childMode,
    source: clean(input.source, 80) || "dialog_discovery_plan",
    priority: integer(input.priority, childMode === "initial" ? 60 : 50, 0, 200),
    generation,
    overlapPages: integer(input.overlapPages, 2, 0, 10),
    knownMessageThreshold: integer(input.knownMessageThreshold, 3, 1, 100),
    maxPages: integer(input.maxPages, childMode === "initial" ? 5000 : 1000, 1, 10000),
  });
}

async function applyDialogDiscoveryChunk({ db, job, deviceId, chunkResult }) {
  const chunk = object(chunkResult);
  const params = object(job.params);
  const runId = clean(chunk.runId ?? params.scanRunId, 160);
  const chunkKey = clean(chunk.chunkKey, 320);
  const discoveryDialogId = clean(params.dialogId, 180) || "__dialog_discovery__";
  if (!job.agencyId || !job.creatorId || !runId || !chunkKey) throw new Error("Dialog discovery chunk scope is incomplete");
  const existing = await db.dialogScanChunkCommit.findUnique({ where: { runId_chunkKey: { runId, chunkKey } } });
  if (existing) return { duplicate: true, chunkId: existing.id, ...object(existing.result) };
  const run = await db.dialogScanRun.findFirst({ where: { id: runId, creatorId: job.creatorId, agencyId: job.agencyId } });
  if (!run) throw new Error("Dialog discovery run not found");
  const childMode = clean(chunk.childMode ?? params.childMode, 40) || "incremental";
  const forceChildFull = chunk.forceChildFull === true || params.forceChildFull === true;
  const generation = integer(params.generation ?? run.generation, run.generation || 0);
  // Desktop queues compact discovery results in asynchronous batches of up to
  // 100 dialogs while its OnlyFans pagination continues without waiting for us.
  // Keep the legacy per-row path only for test doubles / old Prisma adapters;
  // real PostgreSQL uses one findMany + createMany + at most two updateMany calls.
  //
  // FUTURE SERVER MIGRATION FOUNDATION: this function deliberately accepts a
  // transport-neutral discovery plan. Raw conversations remain local-only today;
  // a future server scanner/storage tier can be attached behind this boundary.
  const uniqueDialogs = new Map();
  for (const raw of list(chunk.dialogs).slice(0, 500)) {
    const row = object(raw);
    const dialogId = clean(row.dialogId, 180);
    if (!dialogId || dialogId === discoveryDialogId) continue;
    uniqueDialogs.set(dialogId, { dialogId, fanId: clean(row.fanId, 160) });
  }
  const discoveryRows = [...uniqueDialogs.values()];
  const discovered = discoveryRows.length;
  let planned = 0;
  const supportsBulkPlan = typeof db.dialogScanState.findMany === "function"
    && typeof db.dialogScanState.createMany === "function"
    && typeof db.dialogScanState.updateMany === "function";

  if (supportsBulkPlan && discoveryRows.length > 0) {
    const dialogIds = discoveryRows.map((row) => row.dialogId);
    const existingRows = await db.dialogScanState.findMany({
      where: { creatorId: job.creatorId, dialogId: { in: dialogIds } },
      select: { dialogId: true, initialScanComplete: true },
    });
    const existingById = new Map(existingRows.map((row) => [row.dialogId, row]));
    const createRows = [];
    const plannedExistingIds = [];
    const readyExistingIds = [];

    for (const row of discoveryRows) {
      const existingState = existingById.get(row.dialogId);
      const alreadyInitial = existingState?.initialScanComplete === true;
      const shouldPlan = childMode === "initial" ? (forceChildFull || !alreadyInitial) : true;
      if (shouldPlan) planned += 1;
      if (!existingState) {
        createRows.push({
          agencyId: job.agencyId,
          creatorId: job.creatorId,
          dialogId: row.dialogId,
          fanId: row.fanId,
          status: shouldPlan ? "PLANNED" : "READY",
          scanMode: childMode,
          generation,
          initialScanComplete: false,
          pagesProcessed: 0,
          messagesProcessed: 0,
          mediaProcessed: 0,
          incrementalGapOpen: childMode === "incremental",
        });
      } else if (shouldPlan) {
        plannedExistingIds.push(row.dialogId);
      } else {
        readyExistingIds.push(row.dialogId);
      }
    }

    if (createRows.length > 0) {
      await db.dialogScanState.createMany({ data: createRows, skipDuplicates: true });
    }
    const commonUpdate = {
      scanMode: childMode,
      generation,
      pagesProcessed: 0,
      messagesProcessed: 0,
      mediaProcessed: 0,
      incrementalGapOpen: childMode === "incremental",
      activeRunId: null,
      activeJobId: null,
      lastError: null,
    };
    if (plannedExistingIds.length > 0) {
      await db.dialogScanState.updateMany({
        where: { creatorId: job.creatorId, dialogId: { in: plannedExistingIds } },
        data: {
          ...commonUpdate,
          status: "PLANNED",
          initialScanComplete: forceChildFull ? false : undefined,
          backwardCursor: forceChildFull ? null : undefined,
        },
      });
    }
    if (readyExistingIds.length > 0) {
      await db.dialogScanState.updateMany({
        where: { creatorId: job.creatorId, dialogId: { in: readyExistingIds } },
        data: { ...commonUpdate, status: "READY" },
      });
    }
  } else {
    for (const row of discoveryRows) {
      const existingState = await db.dialogScanState.findUnique({
        where: { creatorId_dialogId: { creatorId: job.creatorId, dialogId: row.dialogId } },
      });
      const alreadyInitial = existingState?.initialScanComplete === true;
      const shouldPlan = childMode === "initial" ? (forceChildFull || !alreadyInitial) : true;
      await db.dialogScanState.upsert({
        where: { creatorId_dialogId: { creatorId: job.creatorId, dialogId: row.dialogId } },
        create: {
          agencyId: job.agencyId, creatorId: job.creatorId, dialogId: row.dialogId, fanId: row.fanId,
          status: shouldPlan ? "PLANNED" : "READY", scanMode: childMode, generation,
          initialScanComplete: forceChildFull ? false : alreadyInitial, pagesProcessed: 0, messagesProcessed: 0, mediaProcessed: 0,
        },
        update: {
          fanId: row.fanId || undefined, scanMode: childMode, generation, status: shouldPlan ? "PLANNED" : "READY",
          initialScanComplete: forceChildFull ? false : undefined, pagesProcessed: 0, messagesProcessed: 0, mediaProcessed: 0,
          backwardCursor: forceChildFull ? null : undefined, incrementalGapOpen: childMode === "incremental",
          activeRunId: null, activeJobId: null, lastError: null,
        },
      });
      if (shouldPlan) planned += 1;
    }
  }
  const pageStart = integer(chunk.pageStart ?? chunk.page, 0);
  const pageEnd = integer(chunk.pageEnd, pageStart);
  const pagesInBatch = integer(chunk.pagesInBatch, Math.max(0, pageEnd - pageStart), 0, 500);
  const page = pageEnd;
  const hasMore = chunk.hasMore === true;
  const cursorOut = clean(chunk.cursorOut, 240);
  const result = { discovered, planned, scheduled: 0, hasMore, page, pageStart, pageEnd, pagesInBatch, cursorOut, childMode, forceChildFull, generation };
  const commit = await db.dialogScanChunkCommit.create({
    data: {
      agencyId: job.agencyId, creatorId: job.creatorId, runId, jobId: job.id, dialogId: discoveryDialogId,
      chunkKey, mode: "discovery", cursorIn: clean(chunk.cursorIn, 240), cursorOut, page,
      messageCount: 0, mediaCount: 0, hasMore, result,
    },
  });
  await db.dialogScanRun.update({
    where: { id: runId },
    data: {
      status: "RUNNING", startedAt: run.startedAt || new Date(), lastWorkerDeviceId: clean(deviceId, 200),
      pagesProcessed: { increment: pagesInBatch }, continuation: object(chunk.continuation), progress: object(chunk.progress),
      purchaseSignals: { increment: discovered }, lastError: null,
    },
  });
  return { duplicate: false, chunkId: commit.id, ...result };
}

async function applyDialogIntelligenceChunk({ db, job, deviceId, chunkResult }) {
  const chunk = object(chunkResult);
  if (chunk.kind === "dialog_discovery_page") return applyDialogDiscoveryChunk({ db, job, deviceId, chunkResult });
  if (chunk.kind !== "dialog_message_page") throw new Error("Unsupported dialog intelligence chunk");
  const params = object(job.params);
  const runId = clean(chunk.runId ?? params.scanRunId, 160);
  const dialogId = clean(chunk.dialogId ?? params.dialogId, 180);
  const chunkKey = clean(chunk.chunkKey, 320);
  if (!job.agencyId || !job.creatorId || !runId || !dialogId || !chunkKey) throw new Error("Dialog chunk scope is incomplete");

  const existing = await db.dialogScanChunkCommit.findUnique({ where: { runId_chunkKey: { runId, chunkKey } } });
  if (existing) {
    // Lost responses remain replayable, but the saved result contains only
    // compact local-commit metadata. Raw conversations never enter PostgreSQL.
    return { duplicate: true, replayedCommit: true, chunkId: existing.id, ...object(existing.result) };
  }

  const run = await db.dialogScanRun.findFirst({ where: { id: runId, creatorId: job.creatorId, agencyId: job.agencyId } });
  if (!run) throw new Error("Dialog scan run not found");
  const observedAt = new Date();

  // Desktop commits the complete OF page to dialog-messages.sqlite before it
  // reports progress. The backend receives only counts, IDs and observations
  // required for leases, continuation and deterministic incremental stopping.
  const messageIds = [...new Set(list(chunk.messageIds).map((value) => clean(value, 240)).filter(Boolean))].slice(0, 500);
  const changedMessageIds = [...new Set(list(chunk.changedMessageIds).map((value) => clean(value, 240)).filter(Boolean))].slice(0, 500);
  const observations = list(chunk.observations).slice(0, 500).map((value) => {
    const item = object(value);
    const createdAt = dateOrNull(item.createdAtOf);
    return {
      known: item.known === true,
      changed: item.changed === true,
      messageId: clean(item.messageId, 240),
      createdAtOf: createdAt ? createdAt.toISOString() : null,
    };
  }).filter((item) => item.messageId);
  const messageCount = integer(chunk.messageCount, messageIds.length, 0, 500);
  const mediaCount = integer(chunk.mediaCount, 0, 0, 100_000);
  const inserted = integer(chunk.inserted, 0, 0, 500);
  const updated = integer(chunk.updated, 0, 0, 500);
  const unchanged = integer(chunk.unchanged, Math.max(0, messageCount - inserted - updated), 0, 500);

  let newest = null;
  let oldest = null;
  for (const item of observations) {
    const createdAtOf = dateOrNull(item.createdAtOf);
    if (!createdAtOf) continue;
    const candidate = { messageId: item.messageId, createdAtOf };
    if (!newest || createdAtOf > newest.createdAtOf) newest = candidate;
    if (!oldest || createdAtOf < oldest.createdAtOf) oldest = candidate;
  }
  const declaredNewestId = clean(chunk.newestMessageId, 240);
  const declaredOldestId = clean(chunk.oldestMessageId, 240);
  if (declaredNewestId) {
    const observation = observations.find((item) => item.messageId === declaredNewestId);
    newest = { messageId: declaredNewestId, createdAtOf: dateOrNull(observation?.createdAtOf) || newest?.createdAtOf || observedAt };
  }
  if (declaredOldestId) {
    const observation = observations.find((item) => item.messageId === declaredOldestId);
    oldest = { messageId: declaredOldestId, createdAtOf: dateOrNull(observation?.createdAtOf) || oldest?.createdAtOf || observedAt };
  }

  const targetMessageId = clean(chunk.targetMessageId, 240);

  const mode = clean(chunk.mode ?? run.mode, 40) || "initial";
  const currentContinuation = jobContinuationValue(job.continuation);
  const submittedContinuation = { ...object(chunk.continuation) };
  const isTargeted = mode === "targeted" || mode === "reconcile";
  const page = integer(chunk.page, 0);
  const cursorOut = clean(chunk.cursorOut, 240);

  if (!submittedContinuation.scanNewestMessageId && newest?.messageId) {
    submittedContinuation.scanNewestMessageId = newest.messageId;
    submittedContinuation.scanNewestMessageAt = newest.createdAtOf.toISOString();
  }
  if (!submittedContinuation.watermark) submittedContinuation.watermark = clean(currentContinuation.watermark, 240);
  if (!submittedContinuation.watermarkAt) submittedContinuation.watermarkAt = clean(currentContinuation.watermarkAt, 80);
  submittedContinuation.overlapPages = integer(
    submittedContinuation.overlapPages ?? currentContinuation.overlapPages ?? params.overlapPages,
    2,
    1,
    100,
  );

  const known = mode === "incremental"
    ? evaluateIncrementalStop({
        startingStreak: integer(
          submittedContinuation.knownUnchangedStreak ?? currentContinuation.knownUnchangedStreak,
          0,
        ),
        threshold: integer(
          submittedContinuation.knownMessageThreshold ?? currentContinuation.knownMessageThreshold ?? params.knownMessageThreshold,
          3,
          1,
          100,
        ),
        observations,
        watermarkMessageId: submittedContinuation.watermark,
        watermarkAt: submittedContinuation.watermarkAt,
        watermarkReached: submittedContinuation.watermarkReached === true || currentContinuation.watermarkReached === true,
        pageNumber: integer(submittedContinuation.page, page + 1, 0, 10_000),
        overlapPages: submittedContinuation.overlapPages,
        previousPageOldestAt: currentContinuation.pageOldestAt,
      })
    : {
        streak: 0,
        threshold: integer(params.knownMessageThreshold, 3, 1, 100),
        candidate: false,
        stop: false,
        watermarkReached: false,
        watermarkConfigured: false,
        overlapSatisfied: false,
        pageOrderStable: true,
        pageOldestAt: oldest?.createdAtOf?.toISOString() || null,
      };
  submittedContinuation.knownUnchangedStreak = known.streak;
  submittedContinuation.knownMessageThreshold = known.threshold;
  submittedContinuation.watermarkReached = known.watermarkReached;
  submittedContinuation.pageOldestAt = known.pageOldestAt;

  // A targeted row becomes complete only after Desktop has durably committed
  // the target result locally and this compact checkpoint is accepted.
  if (isTargeted && targetMessageId) {
    await db.dialogReconciliationTarget.updateMany({
      where: {
        creatorId: job.creatorId,
        dialogId,
        messageId: targetMessageId,
        status: "PENDING",
      },
      data: {
        status: "RESOLVED",
        resolvedAt: observedAt,
        lastAttemptAt: observedAt,
        lastError: chunk.targetMissing === true ? "target_message_unavailable" : null,
      },
    });
  }

  let continuationOverride = null;
  const resumeState = isTargeted ? object(submittedContinuation.resumeState) : submittedContinuation;
  const nextTarget = await nextReconciliationTarget(db, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    dialogId,
    excludeMessageId: isTargeted ? targetMessageId : null,
  });
  if (nextTarget) {
    await touchReconciliationTarget(db, nextTarget);
    continuationOverride = targetedContinuation(nextTarget, resumeState, known.threshold);
  } else if (isTargeted && Object.keys(resumeState).length) {
    continuationOverride = resumeState;
  }

  const rawHasMore = chunk.hasMore === true;
  const stopForKnown = mode === "incremental" && known.stop;
  const hasMore = Boolean(continuationOverride) || (rawHasMore && !stopForKnown);
  const result = {
    messageCount,
    mediaCount,
    inserted,
    updated,
    unchanged,
    projected: 0,
    localOnly: true,
    hasMore,
    page,
    cursorOut,
    messageIds,
    changedMessageIds,
    knownUnchangedStreak: known.streak,
    watermarkReached: known.watermarkReached,
    overlapSatisfied: known.overlapSatisfied,
    pageOrderStable: known.pageOrderStable,
    targetMessageId,
    targetResolved: isTargeted && Boolean(targetMessageId),
    stoppedReason: stopForKnown
      ? "known_message_threshold_after_confirmed_watermark"
      : (!rawHasMore && !continuationOverride ? "of_has_more_false" : null),
  };
  const shouldComplete = !hasMore;
  const durableContinuation = continuationOverride || submittedContinuation;
  const responseResult = {
    ...result,
    jobContinuationOverride: continuationOverride || ((mode === "incremental" || stopForKnown) ? submittedContinuation : null),
    completeAfterCommit: shouldComplete,
    completionResult: {
      runId,
      dialogId,
      mode: run.mode,
      pages: integer(run.pagesProcessed, 0) + 1,
      stoppedReason: result.stoppedReason,
      scanNewestMessageId: clean(submittedContinuation.scanNewestMessageId, 240),
      scanNewestMessageAt: clean(submittedContinuation.scanNewestMessageAt, 80),
    },
  };

  const commit = await db.dialogScanChunkCommit.create({
    data: {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      runId,
      jobId: job.id,
      dialogId,
      chunkKey,
      mode,
      cursorIn: clean(chunk.cursorIn, 240),
      cursorOut,
      page,
      messageCount,
      mediaCount,
      hasMore,
      result: responseResult,
    },
  });

  await db.dialogScanRun.update({
    where: { id: runId },
    data: {
      status: "RUNNING",
      startedAt: run.startedAt || observedAt,
      lastWorkerDeviceId: clean(deviceId, 200),
      pagesProcessed: { increment: 1 },
      messagesProcessed: { increment: messageCount },
      mediaProcessed: { increment: mediaCount },
      continuation: durableContinuation,
      progress: {
        ...object(chunk.progress),
        storage: "local_sqlite",
        knownUnchangedStreak: known.streak,
        watermarkReached: known.watermarkReached,
        inserted,
        updated,
        unchanged,
      },
      lastError: null,
    },
  });

  const state = await db.dialogScanState.findUnique({
    where: { creatorId_dialogId: { creatorId: job.creatorId, dialogId } },
  });
  const stateCreate = {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    dialogId,
    fanId: clean(params.fanId, 160),
    status: "RUNNING",
    scanMode: run.mode,
    generation: integer(params.generation, 0),
    newestMessageId: newest?.messageId || null,
    newestMessageAt: newest?.createdAtOf || null,
    oldestMessageId: oldest?.messageId || null,
    oldestMessageAt: oldest?.createdAtOf || null,
    forwardCursor: mode === "incremental" ? clean(state?.forwardCursor, 240) : null,
    backwardCursor: mode === "initial" ? cursorOut : null,
    activeRunId: runId,
    activeJobId: job.id,
    pagesProcessed: 1,
    messagesProcessed: messageCount,
    mediaProcessed: mediaCount,
    incrementalGapOpen: mode === "incremental",
  };
  const stateUpdate = {
    status: "RUNNING",
    scanMode: run.mode,
    generation: integer(params.generation, state?.generation || 0),
    newestMessageId: newest && (!state?.newestMessageAt || newest.createdAtOf >= state.newestMessageAt) ? newest.messageId : undefined,
    newestMessageAt: newest && (!state?.newestMessageAt || newest.createdAtOf >= state.newestMessageAt) ? newest.createdAtOf : undefined,
    oldestMessageId: oldest && (!state?.oldestMessageAt || oldest.createdAtOf <= state.oldestMessageAt) ? oldest.messageId : undefined,
    oldestMessageAt: oldest && (!state?.oldestMessageAt || oldest.createdAtOf <= state.oldestMessageAt) ? oldest.createdAtOf : undefined,
    forwardCursor: undefined,
    backwardCursor: mode === "initial" ? cursorOut || undefined : undefined,
    activeRunId: runId,
    activeJobId: job.id,
    pagesProcessed: { increment: 1 },
    messagesProcessed: { increment: messageCount },
    mediaProcessed: { increment: mediaCount },
    incrementalGapOpen: mode === "incremental" ? true : undefined,
    lastError: null,
  };
  await db.dialogScanState.upsert({
    where: { creatorId_dialogId: { creatorId: job.creatorId, dialogId } },
    create: stateCreate,
    update: stateUpdate,
  });

  return { duplicate: false, replayedCommit: false, chunkId: commit.id, ...responseResult };
}
function normalizedSignal(raw, job) {
  const input = object(raw);
  const creatorId = clean(job.creatorId ?? input.creatorId, 160);
  const agencyId = clean(job.agencyId ?? input.agencyId, 160);
  const occurredAt = dateOrNull(input.occurredAt ?? input.purchasedAt) || new Date();
  if (!creatorId || !agencyId) return null;
  const sourceEventId = clean(input.sourceEventId ?? input.notificationId ?? input.purchaseId ?? input.transactionId, 240);
  const sourceMessageId = clean(input.sourceMessageId ?? input.messageId, 240);
  const candidate = {
    agencyId, creatorId, sourceEventId, sourceMessageId,
    dialogId: clean(input.dialogId, 180), buyerId: clean(input.buyerId ?? input.fanId, 160),
    buyerUsername: clean(input.buyerUsername ?? input.username, 160),
    buyerDisplayName: clean(input.buyerDisplayName ?? input.name, 240),
    buyerDeleted: input.buyerDeleted === true || input.deletedUser === true,
    occurredAt, amountCents: integer(input.amountCents ?? input.priceCents, 0),
    currency: (clean(input.currency, 12) || "USD").toUpperCase(),
    source: clean(input.source, 80) || "notification", metadata: object(input.metadata),
  };
  return { ...candidate, idempotencyKey: purchaseIdempotencyKey(candidate) };
}

async function applyPurchaseSignalsChunk({ db, job, chunkResult, userId = null }) {
  const chunk = object(chunkResult);
  const agencyId = clean(job.agencyId, 160);
  if (!agencyId) return { accepted: 0, projected: 0, scheduled: 0, disabled: false, localOnly: true };
  const control = await moduleControl(db, agencyId);
  if (!control.enabled) return { accepted: 0, projected: 0, scheduled: 0, disabled: true, localOnly: true };
  const raws = chunk.kind === "dialog_purchase_signals" ? list(chunk.signals) : [];
  let accepted = 0;
  let scheduled = 0;
  for (const raw of raws) {
    const signal = normalizedSignal(raw, job);
    if (!signal) continue;
    accepted += 1;
    // Purchase facts, prices and Vault projections are local-only. PostgreSQL
    // retains only the durable reconciliation target/job needed to resolve a
    // notification's source message on another worker after a restart.
    if (signal.dialogId && signal.sourceMessageId) {
      const result = await scheduleDialogScanTx(db, {
        agencyId: signal.agencyId,
        creatorId: signal.creatorId,
        dialogId: signal.dialogId,
        fanId: signal.buyerId,
        mode: "targeted",
        targetMessageId: signal.sourceMessageId,
        source: "local_purchase_notification",
        priority: 120,
        userId,
      });
      if (result.created || result.reason === "targeted_reconciliation_queued") scheduled += 1;
    }
  }
  return { accepted, projected: 0, scheduled, localOnly: true };
}

async function completeDialogIntelligenceJob({ db = prisma, job, deviceId, result }) {
  const params = object(job.params);
  const runId = clean(params.scanRunId, 160);
  const dialogId = clean(params.dialogId, 180);
  if (!job.agencyId || !job.creatorId || !runId || !dialogId) throw new Error("Dialog job completion scope is incomplete");
  const now = new Date();
  const run = await db.dialogScanRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Dialog scan run not found");
  const continuation = object(run.continuation);
  const completion = object(result);
  const confirmedMessageId = clean(
    completion.scanNewestMessageId
      ?? continuation.scanNewestMessageId,
    240,
  );
  const confirmedAt = dateOrNull(
    completion.scanNewestMessageAt
      ?? continuation.scanNewestMessageAt,
  );

  await db.dialogScanRun.update({
    where: { id: runId },
    data: {
      status: "COMPLETED",
      completedAt: now,
      lastWorkerDeviceId: clean(deviceId, 200),
      progress: completion,
      lastError: null,
    },
  });
  await db.dialogScanState.update({
    where: { creatorId_dialogId: { creatorId: job.creatorId, dialogId } },
    data: {
      status: "READY",
      initialScanComplete: run.mode === "initial" ? true : undefined,
      lastFullScanAt: run.mode === "initial" ? now : undefined,
      lastIncrementalScanAt: run.mode === "incremental" ? now : undefined,
      lastCatchupAt: run.source === "offline_catchup" ? now : undefined,
      forwardCursor: run.mode === "incremental" && confirmedMessageId ? confirmedMessageId : undefined,
      confirmedWatermarkMessageId: ["initial", "incremental"].includes(run.mode) && confirmedMessageId ? confirmedMessageId : undefined,
      confirmedWatermarkAt: ["initial", "incremental"].includes(run.mode) && confirmedAt ? confirmedAt : undefined,
      incrementalGapOpen: run.mode === "incremental" ? false : undefined,
      activeRunId: null,
      activeJobId: null,
      lastError: null,
    },
  });

  let next = null;
  if (run.mode === "discovery") {
    next = await scheduleNextPlannedDialogTx(db, {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      generation: integer(params.generation ?? run.generation, run.generation || 0),
      childMode: clean(params.childMode, 40) || "initial",
      source: clean(params.source, 80) || "dialog_discovery_complete",
      priority: integer(params.childPriority, clean(params.childMode, 40) === "initial" ? 60 : 50, 0, 200),
      overlapPages: integer(params.overlapPages, 2, 0, 10),
      knownMessageThreshold: integer(params.knownMessageThreshold, 3, 1, 100),
      maxPages: integer(params.maxPages, clean(params.childMode, 40) === "initial" ? 5000 : 1000, 1, 10000),
    });
  } else if (["initial", "incremental"].includes(run.mode)) {
    next = await scheduleNextPlannedDialogTx(db, {
      agencyId: job.agencyId,
      creatorId: job.creatorId,
      generation: run.generation,
      childMode: run.mode,
      source: "dialog_history_sequence",
      priority: run.mode === "initial" ? 60 : 50,
      overlapPages: integer(params.overlapPages, 2, 0, 10),
      knownMessageThreshold: integer(params.knownMessageThreshold, 3, 1, 100),
      maxPages: integer(params.maxPages, run.mode === "initial" ? 5000 : 1000, 1, 10000),
    });
  }

  return {
    type: "dialog_intelligence",
    runId,
    dialogId,
    completedAt: now.toISOString(),
    next: next ? { created: next.created === true, reason: next.reason || null, runId: next.run?.id || null, jobId: next.job?.id || null } : null,
  };
}

async function recordDialogIntelligenceFailure({ job, error, terminal }) {
  const params = object(job.params);
  const runId = clean(params.scanRunId, 160);
  const dialogId = clean(params.dialogId, 180);
  if (!job.creatorId || !runId || !dialogId) return null;
  const status = terminal ? "FAILED" : "QUEUED";
  let next = null;
  await prisma.$transaction(async (tx) => {
    const run = await tx.dialogScanRun.findUnique({ where: { id: runId } });
    await tx.dialogScanRun.updateMany({
      where: { id: runId },
      data: { status, completedAt: terminal ? new Date() : null, lastError: clean(error, 2000) },
    });
    await tx.dialogScanState.updateMany({
      where: { creatorId: job.creatorId, dialogId },
      data: { status, lastError: clean(error, 2000), activeRunId: terminal ? null : undefined, activeJobId: terminal ? null : undefined },
    });
    if (terminal && run && dialogId !== "__dialog_discovery__" && ["initial", "incremental"].includes(run.mode)) {
      next = await scheduleNextPlannedDialogTx(tx, {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        generation: run.generation,
        childMode: run.mode,
        source: "dialog_history_after_failure",
        priority: run.mode === "initial" ? 60 : 50,
        overlapPages: integer(params.overlapPages, 2, 0, 10),
        knownMessageThreshold: integer(params.knownMessageThreshold, 3, 1, 100),
        maxPages: integer(params.maxPages, run.mode === "initial" ? 5000 : 1000, 1, 10000),
      });
    }
  });
  return {
    runId,
    status,
    next: next ? { created: next.created === true, reason: next.reason || null, runId: next.run?.id || null, jobId: next.job?.id || null } : null,
  };
}

async function ingestWsMessages({ agencyId, creatorId, dialogId, fanId = null, messages }) {
  // Compatibility endpoint for Desktop builds deployed before the local-ledger
  // rollback. Acknowledge the payload without persisting raw chat content so a
  // rolling backend deploy cannot continue growing DialogMessageLedger.
  return {
    ok: true,
    localOnly: true,
    ignored: true,
    agencyId: clean(agencyId, 160),
    creatorId: clean(creatorId, 160),
    dialogId: clean(dialogId, 180),
    fanId: clean(fanId, 160),
    messageCount: list(messages).length,
    mediaCount: 0,
    projected: 0,
  };
}

async function rebuildCreatorAggregates({ agencyId, creatorId }) {
  const rows = await prisma.vaultPurchaseMedia.findMany({
    where: { agencyId, creatorId, isFanMedia: false, assetId: { not: null } },
    distinct: ["assetId"],
    select: { assetId: true },
    take: 100_000,
  });
  for (const row of rows) await rebuildAssetAggregate(prisma, agencyId, creatorId, row.assetId);
  return { ok: true, rebuilt: rows.length };
}

module.exports = {
  DIALOG_INTELLIGENCE_JOB_KEY,
  ACTIVE_RUN_STATUSES,
  DIALOG_CONTROL_TRANSACTION_OPTIONS,
  classifyPurchase,
  purchaseCountsAsRevenue,
  purchaseIdempotencyKey,
  scheduleDialogScan,
  scheduleDialogScanTx,
  restartCreatorDialogPlan,
  restartCreatorDialogPlanTx,
  supersedeCreatorDialogPlanTx,
  nextCreatorDialogPlanGenerationTx,
  autoRecoverDialogDiscovery,
  autoRecoverDialogDiscoveryTx,
  repairRegressedDialogDiscoveryTx,
  applyDialogIntelligenceChunk,
  applyPurchaseSignalsChunk,
  completeDialogIntelligenceJob,
  recordDialogIntelligenceFailure,
  ingestWsMessages,
  rebuildCreatorAggregates,
  moduleControl,
};
