"use strict";

const prisma = require("../prisma");
const {
  cleanString,
  optionalString,
  boolValue,
  clampInt,
  safeDate,
  compactJson,
  parseLimit: sharedParseLimit,
  parseOffset: sharedParseOffset,
  requireCreator: sharedRequireCreator,
} = require("./server-store-utils");
const { classifyProgrammaticCustomMediaProvenance } = require("./custom-content-delivery-service");

const TASK_TYPE_ALIASES = Object.freeze({
  winback: "sfs_hunter",
  sfshunter: "sfs_hunter",
  sfs: "sfs_hunter",
  sfs_hunter: "sfs_hunter",
});

const TASK_TYPES = new Set([
  "bump_online",
  "hidden_online_scan",
  "hidden_online_list_sync",
  "follow_back",
  "sfs_hunter",
  "sfs_comment",
  "ai_chatter",
  "social_action",
  "custom",
]);

const EVENT_STATUSES = new Set(["info", "ok", "failed", "skipped", "warning"]);
const BUMP_TRASH_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_CACHE_TTL_MS = 30 * 1000;
const EVENTS_CACHE_TTL_MS = 15 * 1000;
const activityCache = new Map();
const eventsCache = new Map();

function addDaysIso(date, days) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const ms = Number.isFinite(d.getTime()) ? d.getTime() : Date.now();
  return new Date(ms + Math.max(0, Number(days || 0)) * DAY_MS).toISOString();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanJsonForPrisma(value = {}, max = 4000) {
  return compactJson(value && typeof value === "object" && !Array.isArray(value) ? value : {}, max);
}

function clean(value, max = 5000) {
  return cleanString(value, max);
}

function optional(value, max = 5000) {
  return optionalString(value, max);
}

function normalizeTaskType(value) {
  const type = clean(value || "custom", 80).toLowerCase() || "custom";
  const normalized = TASK_TYPE_ALIASES[type] || type;
  return TASK_TYPES.has(normalized) ? normalized : "custom";
}

function normalizeStatus(value, fallback = "active") {
  const status = clean(value || fallback, 40).toLowerCase() || fallback;
  if (["active", "paused", "archived", "deleted"].includes(status)) return status;
  return fallback;
}

async function requireCreator(agencyId, creatorId) {
  const id = clean(creatorId, 100);
  if (!id) return null;
  return sharedRequireCreator(prisma, agencyId, id);
}

function parseLimit(value, fallback = 100, max = 1000) {
  return sharedParseLimit(value, fallback, max);
}

function parseOffset(value) {
  return sharedParseOffset(value);
}

function normalizeTaskInput(input = {}, { agencyId, userId, patch = false } = {}) {
  const data = {};
  if (!patch || input.type !== undefined) data.type = normalizeTaskType(input.type);
  if (!patch || input.title !== undefined || input.name !== undefined) data.title = clean(input.title || input.name || "Untitled automation", 180) || "Untitled automation";
  if (!patch || input.enabled !== undefined) data.enabled = boolValue(input.enabled, true);
  if (!patch || input.status !== undefined) data.status = normalizeStatus(input.status, data.enabled === false ? "paused" : "active");
  if (!patch || input.creatorId !== undefined || input.accountId !== undefined) data.creatorId = optional(input.creatorId || input.accountId, 100);
  if (!patch || input.clientId !== undefined || input.id !== undefined) data.clientId = optional(input.clientId || input.id, 120);
  if (!patch || input.config !== undefined) data.config = compactJson(input.config || {}, 16000);
  if (!patch || input.triggers !== undefined) data.triggers = compactJson(input.triggers || {}, 8000);
  if (!patch || input.rules !== undefined) data.rules = compactJson(input.rules || {}, 8000);
  if (!patch || input.schedule !== undefined) data.schedule = compactJson(input.schedule || {}, 8000);
  if (!patch || input.stats !== undefined) data.stats = compactJson(input.stats || {}, 8000);
  if (!patch || input.metadata !== undefined) data.metadata = compactJson(input.metadata || {}, 4000);

  if (!patch) {
    data.agencyId = agencyId;
    data.createdByUserId = userId || null;
  }
  data.updatedByUserId = userId || null;
  return data;
}


function bumpMediaIds(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const raw = item && typeof item === "object" ? (row.id ?? row.mediaId ?? row.media_id ?? row.fileId) : item;
    const id = cleanString(raw, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  return out;
}

async function assertReusableBumpMediaAllowed({ agencyId, creatorId, media, db = prisma }) {
  const ids = bumpMediaIds(media);
  for (let offset = 0; offset < ids.length; offset += 200) {
    const result = await classifyProgrammaticCustomMediaProvenance({
      agencyId, creatorId, mediaIds: ids.slice(offset, offset + 200), db,
    });
    if (!result?.ok || !Array.isArray(result.customMediaIds)) {
      throw automationTaskError("AUTOMATION_BUMP_MEDIA_PROVENANCE_INCOMPLETE", "Bump media provenance check returned an incomplete result", 503);
    }
    if (result.customMediaIds.length) {
      const err = automationTaskError("AUTOMATION_BUMP_CUSTOM_MEDIA_FORBIDDEN", "CUSTOM media cannot be saved or restored as reusable automation bump content", 409);
      err.customMediaIds = [...new Set(result.customMediaIds.map(String))];
      throw err;
    }
  }
}
function normalizeBumpToTask(input = {}, accountId = null) {
  const id = clean(input.id || input.clientId, 120);
  const title = clean(input.title || input.messageText || input.text || "Bump", 180) || "Bump";
  const triggers = input.triggers && typeof input.triggers === "object" ? input.triggers : { fanOnline: true };
  const rules = input.rules && typeof input.rules === "object" ? input.rules : {};
  const media = Array.isArray(input.media) ? input.media : Array.isArray(input.mediaFiles) ? input.mediaFiles : [];
  const trashedAt = input.trashedAt || input.deletedAt || null;
  const purgeAfter = input.purgeAfter || (trashedAt ? addDaysIso(trashedAt, BUMP_TRASH_RETENTION_DAYS) : null);
  const config = {
    schemaVersion: input.schemaVersion || 1,
    messageText: clean(input.messageText || input.text || "", 12000),
    price: Number(input.price || 0) || 0,
    priceCents: clampInt(input.priceCents, Math.round((Number(input.price || 0) || 0) * 100), 0),
    currency: clean(input.currency || "USD", 12).toUpperCase() || "USD",
    media,
  };
  return {
    id: id || undefined,
    clientId: id || undefined,
    creatorId: accountId || input.creatorId || input.accountId || null,
    type: "bump_online",
    title,
    enabled: input.enabled !== false && !trashedAt,
    status: trashedAt ? "deleted" : (input.enabled === false ? "paused" : "active"),
    config,
    triggers,
    rules,
    stats: input.stats || {},
    metadata: cleanJsonForPrisma({
      ...(toPlainObject(input.metadata)),
      legacyBump: true,
      createdAt: input.createdAt || null,
      updatedAt: input.updatedAt || null,
      trashedAt,
      purgeAfter,
      trashRetentionDays: BUMP_TRASH_RETENTION_DAYS,
    }),
  };
}


function statTemplateKeysForTask(task = {}) {
  return Array.from(new Set([
    clean(task.clientId, 120),
    clean(task.id, 120),
  ].filter(Boolean)));
}

function todayKeyUtc() {
  return new Date().toISOString().slice(0, 10);
}


function liveDeliverySentStatAlreadyCounted(row = {}) {
  const meta = toPlainObject(row?.result || {});
  if (meta.sentStatCounted === true || meta.serverSentStatCounted === true) return true;
  if (meta.statCounted === true || meta.statCounted === "sent") return true;
  const events = toPlainObject(meta.statEvents || {});
  return events.sent === true;
}

function syntheticStatRowsFromLiveDeliveries(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id || liveDeliverySentStatAlreadyCounted(row)) continue;
    if (!row.messageId && !row.sentAt) continue;
    const templateId = clean(row.contentCollectionId || "", 120);
    if (!templateId) continue;
    const day = row.sentAt instanceof Date && Number.isFinite(row.sentAt.getTime())
      ? row.sentAt.toISOString().slice(0, 10)
      : todayKeyUtc();
    const key = `${templateId}:${day}`;
    const prev = byKey.get(key) || { templateId, day, sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0 };
    prev.sent += 1;
    byKey.set(key, prev);
  }
  return Array.from(byKey.values());
}

function mergeBumpStatRows(baseStats = {}, rows = []) {
  const today = todayKeyUtc();
  const stats = toPlainObject(baseStats);
  const totals = { sent: 0, replied: 0, canceled: 0, expired: 0, failed: 0, sentToday: 0, repliedToday: 0 };

  for (const row of Array.isArray(rows) ? rows : []) {
    const sent = Number(row?.sent || 0);
    const replied = Number(row?.replied || 0);
    totals.sent += sent;
    totals.replied += replied;
    totals.canceled += Number(row?.canceled || 0);
    totals.expired += Number(row?.expired || 0);
    totals.failed += Number(row?.failed || 0);
    if (String(row?.day || "") === today) {
      totals.sentToday += sent;
      totals.repliedToday += replied;
    }
  }

  if (rows && rows.length) {
    stats.sent = totals.sent;
    stats.replied = totals.replied;
    stats.canceled = totals.canceled;
    stats.expired = totals.expired;
    stats.failed = totals.failed;
    stats.sentToday = totals.sentToday;
    stats.sent24h = totals.sentToday;
    stats.repliedToday = totals.repliedToday;
    stats.replies24h = totals.repliedToday;
    stats.replyRate = totals.sent > 0 ? Math.round((totals.replied / totals.sent) * 10000) / 10000 : 0;
    stats.lastStatAt = stats.lastStatAt || new Date().toISOString();
  } else {
    stats.sentToday = Number(stats.sentToday || stats.sent24h || 0);
    stats.sent24h = Number(stats.sent24h || stats.sentToday || 0);
    stats.repliedToday = Number(stats.repliedToday || stats.replies24h || 0);
    stats.replies24h = Number(stats.replies24h || stats.repliedToday || 0);
  }

  return stats;
}

async function loadBumpStatsByTemplate({ agencyId, creatorId, tasks = [] } = {}) {
  const keys = Array.from(new Set((tasks || []).flatMap(statTemplateKeysForTask))).filter(Boolean);
  if (!agencyId || !keys.length) return new Map();
  const where = { agencyId, templateId: { in: keys } };
  const cid = clean(creatorId, 100);
  if (cid) where.creatorId = cid;
  const [rows, liveRows] = await Promise.all([
    prisma.bumpDeliveryStat.findMany({ where , take: 10000}).catch(() => []),
    prisma.automationDelivery.findMany({
      where: {
        agencyId,
        originKind: "AUTOMATION",
        ...(cid ? { creatorId: cid } : {}),
        contentCollectionId: { in: keys },
        status: { in: ["sent", "pending_reply", "checking_reply", "cancel_claimed"] },
        OR: [{ messageId: { not: null } }, { sentAt: { not: null } }],
      },
      select: { id: true, contentCollectionId: true, sentAt: true, messageId: true, result: true },
      take: 50000,
    }).catch(() => []),
  ]);
  const byTemplate = new Map();
  for (const row of [...(rows || []), ...syntheticStatRowsFromLiveDeliveries(liveRows || [])]) {
    const key = clean(row.templateId, 120);
    if (!key) continue;
    if (!byTemplate.has(key)) byTemplate.set(key, []);
    byTemplate.get(key).push(row);
  }
  return byTemplate;
}

function taskToBumpWithStats(task, statsRows = []) {
  const bump = taskToBump(task);
  bump.stats = mergeBumpStatRows(bump.stats || {}, statsRows || []);
  return bump;
}

function taskToBump(task) {
  const config = task?.config && typeof task.config === "object" ? task.config : {};
  const rules = task?.rules && typeof task.rules === "object" ? task.rules : {};
  const triggers = task?.triggers && typeof task.triggers === "object" ? task.triggers : {};
  const stats = task?.stats && typeof task.stats === "object" ? task.stats : {};
  const metadata = task?.metadata && typeof task.metadata === "object" ? task.metadata : {};
  const trashedAt = task?.deletedAt || task?.status === "deleted" ? (task.deletedAt || metadata.trashedAt || task.updatedAt) : null;
  const purgeAfter = trashedAt ? (metadata.purgeAfter || addDaysIso(trashedAt, BUMP_TRASH_RETENTION_DAYS)) : null;
  return {
    schemaVersion: Number(config.schemaVersion || 1) || 1,
    id: task.clientId || task.id,
    serverTaskId: task.id,
    accountId: task.creatorId || "",
    creatorId: task.creatorId || null,
    enabled: task.enabled === true && task.status !== "deleted" && !task.deletedAt,
    title: task.title || config.messageText?.slice?.(0, 42) || "Bump",
    messageText: clean(config.messageText || config.text || "", 12000),
    price: Number(config.price || (Number(config.priceCents || 0) / 100) || 0) || 0,
    currency: clean(config.currency || "USD", 12).toUpperCase() || "USD",
    media: Array.isArray(config.media) ? config.media : [],
    triggers,
    rules,
    stats,
    trashedAt,
    purgeAfter,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function listTasks({ agencyId, query = {} }) {
  const where = { agencyId };
  const type = clean(query.type, 80);
  const creatorId = clean(query.creatorId || query.accountId, 100);
  const status = clean(query.status, 40);
  const includeDeleted = boolValue(query.includeDeleted || query.includeTrash, false);
  if (type) where.type = normalizeTaskType(type);
  if (creatorId) where.creatorId = creatorId;
  if (status) where.status = status;
  if (!includeDeleted) where.deletedAt = null;
  const take = parseLimit(query.limit, 200, 1000);
  const skip = parseOffset(query.offset);
  const [items, count] = await Promise.all([
    prisma.automationTask.findMany({ where, orderBy: [{ updatedAt: "desc" }], take, skip }),
    prisma.automationTask.count({ where }),
  ]);
  return { ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count };
}

function automationTaskError(code, message, status = 409) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function creatorTaskWhere({ agencyId, creatorId, id = null, clientId = null, type = null } = {}) {
  const where = { agencyId };
  const cid = clean(creatorId, 100);
  if (cid) where.creatorId = cid;
  if (id) where.id = clean(id, 120);
  if (clientId) where.clientId = clean(clientId, 120);
  if (type) where.type = type;
  return where;
}

async function updateTaskWithFence({ db = prisma, where, data, notFoundCode = "AUTOMATION_TASK_NOT_FOUND" }) {
  let result;
  try {
    result = await db.automationTask.updateMany({ where, data });
  } catch (err) {
    if (err?.code === "P2002") {
      throw automationTaskError("AUTOMATION_TASK_ID_CONFLICT", "Automation task id/clientId conflicts with another creator task", 409);
    }
    throw err;
  }
  if (Number(result?.count || 0) !== 1) {
    throw automationTaskError(notFoundCode, "Automation task is outside the current creator boundary or no longer exists", 409);
  }
  return db.automationTask.findFirst({ where });
}

async function upsertTask({ agencyId, userId, input = {}, expectedCreatorId = null, db = prisma }) {
  const requestedCreatorId = clean(input.creatorId || input.accountId, 100);
  const canonicalCreatorId = clean(expectedCreatorId || requestedCreatorId, 100);
  if (expectedCreatorId && requestedCreatorId && requestedCreatorId !== canonicalCreatorId) {
    throw automationTaskError("AUTOMATION_TASK_CREATOR_MISMATCH", "Automation task creator does not match the validated creator", 409);
  }
  if (canonicalCreatorId) await sharedRequireCreator(db, agencyId, canonicalCreatorId);

  const rawId = clean(input.id || input.taskId, 120);
  const clientId = clean(input.clientId || input.id, 120);
  const canonicalInput = canonicalCreatorId
    ? { ...input, creatorId: canonicalCreatorId, accountId: canonicalCreatorId, clientId: input.clientId || input.id }
    : { ...input, clientId: input.clientId || input.id };
  const data = normalizeTaskInput(canonicalInput, { agencyId, userId });
  if (canonicalCreatorId) data.creatorId = canonicalCreatorId;
  const update = { ...data };
  delete update.agencyId;
  delete update.createdByUserId;

  let item;
  if (rawId && !rawId.startsWith("bump_") && !rawId.startsWith("local") && !rawId.startsWith("tmp")) {
    const existingById = await db.automationTask.findFirst({ where: { id: rawId, agencyId }, select: { id: true, creatorId: true } });
    if (existingById) {
      if (canonicalCreatorId && String(existingById.creatorId || "") !== canonicalCreatorId) {
        throw automationTaskError("AUTOMATION_TASK_CREATOR_MISMATCH", "Automation task id belongs to another creator", 409);
      }
      const where = creatorTaskWhere({ agencyId, creatorId: canonicalCreatorId || existingById.creatorId, id: existingById.id });
      item = await updateTaskWithFence({ db, where, data: update, notFoundCode: "AUTOMATION_TASK_CREATOR_MISMATCH" });
    }
  }

  if (!item && clientId) {
    const scopedWhere = creatorTaskWhere({ agencyId, creatorId: canonicalCreatorId, clientId });
    const existingScoped = await db.automationTask.findFirst({ where: scopedWhere, select: { id: true, creatorId: true } });
    if (existingScoped) {
      const where = creatorTaskWhere({ agencyId, creatorId: canonicalCreatorId || existingScoped.creatorId, id: existingScoped.id });
      item = await updateTaskWithFence({ db, where, data: update, notFoundCode: "AUTOMATION_TASK_CREATOR_MISMATCH" });
    } else {
      const existingAgencyClient = await db.automationTask.findFirst({ where: { agencyId, clientId }, select: { id: true, creatorId: true } });
      if (existingAgencyClient) {
        if (canonicalCreatorId && String(existingAgencyClient.creatorId || "") !== canonicalCreatorId) {
          throw automationTaskError("AUTOMATION_TASK_ID_CONFLICT", "Automation task clientId already belongs to another creator", 409);
        }
        const where = creatorTaskWhere({ agencyId, creatorId: canonicalCreatorId || existingAgencyClient.creatorId, id: existingAgencyClient.id });
        item = await updateTaskWithFence({ db, where, data: update, notFoundCode: "AUTOMATION_TASK_ID_CONFLICT" });
      }
    }
  }

  if (!item) {
    try {
      item = await db.automationTask.create({ data: { ...data, clientId: data.clientId || null } });
    } catch (err) {
      if (err?.code === "P2002") {
        throw automationTaskError("AUTOMATION_TASK_ID_CONFLICT", "Automation task id/clientId conflicts with another creator task", 409);
      }
      throw err;
    }
  }
  return { ok: true, item };
}

async function patchTask({ agencyId, userId, taskId, patch = {}, creatorId = null }) {
  const id = clean(taskId, 120);
  const cid = clean(creatorId, 100);
  const existing = await prisma.automationTask.findFirst({ where: { id, agencyId } });
  if (!existing) throw automationTaskError("AUTOMATION_TASK_NOT_FOUND", "Automation task not found", 404);
  if (existing.creatorId && (!cid || String(existing.creatorId) !== cid)) {
    throw automationTaskError("AUTOMATION_TASK_CREATOR_MISMATCH", "Creator-owned task requires its canonical creator boundary", 409);
  }
  const data = normalizeTaskInput(patch, { agencyId, userId, patch: true });
  delete data.agencyId;
  delete data.createdByUserId;
  if (existing.creatorId) {
    data.creatorId = String(existing.creatorId);
  } else if (patch.creatorId !== undefined || patch.accountId !== undefined) {
    const requested = clean(patch.creatorId || patch.accountId, 100);
    if (requested) await requireCreator(agencyId, requested);
    data.creatorId = requested || null;
  }
  const where = creatorTaskWhere({ agencyId, creatorId: existing.creatorId || null, id: existing.id });
  const item = await updateTaskWithFence({ where, data, notFoundCode: "AUTOMATION_TASK_CREATOR_MISMATCH" });
  return { ok: true, item };
}

async function trashTask({ agencyId, userId, taskId, creatorId = null, permanent = false, db = prisma }) {
  const id = clean(taskId, 120);
  const cid = clean(creatorId, 100);
  const existing = await db.automationTask.findFirst({ where: { id, agencyId } });
  if (!existing) throw automationTaskError("AUTOMATION_TASK_NOT_FOUND", "Automation task not found", 404);
  if (existing.creatorId && (!cid || String(existing.creatorId) !== cid)) {
    throw automationTaskError("AUTOMATION_TASK_CREATOR_MISMATCH", "Creator-owned task is outside the requested creator boundary", 409);
  }
  const where = creatorTaskWhere({ agencyId, creatorId: existing.creatorId || null, id: existing.id });
  if (permanent) {
    const deleted = await db.automationTask.deleteMany({ where });
    if (Number(deleted?.count || 0) !== 1) throw automationTaskError("AUTOMATION_TASK_CREATOR_MISMATCH", "Automation task delete lost creator authority", 409);
    return { ok: true, deleted: true };
  }
  const deletedAt = new Date();
  const meta = toPlainObject(existing.metadata);
  const item = await updateTaskWithFence({ db,
    where,
    notFoundCode: "AUTOMATION_TASK_CREATOR_MISMATCH",
    data: {
      status: "deleted",
      enabled: false,
      deletedAt,
      updatedByUserId: userId || null,
      metadata: cleanJsonForPrisma({
        ...meta,
        trashedAt: deletedAt.toISOString(),
        purgeAfter: addDaysIso(deletedAt, BUMP_TRASH_RETENTION_DAYS),
        trashRetentionDays: BUMP_TRASH_RETENTION_DAYS,
      }),
    },
  });
  return { ok: true, item };
}

async function restoreTask({ agencyId, userId, taskId, creatorId = null, db = prisma }) {
  const id = clean(taskId, 120);
  const cid = clean(creatorId, 100);
  const existing = await db.automationTask.findFirst({ where: { id, agencyId } });
  if (!existing) throw automationTaskError("AUTOMATION_TASK_NOT_FOUND", "Automation task not found", 404);
  if (existing.creatorId && (!cid || String(existing.creatorId) !== cid)) {
    throw automationTaskError("AUTOMATION_TASK_CREATOR_MISMATCH", "Creator-owned task is outside the requested creator boundary", 409);
  }
  const meta = { ...toPlainObject(existing.metadata) };
  delete meta.trashedAt;
  delete meta.purgeAfter;
  delete meta.trashRetentionDays;
  const where = creatorTaskWhere({ agencyId, creatorId: existing.creatorId || null, id: existing.id });
  const item = await updateTaskWithFence({ db,
    where,
    notFoundCode: "AUTOMATION_TASK_CREATOR_MISMATCH",
    data: { status: "active", deletedAt: null, metadata: cleanJsonForPrisma(meta), updatedByUserId: userId || null },
  });
  return { ok: true, item };
}

async function gcExpiredBumps({ agencyId, creatorId = null } = {}) {
  const cutoff = new Date(Date.now() - BUMP_TRASH_RETENTION_DAYS * DAY_MS);
  const where = {
    agencyId,
    type: "bump_online",
    deletedAt: { lte: cutoff },
    status: "deleted",
  };
  const id = clean(creatorId, 100);
  if (id) where.creatorId = id;
  const result = await prisma.automationTask.deleteMany({ where });
  return { ok: true, deleted: result.count, cutoff, trashRetentionDays: BUMP_TRASH_RETENTION_DAYS };
}

async function listBumps({ agencyId, creatorId, query = {} }) {
  await gcExpiredBumps({ agencyId, creatorId }).catch(() => null);
  const result = await listTasks({ agencyId, query: { ...query, type: "bump_online", creatorId, includeDeleted: query.includeTrash ?? query.includeDeleted ?? true } });
  const includeTrash = query.includeTrash !== "false" && query.includeTrash !== false;
  const statRowsByTemplate = await loadBumpStatsByTemplate({ agencyId, creatorId, tasks: result.items || [] });
  const items = result.items.map((task) => {
    const keys = statTemplateKeysForTask(task);
    const rows = keys.flatMap((key) => statRowsByTemplate.get(key) || []);
    return taskToBumpWithStats(task, rows);
  }).filter((item) => includeTrash || !item.trashedAt);
  return { ok: true, accountId: String(creatorId || ""), items, count: items.length, source: "server" };
}

async function saveBump({ agencyId, userId, accountId, input = {} }) {
  const canonicalAccountId = clean(accountId, 100);
  const taskInput = normalizeBumpToTask({ ...(input || {}), creatorId: canonicalAccountId, accountId: canonicalAccountId }, canonicalAccountId);
  await assertReusableBumpMediaAllowed({ agencyId, creatorId: canonicalAccountId, media: taskInput.config?.media, db: prisma });
  const result = await upsertTask({ agencyId, userId, input: taskInput, expectedCreatorId: canonicalAccountId });
  return { ok: true, accountId: String(accountId || taskInput.creatorId || ""), item: taskToBump(result.item), task: result.item };
}

async function trashBump({ agencyId, userId, accountId, bumpId, permanent = false, restore = false }) {
  const id = clean(bumpId, 120);
  const canonicalAccountId = clean(accountId, 100);
  let task = await prisma.automationTask.findFirst({ where: { agencyId, creatorId: canonicalAccountId, OR: [{ id }, { clientId: id }], type: "bump_online" } });
  if (!task) {
    const err = new Error("Bump template not found");
    err.status = 404;
    err.code = "BUMP_NOT_FOUND";
    throw err;
  }
  if (restore) {
    const cfg = toPlainObject(task.config);
    await assertReusableBumpMediaAllowed({ agencyId, creatorId: canonicalAccountId, media: cfg.media || cfg.mediaFiles, db: prisma });
  }
  const result = restore
    ? await restoreTask({ agencyId, userId, taskId: task.id, creatorId: canonicalAccountId })
    : await trashTask({ agencyId, userId, taskId: task.id, creatorId: canonicalAccountId, permanent });
  const items = accountId ? (await listBumps({ agencyId, creatorId: accountId, query: { includeTrash: true } })).items : [];
  return { ok: true, accountId: String(accountId || task.creatorId || ""), item: result.item ? taskToBump(result.item) : null, items };
}

function normalizeSfsCommentToTask(input = {}, accountId = null) {
  const id = clean(input.id || input.clientId, 120);
  const commentText = clean(input.commentText || input.messageText || input.text || "", 5000);
  const title = clean(input.title || commentText.slice(0, 80) || "SFS comment", 180) || "SFS comment";
  const trashedAt = input.trashedAt || input.deletedAt || null;
  const dailyUseLimit = clampInt(input.dailyUseLimit || input.rules?.dailyUseLimit, 20, 1, 100);
  const weight = clampInt(input.weight || input.rules?.weight, 1, 1, 100);
  const config = {
    schemaVersion: input.schemaVersion || 1,
    templateType: "sfs_comment",
    commentText,
    // SFS comment templates are intentionally text-only. Media/price stay out
    // of this payload so future worker logic cannot accidentally treat these
    // as normal bump messages.
    media: [],
    price: 0,
    currency: "USD",
  };
  return {
    id: id || undefined,
    clientId: id || undefined,
    creatorId: accountId || input.creatorId || input.accountId || null,
    type: "sfs_comment",
    title,
    enabled: input.enabled !== false && !trashedAt,
    status: trashedAt ? "deleted" : (input.enabled === false ? "paused" : "active"),
    config,
    triggers: {},
    rules: {
      dailyUseLimit,
      weight,
      forbidSameTemplateBackToBack: input.rules?.forbidSameTemplateBackToBack !== false,
    },
    stats: input.stats || {},
    metadata: cleanJsonForPrisma({
      ...(toPlainObject(input.metadata)),
      sfsCommentTemplate: true,
      mediaDisabled: true,
      priceDisabled: true,
      createdAt: input.createdAt || null,
      updatedAt: input.updatedAt || null,
      trashedAt,
      purgeAfter: input.purgeAfter || (trashedAt ? addDaysIso(trashedAt, BUMP_TRASH_RETENTION_DAYS) : null),
      trashRetentionDays: BUMP_TRASH_RETENTION_DAYS,
    }),
  };
}

function taskToSfsComment(task = {}) {
  const cfg = toPlainObject(task.config);
  const rules = toPlainObject(task.rules);
  const meta = toPlainObject(task.metadata);
  const trashedAt = meta.trashedAt || (task.status === "deleted" && task.deletedAt ? task.deletedAt.toISOString() : null);
  return {
    schemaVersion: cfg.schemaVersion || 1,
    id: task.clientId || task.id,
    serverId: task.id,
    accountId: task.creatorId || "",
    creatorId: task.creatorId || "",
    templateType: "sfs_comment",
    enabled: task.enabled !== false && task.status !== "deleted",
    title: task.title || "SFS comment",
    commentText: cfg.commentText || cfg.messageText || "",
    messageText: cfg.commentText || cfg.messageText || "",
    text: cfg.commentText || cfg.messageText || "",
    media: [],
    price: 0,
    dailyUseLimit: clampInt(rules.dailyUseLimit, 20, 1, 100),
    weight: clampInt(rules.weight, 1, 1, 100),
    rules: {
      ...rules,
      dailyUseLimit: clampInt(rules.dailyUseLimit, 20, 1, 100),
      weight: clampInt(rules.weight, 1, 1, 100),
      forbidSameTemplateBackToBack: rules.forbidSameTemplateBackToBack !== false,
    },
    stats: toPlainObject(task.stats),
    trashedAt,
    purgeAfter: meta.purgeAfter || null,
    createdAt: task.createdAt ? task.createdAt.toISOString() : (meta.createdAt || null),
    updatedAt: task.updatedAt ? task.updatedAt.toISOString() : (meta.updatedAt || null),
  };
}

async function listSfsComments({ agencyId, creatorId, query = {} }) {
  const result = await listTasks({ agencyId, query: { ...query, type: "sfs_comment", creatorId, includeDeleted: query.includeTrash ?? query.includeDeleted ?? true } });
  const includeTrash = query.includeTrash !== "false" && query.includeTrash !== false;
  const items = result.items.map(taskToSfsComment).filter((item) => includeTrash || !item.trashedAt);
  return { ok: true, accountId: String(creatorId || ""), creatorId: String(creatorId || ""), items, count: items.length, source: "server" };
}

async function saveSfsComment({ agencyId, userId, accountId, input = {} }) {
  const canonicalAccountId = clean(accountId, 100);
  const text = clean(input.commentText || input.messageText || input.text || "", 5000);
  if (!text) {
    const err = new Error("Comment text is required");
    err.status = 400;
    err.code = "SFS_COMMENT_TEXT_REQUIRED";
    throw err;
  }
  const taskInput = normalizeSfsCommentToTask({ ...(input || {}), commentText: text, creatorId: canonicalAccountId, accountId: canonicalAccountId }, canonicalAccountId);
  const result = await upsertTask({ agencyId, userId, input: taskInput, expectedCreatorId: canonicalAccountId });
  return { ok: true, accountId: String(accountId || taskInput.creatorId || ""), item: taskToSfsComment(result.item), task: result.item };
}

async function trashSfsComment({ agencyId, userId, accountId, templateId, permanent = false, restore = false }) {
  const id = clean(templateId, 120);
  const canonicalAccountId = clean(accountId, 100);
  let task = await prisma.automationTask.findFirst({ where: { agencyId, creatorId: canonicalAccountId, OR: [{ id }, { clientId: id }], type: "sfs_comment" } });
  if (!task) {
    const err = new Error("SFS comment template not found");
    err.status = 404;
    err.code = "SFS_COMMENT_NOT_FOUND";
    throw err;
  }
  if (restore) {
    const cfg = toPlainObject(task.config);
    await assertReusableBumpMediaAllowed({ agencyId, creatorId: canonicalAccountId, media: cfg.media || cfg.mediaFiles, db: prisma });
  }
  const result = restore
    ? await restoreTask({ agencyId, userId, taskId: task.id, creatorId: canonicalAccountId })
    : await trashTask({ agencyId, userId, taskId: task.id, creatorId: canonicalAccountId, permanent });
  const items = accountId ? (await listSfsComments({ agencyId, creatorId: accountId, query: { includeTrash: true } })).items : [];
  return { ok: true, accountId: String(accountId || task.creatorId || ""), item: result.item ? taskToSfsComment(result.item) : null, items };
}

// =============================================================================
// SFS Hunter v19.36 — server-owned target queue / forever ledger
// =============================================================================
const SFS_TYPE = "sfs_hunter";
const SFS_ACTION_TARGET = "sfs_comment_target";
const SFS_ACTION_UNFOLLOW = "sfs_unfollow_due";
const SFS_ACTION_USED_MARKER = "sfs_used_marker";
const SFS_ACTION_COMMENT_LIKE = "sfs_comment_like";
const SFS_DEFAULTS = Object.freeze({
  enabled: false,
  dailyLimit: 20,
  maxDailyLimit: 100,
  wallScanPosts: 40,
  maxPinnedPosts: 5,
  commentsMode: "all_pinned",
  actionDelayMinSec: 10,
  actionDelayMaxSec: 30,
  commentDelayMinSec: 15,
  commentDelayMaxSec: 45,
  unfollowMinMinutes: 3,
  unfollowMaxMinutes: 10,
  onlyFreeTargets: true,
  requirePinnedPosts: true,
  skipIfCommentExists: true,
  useTargetForever: true,
  huntingEnabled: true,
  commentLikesEnabled: true,
  commentLikesPerPost: 8,
  commentLikesDailyCap: 800,
});


function activityModuleFromType(type = "", meta = {}) {
  const t = clean(type, 100).toLowerCase();
  const m = clean(meta.module || meta.scope || "", 60).toLowerCase();
  if (m) return m;
  if (t.startsWith("sfs_")) return "sfs";
  if (t.startsWith("hidden_")) return "hidden";
  if (t.startsWith("follow_back")) return "follow_back";
  if (t.startsWith("bump_")) return "bump";
  if (t.includes("hidden")) return "hidden";
  if (t.includes("sfs")) return "sfs";
  if (t.includes("follow")) return "follow_back";
  if (t.includes("bump")) return "bump";
  return "automation";
}

function activityActionFromType(type = "", meta = {}) {
  const action = clean(meta.action || meta.event || "", 80);
  if (action) return action;
  const t = clean(type, 100).toLowerCase();
  if (t.startsWith("bump_")) return t.slice(5);
  if (t.startsWith("hidden_")) return t.slice(7);
  if (t.startsWith("sfs_")) return t.slice(4);
  if (t.startsWith("follow_back_")) return t.slice("follow_back_".length);
  return t || "activity";
}

function activityTitle({ module = "automation", action = "activity", meta = {}, fanId = null } = {}) {
  const fan = clean(meta.fanUsername || meta.username || meta.handle || meta.fanName || meta.name || fanId || "", 100);
  const target = clean(meta.targetUsername || meta.targetName || meta.targetUserId || "", 100);
  if (module === "bump" || module === "hidden") {
    if (action === "sent") return fan ? `sent to @${fan.replace(/^@+/, "")}` : "bump sent";
    if (action === "replied") return fan ? `@${fan.replace(/^@+/, "")} replied` : "fan replied";
    if (action === "bought") return fan ? `@${fan.replace(/^@+/, "")} bought` : "bump bought";
    if (action === "canceled") return fan ? `canceled for @${fan.replace(/^@+/, "")}` : "bump canceled";
    if (action === "failed") return fan ? `failed for @${fan.replace(/^@+/, "")}` : "bump failed";
    if (action === "skipped") return fan ? `skipped @${fan.replace(/^@+/, "")}` : "bump skipped";
  }
  if (module === "sfs") {
    if (action === "comment_sent") return target ? `commented @${target.replace(/^@+/, "")}` : "SFS comment sent";
    if (action === "already_commented") return target ? `already commented @${target.replace(/^@+/, "")}` : "SFS comment exists";
    if (action === "likes_sent") return target ? `liked comments @${target.replace(/^@+/, "")}` : "SFS likes sent";
    if (action === "skipped") return target ? `skipped @${target.replace(/^@+/, "")}` : "SFS skipped";
    if (action === "unfollowed") return target ? `unfollowed @${target.replace(/^@+/, "")}` : "SFS unfollowed";
  }
  if (module === "follow_back") {
    if (action === "done" || action === "followed") return fan ? `followed @${fan.replace(/^@+/, "")}` : "follow-back done";
    if (action === "skipped") return fan ? `skipped @${fan.replace(/^@+/, "")}` : "follow-back skipped";
    if (action === "failed") return fan ? `failed @${fan.replace(/^@+/, "")}` : "follow-back failed";
  }
  return meta.title || meta.label || `${module}.${action}`;
}

function activityResultText({ module = "automation", action = "activity", status = "info", amountCents = 0, meta = {} } = {}) {
  const reason = clean(meta.reason || meta.code || meta.error || meta.finalStatus || "", 120);
  if (module === "bump" || module === "hidden") {
    if (action === "replied") return meta.replyTimeText || "replied";
    if (action === "bought") return `bought $${Math.round(Number(amountCents || meta.amountCents || 0) / 100)}`;
    if (action === "sent") return "sent";
    if (action === "canceled") return "canceled";
    if (status === "failed" || action === "failed") return reason || "failed";
  }
  if (module === "sfs") {
    if (action === "comment_sent") return `${Number(meta.commentsSent || 1)} comment${Number(meta.commentsSent || 1) === 1 ? "" : "s"}`;
    if (action === "already_commented") return `${Number(meta.existingComments || 1)} existed`;
    if (action === "likes_sent") return `${Number(meta.likedComments || meta.likesSent || 0)} likes`;
    if (action === "unfollowed") return "unfollowed";
    if (action === "skipped") return reason || "skipped";
  }
  if (module === "follow_back") {
    if (action === "done" || action === "followed") return "followed";
    if (action === "skipped") return reason || "skipped";
    if (action === "failed") return reason || "failed";
  }
  return reason || status || action || "activity";
}

function automationActivityFromEvent(row = {}) {
  const meta = toPlainObject(row.metadata || {});
  const module = activityModuleFromType(row.type, meta);
  const action = activityActionFromType(row.type, meta);
  const status = clean(row.status || meta.status || "info", 40) || "info";
  return {
    id: row.id,
    createdAt: row.createdAt,
    ts: row.createdAt,
    module,
    action,
    status,
    creatorId: row.creatorId || row.accountId || meta.creatorId || meta.accountId || null,
    accountId: row.accountId || row.creatorId || meta.accountId || meta.creatorId || null,
    fanId: row.fanId || meta.fanId || null,
    fanUsername: meta.fanUsername || meta.username || meta.handle || null,
    targetUserId: meta.targetUserId || null,
    targetUsername: meta.targetUsername || null,
    templateId: meta.templateId || meta.bumpId || row.taskId || null,
    deliveryId: meta.deliveryId || null,
    jobId: row.jobId || meta.jobId || null,
    messageId: row.messageId || meta.messageId || null,
    postId: meta.postId || null,
    commentId: meta.commentId || null,
    amountCents: Number(row.amountCents || meta.amountCents || 0) || 0,
    reason: meta.reason || meta.code || meta.error || null,
    title: activityTitle({ module, action, meta, fanId: row.fanId }),
    result: activityResultText({ module, action, status, amountCents: row.amountCents, meta }),
    meta,
  };
}

function automationActivityFromDelivery(row = {}) {
  const meta = toPlainObject(row.result || {});
  const trigger = clean(row.trigger || meta.triggerKey || "", 80);
  const module = trigger === "hiddenOnlineSignal" || String(trigger).toLowerCase().includes("hidden") ? "hidden" : "bump";
  const status = clean(row.status || "scheduled", 40).toLowerCase();
  let action = status;
  if (["pending_reply", "sent", "checking_reply"].includes(status)) action = "sent";
  if (status === "online_queued" || status === "scheduled") action = "queued";
  const createdAt = row.sentAt || row.updatedAt || row.createdAt;
  const m = { ...meta, fanUsername: meta.fanUsername || meta.username || row.fanId, templateId: row.contentCollectionId, deliveryId: row.id, reason: meta.finalStatus || row.error || null };
  return {
    id: `delivery:${row.id}`,
    createdAt,
    ts: createdAt,
    module,
    action,
    status: status === "failed" ? "failed" : status === "skipped" ? "skipped" : "info",
    creatorId: row.creatorId,
    accountId: row.creatorId,
    fanId: row.fanId,
    fanUsername: m.fanUsername,
    templateId: row.contentCollectionId,
    deliveryId: row.id,
    messageId: row.messageId,
    amountCents: Number(row.priceCents || 0) || 0,
    reason: row.error || meta.error || meta.reason || null,
    title: activityTitle({ module, action, meta: m, fanId: row.fanId }),
    result: activityResultText({ module, action, status, amountCents: row.priceCents, meta: m }),
    meta: m,
  };
}

async function listActivity({ agencyId, query = {} }) {
  const creatorId = clean(query.creatorId || query.accountId, 100);
  const moduleFilter = clean(query.module, 60).toLowerCase();
  const take = parseLimit(query.limit, 60, 200);
  const sinceHours = clampInt(query.sinceHours, 72, 1, 24 * 30);
  const cacheKey = `${agencyId}:${creatorId || "all"}:${moduleFilter || "all"}:${take}:${sinceHours}`;
  const cached = activityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ACTIVITY_CACHE_TTL_MS) {
    return { ...cached.value, cached: true, cacheTtlMs: ACTIVITY_CACHE_TTL_MS };
  }
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const eventWhere = { agencyId, createdAt: { gte: since } };
  if (creatorId) eventWhere.OR = [{ creatorId }, { accountId: creatorId }];
  const auditWhere = { agencyId, action: { startsWith: "automation." }, createdAt: { gte: since } };
  if (creatorId) auditWhere.OR = [
    { targetId: creatorId },
    { metadata: { path: ["creatorId"], equals: creatorId } },
  ];
  const [events, deliveries, audits] = await Promise.all([
    prisma.automationEvent.findMany({ where: eventWhere, orderBy: { createdAt: "desc" }, take: Math.min(60, take) }).catch(() => []),
    prisma.automationDelivery.findMany({ where: { agencyId, originKind: "AUTOMATION", ...(creatorId ? { creatorId } : {}), OR: [{ updatedAt: { gte: since } }, { sentAt: { gte: since } }, { createdAt: { gte: since } }] }, orderBy: { updatedAt: "desc" }, take: Math.min(120, Math.ceil(take * 2)) }).catch(() => []),
    prisma.auditLog.findMany({ where: auditWhere, orderBy: { createdAt: "desc" }, take: Math.min(120, Math.ceil(take * 1.5)) }).catch(() => []),
  ]);
  const rows = [];
  for (const row of events || []) rows.push(automationActivityFromEvent(row));
  for (const row of deliveries || []) rows.push(automationActivityFromDelivery(row));
  for (const row of audits || []) {
    const meta = toPlainObject(row.metadata);
    rows.push({
      id: `audit:${row.id}`, createdAt: row.createdAt, ts: row.createdAt, module: meta.moduleKey || "automation",
      action: String(row.action || "automation.event").replace(/^automation\./, ""), status: "info",
      creatorId: meta.creatorId || row.targetId || null, accountId: meta.creatorId || row.targetId || null,
      title: String(row.action || "Automation action"), result: meta.details?.action || meta.details?.path || "Recorded by backend", meta,
    });
  }
  const seen = new Set();
  const out = [];
  for (const row of rows.sort((a, b) => (Date.parse(b.ts || b.createdAt || 0) || 0) - (Date.parse(a.ts || a.createdAt || 0) || 0))) {
    if (!row?.id) continue;
    if (moduleFilter && String(row.module || "") !== moduleFilter) continue;
    const key = `${row.module}:${row.action}:${row.deliveryId || row.jobId || row.commentId || row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= take) break;
  }
  const value = { ok: true, items: out, count: out.length, source: "automation_activity_v1" };
  activityCache.set(cacheKey, { ts: Date.now(), value });
  if (activityCache.size > 250) {
    const cutoff = Date.now() - ACTIVITY_CACHE_TTL_MS * 2;
    for (const [key, rec] of activityCache) {
      if (!rec || rec.ts < cutoff || activityCache.size > 300) activityCache.delete(key);
    }
  }
  return value;
}

async function logEvent({ agencyId, userId, input = {} }) {
  eventsCache.clear();
  activityCache.clear();

  const item = await prisma.automationEvent.create({
    data: {
      agencyId,
      taskId: optional(input.taskId, 120),
      jobId: optional(input.jobId, 120),
      creatorId: optional(input.creatorId || input.accountId, 100),
      accountId: optional(input.accountId || input.creatorId, 100),
      fanId: optional(input.fanId || input.userId, 100),
      dialogId: optional(input.dialogId, 100),
      type: clean(input.type || input.eventType || "automation_event", 80) || "automation_event",
      status: EVENT_STATUSES.has(clean(input.status, 40)) ? clean(input.status, 40) : "info",
      messageId: optional(input.messageId, 120),
      amountCents: clampInt(input.amountCents, 0, 0),
      metadata: compactJson(input.metadata || input.result || {}, 4000),
      createdByUserId: userId || null,
    },
  });
  return { ok: true, item };
}

async function listEvents({ agencyId, query = {} }) {
  const where = { agencyId };
  const type = clean(query.type, 80);
  const creatorId = clean(query.creatorId || query.accountId, 100);
  const fanId = clean(query.fanId || query.userId, 100);
  if (type) where.type = type;
  if (creatorId) where.creatorId = creatorId;
  if (fanId) where.fanId = fanId;
  const take = parseLimit(query.limit, 100, 500);
  const skip = parseOffset(query.offset);
  const cacheKey = `${agencyId}:${type || "all"}:${creatorId || "all"}:${fanId || "all"}:${take}:${skip}`;
  const cached = eventsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EVENTS_CACHE_TTL_MS) {
    return { ...cached.value, cached: true, cacheTtlMs: EVENTS_CACHE_TTL_MS };
  }
  const [items, count] = await Promise.all([
    prisma.automationEvent.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.automationEvent.count({ where }),
  ]);
  const value = { ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count };
  eventsCache.set(cacheKey, { ts: Date.now(), value });
  if (eventsCache.size > 250) {
    const cutoff = Date.now() - EVENTS_CACHE_TTL_MS * 2;
    for (const [key, rec] of eventsCache) {
      if (!rec || rec.ts < cutoff || eventsCache.size > 300) eventsCache.delete(key);
    }
  }
  return value;
}

module.exports = {
  listTasks,
  upsertTask,
  patchTask,
  trashTask,
  restoreTask,
  listBumps,
  saveBump,
  trashBump,
  listSfsComments,
  saveSfsComment,
  trashSfsComment,
  gcExpiredBumps,
  logEvent,
  listEvents,
  listActivity,
  taskToBump,
  taskToSfsComment, normalizeBumpToTask, normalizeSfsCommentToTask, assertReusableBumpMediaAllowed,
};
