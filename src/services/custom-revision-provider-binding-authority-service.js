"use strict";

function clean(value, max = 500) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}
function blocked(reason, message) {
  const error = new Error(message || "Revision instruction has no proven Telegram provider thread");
  error.code = "CUSTOM_REVISION_DISPATCH_BLOCKED";
  error.blockedCode = String(reason || "PROVIDER_THREAD_UNAVAILABLE");
  error.status = 409;
  return error;
}
function positiveMessageId(value) {
  const text = clean(value, 40);
  return /^\d{1,20}$/.test(text) && BigInt(text) > 0n ? text : null;
}
function confirmedTaskBinding(task) {
  if (!task || String(task.state || "") !== "CONFIRMED") return null;
  const accountId = clean(task.accountId, 180);
  const replyToMessageId = positiveMessageId(task.remoteMessageId);
  const recipientTelegramUserId = positiveMessageId(task.remoteRecipientTelegramUserId);
  if (!accountId || !replyToMessageId || !recipientTelegramUserId) return null;
  return {
    anchorKind: "CONFIRMED_TASK",
    accountId,
    replyToMessageId,
    recipientTelegramUserId,
    replyToDeliveryId: clean(task.id, 180) || null,
  };
}
function pinnedSubmissionSourceBinding(submission) {
  if (!submission) return null;
  const accountId = clean(submission.telegramSourceAccountId, 180);
  const recipientTelegramUserId = positiveMessageId(submission.telegramSourceUserId);
  const messageIds = Array.from(new Set((Array.isArray(submission.telegramMessageIds) ? submission.telegramMessageIds : [])
    .map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0)))
    .sort((a, b) => a - b);
  if (!accountId || !recipientTelegramUserId || !messageIds.length) return null;
  return {
    anchorKind: "PINNED_SUBMISSION_SOURCE",
    accountId,
    replyToMessageId: String(messageIds[messageIds.length - 1]),
    recipientTelegramUserId,
    replyToDeliveryId: null,
  };
}
async function assertActiveProviderAccount({ agencyId, binding, db }) {
  if (!db?.agencyTelegramMtprotoAccount?.findFirst) {
    const error = new Error("Telegram account storage is required to validate revision provider binding");
    error.code = "CUSTOM_REVISION_PROVIDER_BINDING_STORAGE_REQUIRED";
    error.status = 500;
    throw error;
  }
  const account = await db.agencyTelegramMtprotoAccount.findFirst({
    where: { id: String(binding.accountId), agencyId: String(agencyId) },
    select: { id: true, lifecycleState: true },
  });
  if (!account) throw blocked("PROVIDER_ACCOUNT_MISSING", "The Telegram account for the revision instruction no longer exists");
  if (String(account.lifecycleState || "ACTIVE") !== "ACTIVE") throw blocked("PROVIDER_ACCOUNT_RETIRING", "The Telegram account for the revision instruction is retiring");
  return binding;
}
async function inspectRevisionProviderBindings({ agencyId, orderId, submission, db } = {}) {
  if (!agencyId || !orderId || !submission?.id || !db?.telegramDeliveryIntent?.findFirst) {
    const error = new Error("Exact revision submission, order and Telegram intent storage are required");
    error.code = "CUSTOM_REVISION_PROVIDER_BINDING_SCOPE_REQUIRED";
    error.status = 500;
    throw error;
  }
  if (!db?.agencyTelegramMtprotoAccount?.findFirst) {
    const error = new Error("Telegram account storage is required to validate revision provider binding");
    error.code = "CUSTOM_REVISION_PROVIDER_BINDING_STORAGE_REQUIRED";
    error.status = 500;
    throw error;
  }
  const task = await db.telegramDeliveryIntent.findFirst({
    where: { agencyId: String(agencyId), customOrderId: String(orderId), kind: "TASK", state: "CONFIRMED" },
    orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  const candidates = [confirmedTaskBinding(task), pinnedSubmissionSourceBinding(submission)].filter(Boolean);
  const inspected = [];
  for (const binding of candidates) {
    const account = await db.agencyTelegramMtprotoAccount.findFirst({
      where: { id: String(binding.accountId), agencyId: String(agencyId) },
      select: { id: true, lifecycleState: true },
    });
    const blockedCode = !account ? "PROVIDER_ACCOUNT_MISSING"
      : String(account.lifecycleState || "ACTIVE") !== "ACTIVE" ? "PROVIDER_ACCOUNT_RETIRING" : null;
    inspected.push({ binding, usable: blockedCode == null, blockedCode, lifecycleState: account?.lifecycleState || null });
  }
  return inspected;
}

async function resolveRevisionProviderBinding({ agencyId, orderId, submission, db } = {}) {
  const inspected = await inspectRevisionProviderBindings({ agencyId, orderId, submission, db });
  if (!inspected.length) {
    throw blocked(
      "TASK_AND_PINNED_SOURCE_UNAVAILABLE",
      "Revision is required, but neither a confirmed TASK thread nor the submission's pinned Telegram source thread is available",
    );
  }
  const usable = inspected.find((row) => row.usable);
  if (usable) return usable.binding;
  if (inspected.length === 1) {
    const row = inspected[0];
    throw blocked(
      row.blockedCode || "PROVIDER_THREAD_UNAVAILABLE",
      row.blockedCode === "PROVIDER_ACCOUNT_MISSING"
        ? "The Telegram account for the revision instruction no longer exists"
        : "The Telegram account for the revision instruction is retiring",
    );
  }
  const taskFailure = inspected[0]?.blockedCode || "TASK_UNAVAILABLE";
  const sourceFailure = inspected[1]?.blockedCode || "PINNED_SOURCE_UNAVAILABLE";
  const error = blocked(
    "TASK_AND_PINNED_SOURCE_UNAVAILABLE",
    `Revision provider anchors are unavailable (TASK=${taskFailure}, PINNED_SOURCE=${sourceFailure})`,
  );
  error.anchorFailures = { task: taskFailure, pinnedSource: sourceFailure };
  throw error;
}

module.exports = {
  resolveRevisionProviderBinding,
  confirmedTaskBinding,
  pinnedSubmissionSourceBinding,
  inspectRevisionProviderBindings,
};
