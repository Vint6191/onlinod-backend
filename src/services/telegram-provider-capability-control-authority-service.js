"use strict";

const { findCustomProviderThreadRetentionBlockerForOrder } = require("./custom-provider-thread-retention-authority-service");
const { deriveCustomCancellationInstruction } = require("./custom-cancellation-instruction-authority-service");
const {
  DEBT,
  requireProviderOperationalBackfillReady,
  dirtyOrderIdsForAccount,
  findStandaloneIncompleteSource,
  listProviderOperationalDebtForAccount,
} = require("./provider-operational-debt-authority-service");

const MAX_SYNC_DIRTY_RECONCILE = 100;
const MAX_DEBT_REVALIDATION = 200;

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function blockerError(blocker) {
  const error = new Error(blocker?.message || "Telegram connection is still required by current provider capability debt");
  error.code = "SETTINGS_TELEGRAM_ACCOUNT_IN_USE";
  error.status = 409;
  error.providerCapabilityBlocker = blocker || null;
  error.retentionReason = blocker?.reason || null;
  return error;
}

function maintenancePendingError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

async function findHardPinnedIntentBlocker({ agencyId, accountId, db }) {
  if (!db?.telegramDeliveryIntent?.findFirst) return null;
  const row = await db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId,
      accountId: String(accountId),
      OR: [
        { state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] } },
        { kind: "CANCELLATION", state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] }, commitStartedAt: null },
      ],
    },
    select: { id: true, kind: true, state: true, customOrderId: true, customSubmissionId: true, commitStartedAt: true },
  });
  if (!row) return null;
  return {
    class: ["COMMITTING", "RECONCILE_REQUIRED"].includes(String(row.state)) ? "UNKNOWN_EXTERNAL_OUTCOME" : "PINNED_CANCELLATION_FOLLOWUP",
    reason: ["COMMITTING", "RECONCILE_REQUIRED"].includes(String(row.state)) ? "EXTERNAL_OUTCOME_ACCOUNT_PINNED" : "CANCELLATION_FOLLOWUP_ACCOUNT_PINNED",
    intentId: String(row.id),
    kind: String(row.kind),
    state: String(row.state),
    orderId: row.customOrderId ? String(row.customOrderId) : null,
    submissionId: row.customSubmissionId ? String(row.customSubmissionId) : null,
    message: "Telegram connection is still required by an active or unresolved Custom delivery",
  };
}

async function assertAccountDirtyWorkDrained({ agencyId, accountId, db }) {
  const ids = await dirtyOrderIdsForAccount({ agencyId, accountId, db, limit: MAX_SYNC_DIRTY_RECONCILE + 1 });
  if (ids.length) {
    const error = maintenancePendingError(
      "PROVIDER_OPERATIONAL_DEBT_RECONCILE_PENDING",
      "Provider current-work reconciliation is still draining; retry account retirement after maintenance catches up",
    );
    error.pendingOrderIds = ids.slice(0, MAX_SYNC_DIRTY_RECONCILE);
    error.pendingCountLowerBound = ids.length;
    throw error;
  }
}

async function exactCancellationFollowupBlocker({ agencyId, accountId, orderId, db }) {
  const order = await db?.customOrder?.findFirst?.({ where: { agencyId, id: String(orderId), status: "CANCELLED" } });
  if (!order || order.telegramCancellationWaivedAt) return null;
  const decision = await deriveCustomCancellationInstruction({ agencyId, order, db });
  const instruction = decision?.instruction || null;
  const anchorAccountId = decision?.anchor?.accountId || instruction?.accountId || null;
  if (!instruction || String(anchorAccountId || "") !== String(accountId)) return null;
  if (String(decision.state || "") === "REVISION_OUTCOME_UNRESOLVED") {
    return {
      class: "CANCELLATION_FOLLOWUP_DEBT",
      reason: "REVISION_PROVIDER_OUTCOME_UNRESOLVED",
      orderId: String(order.id), intentId: String(instruction.id), state: String(instruction.state || ""),
      message: "Telegram connection still owns an unresolved model instruction required by cancellation follow-up",
    };
  }
  const cancellation = await db.telegramDeliveryIntent?.findFirst?.({
    where: {
      agencyId, customOrderId: String(order.id), creatorId: String(order.creatorId), accountId: String(accountId), kind: "CANCELLATION",
      state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT", "CONFIRMED"] },
    },
    select: { id: true },
  });
  if (cancellation) return null;
  return {
    class: "CANCELLATION_FOLLOWUP_DEBT",
    reason: "CANCELLATION_FOLLOWUP_REQUIRED",
    orderId: String(order.id), intentId: String(instruction.id),
    message: "Telegram connection still owns a confirmed model instruction whose cancellation follow-up has not been durably planned or confirmed",
  };
}

async function exactIncompleteSourceBlocker({ agencyId, accountId, submissionId, db }) {
  const row = await db?.customContentSubmission?.findFirst?.({ where: { agencyId, id: String(submissionId), telegramSourceAccountId: String(accountId) } });
  if (!row || String(row.pipelineDisposition || "ACTIVE").toUpperCase() !== "ACTIVE") return null;
  const sourceCount = Array.isArray(row.telegramMessageIds) ? row.telegramMessageIds.length : 0;
  const mediaCount = Array.isArray(row.ofMediaIds) ? row.ofMediaIds.length : 0;
  if (!sourceCount || mediaCount >= sourceCount) return null;
  return {
    class: "INBOUND_SOURCE_DEBT",
    reason: "INCOMPLETE_CUSTOM_SOURCE_MEDIA",
    submissionId: String(row.id),
    message: "Telegram connection is still required by pending Custom source media",
  };
}

async function revalidateDebtRow({ agencyId, accountId, row, db }) {
  switch (String(row?.debtClass || "")) {
    case DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY: {
      const blocker = await findCustomProviderThreadRetentionBlockerForOrder({ agencyId, accountId, orderId: row.customOrderId || row.objectId, db });
      return blocker ? {
        class: "CURRENT_PROVIDER_CAPABILITY",
        reason: blocker.reason || "CURRENT_PROVIDER_CAPABILITY",
        ...blocker,
        message: "Telegram connection is still required by an active Custom provider-thread capability",
      } : null;
    }
    case DEBT.CANCELLATION_FOLLOWUP_DEBT:
      return exactCancellationFollowupBlocker({ agencyId, accountId, orderId: row.customOrderId || row.objectId, db });
    case DEBT.INCOMPLETE_SOURCE_RELAY:
      return exactIncompleteSourceBlocker({ agencyId, accountId, submissionId: row.customSubmissionId || row.objectId, db });
    default:
      // CONFIRMED projection repair and provider-binding retry are executable maintenance,
      // but they do not require keeping the MTProto account alive once canonical provider
      // receipt/current binding can be revalidated independently.
      return null;
  }
}

async function findTelegramProviderCapabilityBlocker({ agencyId, accountId, db }) {
  const target = clean(accountId);
  if (!agencyId || !target || !db) return null;

  // Hard commit-boundary states are already an indexed current canonical query. Keep this
  // direct check before the derived workset so an unresolved external effect never depends on
  // projection freshness.
  const hardIntent = await findHardPinnedIntentBlocker({ agencyId, accountId: target, db });
  if (hardIntent) return hardIntent;

  if (!db.providerOperationalDebt || !db.phase2WorkCoverage) {
    throw maintenancePendingError("PROVIDER_OPERATIONAL_DEBT_STORAGE_UNAVAILABLE", "Provider operational current-work authority is unavailable");
  }
  await requireProviderOperationalBackfillReady({ db, agencyId });
  await assertAccountDirtyWorkDrained({ agencyId, accountId: target, db });

  const debtRows = await listProviderOperationalDebtForAccount({
    agencyId, accountId: target, db, limit: MAX_DEBT_REVALIDATION + 1,
    debtClasses: [DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY, DEBT.CANCELLATION_FOLLOWUP_DEBT, DEBT.INCOMPLETE_SOURCE_RELAY],
  });
  for (const row of debtRows.slice(0, MAX_DEBT_REVALIDATION)) {
    const blocker = await revalidateDebtRow({ agencyId, accountId: target, row, db });
    if (blocker) return blocker;
  }
  if (debtRows.length > MAX_DEBT_REVALIDATION) {
    throw maintenancePendingError("PROVIDER_OPERATIONAL_DEBT_REVALIDATION_PENDING", "Provider current-work revalidation is still draining; retry account retirement");
  }

  // Standalone submissions are legal before assignment and therefore have no CustomOrder dirty
  // locator. This is still a bounded CURRENT-state query (ACTIVE + exact account + array debt),
  // not a cursor walk over completed submission history.
  const pendingSource = await findStandaloneIncompleteSource({ agencyId, accountId: target, db });
  if (pendingSource) {
    return {
      class: "INBOUND_SOURCE_DEBT",
      reason: "INCOMPLETE_CUSTOM_SOURCE_MEDIA",
      submissionId: String(pendingSource.id),
      message: "Telegram connection is still required by pending Custom source media",
    };
  }

  if (db.telegramInboundEvent?.findFirst) {
    const unresolvedInbound = await db.telegramInboundEvent.findFirst({
      where: { agencyId, accountId: target, hasMedia: true, submissionId: null, projectionState: { in: ["PENDING", "FAILED_RETRYABLE", "REVIEW_REQUIRED"] } },
      select: { id: true, projectionState: true },
    });
    if (unresolvedInbound) {
      return {
        class: "INBOUND_SOURCE_DEBT",
        reason: "UNRESOLVED_INBOUND_PROVIDER_SOURCE",
        inboundEventId: String(unresolvedInbound.id),
        projectionState: String(unresolvedInbound.projectionState || ""),
        message: "Telegram connection is still required by an unresolved inbound provider source",
      };
    }
  }
  return null;
}

async function assertTelegramProviderCapabilityCanRetire({ agencyId, accountId, db }) {
  const blocker = await findTelegramProviderCapabilityBlocker({ agencyId, accountId, db });
  if (blocker) throw blockerError(blocker);
  return { ok: true, accountId: String(accountId) };
}

module.exports = {
  findHardPinnedIntentBlocker,
  findTelegramProviderCapabilityBlocker,
  assertTelegramProviderCapabilityCanRetire,
};
