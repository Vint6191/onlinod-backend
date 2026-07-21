"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");
const { automationCreatorParamRequired } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const {
  DIALOG_INTELLIGENCE_JOB_KEY,
  DIALOG_CONTROL_TRANSACTION_OPTIONS,
  scheduleDialogScan,
  restartCreatorDialogPlan,
  ingestWsMessages,
  applyPurchaseSignalsChunk,
  moduleControl,
} = require("../services/dialog-intelligence-service");

const {
  DIALOG_HISTORY_BATCH_DIALOG_ID,
  claimDialogHistoryBatch,
  renewDialogHistoryBatch,
  progressDialogHistoryBatch,
  completeDialogHistoryBatch,
  releaseDialogHistoryBatch,
} = require("../services/dialog-history-batch-service");

const router = express.Router();
router.param("creatorId", automationCreatorParamRequired());

function validationError(res, error) {
  return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
}
function serviceError(res, error, code = "DIALOG_INTELLIGENCE_FAILED") {
  return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || code, error: error?.message || "Dialog intelligence request failed" });
}
function seniorRequired(req, res, next) {
  const member = req.auth?.membership || req.member;
  if (!member || !isSeniorAgencyMember(member)) {
    return res.status(403).json({ ok: false, code: "DIALOG_INTELLIGENCE_WRITE_FORBIDDEN", error: "Owner, admin or manager permission is required" });
  }
  return next();
}
function clean(value, max = 240) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

const scanSchema = z.object({
  mode: z.enum(["initial", "full", "incremental", "targeted", "reconcile"]).optional(),
  fanId: z.string().max(180).optional().nullable(),
  targetMessageId: z.string().max(240).optional().nullable(),
  cursor: z.string().max(240).optional().nullable(),
  source: z.string().max(80).optional(),
  generation: z.number().int().min(0).optional(),
  pageLimit: z.number().int().min(1).max(100).optional(),
  overlapPages: z.number().int().min(0).max(10).optional(),
  maxPages: z.number().int().min(1).max(10000).optional(),
  priority: z.number().int().min(0).max(200).optional(),
  knownMessageThreshold: z.number().int().min(1).max(100).optional(),
});

const creatorScanSchema = z.object({
  mode: z.enum(["initial", "full", "incremental"]).optional(),
  source: z.string().max(80).optional(),
  generation: z.number().int().min(0).optional(),
  pageLimit: z.number().int().min(1).max(100).optional(),
  overlapPages: z.number().int().min(0).max(10).optional(),
  maxPages: z.number().int().min(1).max(10000).optional(),
  priority: z.number().int().min(0).max(200).optional(),
});

async function pauseCreatorRuns({ agencyId, creatorId, reason }) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const jobs = await tx.jobInstance.updateMany({
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
        result: { control: { kind: "paused", reason, at: now.toISOString() } },
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        workId: null,
        leaseRevision: { increment: 1 },
      },
    });
    const runs = await tx.dialogScanRun.updateMany({
      where: { agencyId, creatorId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "PAUSED", pausedAt: now, lastError: null },
    });
    const states = await tx.dialogScanState.updateMany({
      where: {
        agencyId,
        creatorId,
        OR: [
          // A frozen batch backlog is represented by PLANNED rows before a
          // Desktop claims it. Pausing only QUEUED/RUNNING rows left that
          // backlog claimable and the UI stuck on "waiting for worker".
          { status: { in: ["PLANNED", "QUEUED", "RUNNING"] } },
          { activeRunId: { not: null } },
          { activeJobId: { not: null } },
        ],
      },
      // Keep activeRunId for an already claimed batch/discovery run so resume
      // can normalize it deterministically. Standalone PLANNED rows have no
      // activeRunId and are resumed directly back to PLANNED below.
      data: { status: "PAUSED", activeJobId: null, lastError: null },
    });
    return {
      paused: runs.count + states.count,
      pausedRuns: runs.count,
      pausedJobs: jobs.count,
      pausedStates: states.count,
      runs: [],
    };
  }, DIALOG_CONTROL_TRANSACTION_OPTIONS);
}

async function resumeCreatorRuns({ agencyId, creatorId }) {
  return prisma.$transaction(async (tx) => {
    const pausedRuns = await tx.dialogScanRun.findMany({
      where: { agencyId, creatorId, status: "PAUSED" },
      orderBy: [{ generation: "desc" }, { updatedAt: "asc" }],
      take: 1000,
    });

    const now = new Date();
    const pausedDiscoveryRuns = pausedRuns
      .filter((run) => run.dialogId === "__dialog_discovery__")
      .sort((a, b) => {
        const generationDelta = Number(b.generation || 0) - Number(a.generation || 0);
        if (generationDelta !== 0) return generationDelta;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    const selectedDiscovery = pausedDiscoveryRuns[0] || null;
    const historyRuns = pausedRuns.filter((run) => run.dialogId !== "__dialog_discovery__");

    // History is never resumed as a per-dialog JobInstance. Return every paused
    // legacy or synthetic batch claim to the frozen PLANNED list. A ready
    // Desktop will claim a fresh compact batch and feed it to the existing CRM
    // scanner without a server round-trip between dialogs.
    for (const run of historyRuns) {
      if (run.jobId) {
        await tx.jobInstance.updateMany({
          where: { id: run.jobId, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
          data: {
            status: "CANCELLED",
            completedAt: now,
            lastError: "Legacy per-dialog history run returned to batch plan",
            result: { control: { kind: "normalized", reason: "dialog history resumes by batch claim", at: now.toISOString() } },
            claimedByDeviceId: null,
            claimedAt: null,
            leaseUntil: null,
            leaseTokenHash: null,
            workId: null,
            leaseRevision: { increment: 1 },
          },
        });
      }
      await tx.dialogScanState.updateMany({
        where: { agencyId, creatorId, activeRunId: run.id },
        data: { status: "PLANNED", activeRunId: null, activeJobId: null, lastError: null },
      });
      await tx.dialogScanRun.update({
        where: { id: run.id },
        data: {
          status: "CANCELLED",
          pausedAt: null,
          completedAt: now,
          lastError: "Paused dialog history returned to batch plan",
        },
      });
    }

    // Only discovery still owns a normal durable JobInstance because it must
    // enumerate/freeze the dialog list before batches can be claimed.
    for (const staleDiscovery of pausedDiscoveryRuns.slice(1)) {
      if (staleDiscovery.jobId) {
        await tx.jobInstance.updateMany({
          where: { id: staleDiscovery.jobId, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
          data: {
            status: "CANCELLED",
            completedAt: now,
            lastError: null,
            result: { control: { kind: "normalized", reason: "newer discovery run selected", at: now.toISOString() } },
            claimedByDeviceId: null,
            claimedAt: null,
            leaseUntil: null,
            leaseTokenHash: null,
            workId: null,
            leaseRevision: { increment: 1 },
          },
        });
      }
      await tx.dialogScanRun.update({
        where: { id: staleDiscovery.id },
        data: { status: "CANCELLED", pausedAt: null, completedAt: now, lastError: null },
      });
    }

    // Rows paused while they were still waiting in the frozen batch list have
    // no active run to normalize. Resume them explicitly; otherwise a creator
    // with only PLANNED backlog can never leave PAUSED and can never be claimed.
    const standaloneHistory = await tx.dialogScanState.updateMany({
      where: {
        agencyId,
        creatorId,
        status: "PAUSED",
        dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
        activeRunId: null,
      },
      data: {
        status: "PLANNED",
        activeRunId: null,
        activeJobId: null,
        lastError: null,
      },
    });

    if (!selectedDiscovery) {
      return {
        resumed: standaloneHistory.count,
        resumedStates: standaloneHistory.count,
        normalized: historyRuns.length,
        items: [],
      };
    }

    const oldJob = selectedDiscovery.jobId
      ? await tx.jobInstance.findUnique({ where: { id: selectedDiscovery.jobId } })
      : null;
    const job = await tx.jobInstance.create({
      data: {
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        scope: "creator",
        creatorId: selectedDiscovery.creatorId,
        agencyId: selectedDiscovery.agencyId,
        idempotencyKey: `${DIALOG_INTELLIGENCE_JOB_KEY}:resume:${selectedDiscovery.id}:${Date.now()}`,
        params: {
          ...((oldJob?.params && typeof oldJob.params === "object") ? oldJob.params : {}),
          scanRunId: selectedDiscovery.id,
          dialogId: "__dialog_discovery__",
          mode: "discovery",
        },
        continuation: oldJob?.continuation || selectedDiscovery.continuation || null,
        progress: oldJob?.progress || selectedDiscovery.progress || null,
        status: "SCHEDULED",
        priority: oldJob?.priority || 70,
        scheduledAt: now,
        nextRunAt: now,
      },
    });
    await tx.dialogScanRun.update({
      where: { id: selectedDiscovery.id },
      data: { status: "QUEUED", jobId: job.id, pausedAt: null, completedAt: null, lastError: null },
    });
    await tx.dialogScanState.updateMany({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
      data: { status: "QUEUED", activeJobId: job.id, activeRunId: selectedDiscovery.id, lastError: null },
    });
    return {
      resumed: 1 + standaloneHistory.count,
      resumedStates: standaloneHistory.count,
      normalized: historyRuns.length + Math.max(0, pausedDiscoveryRuns.length - 1),
      items: [{
        runId: selectedDiscovery.id,
        jobId: job.id,
        dialogId: "__dialog_discovery__",
        generation: selectedDiscovery.generation,
      }],
    };
  }, DIALOG_CONTROL_TRANSACTION_OPTIONS);
}

router.post("/creators/:creatorId/scans", async (req, res) => {
  try {
    const input = creatorScanSchema.parse(req.body || {});
    const childMode = input.mode === "full" ? "initial" : (input.mode || "incremental");
    const forceChildFull = input.mode === "full";
    if (childMode === "initial" && !isSeniorAgencyMember(req.auth?.membership || req.member)) {
      return res.status(403).json({ ok: false, code: "DIALOG_FULL_SCAN_FORBIDDEN", error: "Owner, admin or manager permission is required for a full scan" });
    }
    // Restarting a creator-wide dialog plan is one database transaction.
    // The old build cancelled the current discovery first and created its
    // replacement in a second transaction. A transient error in between left
    // Never Used permanently CANCELLED. The service now guarantees all-or-none.
    const result = await restartCreatorDialogPlan({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      childMode,
      forceChildFull,
      source: input.source || "manual_creator_scan",
      generation: input.generation ?? null,
      pageLimit: input.pageLimit || 50,
      overlapPages: input.overlapPages ?? 2,
      maxPages: input.maxPages ?? (childMode === "initial" ? 5000 : 1000),
      priority: input.priority ?? (childMode === "initial" ? 90 : 70),
      userId: req.auth.userId,
    });
    if (result.created) {
      await audit({
        agencyId: req.auth.agencyId,
        actorUserId: req.auth.userId,
        action: childMode === "initial" ? "dialog_intelligence.full_scan_started" : "dialog_intelligence.incremental_scan_started",
        targetType: "creator",
        targetId: req.params.creatorId,
        metadata: {
          runId: result.run?.id,
          mode: childMode,
          source: input.source || "manual_creator_scan",
          generation: result.generation ?? result.run?.generation ?? null,
          supersededHistoryRuns: result.supersededHistoryRuns || 0,
        },
      });
    }
    return res.status(result.created ? 202 : 200).json({ ...result, forceChildFull });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_CREATOR_SCAN_START_FAILED");
  }
});

router.post("/creators/:creatorId/dialogs/:dialogId/scans", async (req, res) => {
  try {
    const input = scanSchema.parse(req.body || {});
    const requestedMode = input.mode || "incremental";
    const member = req.auth?.membership || req.member;
    const senior = isSeniorAgencyMember(member);
    const lifecycleSources = new Set(["dialog_open", "automatic_startup_resume_scan", "crm_analysis_waiting_for_scan", "browser_dialog_open"]);
    if (["initial", "full", "reconcile"].includes(requestedMode) && !senior) {
      const currentState = await prisma.dialogScanState.findUnique({
        where: { creatorId_dialogId: { creatorId: req.params.creatorId, dialogId: req.params.dialogId } },
        select: { initialScanComplete: true },
      });
      // Full history is local per Desktop. A member opening a dialog on a
      // machine whose local SQLite is empty must be allowed to rebuild that
      // local ledger even when another Desktop completed the server-side scan
      // checkpoint earlier. Explicit/manual full rescans remain senior-only.
      const lifecycleInitial = requestedMode === "initial"
        && lifecycleSources.has(input.source || "")
        && currentState?.initialScanComplete !== true;
      const lifecycleLocalFull = requestedMode === "full"
        && lifecycleSources.has(input.source || "");
      if (!lifecycleInitial && !lifecycleLocalFull) {
        return res.status(403).json({ ok: false, code: "DIALOG_SCAN_WRITE_FORBIDDEN", error: "Owner, admin or manager permission is required for this scan mode" });
      }
    }
    const result = await scheduleDialogScan({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      dialogId: req.params.dialogId,
      fanId: input.fanId || null,
      mode: input.mode || null,
      targetMessageId: input.targetMessageId || null,
      cursor: input.cursor || null,
      source: input.source || "manual_ui",
      generation: input.generation || 0,
      pageLimit: input.pageLimit || 50,
      overlapPages: input.overlapPages ?? 2,
      maxPages: input.maxPages ?? (requestedMode === "initial" || requestedMode === "full" ? 5000 : 1000),
      priority: input.priority,
      knownMessageThreshold: input.knownMessageThreshold ?? 3,
      userId: req.auth.userId,
    });
    if (result.created) {
      await audit({
        agencyId: req.auth.agencyId,
        actorUserId: req.auth.userId,
        action: `dialog_intelligence.${input.mode === "initial" || input.mode === "full" ? "full_scan_started" : input.mode === "reconcile" ? "reconciliation_started" : "incremental_scan_started"}`,
        targetType: "dialog",
        targetId: `${req.params.creatorId}:${req.params.dialogId}`,
        metadata: { creatorId: req.params.creatorId, dialogId: req.params.dialogId, runId: result.run?.id, mode: result.run?.mode, source: input.source || "manual_ui" },
      });
    }
    return res.status(result.created ? 202 : 200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_SCAN_START_FAILED");
  }
});

router.get("/creators/:creatorId/dialogs/:dialogId/state", async (req, res) => {
  try {
    const [state, activeRun, control] = await Promise.all([
      prisma.dialogScanState.findUnique({ where: { creatorId_dialogId: { creatorId: req.params.creatorId, dialogId: req.params.dialogId } } }),
      prisma.dialogScanRun.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, dialogId: req.params.dialogId, status: { in: ["QUEUED", "RUNNING", "PAUSED"] } },
        orderBy: { createdAt: "desc" },
      }),
      moduleControl(prisma, req.auth.agencyId),
    ]);
    // Full message/media rows are local-only. These counters are compact scan
    // telemetry and do not query the legacy server ledger.
    const messageCount = Number(state?.messagesProcessed || 0);
    const mediaCount = Number(state?.mediaProcessed || 0);
    let job = null;
    if (activeRun?.jobId) {
      job = await prisma.jobInstance.findUnique({
        where: { id: activeRun.jobId },
        select: { id: true, status: true, progress: true, continuation: true, leaseUntil: true, claimedByDeviceId: true, leaseRevision: true, attempts: true, lastError: true, lastProgressAt: true },
      });
    }
    return res.json({ ok: true, state, activeRun, job, control, messageCount, mediaCount });
  } catch (error) { return serviceError(res, error, "DIALOG_SCAN_STATE_FAILED"); }
});

router.get("/creators/:creatorId/dialogs/:dialogId/messages", async (req, res) => {
  // Compatibility surface only. Full chat history is canonical in the
  // Desktop's dialog-messages.sqlite and is intentionally not served from
  // PostgreSQL anymore.
  return res.json({
    ok: true,
    localOnly: true,
    items: [],
    count: 0,
    offset: 0,
    nextOffset: 0,
    hasMore: false,
  });
});

router.get("/creators/:creatorId/runs", async (req, res) => {
  try {
    const query = z.object({
      dialogId: z.string().max(180).optional(),
      status: z.string().max(40).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(250).optional(),
    }).parse(req.query || {});
    const offset = query.offset || 0;
    const limit = query.limit || 50;
    const where = { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, ...(query.dialogId ? { dialogId: query.dialogId } : {}), ...(query.status ? { status: query.status.toUpperCase() } : {}) };
    const [items, count] = await Promise.all([
      prisma.dialogScanRun.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
      prisma.dialogScanRun.count({ where }),
    ]);
    return res.json({ ok: true, items, count, offset, nextOffset: offset + items.length, hasMore: offset + items.length < count });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_RUNS_LIST_FAILED");
  }
});

const wsSchema = z.object({
  dialogId: z.string().min(1).max(180),
  fanId: z.string().max(180).optional().nullable(),
  messages: z.array(z.record(z.unknown())).min(1).max(500),
});

const purchaseSignalsSchema = z.object({
  signals: z.array(z.record(z.unknown())).min(1).max(500),
});
router.post("/creators/:creatorId/ingest/purchase-signals", async (req, res) => {
  try {
    const input = purchaseSignalsSchema.parse(req.body || {});
    const result = await prisma.$transaction((tx) => applyPurchaseSignalsChunk({
      db: tx,
      job: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, params: {} },
      userId: req.auth.userId,
      chunkResult: { kind: "dialog_purchase_signals", signals: input.signals },
    }));
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_PURCHASE_SIGNAL_INGEST_FAILED");
  }
});
router.post("/creators/:creatorId/ingest/ws", async (req, res) => {
  try {
    const input = wsSchema.parse(req.body || {});
    const result = await ingestWsMessages({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      dialogId: input.dialogId,
      fanId: input.fanId || null,
      messages: input.messages,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_WS_INGEST_FAILED");
  }
});


const dialogBatchClaimSchema = z.object({
  deviceId: z.string().min(1).max(200),
  creatorIds: z.array(z.string().min(1).max(160)).min(1).max(1000),
  batchSize: z.number().int().min(1).max(100).optional(),
  leaseMs: z.number().int().min(60_000).max(30 * 60_000).optional(),
});
const dialogBatchLeaseSchema = z.object({
  deviceId: z.string().min(1).max(200),
  leaseToken: z.string().min(16).max(500),
  leaseMs: z.number().int().min(60_000).max(30 * 60_000).optional(),
});
const dialogBatchProgressSchema = dialogBatchLeaseSchema.extend({
  progress: z.object({
    current: z.number().int().min(0).max(100),
    total: z.number().int().min(0).max(100),
    completed: z.number().int().min(0).max(100).optional(),
    failed: z.number().int().min(0).max(100).optional(),
    replanned: z.number().int().min(0).max(100).optional(),
    skipped: z.number().int().min(0).max(100).optional(),
    dialogId: z.string().max(180).optional().nullable(),
    fanId: z.string().max(180).optional().nullable(),
    stage: z.enum(["starting", "scanning", "syncing_usage", "completed", "failed", "stalled", "unavailable"]).optional(),
    pages: z.number().int().min(0).max(100000).optional(),
    messages: z.number().int().min(0).max(100000000).optional(),
    media: z.number().int().min(0).max(100000000).optional(),
    lastError: z.string().max(2000).optional().nullable(),
    message: z.string().max(500).optional(),
  }),
});
const dialogBatchCompleteSchema = dialogBatchLeaseSchema.extend({
  results: z.array(z.object({
    dialogId: z.string().min(1).max(180),
    ok: z.boolean(),
    retryable: z.boolean().optional(),
    pages: z.number().int().min(0).max(100000).optional(),
    messages: z.number().int().min(0).max(100000000).optional(),
    inserted: z.number().int().min(0).max(100000000).optional(),
    updated: z.number().int().min(0).max(100000000).optional(),
    error: z.string().max(2000).optional().nullable(),
    code: z.string().max(120).optional().nullable(),
    status: z.number().int().min(0).max(599).optional().nullable(),
    unavailable: z.boolean().optional(),
    reusedLocal: z.boolean().optional(),
  })).min(1).max(100),
});
const dialogBatchReleaseSchema = dialogBatchLeaseSchema.extend({
  reason: z.string().max(2000).optional(),
});

router.post("/batches/claim", async (req, res) => {
  try {
    const input = dialogBatchClaimSchema.parse(req.body || {});
    const result = await claimDialogHistoryBatch({
      agencyId: req.auth.agencyId,
      deviceId: input.deviceId,
      creatorIds: input.creatorIds,
      batchSize: input.batchSize,
      leaseMs: input.leaseMs,
    });
    return res.status(result.batch ? 202 : 200).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_BATCH_CLAIM_FAILED");
  }
});

router.post("/batches/:batchId/renew", async (req, res) => {
  try {
    const input = dialogBatchLeaseSchema.parse(req.body || {});
    const result = await renewDialogHistoryBatch({
      agencyId: req.auth.agencyId,
      batchId: req.params.batchId,
      ...input,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_BATCH_RENEW_FAILED");
  }
});

router.post("/batches/:batchId/progress", async (req, res) => {
  try {
    const input = dialogBatchProgressSchema.parse(req.body || {});
    const result = await progressDialogHistoryBatch({
      agencyId: req.auth.agencyId,
      batchId: req.params.batchId,
      ...input,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_BATCH_PROGRESS_FAILED");
  }
});

router.post("/batches/:batchId/complete", async (req, res) => {
  try {
    const input = dialogBatchCompleteSchema.parse(req.body || {});
    const result = await completeDialogHistoryBatch({
      agencyId: req.auth.agencyId,
      batchId: req.params.batchId,
      ...input,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_BATCH_COMPLETE_FAILED");
  }
});

router.post("/batches/:batchId/release", async (req, res) => {
  try {
    const input = dialogBatchReleaseSchema.parse(req.body || {});
    const result = await releaseDialogHistoryBatch({
      agencyId: req.auth.agencyId,
      batchId: req.params.batchId,
      ...input,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_BATCH_RELEASE_FAILED");
  }
});

router.post("/creators/:creatorId/pause", seniorRequired, async (req, res) => {
  try {
    const reason = clean(req.body?.reason, 500) || "paused by user";
    const result = await pauseCreatorRuns({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, reason });
    await audit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId,
      action: "dialog_intelligence.scan_paused", targetType: "creator", targetId: req.params.creatorId,
      metadata: { paused: result.paused, reason },
    });
    return res.json({
      ok: true,
      paused: result.paused,
      pausedRuns: result.pausedRuns || 0,
      pausedJobs: result.pausedJobs || 0,
      pausedStates: result.pausedStates || 0,
      runIds: result.runs.map((run) => run.id),
    });
  } catch (error) { return serviceError(res, error, "DIALOG_CREATOR_SCAN_PAUSE_FAILED"); }
});

router.post("/creators/:creatorId/resume", seniorRequired, async (req, res) => {
  try {
    const control = await moduleControl(prisma, req.auth.agencyId);
    if (!control.enabled) return res.status(409).json({ ok: false, code: "DIALOG_MODULE_DISABLED", error: "Enable Dialog Intelligence before resuming scans" });
    const result = await resumeCreatorRuns({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId });
    await audit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId,
      action: "dialog_intelligence.scan_resumed", targetType: "creator", targetId: req.params.creatorId,
      metadata: { resumed: result.resumed },
    });
    return res.status(result.resumed ? 202 : 200).json({ ok: true, ...result });
  } catch (error) { return serviceError(res, error, "DIALOG_CREATOR_SCAN_RESUME_FAILED"); }
});

router.post("/creators/:creatorId/cancel", seniorRequired, async (req, res) => {
  try {
    const reason = clean(req.body?.reason, 500) || "creator scan canceled by user";
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      // Scope-based updates are intentional. A creator can have more than 10k
      // planned dialog rows, and building a giant id list used to expire the
      // interactive transaction before its first update completed.
      const jobs = await tx.jobInstance.updateMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId: req.params.creatorId,
          jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
          status: { in: ["SCHEDULED", "CLAIMED"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: now,
          lastError: null,
          result: { control: { kind: "cancelled", reason, at: now.toISOString() } },
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          workId: null,
          leaseRevision: { increment: 1 },
        },
      });
      const runs = await tx.dialogScanRun.updateMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId: req.params.creatorId,
          status: { in: ["QUEUED", "RUNNING", "PAUSED"] },
        },
        data: { status: "CANCELLED", canceledAt: now, completedAt: now, pausedAt: null, lastError: null },
      });
      const states = await tx.dialogScanState.updateMany({
        where: {
          agencyId: req.auth.agencyId,
          creatorId: req.params.creatorId,
          OR: [
            { status: { in: ["QUEUED", "RUNNING", "PAUSED"] } },
            { activeRunId: { not: null } },
            { activeJobId: { not: null } },
          ],
        },
        data: { status: "IDLE", activeRunId: null, activeJobId: null, lastError: null },
      });
      return { canceled: runs.count, canceledJobs: jobs.count, resetStates: states.count };
    }, DIALOG_CONTROL_TRANSACTION_OPTIONS);
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "dialog_intelligence.scan_canceled",
      targetType: "creator",
      targetId: req.params.creatorId,
      metadata: { runs: result.canceled, jobs: result.canceledJobs, states: result.resetStates, reason },
    });
    return res.json({ ok: true, ...result, runIds: [] });
  } catch (error) { return serviceError(res, error, "DIALOG_CREATOR_SCAN_CANCEL_FAILED"); }
});

router.post("/creators/:creatorId/dialogs/:dialogId/cancel", seniorRequired, async (req, res) => {
  try {
    const reason = clean(req.body?.reason, 500) || "canceled by user";
    const active = await prisma.dialogScanRun.findFirst({
      where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, dialogId: req.params.dialogId, status: { in: ["QUEUED", "RUNNING", "PAUSED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!active) return res.json({ ok: true, canceled: false, reason: "no_active_run" });
    await prisma.$transaction(async (tx) => {
      if (active.jobId) {
        await tx.jobInstance.updateMany({
          where: { id: active.jobId, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
          data: {
            status: "CANCELLED",
            completedAt: new Date(),
            lastError: null,
            result: { control: { kind: "cancelled", reason, at: new Date().toISOString() } },
            claimedByDeviceId: null,
            leaseUntil: null,
            leaseTokenHash: null,
          },
        });
      }
      await tx.dialogScanRun.update({ where: { id: active.id }, data: { status: "CANCELLED", canceledAt: new Date(), completedAt: new Date(), lastError: null } });
      await tx.dialogScanState.updateMany({
        where: { creatorId: req.params.creatorId, dialogId: req.params.dialogId },
        data: { status: "IDLE", activeRunId: null, activeJobId: null, lastError: null },
      });
    }, DIALOG_CONTROL_TRANSACTION_OPTIONS);

    await audit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId,
      action: "dialog_intelligence.scan_canceled", targetType: "dialog_scan_run", targetId: active.id,
      metadata: { creatorId: req.params.creatorId, dialogId: req.params.dialogId, reason },
    });
    return res.json({ ok: true, canceled: true, runId: active.id });
  } catch (error) { return serviceError(res, error, "DIALOG_SCAN_CANCEL_FAILED"); }
});

const controlSchema = z.object({ enabled: z.boolean(), settings: z.record(z.unknown()).optional() });
router.patch("/control", seniorRequired, async (req, res) => {
  try {
    const input = controlSchema.parse(req.body || {});
    const before = await moduleControl(prisma, req.auth.agencyId);
    const transition = await prisma.$transaction(async (tx) => {
      const setting = await tx.moduleSetting.upsert({
        where: { agencyId_moduleKey: { agencyId: req.auth.agencyId, moduleKey: "dialog_intelligence" } },
        create: { agencyId: req.auth.agencyId, moduleKey: "dialog_intelligence", enabled: input.enabled, status: input.enabled ? "active" : "disabled", config: input.settings || {} },
        update: { enabled: input.enabled, status: input.enabled ? "active" : "disabled", ...(input.settings ? { config: input.settings } : {}) },
      });
      let pausedCreatorIds = [];
      if (!input.enabled) {
        const jobs = await tx.jobInstance.findMany({
          where: { agencyId: req.auth.agencyId, jobKey: DIALOG_INTELLIGENCE_JOB_KEY, status: { in: ["SCHEDULED", "CLAIMED"] } },
          select: { id: true },
        });
        const ids = jobs.map((job) => job.id);
        if (ids.length) {
          const now = new Date();
          await tx.jobInstance.updateMany({
            where: { id: { in: ids } },
            data: {
              status: "CANCELLED",
              completedAt: now,
              lastError: null,
              result: { control: { kind: "module_disabled", reason: "dialog intelligence disabled", at: now.toISOString() } },
              claimedByDeviceId: null,
              leaseUntil: null,
              leaseTokenHash: null,
              workId: null,
              leaseRevision: { increment: 1 },
            },
          });
          await tx.dialogScanRun.updateMany({
            where: { jobId: { in: ids } },
            data: { status: "PAUSED", pausedAt: now, lastError: null },
          });
          await tx.dialogScanState.updateMany({
            where: { agencyId: req.auth.agencyId, activeJobId: { in: ids } },
            data: { status: "PAUSED", activeJobId: null, lastError: null },
          });
        }
      } else {
        const paused = await tx.dialogScanRun.findMany({
          where: { agencyId: req.auth.agencyId, status: "PAUSED" },
          select: { creatorId: true },
          take: 10000,
        });
        pausedCreatorIds = [...new Set(paused.map((run) => run.creatorId).filter(Boolean))];
      }
      return { setting, pausedCreatorIds };
    });

    // Resume at most one authoritative run per creator. resumeCreatorRuns also
    // normalizes legacy duplicate paused runs back into a sequential plan.
    const resumed = [];
    if (input.enabled) {
      for (const creatorId of transition.pausedCreatorIds) {
        resumed.push({ creatorId, ...(await resumeCreatorRuns({ agencyId: req.auth.agencyId, creatorId })) });
      }
    }

    await audit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId,
      action: input.enabled ? "dialog_intelligence.module_enabled" : "dialog_intelligence.module_disabled",
      targetType: "module", targetId: "dialog_intelligence",
      metadata: { before, after: { enabled: transition.setting.enabled, config: transition.setting.config }, resumed },
    });
    return res.json({ ok: true, setting: transition.setting, resumed });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_CONTROL_UPDATE_FAILED");
  }
});

router.get("/creators/:creatorId/diagnostics", async (req, res) => {
  try {
    const [states, runs, jobs] = await Promise.all([
      prisma.dialogScanState.findMany({ where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId }, orderBy: { updatedAt: "desc" }, take: 250 }),
      prisma.dialogScanRun.findMany({ where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.jobInstance.findMany({
        where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, jobKey: DIALOG_INTELLIGENCE_JOB_KEY },
        orderBy: { createdAt: "desc" }, take: 50,
        select: { id: true, status: true, progress: true, continuation: true, claimedByDeviceId: true, leaseUntil: true, leaseRevision: true, attempts: true, lastError: true, lastProgressAt: true, createdAt: true },
      }),
    ]);
    return res.json({ ok: true, states, runs, jobs });
  } catch (error) { return serviceError(res, error, "DIALOG_DIAGNOSTICS_FAILED"); }
});

module.exports = router;
