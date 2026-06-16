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
router.post("/bumps/gc", async (req, res) => { try { const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100); return res.json(await automationServer.gcExpiredBumps({ agencyId: req.auth.agencyId, creatorId })); } catch (err) { return sendError(res, err, "AUTOMATION_BUMPS_GC_FAILED"); } });
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

const BUMP_TERMINAL_DELIVERY_STATUSES = new Set(["replied", "canceled", "expired", "failed", "skipped"]);

function bumpStatStatus(status) {
  const s = cleanString(status, 40).toLowerCase();
  if (s === "cancelled") return "canceled";
  return s;
}

async function refreshBumpTaskStats({ agencyId, creatorId, templateId }) {
  const cid = cleanString(creatorId, 100);
  const tid = cleanString(templateId, 100);
  if (!agencyId || !cid || !tid) return null;
  const rows = await prisma.bumpDeliveryStat.findMany({
    where: { agencyId, creatorId: cid, templateId: tid },
    select: { sent: true, replied: true, canceled: true, expired: true, failed: true, day: true },
  }).catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  const stats = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0, lastStatAt: new Date().toISOString() };
  for (const row of rows || []) {
    const sent = Number(row.sent || 0);
    const replied = Number(row.replied || 0);
    stats.sent += sent;
    stats.replied += replied;
    stats.canceled += Number(row.canceled || 0);
    stats.expired += Number(row.expired || 0);
    stats.failed += Number(row.failed || 0);
    if (row.day === today) {
      stats.sentToday += sent;
      stats.repliedToday += replied;
    }
  }
  stats.replyRate = stats.sent > 0 ? Math.round((stats.replied / stats.sent) * 10000) / 10000 : 0;
  const task = await prisma.automationTask.findFirst({
    where: { agencyId, creatorId: cid, type: "bump_online", OR: [{ id: tid }, { clientId: tid }] },
    select: { id: true, stats: true },
  }).catch(() => null);
  if (!task?.id) return stats;
  const prev = task.stats && typeof task.stats === "object" && !Array.isArray(task.stats) ? task.stats : {};
  await prisma.automationTask.update({ where: { id: task.id }, data: { stats: { ...prev, ...stats } } }).catch(() => null);
  return stats;
}


function deliveryMeta(item = {}) {
  const result = item?.result && typeof item.result === "object" && !Array.isArray(item.result) ? item.result : {};
  return result;
}

function deliveryTemplateId(item = {}) {
  const meta = deliveryMeta(item);
  return cleanString(item.contentCollectionId || item.templateId || item.bumpId || meta.templateId || meta.bumpId || meta.clientId, 100) || "";
}

function deliveryCancelAt(item = {}) {
  const meta = deliveryMeta(item);
  return item.cancelAt || meta.cancelAt || null;
}

function mapAutomationDelivery(item = {}) {
  if (!item || typeof item !== "object") return item;
  const meta = deliveryMeta(item);
  const templateId = deliveryTemplateId(item);
  return {
    ...item,
    templateId,
    bumpId: templateId,
    localDeliveryId: meta.localDeliveryId || meta.localId || null,
    cancelAt: item.cancelAt || meta.cancelAt || null,
    claimUntil: item.claimUntil || meta.claimUntil || null,
    claimedByDeviceId: item.claimedByDeviceId || meta.claimedByDeviceId || null,
    claimedAt: item.claimedAt || meta.claimedAt || null,
  };
}

function compactTemplateIds(values = [], next = null, max = 50) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const id = cleanString(value, 100);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  push(next);
  for (const value of Array.isArray(values) ? values : []) push(value);
  return out.slice(0, Math.max(1, Math.min(200, Number(max) || 50)));
}

function mapBumpFanState(row = {}) {
  if (!row || typeof row !== "object") return null;
  return {
    id: row.id,
    creatorId: row.creatorId,
    fanId: row.fanId,
    dialogId: row.dialogId || row.fanId,
    lastTemplateId: row.lastTemplateId || null,
    lastStatus: row.lastStatus || null,
    lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    lastFinalizedAt: row.lastFinalizedAt ? row.lastFinalizedAt.toISOString() : null,
    lastMessageId: row.lastMessageId || null,
    templateIds: Array.isArray(row.templateIds) ? row.templateIds : [],
    counters: row.counters && typeof row.counters === "object" && !Array.isArray(row.counters) ? row.counters : {},
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

async function upsertBumpFanState({ agencyId, creatorId, fanId, dialogId = null, templateId = "", status = "sent", sentAt = null, finalizedAt = null, messageId = null }) {
  const cid = cleanString(creatorId, 100);
  const fid = cleanString(fanId, 80);
  if (!agencyId || !cid || !fid) return null;
  const tid = cleanString(templateId, 100) || "";
  const existing = await prisma.automationBumpFanState.findUnique({
    where: { creatorId_fanId: { creatorId: cid, fanId: fid } },
  }).catch(() => null);
  const templateIds = compactTemplateIds(existing?.templateIds || [], tid, 50);
  const lastSentAt = parseDate(sentAt) || existing?.lastSentAt || null;
  const lastFinalizedAt = parseDate(finalizedAt) || existing?.lastFinalizedAt || null;
  const counters = existing?.counters && typeof existing.counters === "object" && !Array.isArray(existing.counters) ? existing.counters : {};
  const data = {
    agencyId,
    creatorId: cid,
    fanId: fid,
    dialogId: optionalString(dialogId || fid, 80),
    lastTemplateId: tid || existing?.lastTemplateId || null,
    lastStatus: cleanString(status, 40) || existing?.lastStatus || "sent",
    lastSentAt,
    lastFinalizedAt,
    lastMessageId: optionalString(messageId || existing?.lastMessageId, 100),
    templateIds,
    counters,
  };
  const row = await prisma.automationBumpFanState.upsert({
    where: { creatorId_fanId: { creatorId: cid, fanId: fid } },
    create: data,
    update: { ...data, agencyId: undefined, creatorId: undefined, fanId: undefined },
  });
  return mapBumpFanState(row);
}

const STAT_EVENTS = new Set(["sent", "replied", "canceled", "expired", "failed"]);

async function incrementBumpDeliveryStat({ agencyId, creatorId, templateId = "", day = null, event, by = 1 }) {
  const ev = bumpStatStatus(event);
  if (!STAT_EVENTS.has(ev)) {
    const err = new Error("Bad bump stat event");
    err.status = 400;
    err.code = "BAD_EVENT";
    throw err;
  }
  const cid = cleanString(creatorId, 100);
  const tid = cleanString(templateId, 100) || "";
  const statDay = cleanString(day, 10) || new Date().toISOString().slice(0, 10);
  const incBy = Math.max(1, Math.min(1000, positiveInt(by, 1)));

  const item = await prisma.bumpDeliveryStat.upsert({
    where: { creatorId_templateId_day: { creatorId: cid, templateId: tid, day: statDay } },
    create: {
      agencyId, creatorId: cid, templateId: tid, day: statDay,
      sent: ev === "sent" ? incBy : 0,
      replied: ev === "replied" ? incBy : 0,
      canceled: ev === "canceled" ? incBy : 0,
      expired: ev === "expired" ? incBy : 0,
      failed: ev === "failed" ? incBy : 0,
    },
    update: { [ev]: { increment: incBy } },
  });
  const taskStats = await refreshBumpTaskStats({ agencyId, creatorId: cid, templateId: tid });
  return { item, taskStats };
}

async function findAutomationDeliveryForResult({ agencyId, creatorId, input = {} }) {
  const id = cleanString(input.id || input.deliveryId || input.serverDeliveryId, 120);
  const messageId = cleanString(input.messageId, 100);
  if (id && !/^(bd_|local|tmp|temp)/i.test(id)) {
    const byId = await prisma.automationDelivery.findFirst({ where: { id, agencyId, creatorId } });
    if (byId) return byId;
  }
  if (messageId) {
    return prisma.automationDelivery.findFirst({ where: { agencyId, creatorId, messageId } });
  }
  return null;
}

// Legacy server-state mutating routes are intentionally senior-only in v19.5.
// Worker job protocol remains open through /jobs/claim, /jobs/:id/result and /events.

router.get("/deliveries/fan-state", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    const fanId = cleanString(req.query.fanId || req.query.dialogId, 80);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await prisma.automationBumpFanState.findUnique({ where: { creatorId_fanId: { creatorId, fanId } } });
    return res.json({ ok: true, item: mapBumpFanState(item), fanId, creatorId });
  } catch (err) { return sendError(res, err, "BUMP_FAN_STATE_FAILED"); }
});

router.post("/deliveries/fan-state/upsert", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId, 100);
    const fanId = cleanString(req.body?.fanId || req.body?.dialogId, 80);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    if (!fanId) return res.status(400).json({ ok: false, code: "FAN_ID_MISSING", error: "fanId is required" });
    const item = await upsertBumpFanState({
      agencyId: req.auth.agencyId,
      creatorId,
      fanId,
      dialogId: req.body?.dialogId || fanId,
      templateId: req.body?.templateId || req.body?.bumpId || req.body?.contentCollectionId || "",
      status: req.body?.status || "sent",
      sentAt: req.body?.sentAt || null,
      finalizedAt: req.body?.finalizedAt || req.body?.repliedAt || req.body?.canceledAt || req.body?.failedAt || null,
      messageId: req.body?.messageId || null,
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "BUMP_FAN_STATE_UPSERT_FAILED"); }
});

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
    const [rows, count] = await Promise.all([
      prisma.automationDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
      prisma.automationDelivery.count({ where }),
    ]);
    const items = (rows || []).map(mapAutomationDelivery);
    return res.json({ ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERIES_FAILED"); }
});

router.post("/deliveries/upsert", async (req, res) => {
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
    const templateId = optionalString(req.body?.contentCollectionId || req.body?.templateId || req.body?.bumpId, 100);
    const incomingResult = req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {};
    const resultMeta = jsonObject({
      ...incomingResult,
      localDeliveryId: rawId && /^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : (incomingResult.localDeliveryId || incomingResult.localId || null),
      templateId: templateId || incomingResult.templateId || incomingResult.bumpId || null,
      bumpId: templateId || incomingResult.bumpId || incomingResult.templateId || null,
      queueId: req.body?.queueId ?? incomingResult.queueId ?? null,
      cancelAt: req.body?.cancelAt || incomingResult.cancelAt || null,
      cancelAfterHours: req.body?.cancelAfterHours ?? incomingResult.cancelAfterHours ?? null,
      statCounted: req.body?.statCounted || incomingResult.statCounted || null,
    });
    const data = {
      agencyId: req.auth.agencyId,
      creatorId,
      ruleId: optionalString(req.body?.ruleId, 100),
      contentCollectionId: templateId,
      fanId,
      dialogId: optionalString(req.body?.dialogId, 80),
      trigger: optionalString(req.body?.trigger, 80),
      status: cleanString(req.body?.status || "scheduled", 40) || "scheduled",
      scheduledAt: parseDate(req.body?.scheduledAt),
      sentAt: parseDate(req.body?.sentAt),
      cancelAt: parseDate(req.body?.cancelAt || incomingResult.cancelAt),
      claimedByDeviceId: optionalString(req.body?.claimedByDeviceId || incomingResult.claimedByDeviceId, 120),
      claimedAt: parseDate(req.body?.claimedAt || incomingResult.claimedAt),
      claimUntil: parseDate(req.body?.claimUntil || incomingResult.claimUntil),
      lastCheckedAt: parseDate(req.body?.lastCheckedAt || incomingResult.lastCheckedAt),
      attempts: req.body?.attempts === undefined ? undefined : positiveInt(req.body.attempts, 0),
      maxAttempts: req.body?.maxAttempts === undefined ? undefined : Math.max(1, Math.min(50, positiveInt(req.body.maxAttempts, 5))),
      messageId: optionalString(req.body?.messageId, 100),
      priceCents: centsFromAny(req.body || {}, "priceCents", "price"),
      media: jsonArray(req.body?.media),
      result: resultMeta,
      error: optionalString(req.body?.error, 2000),
      createdByUserId: req.auth.userId,
    };
    // Dedup logic:
    // 1) explicit server id -> upsert by primary key
    // 2) else if messageId present -> find existing row for this creator+messageId and update it
    //    (prevents the sweep from inserting a fresh clone on every tick)
    // 3) else -> create (drafts / no message yet)
    const updateData = { ...data, agencyId: undefined, creatorId: undefined, fanId: undefined, createdByUserId: undefined };
    for (const key of ["attempts", "maxAttempts"]) {
      if (updateData[key] === undefined) delete updateData[key];
    }
    const terminalStatus = bumpStatStatus(data.status);
    if (BUMP_TERMINAL_DELIVERY_STATUSES.has(terminalStatus)) {
      const existing = id
        ? await prisma.automationDelivery.findFirst({ where: { id, agencyId: req.auth.agencyId, creatorId } })
        : data.messageId
          ? await prisma.automationDelivery.findFirst({ where: { agencyId: req.auth.agencyId, creatorId, messageId: data.messageId } })
          : null;
      if (!existing?.id) {
        return res.json({ ok: true, item: null, alreadyCompacted: true, compacted: true, status: terminalStatus, _dedup: "v4-terminal-already-compacted" });
      }
      const updated = await prisma.automationDelivery.update({ where: { id: existing.id }, data: updateData });
      const templateIdForStat = cleanString(req.body?.templateId || req.body?.bumpId || deliveryTemplateId(updated) || data.contentCollectionId, 100) || "";
      await upsertBumpFanState({
        agencyId: req.auth.agencyId, creatorId, fanId: updated.fanId, dialogId: updated.dialogId || updated.fanId,
        templateId: templateIdForStat, status: terminalStatus, sentAt: updated.sentAt,
        finalizedAt: req.body?.repliedAt || req.body?.canceledAt || req.body?.failedAt || new Date().toISOString(),
        messageId: updated.messageId,
      }).catch(() => null);
      const day = cleanString(req.body?.day, 10) || (updated.sentAt ? updated.sentAt.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
      const stat = await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId: templateIdForStat, day, event: terminalStatus, by: 1 });
      await prisma.automationDelivery.delete({ where: { id: existing.id } }).catch(() => null);
      return res.json({ ok: true, item: null, compacted: true, status: terminalStatus, stat, _dedup: "v4-terminal-server-counted" });
    }

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

    await upsertBumpFanState({
      agencyId: req.auth.agencyId, creatorId, fanId: item.fanId, dialogId: item.dialogId || item.fanId,
      templateId: deliveryTemplateId(item), status: item.status || "sent", sentAt: item.sentAt, messageId: item.messageId,
    }).catch(() => null);
    return res.json({ ok: true, item: mapAutomationDelivery(item), _dedup: "v5-messageId-pending-claimable-fanstate" });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_UPSERT_FAILED"); }
});


// Distributed bump cancel queue. Active AutomationDelivery rows are the queue:
// pending_reply rows become claimable after cancelAt; a worker gets a short lease,
// verifies reply, deletes the OF message if needed, then reports a terminal result.
router.post("/deliveries/claim-cancel", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
    const limit = parseLimit(req.body?.limit, 20, 100);
    const timeoutSec = Math.max(30, Math.min(3600, positiveInt(req.body?.claimTimeoutSec, 120)));
    const now = new Date();
    const claimUntil = new Date(now.getTime() + timeoutSec * 1000);
    const fallbackReplyTimeoutHours = Math.max(1, Math.min(72, Number(req.body?.fallbackReplyTimeoutHours || 5)));
    const fallbackBefore = new Date(now.getTime() - fallbackReplyTimeoutHours * 60 * 60 * 1000);

    // Dead worker recovery: release expired leases back into pending queue.
    await prisma.automationDelivery.updateMany({
      where: {
        agencyId: req.auth.agencyId,
        creatorId,
        status: "cancel_claimed",
        OR: [{ claimUntil: { lt: now } }, { claimUntil: null, updatedAt: { lt: new Date(now.getTime() - timeoutSec * 1000) } }],
      },
      data: {
        status: "pending_reply",
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        error: "cancel claim expired; returned to queue",
      },
    }).catch(() => null);

    const candidates = await prisma.automationDelivery.findMany({
      where: {
        agencyId: req.auth.agencyId,
        creatorId,
        status: { in: ["pending_reply", "sent", "checking_reply"] },
        OR: [
          { cancelAt: { lte: now } },
          // Rows created before cancelAt migration: safe fallback, same old default timeout.
          { cancelAt: null, sentAt: { lte: fallbackBefore } },
        ],
      },
      orderBy: [{ cancelAt: "asc" }, { sentAt: "asc" }, { createdAt: "asc" }],
      take: Math.max(limit * 6, limit),
    });

    const items = [];
    const skippedMaxAttempts = [];
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      const maxAttempts = Math.max(1, Math.min(50, Number(candidate.maxAttempts || 5)));
      const attempts = Math.max(0, Number(candidate.attempts || 0));
      if (attempts >= maxAttempts) {
        const templateId = deliveryTemplateId(candidate);
        const day = candidate.sentAt ? candidate.sentAt.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId, day, event: "failed", by: 1 }).catch(() => null);
        await prisma.automationDelivery.delete({ where: { id: candidate.id } }).catch(() => null);
        skippedMaxAttempts.push(candidate.id);
        continue;
      }
      const updated = await prisma.automationDelivery.updateMany({
        where: {
          id: candidate.id,
          agencyId: req.auth.agencyId,
          creatorId,
          status: { in: ["pending_reply", "sent", "checking_reply"] },
          OR: [{ claimUntil: null }, { claimUntil: { lt: now } }],
        },
        data: {
          status: "cancel_claimed",
          claimedByDeviceId: deviceId,
          claimedAt: now,
          claimUntil,
          lastCheckedAt: now,
          attempts: { increment: 1 },
          error: null,
        },
      });
      if (updated.count > 0) {
        const row = await prisma.automationDelivery.findUnique({ where: { id: candidate.id } });
        if (row) items.push(mapAutomationDelivery(row));
      }
    }

    return res.json({ ok: true, creatorId, deviceId, count: items.length, items, claimUntil, skippedMaxAttemptsCount: skippedMaxAttempts.length });
  } catch (err) { return sendError(res, err, "BUMP_CANCEL_CLAIM_FAILED"); }
});

router.post("/deliveries/cancel-result", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const existing = await findAutomationDeliveryForResult({ agencyId: req.auth.agencyId, creatorId, input: req.body || {} });
    if (!existing) {
      return res.json({ ok: true, alreadyCompacted: true, item: null, code: "DELIVERY_NOT_FOUND_OR_ALREADY_COMPACTED" });
    }

    const status = bumpStatStatus(req.body?.status || (req.body?.ok === false ? "failed" : "canceled"));
    const now = new Date();
    const prevMeta = deliveryMeta(existing);
    const mergedResult = jsonObject({
      ...prevMeta,
      ...(req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {}),
      finalSource: req.body?.source || req.body?.replySource || req.body?.cancelSource || "server_cancel_worker",
      finalStatus: status,
      finalizedAt: req.body?.finalizedAt || req.body?.repliedAt || req.body?.canceledAt || req.body?.failedAt || now.toISOString(),
      replyMessageId: req.body?.replyMessageId || prevMeta.replyMessageId || null,
      deleteVerified: req.body?.deleteVerified ?? prevMeta.deleteVerified ?? null,
      workerDeviceId: req.body?.deviceId || req.body?.claimedByDeviceId || existing.claimedByDeviceId || null,
    });

    if (BUMP_TERMINAL_DELIVERY_STATUSES.has(status)) {
      const templateId = cleanString(req.body?.templateId || req.body?.bumpId || deliveryTemplateId(existing), 100) || "";
      const day = cleanString(req.body?.day, 10) || (existing.sentAt ? existing.sentAt.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
      await upsertBumpFanState({
        agencyId: req.auth.agencyId, creatorId, fanId: existing.fanId, dialogId: existing.dialogId || existing.fanId,
        templateId, status, sentAt: existing.sentAt,
        finalizedAt: req.body?.repliedAt || req.body?.canceledAt || req.body?.failedAt || now.toISOString(),
        messageId: existing.messageId,
      }).catch(() => null);
      const stat = await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId, day, event: status, by: 1 });
      await prisma.automationDelivery.delete({ where: { id: existing.id } }).catch(() => null);
      return res.json({ ok: true, compacted: true, status, item: null, stat, deliveryId: existing.id, templateId });
    }

    // Non-terminal result means transient failure / release lease back into queue.
    const nextStatus = status === "cancel_claimed" ? "cancel_claimed" : "pending_reply";
    const item = await prisma.automationDelivery.update({
      where: { id: existing.id },
      data: {
        status: nextStatus,
        claimedByDeviceId: nextStatus === "cancel_claimed" ? existing.claimedByDeviceId : null,
        claimedAt: nextStatus === "cancel_claimed" ? existing.claimedAt : null,
        claimUntil: nextStatus === "cancel_claimed" ? existing.claimUntil : null,
        lastCheckedAt: now,
        result: mergedResult,
        error: optionalString(req.body?.error || req.body?.lastError || null, 2000),
      },
    });
    return res.json({ ok: true, compacted: false, item: mapAutomationDelivery(item), released: nextStatus === "pending_reply" });
  } catch (err) { return sendError(res, err, "BUMP_CANCEL_RESULT_FAILED"); }
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


router.get("/follow-back/diagnostics", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);

    const runnableActions = ["follow_back", "refollow_nudge"];
    const activeJobWhere = {
      agencyId: req.auth.agencyId,
      creatorId,
      type: "follow_back",
      action: "run_queue",
      status: { in: ["scheduled", "claimed", "running"] },
    };

    const [groups, pendingRunnable, runningClaims, activeJobs, staleRunning] = await Promise.all([
      prisma.followBackTask.groupBy({
        by: ["status", "action"],
        where: { agencyId: req.auth.agencyId, creatorId },
        _count: { _all: true },
      }),
      prisma.followBackTask.count({
        where: { agencyId: req.auth.agencyId, creatorId, status: "pending", action: { in: runnableActions } },
      }),
      prisma.followBackTask.findMany({
        where: { agencyId: req.auth.agencyId, creatorId, status: "running", action: { in: runnableActions } },
        orderBy: { updatedAt: "desc" },
        take: 25,
        select: { id: true, fanId: true, username: true, action: true, status: true, reason: true, error: true, result: true, updatedAt: true, lastResultAt: true },
      }),
      prisma.automationJob.findMany({
        where: activeJobWhere,
        orderBy: [{ claimedAt: "desc" }, { runAfter: "asc" }, { createdAt: "desc" }],
        take: 20,
        select: { id: true, type: true, action: true, status: true, dedupeKey: true, attempts: true, maxAttempts: true, claimedByDeviceId: true, claimedAt: true, runAfter: true, error: true, createdAt: true, updatedAt: true, completedAt: true, result: true },
      }),
      prisma.followBackTask.findMany({
        where: { agencyId: req.auth.agencyId, creatorId, status: "running", action: { in: runnableActions } },
        orderBy: { updatedAt: "asc" },
        take: 100,
        select: { id: true, fanId: true, action: true, result: true, updatedAt: true },
      }).catch(() => []),
    ]);

    const counts = {};
    for (const row of groups || []) {
      const status = String(row.status || "unknown");
      const action = String(row.action || "unknown");
      const count = Number(row._count?._all || 0);
      counts[status] = Number(counts[status] || 0) + count;
      counts[`${status}:${action}`] = count;
    }

    const now = Date.now();
    const running = (runningClaims || []).map((item) => {
      const meta = item.result && typeof item.result === "object" ? item.result : {};
      const leaseUntilMs = meta.leaseUntil ? new Date(meta.leaseUntil).getTime() : 0;
      return {
        id: item.id,
        fanId: item.fanId,
        username: item.username,
        action: item.action,
        status: item.status,
        reason: item.reason,
        error: item.error,
        claimedByDeviceId: meta.claimedByDeviceId || null,
        claimedAt: meta.claimedAt || null,
        leaseUntil: meta.leaseUntil || null,
        leaseExpired: leaseUntilMs > 0 ? leaseUntilMs <= now : false,
        updatedAt: item.updatedAt,
        lastResultAt: item.lastResultAt,
      };
    });

    const staleRunningCount = (staleRunning || []).filter((item) => {
      const meta = item.result && typeof item.result === "object" ? item.result : {};
      const leaseUntilMs = meta.leaseUntil ? new Date(meta.leaseUntil).getTime() : 0;
      if (leaseUntilMs > 0) return leaseUntilMs <= now;
      const updatedAtMs = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
      return updatedAtMs > 0 && now - updatedAtMs > 10 * 60 * 1000;
    }).length;

    return res.json({
      ok: true,
      creatorId,
      counts,
      pendingRunnable,
      runningClaims: running,
      runningClaimCount: running.length,
      staleRunningCount,
      activeRunJobs: activeJobs || [],
      activeRunJobCount: (activeJobs || []).length,
      serverTime: new Date().toISOString(),
    });
  } catch (err) { return sendError(res, err, "FOLLOW_BACK_DIAGNOSTICS_FAILED"); }
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
// Атомарный счётчик по (creatorId, templateId, day). Клиент шлёт sent при отправке.
// Серверный cancel-worker шлёт terminal статусы сам, чтобы другой worker мог закрыть
// чужую доставку без локального raw-event журнала.
router.post("/deliveries/stat-bump", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const event = bumpStatStatus(req.body?.event);
    if (!STAT_EVENTS.has(event)) {
      return res.status(400).json({ ok: false, code: "BAD_EVENT", error: "event must be one of: " + Array.from(STAT_EVENTS).join(", ") });
    }
    const templateId = cleanString(req.body?.templateId, 100) || "";
    const day = cleanString(req.body?.day, 10) || new Date().toISOString().slice(0, 10);
    const by = Math.max(1, Math.min(1000, positiveInt(req.body?.by, 1)));
    const stat = await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId, day, event, by });
    return res.json({ ok: true, item: stat.item, taskStats: stat.taskStats });
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
