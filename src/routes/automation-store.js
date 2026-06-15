"use strict";

const express = require("express");
const prisma = require("../prisma");
const { cleanString, optionalString, jsonArray, jsonObject, centsFromAny, parseLimit, parseOffset, positiveInt, requireCreator, sendError } = require("../services/server-store-utils");
const { isSeniorAgencyMember } = require("../middleware/team-permissions");

const automationServer = require("../services/automation-server-service");

const router = express.Router();

async function requireSeniorAutomationWriter(req, res, next) {
  try {
    const agencyId = req.auth?.agencyId;
    const userId = req.auth?.userId || req.user?.id;
    if (!agencyId || !userId) {
      return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Authentication required" });
    }

    const member = await prisma.agencyMember.findFirst({
      where: { agencyId, userId, deletedAt: null, agency: { deletedAt: null } },
      select: { id: true, role: true, roleKey: true },
    });

    if (!member) {
      return res.status(403).json({ ok: false, code: "NOT_A_MEMBER", error: "You are not a member of this agency" });
    }

    if (!isSeniorAgencyMember(member)) {
      return res.status(403).json({
        ok: false,
        code: "INSUFFICIENT_TEAM_ROLE",
        error: "Only OWNER / MANAGER / ADMIN can modify automation",
      });
    }

    req.agencyMember = member;
    next();
  } catch (err) {
    next(err);
  }
}


// ─── Automation server core v1: generic tasks/jobs/events ────────────────
router.get("/tasks", async (req, res) => { try { return res.json(await automationServer.listTasks({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_TASKS_FAILED"); } });
router.post("/tasks", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.upsertTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_UPSERT_FAILED"); } });
router.patch("/tasks/:id", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.patchTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id, patch: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_PATCH_FAILED"); } });
router.post("/tasks/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.trashTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_TRASH_FAILED"); } });
router.post("/tasks/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.restoreTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_RESTORE_FAILED"); } });
router.delete("/tasks/:id", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.trashTask({ agencyId: req.auth.agencyId, userId: req.auth.userId, taskId: req.params.id, permanent: req.query?.permanent === "1" || req.query?.permanent === "true" })); } catch (err) { return sendError(res, err, "AUTOMATION_TASK_DELETE_FAILED"); } });

// Bump template compatibility layer. These routes expose bump_online tasks in
// the same shape expected by the Electron Automation UI/cache.
router.get("/bumps", async (req, res) => { try { const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100); return res.json(await automationServer.listBumps({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMPS_FAILED"); } });
router.get("/bumps/:accountId", async (req, res) => { try { return res.json(await automationServer.listBumps({ agencyId: req.auth.agencyId, creatorId: cleanString(req.params.accountId, 100), query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMPS_FAILED"); } });
router.post("/bumps/upsert", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.body?.creatorId, 100); return res.json(await automationServer.saveBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_SAVE_FAILED"); } });
router.post("/bumps/:accountId/upsert", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.saveBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId: cleanString(req.params.accountId, 100), input: { ...(req.body || {}), accountId: req.params.accountId } })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_SAVE_FAILED"); } });
router.patch("/bumps/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.body?.creatorId || req.query?.accountId, 100); return res.json(await automationServer.saveBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: { ...(req.body || {}), id: req.params.id, accountId } })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_PATCH_FAILED"); } });
router.post("/bumps/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, bumpId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_TRASH_FAILED"); } });
router.post("/bumps/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, bumpId: req.params.id, restore: true })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_RESTORE_FAILED"); } });
router.delete("/bumps/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashBump({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, bumpId: req.params.id, permanent: true })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMP_DELETE_FAILED"); } });

router.get("/jobs", async (req, res) => { try { return res.json(await automationServer.listJobs({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOBS_FAILED"); } });
router.post("/jobs/enqueue", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.enqueueJob({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_ENQUEUE_FAILED"); } });
router.post("/jobs/cancel", requireSeniorAutomationWriter, async (req, res) => { try { return res.json(await automationServer.cancelJobs({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_CANCEL_FAILED"); } });
router.post("/jobs/claim", async (req, res) => { try { return res.json(await automationServer.claimJobs({ agencyId: req.auth.agencyId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_CLAIM_FAILED"); } });
router.get("/jobs/:id", async (req, res) => { try { return res.json(await automationServer.getJob({ agencyId: req.auth.agencyId, jobId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_GET_FAILED"); } });
router.post("/jobs/:id/result", async (req, res) => { try { return res.json(await automationServer.completeJob({ agencyId: req.auth.agencyId, jobId: req.params.id, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_JOB_RESULT_FAILED"); } });

router.get("/events", async (req, res) => { try { return res.json(await automationServer.listEvents({ agencyId: req.auth.agencyId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_EVENTS_FAILED"); } });
router.post("/events", async (req, res) => { try { return res.json(await automationServer.logEvent({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_EVENT_LOG_FAILED"); } });

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Legacy server-state mutating routes are intentionally senior-only in v19.5.
// Worker job protocol remains open through /jobs/claim, /jobs/:id/result and /events.

router.get("/deliveries", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    const fanId = cleanString(req.query.fanId, 80);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    if (fanId) where.fanId = fanId;
    const take = parseLimit(req.query.limit, 100, 500);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.automationDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.automationDelivery.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERIES_FAILED"); }
});

router.post("/deliveries/upsert", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    // Electron присылает свой локальный id вида "bd_...", который НЕ является
    // серверным cuid. Доверяем id только если это похоже на серверный ключ
    // (cuid: начинается с 'c', без префикса 'bd_'/'local'/'tmp'). Иначе игнорируем,
    // чтобы дедуп ушёл в ветку по messageId, а не делал create по несуществующему id.
    const rawId = cleanString(req.body?.id, 100);
    const id = rawId && !/^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : "";
    const data = {
      agencyId: req.auth.agencyId,
      creatorId,
      ruleId: optionalString(req.body?.ruleId, 100),
      contentCollectionId: optionalString(req.body?.contentCollectionId, 100),
      fanId,
      dialogId: optionalString(req.body?.dialogId, 80),
      trigger: optionalString(req.body?.trigger, 80),
      status: cleanString(req.body?.status || "scheduled", 40) || "scheduled",
      scheduledAt: parseDate(req.body?.scheduledAt),
      sentAt: parseDate(req.body?.sentAt),
      messageId: optionalString(req.body?.messageId, 100),
      priceCents: centsFromAny(req.body || {}, "priceCents", "price"),
      media: jsonArray(req.body?.media),
      result: jsonObject(req.body?.result),
      error: optionalString(req.body?.error, 2000),
      createdByUserId: req.auth.userId,
    };
    // Dedup logic:
    // 1) explicit server id -> upsert by primary key
    // 2) else if messageId present -> find existing row for this creator+messageId and update it
    //    (prevents the sweep from inserting a fresh clone on every tick)
    // 3) else -> create (drafts / no message yet)
    const updateData = { ...data, agencyId: undefined, creatorId: undefined, fanId: undefined };
    let item;
    if (id) {
      item = await prisma.automationDelivery.upsert({ where: { id }, create: data, update: updateData });
    } else if (data.messageId) {
      const existing = await prisma.automationDelivery.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId, messageId: data.messageId },
        select: { id: true },
      });
      item = existing
        ? await prisma.automationDelivery.update({ where: { id: existing.id }, data: updateData })
        : await prisma.automationDelivery.create({ data });
    } else {
      item = await prisma.automationDelivery.create({ data });
    }
    return res.json({ ok: true, item, _dedup: "v2-messageId" });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_UPSERT_FAILED"); }
});

router.get("/hidden-online", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.hiddenOnlineUser.findMany({ where, orderBy: [{ lastSignalAt: "desc" }, { updatedAt: "desc" }], take, skip }),
      prisma.hiddenOnlineUser.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_FAILED"); }
});

router.post("/hidden-online/upsert", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await prisma.hiddenOnlineUser.upsert({
      where: { creatorId_fanId: { creatorId, fanId } },
      create: {
        agencyId: req.auth.agencyId, creatorId, fanId,
        dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180),
        totalSpentCents: Number(req.body?.totalSpentCents || 0) || 0,
        status: cleanString(req.body?.status || "active", 40) || "active",
        signals: jsonArray(req.body?.signals), metadata: jsonObject(req.body?.metadata),
        lastSignalAt: parseDate(req.body?.lastSignalAt) || new Date(),
      },
      update: {
        dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180),
        totalSpentCents: req.body?.totalSpentCents === undefined ? undefined : Number(req.body.totalSpentCents || 0) || 0,
        status: req.body?.status === undefined ? undefined : cleanString(req.body.status, 40) || "active",
        signals: req.body?.signals === undefined ? undefined : jsonArray(req.body.signals),
        metadata: req.body?.metadata === undefined ? undefined : jsonObject(req.body.metadata),
        lastSignalAt: parseDate(req.body?.lastSignalAt) || new Date(),
      },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_UPSERT_FAILED"); }
});


router.post("/hidden-online/clear", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const result = await prisma.hiddenOnlineUser.deleteMany({ where: { agencyId: req.auth.agencyId, creatorId } });
    return res.json({ ok: true, creatorId, deleted: result.count, items: [], signals: [] });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_CLEAR_FAILED"); }
});

router.post("/hidden-online/:fanId/status", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    const fanId = cleanString(req.params.fanId || req.body?.fanId || req.body?.userId, 80);
    const status = cleanString(req.body?.status || req.query?.status || "active", 40) || "active";
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const existing = await prisma.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId, fanId } } });
    if (!existing) return res.status(404).json({ ok: false, code: "HIDDEN_ONLINE_USER_NOT_FOUND", error: "Hidden online user not found" });
    const item = await prisma.hiddenOnlineUser.update({
      where: { id: existing.id },
      data: { status, metadata: { ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}), statusUpdatedAt: new Date().toISOString() } },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_STATUS_FAILED"); }
});


const FOLLOW_BACK_TERMINAL_STATUSES = new Set(["followed", "waiting_return", "final_unfollowed", "done", "completed"]);

function followBackTerminalStatus(status) {
  return FOLLOW_BACK_TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

function followBackStatus(value, fallback = "pending") {
  const s = cleanString(value || fallback, 40).toLowerCase() || fallback;
  return s;
}

function compactWorkerResult(input = {}) {
  const result = input.result && typeof input.result === "object" && !Array.isArray(input.result) ? input.result : {};
  return jsonObject({
    ...result,
    reason: input.reason || result.reason || null,
    skipReason: input.skipReason || result.skipReason || null,
    failReason: input.failReason || result.failReason || null,
    actionReason: input.actionReason || result.actionReason || null,
    decisionReason: input.decisionReason || result.decisionReason || null,
    rawStatus: input.status || result.rawStatus || null,
    claimedByDeviceId: result.claimedByDeviceId || input.claimedByDeviceId || input.deviceId || null,
    claimedAt: result.claimedAt || input.claimedAt || null,
    leaseUntil: result.leaseUntil || input.leaseUntil || null,
    claimTimeoutSec: result.claimTimeoutSec || input.claimTimeoutSec || null,
    refollowNudgeCount: input.refollowNudgeCount ?? result.refollowNudgeCount ?? null,
    followBackStatus: input.followBackStatus || result.followBackStatus || null,
    refollowStatus: input.refollowStatus || result.refollowStatus || null,
    waitReturnUntil: input.waitReturnUntil || result.waitReturnUntil || null,
    lastSuccessAt: input.lastSuccessAt || result.lastSuccessAt || null,
    processedAt: input.processedAt || result.processedAt || null,
    skippedAt: input.skippedAt || result.skippedAt || null,
    failedAt: input.failedAt || result.failedAt || null,
    attentionStatus: input.attentionStatus || result.attentionStatus || null,
    attentionLikesTarget: input.attentionLikesTarget ?? result.attentionLikesTarget ?? 0,
    attentionLikesDone: input.attentionLikesDone ?? result.attentionLikesDone ?? 0,
    attentionError: input.attentionError || result.attentionError || null,
    canChat: input.canChat ?? result.canChat ?? null,
    canReceiveChatMessage: input.canReceiveChatMessage ?? result.canReceiveChatMessage ?? null,
    bumpEligible: input.bumpEligible ?? result.bumpEligible ?? null,
    subscriptionState: input.subscriptionState || result.subscriptionState || null,
    subscribedBy: input.subscribedBy ?? result.subscribedBy ?? null,
    subscribedByActive: input.subscribedByActive ?? result.subscribedByActive ?? null,
    subscribedByExpire: input.subscribedByExpire ?? result.subscribedByExpire ?? null,
    subscribedIsExpiredNow: input.subscribedIsExpiredNow ?? result.subscribedIsExpiredNow ?? null,
    subscribedByExpireDate: input.subscribedByExpireDate || result.subscribedByExpireDate || null,
    subscribedOn: input.subscribedOn ?? result.subscribedOn ?? null,
    subscribedOnActive: input.subscribedOnActive ?? result.subscribedOnActive ?? null,
    subscribedOnExpiredNow: input.subscribedOnExpiredNow ?? result.subscribedOnExpiredNow ?? null,
    subscribedOnExpireDate: input.subscribedOnExpireDate || result.subscribedOnExpireDate || null,
  });
}

async function supersedeFollowBackAlternatives({ req, creatorId, fanId, action, status, reason }) {
  const normalizedAction = cleanString(action || "", 80) || "follow_back";
  const normalizedStatus = followBackStatus(status || "pending");
  const realActions = ["follow_back", "refollow_nudge"];
  let actionsToClose = [];
  let closeReason = optionalString(reason, 500) || `superseded_by_${normalizedAction}`;

  if (realActions.includes(normalizedAction) && ["pending", "followed", "waiting_return", "skipped"].includes(normalizedStatus)) {
    actionsToClose = realActions.filter((x) => x !== normalizedAction);
    closeReason = `superseded_by_${normalizedAction}`;
  } else if (normalizedAction === "skip" || normalizedStatus === "skipped") {
    actionsToClose = realActions;
    closeReason = optionalString(reason, 500) || "superseded_by_skip_decision";
  }

  if (!actionsToClose.length) return;
  await prisma.followBackTask.updateMany({
    where: {
      agencyId: req.auth.agencyId,
      creatorId,
      fanId,
      action: { in: actionsToClose },
      status: { in: ["pending", "running"] },
    },
    data: {
      status: "skipped",
      reason: closeReason,
      error: null,
      lastResultAt: new Date(),
      result: jsonObject({ reason: closeReason, supersededByAction: normalizedAction, source: "follow_back_worker_supersede" }),
    },
  }).catch(() => null);
}

async function upsertFollowBackWorkerItem({ req, creatorId, rawItem = {} }) {
  const body = rawItem && typeof rawItem === "object" ? rawItem : {};
  const fanId = cleanString(body.fanId || body.userId || body.id, 80);
  if (!fanId) return null;
  const action = cleanString(body.action || "follow_back", 80) || "follow_back";
  const incomingStatus = followBackStatus(body.status || "pending");
  const existing = await prisma.followBackTask.findUnique({ where: { creatorId_fanId_action: { creatorId, fanId, action } } });
  const status = existing && followBackTerminalStatus(existing.status) && incomingStatus === "pending" ? existing.status : incomingStatus;
  const reason = optionalString(body.reason || body.skipReason || body.failReason || body.actionReason || body.decisionReason, 500);
  const lastResultAt = parseDate(body.lastResultAt || body.processedAt || body.skippedAt || body.failedAt || body.updatedAt);
  const result = compactWorkerResult(body);
  const item = await prisma.followBackTask.upsert({
    where: { creatorId_fanId_action: { creatorId, fanId, action } },
    create: {
      agencyId: req.auth.agencyId,
      creatorId,
      fanId,
      action,
      dialogId: optionalString(body.dialogId || body.fanId, 80),
      username: optionalString(body.username, 120),
      name: optionalString(body.name, 180),
      status,
      reason,
      result,
      error: optionalString(body.error || body.failReason, 2000),
      lastResultAt,
      createdByUserId: req.auth.userId,
    },
    update: {
      dialogId: body.dialogId === undefined ? undefined : optionalString(body.dialogId, 80),
      username: body.username === undefined ? undefined : optionalString(body.username, 120),
      name: body.name === undefined ? undefined : optionalString(body.name, 180),
      status,
      reason: reason === null ? undefined : reason,
      result,
      error: body.error === undefined && body.failReason === undefined ? undefined : optionalString(body.error || body.failReason, 2000),
      lastResultAt: lastResultAt || undefined,
    },
  });
  await supersedeFollowBackAlternatives({ req, creatorId, fanId, action, status, reason });
  return item;
}

function isFollowBackClaimExpired(item, now = Date.now()) {
  const result = item?.result && typeof item.result === "object" ? item.result : {};
  const leaseUntil = result.leaseUntil ? new Date(result.leaseUntil).getTime() : 0;
  if (Number.isFinite(leaseUntil) && leaseUntil > 0) return leaseUntil <= now;
  const updatedAt = item?.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt > 10 * 60 * 1000;
}

function followBackClaimMeta(existingResult = {}, body = {}, deviceId = "unknown") {
  const now = new Date();
  const timeoutSec = Math.max(60, Math.min(86400, positiveInt(body.claimTimeoutSec, 600)));
  return jsonObject({
    ...(existingResult && typeof existingResult === "object" ? existingResult : {}),
    claimedByDeviceId: deviceId,
    claimedAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + timeoutSec * 1000).toISOString(),
    claimTimeoutSec: timeoutSec,
    claimSource: "follow_back_worker_claim",
  });
}

router.get("/follow-back", async (req, res) => {
  try {
    const where = { agencyId: req.auth.agencyId };
    const creatorId = cleanString(req.query.creatorId, 100);
    const status = cleanString(req.query.status, 40);
    if (creatorId) where.creatorId = creatorId;
    if (status) where.status = status;
    const take = parseLimit(req.query.limit, 200, 1000);
    const skip = parseOffset(req.query.offset);
    const [items, count] = await Promise.all([
      prisma.followBackTask.findMany({ where, orderBy: { queuedAt: "desc" }, take, skip }),
      prisma.followBackTask.count({ where }),
    ]);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_FAILED"); }
});

router.post("/follow-back/upsert", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    const action = cleanString(req.body?.action || "follow_back", 80) || "follow_back";
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await prisma.followBackTask.upsert({
      where: { creatorId_fanId_action: { creatorId, fanId, action } },
      create: { agencyId: req.auth.agencyId, creatorId, fanId, action, dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180), status: cleanString(req.body?.status || "pending", 40) || "pending", reason: optionalString(req.body?.reason, 500), result: jsonObject(req.body?.result), error: optionalString(req.body?.error, 2000), lastResultAt: parseDate(req.body?.lastResultAt), createdByUserId: req.auth.userId },
      update: { dialogId: optionalString(req.body?.dialogId, 80), username: optionalString(req.body?.username, 120), name: optionalString(req.body?.name, 180), status: req.body?.status === undefined ? undefined : cleanString(req.body.status, 40) || "pending", reason: req.body?.reason === undefined ? undefined : optionalString(req.body.reason, 500), result: req.body?.result === undefined ? undefined : jsonObject(req.body.result), error: req.body?.error === undefined ? undefined : optionalString(req.body.error, 2000), lastResultAt: req.body?.lastResultAt ? parseDate(req.body.lastResultAt) : undefined },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_UPSERT_FAILED"); }
});



// Worker protocol: opened for authenticated Electron workers. Definition/destructive
// writes stay senior-only, but workers must be able to mirror scan decisions,
// claim one fan atomically, release claims on Stop, and report OF results.
router.post("/follow-back/worker/upsert-bulk", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const written = [];
    for (const raw of items.slice(0, 1000)) {
      const item = await upsertFollowBackWorkerItem({ req, creatorId, rawItem: raw });
      if (item) written.push(item);
    }
    return res.json({ ok: true, creatorId, count: written.length, items: written });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_UPSERT_FAILED"); }
});

router.post("/follow-back/worker/claim", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
    const limit = parseLimit(req.body?.limit, 1, 10);
    await requireCreator(prisma, req.auth.agencyId, creatorId);

    const nowMs = Date.now();
    const staleBefore = new Date(nowMs - Math.max(60, Math.min(86400, positiveInt(req.body?.claimTimeoutSec, 600))) * 1000);

    await prisma.$executeRaw`
      UPDATE "FollowBackTask"
      SET "status" = 'pending', "error" = 'claim expired; returned to queue', "lastResultAt" = NOW()
      WHERE "agencyId" = ${req.auth.agencyId}
        AND "creatorId" = ${creatorId}
        AND "status" = 'running'
        AND (
          ("result"->>'leaseUntil')::timestamptz < NOW()
          OR (("result"->>'leaseUntil') IS NULL AND "updatedAt" < ${staleBefore})
        )
    `.catch(() => null);

    const candidates = await prisma.followBackTask.findMany({
      where: {
        agencyId: req.auth.agencyId,
        creatorId,
        status: { in: ["pending", "running"] },
        action: { in: ["follow_back", "refollow_nudge"] },
      },
      orderBy: [{ queuedAt: "asc" }, { updatedAt: "asc" }],
      take: Math.max(10, limit * 8),
    });

    const items = [];
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      const meta = candidate.result && typeof candidate.result === "object" ? candidate.result : {};
      const sameDevice = String(meta.claimedByDeviceId || "") === deviceId;
      if (candidate.status === "running" && !sameDevice) continue;

      const result = followBackClaimMeta(meta, req.body || {}, deviceId);
      const where = candidate.status === "pending"
        ? { id: candidate.id, agencyId: req.auth.agencyId, creatorId, status: "pending" }
        : { id: candidate.id, agencyId: req.auth.agencyId, creatorId, status: "running" };
      const updated = await prisma.followBackTask.updateMany({
        where,
        data: { status: "running", result, error: null, lastResultAt: new Date() },
      });
      if (updated.count > 0) {
        const item = await prisma.followBackTask.findUnique({ where: { id: candidate.id } });
        if (item) items.push(item);
      }
    }

    return res.json({ ok: true, creatorId, deviceId, items, count: items.length });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_CLAIM_FAILED"); }
});

router.post("/follow-back/worker/release", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "", 120);
    const reason = optionalString(req.body?.reason || "manual_stop", 500) || "manual_stop";
    await requireCreator(prisma, req.auth.agencyId, creatorId);

    const where = { agencyId: req.auth.agencyId, creatorId, status: "running" };
    const running = await prisma.followBackTask.findMany({ where, take: 500 });
    const releaseIds = running
      .filter((item) => {
        if (!deviceId) return true;
        const result = item.result && typeof item.result === "object" ? item.result : {};
        return String(result.claimedByDeviceId || "") === deviceId;
      })
      .map((item) => item.id);

    if (!releaseIds.length) return res.json({ ok: true, creatorId, released: 0, items: [] });
    await prisma.followBackTask.updateMany({
      where: { agencyId: req.auth.agencyId, creatorId, id: { in: releaseIds }, status: "running" },
      data: { status: "pending", error: reason, lastResultAt: new Date() },
    });
    const items = await prisma.followBackTask.findMany({ where: { agencyId: req.auth.agencyId, creatorId, id: { in: releaseIds } } });
    return res.json({ ok: true, creatorId, released: items.length, items });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_RELEASE_FAILED"); }
});

router.post("/follow-back/worker/result", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.userId, 80);
    const action = cleanString(req.body?.action || "follow_back", 80) || "follow_back";
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });

    const existing = await prisma.followBackTask.findUnique({ where: { creatorId_fanId_action: { creatorId, fanId, action } } });
    if (!existing) return res.status(404).json({ ok: false, code: "FOLLOW_BACK_TASK_NOT_FOUND", error: "Follow-back task not found" });

    const status = followBackStatus(req.body?.status || (req.body?.ok === false ? "failed" : "done"), "done");
    const result = compactWorkerResult({ ...(req.body || {}), result: { ...(existing.result && typeof existing.result === "object" ? existing.result : {}), ...(req.body?.result || {}) } });
    const reason = optionalString(req.body?.reason || req.body?.skipReason || req.body?.failReason || existing.reason, 500);
    const item = await prisma.followBackTask.update({
      where: { id: existing.id },
      data: {
        status,
        reason,
        result,
        error: optionalString(req.body?.error || req.body?.failReason, 2000),
        lastResultAt: parseDate(req.body?.lastResultAt || req.body?.processedAt || req.body?.skippedAt || req.body?.failedAt) || new Date(),
      },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_WORKER_RESULT_FAILED"); }
});

router.post("/follow-back/clear", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const result = await prisma.followBackTask.deleteMany({ where: { agencyId: req.auth.agencyId, creatorId } });
    return res.json({ ok: true, creatorId, deleted: result.count, items: [] });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_CLEAR_FAILED"); }
});

// ─── Bump reply-rate aggregate ────────────────────────────────────────────────
// Атомарный счётчик по (creatorId, templateId, day). Клиент шлёт по одному событию
// на каждый переход бампа: sent при отправке, replied/canceled/expired/failed в финале.
// Дубль-вызовы безопасны на уровне суммы только если клиент гарантирует один вызов
// на переход (он гарантирует через флаг statCounted в локальной записи).
const STAT_EVENTS = new Set(["sent", "replied", "canceled", "expired", "failed"]);

router.post("/deliveries/stat-bump", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const event = cleanString(req.body?.event, 40);
    if (!STAT_EVENTS.has(event)) {
      return res.status(400).json({ ok: false, code: "BAD_EVENT", error: "event must be one of: " + Array.from(STAT_EVENTS).join(", ") });
    }
    const templateId = cleanString(req.body?.templateId, 100) || "";
    // day: YYYY-MM-DD (UTC). Берём из тела если прислали, иначе серверный сегодняшний.
    const day = cleanString(req.body?.day, 10) || new Date().toISOString().slice(0, 10);
    const by = Math.max(1, Math.min(1000, positiveInt(req.body?.by, 1)));

    const item = await prisma.bumpDeliveryStat.upsert({
      where: { creatorId_templateId_day: { creatorId, templateId, day } },
      create: {
        agencyId: req.auth.agencyId, creatorId, templateId, day,
        sent: event === "sent" ? by : 0,
        replied: event === "replied" ? by : 0,
        canceled: event === "canceled" ? by : 0,
        expired: event === "expired" ? by : 0,
        failed: event === "failed" ? by : 0,
      },
      update: { [event]: { increment: by } },
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "BUMP_STAT_FAILED"); }
});

router.get("/deliveries/bump-stats", async (req, res) => {
  try {
    const creatorId = cleanString(req.query?.creatorId, 100);
    const fromDay = cleanString(req.query?.from, 10);
    const toDay = cleanString(req.query?.to, 10);

    const where = { agencyId: req.auth.agencyId };
    if (creatorId) where.creatorId = creatorId;
    if (fromDay || toDay) {
      where.day = {};
      if (fromDay) where.day.gte = fromDay;
      if (toDay) where.day.lte = toDay;
    }

    const rows = await prisma.bumpDeliveryStat.findMany({ where, orderBy: { day: "desc" }, take: parseLimit(req.query?.limit, 500, 5000) });

    // Сводки: всего и по шаблону.
    const totals = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0 };
    const byTemplate = {};
    for (const r of rows) {
      for (const k of ["sent", "replied", "canceled", "expired", "failed"]) totals[k] += r[k] || 0;
      const t = r.templateId || "";
      if (!byTemplate[t]) byTemplate[t] = { templateId: t, sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0 };
      for (const k of ["sent", "replied", "canceled", "expired", "failed"]) byTemplate[t][k] += r[k] || 0;
    }
    const rate = (rep, sent) => (sent > 0 ? Math.round((rep / sent) * 10000) / 100 : 0);
    totals.replyRate = rate(totals.replied, totals.sent);
    const perTemplate = Object.values(byTemplate).map((t) => ({ ...t, replyRate: rate(t.replied, t.sent) }))
      .sort((a, b) => b.replyRate - a.replyRate);

    return res.json({ ok: true, totals, perTemplate, days: rows });
  } catch (err) { return sendError(res, err, "BUMP_STATS_READ_FAILED"); }
});

module.exports = router;
