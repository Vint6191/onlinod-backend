"use strict";

const { findCancelledModelInstructionFollowupDebt, scanIncompleteTelegramSources } = require("./telegram-exact-authority-scan-service");
const { findCustomProviderThreadRetentionBlockers } = require("./custom-provider-thread-retention-authority-service");

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

async function findHardPinnedIntentBlocker({ agencyId, accountId, db }) {
  if (!db?.telegramDeliveryIntent?.findFirst) return null;
  const row = await db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId,
      accountId: String(accountId),
      OR: [
        // External effect may already have started. Provider identity is immutable evidence.
        { state: { in: ["COMMITTING", "RECONCILE_REQUIRED"] } },
        // Cancellation delivery is a follow-up to a model instruction on an exact provider
        // thread. Unlike TASK/REFERENCE/REVISION/REMINDER precommit work, current cancellation
        // planning has no alternate-thread rebinding contract after the source account retires.
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

async function findTelegramProviderCapabilityBlocker({ agencyId, accountId, db }) {
  const target = clean(accountId);
  if (!agencyId || !target || !db) return null;

  const hardIntent = await findHardPinnedIntentBlocker({ agencyId, accountId: target, db });
  if (hardIntent) return hardIntent;

  const providerRetention = await findCustomProviderThreadRetentionBlockers({ agencyId, accountId: target, db, stopAfterFirst: true });
  if (providerRetention.length) {
    return {
      class: "CURRENT_PROVIDER_CAPABILITY",
      reason: providerRetention[0]?.reason || "CURRENT_PROVIDER_CAPABILITY",
      ...providerRetention[0],
      message: "Telegram connection is still required by an active Custom provider-thread capability",
    };
  }

  const cancelledFollowupDebt = await findCancelledModelInstructionFollowupDebt({ agencyId, accountId: target, db, stopAfterFirst: true });
  if (cancelledFollowupDebt.length) {
    return {
      class: "CANCELLATION_FOLLOWUP_DEBT",
      reason: cancelledFollowupDebt[0]?.reason || "CANCELLATION_FOLLOWUP_DEBT",
      debt: cancelledFollowupDebt[0],
      message: "Telegram connection still owns a confirmed model instruction whose cancellation follow-up has not been durably planned or confirmed",
    };
  }

  let pendingSource = null;
  await scanIncompleteTelegramSources({
    agencyId,
    accountId: target,
    requireSourceUser: false,
    db,
    onRow: async (row) => { pendingSource = row; return true; },
  });
  if (pendingSource) {
    return {
      class: "INBOUND_SOURCE_DEBT",
      reason: "INCOMPLETE_CUSTOM_SOURCE_MEDIA",
      submissionId: pendingSource?.id ? String(pendingSource.id) : null,
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
