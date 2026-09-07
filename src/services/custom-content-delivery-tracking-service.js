"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { paymentSnapshot } = require("./custom-orders-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const { FAILURE_CATEGORIES } = require("./automation-failure-taxonomy");
const { isProviderStatusProvenNoEffect, isProviderStatusProvenSuccess } = require("./provider-http-outcome-proof");

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
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
function tokenHash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function tokenMatches(value, expected) {
  const actual = Buffer.from(tokenHash(value)); const wanted = Buffer.from(String(expected || ""));
  return actual.length === wanted.length && actual.length > 0 && crypto.timingSafeEqual(actual, wanted);
}

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
  guardMetadata = null,
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
  const guard = guardMetadata && typeof guardMetadata === "object" && !Array.isArray(guardMetadata) ? guardMetadata : null;
  const guardMatchesOrder = clean(guard?.customOrderId, 180) === String(order.id);
  // Guard metadata is audit context only. Canonical delivery/order selection
  // above is always derived from durable media provenance; client metadata can
  // never select or resurrect a Custom.
  const effectiveOverrideReason = guardMatchesOrder ? (clean(guard?.overrideReason, 500) || null) : (clean(overrideReason, 500) || null);
  const effectiveDuplicateOverride = guardMatchesOrder ? guard?.duplicateOverride === true : duplicateOverride === true;
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
      metadata: { ...commonMetadata, overrideConfirmed: effectiveDuplicateOverride },
    });
  }
  if (actualPriceCents > expectedPriceCents) {
    await writeAudit(client, {
      agencyId, actorUserId: userId, action: "CUSTOM_PAYMENT_OVERRIDE", targetType: "CustomOrder", targetId: order.id,
      metadata: { ...commonMetadata, reason: effectiveOverrideReason },
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


async function settleCustomManualDeliveryWriteFromTeamEvent({ client, row, projection }) {
  const guard = object(row?.extra?.metadata?.customDeliveryGuard);
  if (clean(guard.authorityVersion, 80) !== "CUSTOM_MANUAL_V1") return { required: false, settled: false };
  const writeId = clean(guard.writeId, 180);
  const idempotencyKey = clean(guard.idempotencyKey, 500);
  const guardedOrderId = clean(guard.customOrderId, 180);
  const guardedRevision = Number(guard.writeCommitRevision);
  if (!writeId || !idempotencyKey || !guardedOrderId || !Number.isInteger(guardedRevision) || guardedRevision <= 0) {
    throw fail("CUSTOM_DELIVERY_WRITE_PROOF_INVALID", "Canonical Custom delivery event is missing its server commit authority binding", 409);
  }
  if (!client.automationDelivery?.findUnique || !client.automationDelivery?.updateMany) {
    throw fail("CUSTOM_DELIVERY_WRITE_AUTHORITY_UNAVAILABLE", "AutomationDelivery authority is unavailable for Custom delivery settlement", 500);
  }
  const delivery = await client.automationDelivery.findUnique({ where: { id: writeId } });
  if (!delivery) throw fail("CUSTOM_DELIVERY_WRITE_NOT_FOUND", "Physical Custom delivery commit authority was not found", 409);
  const payload = object(delivery.payload);
  const result = object(delivery.result);
  const actualMediaIds = uniqueIds(row?.extra?.mediaIds);
  const boundMediaIds = uniqueIds(payload.attemptedMediaIds);
  const bindingValid = String(delivery.agencyId || "") === String(row.agencyId || "")
    && String(delivery.creatorId || "") === String(row.creatorId || "")
    && String(delivery.actionType || "") === "CUSTOM_MANUAL_SEND"
    && String(delivery.originKind || "") === "INTERACTIVE"
    && String(result.programmaticWriteKind || "") === "CUSTOM_MANUAL_SEND"
    && String(delivery.idempotencyKey || "") === idempotencyKey
    && String(delivery.targetId || "") === guardedOrderId
    && String(payload.customOrderId || "") === guardedOrderId
    && String(payload.customOrderId || "") === String(projection?.customOrderId || "")
    && String(payload.submissionId || "") === String(projection?.submissionId || "")
    && String(payload.creatorId || "") === String(row.creatorId || "")
    && String(payload.dialogId || "") === String(row.dialogId || "")
    && arraysEqualAsSet(boundMediaIds, actualMediaIds);
  if (!bindingValid) throw fail("CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH", "Canonical Team event does not match the reserved physical Custom delivery", 409);

  const messageId = clean(row.messageId, 220);
  if (String(delivery.status || "") === "COMPLETED") {
    const completedMessageId = clean(delivery.messageId || result.messageId, 220);
    if (completedMessageId !== messageId) throw fail("CUSTOM_DELIVERY_WRITE_RESULT_CONFLICT", "Physical Custom delivery authority is already completed with another remote message", 409);
    return { required: true, settled: true, idempotent: true, writeId };
  }

  const lateUnresolved = String(delivery.status || "") === "FAILED" && String(delivery.failureCode || "") === "outcome_unresolved_do_not_retry";
  if (!new Set(["COMMITTING", "RECONCILE_REQUIRED"]).has(String(delivery.status || "")) && !lateUnresolved) {
    throw fail("CUSTOM_DELIVERY_WRITE_STATE_INVALID", `Physical Custom delivery authority is ${String(delivery.status || "UNKNOWN")}, not committed/unknown`, 409);
  }
  if (Number(delivery.writeCommitRevision || 0) !== guardedRevision) {
    throw fail("CUSTOM_DELIVERY_WRITE_REVISION_MISMATCH", "Physical Custom delivery commit revision changed before proof settlement", 409);
  }
  const now = new Date();
  const changed = await client.automationDelivery.updateMany({
    where: { id: writeId, status: String(delivery.status), writeCommitRevision: guardedRevision },
    data: {
      status: "COMPLETED",
      failureCode: null, failureCategory: null, lastError: null, error: null,
      messageId,
      result: {
        ...result,
        messageId,
        mediaIds: actualMediaIds,
        customOrderId: String(projection.customOrderId),
        submissionId: String(projection.submissionId),
        outcomeState: "PROVEN_SUCCESS",
        teamEventSettledAt: now.toISOString(),
      },
      finishedAt: now, claimUntil: null, leaseTokenHash: null, lastCheckedAt: now,
    },
  });
  if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_DELIVERY_WRITE_SETTLE_RACE", "Physical Custom delivery authority changed while canonical proof was settling", 409);
  return { required: true, settled: true, idempotent: false, writeId };
}


async function settleCustomManualDeliveryWithCapability(input, { db = null } = {}) {
  const client = db || require("../prisma");
  const writeId = clean(input?.writeId, 180);
  const settlementToken = clean(input?.settlementToken, 500);
  const deviceId = clean(input?.deviceId, 180);
  const networkRequestId = clean(input?.networkRequestId, 220);
  const revision = Number(input?.writeCommitRevision);
  const outcome = clean(input?.outcome, 40).toUpperCase();
  const providerStatus = Number(input?.providerStatus);
  const messageId = clean(input?.messageId, 220);
  const occurredAt = dateValue(input?.occurredAt || new Date());
  if (!writeId || !settlementToken || !deviceId || !networkRequestId || !Number.isInteger(revision) || revision < 1
      || !["PROVEN_SUCCESS", "PROVEN_NO_EFFECT"].includes(outcome) || !Number.isInteger(providerStatus)) {
    throw fail("CUSTOM_DELIVERY_SETTLEMENT_INVALID", "Exact Custom settlement proof is incomplete", 400);
  }
  if (outcome === "PROVEN_SUCCESS" && !messageId) throw fail("CUSTOM_DELIVERY_SETTLEMENT_MESSAGE_REQUIRED", "Confirmed Custom settlement requires the exact provider message id", 400);
  if (outcome === "PROVEN_SUCCESS" && !isProviderStatusProvenSuccess(providerStatus)) throw fail("CUSTOM_DELIVERY_SETTLEMENT_STATUS_INVALID", `HTTP ${providerStatus} does not prove Custom send success`, 409);
  if (outcome === "PROVEN_NO_EFFECT" && !isProviderStatusProvenNoEffect(providerStatus)) throw fail("CUSTOM_DELIVERY_SETTLEMENT_STATUS_AMBIGUOUS", `HTTP ${providerStatus} does not prove that no Custom send effect occurred`, 409);

  const settle = async (tx) => {
    const initial = await tx.automationDelivery.findUnique({ where: { id: writeId } });
    if (!initial) throw fail("CUSTOM_DELIVERY_WRITE_NOT_FOUND", "Physical Custom delivery commit authority was not found", 404);
    await lockAutomationWriteCommitFence({ db: tx, agencyId: initial.agencyId });
    const delivery = await tx.automationDelivery.findUnique({ where: { id: writeId } });
    if (!delivery) throw fail("CUSTOM_DELIVERY_WRITE_NOT_FOUND", "Physical Custom delivery commit authority was not found", 404);
    const payload = object(delivery.payload); const result = object(delivery.result);
    const hashes = (Array.isArray(result.customManualSettlementTokenHashes) ? result.customManualSettlementTokenHashes : []).map((value) => clean(value, 200)).filter(Boolean);
    const bindingValid = String(delivery.actionType || "") === "CUSTOM_MANUAL_SEND"
      && String(delivery.originKind || "") === "INTERACTIVE"
      && String(result.programmaticWriteKind || "") === "CUSTOM_MANUAL_SEND"
      && String(delivery.sourceDeviceId || "") === deviceId
      && clean(payload.networkRequestId, 220) === networkRequestId
      && Number(delivery.writeCommitRevision || 0) === revision
      && hashes.some((hash) => tokenMatches(settlementToken, hash));
    if (!bindingValid) throw fail("CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH", "Custom settlement capability does not match the committed physical request", 403);

    if (outcome === "PROVEN_NO_EFFECT") {
      if (String(delivery.status || "") === "RETRY_SCHEDULED" && String(delivery.failureCode || "") === "provider_rejected_no_effect") {
        return { ok: true, duplicate: true, provenNoEffect: true, writeId };
      }
      if (!delivery.writeCommitAt) throw fail("CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH", "Custom rejection belongs to a request that is no longer physically committed", 403);
      if (!["COMMITTING", "RECONCILE_REQUIRED"].includes(String(delivery.status || ""))
          && !(String(delivery.status || "") === "FAILED" && String(delivery.failureCode || "") === "outcome_unresolved_do_not_retry")) {
        throw fail("CUSTOM_DELIVERY_WRITE_STATE_INVALID", `Physical Custom delivery authority is ${String(delivery.status || "UNKNOWN")}, not settleable`, 409);
      }
      const now = new Date();
      const changed = await tx.automationDelivery.updateMany({
        where: { id: writeId, status: String(delivery.status), writeCommitRevision: revision },
        data: {
          status: "RETRY_SCHEDULED", failureCode: "provider_rejected_no_effect", failureCategory: FAILURE_CATEGORIES.DEFINITE_NO_WRITE_RETRYABLE,
          lastError: null, error: null, writeCommitAt: null,
          result: { ...result, outcomeState: "PROVEN_NO_EFFECT", providerStatus, providerRejectedAt: now.toISOString() },
          notBefore: now, finishedAt: null, claimUntil: null, leaseTokenHash: null, lastCheckedAt: now,
        },
      });
      if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_DELIVERY_WRITE_SETTLE_RACE", "Physical Custom delivery authority changed while rejection proof was settling", 409);
      return { ok: true, provenNoEffect: true, writeId };
    }

    if (String(delivery.status || "") === "COMPLETED") {
      const completedMessageId = clean(delivery.messageId || result.messageId, 220);
      if (completedMessageId !== messageId) throw fail("CUSTOM_DELIVERY_WRITE_RESULT_CONFLICT", "Physical Custom delivery authority already completed with another provider message", 409);
      return { ok: true, duplicate: true, provenSuccess: true, writeId, messageId };
    }
    if (!delivery.writeCommitAt) throw fail("CUSTOM_DELIVERY_WRITE_BINDING_MISMATCH", "Custom success belongs to a request that is no longer physically committed", 403);
    if (!["COMMITTING", "RECONCILE_REQUIRED"].includes(String(delivery.status || ""))
        && !(String(delivery.status || "") === "FAILED" && String(delivery.failureCode || "") === "outcome_unresolved_do_not_retry")) {
      throw fail("CUSTOM_DELIVERY_WRITE_STATE_INVALID", `Physical Custom delivery authority is ${String(delivery.status || "UNKNOWN")}, not settleable`, 409);
    }
    const mediaIds = uniqueIds(payload.attemptedMediaIds);
    if (!mediaIds.length) throw fail("CUSTOM_DELIVERY_WRITE_PROOF_INVALID", "Committed Custom delivery has no bound media ids", 409);
    const guardMetadata = {
      customOrderId: clean(payload.customOrderId, 180), overrideReason: clean(payload.overrideReason, 500) || null,
      duplicateOverride: payload.duplicateOverride === true, priceMismatchOverride: payload.priceMismatchOverride === true,
      authorityVersion: "CUSTOM_MANUAL_V2", writeId, idempotencyKey: String(delivery.idempotencyKey || ""), writeCommitRevision: revision,
    };
    const projection = await recordCustomDeliverySend({
      agencyId: delivery.agencyId, actorMemberId: delivery.leaseMemberId || clean(payload.actorMemberId, 180) || null,
      actorUserId: delivery.createdByUserId || clean(payload.actorUserId, 180) || null,
      customOrderId: clean(payload.customOrderId, 180), creatorId: delivery.creatorId, dialogId: clean(payload.dialogId || delivery.dialogId, 180),
      messageId, mediaIds, priceCents: nonNegativeInt(payload.actualPriceCents, 0), occurredAt,
      guardMetadata, enforceAccess: false, db: tx,
    });
    if (!projection?.matched) throw fail("CUSTOM_DELIVERY_WRITE_PROJECTION_REQUIRED", "Settlement proof did not project to its reserved Custom order", 409);
    const now = new Date();
    const changed = await tx.automationDelivery.updateMany({
      where: { id: writeId, status: String(delivery.status), writeCommitRevision: revision },
      data: {
        status: "COMPLETED", failureCode: null, failureCategory: null, lastError: null, error: null, messageId,
        result: { ...result, messageId, mediaIds, customOrderId: String(projection.customOrderId), submissionId: String(projection.submissionId), outcomeState: "PROVEN_SUCCESS", capabilitySettledAt: now.toISOString(), providerStatus },
        finishedAt: now, claimUntil: null, leaseTokenHash: null, lastCheckedAt: now,
      },
    });
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_DELIVERY_WRITE_SETTLE_RACE", "Physical Custom delivery authority changed while exact proof was settling", 409);
    return { ok: true, provenSuccess: true, writeId, messageId, projection };
  };
  if (client.$transaction && !db) return client.$transaction(settle, { timeout: 30_000 });
  return settle(client);
}

async function projectCustomDeliveryFromTeamEvent(row, { db = null } = {}) {
  if (!row || String(row.eventKind || "") !== "MESSAGE_SEND_CONFIRMED" || String(row.actionSource || "") !== "MANUAL" || String(row.lifecycle || "") !== "CONFIRMED") return null;
  const mediaIds = uniqueIds(row?.extra?.mediaIds);
  if (!row.agencyId || !row.creatorId || !row.dialogId || !row.messageId || !mediaIds.length) return null;
  const client = db || require("../prisma");
  const guard = object(row?.extra?.metadata?.customDeliveryGuard);
  const requiresCommitSettlement = clean(guard.authorityVersion, 80) === "CUSTOM_MANUAL_V1";
  const projection = await recordCustomDeliverySend({
    agencyId: row.agencyId,
    actorMemberId: row.memberId || null,
    actorUserId: row.userId || null,
    customOrderId: requiresCommitSettlement ? (clean(guard.customOrderId, 180) || null) : null,
    creatorId: row.creatorId,
    dialogId: row.dialogId,
    messageId: row.messageId,
    mediaIds,
    priceCents: row.priceCents || 0,
    occurredAt: row.ts,
    guardMetadata: guard,
    enforceAccess: false,
    db: client,
  });
  // A V1 event is the canonical proof that releases a server-visible physical
  // commit fence. It may never be durably ACKed as an unrelated/unmatched Team
  // event, otherwise the AutomationDelivery would remain COMMITTING while the
  // canonical replay source has already been consumed. Legacy telemetry remains
  // permissive because it predates the server commit binding.
  if (requiresCommitSettlement && !projection?.matched) {
    throw fail("CUSTOM_DELIVERY_WRITE_PROJECTION_REQUIRED", "Server-bound Custom delivery proof did not project to its reserved Custom order", 409);
  }
  if (projection?.matched) await settleCustomManualDeliveryWriteFromTeamEvent({ client, row, projection });
  return projection;
}

module.exports = {
  allDelivered,
  projectCustomDeliveryFromTeamEvent,
  recordCustomDeliverySend,
  settleCustomManualDeliveryWriteFromTeamEvent,
  settleCustomManualDeliveryWithCapability,
};
