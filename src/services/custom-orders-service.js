"use strict";

const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");

const CUSTOM_ORDER_STATUSES = Object.freeze(["PENDING", "COMPLETED", "CANCELLED"]);
const STATUS_SET = new Set(CUSTOM_ORDER_STATUSES);
const MAX_SCENARIO = 12_000;
const MAX_NOTE = 4_000;
const MAX_CANCEL_REASON = 1_000;
const MAX_MEDIA_IDS = 200;
const MAX_PRICE_CENTS = 2_147_483_647; // PostgreSQL/Prisma Int storage limit; not a business rule.

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function clean(value, max = 500) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

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

function normalizeStatus(value, fallback = "PENDING") {
  const status = String(value || fallback).trim().toUpperCase();
  if (!STATUS_SET.has(status)) throw fail("CUSTOM_ORDER_STATUS_INVALID", `Unsupported custom order status: ${status}`);
  return status;
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
  const raw = Array.isArray(value)
    ? value
    : String(value == null ? "" : value).split(/[\s,;]+/g);
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item == null ? "" : item).trim();
    if (!id || seen.has(id)) continue;
    if (strict && id.length > 100) throw fail("CUSTOM_ORDER_MEDIA_ID_TOO_LONG", "mediaId is too long (max 100 characters)");
    seen.add(id);
    ids.push(strict ? id : id.slice(0, 100));
  }
  if (strict && ids.length > MAX_MEDIA_IDS) throw fail("CUSTOM_ORDER_MEDIA_IDS_LIMIT", `Too many media IDs (max ${MAX_MEDIA_IDS})`);
  return ids.slice(0, MAX_MEDIA_IDS);
}

function mediaIdsArray(value) {
  return normalizeMediaIds(value);
}

function mediaIdsString(value) {
  return normalizeMediaIds(value, { strict: true }).join(" ");
}

function memberLabel(member) {
  return member?.displayName || member?.user?.name || member?.user?.email || null;
}

function creatorLabel(creator) {
  return creator?.displayName || creator?.username || creator?.id || null;
}

const ORDER_INCLUDE = Object.freeze({
  creator: { select: { id: true, displayName: true, username: true, avatarUrl: true } },
  createdByMember: { select: { id: true, displayName: true, roleKey: true, user: { select: { name: true, email: true } } } },
});

function serializeOrder(row, now = new Date()) {
  if (!row) return null;
  const dueAt = row.dueAt ? new Date(row.dueAt) : null;
  const dueMs = dueAt && Number.isFinite(dueAt.getTime()) ? dueAt.getTime() - now.getTime() : null;
  const status = normalizeStatus(row.status);
  return {
    id: String(row.id),
    dialogId: String(row.dialogId),
    scenario: String(row.scenario || ""),
    internalNote: row.internalNote || null,
    status,
    dueAt: dueAt ? dueAt.toISOString() : null,
    acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
    cancelReason: row.cancelReason || null,
    mediaIds: mediaIdsArray(row.mediaIds),
    priceCents: Math.max(0, Number(row.priceCents || 0)),
    price: Math.max(0, Number(row.priceCents || 0)) / 100,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    isOverdue: status === "PENDING" && dueMs !== null && dueMs < 0,
    dueInMs: status === "PENDING" ? dueMs : null,
    creator: row.creator ? {
      name: creatorLabel(row.creator),
      displayName: row.creator.displayName || null,
      username: row.creator.username || null,
      avatarUrl: row.creator.avatarUrl || null,
    } : null,
    createdBy: row.createdByMember ? {
      name: memberLabel(row.createdByMember),
      displayName: row.createdByMember.displayName || null,
      roleKey: row.createdByMember.roleKey || null,
    } : null,
  };
}

function scopeWhere(scope) {
  if (scope?.broad) return {};
  const ids = Array.isArray(scope?.creatorIds) ? scope.creatorIds.map(String).filter(Boolean) : [];
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

async function actorScope({ agencyId, member, creatorId = null, db = null }) {
  const client = db || require("../prisma");
  return allowedCreatorScope({ agencyId, member, requestedCreatorId: creatorId || null, db: client });
}

function normalizeListStatus(value, pendingOnly) {
  if (pendingOnly === true) return "PENDING";
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || raw === "ALL") return null;
  return normalizeStatus(raw);
}

async function listCustomOrders({
  agencyId,
  member,
  creatorId = null,
  dialogId = null,
  status = null,
  pendingOnly = false,
  limit = 100,
  offset = 0,
  now = new Date(),
  db = null,
} = {}) {
  if (!agencyId || !member) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const requestedCreatorId = optionalIdentifier(creatorId, "creatorId", 100);
  const scope = await actorScope({ agencyId, member, creatorId: requestedCreatorId, db: client });
  const requestedDialogId = optionalIdentifier(dialogId, "dialogId", 100);
  const normalizedStatus = normalizeListStatus(status, pendingOnly);
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const where = {
    agencyId,
    ...scopeWhere(scope),
    ...(requestedCreatorId ? { creatorId: requestedCreatorId } : {}),
    ...(requestedDialogId ? { dialogId: requestedDialogId } : {}),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
  };

  const countScope = {
    agencyId,
    ...scopeWhere(scope),
    ...(requestedCreatorId ? { creatorId: requestedCreatorId } : {}),
    ...(requestedDialogId ? { dialogId: requestedDialogId } : {}),
  };

  // Counts intentionally use indexed COUNT queries instead of materialising a
  // capped list of status rows. The queue can grow for years without making
  // every 30-second desktop refresh pull thousands of historical records.
  const [items, count, pendingCount, completedCount, cancelledCount, overdueCount] = await Promise.all([
    client.customOrder.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: [
        { status: "asc" },
        { dueAt: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "asc" },
      ],
      take,
      skip,
    }),
    client.customOrder.count({ where }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING" } }),
    client.customOrder.count({ where: { ...countScope, status: "COMPLETED" } }),
    client.customOrder.count({ where: { ...countScope, status: "CANCELLED" } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", dueAt: { lt: now } } }),
  ]);

  const counts = {
    pending: pendingCount,
    completed: completedCount,
    cancelled: cancelledCount,
    overdue: overdueCount,
  };

  return {
    ok: true,
    items: items.map((row) => serializeOrder(row, now)),
    count,
    nextOffset: skip + items.length,
    hasMore: skip + items.length < count,
    counts,
    serverNow: now.toISOString(),
  };
}

function normalizeCreateInput(input = {}) {
  return {
    creatorId: required(input.creatorId, "creatorId", 100),
    dialogId: required(input.dialogId, "dialogId", 100),
    scenario: required(input.scenario, "scenario", MAX_SCENARIO),
    internalNote: optional(input.internalNote, MAX_NOTE, "internalNote"),
    dueAt: parseIso(input.dueAt, "dueAt"),
    mediaIds: mediaIdsString(input.mediaIds),
    priceCents: normalizePriceCents(input, 0),
  };
}

async function createCustomOrder({ agencyId, member, input, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const data = normalizeCreateInput(input || {});
  await requireCreatorAccess({ agencyId, member, creatorId: data.creatorId, db: client });

  const row = await client.customOrder.create({
    data: {
      agencyId,
      creatorId: data.creatorId,
      dialogId: data.dialogId,
      createdByMemberId: member.id,
      scenario: data.scenario,
      internalNote: data.internalNote,
      status: "PENDING",
      dueAt: data.dueAt,
      mediaIds: data.mediaIds,
      priceCents: data.priceCents,
    },
    include: ORDER_INCLUDE,
  });

  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: "custom_order.create",
    targetType: "CustomOrder",
    targetId: row.id,
    metadata: { creatorId: row.creatorId, dialogId: row.dialogId, status: row.status, dueAt: row.dueAt, priceCents: row.priceCents },
    db: client,
  });

  return { ok: true, order: serializeOrder(row, now) };
}

async function loadOwnedOrder({ agencyId, member, orderId, db = null }) {
  const client = db || require("../prisma");
  const id = required(orderId, "id", 180);
  const row = await client.customOrder.findFirst({ where: { id, agencyId }, include: ORDER_INCLUDE });
  if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  return row;
}

function buildUpdateData(current, input = {}, now = new Date()) {
  const patch = {};
  if (input.scenario !== undefined) patch.scenario = required(input.scenario, "scenario", MAX_SCENARIO);
  if (input.internalNote !== undefined) patch.internalNote = optional(input.internalNote, MAX_NOTE, "internalNote");
  if (input.dueAt !== undefined) patch.dueAt = parseIso(input.dueAt, "dueAt");
  if (input.mediaIds !== undefined) patch.mediaIds = mediaIdsString(input.mediaIds);
  if (input.price !== undefined || input.priceCents !== undefined) patch.priceCents = normalizePriceCents(input, current.priceCents || 0);
  // acceptedAt is intentionally allowed as a future-compatible journal mark while
  // the order remains PENDING. Terminal timestamps are server-owned below.
  if (input.acceptedAt !== undefined) patch.acceptedAt = parseIso(input.acceptedAt, "acceptedAt");

  const nextStatus = input.status === undefined ? normalizeStatus(current.status) : normalizeStatus(input.status);
  if (input.status !== undefined) patch.status = nextStatus;

  if (nextStatus === "COMPLETED") {
    if (normalizeStatus(current.status) !== "COMPLETED" || !current.completedAt) patch.completedAt = new Date(now);
    patch.cancelledAt = null;
    patch.cancelReason = null;
  } else if (nextStatus === "CANCELLED") {
    const reason = input.cancelReason !== undefined ? optional(input.cancelReason, MAX_CANCEL_REASON, "cancelReason") : optional(current.cancelReason, MAX_CANCEL_REASON, "cancelReason");
    if (!reason) throw fail("CUSTOM_ORDER_CANCEL_REASON_REQUIRED", "cancelReason is required when cancelling a custom order");
    patch.cancelReason = reason;
    if (normalizeStatus(current.status) !== "CANCELLED" || !current.cancelledAt) patch.cancelledAt = new Date(now);
    patch.completedAt = null;
  } else if (nextStatus === "PENDING") {
    patch.completedAt = null;
    patch.cancelledAt = null;
    patch.cancelReason = null;
  }

  return patch;
}

async function updateCustomOrder({ agencyId, member, orderId, input, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma");
  const current = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  const expectedCreatorId = optionalIdentifier(input?.creatorId, "creatorId", 100);
  if (expectedCreatorId && expectedCreatorId !== String(current.creatorId)) {
    throw fail("CUSTOM_ORDER_CREATOR_MISMATCH", "Custom order does not belong to the requested creator", 404);
  }

  const currentStatus = normalizeStatus(current.status);
  const requestedStatus = input?.status === undefined ? null : normalizeStatus(input.status);
  if (currentStatus !== "PENDING") {
    // V1 terminal journal rows are immutable. A repeated terminal request is
    // treated as an idempotent retry, while reopening or rewriting history is
    // rejected. Future production/delivery states can extend this transition
    // policy without changing the stored order identity.
    if (requestedStatus === currentStatus) return { ok: true, order: serializeOrder(current, now) };
    throw fail("CUSTOM_ORDER_ALREADY_FINALIZED", "Completed or cancelled custom orders cannot be changed", 409);
  }

  const patch = buildUpdateData(current, input || {}, now);
  const changed = await client.customOrder.updateMany({
    where: { id: current.id, agencyId, status: "PENDING", updatedAt: current.updatedAt },
    data: patch,
  });
  if (Number(changed?.count || 0) !== 1) {
    throw fail("CUSTOM_ORDER_CONFLICT", "Custom order changed while this update was being applied; refresh and try again", 409);
  }
  const row = await client.customOrder.findFirst({ where: { id: current.id, agencyId }, include: ORDER_INCLUDE });
  if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found after update", 404);

  await audit({
    agencyId,
    actorUserId: member.userId || null,
    action: "custom_order.update",
    targetType: "CustomOrder",
    targetId: row.id,
    metadata: {
      creatorId: row.creatorId,
      dialogId: row.dialogId,
      previousStatus: current.status,
      status: row.status,
      dueAt: row.dueAt,
      priceCents: row.priceCents,
    },
    db: client,
  });

  return { ok: true, order: serializeOrder(row, now) };
}

module.exports = {
  CUSTOM_ORDER_STATUSES,
  buildUpdateData,
  createCustomOrder,
  listCustomOrders,
  mediaIdsArray,
  mediaIdsString,
  normalizeCreateInput,
  normalizeStatus,
  serializeOrder,
  updateCustomOrder,
};
