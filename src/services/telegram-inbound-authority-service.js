"use strict";

const crypto = require("node:crypto");
const { audit } = require("./audit-service");
const { assertTelegramInboundRuntimeLease } = require("./telegram-execution-runtime");
const { resolveTelegramAccountId } = require("./custom-order-reminders");
const { createCustomContentSubmissionFromInboundEvent } = require("./custom-content-submissions-service");

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 4000) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }
function positiveInt(value, field, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw fail("TELEGRAM_INBOUND_MESSAGE_ID_INVALID", `${field} must be a positive Telegram message id`); return n;
}
function sentAt(value, now) { const d = new Date(String(value || "")); if (!Number.isFinite(d.getTime())) return new Date(now); return d; }
function eventId({ agencyId, accountId, senderTelegramUserId, messageId }) { return `tgi_${crypto.createHash("sha256").update(`${agencyId}\n${accountId}\n${senderTelegramUserId}\n${messageId}`).digest("hex")}`; }

async function resolveCreator({ agencyId, accountId, senderTelegramUserId, replyToMessageId = null, db }) {
  // A direct Reply to our own CONFIRMED provider message is the strongest correlation proof.
  // It also works when remoteRecipientTelegramUserId could not be persisted during manual repair.
  if (replyToMessageId && db.telegramDeliveryIntent?.findFirst) {
    const replied = await db.telegramDeliveryIntent.findFirst({
      where: { agencyId, accountId, state: "CONFIRMED", remoteMessageId: replyToMessageId },
      select: { creatorId: true, customOrderId: true, remoteRecipientTelegramUserId: true },
      orderBy: { confirmedAt: "desc" },
    });
    if (replied) {
      const provenRecipient = clean(replied.remoteRecipientTelegramUserId, 40);
      if (provenRecipient && provenRecipient !== String(senderTelegramUserId)) return { creator: null, proven: true, conflict: true, customOrderId: null };
      return { creator: { id: String(replied.creatorId), telegramAccountId: accountId, telegramUserId: senderTelegramUserId }, proven: true, conflict: false, customOrderId: String(replied.customOrderId) };
    }
  }

  // A confirmed provider recipient receipt is stronger than the best-effort
  // Creator.telegramUserId projection. This keeps inbound correlation alive when
  // the post-send identity PATCH was lost and prevents stale identity projection
  // from becoming submission provenance while a provider receipt is still pending.
  if (db.telegramDeliveryIntent?.findMany) {
    const proven = await db.telegramDeliveryIntent.findMany({
      where: { agencyId, accountId, state: "CONFIRMED", remoteRecipientTelegramUserId: senderTelegramUserId },
      select: { creatorId: true }, orderBy: [{ confirmedAt: "desc" }, { id: "desc" }], take: 20,
    });
    const provenCreatorIds = Array.from(new Set((proven || []).map((row) => String(row.creatorId || "")).filter(Boolean)));
    if (provenCreatorIds.length === 1) return { creator: { id: provenCreatorIds[0], telegramAccountId: accountId, telegramUserId: senderTelegramUserId }, proven: true, conflict: false, customOrderId: null };
    if (provenCreatorIds.length > 1) return { creator: null, proven: true, conflict: true, customOrderId: null };
  }

  // Legacy/best-effort identity may still be useful for diagnostics/UI, but it is
  // intentionally NOT strong enough to establish Custom submission provenance.
  const candidates = await db.creatorAccount.findMany({ where: { agencyId, deletedAt: null, telegramUserId: senderTelegramUserId }, select: { id: true, telegramAccountId: true, telegramContact: true }, take: 20 });
  const matched = [];
  for (const creator of candidates) {
    const resolved = await resolveTelegramAccountId({ agencyId, creator, db });
    if (resolved && String(resolved) === String(accountId)) matched.push(creator);
  }
  return { creator: matched.length === 1 ? matched[0] : null, proven: false, conflict: matched.length > 1, customOrderId: null };
}

async function correlateOrder({ agencyId, accountId, creatorId, replyToMessageId, db }) {
  if (!creatorId) return null;
  if (replyToMessageId) {
    // A direct Reply is strong correlation only when the replied-to provider message is itself
    // a canonical CONFIRMED Telegram delivery.  Never reinterpret an unmatched Reply as the
    // generic single-active-order fallback and never use legacy CustomOrder message-id projections
    // as a second business fact authority.
    const intent = await db.telegramDeliveryIntent.findFirst({ where: { agencyId, accountId, creatorId, state: "CONFIRMED", remoteMessageId: replyToMessageId }, orderBy: { confirmedAt: "desc" } });
    return intent ? String(intent.customOrderId) : null;
  }
  // Non-Reply intake has an explicit product fallback: exactly one active CONTENT custom.
  const active = await db.customOrder.findMany({ where: { agencyId, creatorId, type: "CONTENT", status: "PENDING" }, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2 });
  return active.length === 1 ? String(active[0].id) : null;
}

async function updateFreshProjection({ agencyId, creatorId, orderId, messageId, observedAt, db }) {
  if (!creatorId || !orderId) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await db.customOrder.findFirst({ where: { id: orderId, agencyId, creatorId }, select: { id: true, telegramLastModelMessageId: true, telegramLastModelMessageAt: true, updatedAt: true } });
    if (!row) return;
    const previousAt = row.telegramLastModelMessageAt ? new Date(row.telegramLastModelMessageAt).getTime() : -1;
    const nextAt = observedAt.getTime(); const previousId = Number(row.telegramLastModelMessageId || 0);
    if (previousAt > nextAt || (previousAt === nextAt && previousId >= messageId)) return;
    const changed = await db.customOrder.updateMany({ where: { id: row.id, agencyId, updatedAt: row.updatedAt }, data: { telegramLastModelMessageId: messageId, telegramLastModelMessageAt: observedAt } });
    if (Number(changed?.count || 0) === 1) return;
  }
}


async function reconcilePendingInboundForConfirmedDelivery({ agencyId, accountId, senderTelegramUserId = null, replyToMessageId = null, actorUserId = null, now = new Date(), limit = 200, db = null } = {}) {
  const client = db || require("../prisma");
  const normalizedAccountId = clean(accountId, 180);
  const sender = clean(senderTelegramUserId, 40);
  const replyId = positiveInt(replyToMessageId, "replyToMessageId", true);
  if (!agencyId || !normalizedAccountId || (!/^\d{1,20}$/.test(sender) && !replyId)) return { ok: true, reconciled: 0, submissions: 0 };

  // A confirmed recipient identity proves all matching inbound events for this provider account.
  // A confirmed remote message id independently proves events that Reply to that exact message,
  // which is essential for manual reconciliation where recipient identity may be unavailable.
  const candidateOr = [];
  if (/^\d{1,20}$/.test(sender)) candidateOr.push({ senderTelegramUserId: sender });
  if (replyId) candidateOr.push({ replyToMessageId: replyId });
  const take = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  const rows = await client.telegramInboundEvent.findMany({
    where: { agencyId, accountId: normalizedAccountId, submissionId: null, ...(candidateOr.length === 1 ? candidateOr[0] : { OR: candidateOr }) },
    orderBy: [{ sentAt: "asc" }, { messageId: "asc" }],
    take,
  });
  let reconciled = 0; let submissions = 0; const creatorIds = new Set();
  for (const snapshot of rows) {
    const eventSender = clean(snapshot.senderTelegramUserId, 40);
    if (!/^\d{1,20}$/.test(eventSender)) continue;
    const eventResolution = await resolveCreator({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: eventSender, replyToMessageId: snapshot.replyToMessageId, db: client });
    if (!eventResolution.proven || !eventResolution.creator?.id || eventResolution.conflict) continue;
    const creatorId = String(eventResolution.creator.id); creatorIds.add(creatorId);
    const customOrderId = eventResolution.customOrderId || await correlateOrder({ agencyId, accountId: normalizedAccountId, creatorId, replyToMessageId: snapshot.replyToMessageId, db: client });
    const data = { creatorId, customOrderId: customOrderId || null };
    let row = snapshot;
    if (String(snapshot.creatorId || "") !== creatorId || String(snapshot.customOrderId || "") !== String(customOrderId || "")) {
      const changed = await client.telegramInboundEvent.updateMany({ where: { id: snapshot.id, agencyId, submissionId: null, updatedAt: snapshot.updatedAt }, data });
      if (Number(changed?.count || 0) !== 1) {
        row = await client.telegramInboundEvent.findFirst({ where: { id: snapshot.id, agencyId } });
        if (!row || row.submissionId || String(row.creatorId || "") !== creatorId) continue;
      } else {
        row = await client.telegramInboundEvent.findFirst({ where: { id: snapshot.id, agencyId } });
      }
    }
    if (!row) continue;
    const effectiveCreatorId = row.creatorId || creatorId;
    const effectiveOrderId = row.customOrderId || customOrderId || null;
    await updateFreshProjection({ agencyId, creatorId: effectiveCreatorId, orderId: effectiveOrderId, messageId: Number(row.messageId), observedAt: new Date(row.sentAt), db: client });
    if (row.hasMedia === true && effectiveCreatorId) {
      const projected = await createCustomContentSubmissionFromInboundEvent({ eventId: row.id, actorUserId, now, db: client });
      if (projected?.submission) submissions += 1;
    }
    reconciled += 1;
  }
  if (reconciled > 0) await audit({ agencyId, actorUserId, action: "custom_order.telegram_inbound_reconcile_after_delivery_receipt", targetType: "TelegramDeliveryReceipt", targetId: `${normalizedAccountId}:${sender || replyId || "unknown"}`, metadata: { creatorIds: Array.from(creatorIds), reconciled, submissions, replyToMessageId: replyId }, db: client });
  return { ok: true, creatorId: creatorIds.size === 1 ? Array.from(creatorIds)[0] : null, reconciled, submissions };
}

async function reconcilePendingInboundForRecipient({ agencyId, accountId, senderTelegramUserId, actorUserId = null, now = new Date(), limit = 200, db = null } = {}) {
  return reconcilePendingInboundForConfirmedDelivery({ agencyId, accountId, senderTelegramUserId, actorUserId, now, limit, db });
}

async function ingestTelegramInboundEvent({ agencyId, member, accountId, deviceId, claimToken, senderTelegramUserId, messageId, replyToMessageId = null, groupedId = null, hasMedia = false, text = null, sentAt: sentAtInput = null, now = new Date(), db = null } = {}) {
  const client = db || require("../prisma"); const normalizedAccountId = clean(accountId, 180); const sender = clean(senderTelegramUserId, 40);
  if (!normalizedAccountId || !/^\d{1,20}$/.test(sender)) throw fail("TELEGRAM_INBOUND_SCOPE_INVALID", "Telegram account and sender identity are required");
  const inboundMessageId = positiveInt(messageId, "messageId"); const replyId = positiveInt(replyToMessageId, "replyToMessageId", true); const observedAt = sentAt(sentAtInput, now);
  await assertTelegramInboundRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId, claimToken, now, db: client });
  const resolution = await resolveCreator({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: sender, replyToMessageId: replyId, db: client });
  // Only provider-proven correlation can establish durable Custom business facts.
  // Weak Creator.telegramUserId fallback is deliberately kept out of creator/order/submission projection.
  const creatorId = resolution.proven && resolution.creator ? String(resolution.creator.id) : null;
  const customOrderId = creatorId ? (resolution.customOrderId || await correlateOrder({ agencyId, accountId: normalizedAccountId, creatorId, replyToMessageId: replyId, db: client })) : null;
  const id = eventId({ agencyId, accountId: normalizedAccountId, senderTelegramUserId: sender, messageId: inboundMessageId });
  let row = await client.telegramInboundEvent.findFirst({ where: { id } });
  if (!row) {
    try {
      row = await client.telegramInboundEvent.create({ data: {
        id, agencyId, accountId: normalizedAccountId, creatorId, customOrderId, senderTelegramUserId: sender, messageId: inboundMessageId,
        replyToMessageId: replyId, groupedId: clean(groupedId, 180) || null, hasMedia: hasMedia === true, text: clean(text, 4000) || null,
        sentAt: observedAt, observedAt: now,
      } });
    } catch (error) {
      if (String(error?.code || "") !== "P2002") throw error;
      row = await client.telegramInboundEvent.findFirst({ where: { id } });
    }
  }
  if (!row) throw fail("TELEGRAM_INBOUND_PERSIST_FAILED", "Telegram inbound event could not be persisted", 500);
  if (creatorId && !row.submissionId && (String(row.creatorId || "") !== creatorId || String(row.customOrderId || "") !== String(customOrderId || ""))) {
    const changed = await client.telegramInboundEvent.updateMany({
      where: { id: row.id, agencyId, submissionId: null, updatedAt: row.updatedAt },
      data: { creatorId, customOrderId: customOrderId || null },
    });
    if (Number(changed?.count || 0) === 1) row = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId } });
    else row = await client.telegramInboundEvent.findFirst({ where: { id: row.id, agencyId } }) || row;
  }
  if (creatorId && row.creatorId && String(row.creatorId) !== creatorId && row.submissionId) {
    throw fail("TELEGRAM_INBOUND_PROVENANCE_CONFLICT", "A stronger Telegram provider proof conflicts with an already-materialized submission", 409);
  }
  const provenCreatorId = creatorId && String(row.creatorId || "") === creatorId ? creatorId : null;
  const provenOrderId = provenCreatorId ? (row.customOrderId || customOrderId) : null;
  await updateFreshProjection({ agencyId, creatorId: provenCreatorId, orderId: provenOrderId, messageId: inboundMessageId, observedAt, db: client });
  let submission = null;
  if (row.hasMedia === true && provenCreatorId) submission = await createCustomContentSubmissionFromInboundEvent({ eventId: row.id, actorUserId: member?.userId || null, now, db: client });
  await audit({ agencyId, actorUserId: member?.userId || null, action: "custom_order.telegram_inbound_ingest", targetType: "TelegramInboundEvent", targetId: row.id, metadata: { accountId: normalizedAccountId, creatorId: row.creatorId || null, customOrderId: row.customOrderId || null, messageId: inboundMessageId, replyToMessageId: replyId, hasMedia: row.hasMedia === true, submissionId: submission?.submission?.id || row.submissionId || null }, db: client });
  return { ok: true, deduped: Boolean(row.createdAt && new Date(row.createdAt).getTime() < new Date(now).getTime()), event: { id: row.id, creatorId: row.creatorId || null, customOrderId: row.customOrderId || null, messageId: String(row.messageId), replyToMessageId: row.replyToMessageId == null ? null : String(row.replyToMessageId), groupedId: row.groupedId || null, hasMedia: row.hasMedia === true, sentAt: new Date(row.sentAt).toISOString(), submissionId: submission?.submission?.id || row.submissionId || null } };
}

module.exports = { ingestTelegramInboundEvent, reconcilePendingInboundForRecipient, reconcilePendingInboundForConfirmedDelivery, updateFreshProjection };
