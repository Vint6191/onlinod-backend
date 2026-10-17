"use strict";

const crypto = require("node:crypto");
const { deriveCustomModelObligation } = require("./custom-model-obligation-authority-service");
const CURRENT_THREAD_PAGE_SIZE = 100;

// Discovery starts with the indexed CURRENT order set, never with a sender's
// lifetime provider history. EXISTS uses the exact order/account/sender index;
// pagination bounds each read without losing ambiguous active candidates.
const CURRENT_THREAD_ORDER_PAGE_SQL = `/* custom_telegram_current_order_page */
  SELECT o."id", o."creatorId", o."type", o."status"
  FROM "CustomOrder" o
  WHERE o."agencyId"=$1 AND o."status"='PENDING' AND o."id">$4
    AND EXISTS (
      SELECT 1 FROM "TelegramDeliveryIntent" i
      WHERE i."agencyId"=o."agencyId" AND i."customOrderId"=o."id"
        AND i."accountId"=$2 AND i."remoteRecipientTelegramUserId"=$3
        AND i."state"='CONFIRMED' AND i."kind" IN ('TASK','REVISION_REQUEST')
    )
  ORDER BY o."id" LIMIT $5`;

async function currentOrderPage({ agencyId, accountId, sender, afterId, db }) {
  if (typeof db.$queryRawUnsafe === "function") {
    return db.$queryRawUnsafe(CURRENT_THREAD_ORDER_PAGE_SQL, agencyId, accountId, sender, afterId, CURRENT_THREAD_PAGE_SIZE);
  }
  // Delegate-only adapters use the same current-state boundary. Production
  // Prisma uses the indexed EXISTS above, which avoids unrelated active orders.
  return db.customOrder.findMany({
    where: { agencyId, status: "PENDING", id: { gt: afterId } },
    select: { id: true, creatorId: true, type: true, status: true },
    orderBy: { id: "asc" }, take: CURRENT_THREAD_PAGE_SIZE,
  });
}

function isCurrentProviderInstruction(row, { agencyId, accountId, sender, order, cutoffMs }) {
  if (!row || String(row.agencyId) !== agencyId || String(row.customOrderId) !== String(order.id)
      || String(row.creatorId) !== String(order.creatorId) || String(row.accountId) !== accountId
      || String(row.remoteRecipientTelegramUserId) !== sender || String(row.state) !== "CONFIRMED"
      || !["TASK", "REVISION_REQUEST"].includes(String(row.kind)) || confirmationAuthority(row) !== "PROVIDER_RECEIPT") return false;
  if (cutoffMs == null) return true;
  const anchorMs = new Date(row.remoteSentAt || row.confirmedAt || NaN).getTime();
  return Number.isFinite(anchorMs) && anchorMs <= cutoffMs;
}

async function confirmedTaskForCurrentOrder({ agencyId, accountId, sender, order, cutoffMs, db }) {
  if (typeof db.$queryRawUnsafe === "function") {
    const rows = await db.$queryRawUnsafe(`/* custom_telegram_current_task */
      SELECT i."id", i."agencyId", i."accountId", i."creatorId", i."customOrderId", i."kind", i."state",
        i."remoteMessageId", i."remoteRecipientTelegramUserId", i."remoteSentAt", i."confirmationAuthority", i."outcomeReason", i."confirmedAt"
      FROM "TelegramDeliveryIntent" i
      WHERE i."agencyId"=$1 AND i."customOrderId"=$2 AND i."accountId"=$3
        AND i."remoteRecipientTelegramUserId"=$4 AND i."state"='CONFIRMED' AND i."kind"='TASK'
        AND COALESCE(NULLIF(upper(btrim(i."confirmationAuthority")),''),
          CASE WHEN upper(btrim(COALESCE(i."outcomeReason",''))) LIKE 'MANUAL_CONFIRMED:%' THEN 'MANUAL_RECONCILIATION' ELSE 'PROVIDER_RECEIPT' END)='PROVIDER_RECEIPT'
        AND ($5::timestamp IS NULL OR COALESCE(i."remoteSentAt",i."confirmedAt") <= $5::timestamp)
      ORDER BY i."confirmedAt" DESC, i."id" DESC LIMIT 1`,
    agencyId, String(order.id), accountId, sender, cutoffMs == null ? null : new Date(cutoffMs));
    return rows[0] || null;
  }
  // Legacy adapters may contain more than one historical TASK for an order.
  // Keep exact temporal/provenance eligibility, without an arbitrary recent-N
  // correctness cutoff or an unbounded materialized result.
  let cursor = null;
  for (;;) {
    const rows = await db.telegramDeliveryIntent.findMany({
      where: { agencyId, customOrderId: String(order.id), accountId, remoteRecipientTelegramUserId: sender, kind: "TASK", state: "CONFIRMED" },
      orderBy: [{ confirmedAt: "desc" }, { id: "desc" }], take: CURRENT_THREAD_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const matching = rows.find(row => isCurrentProviderInstruction(row, { agencyId, accountId, sender, order, cutoffMs }));
    if (matching) return matching;
    if (rows.length < CURRENT_THREAD_PAGE_SIZE) return null;
    const next = clean(rows[rows.length - 1]?.id);
    if (!next || next === cursor) throw Object.assign(new Error("Current Telegram TASK pagination did not advance"), { code: "TELEGRAM_THREAD_SCAN_STALLED", status: 503 });
    cursor = next;
  }
}

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
  // excluded. The current provider-confirmed model instruction (TASK or REVISION_REQUEST)
  // owns the active thread; old satisfied instructions must never keep claiming future media.
  // Manual reconciliation may close a delivery operation, but it is not generic provider
  // proof for future non-Reply observations.
  if (!db.telegramDeliveryIntent?.findMany || !db.customOrder?.findMany) {
    return { type: "NO_ACTIVE_THREAD", proven: false, conflict: false, thread: null, threads: [], creatorIds: [], customOrderIds: [] };
  }
  const cutoff = eventSentAt == null ? null : new Date(eventSentAt);
  const cutoffMs = cutoff && Number.isFinite(cutoff.getTime()) ? cutoff.getTime() : null;
  const threadByOrder = new Map();
  let afterId = "";
  for (;;) {
    const orders = await currentOrderPage({ agencyId, accountId: normalizedAccountId, sender, afterId, db });
    for (const order of orders || []) {
      const orderId = String(order.id);
      const obligation = await deriveCustomModelObligation({ agencyId, order, db });
      let intent = null;
      if (obligation?.modelOwesResponse && obligation.currentInstruction) {
        const current = obligation.currentInstruction;
        if (["TASK", "REVISION_REQUEST"].includes(String(current.kind || ""))
            && String(current.accountId || "") === normalizedAccountId
            && String(current.recipientTelegramUserId || "") === sender) {
          const currentIntent = await db.telegramDeliveryIntent.findFirst({ where: { id: String(current.intentId || ""), agencyId, customOrderId: orderId } });
          if (isCurrentProviderInstruction(currentIntent, { agencyId, accountId: normalizedAccountId, sender, order, cutoffMs })) intent = currentIntent;
        }
      }
      // A confirmed TASK remains exact business-context proof even while a later revision is
      // pending/unknown or an observed media predates the revision receipt. It may identify the
      // CustomOrder, but it does NOT grant revision-response causality: the submission authority
      // still requires the current confirmed revision instruction and will surface REVIEW_REQUIRED.
      if (!intent) intent = await confirmedTaskForCurrentOrder({ agencyId, accountId: normalizedAccountId, sender, order, cutoffMs, db });
      if (!intent || String(order.creatorId) !== String(intent.creatorId)) continue;
      if (!threadByOrder.has(orderId)) threadByOrder.set(orderId, publicThread(intent, order, "ACTIVE_THREAD"));
    }
    if (orders.length < CURRENT_THREAD_PAGE_SIZE) break;
    const next = clean(orders[orders.length - 1]?.id);
    if (!next || next <= afterId) throw Object.assign(new Error("Current Telegram order pagination did not advance"), { code: "TELEGRAM_THREAD_SCAN_STALLED", status: 503 });
    afterId = next;
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
  CURRENT_THREAD_PAGE_SIZE,
  CURRENT_THREAD_ORDER_PAGE_SQL,
  providerMessageEventId,
  resolveTelegramCustomThread,
  targetAllowedByThreadContext,
  confirmationAuthority,
};
