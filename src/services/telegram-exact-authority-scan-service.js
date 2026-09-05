"use strict";

const DEFAULT_PAGE_SIZE = 250;
const ACCOUNT_BATCH_SIZE = 250;

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => clean(value)).filter(Boolean)));
}

function chunks(values, size = ACCOUNT_BATCH_SIZE) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

async function scanAllById({ delegate, where, select, pageSize = DEFAULT_PAGE_SIZE, onPage }) {
  if (!delegate?.findMany) return;
  let cursorId = null;
  for (;;) {
    const page = await delegate.findMany({
      where,
      select,
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    const rows = Array.isArray(page) ? page : [];
    if (!rows.length) return;
    const shouldStop = await onPage(rows);
    if (shouldStop === true) return;
    if (rows.length < pageSize) return;
    const nextCursor = clean(rows[rows.length - 1]?.id);
    if (!nextCursor || nextCursor === cursorId) {
      throw Object.assign(new Error("Exact authority pagination did not advance"), { code: "TELEGRAM_EXACT_AUTHORITY_SCAN_STALLED", status: 503 });
    }
    cursorId = nextCursor;
  }
}

async function findPendingTaskAnchors({ agencyId, creatorIds = null, accountId = null, db, stopAfterFirst = false }) {
  if (!db?.telegramDeliveryIntent?.findMany) return [];
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return [];
  const normalizedAccountId = clean(accountId);
  const found = [];

  const consumePendingOrders = async (orders) => {
    const pendingById = new Map((orders || []).map((row) => [String(row.id), row]));
    const orderIds = [...pendingById.keys()];
    if (!orderIds.length) return false;
    const intents = await db.telegramDeliveryIntent.findMany({
      where: {
        agencyId,
        kind: "TASK",
        state: "CONFIRMED",
        customOrderId: { in: orderIds },
        ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
        ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      },
      select: {
        id: true,
        creatorId: true,
        customOrderId: true,
        accountId: true,
        remoteMessageId: true,
        remoteRecipientTelegramUserId: true,
        confirmationAuthority: true,
      },
    });
    for (const intent of intents || []) {
      const order = pendingById.get(String(intent.customOrderId));
      if (!order || String(order.creatorId) !== String(intent.creatorId)) continue;
      found.push({ ...intent, order });
      if (stopAfterFirst) return true;
    }
    return false;
  };

  if (db.customOrder?.findMany) {
    await scanAllById({
      delegate: db.customOrder,
      where: {
        agencyId,
        status: "PENDING",
        ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      },
      select: { id: true, creatorId: true },
      onPage: consumePendingOrders,
    });
    return found;
  }

  // Compatibility for narrow injected test adapters. This fallback remains exact: it drains the
  // confirmed TASK history to exhaustion and checks every referenced order instead of sampling N.
  if (!db.customOrder?.findFirst) return [];
  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: {
      agencyId,
      kind: "TASK",
      state: "CONFIRMED",
      ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
    },
    select: { id: true, creatorId: true, customOrderId: true, accountId: true, remoteMessageId: true, remoteRecipientTelegramUserId: true, confirmationAuthority: true },
    onPage: async (intents) => {
      for (const intent of intents) {
        const order = await db.customOrder.findFirst({
          where: { agencyId, id: String(intent.customOrderId), status: "PENDING", creatorId: String(intent.creatorId) },
          select: { id: true, creatorId: true },
        });
        if (!order) continue;
        found.push({ ...intent, order });
        if (stopAfterFirst) return true;
      }
      return false;
    },
  });
  return found;
}

async function scanIncompleteTelegramSources({ agencyId, creatorIds, accountId = null, requireSourceUser = true, db, onRow }) {
  if (!db?.customContentSubmission?.findMany) return;
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return;
  const normalizedAccountId = clean(accountId);
  await scanAllById({
    delegate: db.customContentSubmission,
    where: {
      agencyId,
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      telegramSourceAccountId: normalizedAccountId || { not: null },
      ...(requireSourceUser ? { telegramSourceUserId: { not: null } } : {}),
    },
    select: { id: true, creatorId: true, telegramSourceAccountId: true, telegramSourceUserId: true, telegramMessageIds: true, ofMediaIds: true },
    onPage: async (rows) => {
      for (const row of rows) {
        const sourceCount = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.length : 0;
        const mediaCount = Array.isArray(row.ofMediaIds) ? row.ofMediaIds.length : 0;
        if (!sourceCount || mediaCount >= sourceCount) continue;
        if (await onRow(row) === true) return true;
      }
      return false;
    },
  });
}

async function scanActiveFollowupIntents({ agencyId, creatorIds, db, onRow }) {
  if (!db?.telegramDeliveryIntent?.findMany) return;
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return;
  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: {
      agencyId,
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      kind: { in: ["REFERENCE", "MANUAL_REMINDER", "AUTO_REMINDER", "CANCELLATION"] },
      state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED"] },
    },
    select: { id: true, creatorId: true, accountId: true },
    onPage: async (rows) => {
      for (const row of rows) if (await onRow(row) === true) return true;
      return false;
    },
  });
}

async function fetchAccountRowsByIds({ agencyId, accountIds, db }) {
  const ids = unique(accountIds);
  if (!ids.length || !db?.agencyTelegramMtprotoAccount?.findMany) return [];
  const rows = [];
  for (const batch of chunks(ids)) {
    const found = await db.agencyTelegramMtprotoAccount.findMany({
      where: { agencyId, id: { in: batch } },
      select: { id: true, lifecycleState: true },
    });
    rows.push(...(found || []));
  }
  return rows;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  scanAllById,
  findPendingTaskAnchors,
  scanIncompleteTelegramSources,
  scanActiveFollowupIntents,
  fetchAccountRowsByIds,
};
