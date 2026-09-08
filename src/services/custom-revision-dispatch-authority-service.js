"use strict";

const { resolveRevisionProviderBinding } = require("./custom-revision-provider-binding-authority-service");

function clean(value, max = 500) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}
function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function blockedCodeFromOutcomeReason(value) {
  const reason = clean(value, 500);
  const prefix = "PRECOMMIT_PROVIDER_UNAVAILABLE:";
  return reason.startsWith(prefix) ? clean(reason.slice(prefix.length), 300) || "PROVIDER_UNAVAILABLE" : null;
}
function projection({ status, intent = null, blockedCode = null, binding = null }) {
  return {
    status: String(status),
    intentId: intent?.id == null ? null : String(intent.id),
    state: intent?.state == null ? null : String(intent.state),
    providerMessageId: intent?.remoteMessageId == null ? null : String(intent.remoteMessageId),
    remoteSentAt: isoOrNull(intent?.remoteSentAt),
    blockedCode: blockedCode || null,
    providerAnchorKind: binding?.anchorKind || null,
    providerAccountId: binding?.accountId || null,
  };
}
async function latestRevisionIntent({ agencyId, orderId, submissionId, db }) {
  if (!db?.telegramDeliveryIntent?.findFirst) return null;
  return db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId: String(agencyId),
      customOrderId: String(orderId),
      kind: "REVISION_REQUEST",
      customSubmissionId: String(submissionId),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
async function deriveCustomRevisionDispatch({ agencyId, orderId, submission, intent = undefined, db } = {}) {
  if (!agencyId || !orderId || !submission?.id || !db) {
    const error = new Error("Exact revision submission, order and db are required");
    error.code = "CUSTOM_REVISION_DISPATCH_SCOPE_REQUIRED";
    error.status = 500;
    throw error;
  }
  const row = intent === undefined
    ? await latestRevisionIntent({ agencyId, orderId, submissionId: submission.id, db })
    : intent;
  const state = String(row?.state || "");

  if (state === "CONFIRMED") return projection({ status: "WAITING_MODEL", intent: row });
  if (state === "RECONCILE_REQUIRED") return projection({ status: "DELIVERY_UNKNOWN", intent: row });
  if (["CLAIMED", "COMMITTING"].includes(state)) return projection({ status: "SENDING", intent: row });
  if (state === "CANCELLED") return projection({ status: "DISPATCH_CANCELLED", intent: row });

  // Durable execution truth wins over a speculative read-time provider probe. Once the
  // executor records PRECOMMIT_PROVIDER_UNAVAILABLE, every consumer must stay BLOCKED
  // until the repair/claim lane has actually rebound the SAME durable intent and cleared
  // the blocker. Otherwise UI can say PENDING while the executable queue is still blocked.
  const durableBlockedCode = state === "PLANNED" && row?.commitStartedAt == null
    ? blockedCodeFromOutcomeReason(row?.outcomeReason)
    : null;
  if (durableBlockedCode) return projection({ status: "DISPATCH_BLOCKED", intent: row, blockedCode: durableBlockedCode });

  // Missing or ordinary precommit revision work is not enough to say PENDING. The provider
  // capability must still exist now.
  let binding = null;
  try {
    binding = await resolveRevisionProviderBinding({ agencyId, orderId, submission, db });
  } catch (error) {
    if (String(error?.code || "") !== "CUSTOM_REVISION_DISPATCH_BLOCKED") throw error;
    return projection({
      status: "DISPATCH_BLOCKED",
      intent: row || null,
      blockedCode: String(error.blockedCode || blockedCodeFromOutcomeReason(row?.outcomeReason) || "PROVIDER_THREAD_UNAVAILABLE"),
    });
  }

  return projection({ status: row ? "DISPATCH_PENDING" : "DISPATCH_REQUIRED", intent: row || null, binding });
}

module.exports = {
  deriveCustomRevisionDispatch,
  blockedCodeFromOutcomeReason,
};
