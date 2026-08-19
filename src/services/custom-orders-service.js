"use strict";

const crypto = require("node:crypto");

const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const {
  normalizeReminderOverride,
  nextReminderForOrder,
  readWorkspaceReminderPolicy,
  reminderText,
  resolveTelegramAccountId,
  taskText,
} = require("./custom-order-reminders");

const CUSTOM_ORDER_STATUSES = Object.freeze(["PENDING", "COMPLETED", "MISSED", "CANCELLED"]);
const CUSTOM_ORDER_TYPES = Object.freeze(["CONTENT", "CALL", "PHYSICAL"]);
const CUSTOM_ORDER_CONTENT_KINDS = Object.freeze(["PHOTO", "VIDEO", "BOTH"]);
const CUSTOM_ORDER_PHYSICAL_STATUSES = Object.freeze(["WAITING", "READY", "SHIPPED", "COMPLETED"]);
const STATUS_SET = new Set(CUSTOM_ORDER_STATUSES);
const TYPE_SET = new Set(CUSTOM_ORDER_TYPES);
const CONTENT_KIND_SET = new Set(CUSTOM_ORDER_CONTENT_KINDS);
const PHYSICAL_STATUS_SET = new Set(CUSTOM_ORDER_PHYSICAL_STATUSES);
const MAX_SCENARIO = 12_000;
const MAX_NOTE = 4_000;
const MAX_CANCEL_REASON = 1_000;
const MAX_MEDIA_IDS = 200;
const MAX_REFERENCE_MESSAGES = 50;
const MAX_SUBMISSION_MESSAGES = 500;
const MAX_PRICE_CENTS = 2_147_483_647;
const DUE_SOON_MS = 3 * 60 * 60 * 1000;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function optional(value, max = 500, field = "value") {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  if (text.length > max) throw fail(`CUSTOM_ORDER_${field.toUpperCase()}_TOO_LONG`, `${field} is too long (max ${max} characters)`);
  return text;
}
function required(value, field, max) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw fail(`CUSTOM_ORDER_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  if (text.length > max) throw fail(`CUSTOM_ORDER_${field.toUpperCase()}_TOO_LONG`, `${field} is too long (max ${max} characters)`);
  return text;
}
function optionalIdentifier(value, field, max = 180) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  if (text.length > max) throw fail(`CUSTOM_ORDER_${field.toUpperCase()}_TOO_LONG`, `${field} is too long (max ${max} characters)`);
  return text;
}
function parseIso(value, field, { allowNull = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw fail(`CUSTOM_ORDER_${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail(`CUSTOM_ORDER_${field.toUpperCase()}_INVALID`, `${field} must be a valid date-time`);
  return date;
}
function normalizeEnum(value, fallback, set, code, label) {
  const normalized = String(value == null || value === "" ? fallback : value).trim().toUpperCase();
  if (!set.has(normalized)) throw fail(code, `Unsupported ${label}: ${normalized}`);
  return normalized;
}
function normalizeStatus(value, fallback = "PENDING") { return normalizeEnum(value, fallback, STATUS_SET, "CUSTOM_ORDER_STATUS_INVALID", "custom order status"); }
function normalizeType(value, fallback = "CONTENT") { return normalizeEnum(value, fallback, TYPE_SET, "CUSTOM_ORDER_TYPE_INVALID", "custom order type"); }
function normalizeContentKind(value, fallback = "BOTH") { return normalizeEnum(value, fallback, CONTENT_KIND_SET, "CUSTOM_ORDER_CONTENT_KIND_INVALID", "content kind"); }
function normalizePhysicalStatus(value, fallback = "WAITING") { return normalizeEnum(value, fallback, PHYSICAL_STATUS_SET, "CUSTOM_ORDER_PHYSICAL_STATUS_INVALID", "physical status"); }
function normalizeDuration(value, { allowNull = true } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw fail("CUSTOM_ORDER_DURATION_REQUIRED", "durationMinutes is required");
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1440) throw fail("CUSTOM_ORDER_DURATION_INVALID", "durationMinutes must be between 1 and 1440");
  return Math.round(numeric);
}
function moneyToCents(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  const cents = Math.round(number * 100);
  if (cents > MAX_PRICE_CENTS) throw fail("CUSTOM_ORDER_PRICE_TOO_LARGE", "price exceeds storage limit");
  return cents;
}
function normalizePriceCents(input, fallback = 0) {
  if (input?.priceCents !== undefined) {
    const value = Number(input.priceCents);
    if (!Number.isFinite(value) || value < 0) throw fail("CUSTOM_ORDER_PRICE_INVALID", "priceCents must be a non-negative number");
    const cents = Math.round(value);
    if (cents > MAX_PRICE_CENTS) throw fail("CUSTOM_ORDER_PRICE_TOO_LARGE", "priceCents exceeds storage limit");
    return cents;
  }
  if (input?.price !== undefined) {
    const value = Number(input.price);
    if (!Number.isFinite(value) || value < 0) throw fail("CUSTOM_ORDER_PRICE_INVALID", "price must be a non-negative number");
    return moneyToCents(value, fallback);
  }
  return fallback;
}
function normalizeMediaIds(value, { strict = false } = {}) {
  const raw = Array.isArray(value) ? value : String(value == null ? "" : value).split(/[\s,;]+/g);
  const ids = []; const seen = new Set();
  for (const item of raw) {
    const id = String(item == null ? "" : item).trim();
    if (!id || seen.has(id)) continue;
    if (strict && id.length > 100) throw fail("CUSTOM_ORDER_MEDIA_ID_TOO_LONG", "mediaId is too long (max 100 characters)");
    seen.add(id); ids.push(strict ? id : id.slice(0, 100));
  }
  if (strict && ids.length > MAX_MEDIA_IDS) throw fail("CUSTOM_ORDER_MEDIA_IDS_LIMIT", `Too many media IDs (max ${MAX_MEDIA_IDS})`);
  return ids.slice(0, MAX_MEDIA_IDS);
}
function mediaIdsArray(value) { return normalizeMediaIds(value); }
function mediaIdsString(value) { return normalizeMediaIds(value, { strict: true }).join(" "); }
function telegramMessageId(value, field = "telegramMessageId") {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > 2_147_483_647) throw fail("CUSTOM_ORDER_TELEGRAM_MESSAGE_ID_INVALID", `${field} must be a positive Telegram message id`);
  return numeric;
}
function telegramMessageIds(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set(); const result = [];
  for (const item of raw) {
    const id = telegramMessageId(item, "telegramReferenceMessageId");
    if (id == null || seen.has(id)) continue;
    seen.add(id); result.push(id);
  }
  if (result.length > MAX_REFERENCE_MESSAGES) throw fail("CUSTOM_ORDER_REFERENCE_MESSAGES_LIMIT", `Too many Telegram reference messages (max ${MAX_REFERENCE_MESSAGES})`);
  return result;
}
function memberLabel(member) { return member?.displayName || member?.user?.name || member?.user?.email || null; }
function creatorLabel(creator) { return creator?.displayName || creator?.username || creator?.id || null; }

const ORDER_INCLUDE = Object.freeze({
  creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, telegramContact: true, telegramUserId: true, telegramAccountId: true } },
  createdByMember: { select: { id: true, displayName: true, roleKey: true, user: { select: { name: true, email: true } } } },
});

function serializeOrder(row, now = new Date()) {
  if (!row) return null;
  const dueAt = row.dueAt ? new Date(row.dueAt) : null;
  const scheduledAt = row.scheduledAt ? new Date(row.scheduledAt) : null;
  const status = normalizeStatus(row.status);
  const type = normalizeType(row.type || "CONTENT");
  const relevantAt = type === "CALL" ? scheduledAt : type === "CONTENT" ? dueAt : null;
  const dueMs = relevantAt && Number.isFinite(relevantAt.getTime()) ? relevantAt.getTime() - now.getTime() : null;
  return {
    id: String(row.id), dialogId: String(row.dialogId), scenario: String(row.scenario || ""), internalNote: row.internalNote || null,
    type,
    contentKind: type === "CONTENT" ? normalizeContentKind(row.contentKind || "BOTH") : null,
    status,
    dueAt: dueAt ? dueAt.toISOString() : null,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    durationMinutes: row.durationMinutes == null ? null : Number(row.durationMinutes),
    physicalStatus: type === "PHYSICAL" ? normalizePhysicalStatus(row.physicalStatus || "WAITING") : null,
    acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
    cancelReason: row.cancelReason || null,
    mediaIds: mediaIdsArray(row.mediaIds),
    priceCents: Math.max(0, Number(row.priceCents || 0)), price: Math.max(0, Number(row.priceCents || 0)) / 100,
    telegramTaskMessageId: row.telegramTaskMessageId == null ? null : String(row.telegramTaskMessageId),
    telegramTaskTransport: String(row.telegramTaskTransport || "USER"),
    telegramReferenceMessageIds: Array.isArray(row.telegramReferenceMessageIds) ? row.telegramReferenceMessageIds.map(String) : [],
    telegramUploadState: normalizeStatus(row.status) !== "PENDING" || type !== "CONTENT" ? "NONE" : row.telegramUploadArmedAt ? "WAITING" : (Array.isArray(row.telegramSubmissionMessageIds) && row.telegramSubmissionMessageIds.length ? "SUBMITTED" : "READY"),
    telegramSubmissionCount: Array.isArray(row.telegramSubmissionMessageIds) ? row.telegramSubmissionMessageIds.length : 0,
    telegramSubmissionReceivedAt: row.telegramSubmissionReceivedAt ? new Date(row.telegramSubmissionReceivedAt).toISOString() : null,
    telegramLastModelMessageId: row.telegramLastModelMessageId == null ? null : String(row.telegramLastModelMessageId),
    telegramLastModelMessageAt: row.telegramLastModelMessageAt ? new Date(row.telegramLastModelMessageAt).toISOString() : null,
    reminderConfig: row.reminderConfig && typeof row.reminderConfig === "object" ? row.reminderConfig : null,
    nextReminderAt: row.nextReminderAt ? new Date(row.nextReminderAt).toISOString() : null,
    lastReminderAt: row.lastReminderAt ? new Date(row.lastReminderAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
    isOverdue: status === "PENDING" && dueMs !== null && dueMs < 0,
    isDueSoon: status === "PENDING" && dueMs !== null && dueMs >= 0 && dueMs <= DUE_SOON_MS,
    dueInMs: status === "PENDING" ? dueMs : null,
    creator: row.creator ? { name: creatorLabel(row.creator), displayName: row.creator.displayName || null, username: row.creator.username || null, avatarUrl: row.creator.avatarUrl || null } : null,
    createdBy: row.createdByMember ? { name: memberLabel(row.createdByMember), displayName: row.createdByMember.displayName || null, roleKey: row.createdByMember.roleKey || null } : null,
  };
}

function scopeWhere(scope) { if (scope?.broad) return {}; const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : []; return { creatorId: { in: ids.length ? ids : ["__none__"] } }; }
async function actorScope({ agencyId, member, creatorId = null, db = null }) { const client = db || require("../prisma"); return allowedCreatorScope({ agencyId, member, requestedCreatorId: creatorId || null, db: client }); }
function normalizeListStatus(value, pendingOnly) { if (pendingOnly === true) return "PENDING"; const raw = String(value || "").trim().toUpperCase(); if (!raw || raw === "ALL") return null; return normalizeStatus(raw); }

async function listCustomOrders({ agencyId, member, creatorId = null, dialogId = null, status = null, pendingOnly = false, limit = 100, offset = 0, now = new Date(), db = null } = {}) {
  if (!agencyId || !member) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const requestedCreatorId = optionalIdentifier(creatorId, "creatorId", 100);
  const scope = await actorScope({ agencyId, member, creatorId: requestedCreatorId, db: client });
  const requestedDialogId = optionalIdentifier(dialogId, "dialogId", 100);
  const normalizedStatus = normalizeListStatus(status, pendingOnly);
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))); const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const where = { agencyId, ...scopeWhere(scope), ...(requestedCreatorId ? { creatorId: requestedCreatorId } : {}), ...(requestedDialogId ? { dialogId: requestedDialogId } : {}), ...(normalizedStatus ? { status: normalizedStatus } : {}) };
  const countScope = { agencyId, ...scopeWhere(scope), ...(requestedCreatorId ? { creatorId: requestedCreatorId } : {}), ...(requestedDialogId ? { dialogId: requestedDialogId } : {}) };
  const dueSoonCeiling = new Date(now.getTime() + DUE_SOON_MS);
  const [items, count, pendingCount, completedCount, missedCount, cancelledCount, overdueCount, dueSoonCount] = await Promise.all([
    client.customOrder.findMany({ where, include: ORDER_INCLUDE, orderBy: [{ status: "asc" }, { dueAt: { sort: "asc", nulls: "last" } }, { scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }], take, skip }),
    client.customOrder.count({ where }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING" } }),
    client.customOrder.count({ where: { ...countScope, status: "COMPLETED" } }),
    client.customOrder.count({ where: { ...countScope, status: "MISSED" } }),
    client.customOrder.count({ where: { ...countScope, status: "CANCELLED" } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", OR: [{ type: "CONTENT", dueAt: { lt: now } }, { type: "CALL", scheduledAt: { lt: now } }] } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", OR: [{ type: "CONTENT", dueAt: { gte: now, lte: dueSoonCeiling } }, { type: "CALL", scheduledAt: { gte: now, lte: dueSoonCeiling } }] } }),
  ]);
  return { ok: true, items: items.map((row) => serializeOrder(row, now)), count, nextOffset: skip + items.length, hasMore: skip + items.length < count, counts: { pending: pendingCount, completed: completedCount, missed: missedCount, cancelled: cancelledCount, overdue: overdueCount, dueSoon: dueSoonCount }, serverNow: now.toISOString() };
}

function normalizeCreateInput(input = {}) {
  const type = normalizeType(input.type || "CONTENT");
  const data = {
    creatorId: required(input.creatorId, "creatorId", 100), dialogId: required(input.dialogId, "dialogId", 100), scenario: required(input.scenario, "scenario", MAX_SCENARIO),
    internalNote: optional(input.internalNote, MAX_NOTE, "internalNote"), type,
    contentKind: type === "CONTENT" ? normalizeContentKind(input.contentKind || "BOTH") : null,
    dueAt: type === "CONTENT" ? parseIso(input.dueAt, "dueAt") : null,
    scheduledAt: type === "CALL" ? parseIso(input.scheduledAt, "scheduledAt", { allowNull: false }) : null,
    durationMinutes: type === "CALL" ? normalizeDuration(input.durationMinutes) : null,
    physicalStatus: type === "PHYSICAL" ? normalizePhysicalStatus(input.physicalStatus || "WAITING") : null,
    mediaIds: mediaIdsString(input.mediaIds), priceCents: normalizePriceCents(input, 0),
    reminderConfig: input.reminderConfig === undefined ? null : normalizeReminderOverride(type, input.reminderConfig),
  };
  return data;
}

async function createCustomOrder({ agencyId, member, input, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma"); const data = normalizeCreateInput(input || {});
  await requireCreatorAccess({ agencyId, member, creatorId: data.creatorId, db: client });
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
  const seed = { ...data, status: "PENDING", createdAt: now, lastReminderAt: null, lastReminderKey: null };
  const nextReminderAt = nextReminderForOrder(seed, workspacePolicy, now).at;
  const uploadKey = data.type === "CONTENT" ? crypto.randomBytes(18).toString("base64url") : null;
  const row = await client.customOrder.create({ data: { agencyId, creatorId: data.creatorId, dialogId: data.dialogId, createdByMemberId: member.id, scenario: data.scenario, internalNote: data.internalNote, type: data.type, contentKind: data.contentKind, status: "PENDING", telegramUploadKey: uploadKey, dueAt: data.dueAt, scheduledAt: data.scheduledAt, durationMinutes: data.durationMinutes, physicalStatus: data.physicalStatus, mediaIds: data.mediaIds, priceCents: data.priceCents, reminderConfig: data.reminderConfig, nextReminderAt }, include: ORDER_INCLUDE });
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.create", targetType: "CustomOrder", targetId: row.id, metadata: { creatorId: row.creatorId, dialogId: row.dialogId, type: row.type, status: row.status, dueAt: row.dueAt, scheduledAt: row.scheduledAt, priceCents: row.priceCents }, db: client });
  return { ok: true, order: serializeOrder(row, now) };
}

async function loadOwnedOrder({ agencyId, member, orderId, db = null }) {
  const client = db || require("../prisma"); const id = required(orderId, "id", 180);
  const row = await client.customOrder.findFirst({ where: { id, agencyId }, include: ORDER_INCLUDE });
  if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client }); return row;
}

function buildUpdateData(current, input = {}, now = new Date()) {
  const patch = {}; const nextType = input.type === undefined ? normalizeType(current.type || "CONTENT") : normalizeType(input.type);
  if (input.scenario !== undefined) patch.scenario = required(input.scenario, "scenario", MAX_SCENARIO);
  if (input.internalNote !== undefined) patch.internalNote = optional(input.internalNote, MAX_NOTE, "internalNote");
  if (input.type !== undefined) patch.type = nextType;
  if (nextType === "CONTENT") {
    if (input.contentKind !== undefined || input.type !== undefined) patch.contentKind = normalizeContentKind(input.contentKind ?? current.contentKind ?? "BOTH");
    if (input.dueAt !== undefined || input.type !== undefined) patch.dueAt = parseIso(input.dueAt ?? (input.type === undefined ? current.dueAt : null), "dueAt");
    if (input.type !== undefined) { patch.scheduledAt = null; patch.durationMinutes = null; patch.physicalStatus = null; }
  } else if (nextType === "CALL") {
    if (input.scheduledAt !== undefined || input.type !== undefined) patch.scheduledAt = parseIso(input.scheduledAt ?? current.scheduledAt, "scheduledAt", { allowNull: false });
    if (input.durationMinutes !== undefined || input.type !== undefined) patch.durationMinutes = normalizeDuration(input.durationMinutes ?? current.durationMinutes);
    if (input.type !== undefined) { patch.contentKind = null; patch.dueAt = null; patch.physicalStatus = null; }
  } else {
    if (input.physicalStatus !== undefined || input.type !== undefined) patch.physicalStatus = normalizePhysicalStatus(input.physicalStatus ?? current.physicalStatus ?? "WAITING");
    if (input.type !== undefined) { patch.contentKind = null; patch.dueAt = null; patch.scheduledAt = null; patch.durationMinutes = null; }
  }
  if (input.mediaIds !== undefined) patch.mediaIds = mediaIdsString(input.mediaIds);
  if (input.price !== undefined || input.priceCents !== undefined) patch.priceCents = normalizePriceCents(input, current.priceCents || 0);
  if (input.acceptedAt !== undefined) patch.acceptedAt = parseIso(input.acceptedAt, "acceptedAt");
  if (input.reminderConfig !== undefined) patch.reminderConfig = input.reminderConfig === null ? null : normalizeReminderOverride(nextType, input.reminderConfig);

  let nextStatus = input.status === undefined ? normalizeStatus(current.status) : normalizeStatus(input.status);
  const nextPhysical = patch.physicalStatus ?? current.physicalStatus;
  if (nextType === "PHYSICAL" && nextPhysical === "COMPLETED") nextStatus = "COMPLETED";
  if (input.status !== undefined || nextStatus !== normalizeStatus(current.status)) patch.status = nextStatus;
  if (nextStatus === "COMPLETED") {
    if (normalizeStatus(current.status) !== "COMPLETED" || !current.completedAt) patch.completedAt = new Date(now);
    if (nextType === "PHYSICAL") patch.physicalStatus = "COMPLETED";
    patch.cancelledAt = null; patch.cancelReason = null;
  } else if (nextStatus === "MISSED") {
    if (nextType !== "CALL") throw fail("CUSTOM_ORDER_MISSED_CALL_ONLY", "Only call customs can be marked missed");
    patch.completedAt = null; patch.cancelledAt = null; patch.cancelReason = null;
  } else if (nextStatus === "CANCELLED") {
    const reason = input.cancelReason !== undefined ? optional(input.cancelReason, MAX_CANCEL_REASON, "cancelReason") : optional(current.cancelReason, MAX_CANCEL_REASON, "cancelReason");
    if (!reason) throw fail("CUSTOM_ORDER_CANCEL_REASON_REQUIRED", "cancelReason is required when cancelling a custom order");
    patch.cancelReason = reason; if (normalizeStatus(current.status) !== "CANCELLED" || !current.cancelledAt) patch.cancelledAt = new Date(now); patch.completedAt = null;
  } else if (nextStatus === "PENDING") { patch.completedAt = null; patch.cancelledAt = null; patch.cancelReason = null; }
  return patch;
}

async function updateCustomOrder({ agencyId, member, orderId, input, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma"); const current = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  const expectedCreatorId = optionalIdentifier(input?.creatorId, "creatorId", 100); if (expectedCreatorId && expectedCreatorId !== String(current.creatorId)) throw fail("CUSTOM_ORDER_CREATOR_MISMATCH", "Custom order does not belong to the requested creator", 404);
  const currentStatus = normalizeStatus(current.status); const requestedStatus = input?.status === undefined ? null : normalizeStatus(input.status);
  if (currentStatus !== "PENDING") { if (requestedStatus === currentStatus) return { ok: true, order: serializeOrder(current, now) }; throw fail("CUSTOM_ORDER_ALREADY_FINALIZED", "Completed, missed or cancelled custom orders cannot be changed", 409); }
  const hasPendingContentReview = normalizeType(current.type || "CONTENT") === "CONTENT" && Array.isArray(current.telegramSubmissionMessageIds) && current.telegramSubmissionMessageIds.length > 0;
  if (hasPendingContentReview && requestedStatus === "COMPLETED") {
    throw fail("CUSTOM_ORDER_CONTENT_REVIEW_REQUIRED", "Model media is waiting for Content Team review before this custom can be completed", 409);
  }
  if (hasPendingContentReview && input?.type !== undefined && normalizeType(input.type) !== "CONTENT") {
    throw fail("CUSTOM_ORDER_CONTENT_REVIEW_REQUIRED", "Content type cannot be changed while model media is waiting for Content Team review", 409);
  }
  const patch = buildUpdateData(current, input || {}, now);
  const prospective = { ...current, ...patch };
  if (normalizeStatus(prospective.status) === "PENDING") {
    const reminderTimingChanged = input?.reminderConfig !== undefined || input?.type !== undefined || (normalizeType(prospective.type || "CONTENT") === "CALL" && input?.scheduledAt !== undefined);
    if (reminderTimingChanged) {
      const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
      const type = normalizeType(prospective.type || "CONTENT");
      if (type === "CALL") patch.nextReminderAt = nextReminderForOrder(prospective, workspacePolicy, now).at;
      else if (prospective.telegramTaskMessageId == null) patch.nextReminderAt = null;
      else if (prospective.lastReminderAt) patch.nextReminderAt = nextReminderForOrder(prospective, workspacePolicy, now, { afterAck: true }).at;
      else patch.nextReminderAt = nextReminderForOrder({ ...prospective, createdAt: now }, workspacePolicy, now).at;
      patch.reminderClaimToken = null; patch.reminderClaimUntil = null;
    }
  } else { patch.nextReminderAt = null; patch.reminderClaimToken = null; patch.reminderClaimUntil = null; patch.telegramUploadArmedAt = null; }
  const changed = await client.customOrder.updateMany({ where: { id: current.id, agencyId, status: "PENDING", updatedAt: current.updatedAt }, data: patch });
  if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_ORDER_CONFLICT", "Custom order changed while this update was being applied; refresh and try again", 409);
  const row = await client.customOrder.findFirst({ where: { id: current.id, agencyId }, include: ORDER_INCLUDE }); if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found after update", 404);
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.update", targetType: "CustomOrder", targetId: row.id, metadata: { creatorId: row.creatorId, dialogId: row.dialogId, type: row.type, previousStatus: current.status, status: row.status, dueAt: row.dueAt, scheduledAt: row.scheduledAt, physicalStatus: row.physicalStatus, priceCents: row.priceCents }, db: client });
  return { ok: true, order: serializeOrder(row, now) };
}

async function recordTelegramDelivery({ agencyId, member, orderId, taskMessageId, referenceMessageIds, transport = "USER", botControlMessageId = null, now = new Date(), db = null }) {
  const client = db || require("../prisma"); const current = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  const taskId = telegramMessageId(taskMessageId, "telegramTaskMessageId");
  if (taskId == null) throw fail("CUSTOM_ORDER_TELEGRAM_TASK_MESSAGE_REQUIRED", "telegramTaskMessageId is required");
  if (current.telegramTaskMessageId != null && Number(current.telegramTaskMessageId) !== taskId) throw fail("CUSTOM_ORDER_TELEGRAM_TASK_MESSAGE_CONFLICT", "Telegram task message is already linked to this custom order", 409);
  const refs = telegramMessageIds([...(Array.isArray(current.telegramReferenceMessageIds) ? current.telegramReferenceMessageIds : []), ...telegramMessageIds(referenceMessageIds)]);
  const normalizedTransport = String(transport || current.telegramTaskTransport || "USER").toUpperCase() === "BOT" ? "BOT" : "USER";
  const existingTransport = String(current.telegramTaskTransport || "USER").toUpperCase() === "BOT" ? "BOT" : "USER";
  const firstTaskDelivery = current.telegramTaskMessageId == null;
  if (!firstTaskDelivery && normalizedTransport !== existingTransport) {
    throw fail("CUSTOM_ORDER_TELEGRAM_TRANSPORT_CONFLICT", "Telegram task transport is already fixed for this custom order", 409);
  }
  const controlId = telegramMessageId(botControlMessageId, "telegramBotControlMessageId");
  let nextReminderAt = current.nextReminderAt || null;
  if (firstTaskDelivery && normalizeStatus(current.status) === "PENDING") {
    const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
    const schedulingSeed = String(current.type || "CONTENT").toUpperCase() === "CALL" ? current : { ...current, createdAt: now };
    nextReminderAt = nextReminderForOrder(schedulingSeed, workspacePolicy, now).at;
  }
  const row = await client.customOrder.update({
    where: { id: current.id },
    data: { telegramTaskMessageId: taskId, telegramTaskTransport: normalizedTransport, telegramBotControlMessageId: controlId ?? current.telegramBotControlMessageId ?? null, telegramReferenceMessageIds: refs, deliveredAt: current.deliveredAt || now, ...(firstTaskDelivery ? { nextReminderAt } : {}) },
    include: ORDER_INCLUDE,
  });
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_delivered", targetType: "CustomOrder", targetId: row.id, metadata: { taskMessageId: taskId, referenceCount: refs.length, transport: normalizedTransport }, db: client });
  return { ok: true, order: serializeOrder(row, now) };
}

async function prepareTelegramTask({ agencyId, member, orderId, db = null }) {
  const client = db || require("../prisma"); const row = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  if (!String(row.creator?.telegramContact || "").trim()) throw fail("CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED", "Model has no Telegram contact", 409);
  const accountId = await resolveTelegramAccountId({ agencyId, creator: row.creator, db: client });
  if (!accountId) throw fail("CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "Assign a Telegram connection to this model, or keep exactly one Telegram connection in the workspace", 409);
  const account = await client.agencyTelegramMtprotoAccount.findFirst({ where: { id: accountId, agencyId }, select: { customBotUsername: true, encryptedPayload: true, iv: true, tag: true, algorithm: true, payloadVersion: true } });
  let customBotReady = false;
  try { const { decryptTelegramCredentials } = require("./telegram-mtproto-credentials"); customBotReady = Boolean(String(account?.customBotUsername || "").trim() && String(decryptTelegramCredentials(account || {}).customBotToken || "").trim()); } catch (_) {}
  return { ok: true, delivery: { orderId: row.id, creatorId: row.creatorId, accountId, text: taskText(row), transport: String(row.telegramTaskTransport || "USER"), customBotReady, customBotUsername: account?.customBotUsername || null, uploadKey: row.telegramUploadKey || null, botControlMessageId: row.telegramBotControlMessageId == null ? null : String(row.telegramBotControlMessageId) }, order: serializeOrder(row) };
}

async function prepareManualReminder({ agencyId, member, orderId, now = new Date(), db = null }) {
  const client = db || require("../prisma"); const row = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  if (normalizeStatus(row.status) !== "PENDING") throw fail("CUSTOM_ORDER_ALREADY_FINALIZED", "Only pending custom orders can be reminded", 409);
  if (row.telegramTaskMessageId == null) throw fail("CUSTOM_ORDER_TELEGRAM_TASK_REQUIRED", "Send the custom task to Telegram before sending a reminder", 409);
  if (!String(row.creator?.telegramContact || "").trim()) throw fail("CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED", "Model has no Telegram contact", 409);
  const accountId = await resolveTelegramAccountId({ agencyId, creator: row.creator, db: client });
  if (!accountId) throw fail("CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED", "Assign a Telegram connection to this model, or keep exactly one Telegram connection in the workspace", 409);
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
  return { ok: true, delivery: { orderId: row.id, creatorId: row.creatorId, accountId, text: reminderText(row, row.creator, workspacePolicy, now), replyToMessageId: row.telegramTaskMessageId == null ? null : String(row.telegramTaskMessageId), transport: String(row.telegramTaskTransport || "USER"), botControlMessageId: row.telegramBotControlMessageId == null ? null : String(row.telegramBotControlMessageId) } };
}

async function recordManualReminder({ agencyId, member, orderId, now = new Date(), db = null }) {
  const client = db || require("../prisma"); const row = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
  const synthetic = { ...row, lastReminderAt: now };
  const next = nextReminderForOrder(synthetic, workspacePolicy, now, { afterAck: true });
  await client.customOrder.update({ where: { id: row.id }, data: { lastReminderAt: now, nextReminderAt: next.at } });
  return { ok: true, nextReminderAt: next.at ? next.at.toISOString() : null };
}


async function recordTelegramInboundReply({ agencyId, member, accountId, deviceId, claimToken, transport = "USER", senderTelegramUserId, messageId, replyToMessageId, sentAt, now = new Date(), db = null }) {
  const client = db || require("../prisma");
  const normalizedAccountId = optionalIdentifier(accountId, "telegramAccountId", 180);
  const senderId = clean(senderTelegramUserId, 32);
  const normalizedTransport = String(transport || "").toUpperCase();
  const inboundId = telegramMessageId(messageId, "telegramMessageId");
  const replyToId = telegramMessageId(replyToMessageId, "replyToMessageId");
  if (!normalizedAccountId || !["USER", "BOT"].includes(normalizedTransport) || !/^\d{1,20}$/.test(senderId) || inboundId == null || replyToId == null) {
    throw fail("CUSTOM_ORDER_TELEGRAM_INBOUND_INVALID", "Telegram inbound reply payload is invalid");
  }
  const { assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
  await assertTelegramRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId, claimToken, now, db: client });
  const scope = await allowedCreatorScope({ agencyId, member, db: client });
  const creator = await client.creatorAccount.findFirst({
    where: {
      agencyId, deletedAt: null, telegramUserId: senderId,
      ...(scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }),
    },
    select: { id: true, telegramAccountId: true, telegramContact: true },
  });
  if (!creator) return { ok: true, matched: false, reason: "CREATOR_NOT_FOUND" };
  const resolvedAccountId = await resolveTelegramAccountId({ agencyId, creator, db: client });
  if (!resolvedAccountId || String(resolvedAccountId) !== normalizedAccountId) return { ok: true, matched: false, reason: "ACCOUNT_MISMATCH" };
  let row = await client.customOrder.findFirst({
    where: { agencyId, creatorId: creator.id, telegramTaskTransport: normalizedTransport, telegramTaskMessageId: replyToId },
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    row = await client.customOrder.findFirst({
      where: { agencyId, creatorId: creator.id, telegramTaskTransport: normalizedTransport, telegramReferenceMessageIds: { has: replyToId } },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }
  if (!row) return { ok: true, matched: false, reason: "CUSTOM_NOT_FOUND" };
  if (row.telegramLastModelMessageId != null && Number(row.telegramLastModelMessageId) === inboundId) {
    return { ok: true, matched: true, deduped: true, order: serializeOrder(row, now) };
  }
  const observedAt = parseIso(sentAt, "telegramLastModelMessageAt") || new Date(now);
  const updated = await client.customOrder.update({
    where: { id: row.id },
    data: { telegramLastModelMessageId: inboundId, telegramLastModelMessageAt: observedAt },
    include: ORDER_INCLUDE,
  });
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_model_reply", targetType: "CustomOrder", targetId: updated.id, metadata: { creatorId: updated.creatorId, telegramMessageId: inboundId, replyToMessageId: replyToId, accountId: normalizedAccountId, transport: normalizedTransport }, db: client });
  return { ok: true, matched: true, deduped: false, order: serializeOrder(updated, now) };
}


function normalizeSubmissionIds(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set(); const result = [];
  for (const item of raw) {
    const id = telegramMessageId(item, "telegramSubmissionMessageId");
    if (id == null || seen.has(id)) continue;
    seen.add(id); result.push(id);
  }
  if (result.length > MAX_SUBMISSION_MESSAGES) throw fail("CUSTOM_ORDER_SUBMISSION_MESSAGES_LIMIT", `Too many Telegram submission messages (max ${MAX_SUBMISSION_MESSAGES})`);
  return result;
}

async function resolveInboundCreator({ agencyId, member, accountId, senderTelegramUserId, db }) {
  const scope = await allowedCreatorScope({ agencyId, member, db });
  const creator = await db.creatorAccount.findFirst({
    where: { agencyId, deletedAt: null, telegramUserId: senderTelegramUserId, ...(scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }) },
    select: { id: true, telegramAccountId: true, telegramContact: true },
  });
  if (!creator) return null;
  const resolvedAccountId = await resolveTelegramAccountId({ agencyId, creator, db });
  return resolvedAccountId && String(resolvedAccountId) === String(accountId) ? creator : null;
}

async function armTelegramCustomUpload({ agencyId, member, accountId, deviceId, claimToken, senderTelegramUserId, uploadKey, controlMessageId = null, now = new Date(), db = null }) {
  const client = db || require("../prisma");
  const normalizedAccountId = optionalIdentifier(accountId, "telegramAccountId", 180);
  const senderId = clean(senderTelegramUserId, 32);
  const key = clean(uploadKey, 64);
  if (!normalizedAccountId || !/^\d{1,20}$/.test(senderId) || !key) throw fail("CUSTOM_ORDER_TELEGRAM_UPLOAD_INVALID", "Telegram upload callback payload is invalid");
  const { assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
  await assertTelegramRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId, claimToken, now, db: client });
  const creator = await resolveInboundCreator({ agencyId, member, accountId: normalizedAccountId, senderTelegramUserId: senderId, db: client });
  if (!creator) return { ok: true, matched: false, reason: "CREATOR_OR_ACCOUNT_MISMATCH" };
  const row = await client.customOrder.findFirst({ where: { agencyId, creatorId: creator.id, telegramUploadKey: key, status: "PENDING", type: "CONTENT" }, include: ORDER_INCLUDE });
  if (!row) return { ok: true, matched: false, reason: "CUSTOM_NOT_FOUND" };
  const controlId = telegramMessageId(controlMessageId, "telegramBotControlMessageId");
  const persist = async (tx) => {
    await tx.customOrder.updateMany({ where: { agencyId, creatorId: creator.id, status: "PENDING", type: "CONTENT", telegramUploadArmedAt: { not: null }, id: { not: row.id } }, data: { telegramUploadArmedAt: null } });
    return tx.customOrder.update({ where: { id: row.id }, data: { telegramUploadArmedAt: now, ...(controlId != null ? { telegramBotControlMessageId: controlId } : {}) }, include: ORDER_INCLUDE });
  };
  const updated = typeof client.$transaction === "function" ? await client.$transaction((tx) => persist(tx)) : await persist(client);
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_upload_armed", targetType: "CustomOrder", targetId: updated.id, metadata: { creatorId: updated.creatorId, accountId: normalizedAccountId }, db: client });
  return { ok: true, matched: true, creatorId: creator.id, uploadKey: updated.telegramUploadKey || key, order: serializeOrder(updated, now), controlMessageId: updated.telegramBotControlMessageId == null ? null : String(updated.telegramBotControlMessageId) };
}

async function recordTelegramCustomSubmission({ agencyId, member, accountId, deviceId, claimToken, senderTelegramUserId, messageIds, sentAt, now = new Date(), db = null }) {
  const client = db || require("../prisma");
  const normalizedAccountId = optionalIdentifier(accountId, "telegramAccountId", 180);
  const senderId = clean(senderTelegramUserId, 32);
  const incomingIds = normalizeSubmissionIds(messageIds);
  if (!normalizedAccountId || !/^\d{1,20}$/.test(senderId) || !incomingIds.length) throw fail("CUSTOM_ORDER_TELEGRAM_SUBMISSION_INVALID", "Telegram submission payload is invalid");
  const { assertTelegramRuntimeLease } = require("./telegram-execution-runtime");
  await assertTelegramRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId, claimToken, now, db: client });
  const creator = await resolveInboundCreator({ agencyId, member, accountId: normalizedAccountId, senderTelegramUserId: senderId, db: client });
  if (!creator) return { ok: true, matched: false, reason: "CREATOR_OR_ACCOUNT_MISMATCH" };
  const row = await client.customOrder.findFirst({ where: { agencyId, creatorId: creator.id, status: "PENDING", type: "CONTENT", telegramUploadArmedAt: { not: null } }, include: ORDER_INCLUDE, orderBy: { telegramUploadArmedAt: "desc" } });
  if (!row) return { ok: true, matched: false, reason: "NO_ARMED_CUSTOM" };
  const merged = normalizeSubmissionIds([...(Array.isArray(row.telegramSubmissionMessageIds) ? row.telegramSubmissionMessageIds : []), ...incomingIds]);
  const observedAt = parseIso(sentAt, "telegramSubmissionReceivedAt") || new Date(now);
  const updated = await client.customOrder.update({ where: { id: row.id }, data: { telegramSubmissionMessageIds: merged, telegramSubmissionReceivedAt: observedAt, telegramUploadArmedAt: null }, include: ORDER_INCLUDE });
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.telegram_submission_received", targetType: "CustomOrder", targetId: updated.id, metadata: { creatorId: updated.creatorId, accountId: normalizedAccountId, addedCount: incomingIds.length, totalCount: merged.length }, db: client });
  return { ok: true, matched: true, creatorId: creator.id, uploadKey: updated.telegramUploadKey || null, order: serializeOrder(updated, now), controlMessageId: updated.telegramBotControlMessageId == null ? null : String(updated.telegramBotControlMessageId), submissionCount: merged.length };
}

async function prepareTelegramStatusNotification({ agencyId, member, orderId, db = null }) {
  const client = db || require("../prisma"); const row = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  if (row.telegramTaskMessageId == null) return { ok: true, delivery: null };
  const accountId = await resolveTelegramAccountId({ agencyId, creator: row.creator, db: client });
  if (!accountId) return { ok: true, delivery: null };
  const status = normalizeStatus(row.status);
  let text = null;
  if (status === "CANCELLED") {
    const label = String(row.scenario || "").trim().replace(/\s+/g, " ").slice(0, 240);
    text = `❌ Кастом отменён${label ? `: «${label}»` : ""}. Выполнять его больше не нужно.${row.cancelReason ? `\nПричина: ${String(row.cancelReason).trim()}` : ""}`;
  }
  return { ok: true, delivery: { orderId: row.id, creatorId: row.creatorId, accountId, status, text, transport: String(row.telegramTaskTransport || "USER"), replyToMessageId: String(row.telegramTaskMessageId), botControlMessageId: row.telegramBotControlMessageId == null ? null : String(row.telegramBotControlMessageId) } };
}

module.exports = {
  CUSTOM_ORDER_STATUSES, CUSTOM_ORDER_TYPES, CUSTOM_ORDER_CONTENT_KINDS, CUSTOM_ORDER_PHYSICAL_STATUSES,
  buildUpdateData, createCustomOrder, listCustomOrders, loadOwnedOrder, mediaIdsArray, mediaIdsString,
  normalizeCreateInput, normalizeStatus, normalizeType, serializeOrder, updateCustomOrder,
  recordTelegramDelivery, prepareTelegramTask, prepareManualReminder, recordManualReminder, recordTelegramInboundReply,
  armTelegramCustomUpload, recordTelegramCustomSubmission, prepareTelegramStatusNotification,
};
