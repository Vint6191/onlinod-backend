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

const JOB_STATUSES = new Set(["scheduled", "claimed", "running", "done", "failed", "canceled", "expired"]);
const EVENT_STATUSES = new Set(["info", "ok", "failed", "skipped", "warning"]);
const RAW_KEY_RE = /(^|_)(raw|html|payload|headers|cookies|token|authorization|password|secret)($|_)/i;
const BUMP_TRASH_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

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

  const where = { agencyId, status: "scheduled", runAfter: { lte: now } };
  if (types.length) where.type = { in: types };
  if (creatorId) where.creatorId = creatorId;
  const candidates = await prisma.automationJob.findMany({
    where,
    orderBy: [{ priority: "desc" }, { runAfter: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  const items = [];
  for (const candidate of candidates) {
    const updated = await prisma.automationJob.updateMany({
      where: { id: candidate.id, agencyId, status: "scheduled" },
      data: { status: "claimed", claimedByDeviceId: deviceId, claimedAt: now, attempts: { increment: 1 } },
    });
    if (updated.count > 0) {
      const job = await prisma.automationJob.findUnique({ where: { id: candidate.id } });
      if (job) items.push(job);
    }
  }
  return { ok: true, items, count: items.length };
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
  const [items, count] = await Promise.all([
    prisma.automationEvent.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.automationEvent.count({ where }),
  ]);
  return { ok: true, items, count, nextOffset: skip + items.length, hasMore: skip + items.length < count };
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
  listJobs,
  enqueueJob,
  claimJobs,
  cancelJobs,
  getJob,
  completeJob,
  logEvent,
  listEvents,
  taskToBump,
};
