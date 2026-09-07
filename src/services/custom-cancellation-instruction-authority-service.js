"use strict";

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function fail(code, message, status = 409, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

async function latestSubmissionForCancellation({ agencyId, order, db }) {
  if (String(order?.type || "CONTENT").toUpperCase() !== "CONTENT" || !db?.customContentSubmission?.findFirst) return null;
  return db.customContentSubmission.findFirst({
    where: { agencyId, creatorId: String(order.creatorId), customOrderId: String(order.id) },
    select: { id: true, reviewStatus: true, receivedAt: true, createdAt: true },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

async function latestRevisionIntent({ agencyId, orderId, submissionId, db }) {
  if (!submissionId || !db?.telegramDeliveryIntent?.findFirst) return null;
  return db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId,
      customOrderId: String(orderId),
      customSubmissionId: String(submissionId),
      kind: "REVISION_REQUEST",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

async function latestConfirmedTask({ agencyId, orderId, db }) {
  if (!db?.telegramDeliveryIntent?.findFirst) return null;
  return db.telegramDeliveryIntent.findFirst({
    where: { agencyId, customOrderId: String(orderId), kind: "TASK", state: "CONFIRMED" },
    orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

function confirmedCancellationInstruction(intent) {
  if (!intent || String(intent.state || "") !== "CONFIRMED") return null;
  const messageId = clean(intent.remoteMessageId, 40);
  const recipient = clean(intent.remoteRecipientTelegramUserId, 40);
  const accountId = clean(intent.accountId, 180);
  if (!intent.id || !accountId || !/^\d{1,20}$/.test(messageId) || !/^\d{1,20}$/.test(recipient)) return null;
  const sentAtRaw = intent.remoteSentAt || intent.confirmedAt || null;
  const sentAt = sentAtRaw && Number.isFinite(new Date(sentAtRaw).getTime()) ? new Date(sentAtRaw).toISOString() : null;
  return {
    intentId: String(intent.id),
    kind: String(intent.kind),
    accountId,
    remoteMessageId: messageId,
    recipientTelegramUserId: recipient,
    remoteSentAt: sentAt,
    state: "CONFIRMED",
  };
}

function publicAnchor(instruction) {
  if (!instruction) return null;
  return {
    anchorKind: String(instruction.kind),
    instructionIntentId: String(instruction.intentId),
    accountId: String(instruction.accountId),
    replyToMessageId: String(instruction.remoteMessageId),
    recipientTelegramUserId: String(instruction.recipientTelegramUserId),
    remoteSentAt: String(instruction.remoteSentAt),
  };
}


function classifyCancellationInstructionFacts({ submission = null, revision = null, task = null } = {}) {
  if (submission && String(submission.reviewStatus || "").toUpperCase() === "REVISION_REQUESTED") {
    const revisionInstruction = confirmedCancellationInstruction(revision);
    if (revisionInstruction) {
      return {
        state: "CONFIRMED_REVISION",
        anchor: publicAnchor(revisionInstruction),
        instruction: revision,
        revisionIntentId: String(revision.id),
        revisionState: "CONFIRMED",
        submissionId: String(submission.id),
      };
    }
    if (["COMMITTING", "RECONCILE_REQUIRED"].includes(String(revision?.state || ""))) {
      return {
        state: "REVISION_OUTCOME_UNRESOLVED",
        anchor: null,
        instruction: revision || null,
        revisionIntentId: String(revision.id),
        revisionState: String(revision.state),
        submissionId: String(submission.id),
      };
    }
  }

  const taskInstruction = confirmedCancellationInstruction(task);
  if (taskInstruction) {
    return {
      state: "CONFIRMED_TASK",
      anchor: publicAnchor(taskInstruction),
      instruction: task,
      revisionIntentId: null,
      revisionState: null,
      submissionId: submission?.id ? String(submission.id) : null,
    };
  }

  return {
    state: "NO_DELIVERED_INSTRUCTION",
    anchor: null,
    instruction: null,
    revisionIntentId: null,
    revisionState: null,
    submissionId: submission?.id ? String(submission.id) : null,
  };
}

async function deriveCustomCancellationInstruction({ agencyId, orderId = null, order = null, db } = {}) {
  const scopedAgencyId = clean(agencyId);
  if (!scopedAgencyId || !db) throw fail("CUSTOM_CANCELLATION_INSTRUCTION_SCOPE_REQUIRED", "agencyId and db are required", 400);
  const row = order || (db.customOrder?.findFirst
    ? await db.customOrder.findFirst({ where: { agencyId: scopedAgencyId, id: clean(orderId) } })
    : null);
  if (!row) return { state: "ORDER_MISSING", anchor: null, revisionIntentId: null, revisionState: null };

  const submission = await latestSubmissionForCancellation({ agencyId: scopedAgencyId, order: row, db });
  const revision = submission && String(submission.reviewStatus || "").toUpperCase() === "REVISION_REQUESTED"
    ? await latestRevisionIntent({ agencyId: scopedAgencyId, orderId: row.id, submissionId: submission.id, db })
    : null;
  const task = await latestConfirmedTask({ agencyId: scopedAgencyId, orderId: row.id, db });
  return classifyCancellationInstructionFacts({ submission, revision, task });
}

function requireCancellationProviderAnchor(result) {
  if (result?.anchor) return result.anchor;
  if (String(result?.state || "") === "REVISION_OUTCOME_UNRESOLVED") {
    throw fail(
      "CUSTOM_CANCELLATION_INSTRUCTION_OUTCOME_UNRESOLVED",
      "The current revision instruction crossed the Telegram commit boundary; settle its provider outcome before cancellation follow-up is sent",
      409,
      { instructionIntentId: result.revisionIntentId || null, instructionState: result.revisionState || null },
    );
  }
  throw fail(
    "CUSTOM_CANCELLATION_MODEL_INSTRUCTION_NOT_DELIVERED",
    "No provider-confirmed Custom model instruction exists, so no Telegram cancellation follow-up is required",
    409,
  );
}

module.exports = {
  classifyCancellationInstructionFacts,
  deriveCustomCancellationInstruction,
  requireCancellationProviderAnchor,
};
