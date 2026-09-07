"use strict";

const { deriveCustomModelObligation } = require("./custom-model-obligation-authority-service");
const { classifyCancellationInstructionFacts, deriveCustomCancellationInstruction } = require("./custom-cancellation-instruction-authority-service");

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

async function findPendingModelInstructionAnchors({ agencyId, creatorIds = null, accountId = null, db, stopAfterFirst = false }) {
  if (!db?.telegramDeliveryIntent?.findMany) return [];
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return [];
  const normalizedAccountId = clean(accountId);
  const found = [];

  const consumePendingOrders = async (orders) => {
    const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
    const orderIds = [...orderById.keys()];
    if (!orderIds.length) return false;
    const intents = await db.telegramDeliveryIntent.findMany({
      where: {
        agencyId,
        kind: { in: ["TASK", "REVISION_REQUEST"] },
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
        kind: true,
        state: true,
        remoteMessageId: true,
        remoteRecipientTelegramUserId: true,
        remoteSentAt: true,
        confirmedAt: true,
        confirmationAuthority: true,
        outcomeReason: true,
      },
    });
    const intentById = new Map((intents || []).map((row) => [String(row.id), row]));
    for (const order of orders || []) {
      const obligation = await deriveCustomModelObligation({ agencyId, order, db });
      if (!obligation?.modelOwesResponse || !obligation.currentInstruction) continue;
      const instruction = obligation.currentInstruction;
      if (!["TASK", "REVISION_REQUEST"].includes(String(instruction.kind || ""))) continue;
      if (normalizedAccountId && String(instruction.accountId || "") !== normalizedAccountId) continue;
      const intent = intentById.get(String(instruction.intentId || ""));
      if (!intent) continue;
      if (String(order.creatorId) !== String(intent.creatorId)) continue;
      found.push({ ...intent, order, obligationState: String(obligation.state || "") });
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
      select: { id: true, creatorId: true, type: true, status: true, telegramTaskMessageId: true, deliveredAt: true, updatedAt: true },
      onPage: consumePendingOrders,
    });
    return found;
  }

  // Compatibility for narrow injected adapters. The production path above is obligation-aware.
  // Without relational order scans we can still preserve the historical TASK-only exact fallback
  // rather than silently sampling confirmed history.
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
    select: { id: true, creatorId: true, customOrderId: true, accountId: true, kind: true, state: true, remoteMessageId: true, remoteRecipientTelegramUserId: true, remoteSentAt: true, confirmedAt: true, confirmationAuthority: true, outcomeReason: true },
    onPage: async (intents) => {
      for (const intent of intents) {
        const order = await db.customOrder.findFirst({
          where: { agencyId, id: String(intent.customOrderId), status: "PENDING", creatorId: String(intent.creatorId) },
          select: { id: true, creatorId: true, type: true, status: true, telegramTaskMessageId: true, deliveredAt: true, updatedAt: true },
        });
        if (!order) continue;
        found.push({ ...intent, order, obligationState: "LEGACY_TASK_FALLBACK" });
        if (stopAfterFirst) return true;
      }
      return false;
    },
  });
  return found;
}

// Backward-compatible export name for older callers/tests. New production code should use the
// model-instruction name so TASK is not treated as the only live provider instruction.
const findPendingTaskAnchors = findPendingModelInstructionAnchors;

async function findCancelledModelInstructionFollowupDebt({ agencyId, creatorIds = null, accountId = null, db, stopAfterFirst = false }) {
  if (!db?.telegramDeliveryIntent?.findMany) return [];
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return [];
  const normalizedAccountId = clean(accountId);
  const found = [];
  const cancellationSatisfiedStates = new Set(["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT", "CONFIRMED"]);

  const time = (value) => {
    if (!value) return Number.NEGATIVE_INFINITY;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.getTime() : Number.NEGATIVE_INFINITY;
  };
  const newest = (rows, primary, secondary = "createdAt") => (rows || []).slice().sort((a, b) => {
    const primaryDiff = time(b?.[primary]) - time(a?.[primary]);
    if (primaryDiff) return primaryDiff;
    const secondaryDiff = time(b?.[secondary]) - time(a?.[secondary]);
    if (secondaryDiff) return secondaryDiff;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  })[0] || null;

  const evaluateCancelledOrders = async (orders) => {
    const orderById = new Map((orders || []).map((row) => [String(row.id), row]));
    const orderIds = [...orderById.keys()];
    if (!orderIds.length) return false;
    const intents = await db.telegramDeliveryIntent.findMany({
      where: {
        agencyId,
        customOrderId: { in: orderIds },
        kind: { in: ["TASK", "REVISION_REQUEST", "CANCELLATION"] },
        ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      },
      select: {
        id: true, creatorId: true, customOrderId: true, customSubmissionId: true, accountId: true,
        kind: true, state: true, remoteMessageId: true, remoteRecipientTelegramUserId: true,
        remoteSentAt: true, confirmedAt: true, createdAt: true,
      },
    });
    const submissions = db.customContentSubmission?.findMany
      ? await db.customContentSubmission.findMany({
          where: { agencyId, customOrderId: { in: orderIds }, ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}) },
          select: { id: true, creatorId: true, customOrderId: true, reviewStatus: true, receivedAt: true, createdAt: true },
        })
      : [];
    const intentsByOrder = new Map();
    for (const intent of intents || []) {
      const key = String(intent.customOrderId);
      if (!intentsByOrder.has(key)) intentsByOrder.set(key, []);
      intentsByOrder.get(key).push(intent);
    }
    const submissionsByOrder = new Map();
    for (const submission of submissions || []) {
      const key = String(submission.customOrderId);
      if (!submissionsByOrder.has(key)) submissionsByOrder.set(key, []);
      submissionsByOrder.get(key).push(submission);
    }

    for (const order of orders || []) {
      if (order.telegramCancellationWaivedAt) continue;
      const rows = intentsByOrder.get(String(order.id)) || [];
      const submission = newest(submissionsByOrder.get(String(order.id)) || [], "receivedAt");
      const revision = submission
        ? newest(rows.filter((row) => String(row.kind) === "REVISION_REQUEST" && String(row.customSubmissionId || "") === String(submission.id)), "createdAt")
        : null;
      const task = newest(rows.filter((row) => String(row.kind) === "TASK" && String(row.state) === "CONFIRMED"), "confirmedAt");
      const decision = classifyCancellationInstructionFacts({ submission, revision, task });
      const instruction = decision.instruction || null;
      const instructionAccountId = decision.anchor?.accountId || clean(instruction?.accountId);
      if (normalizedAccountId && instructionAccountId !== normalizedAccountId) continue;

      if (decision.state === "REVISION_OUTCOME_UNRESOLVED") {
        found.push({ order, instruction, unresolved: true, instructionState: String(instruction?.state || "") });
        if (stopAfterFirst) return true;
        continue;
      }
      if (!decision.anchor || !instruction) continue;

      const cancellation = rows.find((row) => String(row.kind) === "CANCELLATION"
        && String(row.creatorId) === String(order.creatorId)
        && String(row.accountId) === String(decision.anchor.accountId)
        && cancellationSatisfiedStates.has(String(row.state)));
      if (cancellation) continue;
      found.push({
        order,
        instruction,
        task: String(instruction.kind) === "TASK" ? instruction : null,
        anchorKind: String(decision.anchor.anchorKind),
        unresolved: false,
      });
      if (stopAfterFirst) return true;
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
      select: { id: true, creatorId: true, type: true, telegramTaskMessageId: true, telegramCancellationWaivedAt: true, telegramCancellationWaiverReason: true },
      onPage: evaluateCancelledOrders,
    });
    return found;
  }

  // Compatibility for narrow adapters: drain model-instruction history, then derive the same
  // cancellation authority per exact terminal order instead of silently falling back to TASK-only.
  if (!db.customOrder?.findFirst || !db.telegramDeliveryIntent?.findFirst) return [];
  const seenOrders = new Set();
  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: {
      agencyId,
      kind: { in: ["TASK", "REVISION_REQUEST"] },
      ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
    },
    select: { id: true, creatorId: true, customOrderId: true, accountId: true, kind: true, state: true },
    onPage: async (instructions) => {
      for (const candidate of instructions) {
        const key = String(candidate.customOrderId);
        if (seenOrders.has(key)) continue;
        seenOrders.add(key);
        const order = await db.customOrder.findFirst({
          where: { agencyId, id: key, creatorId: String(candidate.creatorId), status: "CANCELLED" },
          select: { id: true, creatorId: true, type: true, telegramTaskMessageId: true, telegramCancellationWaivedAt: true, telegramCancellationWaiverReason: true },
        });
        if (!order || order.telegramCancellationWaivedAt) continue;
        const decision = await deriveCustomCancellationInstruction({ agencyId, order, db });
        const instruction = decision.instruction || null;
        const instructionAccountId = decision.anchor?.accountId || clean(instruction?.accountId);
        if (normalizedAccountId && instructionAccountId !== normalizedAccountId) continue;
        if (decision.state === "REVISION_OUTCOME_UNRESOLVED") {
          found.push({ order, instruction, unresolved: true, instructionState: String(instruction?.state || "") });
          if (stopAfterFirst) return true;
          continue;
        }
        if (!decision.anchor || !instruction) continue;
        const cancellation = await db.telegramDeliveryIntent.findFirst({
          where: {
            agencyId,
            customOrderId: String(order.id),
            creatorId: String(order.creatorId),
            accountId: String(decision.anchor.accountId),
            kind: "CANCELLATION",
            state: { in: [...cancellationSatisfiedStates] },
          },
          select: { id: true },
        });
        if (cancellation) continue;
        found.push({ order, instruction, task: String(instruction.kind) === "TASK" ? instruction : null, anchorKind: String(decision.anchor.anchorKind), unresolved: false });
        if (stopAfterFirst) return true;
      }
      return false;
    },
  });
  return found;
}

// Backward-compatible name for older adapters. Production callers use model-instruction wording.
const findCancelledTaskFollowupDebt = findCancelledModelInstructionFollowupDebt;

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
  findPendingModelInstructionAnchors,
  findPendingTaskAnchors,
  findCancelledModelInstructionFollowupDebt,
  findCancelledTaskFollowupDebt,
  findConfirmedTelegramProjectionDebt,
  scanIncompleteTelegramSources,
  scanActiveFollowupIntents,
  fetchAccountRowsByIds,
};
