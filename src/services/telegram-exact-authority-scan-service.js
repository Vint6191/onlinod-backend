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
      select: { id: true, creatorId: true, telegramTaskMessageId: true, deliveredAt: true },
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
          select: { id: true, creatorId: true, telegramTaskMessageId: true, deliveredAt: true },
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

async function findCancelledTaskFollowupDebt({ agencyId, creatorIds = null, accountId = null, db, stopAfterFirst = false }) {
  if (!db?.telegramDeliveryIntent?.findMany) return [];
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return [];
  const normalizedAccountId = clean(accountId);
  const found = [];
  const cancellationSatisfiedStates = new Set(["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT", "CONFIRMED"]);

  const evaluateCancelledOrders = async (orders) => {
    const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
    const orderIds = [...orderById.keys()];
    if (!orderIds.length) return false;
    const intents = await db.telegramDeliveryIntent.findMany({
      where: {
        agencyId,
        customOrderId: { in: orderIds },
        kind: { in: ["TASK", "CANCELLATION"] },
        ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      },
      select: { id: true, creatorId: true, customOrderId: true, accountId: true, kind: true, state: true, remoteMessageId: true, remoteRecipientTelegramUserId: true },
    });
    const byOrder = new Map();
    for (const intent of intents || []) {
      const key = String(intent.customOrderId);
      if (!byOrder.has(key)) byOrder.set(key, []);
      byOrder.get(key).push(intent);
    }
    for (const order of orders || []) {
      // A legacy-retirement waiver is an explicit durable statement that no Telegram
      // cancellation was sent because provider capability had already been retired.
      // It is not provider confirmation, but it intentionally satisfies the follow-up
      // obligation so historical debt cannot become an eternal retirement blocker.
      if (order.telegramCancellationWaivedAt) continue;
      const rows = byOrder.get(String(order.id)) || [];
      const confirmedTasks = rows.filter((row) => String(row.kind) === "TASK"
        && String(row.state) === "CONFIRMED"
        && String(row.creatorId) === String(order.creatorId)
        && (!normalizedAccountId || String(row.accountId) === normalizedAccountId));
      for (const task of confirmedTasks) {
        const cancellation = rows.find((row) => String(row.kind) === "CANCELLATION"
          && String(row.creatorId) === String(order.creatorId)
          && String(row.accountId) === String(task.accountId)
          && cancellationSatisfiedStates.has(String(row.state)));
        if (cancellation) continue;
        found.push({ order, task });
        if (stopAfterFirst) return true;
      }
    }
    return false;
  };

  if (db.customOrder?.findMany) {
    await scanAllById({
      delegate: db.customOrder,
      where: {
        agencyId,
        status: "CANCELLED",
        ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      },
      select: { id: true, creatorId: true, telegramTaskMessageId: true, telegramCancellationWaivedAt: true, telegramCancellationWaiverReason: true },
      onPage: evaluateCancelledOrders,
    });
    return found;
  }

  // Narrow injected adapters may only expose exact findFirst. Preserve correctness by draining
  // confirmed TASK history rather than turning an unavailable relational join into a sample.
  if (!db.customOrder?.findFirst || !db.telegramDeliveryIntent?.findFirst) return [];
  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: {
      agencyId,
      kind: "TASK",
      state: "CONFIRMED",
      ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
    },
    select: { id: true, creatorId: true, customOrderId: true, accountId: true, kind: true, state: true, remoteMessageId: true, remoteRecipientTelegramUserId: true },
    onPage: async (tasks) => {
      for (const task of tasks) {
        const order = await db.customOrder.findFirst({
          where: { agencyId, id: String(task.customOrderId), creatorId: String(task.creatorId), status: "CANCELLED" },
          select: { id: true, creatorId: true, telegramTaskMessageId: true, telegramCancellationWaivedAt: true, telegramCancellationWaiverReason: true },
        });
        if (!order || order.telegramCancellationWaivedAt) continue;
        const cancellation = await db.telegramDeliveryIntent.findFirst({
          where: {
            agencyId,
            customOrderId: String(order.id),
            creatorId: String(order.creatorId),
            accountId: String(task.accountId),
            kind: "CANCELLATION",
            state: { in: [...cancellationSatisfiedStates] },
          },
          select: { id: true },
        });
        if (cancellation) continue;
        found.push({ order, task });
        if (stopAfterFirst) return true;
      }
      return false;
    },
  });
  return found;
}

async function findConfirmedTelegramProjectionDebt({ agencyId, creatorIds = null, db, stopAfterFirst = false, onlyUnmarked = false }) {
  if (!db?.telegramDeliveryIntent?.findMany) return [];
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return [];
  const found = [];

  const evaluate = async (intents) => {
    const rows = Array.isArray(intents) ? intents : [];
    const orderIds = unique(rows.map((row) => row.customOrderId));
    if (!orderIds.length) return false;

    let orders = [];
    if (db.customOrder?.findMany) {
      orders = await db.customOrder.findMany({
        where: { agencyId, id: { in: orderIds } },
        select: {
          id: true, creatorId: true, telegramTaskMessageId: true, deliveredAt: true,
          telegramReferenceMessageIds: true, lastReminderAt: true,
        },
      });
    } else if (db.customOrder?.findFirst) {
      for (const orderId of orderIds) {
        const order = await db.customOrder.findFirst({
          where: { agencyId, id: orderId },
          select: {
            id: true, creatorId: true, telegramTaskMessageId: true, deliveredAt: true,
            telegramReferenceMessageIds: true, lastReminderAt: true,
          },
        });
        if (order) orders.push(order);
      }
    }
    const orderById = new Map((orders || []).map((order) => [String(order.id), order]));

    for (const row of rows) {
      if (onlyUnmarked && row.projectionBlockedAt) continue;
      const order = orderById.get(String(row.customOrderId));
      // Historical hard-delete orphans deliberately preserve provider proof but have no
      // recoverable business projection target. They are not retirement debt for a live row.
      if (!order) continue;
      let reason = null;
      if (String(order.creatorId) !== String(row.creatorId)) {
        reason = "BUSINESS_TARGET_MISMATCH";
      } else if (String(row.kind) === "TASK") {
        const projected = order.telegramTaskMessageId == null ? null : Number(order.telegramTaskMessageId);
        if (projected !== Number(row.remoteMessageId) || !order.deliveredAt) reason = "TASK_PROJECTION_DEBT";
      } else if (String(row.kind) === "REFERENCE") {
        const projected = new Set((Array.isArray(order.telegramReferenceMessageIds) ? order.telegramReferenceMessageIds : []).map(Number));
        if (!projected.has(Number(row.remoteMessageId))) reason = "REFERENCE_PROJECTION_DEBT";
      } else if (["MANUAL_REMINDER", "AUTO_REMINDER"].includes(String(row.kind))) {
        const effectAt = row.remoteSentAt ? new Date(row.remoteSentAt) : (row.confirmedAt ? new Date(row.confirmedAt) : null);
        const projectedAt = order.lastReminderAt ? new Date(order.lastReminderAt) : null;
        if (!effectAt || !Number.isFinite(effectAt.getTime()) || !projectedAt || !Number.isFinite(projectedAt.getTime()) || projectedAt.getTime() < effectAt.getTime()) {
          reason = "REMINDER_PROJECTION_DEBT";
        }
      }
      if (!reason) continue;
      found.push({ intent: row, order, reason });
      if (stopAfterFirst) return true;
    }
    return false;
  };

  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: {
      agencyId,
      state: "CONFIRMED",
      kind: { in: ["TASK", "REFERENCE", "MANUAL_REMINDER", "AUTO_REMINDER"] },
      remoteMessageId: { not: null },
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
    },
    select: {
      id: true, creatorId: true, customOrderId: true, kind: true, remoteMessageId: true,
      remoteSentAt: true, confirmedAt: true, projectionBlockedAt: true,
    },
    onPage: evaluate,
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
    select: { id: true, creatorId: true, telegramSourceAccountId: true, telegramSourceUserId: true, telegramMessageIds: true, ofMediaIds: true, pipelineDisposition: true },
    onPage: async (rows) => {
      for (const row of rows) {
        // Telegram source capability is only required while this submission is allowed to
        // create NEW source -> OF relay work. SALVAGE deliberately forbids new relay writes:
        // already-confirmed OF media may still converge through Vault/finalization, but that
        // stage no longer needs MTProto. ARCHIVED/ABANDONED are terminal. Treat missing
        // disposition as ACTIVE for rolling-version/test compatibility.
        const sourceExecutionDisposition = String(row.pipelineDisposition || "ACTIVE").toUpperCase();
        if (sourceExecutionDisposition !== "ACTIVE") continue;
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
      state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"] },
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
  findCancelledTaskFollowupDebt,
  findConfirmedTelegramProjectionDebt,
  scanIncompleteTelegramSources,
  scanActiveFollowupIntents,
  fetchAccountRowsByIds,
};
