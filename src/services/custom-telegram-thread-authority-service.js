"use strict";

const crypto = require("node:crypto");

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}
function positiveInt(value, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}
function providerMessageEventId({ agencyId, accountId, senderTelegramUserId, messageId }) {
  return `tgi_${crypto.createHash("sha256").update(`${agencyId}\n${accountId}\n${senderTelegramUserId}\n${messageId}`).digest("hex")}`;
}
function confirmationAuthority(row) {
  const explicit = clean(row?.confirmationAuthority, 60).toUpperCase();
  if (explicit) return explicit;
  const reason = clean(row?.outcomeReason, 500).toUpperCase();
  return reason.startsWith("MANUAL_CONFIRMED:") ? "MANUAL_RECONCILIATION" : "PROVIDER_RECEIPT";
}
function publicThread(intent, order, type) {
  return {
    resolutionType: type,
    anchorIntentId: String(intent.id),
    agencyId: String(intent.agencyId),
    accountId: String(intent.accountId),
    telegramUserId: clean(intent.remoteRecipientTelegramUserId, 40) || null,
    anchorMessageId: intent.remoteMessageId == null ? null : String(intent.remoteMessageId),
    creatorId: String(intent.creatorId),
    customOrderId: String(intent.customOrderId),
    customOrderType: String(order?.type || ""),
    customOrderStatus: String(order?.status || ""),
    confirmationAuthority: confirmationAuthority(intent),
  };
}
async function matchingConfirmedMessageRows({ agencyId, accountId, remoteMessageId, db }) {
  const where = { agencyId, accountId, state: "CONFIRMED", remoteMessageId };
  if (db.telegramDeliveryIntent?.findMany) {
    return db.telegramDeliveryIntent.findMany({
      where,
      select: {
        id: true, agencyId: true, accountId: true, creatorId: true, customOrderId: true,
        remoteMessageId: true, remoteRecipientTelegramUserId: true, confirmationAuthority: true,
        outcomeReason: true, confirmedAt: true,
      },
      orderBy: [{ confirmedAt: "desc" }, { id: "desc" }],
      take: 2,
    });
  }
  if (db.telegramDeliveryIntent?.findFirst) {
    const one = await db.telegramDeliveryIntent.findFirst({ where, orderBy: { confirmedAt: "desc" } });
    return one ? [one] : [];
  }
  return [];
}

async function resolveTelegramCustomThread({ agencyId, accountId, senderTelegramUserId, replyToMessageId = null, eventSentAt = null, db }) {
  const normalizedAccountId = clean(accountId, 180);
  const sender = clean(senderTelegramUserId, 40);
  const replyId = positiveInt(replyToMessageId, true);
  if (!agencyId || !normalizedAccountId || !/^\d{1,20}$/.test(sender)) {
    return { type: "NO_ACTIVE_THREAD", proven: false, conflict: false, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
  }

  // A direct Reply is a historical thread proof. It remains exact even after current
  // creator/account bindings change or the CustomOrder itself becomes terminal.
  if (replyId) {
    const matches = await matchingConfirmedMessageRows({ agencyId, accountId: normalizedAccountId, remoteMessageId: replyId, db });
    if (matches.length > 1) {
      return { type: "DIRECT_REPLY_CONFLICT", proven: true, conflict: true, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
    }
    const intent = matches[0] || null;
    if (!intent) {
      return { type: "DIRECT_REPLY_UNRESOLVED", proven: false, conflict: false, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
    }
    const recipient = clean(intent.remoteRecipientTelegramUserId, 40);
    if (recipient && recipient !== sender) {
      return { type: "DIRECT_REPLY_RECIPIENT_CONFLICT", proven: true, conflict: true, thread: null, threads: [], creatorIds: [String(intent.creatorId)], customOrderIds: [String(intent.customOrderId)] };
    }
    const order = db.customOrder?.findFirst
      ? await db.customOrder.findFirst({ where: { id: String(intent.customOrderId), agencyId }, select: { id: true, creatorId: true, type: true, status: true } })
      : null;
    const thread = publicThread(intent, order, "DIRECT_REPLY");
    return { type: "DIRECT_REPLY", proven: true, conflict: false, thread, threads: [thread], creatorIds: [thread.creatorId], customOrderIds: [thread.customOrderId] };
  }

  // Non-Reply routing is CURRENT business routing. Historical receipts are deliberately
  // excluded. Only provider-confirmed TASK anchors whose CustomOrder is still PENDING can
  // establish an active thread. Manual reconciliation may close a delivery operation, but it
  // is not generic provider proof for future non-Reply observations.
  if (!db.telegramDeliveryIntent?.findMany || !db.customOrder?.findMany) {
    return { type: "NO_ACTIVE_THREAD", proven: false, conflict: false, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
  }
  const taskRows = await db.telegramDeliveryIntent.findMany({
    where: {
      agencyId,
      accountId: normalizedAccountId,
      kind: "TASK",
      state: "CONFIRMED",
      remoteRecipientTelegramUserId: sender,
    },
    select: {
      id: true, agencyId: true, accountId: true, creatorId: true, customOrderId: true,
      remoteMessageId: true, remoteRecipientTelegramUserId: true, remoteSentAt: true, confirmationAuthority: true,
      outcomeReason: true, confirmedAt: true,
    },
    orderBy: [{ confirmedAt: "desc" }, { id: "desc" }],
  });
  const cutoff = eventSentAt == null ? null : new Date(eventSentAt);
  const cutoffMs = cutoff && Number.isFinite(cutoff.getTime()) ? cutoff.getTime() : null;
  const providerTasks = (taskRows || []).filter((row) => {
    if (confirmationAuthority(row) !== "PROVIDER_RECEIPT") return false;
    if (cutoffMs == null) return true;
    const anchorAt = row.remoteSentAt || row.confirmedAt || null;
    const anchorMs = anchorAt ? new Date(anchorAt).getTime() : NaN;
    // A future TASK may never retroactively claim a provider observation that was already sent.
    // Missing historical timestamps are insufficient temporal proof and therefore fail closed.
    return Number.isFinite(anchorMs) && anchorMs <= cutoffMs;
  });
  const orderIds = Array.from(new Set(providerTasks.map((row) => clean(row.customOrderId, 180)).filter(Boolean)));
  if (!orderIds.length) {
    return { type: "NO_ACTIVE_THREAD", proven: false, conflict: false, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
  }
  const orders = await db.customOrder.findMany({
    where: { agencyId, id: { in: orderIds }, status: "PENDING" },
    select: { id: true, creatorId: true, type: true, status: true },
  });
  const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
  const threadByOrder = new Map();
  for (const intent of providerTasks) {
    const order = orderById.get(String(intent.customOrderId));
    if (!order) continue;
    if (String(order.creatorId) !== String(intent.creatorId)) continue;
    const orderId = String(order.id);
    if (!threadByOrder.has(orderId)) threadByOrder.set(orderId, publicThread(intent, order, "ACTIVE_THREAD"));
  }
  const threads = [...threadByOrder.values()];
  const creatorIds = Array.from(new Set(threads.map((row) => row.creatorId)));
  const customOrderIds = threads.map((row) => row.customOrderId);
  if (threads.length === 1) {
    return { type: "UNIQUE_ACTIVE_THREAD", proven: true, conflict: false, thread: threads[0], threads, creatorIds, customOrderIds };
  }
  if (threads.length > 1) {
    return { type: "AMBIGUOUS_ACTIVE_THREADS", proven: true, conflict: true, thread: null, threads, creatorIds, customOrderIds };
  }
  return { type: "NO_ACTIVE_THREAD", proven: false, conflict: false, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
}

function targetAllowedByThreadContext(context, target) {
  if (!context || !target?.id) return false;
  const targetId = String(target.id);
  if (context.type === "DIRECT_REPLY" || context.type === "UNIQUE_ACTIVE_THREAD") {
    return String(context.thread?.customOrderId || "") === targetId;
  }
  if (context.type === "AMBIGUOUS_ACTIVE_THREADS") {
    return (context.threads || []).some((thread) => String(thread.customOrderId) === targetId);
  }
  return false;
}

module.exports = {
  providerMessageEventId,
  resolveTelegramCustomThread,
  targetAllowedByThreadContext,
  confirmationAuthority,
};
