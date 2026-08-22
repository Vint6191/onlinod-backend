"use strict";

const { audit } = require("./audit-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { paymentSnapshot } = require("./custom-orders-service");

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 220) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function uniqueIds(values, max = 200) {
  const source = Array.isArray(values) ? values : [];
  const out = []; const seen = new Set();
  for (const value of source) {
    const id = clean(value, 100);
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(id);
    if (out.length >= max) break;
  }
  return out;
}
function nonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(2_147_483_647, Math.round(numeric));
}
function dateValue(value, fallback = new Date()) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value || ""));
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(fallback);
}
function arraysEqualAsSet(a, b) {
  const left = uniqueIds(a); const right = uniqueIds(b);
  return left.length === right.length && left.every((id) => right.includes(id));
}
function intersection(a, b) { const set = new Set(uniqueIds(b)); return uniqueIds(a).filter((id) => set.has(id)); }
function allDelivered(approved, delivered) { const set = new Set(uniqueIds(delivered)); const ids = uniqueIds(approved); return ids.length > 0 && ids.every((id) => set.has(id)); }

async function requireDirectAccess({ agencyId, member, creatorId, db }) {
  if (!agencyId || !member?.id) throw fail("CUSTOM_DELIVERY_ACTOR_REQUIRED", "Agency membership is required", 403);
  if (!await canUsePermission({ member, key: "chats.reply", db })) {
    throw fail("CUSTOM_DELIVERY_FORBIDDEN", "chats.reply permission is required", 403);
  }
  await requireCreatorAccess({ agencyId, member, creatorId, db });
}

const TRACK_INCLUDE = {
  customOrder: {
    select: {
      id: true, agencyId: true, creatorId: true, dialogId: true, type: true, status: true,
      priceCents: true, paidAmountCents: true, fanDeliveredAt: true,
      deliverySentMediaIds: true, deliveryMessageIds: true, deliveryOfferedCents: true,
      completedAt: true, updatedAt: true,
    },
  },
};

function eligibleSubmission(row, creatorId, dialogId) {
  const order = row?.customOrder;
  return Boolean(order
    && String(row.reviewStatus || "") === "APPROVED"
    && row.reviewedAt
    && String(order.type || "") === "CONTENT"
    && String(order.creatorId || "") === creatorId
    && String(order.dialogId || "") === dialogId);
}

async function findExplicitSubmission(client, agencyId, customOrderId) {
  return client.customContentSubmission.findFirst({
    where: { agencyId, customOrderId, reviewStatus: "APPROVED", reviewedAt: { not: null } },
    include: TRACK_INCLUDE,
  });
}

async function discoverSubmission(client, { agencyId, creatorId, dialogId, sentMediaIds }) {
  // Fast path for durable Team telemetry: CreatorMediaAsset already carries the
  // typed CUSTOM provenance. Ordinary PPV/media sends therefore cost one
  // indexed creator+media lookup and never scan a creator's review history.
  if (client.creatorMediaAsset?.findMany) {
    const assets = await client.creatorMediaAsset.findMany({
      where: {
        agencyId,
        creatorId,
        source: "CUSTOM",
        mediaId: { in: uniqueIds(sentMediaIds) },
        customOrderId: { not: null },
      },
      select: { mediaId: true, customOrderId: true },
      take: Math.max(1, uniqueIds(sentMediaIds).length),
    });
    const byOrder = new Map();
    for (const asset of assets || []) {
      const orderId = clean(asset.customOrderId, 180);
      const mediaId = clean(asset.mediaId, 100);
      if (!orderId || !mediaId) continue;
      if (!byOrder.has(orderId)) byOrder.set(orderId, new Set());
      byOrder.get(orderId).add(mediaId);
    }
    const ranked = [...byOrder.entries()]
      .map(([orderId, ids]) => ({ orderId, matched: ids.size }))
      .sort((a, b) => b.matched - a.matched || a.orderId.localeCompare(b.orderId));
    if (!ranked.length) return { row: null, ambiguous: false };
    if (ranked.length > 1 && ranked[0].matched === ranked[1].matched) return { row: null, ambiguous: true };
    const row = await findExplicitSubmission(client, agencyId, ranked[0].orderId);
    return { row: row && eligibleSubmission(row, creatorId, dialogId) ? row : null, ambiguous: false };
  }

  // Compatibility path for isolated unit fakes / older service adapters. Real
  // production Prisma always uses the typed CreatorMediaAsset fast path above.
  const rows = await client.customContentSubmission.findMany({
    where: {
      agencyId, creatorId, reviewStatus: "APPROVED", reviewedAt: { not: null }, customOrderId: { not: null },
      customOrder: {
        is: {
          creatorId, dialogId, type: "CONTENT",
          OR: [{ status: "PENDING" }, { fanDeliveredAt: { not: null } }],
        },
      },
    },
    include: TRACK_INCLUDE,
    orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  const scored = rows
    .filter((row) => eligibleSubmission(row, creatorId, dialogId))
    .map((row) => ({ row, matched: intersection(sentMediaIds, row.ofMediaIds) }))
    .filter((item) => item.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length);
  if (!scored.length) return { row: null, ambiguous: false };
  if (scored.length > 1 && scored[0].matched.length === scored[1].matched.length) return { row: null, ambiguous: true };
  return { row: scored[0].row, ambiguous: false };
}

async function actorUserId(client, memberId, fallback = null) {
  if (fallback) return fallback;
  if (!memberId || !client.agencyMember?.findFirst) return null;
  const row = await client.agencyMember.findFirst({ where: { id: memberId }, select: { userId: true } });
  return row?.userId || null;
}

async function writeAudit(client, input) {
  try { await audit({ ...input, db: client }); } catch (_) { /* delivery state must not roll back on audit transport/schema drift */ }
}

async function recordCustomDeliverySend({
  agencyId,
  member = null,
  actorMemberId = null,
  actorUserId: explicitActorUserId = null,
  customOrderId = null,
  creatorId,
  dialogId,
  messageId,
  mediaIds,
  priceCents = 0,
  occurredAt = new Date(),
  overrideReason = null,
  duplicateOverride = false,
  enforceAccess = true,
  db = null,
} = {}) {
  const client = db || require("../prisma");
  const creator = clean(creatorId, 180); const dialog = clean(dialogId, 180); const message = clean(messageId, 220);
  if (!agencyId || !creator || !dialog || !message) throw fail("CUSTOM_DELIVERY_CONFIRM_INVALID", "creatorId, dialogId and messageId are required");
  const sentMediaIds = uniqueIds(mediaIds);
  if (!sentMediaIds.length) return { ok: true, matched: false, reason: "NO_MEDIA", customOrderId: null };
  if (enforceAccess) await requireDirectAccess({ agencyId, member, creatorId: creator, db: client });

  const explicitOrderId = clean(customOrderId, 180) || null;
  const selected = explicitOrderId
    ? { row: await findExplicitSubmission(client, agencyId, explicitOrderId), ambiguous: false }
    : await discoverSubmission(client, { agencyId, creatorId: creator, dialogId: dialog, sentMediaIds });
  if (selected.ambiguous) return { ok: true, matched: false, reason: "AMBIGUOUS_CUSTOM", customOrderId: null };
  const submission = selected.row;
  if (!submission || !eligibleSubmission(submission, creator, dialog)) {
    if (explicitOrderId) throw fail("CUSTOM_DELIVERY_NOT_READY", "Approved custom delivery was not found", 409);
    return { ok: true, matched: false, reason: "NO_MATCH", customOrderId: null };
  }

  const approvedMediaIds = uniqueIds(submission.ofMediaIds);
  const matchedMediaIds = intersection(sentMediaIds, approvedMediaIds);
  if (!matchedMediaIds.length) {
    if (explicitOrderId) throw fail("CUSTOM_DELIVERY_MEDIA_MISMATCH", "Outgoing message does not contain approved media for this custom", 409);
    return { ok: true, matched: false, reason: "NO_MATCH", customOrderId: null };
  }

  const order = submission.customOrder;
  const existingMessageIds = uniqueIds(order.deliveryMessageIds);
  const existingDeliveredIds = uniqueIds(order.deliverySentMediaIds);
  const alreadyRecorded = existingMessageIds.includes(message);
  const previousOffered = nonNegativeInt(order.deliveryOfferedCents, 0);
  const actualPriceCents = nonNegativeInt(priceCents, 0);
  const payment = paymentSnapshot(order.priceCents, order.paidAmountCents);
  const expectedPriceCents = Math.max(payment.remainingAmountCents - previousOffered, 0);
  const duplicateMediaIds = matchedMediaIds.filter((id) => existingDeliveredIds.includes(id));
  const newMediaIds = matchedMediaIds.filter((id) => !existingDeliveredIds.includes(id));

  if (alreadyRecorded) {
    return {
      ok: true, matched: true, idempotent: true, customOrderId: String(order.id), submissionId: String(submission.id),
      messageId: message, deliveredMediaIds: existingDeliveredIds, newlyDeliveredMediaIds: [], duplicateMediaIds: [],
      complete: allDelivered(approvedMediaIds, existingDeliveredIds), fanDeliveredAt: order.fanDeliveredAt ? new Date(order.fanDeliveredAt).toISOString() : null,
      expectedPriceCents, actualPriceCents, paymentStatus: payment.paymentStatus,
    };
  }

  const nextDeliveredIds = uniqueIds([...existingDeliveredIds, ...newMediaIds]);
  const nextMessageIds = uniqueIds([...existingMessageIds, message]);
  const complete = allDelivered(approvedMediaIds, nextDeliveredIds);
  const sentAt = dateValue(occurredAt);
  const effectiveFanDeliveredAt = complete ? (order.fanDeliveredAt ? new Date(order.fanDeliveredAt) : sentAt) : null;
  const nextOffered = Math.min(2_147_483_647, previousOffered + actualPriceCents);
  const updateData = {
    deliverySentMediaIds: nextDeliveredIds,
    deliveryMessageIds: nextMessageIds,
    deliveryOfferedCents: nextOffered,
    ...(complete && !order.fanDeliveredAt ? { fanDeliveredAt: sentAt } : {}),
    ...(complete && String(order.status || "") === "PENDING" ? { status: "COMPLETED", completedAt: order.completedAt || sentAt } : {}),
  };

  const changed = await client.customOrder.updateMany({
    where: { id: order.id, agencyId, updatedAt: order.updatedAt },
    data: updateData,
  });
  if (Number(changed?.count || 0) !== 1) {
    // Concurrent/manual telemetry replay: reload once. If this message already
    // won the race, treat it as an idempotent success rather than duplicating it.
    const fresh = await client.customOrder.findFirst({ where: { id: order.id, agencyId } });
    if (fresh && uniqueIds(fresh.deliveryMessageIds).includes(message)) {
      return {
        ok: true, matched: true, idempotent: true, customOrderId: String(order.id), submissionId: String(submission.id), messageId: message,
        deliveredMediaIds: uniqueIds(fresh.deliverySentMediaIds), newlyDeliveredMediaIds: [], duplicateMediaIds: [],
        complete: Boolean(fresh.fanDeliveredAt), fanDeliveredAt: fresh.fanDeliveredAt ? new Date(fresh.fanDeliveredAt).toISOString() : null,
        expectedPriceCents, actualPriceCents, paymentStatus: payment.paymentStatus,
      };
    }
    throw fail("CUSTOM_DELIVERY_CONFLICT", "Custom delivery changed concurrently; retry", 409);
  }

  const memberId = member?.id || clean(actorMemberId, 180) || null;
  const userId = await actorUserId(client, memberId, member?.userId || explicitActorUserId || null);
  const commonMetadata = {
    creatorId: creator, dialogId: dialog, submissionId: String(submission.id), messageId: message,
    approvedMediaCount: approvedMediaIds.length, matchedMediaIds, newlyDeliveredMediaIds: newMediaIds,
    duplicateMediaIds, expectedPriceCents, actualPriceCents,
    totalPriceCents: Math.max(0, Number(order.priceCents || 0)), paidAmountCents: payment.paidAmountCents,
    remainingAmountCents: payment.remainingAmountCents, previousDeliveryOfferedCents: previousOffered,
    deliveryOfferedCents: nextOffered, complete,
  };
  await writeAudit(client, { agencyId, actorUserId: userId, action: "custom_order.fan_delivery_send", targetType: "CustomOrder", targetId: order.id, metadata: commonMetadata });

  if (duplicateMediaIds.length) {
    await writeAudit(client, {
      agencyId, actorUserId: userId, action: "CUSTOM_DELIVERY_DUPLICATE_ATTEMPT", targetType: "CustomOrder", targetId: order.id,
      metadata: { ...commonMetadata, overrideConfirmed: duplicateOverride === true },
    });
  }
  if (actualPriceCents > expectedPriceCents) {
    await writeAudit(client, {
      agencyId, actorUserId: userId, action: "CUSTOM_PAYMENT_OVERRIDE", targetType: "CustomOrder", targetId: order.id,
      metadata: { ...commonMetadata, reason: clean(overrideReason, 500) || null },
    });
  } else if (actualPriceCents < expectedPriceCents) {
    await writeAudit(client, {
      agencyId, actorUserId: userId, action: "CUSTOM_PAYMENT_UNDERCHARGE", targetType: "CustomOrder", targetId: order.id,
      metadata: { ...commonMetadata, shortfallCents: expectedPriceCents - actualPriceCents },
    });
  }

  return {
    ok: true, matched: true, idempotent: false, customOrderId: String(order.id), submissionId: String(submission.id), messageId: message,
    deliveredMediaIds: nextDeliveredIds, newlyDeliveredMediaIds: newMediaIds, duplicateMediaIds,
    complete, fanDeliveredAt: effectiveFanDeliveredAt ? effectiveFanDeliveredAt.toISOString() : null,
    expectedPriceCents, actualPriceCents, paymentStatus: payment.paymentStatus,
    paymentMismatch: actualPriceCents === expectedPriceCents ? null : actualPriceCents > expectedPriceCents ? "OVERCHARGE" : "UNDERCHARGE",
  };
}

async function projectCustomDeliveryFromTeamEvent(row, { db = null } = {}) {
  if (!row || String(row.eventKind || "") !== "MESSAGE_SEND_CONFIRMED" || String(row.actionSource || "") !== "MANUAL" || String(row.lifecycle || "") !== "CONFIRMED") return null;
  const mediaIds = uniqueIds(row?.extra?.mediaIds);
  if (!row.agencyId || !row.creatorId || !row.dialogId || !row.messageId || !mediaIds.length) return null;
  return recordCustomDeliverySend({
    agencyId: row.agencyId,
    actorMemberId: row.memberId || null,
    actorUserId: row.userId || null,
    creatorId: row.creatorId,
    dialogId: row.dialogId,
    messageId: row.messageId,
    mediaIds,
    priceCents: row.priceCents || 0,
    occurredAt: row.ts,
    enforceAccess: false,
    db: db || require("../prisma"),
  });
}

module.exports = {
  allDelivered,
  projectCustomDeliveryFromTeamEvent,
  recordCustomDeliverySend,
};
