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

// SFS Hunter comment templates — server-only, text-only bump-like comments.
router.get("/sfs-comments", async (req, res) => { try { const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100); return res.json(await automationServer.listSfsComments({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENTS_FAILED"); } });
router.post("/sfs-comments/upsert", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.body?.creatorId, 100); return res.json(await automationServer.saveSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, input: req.body || {} })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_SAVE_FAILED"); } });
router.post("/sfs-comments/:id/trash", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_TRASH_FAILED"); } });
router.post("/sfs-comments/:id/restore", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id, restore: true })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_RESTORE_FAILED"); } });
router.delete("/sfs-comments/:id", requireSeniorAutomationWriter, async (req, res) => { try { const accountId = cleanString(req.body?.accountId || req.query?.accountId, 100); return res.json(await automationServer.trashSfsComment({ agencyId: req.auth.agencyId, userId: req.auth.userId, accountId, templateId: req.params.id, permanent: true })); } catch (err) { return sendError(res, err, "AUTOMATION_SFS_COMMENT_DELETE_FAILED"); } });


// SFS Hunter runtime — server-owned settings/queue/ledger.
router.get("/sfs-hunter/state", async (req, res) => { try { const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100); return res.json(await automationServer.listSfsHunterState({ agencyId: req.auth.agencyId, creatorId, query: req.query || {} })); } catch (err) { return sendError(res, err, "SFS_HUNTER_STATE_FAILED"); } });
router.get("/sfs-hunter/settings", async (req, res) => { try { const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100); return res.json(await automationServer.getSfsHunterSettings({ agencyId: req.auth.agencyId, creatorId })); } catch (err) { return sendError(res, err, "SFS_HUNTER_SETTINGS_FAILED"); } });
router.put("/sfs-hunter/settings", requireSeniorAutomationWriter, async (req, res) => { try { const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100); return res.json(await automationServer.saveSfsHunterSettings({ agencyId: req.auth.agencyId, userId: req.auth.userId, creatorId, input: req.body || {} })); } catch (err) { return sendError(res, err, "SFS_HUNTER_SETTINGS_SAVE_FAILED"); } });
router.post("/sfs-hunter/targets/ingest", async (req, res) => { try { return res.json(await automationServer.ingestSfsTargets({ agencyId: req.auth.agencyId, userId: req.auth.userId, input: req.body || {} })); } catch (err) { return sendError(res, err, "SFS_TARGETS_INGEST_FAILED"); } });
router.post("/sfs-hunter/targets/claim", async (req, res) => { try { return res.json(await automationServer.claimSfsTarget({ agencyId: req.auth.agencyId, input: req.body || {} })); } catch (err) { return sendError(res, err, "SFS_TARGET_CLAIM_FAILED"); } });
router.post("/sfs-hunter/targets/:id/result", async (req, res) => { try { return res.json(await automationServer.completeSfsTarget({ agencyId: req.auth.agencyId, jobId: req.params.id, input: req.body || {} })); } catch (err) { return sendError(res, err, "SFS_TARGET_RESULT_FAILED"); } });
router.post("/sfs-hunter/unfollow/claim", async (req, res) => { try { return res.json(await automationServer.claimSfsUnfollow({ agencyId: req.auth.agencyId, input: req.body || {} })); } catch (err) { return sendError(res, err, "SFS_UNFOLLOW_CLAIM_FAILED"); } });
router.post("/sfs-hunter/unfollow/:id/result", async (req, res) => { try { return res.json(await automationServer.completeSfsUnfollow({ agencyId: req.auth.agencyId, jobId: req.params.id, input: req.body || {} })); } catch (err) { return sendError(res, err, "SFS_UNFOLLOW_RESULT_FAILED"); } });
router.get("/sfs-hunter/used/check", async (req, res) => { try { const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100); return res.json(await automationServer.checkSfsTargetUsed({ agencyId: req.auth.agencyId, creatorId, targetUserId: req.query.targetUserId, targetUsername: req.query.targetUsername || req.query.username })); } catch (err) { return sendError(res, err, "SFS_USED_CHECK_FAILED"); } });

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

function automationDeliveryTriggerPriority(row = {}) {
  const raw = String(row.trigger || row.eventType || row.triggerKey || "").trim();
  const lower = raw.toLowerCase();
  // v19.33.4 business order: once due, online is the hottest action.
  // scheduledAt still controls the configured online delay; this priority only
  // decides among rows that are already due.
  if (raw === "fanOnline" || lower.includes("online") || lower.includes("presence")) return 0;
  if (raw === "fanSubscribed" || lower.includes("subscrib") || lower.includes("new_sub")) return 10;
  if (raw === "fanLikedPost" || lower.includes("liked") || lower.includes("post_like") || lower.includes("favorite")) return 20;
  if (raw === "hiddenOnlineSignal" || lower.includes("hidden")) return 50;
  return 80;
}

function automationDeliveryTimeMs(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function sortAutomationSendCandidates(a, b) {
  return (automationDeliveryTriggerPriority(a) - automationDeliveryTriggerPriority(b))
    || (automationDeliveryTimeMs(a.scheduledAt) - automationDeliveryTimeMs(b.scheduledAt))
    || (automationDeliveryTimeMs(a.createdAt) - automationDeliveryTimeMs(b.createdAt));
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

function dateIso(value) {
  const d = value instanceof Date ? value : parseDate(value);
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function maxIsoDate(...values) {
  let best = null;
  let bestMs = 0;
  for (const value of values) {
    const d = value instanceof Date ? value : parseDate(value);
    const ms = d && Number.isFinite(d.getTime()) ? d.getTime() : 0;
    if (ms > bestMs) { bestMs = ms; best = d; }
  }
  return best ? best.toISOString() : null;
}

function addHoursDate(value, hours) {
  const d = value instanceof Date ? value : parseDate(value);
  const h = Number(hours);
  if (!d || !Number.isFinite(d.getTime()) || !Number.isFinite(h) || h <= 0) return null;
  return new Date(d.getTime() + h * 60 * 60 * 1000);
}

function mapBumpFanState(row = {}) {
  if (!row || typeof row !== "object") return null;
  const counters = row.counters && typeof row.counters === "object" && !Array.isArray(row.counters) ? row.counters : {};
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
    counters,
    // Compact fan quiet-window state. Kept in counters JSON to avoid another DB migration.
    lastRepliedAt: counters.lastRepliedAt || null,
    lastCanceledAt: counters.lastCanceledAt || null,
    lastExpiredAt: counters.lastExpiredAt || null,
    repliedCooldownUntil: counters.repliedCooldownUntil || null,
    sentCooldownUntil: counters.sentCooldownUntil || null,
    sameTemplateCooldownUntil: counters.sameTemplateCooldownUntil || null,
    nextAllowedAt: counters.nextAllowedAt || null,
    quietReason: counters.quietReason || null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

async function upsertBumpFanState({
  agencyId,
  creatorId,
  fanId,
  dialogId = null,
  templateId = "",
  status = "sent",
  sentAt = null,
  finalizedAt = null,
  messageId = null,
  replyCooldownHours = 24,
  sentCooldownHours = 6,
  sameTemplateCooldownHours = null,
  nextAllowedAt = null,
  repliedCooldownUntil = null,
  sentCooldownUntil = null,
}) {
  const cid = cleanString(creatorId, 100);
  const fid = cleanString(fanId, 80);
  if (!agencyId || !cid || !fid) return null;
  const tid = cleanString(templateId, 100) || "";
  const st = cleanString(status, 40) || "sent";
  const existing = await prisma.automationBumpFanState.findUnique({
    where: { creatorId_fanId: { creatorId: cid, fanId: fid } },
  }).catch(() => null);
  const templateIds = compactTemplateIds(existing?.templateIds || [], tid, 50);
  const sentDate = parseDate(sentAt) || existing?.lastSentAt || new Date();
  const finalizedDate = parseDate(finalizedAt) || (["replied", "canceled", "expired", "failed"].includes(st) ? new Date() : existing?.lastFinalizedAt || null);
  const prevCounters = existing?.counters && typeof existing.counters === "object" && !Array.isArray(existing.counters) ? existing.counters : {};

  const replyHours = Math.max(0, Math.min(2160, Number(replyCooldownHours ?? 24) || 24));
  const sentHours = Math.max(0, Math.min(720, Number(sentCooldownHours ?? 6) || 6));
  const sameTplHours = sameTemplateCooldownHours === null || sameTemplateCooldownHours === undefined
    ? null
    : Math.max(0, Math.min(8760, Number(sameTemplateCooldownHours) || 0));

  const computedSentUntil = addHoursDate(sentDate, sentHours);
  const computedReplyUntil = st === "replied" ? addHoursDate(finalizedDate || sentDate, replyHours) : null;
  const computedSameTemplateUntil = tid && sameTplHours !== null ? addHoursDate(sentDate, sameTplHours) : null;
  const explicitNextAllowedAt = parseDate(nextAllowedAt);
  const explicitRepliedUntil = parseDate(repliedCooldownUntil);
  const explicitSentUntil = parseDate(sentCooldownUntil);

  const nextAllowedIso = maxIsoDate(
    prevCounters.nextAllowedAt,
    explicitNextAllowedAt,
    explicitRepliedUntil,
    explicitSentUntil,
    computedReplyUntil,
    computedSentUntil
  );
  const repliedUntilIso = maxIsoDate(prevCounters.repliedCooldownUntil, explicitRepliedUntil, computedReplyUntil);
  const sentUntilIso = maxIsoDate(prevCounters.sentCooldownUntil, explicitSentUntil, computedSentUntil);
  const sameTemplateUntilIso = maxIsoDate(prevCounters.sameTemplateCooldownUntil, computedSameTemplateUntil);

  const counters = {
    ...prevCounters,
    lastSentAt: dateIso(sentDate) || prevCounters.lastSentAt || null,
    lastFinalizedAt: dateIso(finalizedDate) || prevCounters.lastFinalizedAt || null,
    lastStatus: st,
    lastMessageId: optionalString(messageId || existing?.lastMessageId, 100),
    lastTemplateId: tid || existing?.lastTemplateId || null,
    lastRepliedAt: st === "replied" ? (dateIso(finalizedDate) || new Date().toISOString()) : prevCounters.lastRepliedAt || null,
    lastCanceledAt: st === "canceled" ? (dateIso(finalizedDate) || new Date().toISOString()) : prevCounters.lastCanceledAt || null,
    lastExpiredAt: st === "expired" ? (dateIso(finalizedDate) || new Date().toISOString()) : prevCounters.lastExpiredAt || null,
    repliedCooldownUntil: repliedUntilIso || prevCounters.repliedCooldownUntil || null,
    sentCooldownUntil: sentUntilIso || prevCounters.sentCooldownUntil || null,
    sameTemplateCooldownUntil: sameTemplateUntilIso || prevCounters.sameTemplateCooldownUntil || null,
    nextAllowedAt: nextAllowedIso || prevCounters.nextAllowedAt || null,
    quietReason: computedReplyUntil ? "replied" : "sent",
    replyCooldownHours: replyHours,
    sentCooldownHours: sentHours,
    sameTemplateCooldownHours: sameTplHours,
    updatedAt: new Date().toISOString(),
  };

  const data = {
    agencyId,
    creatorId: cid,
    fanId: fid,
    dialogId: optionalString(dialogId || fid, 80),
    lastTemplateId: tid || existing?.lastTemplateId || null,
    lastStatus: st,
    lastSentAt: sentDate,
    lastFinalizedAt: finalizedDate,
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


// v19.34.0: AutomationDelivery state-machine guard.
// This table is still used by legacy desktop clients, so the repair is intentionally
// schema-free: terminal/lifecycle metadata lives in result JSON and terminal rows
// are kept as tombstones instead of being deleted immediately.
const AUTOMATION_SEND_CLAIM_STATUSES = new Set(["online_claimed", "send_reserved"]);
const AUTOMATION_CANCEL_CLAIM_STATUSES = new Set(["cancel_claimed"]);
const AUTOMATION_HIDDEN_SCAN_CLAIM_STATUSES = new Set(["hidden_scan_claimed"]);
const AUTOMATION_ANY_CLAIM_STATUSES = new Set([
  ...AUTOMATION_SEND_CLAIM_STATUSES,
  ...AUTOMATION_CANCEL_CLAIM_STATUSES,
  ...AUTOMATION_HIDDEN_SCAN_CLAIM_STATUSES,
]);
const AUTOMATION_TERMINAL_ROW_STATUSES = new Set(["replied", "canceled", "expired", "failed", "skipped"]);

// v19.34.2: send results now distinguish hard terminal outcomes from
// soft scheduling pressure and unknown post-send states. Soft limits stay in
// the active queue; request timeouts become send_unknown so we never blindly
// retry a message that OF may already have accepted.
const AUTOMATION_SOFT_RETRY_CODES = new Set([
  "BUMP_HOURLY_LIMIT",
  "BUMP_DAILY_LIMIT",
  "BUMP_COOLDOWN",
  "LOCAL_BUMP_SEND_SPACING_WAIT",
  "LOCAL_BUMP_SEND_NOT_DUE",
  "BUMP_SEND_ALREADY_RUNNING",
  "BUMP_FAN_QUIET_WINDOW",
  "FAN_QUIET_WINDOW",
  "ACCOUNT_COOLDOWN",
  "BUMP_ACCOUNT_COOLDOWN",
  "BUMP_DELAYED_BY_SERVER_GATE",
]);
const AUTOMATION_SEND_UNKNOWN_CODES = new Set([
  "REQUEST_TIMEOUT",
  "REQUEST_FAILED",
  "ONLINE_BUMP_SEND_EXCEPTION",
  "BROWSER_API_REQUEST_TIMEOUT",
  "NETWORK_ERROR",
  "ETIMEDOUT",
  "ECONNRESET",
]);

function stripUndefinedFields(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function deliveryStatAlreadyCounted(row = {}) {
  const meta = deliveryMeta(row);
  return Boolean(meta.statCounted === true || meta.statCountedAt || meta.statCountedStatus);
}

function automationResultCode(input = {}, meta = {}) {
  return cleanString(
    input.code || input.resultCode || input.statusCode || input.errorCode ||
    meta.code || meta.resultCode || meta.statusCode || meta.errorCode ||
    meta.retryReason || meta.sendResultStatus || "",
    120
  ).toUpperCase();
}

function isSoftRetryResult(status = "", code = "") {
  const s = cleanString(status, 40).toLowerCase();
  const c = cleanString(code, 120).toUpperCase();
  return s === "retry_wait" || s === "soft_retry" || s === "soft_limited" || AUTOMATION_SOFT_RETRY_CODES.has(c);
}

function isSendUnknownResult(status = "", code = "", input = {}, meta = {}) {
  const s = cleanString(status, 40).toLowerCase();
  const c = cleanString(code, 120).toUpperCase();
  if (s === "send_unknown" || s === "unknown" || AUTOMATION_SEND_UNKNOWN_CODES.has(c)) return true;
  const text = String(input.error || input.message || meta.error || meta.message || meta.lastError || "").toLowerCase();
  return text.includes("timed out") || text.includes("timeout") || text.includes("network") || text.includes("socket hang up");
}

function automationRetryAt(input = {}, meta = {}, fallbackMs = 5 * 60 * 1000) {
  const raw = input.retryAt || input.nextScheduledAt || input.nextDueAt || input.nextAllowedAt ||
    meta.retryAt || meta.nextScheduledAt || meta.nextDueAt || meta.nextAllowedAt ||
    meta.quietUntil || meta.verifyAt || null;
  const parsed = parseDate(raw);
  if (parsed && parsed.getTime() > Date.now()) return parsed;
  const wait = Math.max(30 * 1000, Math.min(24 * 60 * 60 * 1000, Number(input.waitMs || input.retryAfterMs || meta.waitMs || meta.retryAfterMs || fallbackMs) || fallbackMs));
  return new Date(Date.now() + wait);
}

function normalizeDeliveryWriteData(data = {}) {
  const next = { ...(data || {}) };
  const status = bumpStatStatus(next.status || "");
  if (AUTOMATION_ANY_CLAIM_STATUSES.has(status) && (!next.claimUntil || !next.claimedByDeviceId)) {
    const meta = deliveryMeta(next);
    next.result = jsonObject({
      ...meta,
      leaseRejected: true,
      leaseRejectedAt: new Date().toISOString(),
      requestedStatus: status,
      leaseRejectedReason: "claimed/reserved status requires claimedByDeviceId and claimUntil",
    });
    if (AUTOMATION_CANCEL_CLAIM_STATUSES.has(status)) next.status = "pending_reply";
    else if (AUTOMATION_HIDDEN_SCAN_CLAIM_STATUSES.has(status)) next.status = "hidden_scan_queued";
    else next.status = "online_queued";
    next.claimedByDeviceId = null;
    next.claimedAt = null;
    next.claimUntil = null;
  }
  return next;
}

async function createAutomationDeliverySafe(data = {}) {
  try {
    return await prisma.automationDelivery.create({ data });
  } catch (err) {
    if (err?.code === "P2002" && data.id) {
      const existing = await prisma.automationDelivery.findUnique({ where: { id: data.id } }).catch(() => null);
      if (existing) return existing;
    }
    throw err;
  }
}

async function saveAutomationDeliveryIdempotent({ agencyId, creatorId, id = "", messageId = "", data = {}, updateData = {} }) {
  const safeData = normalizeDeliveryWriteData(data);
  const safeUpdate = stripUndefinedFields(normalizeDeliveryWriteData(updateData));
  const cid = cleanString(creatorId, 100);
  const did = cleanString(id, 120);
  const mid = cleanString(messageId, 100);

  if (did) {
    const updated = await prisma.automationDelivery.updateMany({
      where: { id: did, agencyId, creatorId: cid },
      data: safeUpdate,
    });
    if (updated.count > 0) {
      const row = await prisma.automationDelivery.findUnique({ where: { id: did } }).catch(() => null);
      if (row) return row;
    }
    const foreign = await prisma.automationDelivery.findUnique({ where: { id: did }, select: { id: true, agencyId: true, creatorId: true } }).catch(() => null);
    if (foreign?.id && (foreign.agencyId !== agencyId || foreign.creatorId !== cid)) {
      const err = new Error("delivery id belongs to another creator");
      err.status = 409;
      err.code = "DELIVERY_ID_CONFLICT";
      throw err;
    }
    return createAutomationDeliverySafe({ ...safeData, id: did });
  }

  if (mid) {
    const updated = await prisma.automationDelivery.updateMany({
      where: { agencyId, creatorId: cid, messageId: mid },
      data: safeUpdate,
    });
    if (updated.count > 0) {
      const row = await prisma.automationDelivery.findFirst({
        where: { agencyId, creatorId: cid, messageId: mid },
        orderBy: { updatedAt: "desc" },
      }).catch(() => null);
      if (row) return row;
    }
    return createAutomationDeliverySafe(safeData);
  }

  return createAutomationDeliverySafe(safeData);
}

async function markAutomationDeliveryTerminal({ req, creatorId, row, status, input = {}, source = "automation_state_machine" }) {
  const terminalStatus = bumpStatStatus(status);
  if (!row?.id || !BUMP_TERMINAL_DELIVERY_STATUSES.has(terminalStatus)) {
    return { ok: false, code: "BAD_TERMINAL_DELIVERY", item: row ? mapAutomationDelivery(row) : null };
  }
  const now = new Date();
  const prevMeta = deliveryMeta(row);
  const inputResult = input?.result && typeof input.result === "object" && !Array.isArray(input.result) ? input.result : {};
  const alreadyCounted = deliveryStatAlreadyCounted(row);
  const templateId = cleanString(input?.templateId || input?.bumpId || deliveryTemplateId(row), 100) || "";
  const day = cleanString(input?.day, 10) || (row.sentAt ? row.sentAt.toISOString().slice(0, 10) : now.toISOString().slice(0, 10));
  let stat = null;

  if (!alreadyCounted && STAT_EVENTS.has(terminalStatus)) {
    await upsertBumpFanState({
      agencyId: req.auth.agencyId,
      creatorId,
      fanId: row.fanId,
      dialogId: row.dialogId || row.fanId,
      templateId,
      status: terminalStatus,
      sentAt: row.sentAt,
      finalizedAt: input?.repliedAt || input?.canceledAt || input?.failedAt || input?.finalizedAt || now.toISOString(),
      messageId: row.messageId,
      replyCooldownHours: input?.replyCooldownHours ?? input?.fanReplyCooldownHours ?? input?.afterReplyCooldownHours ?? 24,
      sentCooldownHours: input?.sentCooldownHours ?? input?.fanSentCooldownHours ?? input?.afterSendCooldownHours ?? 6,
      sameTemplateCooldownHours: input?.sameTemplateCooldownHours ?? input?.cooldownHours ?? null,
    }).catch(() => null);
    stat = await incrementBumpDeliveryStat({ agencyId: req.auth.agencyId, creatorId, templateId, day, event: terminalStatus, by: 1 }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  }

  const mergedResult = jsonObject({
    ...prevMeta,
    ...inputResult,
    finalSource: input?.source || input?.replySource || input?.cancelSource || source,
    finalStatus: terminalStatus,
    terminalStatus,
    lifecycle: "terminal",
    terminalAt: input?.terminalAt || input?.repliedAt || input?.canceledAt || input?.failedAt || input?.finalizedAt || now.toISOString(),
    finalizedAt: input?.finalizedAt || input?.repliedAt || input?.canceledAt || input?.failedAt || now.toISOString(),
    replyMessageId: input?.replyMessageId || prevMeta.replyMessageId || null,
    deleteVerified: input?.deleteVerified ?? prevMeta.deleteVerified ?? null,
    workerDeviceId: input?.deviceId || input?.claimedByDeviceId || row.claimedByDeviceId || null,
    statCounted: alreadyCounted || STAT_EVENTS.has(terminalStatus),
    statCountedStatus: prevMeta.statCountedStatus || (STAT_EVENTS.has(terminalStatus) ? terminalStatus : null),
    statCountedAt: prevMeta.statCountedAt || (STAT_EVENTS.has(terminalStatus) ? now.toISOString() : null),
    statSkipped: !STAT_EVENTS.has(terminalStatus),
  });

  const updated = await prisma.automationDelivery.updateMany({
    where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
    data: {
      status: terminalStatus,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      lastCheckedAt: now,
      result: mergedResult,
      error: optionalString(input?.error || input?.lastError || null, 2000),
    },
  });
  if (updated.count <= 0) {
    return { ok: true, alreadyCompacted: true, item: null, code: "DELIVERY_TERMINAL_RACE_LOST", status: terminalStatus, stat };
  }
  const item = await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null);
  return { ok: true, compacted: false, terminal: true, status: terminalStatus, item: item ? mapAutomationDelivery(item) : null, stat, alreadyCounted };
}

async function repairAutomationDeliveries({ agencyId, creatorId, now = new Date(), timeoutSec = 180 } = {}) {
  const cid = cleanString(creatorId, 100);
  const staleBefore = new Date(now.getTime() - Math.max(30, Number(timeoutSec) || 180) * 1000);
  const report = { repairedOnlineClaims: 0, repairedCancelClaims: 0, repairedHiddenScanClaims: 0, fixedQueuedWithMessageId: 0, fixedPendingWithoutMessageId: 0 };

  const online = await prisma.automationDelivery.updateMany({
    where: {
      agencyId,
      creatorId: cid,
      status: { in: ["online_claimed", "send_reserved"] },
      OR: [{ claimUntil: { lt: now } }, { claimUntil: null }, { claimedByDeviceId: null }],
    },
    data: {
      status: "online_queued",
      sentAt: null,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      scheduledAt: now,
      lastCheckedAt: now,
      error: "stale online/send claim repaired; returned to queue",
    },
  }).catch(() => ({ count: 0 }));
  report.repairedOnlineClaims = online.count || 0;

  const cancel = await prisma.automationDelivery.updateMany({
    where: {
      agencyId,
      creatorId: cid,
      status: "cancel_claimed",
      OR: [{ claimUntil: { lt: now } }, { claimUntil: null }, { claimedByDeviceId: null }],
    },
    data: {
      status: "pending_reply",
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      lastCheckedAt: now,
      error: "stale cancel claim repaired; returned to pending_reply",
    },
  }).catch(() => ({ count: 0 }));
  report.repairedCancelClaims = cancel.count || 0;

  const scan = await prisma.automationDelivery.updateMany({
    where: {
      agencyId,
      creatorId: cid,
      trigger: "hidden_online_scan",
      status: "hidden_scan_claimed",
      OR: [{ claimUntil: { lt: now } }, { claimUntil: null }, { claimedByDeviceId: null }, { updatedAt: { lt: staleBefore } }],
    },
    data: {
      status: "hidden_scan_queued",
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      lastCheckedAt: now,
      error: "stale hidden scan claim repaired; returned to queue",
    },
  }).catch(() => ({ count: 0 }));
  report.repairedHiddenScanClaims = scan.count || 0;

  const queuedWithMessage = await prisma.automationDelivery.updateMany({
    where: { agencyId, creatorId: cid, status: "online_queued", messageId: { not: null } },
    data: { status: "pending_reply", claimedByDeviceId: null, claimedAt: null, claimUntil: null, lastCheckedAt: now, error: null },
  }).catch(() => ({ count: 0 }));
  report.fixedQueuedWithMessageId = queuedWithMessage.count || 0;

  const pendingNoMessage = await prisma.automationDelivery.updateMany({
    where: { agencyId, creatorId: cid, status: "pending_reply", messageId: null, sentAt: null },
    data: { status: "online_queued", scheduledAt: now, claimedByDeviceId: null, claimedAt: null, claimUntil: null, lastCheckedAt: now, error: "pending_reply without messageId/sentAt repaired; returned to queue" },
  }).catch(() => ({ count: 0 }));
  report.fixedPendingWithoutMessageId = pendingNoMessage.count || 0;

  return report;
}

// Legacy server-state mutating routes are intentionally senior-only in v19.5.
// Worker job protocol remains open through /jobs/claim, /jobs/:id/result and /events.



const BUMP_TRIGGER_KEYS = Object.freeze({
  ONLINE: "fanOnline",
  LIKE: "fanLikedPost",
  SUBSCRIBED: "fanSubscribed",
  HIDDEN: "hiddenOnlineSignal",
});

function normalizeBumpTrigger(value) {
  const raw = cleanString(value, 80);
  const lower = String(raw || "").toLowerCase();
  if (!raw) return BUMP_TRIGGER_KEYS.ONLINE;
  if (raw === BUMP_TRIGGER_KEYS.ONLINE || lower === "online" || lower === "presence_online" || lower === "fan_online") return BUMP_TRIGGER_KEYS.ONLINE;
  if (raw === BUMP_TRIGGER_KEYS.LIKE || lower === "like" || lower === "post_like" || lower === "fan_liked_post" || lower === "fanlikedpost") return BUMP_TRIGGER_KEYS.LIKE;
  if (raw === BUMP_TRIGGER_KEYS.SUBSCRIBED || lower === "subscribe" || lower === "subscription" || lower === "subscription_created" || lower === "new_subscriber" || lower === "fansubscribed") return BUMP_TRIGGER_KEYS.SUBSCRIBED;
  if (raw === BUMP_TRIGGER_KEYS.HIDDEN || lower === "hidden" || lower === "hidden_online" || lower === "hiddenonlinesignal" || lower === "hidden_online_signal") return BUMP_TRIGGER_KEYS.HIDDEN;
  return BUMP_TRIGGER_KEYS.ONLINE;
}

function eventGateId(creatorId) {
  return `bump_event_gate_${String(creatorId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}`;
}

function eventQueueBatchId(prefix = "event") {
  return `bump_${String(prefix || "event").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function onlineQueueFanIds(value) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const raw = item && typeof item === "object" ? (item.fanId || item.userId || item.id || item.dialogId) : item;
    const id = cleanString(raw, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function onlineSpacingRange(input = {}) {
  const min = Math.max(15, Math.min(3600, positiveInt(input.minFanSpacingSec ?? input.onlineFanSpacingSec ?? input.batchSpacingSec, 15)));
  const rawMax = positiveInt(input.maxFanSpacingSec ?? input.onlineFanMaxSpacingSec ?? input.batchMaxSpacingSec, 30);
  const max = Math.max(min, Math.min(3600, rawMax || 30));
  return { min, max };
}

function randomOnlineSpacingMs(range = {}) {
  const min = Math.max(15, Number(range.min) || 15);
  const max = Math.max(min, Number(range.max) || 30);
  const sec = min + Math.floor(Math.random() * (max - min + 1));
  return sec * 1000;
}

async function acquireOnlineGate(tx, { agencyId, creatorId, now }) {
  const id = eventGateId(creatorId);
  let row = await tx.automationDelivery.findUnique({ where: { id } }).catch(() => null);
  if (!row) {
    try {
      row = await tx.automationDelivery.create({
        data: {
          id,
          agencyId,
          creatorId,
          fanId: "__bump_event_gate__",
          dialogId: null,
          trigger: "bumpEvent_gate",
          status: "online_gate",
          scheduledAt: now,
          lastCheckedAt: now,
          result: { onlineGate: true, nextAllowedAt: now.toISOString() },
        },
      });
    } catch (_) {
      row = await tx.automationDelivery.findUnique({ where: { id } }).catch(() => null);
    }
  }

  if (!row) throw new Error("ONLINE_GATE_UNAVAILABLE");
  // UPDATE locks the gate row inside the transaction on PostgreSQL, giving us
  // one global cursor per creator/account for online bump sends.
  return tx.automationDelivery.update({ where: { id }, data: { lastCheckedAt: now } });
}

function onlineGateNextAllowed(row, now) {
  const meta = deliveryMeta(row);
  const t = new Date(meta.nextAllowedAt || row?.scheduledAt || 0).getTime();
  return Number.isFinite(t) && t > now.getTime() ? new Date(t) : now;
}

const ONLINE_SEND_ACTIVE_STATUSES = ["online_queued", "online_claimed", "send_reserved", "send_unknown", "retry_wait", "pending_reply", "sent", "checking_reply", "cancel_claimed"];

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
      replyCooldownHours: req.body?.replyCooldownHours ?? req.body?.fanReplyCooldownHours ?? req.body?.afterReplyCooldownHours ?? 24,
      sentCooldownHours: req.body?.sentCooldownHours ?? req.body?.fanSentCooldownHours ?? req.body?.afterSendCooldownHours ?? 6,
      sameTemplateCooldownHours: req.body?.sameTemplateCooldownHours ?? req.body?.cooldownHours ?? null,
      nextAllowedAt: req.body?.nextAllowedAt || null,
      repliedCooldownUntil: req.body?.repliedCooldownUntil || null,
      sentCooldownUntil: req.body?.sentCooldownUntil || null,
    });
    return res.json({ ok: true, item });
  } catch (err) { return sendError(res, err, "BUMP_FAN_STATE_UPSERT_FAILED"); }
});

router.post("/deliveries/repair", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const report = await repairAutomationDeliveries({ agencyId: req.auth.agencyId, creatorId, timeoutSec: positiveInt(req.body?.timeoutSec, 180) });
    return res.json({ ok: true, creatorId, report });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_REPAIR_FAILED"); }
});

router.get("/deliveries/health", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const now = new Date();
    const [byStatus, byTrigger, staleClaims, dueHot, dueHidden, pendingReply, terminalToday, retryWait, sendUnknown, softLimited] = await Promise.all([
      prisma.automationDelivery.groupBy({ by: ["status"], where: { agencyId: req.auth.agencyId, creatorId }, _count: { _all: true } }).catch(() => []),
      prisma.automationDelivery.groupBy({ by: ["trigger"], where: { agencyId: req.auth.agencyId, creatorId }, _count: { _all: true } }).catch(() => []),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: { in: ["online_claimed", "send_reserved", "cancel_claimed", "hidden_scan_claimed"] }, OR: [{ claimUntil: null }, { claimUntil: { lt: now } }, { claimedByDeviceId: null }] } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", trigger: { in: ["fanOnline", "fanSubscribed", "fanLikedPost"] }, scheduledAt: { lte: now } } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", trigger: "hiddenOnlineSignal", scheduledAt: { lte: now } } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "pending_reply" } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: { in: Array.from(AUTOMATION_TERMINAL_ROW_STATUSES) }, updatedAt: { gte: new Date(now.toISOString().slice(0,10) + "T00:00:00.000Z") } } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", result: { path: ["softRetry"], equals: true } } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "send_unknown" } }).catch(() => 0),
      prisma.automationDelivery.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", OR: Array.from(AUTOMATION_SOFT_RETRY_CODES).map((code) => ({ result: { path: ["retryReason"], equals: code } })) } }).catch(() => 0),
    ]);
    return res.json({
      ok: true,
      creatorId,
      deliveries: {
        byStatus: Object.fromEntries((byStatus || []).map((x) => [x.status || "null", x._count?._all || 0])),
        byTrigger: Object.fromEntries((byTrigger || []).map((x) => [x.trigger || "null", x._count?._all || 0])),
        staleClaims,
        dueHot,
        dueHidden,
        pendingReply,
        terminalToday,
        retryWait,
        sendUnknown,
        softLimited,
      },
    });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_HEALTH_FAILED"); }
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

    // Electron может прислать локальный id вида bd_/local/tmp. Такой id не
    // является серверным primary key, поэтому дедупим его через messageId.
    const rawId = cleanString(req.body?.id, 100);
    const id = rawId && !/^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : "";
    const templateId = optionalString(req.body?.contentCollectionId || req.body?.templateId || req.body?.bumpId, 100);
    const incomingResult = req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {};
    const resultMeta = jsonObject({
      ...incomingResult,
      lifecycle: incomingResult.lifecycle || "active",
      localDeliveryId: rawId && /^(bd_|local|tmp|temp)/i.test(rawId) ? rawId : (incomingResult.localDeliveryId || incomingResult.localId || null),
      templateId: templateId || incomingResult.templateId || incomingResult.bumpId || null,
      bumpId: templateId || incomingResult.bumpId || incomingResult.templateId || null,
      queueId: req.body?.queueId ?? incomingResult.queueId ?? null,
      cancelAt: req.body?.cancelAt || incomingResult.cancelAt || null,
      cancelAfterHours: req.body?.cancelAfterHours ?? incomingResult.cancelAfterHours ?? null,
      statCounted: incomingResult.statCounted || null,
      statCountedAt: incomingResult.statCountedAt || null,
      statCountedStatus: incomingResult.statCountedStatus || null,
    });

    let data = normalizeDeliveryWriteData({
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
    });

    const updateData = stripUndefinedFields({ ...data, agencyId: undefined, creatorId: undefined, fanId: undefined, createdByUserId: undefined });
    const terminalStatus = bumpStatStatus(data.status);

    // Terminal writes are state transitions, not deletes. Keeping a tombstone row
    // makes late local fire-and-forget updates idempotent and avoids P2025 races.
    if (BUMP_TERMINAL_DELIVERY_STATUSES.has(terminalStatus)) {
      const existing = id
        ? await prisma.automationDelivery.findFirst({ where: { id, agencyId: req.auth.agencyId, creatorId } })
        : data.messageId
          ? await prisma.automationDelivery.findFirst({ where: { agencyId: req.auth.agencyId, creatorId, messageId: data.messageId }, orderBy: { updatedAt: "desc" } })
          : null;
      if (!existing?.id) {
        return res.json({ ok: true, item: null, alreadyCompacted: true, terminal: true, status: terminalStatus, code: "TERMINAL_DELIVERY_NOT_FOUND" });
      }
      const final = await markAutomationDeliveryTerminal({ req, creatorId, row: existing, status: terminalStatus, input: req.body || {}, source: "delivery_upsert_terminal" });
      return res.json({ ...final, _dedup: "v19.34-terminal-tombstone" });
    }

    const item = await saveAutomationDeliveryIdempotent({
      agencyId: req.auth.agencyId,
      creatorId,
      id,
      messageId: data.messageId,
      data,
      updateData,
    });

    if (item && !AUTOMATION_TERMINAL_ROW_STATUSES.has(bumpStatStatus(item.status || ""))) {
      await upsertBumpFanState({
        agencyId: req.auth.agencyId, creatorId, fanId: item.fanId, dialogId: item.dialogId || item.fanId,
        templateId: deliveryTemplateId(item), status: item.status || "sent", sentAt: item.sentAt, messageId: item.messageId,
        replyCooldownHours: req.body?.replyCooldownHours ?? req.body?.fanReplyCooldownHours ?? req.body?.afterReplyCooldownHours ?? 24,
        sentCooldownHours: req.body?.sentCooldownHours ?? req.body?.fanSentCooldownHours ?? req.body?.afterSendCooldownHours ?? 6,
        sameTemplateCooldownHours: req.body?.sameTemplateCooldownHours ?? req.body?.cooldownHours ?? null,
      }).catch(() => null);
    }
    return res.json({ ok: true, item: mapAutomationDelivery(item), _dedup: "v19.34-state-machine-idempotent" });
  } catch (err) { return sendError(res, err, "AUTOMATION_DELIVERY_UPSERT_FAILED"); }
});


// Test helper for environments without DB shell access. It does NOT delete
// messages by itself. It only moves a small number of pending bump deliveries
// into the due window so the normal distributed claim/sweep pipeline can be
// tested from the desktop console. Senior automation writer is required.
router.post("/deliveries/debug-force-due", requireSeniorAutomationWriter, async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);

    const limit = parseLimit(req.body?.limit, 1, 5);
    const minutesAgo = Math.max(1, Math.min(60, positiveInt(req.body?.minutesAgo, 1)));
    const now = new Date();
    const forcedCancelAt = new Date(now.getTime() - minutesAgo * 60 * 1000);

    const deliveryId = cleanString(req.body?.deliveryId || req.body?.id, 120);
    const messageId = cleanString(req.body?.messageId, 120);
    const fanId = cleanString(req.body?.fanId || req.body?.dialogId, 100);
    const templateId = cleanString(req.body?.templateId || req.body?.bumpId, 100);

    const where = {
      agencyId: req.auth.agencyId,
      creatorId,
      status: { in: ["pending_reply", "sent", "checking_reply"] },
      ...(deliveryId ? { id: deliveryId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(fanId ? { OR: [{ fanId }, { dialogId: fanId }] } : {}),
      ...(templateId ? { contentCollectionId: templateId } : {}),
    };

    const rows = await prisma.automationDelivery.findMany({
      where,
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take: limit,
    });

    const items = [];
    for (const row of rows) {
      const updated = await prisma.automationDelivery.update({
        where: { id: row.id },
        data: {
          status: "pending_reply",
          cancelAt: forcedCancelAt,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          error: null,
          result: jsonObject({
            ...deliveryMeta(row),
            debugForcedDueAt: now.toISOString(),
            debugForcedByUserId: req.auth?.userId || null,
            previousCancelAt: row.cancelAt ? row.cancelAt.toISOString() : deliveryMeta(row).cancelAt || null,
          }),
        },
      });
      items.push(mapAutomationDelivery(updated));
    }

    return res.json({
      ok: true,
      creatorId,
      count: items.length,
      forcedCancelAt: forcedCancelAt.toISOString(),
      items,
      warning: "debug-force-due only makes rows claimable; normal claim/sweep still performs reply-check and delete",
    });
  } catch (err) { return sendError(res, err, "BUMP_DEBUG_FORCE_DUE_FAILED"); }
});


// Distributed bump event scheduler. Workers report online/like/subscription fan batches; server
// dedupes fanIds and assigns global scheduledAt slots with 15–30s spacing so
// several employees/devices cannot burst-send at the same time.
router.post("/deliveries/online-batch", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const fanIds = onlineQueueFanIds(req.body?.fanIds || req.body?.onlineIds || req.body?.ids || []);
    if (!fanIds.length) return res.json({ ok: true, creatorId, count: 0, items: [], skipped: [], code: "BUMP_EVENT_BATCH_EMPTY" });

    const range = onlineSpacingRange(req.body || {});
    const triggerKey = normalizeBumpTrigger(req.body?.triggerType || req.body?.triggerKey || req.body?.trigger || req.body?.event?.triggerKey || req.body?.event?.type);
    const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
    const batchId = cleanString(req.body?.batchId, 120) || eventQueueBatchId(triggerKey);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const gate = await acquireOnlineGate(tx, { agencyId: req.auth.agencyId, creatorId, now });
      const activeRows = await tx.automationDelivery.findMany({
        where: { agencyId: req.auth.agencyId, creatorId, fanId: { in: fanIds }, status: { in: ONLINE_SEND_ACTIVE_STATUSES } },
        select: { id: true, fanId: true, status: true, scheduledAt: true, sentAt: true, createdAt: true },
      });
      const activeByFan = new Map(activeRows.map((x) => [String(x.fanId), x]));
      let cursor = onlineGateNextAllowed(gate, now);
      const items = [];
      const skipped = [];

      for (const fanId of fanIds) {
        if (activeByFan.has(String(fanId))) {
          skipped.push({ fanId, code: "ACTIVE_OR_ALREADY_QUEUED", status: activeByFan.get(String(fanId))?.status || null });
          continue;
        }

        const scheduledAt = new Date(Math.max(cursor.getTime(), now.getTime()));
        const item = await tx.automationDelivery.create({
          data: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId,
            dialogId: fanId,
            trigger: triggerKey,
            status: "online_queued",
            scheduledAt,
            maxAttempts: 3,
            claimedByDeviceId: null,
            result: jsonObject({
              onlineQueue: triggerKey === BUMP_TRIGGER_KEYS.ONLINE,
              eventQueue: true,
              triggerKey,
              trigger: triggerKey,
              eventType: req.body?.event?.type || req.body?.eventType || null,
              externalEventId: req.body?.event?.externalEventId || req.body?.externalEventId || null,
              batchId,
              sourceDeviceId: deviceId,
              minFanSpacingSec: range.min,
              maxFanSpacingSec: range.max,
              queuedAt: now.toISOString(),
            }),
            createdByUserId: req.auth.userId,
          },
        });
        items.push(item);
        activeByFan.set(String(fanId), item);
        cursor = new Date(scheduledAt.getTime() + randomOnlineSpacingMs(range));
      }

      await tx.automationDelivery.update({
        where: { id: gate.id },
        data: {
          scheduledAt: cursor,
          result: jsonObject({ ...deliveryMeta(gate), eventGate: true, onlineGate: true, nextAllowedAt: cursor.toISOString(), minFanSpacingSec: range.min, maxFanSpacingSec: range.max, updatedAt: now.toISOString() }),
        },
      });

      const nextScheduledAt = items[0]?.scheduledAt || await tx.automationDelivery.findFirst({
        where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued" },
        orderBy: { scheduledAt: "asc" },
        select: { scheduledAt: true },
      }).then((x) => x?.scheduledAt || null);

      return { items, skipped, nextScheduledAt, gateNextAllowedAt: cursor };
    }, { timeout: 15000 });

    return res.json({
      ok: true,
      creatorId,
      mode: "server_event_queue",
      triggerKey,
      count: result.items.length,
      items: result.items.map(mapAutomationDelivery),
      skipped: result.skipped,
      skippedCount: result.skipped.length,
      nextScheduledAt: result.nextScheduledAt ? result.nextScheduledAt.toISOString() : null,
      gateNextAllowedAt: result.gateNextAllowedAt ? result.gateNextAllowedAt.toISOString() : null,
      minFanSpacingSec: range.min,
      maxFanSpacingSec: range.max,
    });
  } catch (err) { return sendError(res, err, "BUMP_EVENT_BATCH_FAILED"); }
});

router.post("/deliveries/claim-online-send", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
    const limit = parseLimit(req.body?.limit, 1, 10);
    const timeoutSec = Math.max(30, Math.min(1800, positiveInt(req.body?.claimTimeoutSec, 180)));
    const now = new Date();
    const claimUntil = new Date(now.getTime() + timeoutSec * 1000);

    // v19.33.7: repair stale online send reservations before claiming.
    // Older desktop builds could create `send_reserved` rows with no claimUntil
    // (legacy realtime reservation fallback). Those rows never expired and fell
    // out of the normal claim flow forever. Treat every expired/null lease on
    // online_claimed/send_reserved as retryable queue work.
    await prisma.automationDelivery.updateMany({
      where: {
        agencyId: req.auth.agencyId,
        creatorId,
        status: { in: ["online_claimed", "send_reserved"] },
        OR: [
          { claimUntil: { lt: now } },
          { claimUntil: null },
        ],
      },
      data: {
        status: "online_queued",
        sentAt: null,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        lastCheckedAt: now,
        scheduledAt: now,
        error: "stale online/send reservation repaired; returned to queue",
      },
    }).catch(() => null);

    // v19.33.4: a backlog of hiddenOnlineSignal rows must not keep fresh
    // fanOnline/fanSubscribed/fanLikedPost rows behind it. scheduledAt still
    // controls the configured online delay; among rows already due, claim by
    // business priority first, then by scheduledAt. Fetch a wider window because
    // old hidden rows can otherwise hide newer realtime rows from the candidate set.
    const candidates = await prisma.automationDelivery.findMany({
      where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued", scheduledAt: { lte: now } },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      take: Math.max(limit * 100, 100),
    });
    candidates.sort(sortAutomationSendCandidates);

    const items = [];
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      const updated = await prisma.automationDelivery.updateMany({
        where: { id: candidate.id, agencyId: req.auth.agencyId, creatorId, status: "online_queued", OR: [{ claimUntil: null }, { claimUntil: { lt: now } }] },
        data: { status: "online_claimed", claimedByDeviceId: deviceId, claimedAt: now, claimUntil, lastCheckedAt: now, attempts: { increment: 1 }, error: null },
      });
      if (updated.count > 0) {
        const row = await prisma.automationDelivery.findUnique({ where: { id: candidate.id } });
        if (row) items.push(mapAutomationDelivery(row));
      }
    }

    const next = await prisma.automationDelivery.findFirst({
      where: { agencyId: req.auth.agencyId, creatorId, status: "online_queued" },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    });

    return res.json({ ok: true, creatorId, deviceId, count: items.length, items, claimUntil, nextScheduledAt: next?.scheduledAt ? next.scheduledAt.toISOString() : null });
  } catch (err) { return sendError(res, err, "BUMP_ONLINE_CLAIM_FAILED"); }
});

router.post("/deliveries/online-send-result", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const id = cleanString(req.body?.id || req.body?.deliveryId || req.body?.serverDeliveryId, 120);
    if (!id) return res.status(400).json({ ok: false, code: "ONLINE_QUEUE_ID_MISSING", error: "delivery id is required" });

    const row = await prisma.automationDelivery.findFirst({
      where: { id, agencyId: req.auth.agencyId, creatorId, status: { in: ["online_claimed", "online_queued", "send_reserved", "pending_reply", "failed", "skipped", "retry_wait", "send_unknown"] } },
    });
    if (!row) return res.json({ ok: true, alreadyDone: true, item: null, code: "ONLINE_QUEUE_ROW_NOT_FOUND" });

    const status = cleanString(req.body?.status || (req.body?.ok === false ? "failed" : "done"), 40) || "done";
    const now = new Date();
    const inputResult = req.body?.result && typeof req.body.result === "object" && !Array.isArray(req.body.result) ? req.body.result : {};
    const resultItem = inputResult.item && typeof inputResult.item === "object" && !Array.isArray(inputResult.item) ? inputResult.item : {};
    const responseData = inputResult.data && typeof inputResult.data === "object" && !Array.isArray(inputResult.data) ? inputResult.data : {};
    const messageId = cleanString(req.body?.messageId || resultItem.messageId || inputResult.messageId || responseData.id || responseData.messageId, 100);
    const sentAt = parseDate(req.body?.sentAt || resultItem.sentAt || inputResult.sentAt || responseData.createdAt) || row.sentAt || now;
    const cancelAt = parseDate(req.body?.cancelAt || resultItem.cancelAt || inputResult.cancelAt) || row.cancelAt || null;
    const meta = jsonObject({
      ...deliveryMeta(row),
      ...inputResult,
      sendResultStatus: status,
      lastSendResultAt: now.toISOString(),
      workerDeviceId: req.body?.deviceId || row.claimedByDeviceId || null,
      messageId: messageId || row.messageId || null,
      lifecycle: status === "done" ? "waiting_reply" : "active",
    });
    const resultCode = automationResultCode(req.body || {}, meta);

    if (isSoftRetryResult(status, resultCode)) {
      const retryAt = automationRetryAt(req.body || {}, meta, resultCode === "BUMP_HOURLY_LIMIT" ? 60 * 60 * 1000 : 5 * 60 * 1000);
      const nextMeta = jsonObject({
        ...meta,
        lifecycle: "active",
        softRetry: true,
        retryReason: resultCode || status || "SOFT_RETRY",
        retryAt: retryAt.toISOString(),
        terminalAt: null,
        finalStatus: null,
      });
      const updated = await prisma.automationDelivery.updateMany({
        where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
        data: {
          status: "online_queued",
          scheduledAt: retryAt,
          sentAt: null,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          result: nextMeta,
          error: optionalString(resultCode || "soft retry; returned to queue", 2000),
        },
      });
      const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
      return res.json({ ok: true, compacted: false, requeued: true, status: "online_queued", retryAt: retryAt.toISOString(), item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: nextMeta, code: resultCode || "SOFT_RETRY" });
    }

    if (isSendUnknownResult(status, resultCode, req.body || {}, meta)) {
      const verifyAt = automationRetryAt(req.body || {}, meta, 5 * 60 * 1000);
      const nextMeta = jsonObject({
        ...meta,
        lifecycle: "send_unknown",
        sendUnknown: true,
        verifyAt: verifyAt.toISOString(),
        retryAt: verifyAt.toISOString(),
        retryReason: resultCode || status || "SEND_UNKNOWN",
        terminalAt: null,
        finalStatus: null,
      });
      const updated = await prisma.automationDelivery.updateMany({
        where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
        data: {
          status: "send_unknown",
          scheduledAt: verifyAt,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          result: nextMeta,
          error: optionalString(req.body?.error || inputResult.error || resultCode || "send result unknown; verification required", 2000),
        },
      });
      const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
      return res.json({ ok: true, compacted: false, sendUnknown: true, status: "send_unknown", verifyAt: verifyAt.toISOString(), item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: nextMeta, code: resultCode || "SEND_UNKNOWN" });
    }

    if (status === "done") {
      if (!messageId && !row.messageId) {
        // Do not create a pending_reply that cannot ever be cancelled/checked.
        // Requeue with a short delay and explicit error instead.
        const nextAt = new Date(now.getTime() + 120 * 1000);
        const updated = await prisma.automationDelivery.updateMany({
          where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
          data: {
            status: "online_queued",
            scheduledAt: nextAt,
            sentAt: null,
            claimedByDeviceId: null,
            claimedAt: null,
            claimUntil: null,
            lastCheckedAt: now,
            result: jsonObject({ ...meta, sendResultProblem: "missing_message_id", retryAt: nextAt.toISOString() }),
            error: "online send returned done without messageId; returned to queue",
          },
        });
        const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
        return res.json({ ok: true, repaired: true, requeued: true, status: "online_queued", item: item ? mapAutomationDelivery(item) : null, code: "ONLINE_SEND_DONE_WITHOUT_MESSAGE_ID" });
      }

      const updated = await prisma.automationDelivery.updateMany({
        where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
        data: {
          status: "pending_reply",
          messageId: messageId || row.messageId,
          sentAt,
          cancelAt,
          claimedByDeviceId: null,
          claimedAt: null,
          claimUntil: null,
          lastCheckedAt: now,
          result: meta,
          error: null,
        },
      });
      const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
      return res.json({ ok: true, compacted: false, status: "pending_reply", item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: meta });
    }

    if (status === "skipped") {
      const final = await markAutomationDeliveryTerminal({ req, creatorId, row, status: "skipped", input: { ...(req.body || {}), result: meta }, source: "online_send_result_skipped" });
      return res.json({ ...final, deliveryId: row.id });
    }

    const attempts = Math.max(0, Number(row.attempts || 0));
    const maxAttempts = Math.max(1, Math.min(50, Number(row.maxAttempts || 5)));
    if (attempts >= maxAttempts) {
      const final = await markAutomationDeliveryTerminal({ req, creatorId, row, status: "failed", input: { ...(req.body || {}), result: meta }, source: "online_send_result_max_attempts" });
      return res.json({ ...final, deliveryId: row.id, maxAttemptsReached: true });
    }

    const retryAt = new Date(now.getTime() + Math.min(15 * 60 * 1000, Math.max(30 * 1000, attempts * 60 * 1000)));
    const updated = await prisma.automationDelivery.updateMany({
      where: { id: row.id, agencyId: req.auth.agencyId, creatorId },
      data: {
        status: "online_queued",
        scheduledAt: retryAt,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        lastCheckedAt: now,
        result: jsonObject({ ...meta, retryAt: retryAt.toISOString(), retryReason: status || "failed" }),
        error: optionalString(req.body?.error || inputResult.error || inputResult.code || "online send failed; returned to queue", 2000),
      },
    });
    const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
    return res.json({ ok: true, compacted: false, requeued: true, status: "online_queued", retryAt: retryAt.toISOString(), item: item ? mapAutomationDelivery(item) : null, deliveryId: row.id, result: meta });
  } catch (err) { return sendError(res, err, "BUMP_ONLINE_RESULT_FAILED"); }
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
        await markAutomationDeliveryTerminal({
          req,
          creatorId,
          row: candidate,
          status: "failed",
          input: { result: { reason: "cancel_max_attempts", attempts, maxAttempts }, failedAt: now.toISOString() },
          source: "cancel_claim_max_attempts",
        }).catch(() => null);
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
      return res.json({ ok: true, alreadyCompacted: true, item: null, code: "DELIVERY_NOT_FOUND_OR_ALREADY_TERMINAL" });
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
      const final = await markAutomationDeliveryTerminal({ req, creatorId, row: existing, status, input: { ...(req.body || {}), result: mergedResult }, source: "cancel_result_terminal" });
      return res.json({ ...final, deliveryId: existing.id, templateId: deliveryTemplateId(existing) });
    }

    // Non-terminal result means transient failure / release lease back into queue.
    const nextStatus = status === "cancel_claimed" ? "cancel_claimed" : "pending_reply";
    const updated = await prisma.automationDelivery.updateMany({
      where: { id: existing.id, agencyId: req.auth.agencyId, creatorId },
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
    const item = updated.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: existing.id } }).catch(() => null) : null;
    return res.json({ ok: true, compacted: false, item: item ? mapAutomationDelivery(item) : null, released: nextStatus === "pending_reply" });
  } catch (err) { return sendError(res, err, "BUMP_CANCEL_RESULT_FAILED"); }
});

// Hidden online is intentionally server-owned: desktop workers only claim scan
// chunks and upload compact candidate rows. We keep one mutable row per fan in
// HiddenOnlineUser and reuse AutomationDelivery as the distributed job/queue
// table, so no local-only state and no event-log explosion.
const HIDDEN_SCAN_STATUSES = ["hidden_scan_queued", "hidden_scan_claimed", "hidden_scan_paused"];

function hiddenScanJobId(creatorId) {
  return `hidden_scan_${String(creatorId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90)}`;
}

function hiddenScanState(row = {}) {
  const meta = deliveryMeta(row);
  const rawStatus = String(row?.status || "").toLowerCase();
  const out = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};

  // Expose server job status to desktop UI. The previous version returned only
  // row.result, so freshly queued/claimed jobs could look idle until the first
  // progress page was posted. Hidden scan is server-owned, so the visible
  // progress state must reflect AutomationDelivery.status too.
  if (!out.status) {
    if (rawStatus === "hidden_scan_claimed") out.status = "running";
    else if (rawStatus === "hidden_scan_queued") out.status = "queued";
    else if (rawStatus === "hidden_scan_paused") out.status = "paused";
    else if (rawStatus === "hidden_scan_done") out.status = "done";
    else if (rawStatus === "failed") out.status = "failed";
    else if (rawStatus) out.status = rawStatus;
    else out.status = "idle";
  }

  out.serverStatus = rawStatus || out.serverStatus || null;
  if (row?.id && !out.jobId) out.jobId = row.id;
  if (row?.scheduledAt && !out.nextScanAt) out.nextScanAt = row.scheduledAt.toISOString ? row.scheduledAt.toISOString() : row.scheduledAt;
  if (row?.claimedByDeviceId && !out.claimedByDeviceId) out.claimedByDeviceId = row.claimedByDeviceId;
  if (row?.claimUntil && !out.claimUntil) out.claimUntil = row.claimUntil.toISOString ? row.claimUntil.toISOString() : row.claimUntil;
  if (row?.lastCheckedAt && !out.lastCheckedAt) out.lastCheckedAt = row.lastCheckedAt.toISOString ? row.lastCheckedAt.toISOString() : row.lastCheckedAt;
  if (row?.error && !out.lastError) out.lastError = row.error;

  return out;
}

function hiddenCandidateStatus(value) {
  const s = cleanString(value || "active", 40).toLowerCase() || "active";
  if (["ignored", "blocked", "removed", "excluded"].includes(s)) return s;
  if (["queued", "cooling", "eligible"].includes(s)) return "active";
  return "active";
}

function hiddenCandidateCompact(input = {}) {
  const fanId = cleanString(input.fanId || input.userId || input.id || input.dialogId, 80);
  if (!fanId) return null;
  const metadata = jsonObject(input.metadata || {});
  const now = new Date().toISOString();
  return {
    fanId,
    dialogId: optionalString(input.dialogId || input.withUserId || fanId, 80),
    username: optionalString(input.username || input.fanUsername, 120),
    name: optionalString(input.name || input.fanName || input.displayName, 180),
    totalSpentCents: Number(input.totalSpentCents || input.spendTotalCents || input.spentCents || 0) || 0,
    status: hiddenCandidateStatus(input.status),
    lastSignalAt: parseDate(input.lastSignalAt || input.lastScannedAt || input.scannedAt) || new Date(),
    metadata: {
      ...metadata,
      source: metadata.source || input.source || "hidden_online_scan",
      reason: metadata.reason || input.reason || "hidden lastSeen=null",
      lastScannedAt: input.lastScannedAt || input.scannedAt || now,
      lastSeen: input.lastSeen === undefined ? (metadata.lastSeen ?? null) : input.lastSeen,
      canReceiveChatMessage: input.canReceiveChatMessage ?? metadata.canReceiveChatMessage ?? null,
      lastOutgoingAt: input.lastOutgoingAt || metadata.lastOutgoingAt || null,
      lastIncomingAt: input.lastIncomingAt || metadata.lastIncomingAt || null,
      nextEligibleAt: input.nextEligibleAt || metadata.nextEligibleAt || null,
      lastHiddenQueuedAt: input.lastHiddenQueuedAt || metadata.lastHiddenQueuedAt || null,
      hiddenCadenceHours: Number(input.hiddenCadenceHours || metadata.hiddenCadenceHours || 3) || 3,
    },
  };
}

async function upsertHiddenCandidateRows({ agencyId, creatorId, items = [], scanJobId = null }) {
  const out = { inserted: 0, updated: 0, items: [] };
  for (const raw of Array.isArray(items) ? items : []) {
    const item = hiddenCandidateCompact(raw);
    if (!item?.fanId) continue;
    const existing = await prisma.hiddenOnlineUser.findUnique({ where: { creatorId_fanId: { creatorId, fanId: item.fanId } } }).catch(() => null);
    const prevMeta = existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata : {};
    const status = existing && ["ignored", "blocked", "removed", "excluded"].includes(String(existing.status || ""))
      ? existing.status
      : item.status;
    const saved = await prisma.hiddenOnlineUser.upsert({
      where: { creatorId_fanId: { creatorId, fanId: item.fanId } },
      create: {
        agencyId,
        creatorId,
        fanId: item.fanId,
        dialogId: item.dialogId,
        username: item.username,
        name: item.name,
        totalSpentCents: item.totalSpentCents,
        status,
        signals: [],
        metadata: jsonObject({ ...item.metadata, scanJobId }),
        lastSignalAt: item.lastSignalAt,
      },
      update: {
        dialogId: item.dialogId || undefined,
        username: item.username || undefined,
        name: item.name || undefined,
        totalSpentCents: raw?.totalSpentCents === undefined && raw?.spendTotalCents === undefined && raw?.spentCents === undefined ? undefined : item.totalSpentCents,
        status,
        // Keep compact. Do not append signal history here.
        signals: [],
        metadata: jsonObject({ ...prevMeta, ...item.metadata, scanJobId }),
        lastSignalAt: item.lastSignalAt,
      },
    });
    if (existing?.id) out.updated += 1; else out.inserted += 1;
    out.items.push(saved);
  }
  return out;
}

router.post("/hidden-online/scan-jobs/enqueue", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const now = new Date();
    const scanEveryDays = Math.max(1, Math.min(30, positiveInt(req.body?.scanEveryDays, 7)));
    const limit = Math.max(20, Math.min(100, positiveInt(req.body?.limit, 100)));
    const fullScan = req.body?.fullScan === true || req.body?.force === true;
    const id = hiddenScanJobId(creatorId);
    const existing = await prisma.automationDelivery.findUnique({ where: { id } }).catch(() => null);
    const prev = hiddenScanState(existing || {});
    const dueAt = existing?.scheduledAt || null;
    const manual = req.body?.manual === true;
    const due = !dueAt || dueAt <= now || manual || fullScan;

    // v19.34.9: hidden scan is one pass. A completed hasMore=false job must
    // stay done until its next scheduled scan or an explicit manual/full scan.
    // Older logic excluded hidden_scan_done from the not-due return path, so
    // every scheduler tick resurrected a completed scan and cursor/pages ran
    // away (offset 900k+ / pages 9000+ with only a few thousand scanned).
    if (existing?.id && String(existing.status || "") === "hidden_scan_done" && !due) {
      return res.json({
        ok: true,
        creatorId,
        item: mapAutomationDelivery(existing),
        queued: false,
        nextScanAt: dueAt?.toISOString?.() || prev.nextScanAt || null,
        code: "HIDDEN_SCAN_DONE_NOT_DUE",
        scanState: hiddenScanState(existing),
      });
    }

    if (existing?.id && !due && !["hidden_scan_paused", "failed"].includes(String(existing.status || ""))) {
      return res.json({ ok: true, creatorId, item: mapAutomationDelivery(existing), queued: false, nextScanAt: dueAt?.toISOString?.() || null, code: "HIDDEN_SCAN_NOT_DUE", scanState: hiddenScanState(existing) });
    }

    const prevPages = Math.max(0, Number(prev.pages || 0) || 0);
    const prevOffset = Math.max(0, Number(prev.nextOffset || prev.offset || 0) || 0);
    const prevScanned = Math.max(0, Number(prev.scanned || 0) || 0);
    const runawayCursor = (prevPages >= 2000 || prevOffset >= 200000) && (prevOffset <= 0 || (prevScanned / prevOffset) < 0.25);

    const state = jsonObject({
      ...prev,
      hiddenScan: true,
      scanEveryDays,
      limit,
      sourceType: cleanString(req.body?.type || req.body?.subscriberType || prev.sourceType || "all", 40) || "all",
      nextOffset: (fullScan || runawayCursor) ? 0 : Math.max(0, Number(prev.nextOffset || 0) || 0),
      fullScan,
      manual,
      repairedRunawayCursor: runawayCursor || undefined,
      enqueuedAt: now.toISOString(),
      lastError: null,
    });
    const hiddenScanData = {
      id,
      agencyId: req.auth.agencyId,
      creatorId,
      fanId: "__hidden_scan__",
      trigger: "hidden_online_scan",
      status: "hidden_scan_queued",
      scheduledAt: now,
      maxAttempts: 100000,
      result: state,
      createdByUserId: req.auth.userId || null,
    };
    const hiddenScanUpdate = {
      status: "hidden_scan_queued",
      scheduledAt: now,
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      error: null,
      result: state,
    };
    const updatedScan = await prisma.automationDelivery.updateMany({
      where: { id, agencyId: req.auth.agencyId, creatorId },
      data: hiddenScanUpdate,
    });
    const item = updatedScan.count > 0
      ? await prisma.automationDelivery.findUnique({ where: { id } })
      : await createAutomationDeliverySafe(hiddenScanData);
    return res.json({ ok: true, creatorId, queued: true, item: mapAutomationDelivery(item), scanState: hiddenScanState(item) });
  } catch (err) { return sendError(res, err, "HIDDEN_SCAN_ENQUEUE_FAILED"); }
});

router.post("/hidden-online/scan-jobs/claim", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const deviceId = cleanString(req.body?.deviceId || req.body?.claimedByDeviceId || "unknown", 120) || "unknown";
    const timeoutSec = Math.max(60, Math.min(3600, positiveInt(req.body?.claimTimeoutSec, 300)));
    const now = new Date();
    const claimUntil = new Date(now.getTime() + timeoutSec * 1000);

    await prisma.automationDelivery.updateMany({
      where: { agencyId: req.auth.agencyId, creatorId, status: "hidden_scan_claimed", OR: [{ claimUntil: { lt: now } }, { claimUntil: null, updatedAt: { lt: new Date(now.getTime() - timeoutSec * 1000) } }] },
      data: { status: "hidden_scan_queued", claimedByDeviceId: null, claimedAt: null, claimUntil: null, error: "hidden scan claim expired; returned to queue" },
    }).catch(() => null);

    const row = await prisma.automationDelivery.findFirst({
      where: { agencyId: req.auth.agencyId, creatorId, status: "hidden_scan_queued", scheduledAt: { lte: now }, trigger: "hidden_online_scan" },
      orderBy: [{ scheduledAt: "asc" }, { updatedAt: "asc" }],
    });
    if (!row) {
      const next = await prisma.automationDelivery.findFirst({ where: { agencyId: req.auth.agencyId, creatorId, trigger: "hidden_online_scan" }, orderBy: { scheduledAt: "asc" } });
      return res.json({ ok: true, creatorId, count: 0, items: [], item: null, nextScanAt: next?.scheduledAt ? next.scheduledAt.toISOString() : null });
    }
    const claimed = await prisma.automationDelivery.updateMany({
      where: { id: row.id, agencyId: req.auth.agencyId, creatorId, status: "hidden_scan_queued" },
      data: { status: "hidden_scan_claimed", claimedByDeviceId: deviceId, claimedAt: now, claimUntil, lastCheckedAt: now, attempts: { increment: 1 }, error: null },
    });
    if (claimed.count <= 0) return res.json({ ok: true, creatorId, count: 0, items: [], item: null, code: "HIDDEN_SCAN_CLAIM_RACE_LOST" });
    const updated = await prisma.automationDelivery.findUnique({ where: { id: row.id } });
    return res.json({ ok: true, creatorId, count: 1, item: mapAutomationDelivery(updated), items: [mapAutomationDelivery(updated)], scanState: hiddenScanState(updated), claimUntil });
  } catch (err) { return sendError(res, err, "HIDDEN_SCAN_CLAIM_FAILED"); }
});

router.post("/hidden-online/scan-jobs/progress", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const id = cleanString(req.body?.jobId || req.body?.id || hiddenScanJobId(creatorId), 120);
    const now = new Date();
    const row = await prisma.automationDelivery.findFirst({ where: { id, agencyId: req.auth.agencyId, creatorId, trigger: "hidden_online_scan" } });
    if (!row) return res.status(404).json({ ok: false, code: "HIDDEN_SCAN_JOB_NOT_FOUND", error: "Hidden scan job not found" });
    const prev = hiddenScanState(row);
    const upsert = await upsertHiddenCandidateRows({ agencyId: req.auth.agencyId, creatorId, items: req.body?.items || req.body?.candidates || [], scanJobId: row.id });
    const scanned = Number(prev.scanned || 0) + Math.max(0, Number(req.body?.scanned || req.body?.pageSize || 0) || 0);
    const hiddenSeen = Number(prev.hiddenSeen || 0) + Math.max(0, Number(req.body?.hiddenSeen || upsert.items.length || 0) || 0);
    const pages = Number(prev.pages || 0) + Math.max(1, Number(req.body?.pages || 1) || 1);
    const hasMore = req.body?.hasMore === true;
    const done = req.body?.done === true || hasMore === false;
    const scanEveryDays = Math.max(1, Math.min(30, positiveInt(req.body?.scanEveryDays || prev.scanEveryDays, 7)));
    const nextOffset = Math.max(0, Number(req.body?.nextOffset ?? prev.nextOffset ?? 0) || 0);
    const errorText = cleanString(req.body?.error || "", 2000);
    const pauseForPriority = req.body?.pauseForPriority === true;
    const requestedBackoffMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(req.body?.backoffMs || req.body?.priorityPauseMs || 0) || 0));
    const runtimeAuthMissing = Boolean(errorText && /runtime auth context.*missing|auth context.*missing|runtime context.*missing/i.test(errorText)) || String(req.body?.workerStatus || "").toLowerCase().includes("auth_context_wait");
    const authBackoffMs = errorText && !runtimeAuthMissing && /invalid|expired|access token|auth|unauthorized|forbidden/i.test(errorText) ? 10 * 60 * 1000 : 0;
    const runtimeAuthBackoffMs = runtimeAuthMissing ? 5 * 60 * 1000 : 0;
    const browserBackoffMs = errorText && /browser tab.*not found|tab for account.*not found|account browser page.*not on onlyfans|page is not on onlyfans/i.test(errorText) ? 15 * 60 * 1000 : 0;
    const browserMissing = browserBackoffMs > 0 || String(req.body?.workerStatus || "").toLowerCase().includes("browser_tab_missing");
    const backoffMs = done ? 0 : Math.max(requestedBackoffMs, runtimeAuthBackoffMs, authBackoffMs, browserBackoffMs, pauseForPriority ? 45 * 1000 : 0);
    const stateStatus = done ? "done" : (backoffMs > 0 ? "cooldown" : "queued");
    const workerStatus = cleanString(req.body?.workerStatus || (runtimeAuthMissing ? "auth_context_wait" : browserMissing ? "browser_tab_missing" : pauseForPriority ? "paused_for_bumps" : (errorText ? "error_backoff" : "queued")), 80);
    const nextScheduledAt = done
      ? new Date(now.getTime() + scanEveryDays * 24 * 60 * 60 * 1000)
      : new Date(now.getTime() + (backoffMs > 0 ? backoffMs : 1000));
    const state = jsonObject({
      ...prev,
      scanned,
      hiddenSeen,
      inserted: Number(prev.inserted || 0) + upsert.inserted,
      updated: Number(prev.updated || 0) + upsert.updated,
      pages,
      nextOffset,
      hasMore,
      status: stateStatus,
      workerStatus,
      serverStatus: done ? "hidden_scan_done" : "hidden_scan_queued",
      claimedByDeviceId: null,
      claimedAt: null,
      claimUntil: null,
      // Do not keep a stale `local_bump_queue` pause reason after the page
      // finished. The UI used that stale reason to show a fake waiting-worker
      // state even while the scheduler was correctly processing scan pages.
      pauseReason: runtimeAuthMissing ? "runtime_auth_context_missing" : browserMissing ? "browser_tab_missing" : (pauseForPriority ? "local_bump_queue" : null),
      pausedForPriority: pauseForPriority || false,
      backoffMs: backoffMs || undefined,
      nextPageAt: done ? null : nextScheduledAt.toISOString(),
      nextScanAt: done ? nextScheduledAt.toISOString() : null,
      lastPageAt: now.toISOString(),
      finishedAt: done ? now.toISOString() : prev.finishedAt || null,
      lastError: errorText || null,
    });
    const progressed = await prisma.automationDelivery.updateMany({
      where: { id: row.id, agencyId: req.auth.agencyId, creatorId, trigger: "hidden_online_scan" },
      data: {
        status: done ? "hidden_scan_done" : "hidden_scan_queued",
        scheduledAt: nextScheduledAt,
        claimedByDeviceId: null,
        claimedAt: null,
        claimUntil: null,
        lastCheckedAt: now,
        result: state,
        error: req.body?.error ? optionalString(req.body.error, 2000) : null,
      },
    });
    const item = progressed.count > 0 ? await prisma.automationDelivery.findUnique({ where: { id: row.id } }).catch(() => null) : null;
    const counts = await prisma.hiddenOnlineUser.groupBy({ by: ["status"], where: { agencyId: req.auth.agencyId, creatorId }, _count: { _all: true } }).catch(() => []);
    return res.json({ ok: true, creatorId, item: item ? mapAutomationDelivery(item) : null, scanState: hiddenScanState(item), upsert, counts, nextScanAt: nextScheduledAt.toISOString(), raceLost: progressed.count <= 0 });
  } catch (err) { return sendError(res, err, "HIDDEN_SCAN_PROGRESS_FAILED"); }
});

router.get("/hidden-online/scan-state", async (req, res) => {
  try {
    const creatorId = cleanString(req.query.creatorId || req.query.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const job = await prisma.automationDelivery.findUnique({ where: { id: hiddenScanJobId(creatorId) } }).catch(() => null);
    const [total, active, ignored, blocked] = await Promise.all([
      prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId } }),
      prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "active" } }),
      prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "ignored" } }),
      prisma.hiddenOnlineUser.count({ where: { agencyId: req.auth.agencyId, creatorId, status: "blocked" } }),
    ]);
    return res.json({ ok: true, creatorId, item: mapAutomationDelivery(job), scanState: hiddenScanState(job || {}), counts: { total, active, ignored, blocked } });
  } catch (err) { return sendError(res, err, "HIDDEN_SCAN_STATE_FAILED"); }
});

router.post("/hidden-online/queue-eligible", async (req, res) => {
  try {
    const creatorId = cleanString(req.body?.creatorId || req.body?.accountId || req.query?.creatorId || req.query?.accountId, 100);
    await requireCreator(prisma, req.auth.agencyId, creatorId);
    const now = new Date();
    const range = onlineSpacingRange(req.body || {});
    const limit = Math.max(1, Math.min(200, positiveInt(req.body?.limit, 50)));
    const cadenceHours = Math.max(1, Math.min(168, Number(req.body?.cadenceHours || req.body?.hiddenCadenceHours || 3) || 3));
    const replyTimeoutHours = Math.max(1, Math.min(24, Number(req.body?.replyTimeoutHours || req.body?.hiddenReplyTimeoutHours || 1) || 1));

    const candidates = await prisma.hiddenOnlineUser.findMany({
      where: { agencyId: req.auth.agencyId, creatorId, status: "active" },
      orderBy: [{ lastSignalAt: "desc" }, { updatedAt: "desc" }],
      take: Math.max(limit * 5, limit),
    });
    const activeRows = await prisma.automationDelivery.findMany({
      where: { agencyId: req.auth.agencyId, creatorId, fanId: { in: candidates.map((x) => x.fanId) }, status: { in: ONLINE_SEND_ACTIVE_STATUSES } },
      select: { fanId: true, status: true },
    });
    const activeByFan = new Map(activeRows.map((x) => [String(x.fanId), x]));
    const picked = [];
    const skipped = [];
    for (const c of candidates) {
      if (picked.length >= limit) break;
      const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata : {};
      const nextEligibleAt = parseDate(meta.nextEligibleAt || meta.hiddenNextEligibleAt || null);
      if (nextEligibleAt && nextEligibleAt > now) { skipped.push({ fanId: c.fanId, code: "COOLING", nextEligibleAt: nextEligibleAt.toISOString() }); continue; }
      if (activeByFan.has(String(c.fanId))) { skipped.push({ fanId: c.fanId, code: "ACTIVE_OR_ALREADY_QUEUED", status: activeByFan.get(String(c.fanId))?.status || null }); continue; }
      picked.push(c);
    }

    if (!picked.length) return res.json({ ok: true, creatorId, count: 0, items: [], skipped, code: "NO_ELIGIBLE_HIDDEN_ONLINE" });

    const result = await prisma.$transaction(async (tx) => {
      const gate = await acquireOnlineGate(tx, { agencyId: req.auth.agencyId, creatorId, now });
      let cursor = onlineGateNextAllowed(gate, now);
      const items = [];
      for (const c of picked) {
        const scheduledAt = new Date(Math.max(cursor.getTime(), now.getTime()));
        const meta = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata : {};
        const item = await tx.automationDelivery.create({
          data: {
            agencyId: req.auth.agencyId,
            creatorId,
            fanId: c.fanId,
            dialogId: c.dialogId || c.fanId,
            trigger: BUMP_TRIGGER_KEYS.HIDDEN,
            status: "online_queued",
            scheduledAt,
            maxAttempts: 3,
            result: jsonObject({
              eventQueue: true,
              hiddenOnlineQueue: true,
              triggerKey: BUMP_TRIGGER_KEYS.HIDDEN,
              trigger: BUMP_TRIGGER_KEYS.HIDDEN,
              eventType: "hidden_online_candidate",
              sourceCandidateId: c.id,
              reason: meta.reason || "hidden online candidate",
              replyTimeoutHours,
              hiddenReplyTimeoutHours: replyTimeoutHours,
              hiddenCadenceHours: cadenceHours,
              minFanSpacingSec: range.min,
              maxFanSpacingSec: range.max,
              queuedAt: now.toISOString(),
            }),
            createdByUserId: req.auth.userId || null,
          },
        });
        items.push(item);
        const nextEligibleAt = new Date(now.getTime() + cadenceHours * 60 * 60 * 1000).toISOString();
        await tx.hiddenOnlineUser.update({
          where: { id: c.id },
          data: { metadata: jsonObject({ ...meta, lastHiddenQueuedAt: now.toISOString(), nextEligibleAt, hiddenCadenceHours: cadenceHours, hiddenReplyTimeoutHours: replyTimeoutHours }) },
        });
        cursor = new Date(scheduledAt.getTime() + randomOnlineSpacingMs(range));
      }
      await tx.automationDelivery.update({
        where: { id: gate.id },
        data: { scheduledAt: cursor, result: jsonObject({ ...deliveryMeta(gate), eventGate: true, onlineGate: true, nextAllowedAt: cursor.toISOString(), minFanSpacingSec: range.min, maxFanSpacingSec: range.max, updatedAt: now.toISOString() }) },
      });
      return { items, gateNextAllowedAt: cursor };
    }, { timeout: 15000 });

    return res.json({ ok: true, creatorId, triggerKey: BUMP_TRIGGER_KEYS.HIDDEN, count: result.items.length, items: result.items.map(mapAutomationDelivery), skipped, skippedCount: skipped.length, gateNextAllowedAt: result.gateNextAllowedAt.toISOString(), minFanSpacingSec: range.min, maxFanSpacingSec: range.max, cadenceHours, replyTimeoutHours });
  } catch (err) { return sendError(res, err, "HIDDEN_ONLINE_QUEUE_ELIGIBLE_FAILED"); }
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

    // Сводки: всего и по шаблону. sentToday/repliedToday are UTC-day buckets,
    // the same compact source used by bump list counters.
    const today = new Date().toISOString().slice(0, 10);
    const totals = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0 };
    const byTemplate = {};
    for (const r of rows) {
      for (const k of ["sent", "replied", "canceled", "expired", "failed"]) totals[k] += r[k] || 0;
      if (r.day === today) {
        totals.sentToday += r.sent || 0;
        totals.repliedToday += r.replied || 0;
      }
      const t = r.templateId || "";
      if (!byTemplate[t]) byTemplate[t] = { templateId: t, sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0 };
      for (const k of ["sent", "replied", "canceled", "expired", "failed"]) byTemplate[t][k] += r[k] || 0;
      if (r.day === today) {
        byTemplate[t].sentToday += r.sent || 0;
        byTemplate[t].repliedToday += r.replied || 0;
      }
    }
    const rate = (rep, sent) => (sent > 0 ? Math.round((rep / sent) * 10000) / 100 : 0);
    totals.replyRate = rate(totals.replied, totals.sent);
    const perTemplate = Object.values(byTemplate).map((t) => ({ ...t, replyRate: rate(t.replied, t.sent) }))
      .sort((a, b) => b.replyRate - a.replyRate);

    return res.json({ ok: true, totals, perTemplate, days: rows });
  } catch (err) { return sendError(res, err, "BUMP_STATS_READ_FAILED"); }
});

module.exports = router;
