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

const TASK_TYPES = new Set([
  "bump_online",
  "hidden_online_scan",
  "hidden_online_list_sync",
  "follow_back",
  "winback",
  "ai_chatter",
  "social_action",
  "custom",
]);

const JOB_STATUSES = new Set(["scheduled", "claimed", "running", "done", "failed", "canceled", "expired"]);
const EVENT_STATUSES = new Set(["info", "ok", "failed", "skipped", "warning"]);
const RAW_KEY_RE = /(^|_)(raw|html|payload|headers|cookies|token|authorization|password|secret)($|_)/i;

function clean(value, max = 5000) {
  return cleanString(value, max);
}

function optional(value, max = 5000) {
  return optionalString(value, max);
}

function normalizeTaskType(value) {
  const type = clean(value || "custom", 80).toLowerCase() || "custom";
  return TASK_TYPES.has(type) ? type : "custom";
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
    enabled: input.enabled !== false && !input.trashedAt,
    status: input.trashedAt ? "deleted" : "active",
    config,
    triggers,
    rules,
    stats: input.stats || {},
    metadata: { legacyBump: true, createdAt: input.createdAt || null, updatedAt: input.updatedAt || null },
  };
}

function taskToBump(task) {
  const config = task?.config && typeof task.config === "object" ? task.config : {};
  const rules = task?.rules && typeof task.rules === "object" ? task.rules : {};
  const triggers = task?.triggers && typeof task.triggers === "object" ? task.triggers : {};
  const stats = task?.stats && typeof task.stats === "object" ? task.stats : {};
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
    trashedAt: task.deletedAt || task.status === "deleted" ? (task.deletedAt || task.updatedAt) : null,
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
  const item = await prisma.automationTask.update({ where: { id: existing.id }, data: { status: "deleted", enabled: false, deletedAt: new Date(), updatedByUserId: userId || null } });
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
  const item = await prisma.automationTask.update({ where: { id: existing.id }, data: { status: "active", deletedAt: null, updatedByUserId: userId || null } });
  return { ok: true, item };
}

async function listBumps({ agencyId, creatorId, query = {} }) {
  const result = await listTasks({ agencyId, query: { ...query, type: "bump_online", creatorId, includeDeleted: query.includeTrash ?? query.includeDeleted ?? true } });
  const includeTrash = query.includeTrash !== "false" && query.includeTrash !== false;
  const items = result.items.map(taskToBump).filter((item) => includeTrash || !item.trashedAt);
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
  if (data.dedupeKey) {
    item = await prisma.automationJob.upsert({
      where: { agencyId_dedupeKey: { agencyId, dedupeKey: data.dedupeKey } },
      create: data,
      update: {
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
  return { ok: true, item };
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
  listJobs,
  enqueueJob,
  claimJobs,
  completeJob,
  logEvent,
  listEvents,
  taskToBump,
};
