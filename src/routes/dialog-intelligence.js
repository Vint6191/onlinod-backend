"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");
const { automationCreatorParamRequired } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const {
  DIALOG_INTELLIGENCE_JOB_KEY,
  scheduleDialogScan,
  restartCreatorDialogPlan,
  ingestWsMessages,
  applyPurchaseSignalsChunk,
  moduleControl,
} = require("../services/dialog-intelligence-service");

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
  const runs = await prisma.dialogScanRun.findMany({
    where: { agencyId, creatorId, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "asc" },
    take: 10000,
  });
  const jobIds = runs.map((run) => run.jobId).filter(Boolean);
  await prisma.$transaction(async (tx) => {
    if (jobIds.length) {
      await tx.jobInstance.updateMany({
        where: { id: { in: jobIds }, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
        data: {
          status: "CANCELLED", completedAt: new Date(), lastError: null,
          result: { control: { kind: "paused", reason, at: new Date().toISOString() } },
          claimedByDeviceId: null, leaseUntil: null, leaseTokenHash: null,
          leaseRevision: { increment: 1 },
        },
      });
    }
    if (runs.length) {
      await tx.dialogScanRun.updateMany({
        where: { id: { in: runs.map((run) => run.id) } },
        data: { status: "PAUSED", pausedAt: new Date(), lastError: null },
      });
      await tx.dialogScanState.updateMany({
        where: { agencyId, creatorId, activeRunId: { in: runs.map((run) => run.id) } },
        data: { status: "PAUSED", activeJobId: null, lastError: null },
      });
    }
  });
  return { paused: runs.length, runs };
}

async function resumeCreatorRuns({ agencyId, creatorId }) {
  return prisma.$transaction(async (tx) => {
    const runs = await tx.dialogScanRun.findMany({
      where: { agencyId, creatorId, status: "PAUSED" },
      orderBy: [{ generation: "desc" }, { updatedAt: "asc" }],
      take: 1000,
    });
    if (!runs.length) return { resumed: 0, normalized: 0, items: [] };

    // A creator pipeline is strictly sequential. Legacy builds could pause
    // several discovery/history runs at once and then resume every one of
    // them, recreating the exact parallel queue this pipeline is meant to
    // eliminate. Resume one authoritative run and turn the remaining paused
    // history rows back into plan entries.
    const latestDiscovery = await tx.dialogScanRun.findFirst({
      where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
      orderBy: [{ generation: "desc" }, { createdAt: "desc" }],
      select: { id: true, generation: true, status: true },
    });
    const latestDiscoveryStatus = clean(latestDiscovery?.status, 40).toUpperCase();
    let selectedGeneration = latestDiscovery?.generation ?? runs[0]?.generation ?? 0;
    let selected = latestDiscoveryStatus === "PAUSED"
      ? runs.find((run) => run.id === latestDiscovery.id) || null
      : null;

    // If the authoritative discovery is already live, stale paused rows must
    // be cleaned up but no second job may be started beside it.
    const discoveryAlreadyLive = ["QUEUED", "RUNNING"].includes(latestDiscoveryStatus);
    if (!selected && !discoveryAlreadyLive) {
      selected = runs.find((run) => run.dialogId !== "__dialog_discovery__" && run.generation === selectedGeneration)
        || (!latestDiscovery
          ? runs
            .filter((run) => run.dialogId === "__dialog_discovery__")
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0]
          : null)
        || runs.find((run) => run.dialogId !== "__dialog_discovery__")
        || null;
      selectedGeneration = selected?.generation ?? selectedGeneration;
    }

    const extraRuns = selected ? runs.filter((run) => run.id !== selected.id) : runs;
    const now = new Date();
    for (const run of extraRuns) {
      if (run.jobId) {
        await tx.jobInstance.updateMany({
          where: { id: run.jobId, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
          data: {
            status: "CANCELLED",
            completedAt: now,
            lastError: null,
            result: { control: { kind: "normalized", reason: "sequential dialog plan recovery", at: now.toISOString() } },
            claimedByDeviceId: null,
            leaseUntil: null,
            leaseTokenHash: null,
            workId: null,
            leaseRevision: { increment: 1 },
          },
        });
      }
      await tx.dialogScanRun.update({
        where: { id: run.id },
        data: { status: "CANCELLED", completedAt: now, pausedAt: null, lastError: null },
      });
      await tx.dialogScanState.updateMany({
        where: { agencyId, creatorId, activeRunId: run.id },
        data: {
          status: run.dialogId !== "__dialog_discovery__" && run.generation === selectedGeneration ? "PLANNED" : "IDLE",
          activeRunId: null,
          activeJobId: null,
          lastError: null,
        },
      });
    }

    if (!selected) {
      return { resumed: 0, normalized: extraRuns.length, items: [] };
    }

    const oldJob = selected.jobId ? await tx.jobInstance.findUnique({ where: { id: selected.jobId } }) : null;
    const job = await tx.jobInstance.create({
      data: {
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        scope: "creator",
        creatorId: selected.creatorId,
        agencyId: selected.agencyId,
        idempotencyKey: `${DIALOG_INTELLIGENCE_JOB_KEY}:resume:${selected.id}:${Date.now()}`,
        params: {
          ...((oldJob?.params && typeof oldJob.params === "object") ? oldJob.params : {}),
          scanRunId: selected.id,
          dialogId: selected.dialogId,
          mode: selected.mode,
        },
        continuation: oldJob?.continuation || selected.continuation || null,
        progress: oldJob?.progress || selected.progress || null,
        status: "SCHEDULED",
        priority: oldJob?.priority || 70,
        scheduledAt: now,
        nextRunAt: now,
      },
    });
    await tx.dialogScanRun.update({
      where: { id: selected.id },
      data: { status: "QUEUED", jobId: job.id, pausedAt: null, completedAt: null, lastError: null },
    });
    await tx.dialogScanState.updateMany({
      where: { agencyId, creatorId, dialogId: selected.dialogId },
      data: { status: "QUEUED", activeJobId: job.id, activeRunId: selected.id, lastError: null },
    });
    return {
      resumed: 1,
      normalized: extraRuns.length,
      items: [{ runId: selected.id, jobId: job.id, dialogId: selected.dialogId, generation: selected.generation }],
    };
  });
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
      const lifecycleInitial = requestedMode === "initial"
        && lifecycleSources.has(input.source || "")
        && currentState?.initialScanComplete !== true;
      if (!lifecycleInitial) {
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
    const [state, activeRun, control, messageCount, mediaCount] = await Promise.all([
      prisma.dialogScanState.findUnique({ where: { creatorId_dialogId: { creatorId: req.params.creatorId, dialogId: req.params.dialogId } } }),
      prisma.dialogScanRun.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, dialogId: req.params.dialogId, status: { in: ["QUEUED", "RUNNING", "PAUSED"] } },
        orderBy: { createdAt: "desc" },
      }),
      moduleControl(prisma, req.auth.agencyId),
      prisma.dialogMessageLedger.count({ where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, dialogId: req.params.dialogId } }),
      prisma.dialogMessageMedia.count({ where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, messageLedger: { dialogId: req.params.dialogId } } }),
    ]);
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
  try {
    const query = z.object({
      offset: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(250).optional(),
      after: z.string().datetime().optional(),
      before: z.string().datetime().optional(),
      changedAfter: z.string().datetime().optional(),
      includeText: z.enum(["true", "false"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      messageIds: z.string().max(12000).optional(),
    }).parse(req.query || {});
    const offset = query.offset || 0;
    const limit = query.limit || 100;
    const messageIds = (query.messageIds || "").split(",").map((value) => clean(value, 240)).filter(Boolean).slice(0, 100);
    const where = {
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      dialogId: req.params.dialogId,
      ...(messageIds.length ? { messageId: { in: messageIds } } : {}),
      ...(query.after || query.before ? { createdAtOf: { ...(query.after ? { gt: new Date(query.after) } : {}), ...(query.before ? { lt: new Date(query.before) } : {}) } } : {}),
      ...(query.changedAfter ? { OR: [{ changedAtOf: { gt: new Date(query.changedAfter) } }, { firstSeenAt: { gt: new Date(query.changedAfter) } }] } : {}),
    };
    const [items, count] = await Promise.all([
      prisma.dialogMessageLedger.findMany({
        where,
        orderBy: [{ createdAtOf: query.order === "desc" ? "desc" : "asc" }, { messageId: query.order === "desc" ? "desc" : "asc" }],
        skip: offset,
        take: limit,
        include: { media: true },
      }),
      prisma.dialogMessageLedger.count({ where }),
    ]);
    const safeItems = items.map((item) => query.includeText === "false" ? { ...item, text: null } : item);
    return res.json({ ok: true, items: safeItems, count, offset, nextOffset: offset + items.length, hasMore: offset + items.length < count });
  } catch (error) {
    if (error instanceof z.ZodError) return validationError(res, error);
    return serviceError(res, error, "DIALOG_MESSAGES_LIST_FAILED");
  }
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

router.post("/creators/:creatorId/pause", seniorRequired, async (req, res) => {
  try {
    const reason = clean(req.body?.reason, 500) || "paused by user";
    const result = await pauseCreatorRuns({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, reason });
    await audit({
      agencyId: req.auth.agencyId, actorUserId: req.auth.userId,
      action: "dialog_intelligence.scan_paused", targetType: "creator", targetId: req.params.creatorId,
      metadata: { paused: result.paused, reason },
    });
    return res.json({ ok: true, paused: result.paused, runIds: result.runs.map((run) => run.id) });
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
    const runs = await prisma.dialogScanRun.findMany({
      where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, status: { in: ["QUEUED", "RUNNING", "PAUSED"] } },
      select: { id: true, jobId: true, dialogId: true },
      take: 10000,
    });
    const jobIds = runs.map((run) => run.jobId).filter(Boolean);
    await prisma.$transaction(async (tx) => {
      if (jobIds.length) {
        await tx.jobInstance.updateMany({
          where: { id: { in: jobIds }, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
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
      if (runs.length) {
        await tx.dialogScanRun.updateMany({ where: { id: { in: runs.map((run) => run.id) } }, data: { status: "CANCELLED", canceledAt: new Date(), completedAt: new Date(), lastError: null } });
        await tx.dialogScanState.updateMany({ where: { agencyId: req.auth.agencyId, creatorId: req.params.creatorId, activeRunId: { in: runs.map((run) => run.id) } }, data: { status: "IDLE", activeRunId: null, activeJobId: null, lastError: null } });
      }
    });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "dialog_intelligence.scan_canceled", targetType: "creator", targetId: req.params.creatorId, metadata: { runs: runs.length, reason } });
    return res.json({ ok: true, canceled: runs.length, runIds: runs.map((run) => run.id) });
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
    });
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
