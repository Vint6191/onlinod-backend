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

const JOB_STATUSES = new Set(["scheduled", "claimed", "running", "done", "skipped", "failed", "canceled", "expired"]);
const EVENT_STATUSES = new Set(["info", "ok", "failed", "skipped", "warning"]);
const RAW_KEY_RE = /(^|_)(raw|html|payload|headers|cookies|token|authorization|password|secret)($|_)/i;
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
    creatorId: input.creatorId || input.accountId || accountId || null,
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
    prisma.bumpDeliveryStat.findMany({ where }).catch(() => []),
    prisma.automationDelivery.findMany({
      where: {
        agencyId,
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

async function upsertTask({ agencyId, userId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  if (creatorId) await requireCreator(agencyId, creatorId);
  const rawId = clean(input.id || input.taskId, 120);
  const clientId = clean(input.clientId || input.id, 120);
  const data = normalizeTaskInput({ ...input, clientId: input.clientId || input.id, creatorId }, { agencyId, userId });
  const update = { ...data };
  delete update.agencyId;
  delete update.createdByUserId;

  let item;
  if (rawId && !rawId.startsWith("bump_") && !rawId.startsWith("local") && !rawId.startsWith("tmp")) {
    const existing = await prisma.automationTask.findFirst({ where: { id: rawId, agencyId }, select: { id: true } });
    if (existing) item = await prisma.automationTask.update({ where: { id: existing.id }, data: update });
  }
  if (!item && clientId) {
    item = await prisma.automationTask.upsert({ where: { agencyId_clientId: { agencyId, clientId } }, create: data, update });
  }
  if (!item) item = await prisma.automationTask.create({ data: { ...data, clientId: data.clientId || null } });
  return { ok: true, item };
}

async function patchTask({ agencyId, userId, taskId, patch = {} }) {
  const id = clean(taskId, 120);
  const existing = await prisma.automationTask.findFirst({ where: { id, agencyId } });
  if (!existing) {
    const err = new Error("Automation task not found");
    err.status = 404;
    err.code = "AUTOMATION_TASK_NOT_FOUND";
    throw err;
  }
  const data = normalizeTaskInput(patch, { agencyId, userId, patch: true });
  delete data.agencyId;
  delete data.createdByUserId;
  if (patch.creatorId !== undefined || patch.accountId !== undefined) {
    const creatorId = clean(patch.creatorId || patch.accountId, 100);
    if (creatorId) await requireCreator(agencyId, creatorId);
  }
  const item = await prisma.automationTask.update({ where: { id: existing.id }, data });
  return { ok: true, item };
}

async function trashTask({ agencyId, userId, taskId, permanent = false }) {
  const id = clean(taskId, 120);
  const existing = await prisma.automationTask.findFirst({ where: { id, agencyId } });
  if (!existing) {
    const err = new Error("Automation task not found");
    err.status = 404;
    err.code = "AUTOMATION_TASK_NOT_FOUND";
    throw err;
  }
  if (permanent) {
    await prisma.automationTask.delete({ where: { id: existing.id } });
    return { ok: true, deleted: true };
  }
  const deletedAt = new Date();
  const meta = toPlainObject(existing.metadata);
  const item = await prisma.automationTask.update({
    where: { id: existing.id },
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

async function restoreTask({ agencyId, userId, taskId }) {
  const id = clean(taskId, 120);
  const existing = await prisma.automationTask.findFirst({ where: { id, agencyId } });
  if (!existing) {
    const err = new Error("Automation task not found");
    err.status = 404;
    err.code = "AUTOMATION_TASK_NOT_FOUND";
    throw err;
  }
  const meta = { ...toPlainObject(existing.metadata) };
  delete meta.trashedAt;
  delete meta.purgeAfter;
  delete meta.trashRetentionDays;
  const item = await prisma.automationTask.update({ where: { id: existing.id }, data: { status: "active", deletedAt: null, metadata: cleanJsonForPrisma(meta), updatedByUserId: userId || null } });
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
  const taskInput = normalizeBumpToTask(input, accountId);
  const result = await upsertTask({ agencyId, userId, input: taskInput });
  return { ok: true, accountId: String(accountId || taskInput.creatorId || ""), item: taskToBump(result.item), task: result.item };
}

async function trashBump({ agencyId, userId, accountId, bumpId, permanent = false, restore = false }) {
  const id = clean(bumpId, 120);
  let task = await prisma.automationTask.findFirst({ where: { agencyId, OR: [{ id }, { clientId: id }], type: "bump_online" } });
  if (!task) {
    const err = new Error("Bump template not found");
    err.status = 404;
    err.code = "BUMP_NOT_FOUND";
    throw err;
  }
  const result = restore
    ? await restoreTask({ agencyId, userId, taskId: task.id })
    : await trashTask({ agencyId, userId, taskId: task.id, permanent });
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
    creatorId: input.creatorId || input.accountId || accountId || null,
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
  const text = clean(input.commentText || input.messageText || input.text || "", 5000);
  if (!text) {
    const err = new Error("Comment text is required");
    err.status = 400;
    err.code = "SFS_COMMENT_TEXT_REQUIRED";
    throw err;
  }
  const taskInput = normalizeSfsCommentToTask({ ...(input || {}), commentText: text }, accountId);
  const result = await upsertTask({ agencyId, userId, input: taskInput });
  return { ok: true, accountId: String(accountId || taskInput.creatorId || ""), item: taskToSfsComment(result.item), task: result.item };
}

async function trashSfsComment({ agencyId, userId, accountId, templateId, permanent = false, restore = false }) {
  const id = clean(templateId, 120);
  let task = await prisma.automationTask.findFirst({ where: { agencyId, OR: [{ id }, { clientId: id }], type: "sfs_comment" } });
  if (!task) {
    const err = new Error("SFS comment template not found");
    err.status = 404;
    err.code = "SFS_COMMENT_NOT_FOUND";
    throw err;
  }
  const result = restore
    ? await restoreTask({ agencyId, userId, taskId: task.id })
    : await trashTask({ agencyId, userId, taskId: task.id, permanent });
  const items = accountId ? (await listSfsComments({ agencyId, creatorId: accountId, query: { includeTrash: true } })).items : [];
  return { ok: true, accountId: String(accountId || task.creatorId || ""), item: result.item ? taskToSfsComment(result.item) : null, items };
}

function normalizeJobStatus(value, fallback = "scheduled") {
  const status = clean(value || fallback, 40).toLowerCase() || fallback;
  return JOB_STATUSES.has(status) ? status : fallback;
}

function normalizeJobInput(input = {}, { agencyId, userId } = {}) {
  return {
    agencyId,
    taskId: optional(input.taskId, 120),
    creatorId: optional(input.creatorId || input.accountId, 100),
    accountId: optional(input.accountId || input.creatorId, 100),
    fanId: optional(input.fanId || input.userId, 100),
    dialogId: optional(input.dialogId, 100),
    type: normalizeTaskType(input.type || input.taskType || "custom"),
    action: clean(input.action || "run", 80) || "run",
    status: normalizeJobStatus(input.status || "scheduled"),
    priority: clampInt(input.priority, 0, -1000, 1000),
    runAfter: safeDate(input.runAfter || input.scheduledAt, new Date()),
    maxAttempts: clampInt(input.maxAttempts, 3, 1, 20),
    dedupeKey: optional(input.dedupeKey, 240),
    payload: compactJson(input.payload || {}, 16000),
    result: compactJson(input.result || {}, 8000),
    error: optional(input.error, 2000),
    createdByUserId: userId || null,
  };
}

async function listJobs({ agencyId, query = {} }) {
  const where = { agencyId };
  const status = clean(query.status, 40);
  const type = clean(query.type, 80);
  const creatorId = clean(query.creatorId || query.accountId, 100);
  const taskId = clean(query.taskId, 120);
  if (status) where.status = normalizeJobStatus(status);
  if (type) where.type = normalizeTaskType(type);
  if (creatorId) where.creatorId = creatorId;
  if (taskId) where.taskId = taskId;
  const take = parseLimit(query.limit, 100, 500);
  const skip = parseOffset(query.offset);
  const [items, count] = await Promise.all([
    prisma.automationJob.findMany({ where, orderBy: [{ priority: "desc" }, { runAfter: "asc" }, { createdAt: "asc" }], take, skip }),
    prisma.automationJob.count({ where }),
  ]);
  return { ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count };
}

async function enqueueJob({ agencyId, userId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  if (creatorId) await requireCreator(agencyId, creatorId);
  const data = normalizeJobInput(input, { agencyId, userId });
  let item;
  let alreadyActive = false;

  if (data.dedupeKey) {
    const existing = await prisma.automationJob.findUnique({
      where: { agencyId_dedupeKey: { agencyId, dedupeKey: data.dedupeKey } },
    });

    // A second Run click must not reset an active worker lease.
    // Manual Stop explicitly cancels the job; after that this dedupe key can be reused.
    if (existing && ["claimed", "running"].includes(String(existing.status || ""))) {
      item = existing;
      alreadyActive = true;
    } else if (existing) {
      item = await prisma.automationJob.update({
        where: { id: existing.id },
        data: {
          ...data,
          agencyId: undefined,
          createdByUserId: undefined,
          status: "scheduled",
          claimedByDeviceId: null,
          claimedAt: null,
          completedAt: null,
          error: null,
        },
      });
    } else {
      item = await prisma.automationJob.create({ data });
    }
  } else {
    item = await prisma.automationJob.create({ data });
  }

  return { ok: true, item, alreadyActive };
}

async function claimJobs({ agencyId, input = {} }) {
  const deviceId = clean(input.deviceId || input.claimedByDeviceId || "unknown", 120) || "unknown";
  const types = Array.isArray(input.types) ? input.types.map(normalizeTaskType) : [];
  const creatorId = clean(input.creatorId || input.accountId, 100);
  const limit = parseLimit(input.limit, 10, 50);
  const now = new Date();
  const staleBefore = new Date(Date.now() - clampInt(input.claimTimeoutSec, 600, 60, 86400) * 1000);

  await prisma.$executeRaw`
    UPDATE "AutomationJob"
    SET
      "status" = CASE WHEN "attempts" >= "maxAttempts" THEN 'failed' ELSE 'scheduled' END,
      "completedAt" = CASE WHEN "attempts" >= "maxAttempts" THEN NOW() ELSE NULL END,
      "claimedByDeviceId" = NULL,
      "claimedAt" = NULL,
      "error" = CASE
        WHEN "attempts" >= "maxAttempts" THEN 'claim expired; max attempts exceeded'
        ELSE 'claim expired; returned to queue'
      END
    WHERE "agencyId" = ${agencyId}
      AND "status" IN ('claimed', 'running')
      AND "claimedAt" < ${staleBefore}
  `.catch(() => null);

  await prisma.$executeRaw`
    UPDATE "AutomationJob"
    SET "status" = 'failed', "completedAt" = NOW(), "error" = COALESCE("error", 'max attempts exceeded')
    WHERE "agencyId" = ${agencyId}
      AND "status" = 'scheduled'
      AND "attempts" >= "maxAttempts"
  `.catch(() => null);

  const params = [agencyId, now, limit, deviceId];
  const filters = [];
  if (creatorId) {
    params.push(creatorId);
    filters.push(`AND "creatorId" = $${params.length}`);
  }
  if (types.length) {
    const placeholders = types.map((type) => {
      params.push(type);
      return `$${params.length}`;
    }).join(", ");
    filters.push(`AND "type" IN (${placeholders})`);
  }

  const items = await prisma.$queryRawUnsafe(`
    UPDATE "AutomationJob"
    SET
      "status" = 'claimed',
      "claimedByDeviceId" = $4,
      "claimedAt" = NOW(),
      "attempts" = "attempts" + 1,
      "updatedAt" = NOW()
    WHERE "id" IN (
      SELECT "id"
      FROM "AutomationJob"
      WHERE "agencyId" = $1
        AND "status" = 'scheduled'
        AND "runAfter" <= $2
        ${filters.join("\n        ")}
      ORDER BY "priority" DESC, "runAfter" ASC, "createdAt" ASC
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `, ...params).catch(() => []);

  return { ok: true, items: Array.isArray(items) ? items : [], count: Array.isArray(items) ? items.length : 0 };
}

async function cancelJobs({ agencyId, userId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  if (creatorId) await requireCreator(agencyId, creatorId);

  const where = {
    agencyId,
    status: { in: ["scheduled", "claimed", "running"] },
  };
  const type = clean(input.type, 80);
  const action = clean(input.action, 80);
  const dedupeKey = clean(input.dedupeKey, 240);
  const jobId = clean(input.jobId || input.id, 120);
  if (jobId) where.id = jobId;
  if (creatorId) where.creatorId = creatorId;
  if (type) where.type = normalizeTaskType(type);
  if (action) where.action = action;
  if (dedupeKey) where.dedupeKey = dedupeKey;

  const reason = optional(input.reason || "manual_stop", 2000) || "manual_stop";
  const before = await prisma.automationJob.findMany({ where, take: parseLimit(input.limit, 50, 500) });
  if (!before.length) return { ok: true, canceled: 0, items: [] };

  const ids = before.map((x) => x.id);
  await prisma.automationJob.updateMany({
    where: { agencyId, id: { in: ids }, status: { in: ["scheduled", "claimed", "running"] } },
    data: {
      status: "canceled",
      completedAt: new Date(),
      claimedByDeviceId: null,
      claimedAt: null,
      error: reason,
      result: compactJson({ canceledByUserId: userId || null, canceledAt: new Date().toISOString(), reason }, 4000),
    },
  });
  const items = await prisma.automationJob.findMany({ where: { agencyId, id: { in: ids } } });
  return { ok: true, canceled: items.length, items };
}

async function getJob({ agencyId, jobId }) {
  const id = clean(jobId, 120);
  const item = id ? await prisma.automationJob.findFirst({ where: { id, agencyId } }) : null;
  if (!item) {
    const err = new Error("Automation job not found");
    err.status = 404;
    err.code = "AUTOMATION_JOB_NOT_FOUND";
    throw err;
  }
  return { ok: true, item };
}

async function completeJob({ agencyId, jobId, input = {} }) {
  const id = clean(jobId || input.id, 120);
  const existing = await prisma.automationJob.findFirst({ where: { id, agencyId } });
  if (!existing) {
    const err = new Error("Automation job not found");
    err.status = 404;
    err.code = "AUTOMATION_JOB_NOT_FOUND";
    throw err;
  }
  const status = normalizeJobStatus(input.status || (input.ok === false ? "failed" : "done"), "done");
  const item = await prisma.automationJob.update({
    where: { id: existing.id },
    data: {
      status,
      result: compactJson(input.result || {}, 12000),
      error: optional(input.error, 2000),
      completedAt: ["done", "failed", "canceled", "expired"].includes(status) ? new Date() : null,
      claimedAt: status === "running" || status === "claimed" ? existing.claimedAt : existing.claimedAt,
    },
  });
  return { ok: true, item };
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

function normalizeSfsSettings(input = {}, prev = {}) {
  const src = { ...(SFS_DEFAULTS || {}), ...(toPlainObject(prev)), ...(toPlainObject(input)) };
  const dailyLimit = clampInt(src.dailyLimit, SFS_DEFAULTS.dailyLimit, 1, SFS_DEFAULTS.maxDailyLimit);
  const unfollowMin = clampInt(src.unfollowMinMinutes, SFS_DEFAULTS.unfollowMinMinutes, 1, 10);
  const unfollowMax = clampInt(src.unfollowMaxMinutes, SFS_DEFAULTS.unfollowMaxMinutes, unfollowMin, 10);
  const actionMin = clampInt(src.actionDelayMinSec, SFS_DEFAULTS.actionDelayMinSec, 1, 300);
  const actionMax = clampInt(src.actionDelayMaxSec, SFS_DEFAULTS.actionDelayMaxSec, actionMin, 600);
  const commentMin = clampInt(src.commentDelayMinSec, SFS_DEFAULTS.commentDelayMinSec, 1, 600);
  const commentMax = clampInt(src.commentDelayMaxSec, SFS_DEFAULTS.commentDelayMaxSec, commentMin, 900);
  return {
    ...SFS_DEFAULTS,
    ...src,
    enabled: boolValue(src.enabled, false),
    dailyLimit,
    maxDailyLimit: SFS_DEFAULTS.maxDailyLimit,
    wallScanPosts: clampInt(src.wallScanPosts, SFS_DEFAULTS.wallScanPosts, 1, 100),
    maxPinnedPosts: clampInt(src.maxPinnedPosts, SFS_DEFAULTS.maxPinnedPosts, 1, 10),
    commentsMode: "all_pinned",
    actionDelayMinSec: actionMin,
    actionDelayMaxSec: actionMax,
    commentDelayMinSec: commentMin,
    commentDelayMaxSec: commentMax,
    unfollowMinMinutes: unfollowMin,
    unfollowMaxMinutes: unfollowMax,
    onlyFreeTargets: boolValue(src.onlyFreeTargets, true),
    requirePinnedPosts: boolValue(src.requirePinnedPosts, true),
    skipIfCommentExists: boolValue(src.skipIfCommentExists, true),
    useTargetForever: true,
    huntingEnabled: boolValue(src.huntingEnabled, true),
    commentLikesEnabled: boolValue(src.commentLikesEnabled, true),
    commentLikesPerPost: clampInt(src.commentLikesPerPost, SFS_DEFAULTS.commentLikesPerPost, 1, 50),
    commentLikesDailyCap: clampInt(src.commentLikesDailyCap, SFS_DEFAULTS.commentLikesDailyCap, 0, 10000),
    updatedAt: new Date().toISOString(),
  };
}

function sfsSettingsClientId(creatorId) {
  return `sfs_hunter_settings:${clean(creatorId, 100)}`;
}

async function getSfsHunterSettings({ agencyId, creatorId }) {
  const cid = clean(creatorId, 100);
  if (!agencyId || !cid) return { ok: false, code: "CREATOR_ID_MISSING", settings: normalizeSfsSettings() };
  const task = await prisma.automationTask.findFirst({
    where: { agencyId, creatorId: cid, type: SFS_TYPE, clientId: sfsSettingsClientId(cid) },
  }).catch(() => null);
  const settings = normalizeSfsSettings(task?.config || {});
  return { ok: true, creatorId: cid, settings, item: task || null };
}

async function saveSfsHunterSettings({ agencyId, userId, creatorId, input = {} }) {
  const cid = clean(creatorId || input.creatorId || input.accountId, 100);
  if (!agencyId || !cid) {
    const err = new Error("creatorId is required");
    err.status = 400;
    err.code = "CREATOR_ID_MISSING";
    throw err;
  }
  await requireCreator(agencyId, cid);
  const prev = await getSfsHunterSettings({ agencyId, creatorId: cid });
  const settings = normalizeSfsSettings(input.settings || input, prev.settings || {});
  const clientId = sfsSettingsClientId(cid);
  const existing = await prisma.automationTask.findFirst({ where: { agencyId, clientId } }).catch(() => null);
  const data = {
    agencyId,
    creatorId: cid,
    clientId,
    type: SFS_TYPE,
    title: "SFS Hunter",
    enabled: settings.enabled,
    status: settings.enabled ? "active" : "paused",
    config: compactJson(settings, 8000),
    triggers: compactJson({ wallScan: true, commentTargets: true, unfollowDue: true }, 2000),
    rules: compactJson({ dailyLimit: settings.dailyLimit, maxPinnedPosts: settings.maxPinnedPosts }, 2000),
    metadata: compactJson({ sfsHunterSettings: true, updatedAt: new Date().toISOString() }, 2000),
    updatedByUserId: userId || null,
  };
  const item = existing
    ? await prisma.automationTask.update({ where: { id: existing.id }, data: { ...data, agencyId: undefined, createdByUserId: undefined } })
    : await prisma.automationTask.create({ data: { ...data, createdByUserId: userId || null } });
  return { ok: true, creatorId: cid, settings, item };
}

function extractSfsUsernamesFromText(value = "") {
  const text = String(value || "");
  const out = new Set();
  const add = (raw) => {
    const u = clean(String(raw || "").replace(/^@+/, "").replace(/^\/+/, ""), 80).toLowerCase();
    if (!u || u.length < 2) return;
    if (["api2", "my", "posts", "chats", "settings", "users", "messages", "notifications"].includes(u)) return;
    if (!/^[a-z0-9_.-]{2,80}$/i.test(u)) return;
    out.add(u);
  };
  for (const m of text.matchAll(/(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9_.-]{2,80})/g)) add(m[1]);
  for (const m of text.matchAll(/href=["']\/?([a-zA-Z0-9_.-]{2,80})["']/gi)) add(m[1]);
  return Array.from(out);
}

function sfsUsernameDedupeKey(creatorId, username) {
  return `sfs_target_username:${clean(creatorId, 100)}:${clean(username, 80).toLowerCase()}`;
}

function sfsTargetIdDedupeKey(creatorId, targetUserId) {
  return `sfs_target_id:${clean(creatorId, 100)}:${clean(targetUserId, 100)}`;
}

function sfsUnfollowDedupeKey(creatorId, targetUserId) {
  return `sfs_unfollow:${clean(creatorId, 100)}:${clean(targetUserId, 100)}`;
}

function sfsCommentLikeDedupeKey(creatorId, targetUserId, postId, commentId) {
  return `sfs_comment_like:${clean(creatorId, 100)}:${clean(targetUserId, 100)}:${clean(postId, 100)}:${clean(commentId, 100)}`;
}

function normalizeSfsCommentLikeRows({ creatorId, targetUserId, targetUsername, postId, comments = [] } = {}) {
  const cid = clean(creatorId, 100);
  const tid = clean(targetUserId, 100);
  const username = clean(targetUsername, 80).toLowerCase();
  const defaultPostId = clean(postId, 100);
  const rows = [];
  for (const raw of Array.isArray(comments) ? comments : []) {
    const commentId = clean(raw?.commentId || raw?.id, 100);
    const pid = clean(raw?.postId || defaultPostId, 100);
    if (!cid || !tid || !pid || !commentId) continue;
    rows.push({
      creatorId: cid,
      targetUserId: tid,
      targetUsername: clean(raw?.targetUsername || username, 80).toLowerCase(),
      postId: pid,
      commentId,
      authorId: clean(raw?.authorId || raw?.userId, 100),
      authorUsername: clean(raw?.authorUsername || raw?.username, 80).toLowerCase(),
      text: clean(raw?.text || raw?.commentText, 500),
      postedAt: raw?.postedAt || null,
      likedAt: raw?.likedAt || new Date().toISOString(),
      dedupeKey: sfsCommentLikeDedupeKey(cid, tid, pid, commentId),
    });
  }
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.dedupeKey)) return false;
    seen.add(row.dedupeKey);
    return true;
  });
}

async function ingestSfsTargets({ agencyId, userId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  if (!agencyId || !creatorId) {
    const err = new Error("creatorId is required");
    err.status = 400;
    err.code = "CREATOR_ID_MISSING";
    throw err;
  }
  await requireCreator(agencyId, creatorId);
  const settings = (await getSfsHunterSettings({ agencyId, creatorId })).settings;
  const sourcePosts = Array.isArray(input.sourcePosts) ? input.sourcePosts : [];
  const directTargets = Array.isArray(input.targets) ? input.targets : [];
  const found = new Map();
  const register = (username, meta = {}) => {
    const u = clean(username, 80).replace(/^@+/, "").replace(/^\/+/, "").toLowerCase();
    if (!u || !/^[a-z0-9_.-]{2,80}$/i.test(u)) return;
    const prev = found.get(u) || { username: u, sourcePostIds: [], sourceTexts: [] };
    if (meta.sourcePostId && !prev.sourcePostIds.includes(String(meta.sourcePostId))) prev.sourcePostIds.push(String(meta.sourcePostId));
    if (meta.sourceText && prev.sourceTexts.length < 3) prev.sourceTexts.push(clean(meta.sourceText, 1000));
    found.set(u, prev);
  };
  for (const t of directTargets) register(typeof t === "string" ? t : (t.username || t.targetUsername), t || {});
  for (const post of sourcePosts) {
    const text = String(post?.rawText || post?.text || post?.description || "");
    for (const username of extractSfsUsernamesFromText(text)) register(username, { sourcePostId: post?.id || post?.postId, sourceText: text });
  }
  const usernames = Array.from(found.keys()).slice(0, 500);
  const items = [];
  let created = 0;
  let skipped = 0;
  for (const username of usernames) {
    const dedupeKey = sfsUsernameDedupeKey(creatorId, username);
    const existing = await prisma.automationJob.findUnique({ where: { agencyId_dedupeKey: { agencyId, dedupeKey } } }).catch(() => null);
    if (existing) { skipped += 1; continue; }
    const meta = found.get(username) || { username };
    const item = await prisma.automationJob.create({
      data: {
        agencyId,
        creatorId,
        accountId: creatorId,
        type: SFS_TYPE,
        action: SFS_ACTION_TARGET,
        status: settings.enabled ? "scheduled" : "scheduled",
        priority: 0,
        runAfter: new Date(),
        maxAttempts: 3,
        dedupeKey,
        payload: compactJson({
          targetUsername: username,
          sourcePostIds: meta.sourcePostIds || [],
          sourceTexts: meta.sourceTexts || [],
          stage: "discovered",
          discoveredAt: new Date().toISOString(),
        }, 12000),
        result: compactJson({}, 1000),
        createdByUserId: userId || null,
      },
    });
    created += 1;
    items.push(item);
  }
  return { ok: true, creatorId, found: usernames.length, created, skipped, items };
}

function sfsResultComments(result = {}) {
  const r = toPlainObject(result);
  const comments = Array.isArray(r.comments) ? r.comments : [];
  return comments.filter((x) => x && (x.commentId || x.id));
}

function sfsExistingComments(result = {}) {
  const r = toPlainObject(result);
  const rows = Array.isArray(r.existingComments) ? r.existingComments : [];
  return rows.filter((x) => x && (x.commentId || x.id));
}

function sfsLikedComments(result = {}) {
  const r = toPlainObject(result);
  const rows = Array.isArray(r.likedComments) ? r.likedComments : [];
  return rows.filter((x) => x && (x.commentId || x.id));
}

function isSfsCommentSuccess(result = {}) {
  const r = toPlainObject(result);
  const commentsSent = Number(r.commentsSent || 0);
  return String(r.reason || "") === "SFS_COMMENTS_SENT" && commentsSent > 0 && sfsResultComments(r).length > 0;
}

function isSfsAlreadyCommented(result = {}) {
  const r = toPlainObject(result);
  return String(r.reason || "") === "SFS_ALREADY_COMMENTED" && sfsExistingComments(r).length > 0;
}

function isSfsCommentLikeSuccess(result = {}) {
  const r = toPlainObject(result);
  return String(r.reason || "") === "SFS_COMMENT_LIKES_SENT" && sfsLikedComments(r).length > 0;
}

function isSfsDoneForever(result = {}) {
  return isSfsCommentSuccess(result) || isSfsAlreadyCommented(result) || isSfsCommentLikeSuccess(result);
}

async function sfsDoneTodayCount({ agencyId, creatorId }) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.automationJob.findMany({
    where: {
      agencyId,
      creatorId,
      type: SFS_TYPE,
      action: SFS_ACTION_TARGET,
      status: "done",
      completedAt: { gte: start },
    },
    select: { result: true },
    take: 1000,
  }).catch(() => []);
  return rows.filter((row) => isSfsCommentSuccess(row.result)).length;
}

async function listSfsHunterState({ agencyId, creatorId, query = {} }) {
  const cid = clean(creatorId, 100);
  const settings = (await getSfsHunterSettings({ agencyId, creatorId: cid })).settings;
  const jobs = await prisma.automationJob.findMany({
    where: { agencyId, creatorId: cid, type: SFS_TYPE, action: { in: [SFS_ACTION_TARGET, SFS_ACTION_UNFOLLOW] } },
    orderBy: { updatedAt: "desc" },
    take: parseLimit(query.limit, 100, 300),
  }).catch(() => []);
  const counts = {
    discovered: 0,
    queued: 0,
    claimed: 0,
    waitingUnfollow: 0,
    doneForever: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
    commentedToday: await sfsDoneTodayCount({ agencyId, creatorId: cid }),
    likedComments: 0,
  };
  for (const j of jobs) {
    const result = toPlainObject(j.result);
    const commentsSent = Number(result.commentsSent || 0);
    if (j.action === SFS_ACTION_TARGET) counts.likedComments += sfsLikedComments(result).length;
    const success = j.action === SFS_ACTION_TARGET && j.status === "done" && isSfsDoneForever(result);
    const skippedResult = j.action === SFS_ACTION_TARGET && (
      j.status === "skipped" ||
      j.status === "expired" ||
      (j.status === "done" && !success && (commentsSent <= 0 || String(result.reason || "")))
    );
    if (j.action === SFS_ACTION_UNFOLLOW && ["scheduled", "claimed", "running"].includes(j.status)) counts.waitingUnfollow += 1;
    if (j.action === SFS_ACTION_TARGET && j.status === "scheduled") counts.queued += 1;
    if (j.status === "claimed" || j.status === "running") counts.claimed += 1;
    if (success) counts.doneForever += 1;
    if (j.status === "failed") counts.failed += 1;
    if (skippedResult) counts.skipped += 1;
    if (j.status === "canceled") counts.canceled += 1;
  }
  const templates = await listSfsComments({ agencyId, creatorId: cid, query: { includeTrash: false, limit: 200 } }).catch(() => ({ items: [] }));
  const normalizedJobs = jobs.map((j) => {
    if (j.action !== SFS_ACTION_TARGET) return j;
    const result = toPlainObject(j.result);
    const payload = toPlainObject(j.payload);
    const success = j.status === "done" && isSfsDoneForever(result);
    if (j.status === "done" && !success) {
      return {
        ...j,
        status: "skipped",
        payload: {
          ...payload,
          stage: "skipped_forever",
          lastReason: result.reason || payload.lastReason || "SFS_NO_COMMENTS_SENT",
        },
        result,
      };
    }
    if (success && payload.stage !== "done_forever") {
      return { ...j, payload: { ...payload, stage: "done_forever" }, result };
    }
    return j;
  });
  return { ok: true, creatorId: cid, settings, counts, templates: templates.items || [], items: normalizedJobs };
}

async function resetStaleSfsClaims({ agencyId, claimTimeoutSec = 180 }) {
  const staleBefore = new Date(Date.now() - clampInt(claimTimeoutSec, 180, 60, 86400) * 1000);
  await prisma.automationJob.updateMany({
    where: { agencyId, type: SFS_TYPE, status: { in: ["claimed", "running"] }, claimedAt: { lt: staleBefore } },
    data: { status: "scheduled", claimedByDeviceId: null, claimedAt: null, error: "claim expired; returned to SFS queue" },
  }).catch(() => null);
}

async function claimSfsTarget({ agencyId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  const deviceId = clean(input.deviceId || input.claimedByDeviceId || "unknown", 120) || "unknown";
  const settings = (await getSfsHunterSettings({ agencyId, creatorId })).settings;
  if (!settings.enabled || settings.huntingEnabled === false) return { ok: true, code: "SFS_DISABLED", items: [], settings };
  const templates = (await listSfsComments({ agencyId, creatorId, query: { includeTrash: false, limit: 200 } }).catch(() => ({ items: [] }))).items || [];
  const enabledTemplates = templates.filter((x) => x && x.enabled !== false && !x.trashedAt && clean(x.commentText || x.text, 5000));
  if (!enabledTemplates.length) return { ok: true, code: "NO_SFS_TEMPLATES", items: [], settings };
  const doneToday = await sfsDoneTodayCount({ agencyId, creatorId });
  if (doneToday >= Number(settings.dailyLimit || 20)) return { ok: true, code: "DAILY_LIMIT_REACHED", items: [], settings, doneToday };
  await resetStaleSfsClaims({ agencyId, claimTimeoutSec: input.claimTimeoutSec || 600 });
  const candidates = await prisma.automationJob.findMany({
    where: { agencyId, creatorId, type: SFS_TYPE, action: SFS_ACTION_TARGET, status: "scheduled", runAfter: { lte: new Date() } },
    orderBy: [{ priority: "desc" }, { runAfter: "asc" }, { createdAt: "asc" }],
    take: 5,
  });
  const items = [];
  for (const c of candidates) {
    const updated = await prisma.automationJob.updateMany({ where: { id: c.id, agencyId, status: "scheduled" }, data: { status: "claimed", claimedByDeviceId: deviceId, claimedAt: new Date(), attempts: { increment: 1 } } });
    if (updated.count > 0) {
      const item = await prisma.automationJob.findUnique({ where: { id: c.id } });
      if (item) items.push(item);
      break;
    }
  }
  return { ok: true, items, count: items.length, settings, templates: enabledTemplates, doneToday };
}

async function markSfsTargetUsed({ agencyId, creatorId, targetUserId, targetUsername, sourceJobId = null, result = {} }) {
  const tid = clean(targetUserId, 100);
  if (!tid) return null;
  const dedupeKey = sfsTargetIdDedupeKey(creatorId, tid);
  const existing = await prisma.automationJob.findUnique({ where: { agencyId_dedupeKey: { agencyId, dedupeKey } } }).catch(() => null);
  if (existing) return existing;
  return prisma.automationJob.create({
    data: {
      agencyId,
      creatorId,
      accountId: creatorId,
      type: SFS_TYPE,
      action: SFS_ACTION_USED_MARKER,
      status: "done",
      priority: -100,
      runAfter: new Date(),
      maxAttempts: 1,
      dedupeKey,
      payload: compactJson({ targetUserId: tid, targetUsername: clean(targetUsername, 80), sourceJobId }, 2000),
      result: compactJson({ ...(toPlainObject(result)), usedForeverAt: new Date().toISOString() }, 4000),
      completedAt: new Date(),
    },
  }).catch(() => null);
}

async function completeSfsTarget({ agencyId, jobId, input = {} }) {
  const id = clean(jobId || input.jobId || input.id, 120);
  const existing = id ? await prisma.automationJob.findFirst({ where: { id, agencyId, type: SFS_TYPE, action: SFS_ACTION_TARGET } }) : null;
  if (!existing) {
    const err = new Error("SFS target job not found");
    err.status = 404;
    err.code = "SFS_TARGET_JOB_NOT_FOUND";
    throw err;
  }
  const payload = toPlainObject(existing.payload);
  const result = toPlainObject(input.result || input);
  const targetUserId = clean(input.targetUserId || result.targetUserId || payload.targetUserId, 100);
  const targetUsername = clean(input.targetUsername || result.targetUsername || payload.targetUsername, 80);
  const requestedStatus = clean(input.status || result.status, 40).toLowerCase();
  const commentsSent = Number(result.commentsSent || 0);
  const successfulComment = String(result.reason || "") === "SFS_COMMENTS_SENT" && commentsSent > 0 && sfsResultComments(result).length > 0;
  const alreadyCommented = isSfsAlreadyCommented(result);
  const successfulLikes = isSfsCommentLikeSuccess(result);
  const status = input.ok === false || requestedStatus === "failed"
    ? "failed"
    : (successfulComment || alreadyCommented || successfulLikes)
      ? "done"
      : "skipped";
  const shouldMarkUsed = !!targetUserId && status !== "failed" && input.markUsedForever !== false;
  if (shouldMarkUsed) await markSfsTargetUsed({ agencyId, creatorId: existing.creatorId, targetUserId, targetUsername, sourceJobId: existing.id, result });
  const item = await prisma.automationJob.update({
    where: { id: existing.id },
    data: {
      status,
      result: compactJson(result, 12000),
      error: optional(input.error || result.error, 2000),
      completedAt: new Date(),
      claimedByDeviceId: null,
      claimedAt: existing.claimedAt,
      payload: compactJson({
        ...payload,
        targetUserId: targetUserId || payload.targetUserId || null,
        targetUsername: targetUsername || payload.targetUsername || null,
        stage: status === "done" ? "done_forever" : (status === "skipped" ? "skipped_forever" : status),
        lastReason: result.reason || payload.lastReason || null,
      }, 12000),
    },
  });
  const unfollowAt = safeDate(input.unfollowAt || result.unfollowAt, null);
  if (["done", "skipped"].includes(status) && targetUserId && unfollowAt) {
    const dedupeKey = sfsUnfollowDedupeKey(existing.creatorId, targetUserId);
    const prev = await prisma.automationJob.findUnique({ where: { agencyId_dedupeKey: { agencyId, dedupeKey } } }).catch(() => null);
    const data = {
      agencyId,
      creatorId: existing.creatorId,
      accountId: existing.creatorId,
      fanId: targetUserId,
      type: SFS_TYPE,
      action: SFS_ACTION_UNFOLLOW,
      status: "scheduled",
      priority: -10,
      runAfter: unfollowAt,
      maxAttempts: 5,
      dedupeKey,
      payload: compactJson({ targetUserId, targetUsername, sourceTargetJobId: existing.id, unfollowAt: unfollowAt.toISOString() }, 4000),
      result: compactJson({}, 1000),
    };
    if (!prev) await prisma.automationJob.create({ data }).catch(() => null);
    else if (!["done", "canceled"].includes(prev.status)) await prisma.automationJob.update({ where: { id: prev.id }, data: { runAfter: unfollowAt, status: "scheduled", payload: data.payload } }).catch(() => null);
  }
  const likedComments = Number(result.likedComments || result.likesSent || result.liked || 0) || 0;
  const existingComments = Number(result.existingComments || result.alreadyCommented || 0) || 0;
  let action = "skipped";
  if (status === "failed") action = "failed";
  else if (successfulComment) action = "comment_sent";
  else if (alreadyCommented) action = "already_commented";
  else if (successfulLikes) action = "likes_sent";
  else if (status === "done") action = "done";
  await logEvent({
    agencyId,
    userId: null,
    input: {
      creatorId: existing.creatorId,
      accountId: existing.creatorId,
      jobId: existing.id,
      fanId: targetUserId || null,
      type: `sfs_${action}`,
      status: status === "failed" ? "failed" : status === "skipped" ? "skipped" : "ok",
      metadata: {
        module: "sfs",
        action,
        targetUserId: targetUserId || null,
        targetUsername: targetUsername || null,
        commentsSent,
        existingComments,
        likedComments,
        reason: result.reason || null,
        unfollowAt: unfollowAt?.toISOString?.() || result.unfollowAt || null,
      },
    },
  }).catch(() => null);
  return { ok: true, item };
}

async function claimSfsUnfollow({ agencyId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  const deviceId = clean(input.deviceId || input.claimedByDeviceId || "unknown", 120) || "unknown";
  await resetStaleSfsClaims({ agencyId, claimTimeoutSec: input.claimTimeoutSec || 600 });
  const candidates = await prisma.automationJob.findMany({
    where: { agencyId, creatorId, type: SFS_TYPE, action: SFS_ACTION_UNFOLLOW, status: "scheduled", runAfter: { lte: new Date() } },
    orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
    take: 5,
  });
  const items = [];
  for (const c of candidates) {
    const updated = await prisma.automationJob.updateMany({ where: { id: c.id, agencyId, status: "scheduled" }, data: { status: "claimed", claimedByDeviceId: deviceId, claimedAt: new Date(), attempts: { increment: 1 } } });
    if (updated.count > 0) {
      const item = await prisma.automationJob.findUnique({ where: { id: c.id } });
      if (item) items.push(item);
      break;
    }
  }
  return { ok: true, items, count: items.length };
}

async function completeSfsUnfollow({ agencyId, jobId, input = {} }) {
  const id = clean(jobId || input.jobId || input.id, 120);
  const existing = id ? await prisma.automationJob.findFirst({ where: { id, agencyId, type: SFS_TYPE, action: SFS_ACTION_UNFOLLOW } }) : null;
  if (!existing) {
    const err = new Error("SFS unfollow job not found");
    err.status = 404;
    err.code = "SFS_UNFOLLOW_JOB_NOT_FOUND";
    throw err;
  }
  const result = toPlainObject(input.result || input);
  const status = input.ok === false || input.status === "failed" ? "failed" : "done";
  const item = await prisma.automationJob.update({
    where: { id: existing.id },
    data: {
      status,
      result: compactJson(result, 8000),
      error: optional(input.error || result.error, 2000),
      completedAt: new Date(),
      claimedByDeviceId: null,
    },
  });
  const payload = toPlainObject(existing.payload || {});
  await logEvent({
    agencyId,
    userId: null,
    input: {
      creatorId: existing.creatorId,
      accountId: existing.creatorId,
      jobId: existing.id,
      fanId: payload.targetUserId || existing.fanId || null,
      type: status === "done" ? "sfs_unfollowed" : "sfs_unfollow_failed",
      status: status === "done" ? "ok" : "failed",
      metadata: {
        module: "sfs",
        action: status === "done" ? "unfollowed" : "unfollow_failed",
        targetUserId: payload.targetUserId || existing.fanId || null,
        targetUsername: payload.targetUsername || null,
        reason: result.reason || result.error || input.error || null,
      },
    },
  }).catch(() => null);
  return { ok: true, item };
}

async function checkSfsCommentLikes({ agencyId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  const rows = normalizeSfsCommentLikeRows({
    creatorId,
    targetUserId: input.targetUserId,
    targetUsername: input.targetUsername,
    postId: input.postId,
    comments: input.comments || input.rows || [],
  });
  if (!agencyId || !creatorId || !rows.length) return { ok: true, usedCommentIds: [], used: [], rows: [] };
  const keys = rows.map((row) => row.dedupeKey);
  const found = await prisma.automationJob.findMany({
    where: { agencyId, type: SFS_TYPE, action: SFS_ACTION_COMMENT_LIKE, dedupeKey: { in: keys } },
    select: { dedupeKey: true, payload: true, result: true },
    take: Math.min(1000, keys.length),
  }).catch(() => []);
  const usedKeys = new Set(found.map((x) => x.dedupeKey));
  return {
    ok: true,
    rows,
    used: rows.filter((row) => usedKeys.has(row.dedupeKey)),
    usedCommentIds: rows.filter((row) => usedKeys.has(row.dedupeKey)).map((row) => row.commentId),
  };
}

async function markSfsCommentLikes({ agencyId, input = {} }) {
  const creatorId = clean(input.creatorId || input.accountId, 100);
  const rows = normalizeSfsCommentLikeRows({
    creatorId,
    targetUserId: input.targetUserId,
    targetUsername: input.targetUsername,
    postId: input.postId,
    comments: input.comments || input.rows || [],
  });
  if (!agencyId || !creatorId || !rows.length) return { ok: true, created: 0, skipped: 0, items: [] };
  const items = [];
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const existing = await prisma.automationJob.findUnique({ where: { agencyId_dedupeKey: { agencyId, dedupeKey: row.dedupeKey } } }).catch(() => null);
    if (existing) { skipped += 1; items.push(existing); continue; }
    const item = await prisma.automationJob.create({
      data: {
        agencyId,
        creatorId: row.creatorId,
        accountId: row.creatorId,
        fanId: row.authorId || null,
        type: SFS_TYPE,
        action: SFS_ACTION_COMMENT_LIKE,
        status: "done",
        priority: -100,
        runAfter: new Date(),
        maxAttempts: 1,
        dedupeKey: row.dedupeKey,
        payload: compactJson({
          targetUserId: row.targetUserId,
          targetUsername: row.targetUsername,
          postId: row.postId,
          commentId: row.commentId,
          authorId: row.authorId,
          authorUsername: row.authorUsername,
        }, 4000),
        result: compactJson({
          reason: "SFS_COMMENT_LIKE_OK",
          text: row.text,
          postedAt: row.postedAt,
          likedAt: row.likedAt,
        }, 4000),
        completedAt: new Date(),
      },
    }).catch(() => null);
    if (item) { created += 1; items.push(item); }
    else skipped += 1;
  }
  return { ok: true, created, skipped, items };
}


async function countSfsCommentLikes({ agencyId, query = {} }) {
  const creatorId = clean(query.creatorId || query.accountId, 100);
  if (!agencyId || !creatorId) return { ok: true, count: 0, creatorId };
  const rawDate = clean(query.date, 20) || new Date().toISOString().slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : new Date().toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const where = {
    agencyId,
    creatorId,
    type: SFS_TYPE,
    action: SFS_ACTION_COMMENT_LIKE,
    status: "done",
    completedAt: { gte: start, lt: end },
  };
  const count = await prisma.automationJob.count({ where }).catch(() => 0);
  return { ok: true, creatorId, date: day, count };
}

async function checkSfsTargetUsed({ agencyId, creatorId, targetUserId = null, targetUsername = null }) {
  const cid = clean(creatorId, 100);
  const tid = clean(targetUserId, 100);
  const username = clean(targetUsername, 80).toLowerCase();
  const keys = [];
  if (tid) keys.push(sfsTargetIdDedupeKey(cid, tid));
  if (username) keys.push(sfsUsernameDedupeKey(cid, username));
  if (!keys.length) return { ok: true, used: false };
  const item = await prisma.automationJob.findFirst({ where: { agencyId, dedupeKey: { in: keys } } }).catch(() => null);
  return { ok: true, used: !!item, item, reason: item ? "ALREADY_USED_FOREVER" : null };
}


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

function automationActivityFromFollowBack(row = {}) {
  const meta = toPlainObject(row.result || {});
  const status = clean(row.status || "pending", 40).toLowerCase();
  const action = status === "done" ? "done" : status === "failed" ? "failed" : status === "skipped" ? "skipped" : "queued";
  const m = { ...meta, fanUsername: row.username || row.name || row.fanId, reason: row.reason || row.error || meta.reason || null };
  return {
    id: `follow:${row.id}`,
    createdAt: row.lastResultAt || row.updatedAt || row.createdAt,
    ts: row.lastResultAt || row.updatedAt || row.createdAt,
    module: "follow_back",
    action,
    status: status === "failed" ? "failed" : status === "skipped" ? "skipped" : status === "done" ? "ok" : "info",
    creatorId: row.creatorId,
    accountId: row.creatorId,
    fanId: row.fanId,
    fanUsername: row.username || row.name || null,
    reason: row.reason || row.error || null,
    title: activityTitle({ module: "follow_back", action, meta: m, fanId: row.fanId }),
    result: activityResultText({ module: "follow_back", action, status, meta: m }),
    meta: m,
  };
}

function automationActivityFromSfsJob(row = {}) {
  const payload = toPlainObject(row.payload || {});
  const result = toPlainObject(row.result || {});
  const meta = { ...payload, ...result, targetUsername: result.targetUsername || payload.targetUsername, targetUserId: result.targetUserId || payload.targetUserId, jobId: row.id };
  const status = clean(row.status || "scheduled", 40).toLowerCase();
  let action = "queued";
  const reason = clean(result.reason || "", 120);
  if (status === "done") {
    if (Number(result.commentsSent || 0) > 0) action = "comment_sent";
    else if (Number(result.existingComments || 0) > 0 || reason === "SFS_ALREADY_COMMENTED") action = "already_commented";
    else if (Number(result.likedComments || result.likesSent || 0) > 0) action = "likes_sent";
    else action = "done";
  } else if (status === "skipped") action = "skipped";
  else if (status === "failed") action = "failed";
  return {
    id: `sfs:${row.id}`,
    createdAt: row.completedAt || row.updatedAt || row.createdAt,
    ts: row.completedAt || row.updatedAt || row.createdAt,
    module: "sfs",
    action,
    status: status === "failed" ? "failed" : status === "skipped" ? "skipped" : status === "done" ? "ok" : "info",
    creatorId: row.creatorId || row.accountId,
    accountId: row.accountId || row.creatorId,
    targetUserId: meta.targetUserId || null,
    targetUsername: meta.targetUsername || null,
    jobId: row.id,
    reason: reason || null,
    title: activityTitle({ module: "sfs", action, meta }),
    result: activityResultText({ module: "sfs", action, status, meta }),
    meta,
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
  const [events, deliveries, follows, sfsJobs] = await Promise.all([
    prisma.automationEvent.findMany({ where: eventWhere, orderBy: { createdAt: "desc" }, take: Math.min(120, Math.ceil(take * 1.5)) }).catch(() => []),
    prisma.automationDelivery.findMany({ where: { agencyId, ...(creatorId ? { creatorId } : {}), OR: [{ updatedAt: { gte: since } }, { sentAt: { gte: since } }, { createdAt: { gte: since } }] }, orderBy: { updatedAt: "desc" }, take: Math.min(90, Math.ceil(take * 1.5)) }).catch(() => []),
    prisma.followBackTask.findMany({ where: { agencyId, ...(creatorId ? { creatorId } : {}), updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: Math.min(90, Math.ceil(take * 1.5)) }).catch(() => []),
    prisma.automationJob.findMany({ where: { agencyId, ...(creatorId ? { OR: [{ creatorId }, { accountId: creatorId }] } : {}), type: "sfs_hunter", updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: Math.min(90, Math.ceil(take * 1.5)) }).catch(() => []),
  ]);
  const rows = [];
  for (const row of events || []) rows.push(automationActivityFromEvent(row));
  for (const row of deliveries || []) rows.push(automationActivityFromDelivery(row));
  for (const row of follows || []) rows.push(automationActivityFromFollowBack(row));
  for (const row of sfsJobs || []) rows.push(automationActivityFromSfsJob(row));
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
  checkSfsTargetUsed,
  checkSfsCommentLikes,
  markSfsCommentLikes,
  countSfsCommentLikes,
  completeSfsUnfollow,
  claimSfsUnfollow,
  completeSfsTarget,
  claimSfsTarget,
  ingestSfsTargets,
  listSfsHunterState,
  saveSfsHunterSettings,
  getSfsHunterSettings,
  gcExpiredBumps,
  listJobs,
  enqueueJob,
  claimJobs,
  cancelJobs,
  getJob,
  completeJob,
  logEvent,
  listEvents,
  listActivity,
  taskToBump,
};
