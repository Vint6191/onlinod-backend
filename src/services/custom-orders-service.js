"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const {
  normalizeReminderOverride,
  nextReminderForOrder,
  readWorkspaceReminderPolicy,
} = require("./custom-order-reminders");
const { planTaskIntentForCommittedOrder, planCancellationIntentForCommittedOrder } = require("./telegram-delivery-authority-service");

const CUSTOM_ORDER_STATUSES = Object.freeze(["PENDING", "COMPLETED", "MISSED", "CANCELLED"]);
const CUSTOM_ORDER_TYPES = Object.freeze(["CONTENT", "CALL", "PHYSICAL"]);
const CUSTOM_ORDER_CONTENT_KINDS = Object.freeze(["PHOTO", "VIDEO", "BOTH"]);
const CUSTOM_ORDER_PHYSICAL_STATUSES = Object.freeze(["WAITING", "READY", "SHIPPED", "COMPLETED"]);
const CUSTOM_ORDER_PAYMENT_STATUSES = Object.freeze(["NOT_PAID", "PARTIALLY_PAID", "PAID_IN_FULL"]);
const STATUS_SET = new Set(CUSTOM_ORDER_STATUSES);
const TYPE_SET = new Set(CUSTOM_ORDER_TYPES);
const CONTENT_KIND_SET = new Set(CUSTOM_ORDER_CONTENT_KINDS);
const PHYSICAL_STATUS_SET = new Set(CUSTOM_ORDER_PHYSICAL_STATUSES);
const MAX_SCENARIO = 12_000;
const MAX_NOTE = 4_000;
const MAX_CANCEL_REASON = 1_000;
const MAX_MEDIA_IDS = 200;
const MAX_PRICE_CENTS = 2_147_483_647;
const DUE_SOON_MS = 3 * 60 * 60 * 1000;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clientMutationId(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw fail("CUSTOM_ORDER_CLIENT_MUTATION_ID_REQUIRED", "clientMutationId must be a stable UUID");
  return text;
}
function stableCreateFingerprint(data) {
  const value = {
    creatorId: data.creatorId, dialogId: data.dialogId, scenario: data.scenario, internalNote: data.internalNote, type: data.type, contentKind: data.contentKind,
    dueAt: data.dueAt ? new Date(data.dueAt).toISOString() : null, scheduledAt: data.scheduledAt ? new Date(data.scheduledAt).toISOString() : null, durationMinutes: data.durationMinutes,
    physicalStatus: data.physicalStatus, mediaIds: data.mediaIds, priceCents: data.priceCents, paidAmountCents: data.paidAmountCents, reminderConfig: data.reminderConfig,
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
function normalizePaidAmountCents(input, fallback = 0) {
  if (input?.paidAmountCents !== undefined) {
    const value = Number(input.paidAmountCents);
    if (!Number.isFinite(value) || value < 0) throw fail("CUSTOM_ORDER_PAID_AMOUNT_INVALID", "paidAmountCents must be a non-negative number");
    const cents = Math.round(value);
    if (cents > MAX_PRICE_CENTS) throw fail("CUSTOM_ORDER_PAID_AMOUNT_TOO_LARGE", "paidAmountCents exceeds storage limit");
    return cents;
  }
  if (input?.paidAmount !== undefined) {
    const value = Number(input.paidAmount);
    if (!Number.isFinite(value) || value < 0) throw fail("CUSTOM_ORDER_PAID_AMOUNT_INVALID", "paidAmount must be a non-negative number");
    const cents = Math.round(value * 100);
    if (cents > MAX_PRICE_CENTS) throw fail("CUSTOM_ORDER_PAID_AMOUNT_TOO_LARGE", "paidAmount exceeds storage limit");
    return cents;
  }
  return Math.max(0, Math.round(Number(fallback) || 0));
}
function paymentSnapshot(priceCents, paidAmountCents) {
  const total = Math.max(0, Math.round(Number(priceCents) || 0));
  const paid = Math.max(0, Math.round(Number(paidAmountCents) || 0));
  const remaining = Math.max(total - paid, 0);
  const paymentStatus = paid <= 0 ? "NOT_PAID" : paid < total ? "PARTIALLY_PAID" : "PAID_IN_FULL";
  return {
    paidAmountCents: paid, paidAmount: paid / 100,
    remainingAmountCents: remaining, remainingAmount: remaining / 100, paymentStatus,
  };
}
function callPhaseSnapshot(row, now = new Date()) {
  const scheduledAt = row?.scheduledAt ? new Date(row.scheduledAt) : null;
  if (!scheduledAt || !Number.isFinite(scheduledAt.getTime())) return { callEndAt: null, callPhase: null, callSecondsToStart: null, callSecondsSinceEnd: null };
  const durationMinutes = Math.max(1, Math.min(1440, Math.round(Number(row?.durationMinutes) || 1)));
  const endAt = new Date(scheduledAt.getTime() + durationMinutes * 60_000);
  if (String(row?.status || "PENDING").toUpperCase() !== "PENDING") {
    return { callEndAt: endAt, callPhase: null, callSecondsToStart: null, callSecondsSinceEnd: null };
  }
  const nowMs = now.getTime();
  if (nowMs < scheduledAt.getTime()) return { callEndAt: endAt, callPhase: "UPCOMING", callSecondsToStart: Math.ceil((scheduledAt.getTime() - nowMs) / 1000), callSecondsSinceEnd: null };
  if (nowMs < endAt.getTime()) return { callEndAt: endAt, callPhase: "DUE", callSecondsToStart: 0, callSecondsSinceEnd: null };
  return { callEndAt: endAt, callPhase: "OVERDUE", callSecondsToStart: null, callSecondsSinceEnd: Math.max(0, Math.floor((nowMs - endAt.getTime()) / 1000)) };
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
  const call = type === "CALL" ? callPhaseSnapshot(row, now) : { callEndAt: null, callPhase: null, callSecondsToStart: null, callSecondsSinceEnd: null };
  const contentDueMs = type === "CONTENT" && dueAt && Number.isFinite(dueAt.getTime()) ? dueAt.getTime() - now.getTime() : null;
  const callDueMs = type === "CALL" && scheduledAt && Number.isFinite(scheduledAt.getTime()) ? scheduledAt.getTime() - now.getTime() : null;
  const dueMs = type === "CALL" ? callDueMs : contentDueMs;
  const physicalStatusChangedAt = type === "PHYSICAL" && row.physicalStatusChangedAt ? new Date(row.physicalStatusChangedAt) : null;
  const physicalStatusAgeSeconds = physicalStatusChangedAt && Number.isFinite(physicalStatusChangedAt.getTime())
    ? Math.max(0, Math.floor((now.getTime() - physicalStatusChangedAt.getTime()) / 1000))
    : null;
  const isOverdue = status === "PENDING" && (type === "CONTENT" ? contentDueMs !== null && contentDueMs < 0 : type === "CALL" ? call.callPhase === "OVERDUE" : false);
  const isDueSoon = status === "PENDING" && (type === "CONTENT"
    ? contentDueMs !== null && contentDueMs >= 0 && contentDueMs <= DUE_SOON_MS
    : type === "CALL" ? call.callPhase === "DUE" || (call.callPhase === "UPCOMING" && callDueMs !== null && callDueMs <= DUE_SOON_MS) : false);
  return {
    id: String(row.id), clientMutationId: row.clientMutationId == null ? null : String(row.clientMutationId), dialogId: String(row.dialogId), scenario: String(row.scenario || ""), internalNote: row.internalNote || null,
    type,
    contentKind: type === "CONTENT" ? normalizeContentKind(row.contentKind || "BOTH") : null,
    status,
    dueAt: dueAt ? dueAt.toISOString() : null,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    durationMinutes: row.durationMinutes == null ? null : Number(row.durationMinutes),
    callEndAt: call.callEndAt ? call.callEndAt.toISOString() : null,
    callPhase: call.callPhase,
    callSecondsToStart: call.callSecondsToStart,
    callSecondsSinceEnd: call.callSecondsSinceEnd,
    physicalStatus: type === "PHYSICAL" ? normalizePhysicalStatus(row.physicalStatus || "WAITING") : null,
    physicalStatusChangedAt: physicalStatusChangedAt && Number.isFinite(physicalStatusChangedAt.getTime()) ? physicalStatusChangedAt.toISOString() : null,
    physicalStatusAgeSeconds,
    acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    // deliveredAt is the historical Telegram task-delivery timestamp. Fan delivery
    // is tracked independently so reminders/task delivery cannot suppress READY work.
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    fanDeliveredAt: row.fanDeliveredAt ? new Date(row.fanDeliveredAt).toISOString() : null,
    deliverySentMediaIds: Array.isArray(row.deliverySentMediaIds) ? row.deliverySentMediaIds.map(String) : [],
    deliveryMessageIds: Array.isArray(row.deliveryMessageIds) ? row.deliveryMessageIds.map(String) : [],
    deliveryOfferedCents: Math.max(0, Math.round(Number(row.deliveryOfferedCents) || 0)),
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null,
    cancelReason: row.cancelReason || null,
    mediaIds: mediaIdsArray(row.mediaIds),
    priceCents: Math.max(0, Number(row.priceCents || 0)), price: Math.max(0, Number(row.priceCents || 0)) / 100,
    ...paymentSnapshot(row.priceCents, row.paidAmountCents),
    telegramTaskMessageId: row.telegramTaskMessageId == null ? null : String(row.telegramTaskMessageId),
    telegramReferenceMessageIds: Array.isArray(row.telegramReferenceMessageIds) ? row.telegramReferenceMessageIds.map(String) : [],
    telegramLastModelMessageId: row.telegramLastModelMessageId == null ? null : String(row.telegramLastModelMessageId),
    telegramLastModelMessageAt: row.telegramLastModelMessageAt ? new Date(row.telegramLastModelMessageAt).toISOString() : null,
    reminderConfig: row.reminderConfig && typeof row.reminderConfig === "object" ? row.reminderConfig : null,
    nextReminderAt: row.nextReminderAt ? new Date(row.nextReminderAt).toISOString() : null,
    lastReminderAt: row.lastReminderAt ? new Date(row.lastReminderAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
    isOverdue,
    isDueSoon,
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
  const definitelyOverdueBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [items, count, pendingCount, completedCount, missedCount, cancelledCount, contentOverdueCount, contentDueSoonCount, oldCallOverdueCount, recentStartedCalls, upcomingCallCount] = await Promise.all([
    client.customOrder.findMany({ where, include: ORDER_INCLUDE, orderBy: [{ status: "asc" }, { dueAt: { sort: "asc", nulls: "last" } }, { scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }], take, skip }),
    client.customOrder.count({ where }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING" } }),
    client.customOrder.count({ where: { ...countScope, status: "COMPLETED" } }),
    client.customOrder.count({ where: { ...countScope, status: "MISSED" } }),
    client.customOrder.count({ where: { ...countScope, status: "CANCELLED" } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", type: "CONTENT", dueAt: { lt: now } } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", type: "CONTENT", dueAt: { gte: now, lte: dueSoonCeiling } } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", type: "CALL", scheduledAt: { lte: definitelyOverdueBefore } } }),
    client.customOrder.findMany({ where: { ...countScope, status: "PENDING", type: "CALL", scheduledAt: { gt: definitelyOverdueBefore, lte: now } }, select: { scheduledAt: true, durationMinutes: true, status: true } }),
    client.customOrder.count({ where: { ...countScope, status: "PENDING", type: "CALL", scheduledAt: { gt: now, lte: dueSoonCeiling } } }),
  ]);
  let recentCallOverdueCount = 0; let callDueNowCount = 0;
  for (const row of recentStartedCalls || []) {
    const phase = callPhaseSnapshot(row, now).callPhase;
    if (phase === "OVERDUE") recentCallOverdueCount += 1;
    else if (phase === "DUE") callDueNowCount += 1;
  }
  const overdueCount = Number(contentOverdueCount || 0) + Number(oldCallOverdueCount || 0) + recentCallOverdueCount;
  const dueSoonCount = Number(contentDueSoonCount || 0) + Number(upcomingCallCount || 0) + callDueNowCount;
  return { ok: true, items: items.map((row) => serializeOrder(row, now)), count, nextOffset: skip + items.length, hasMore: skip + items.length < count, counts: { pending: pendingCount, completed: completedCount, missed: missedCount, cancelled: cancelledCount, overdue: overdueCount, dueSoon: dueSoonCount }, serverNow: now.toISOString() };
}

function normalizeCreateInput(input = {}) {
  const type = normalizeType(input.type || "CONTENT");
  const requestedMediaIds = mediaIdsString(input.mediaIds);
  if (type === "CONTENT" && requestedMediaIds) throw fail("CUSTOM_ORDER_CONTENT_MEDIA_IDS_RETIRED", "CONTENT media IDs are projected only from proven Custom submissions and cannot be entered manually", 409);
  const data = {
    clientMutationId: clientMutationId(input.clientMutationId),
    creatorId: required(input.creatorId, "creatorId", 100), dialogId: required(input.dialogId, "dialogId", 100), scenario: required(input.scenario, "scenario", MAX_SCENARIO),
    internalNote: optional(input.internalNote, MAX_NOTE, "internalNote"), type,
    contentKind: type === "CONTENT" ? normalizeContentKind(input.contentKind || "BOTH") : null,
    dueAt: type === "CONTENT" ? parseIso(input.dueAt, "dueAt") : null,
    scheduledAt: type === "CALL" ? parseIso(input.scheduledAt, "scheduledAt", { allowNull: false }) : null,
    durationMinutes: type === "CALL" ? normalizeDuration(input.durationMinutes) : null,
    physicalStatus: type === "PHYSICAL" ? normalizePhysicalStatus(input.physicalStatus || "WAITING") : null,
    mediaIds: type === "CONTENT" ? "" : requestedMediaIds, priceCents: normalizePriceCents(input, 0), paidAmountCents: normalizePaidAmountCents(input, 0),
    reminderConfig: input.reminderConfig === undefined ? null : normalizeReminderOverride(type, input.reminderConfig),
  };
  return data;
}

async function createCustomOrder({ agencyId, member, input, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma"); const data = normalizeCreateInput(input || {});
  await requireCreatorAccess({ agencyId, member, creatorId: data.creatorId, db: client });
  const fingerprint = stableCreateFingerprint(data);
  const existing = await client.customOrder.findFirst({ where: { agencyId, clientMutationId: data.clientMutationId }, include: ORDER_INCLUDE });
  if (existing) {
    if (String(existing.clientMutationFingerprint || "") !== fingerprint) throw fail("CUSTOM_ORDER_CLIENT_MUTATION_CONFLICT", "clientMutationId is already bound to a different CustomOrder payload", 409);
    if (String(existing.creatorId) !== String(data.creatorId)) throw fail("CUSTOM_ORDER_CLIENT_MUTATION_CONFLICT", "clientMutationId belongs to another creator", 409);
    return { ok: true, idempotent: true, order: serializeOrder(existing, now) };
  }
  const workspacePolicy = await readWorkspaceReminderPolicy({ agencyId, db: client });
  const seed = { ...data, status: "PENDING", createdAt: now, lastReminderAt: null, lastReminderKey: null };
  const nextReminderAt = nextReminderForOrder(seed, workspacePolicy, now).at;
  const execute = async (tx) => {
    let row;
    try {
      row = await tx.customOrder.create({ data: { agencyId, creatorId: data.creatorId, dialogId: data.dialogId, createdByMemberId: member.id, clientMutationId: data.clientMutationId, clientMutationFingerprint: fingerprint, scenario: data.scenario, internalNote: data.internalNote, type: data.type, contentKind: data.contentKind, status: "PENDING", dueAt: data.dueAt, scheduledAt: data.scheduledAt, durationMinutes: data.durationMinutes, physicalStatus: data.physicalStatus, physicalStatusChangedAt: data.type === "PHYSICAL" ? now : null, mediaIds: data.mediaIds, priceCents: data.priceCents, paidAmountCents: data.paidAmountCents, reminderConfig: data.reminderConfig, nextReminderAt }, include: ORDER_INCLUDE });
    } catch (error) {
      if (String(error?.code || "") !== "P2002") throw error;
      const raced = await tx.customOrder.findFirst({ where: { agencyId, clientMutationId: data.clientMutationId }, include: ORDER_INCLUDE });
      if (!raced || String(raced.clientMutationFingerprint || "") !== fingerprint) throw fail("CUSTOM_ORDER_CLIENT_MUTATION_CONFLICT", "clientMutationId conflicted with a different CustomOrder payload", 409);
      return { row: raced, idempotent: true };
    }
    await planTaskIntentForCommittedOrder({ agencyId, member, order: row, now, db: tx });
    return { row, idempotent: false };
  };
  const outcome = typeof client.$transaction === "function" ? await client.$transaction(execute) : await execute(client);
  const row = outcome.row;
  if (!outcome.idempotent) {
    const payment = paymentSnapshot(row.priceCents, row.paidAmountCents);
    await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.create", targetType: "CustomOrder", targetId: row.id, metadata: { creatorId: row.creatorId, dialogId: row.dialogId, type: row.type, status: row.status, dueAt: row.dueAt, scheduledAt: row.scheduledAt, priceCents: row.priceCents, paidAmountCents: payment.paidAmountCents, remainingAmountCents: payment.remainingAmountCents, paymentStatus: payment.paymentStatus, clientMutationId: data.clientMutationId }, db: client });
  }
  return { ok: true, idempotent: outcome.idempotent, order: serializeOrder(row, now) };
}

async function getCustomOrderByClientMutationId({ agencyId, member, clientMutationId: mutationId, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const normalized = clientMutationId(mutationId);
  const row = await client.customOrder.findFirst({ where: { agencyId, clientMutationId: normalized }, include: ORDER_INCLUDE });
  if (!row) throw fail("CUSTOM_ORDER_CLIENT_MUTATION_NOT_FOUND", "Custom order create intent not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client });
  return { ok: true, order: serializeOrder(row, now) };
}

async function loadOwnedOrder({ agencyId, member, orderId, db = null }) {
  const client = db || require("../prisma"); const id = required(orderId, "id", 180);
  const row = await client.customOrder.findFirst({ where: { id, agencyId }, include: ORDER_INCLUDE });
  if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found", 404);
  await requireCreatorAccess({ agencyId, member, creatorId: row.creatorId, db: client }); return row;
}

async function getCustomOrder({ agencyId, member, orderId, now = new Date(), db = null } = {}) {
  const row = await loadOwnedOrder({ agencyId, member, orderId, db });
  return { ok: true, order: serializeOrder(row, now) };
}

function buildUpdateData(current, input = {}, now = new Date()) {
  const patch = {}; const nextType = input.type === undefined ? normalizeType(current.type || "CONTENT") : normalizeType(input.type);
  if (input.scenario !== undefined) patch.scenario = required(input.scenario, "scenario", MAX_SCENARIO);
  if (input.internalNote !== undefined) patch.internalNote = optional(input.internalNote, MAX_NOTE, "internalNote");
  if (input.type !== undefined) patch.type = nextType;
  if (nextType === "CONTENT") {
    if (input.contentKind !== undefined || input.type !== undefined) patch.contentKind = normalizeContentKind(input.contentKind ?? current.contentKind ?? "BOTH");
    if (input.dueAt !== undefined || input.type !== undefined) patch.dueAt = parseIso(input.dueAt ?? (input.type === undefined ? current.dueAt : null), "dueAt");
    if (input.type !== undefined) { patch.scheduledAt = null; patch.durationMinutes = null; patch.physicalStatus = null; patch.physicalStatusChangedAt = null; }
  } else if (nextType === "CALL") {
    if (input.scheduledAt !== undefined || input.type !== undefined) patch.scheduledAt = parseIso(input.scheduledAt ?? current.scheduledAt, "scheduledAt", { allowNull: false });
    if (input.durationMinutes !== undefined || input.type !== undefined) patch.durationMinutes = normalizeDuration(input.durationMinutes ?? current.durationMinutes);
    if (input.type !== undefined) { patch.contentKind = null; patch.dueAt = null; patch.physicalStatus = null; patch.physicalStatusChangedAt = null; }
  } else {
    if (input.physicalStatus !== undefined || input.type !== undefined) {
      const nextPhysicalStatus = normalizePhysicalStatus(input.physicalStatus ?? current.physicalStatus ?? "WAITING");
      patch.physicalStatus = nextPhysicalStatus;
      if (input.type !== undefined || nextPhysicalStatus !== normalizePhysicalStatus(current.physicalStatus || "WAITING")) patch.physicalStatusChangedAt = new Date(now);
    }
    if (input.type !== undefined) { patch.contentKind = null; patch.dueAt = null; patch.scheduledAt = null; patch.durationMinutes = null; }
  }
  if (input.mediaIds !== undefined) patch.mediaIds = mediaIdsString(input.mediaIds);
  if (input.price !== undefined || input.priceCents !== undefined) patch.priceCents = normalizePriceCents(input, current.priceCents || 0);
  if (input.paidAmount !== undefined || input.paidAmountCents !== undefined) patch.paidAmountCents = normalizePaidAmountCents(input, current.paidAmountCents || 0);
  if (input.acceptedAt !== undefined) patch.acceptedAt = parseIso(input.acceptedAt, "acceptedAt");
  if (input.reminderConfig !== undefined) patch.reminderConfig = input.reminderConfig === null ? null : normalizeReminderOverride(nextType, input.reminderConfig);

  let nextStatus = input.status === undefined ? normalizeStatus(current.status) : normalizeStatus(input.status);
  const nextPhysical = patch.physicalStatus ?? current.physicalStatus;
  if (nextType === "PHYSICAL" && nextPhysical === "COMPLETED") nextStatus = "COMPLETED";
  if (input.status !== undefined || nextStatus !== normalizeStatus(current.status)) patch.status = nextStatus;
  if (nextStatus === "COMPLETED") {
    if (normalizeStatus(current.status) !== "COMPLETED" || !current.completedAt) patch.completedAt = new Date(now);
    if (nextType === "PHYSICAL") { if (String(current.physicalStatus || "WAITING") !== "COMPLETED") patch.physicalStatusChangedAt = new Date(now); patch.physicalStatus = "COMPLETED"; }
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

function sameInstant(left, right) {
  const a = left == null || left === "" ? null : new Date(left);
  const b = right == null || right === "" ? null : new Date(right);
  const ams = a && Number.isFinite(a.getTime()) ? a.getTime() : null;
  const bms = b && Number.isFinite(b.getTime()) ? b.getTime() : null;
  return ams === bms;
}

function telegramTaskVisibleEditRequested(current, input = {}) {
  const currentType = normalizeType(current?.type || "CONTENT");
  if (input.type !== undefined || input.scenario !== undefined) return true;
  if (currentType === "CONTENT") return input.contentKind !== undefined || input.dueAt !== undefined;
  if (currentType === "CALL") return input.scheduledAt !== undefined || input.durationMinutes !== undefined;
  return false;
}

async function assertContentTypeMutationCompatibility({ agencyId, current, requestedType, db }) {
  const currentType = normalizeType(current?.type || "CONTENT");
  if (currentType !== "CONTENT" || requestedType === "CONTENT") return;
  if (current?.contentBoundAt) {
    throw fail("CUSTOM_ORDER_CONTENT_TYPE_BOUND", "A CONTENT custom with submission history cannot change type", 409);
  }
  // Migration backfill makes contentBoundAt authoritative for normal current rows, but the
  // historical relation check keeps rolling-deploy / partially-migrated data fail-closed.
  if (db?.customContentSubmission?.findFirst) {
    const existing = await db.customContentSubmission.findFirst({
      where: { agencyId, customOrderId: current.id },
      select: { id: true },
    });
    if (existing) throw fail("CUSTOM_ORDER_CONTENT_TYPE_BOUND", "A CONTENT custom with submission history cannot change type", 409);
  }
}

function assertTelegramTaskEditCompatibility(current, input = {}, { externalCommitFence = false } = {}) {
  if (!externalCommitFence) return;
  const currentType = normalizeType(current.type || "CONTENT");
  if (input.type !== undefined && normalizeType(input.type) !== currentType) {
    throw fail("CUSTOM_ORDER_TELEGRAM_TASK_TYPE_IMMUTABLE", "Custom type cannot change after the Telegram task external commit has started", 409);
  }
  const changed = [];
  if (input.scenario !== undefined && required(input.scenario, "scenario", MAX_SCENARIO) !== String(current.scenario || "")) changed.push("scenario");
  if (currentType === "CONTENT") {
    if (input.contentKind !== undefined && normalizeContentKind(input.contentKind) !== normalizeContentKind(current.contentKind || "BOTH")) changed.push("contentKind");
    if (input.dueAt !== undefined) {
      const next = parseIso(input.dueAt, "dueAt");
      if (!sameInstant(next, current.dueAt)) changed.push("dueAt");
    }
  } else if (currentType === "CALL") {
    if (input.scheduledAt !== undefined) {
      const next = parseIso(input.scheduledAt, "scheduledAt", { allowNull: false });
      if (!sameInstant(next, current.scheduledAt)) changed.push("scheduledAt");
    }
    if (input.durationMinutes !== undefined && normalizeDuration(input.durationMinutes) !== Number(current.durationMinutes)) changed.push("durationMinutes");
  }
  if (changed.length) {
    throw fail("CUSTOM_ORDER_TELEGRAM_TASK_FIELDS_IMMUTABLE", `Model-visible Telegram task fields cannot change after the Telegram external commit has started: ${changed.join(", ")}`, 409);
  }
}

async function updateCustomOrder({ agencyId, member, orderId, input, now = new Date(), db = null } = {}) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_ORDER_ACTOR_REQUIRED", "Agency membership is required", 403);
  const client = db || require("../prisma"); const current = await loadOwnedOrder({ agencyId, member, orderId, db: client });
  const expectedCreatorId = optionalIdentifier(input?.creatorId, "creatorId", 100); if (expectedCreatorId && expectedCreatorId !== String(current.creatorId)) throw fail("CUSTOM_ORDER_CREATOR_MISMATCH", "Custom order does not belong to the requested creator", 404);
  const currentStatus = normalizeStatus(current.status); const requestedStatus = input?.status === undefined ? null : normalizeStatus(input.status);
  const paymentMutation = input?.paidAmount !== undefined || input?.paidAmountCents !== undefined;
  const currentType = normalizeType(current.type || "CONTENT");
  const requestedType = input?.type === undefined ? currentType : normalizeType(input.type);
  if ((currentType === "CONTENT" || requestedType === "CONTENT") && input?.mediaIds !== undefined) {
    throw fail("CUSTOM_ORDER_CONTENT_MEDIA_IDS_RETIRED", "CONTENT media IDs are projected only from proven Custom submissions and cannot be mutated manually", 409);
  }
  if (requestedType === "CONTENT" && requestedStatus === "COMPLETED") {
    throw fail("CUSTOM_ORDER_CONTENT_COMPLETION_AUTHORITY", "CONTENT completion is projected only from confirmed fan delivery", 409);
  }
  await assertContentTypeMutationCompatibility({ agencyId, current, requestedType, db: client });
  let externalTaskCommitFence = current.telegramTaskMessageId != null;
  if (!externalTaskCommitFence && telegramTaskVisibleEditRequested(current, input || {}) && client.telegramDeliveryIntent?.findFirst) {
    const committedTask = await client.telegramDeliveryIntent.findFirst({
      where: { agencyId, customOrderId: current.id, kind: "TASK", state: { in: ["COMMITTING", "RECONCILE_REQUIRED", "CONFIRMED"] } },
      select: { id: true },
      orderBy: [{ commitStartedAt: "desc" }, { createdAt: "desc" }],
    });
    externalTaskCommitFence = Boolean(committedTask);
  }
  assertTelegramTaskEditCompatibility(current, input || {}, { externalCommitFence: externalTaskCommitFence });

  if (currentStatus !== "PENDING") {
    const nonFinancialFields = ["scenario", "internalNote", "type", "contentKind", "dueAt", "scheduledAt", "durationMinutes", "physicalStatus", "acceptedAt", "cancelReason", "mediaIds", "price", "priceCents", "reminderConfig"]
      .filter((key) => input?.[key] !== undefined);
    if (requestedStatus && requestedStatus !== currentStatus) throw fail("CUSTOM_ORDER_ALREADY_FINALIZED", "Completed, missed or cancelled custom orders cannot change production status", 409);
    // Preserve the old idempotent finalization contract: retrying the same terminal
    // status is a no-op even if the stale client repeats its final payload.
    if (requestedStatus === currentStatus && !paymentMutation) return { ok: true, order: serializeOrder(current, now) };
    if (nonFinancialFields.length) throw fail("CUSTOM_ORDER_ALREADY_FINALIZED", "Completed, missed or cancelled custom orders cannot change production details", 409);
    if (!paymentMutation) return { ok: true, order: serializeOrder(current, now) };

    const paidAmountCents = normalizePaidAmountCents(input, current.paidAmountCents || 0);
    const changed = await client.customOrder.updateMany({ where: { id: current.id, agencyId, status: currentStatus, updatedAt: current.updatedAt }, data: { paidAmountCents } });
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_ORDER_CONFLICT", "Custom order changed while this payment update was being applied; refresh and try again", 409);
    const row = await client.customOrder.findFirst({ where: { id: current.id, agencyId }, include: ORDER_INCLUDE }); if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found after payment update", 404);
    const payment = paymentSnapshot(row.priceCents, row.paidAmountCents);
    await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.payment_update", targetType: "CustomOrder", targetId: row.id, metadata: { creatorId: row.creatorId, dialogId: row.dialogId, status: row.status, priceCents: row.priceCents, previousPaidAmountCents: Math.max(0, Number(current.paidAmountCents || 0)), paidAmountCents: payment.paidAmountCents, remainingAmountCents: payment.remainingAmountCents, paymentStatus: payment.paymentStatus }, db: client });
    return { ok: true, order: serializeOrder(row, now) };
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
    }
  } else { patch.nextReminderAt = null; }
  const applyPendingUpdate = async (tx) => {
    const changed = await tx.customOrder.updateMany({ where: { id: current.id, agencyId, status: "PENDING", updatedAt: current.updatedAt }, data: patch });
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_ORDER_CONFLICT", "Custom order changed while this update was being applied; refresh and try again", 409);
    const row = await tx.customOrder.findFirst({ where: { id: current.id, agencyId }, include: ORDER_INCLUDE });
    if (!row) throw fail("CUSTOM_ORDER_NOT_FOUND", "Custom order not found after update", 404);
    if (String(row.status) === "CANCELLED" && String(current.status) !== "CANCELLED") await planCancellationIntentForCommittedOrder({ agencyId, member, order: row, now, db: tx });
    return row;
  };
  const row = typeof client.$transaction === "function" ? await client.$transaction(applyPendingUpdate) : await applyPendingUpdate(client);
  const payment = paymentSnapshot(row.priceCents, row.paidAmountCents);
  await audit({ agencyId, actorUserId: member.userId || null, action: "custom_order.update", targetType: "CustomOrder", targetId: row.id, metadata: { creatorId: row.creatorId, dialogId: row.dialogId, type: row.type, previousStatus: current.status, status: row.status, dueAt: row.dueAt, scheduledAt: row.scheduledAt, physicalStatus: row.physicalStatus, priceCents: row.priceCents, previousPaidAmountCents: Math.max(0, Number(current.paidAmountCents || 0)), paidAmountCents: payment.paidAmountCents, remainingAmountCents: payment.remainingAmountCents, paymentStatus: payment.paymentStatus }, db: client });
  return { ok: true, order: serializeOrder(row, now) };
}

module.exports = {
  CUSTOM_ORDER_STATUSES, CUSTOM_ORDER_TYPES, CUSTOM_ORDER_CONTENT_KINDS, CUSTOM_ORDER_PHYSICAL_STATUSES, CUSTOM_ORDER_PAYMENT_STATUSES,
  buildUpdateData, callPhaseSnapshot, createCustomOrder, getCustomOrder, getCustomOrderByClientMutationId, listCustomOrders, loadOwnedOrder, mediaIdsArray, mediaIdsString, paymentSnapshot,
  normalizeCreateInput, normalizePaidAmountCents, normalizeStatus, normalizeType, serializeOrder, updateCustomOrder,
};
