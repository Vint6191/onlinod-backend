"use strict";

const { deriveCustomRevisionDispatch } = require("./custom-revision-dispatch-authority-service");

function clean(value, max = 500) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function confirmedInstruction(intent) {
  if (!intent || String(intent.state || "") !== "CONFIRMED") return null;
  const messageId = clean(intent.remoteMessageId, 40);
  const recipient = clean(intent.remoteRecipientTelegramUserId, 40);
  // remoteSentAt is the strongest provider timestamp. Historical confirmed rows may predate
  // that projection; confirmedAt is a conservative fallback (never earlier than settlement).
  const sentAt = isoOrNull(intent.remoteSentAt || intent.confirmedAt);
  if (!/^\d{1,20}$/.test(messageId) || !/^\d{1,20}$/.test(recipient) || !sentAt) return null;
  return {
    intentId: String(intent.id),
    kind: String(intent.kind),
    accountId: String(intent.accountId),
    remoteMessageId: messageId,
    recipientTelegramUserId: recipient,
    remoteSentAt: sentAt,
    state: "CONFIRMED",
  };
}

function publicSubmission(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    reviewStatus: String(row.reviewStatus || "WAITING_REVIEW"),
    pipelineDisposition: String(row.pipelineDisposition || "ACTIVE"),
    receivedAt: isoOrNull(row.receivedAt),
    reviewedAt: isoOrNull(row.reviewedAt),
  };
}

function stateResult({ state, order, submission = null, intent = null, instruction = null, obligation = false, reason = null }) {
  return {
    applies: true,
    orderId: String(order.id),
    creatorId: String(order.creatorId),
    state,
    modelOwesResponse: obligation === true,
    currentInstruction: instruction,
    instructionIntentId: instruction?.intentId || (intent?.id ? String(intent.id) : null),
    instructionKind: instruction?.kind || (intent?.kind ? String(intent.kind) : null),
    deliveryState: intent?.state ? String(intent.state) : null,
    latestSubmission: publicSubmission(submission),
    reason,
  };
}

async function latestSubmissionForOrder({ agencyId, order, db }) {
  if (!db?.customContentSubmission?.findFirst) return null;
  return db.customContentSubmission.findFirst({
    where: { agencyId, creatorId: String(order.creatorId), customOrderId: String(order.id) },
    select: { id: true, reviewStatus: true, pipelineDisposition: true, receivedAt: true, reviewedAt: true, createdAt: true },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

async function latestIntent({ agencyId, orderId, kind, customSubmissionId = null, db }) {
  if (!db?.telegramDeliveryIntent?.findFirst) return null;
  return db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId,
      customOrderId: String(orderId),
      kind: String(kind),
      ...(customSubmissionId ? { customSubmissionId: String(customSubmissionId) } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

async function deriveCustomModelObligation({ agencyId, orderId = null, order = null, db } = {}) {
  if (!agencyId || !db) {
    const error = new Error("agencyId and db are required to derive Custom model obligation");
    error.code = "CUSTOM_MODEL_OBLIGATION_SCOPE_REQUIRED";
    error.status = 400;
    throw error;
  }
  const row = order || (db.customOrder?.findFirst ? await db.customOrder.findFirst({ where: { id: clean(orderId, 180), agencyId } }) : null);
  if (!row) return { applies: false, missing: true, state: "MISSING", modelOwesResponse: false, currentInstruction: null };
  if (String(row.type || "CONTENT").toUpperCase() !== "CONTENT") {
    return { applies: false, missing: false, orderId: String(row.id), creatorId: String(row.creatorId), state: "NON_CONTENT", modelOwesResponse: false, currentInstruction: null };
  }
  if (String(row.status || "PENDING").toUpperCase() !== "PENDING") {
    return stateResult({ state: "TERMINAL", order: row, reason: `ORDER_${String(row.status || "UNKNOWN").toUpperCase()}` });
  }

  const submission = await latestSubmissionForOrder({ agencyId, order: row, db });
  if (submission) {
    const reviewStatus = String(submission.reviewStatus || "WAITING_REVIEW").toUpperCase();
    if (reviewStatus === "REVISION_REQUESTED") {
      const revision = await latestIntent({ agencyId, orderId: row.id, kind: "REVISION_REQUEST", customSubmissionId: submission.id, db });
      const dispatch = await deriveCustomRevisionDispatch({ agencyId, orderId: row.id, submission, intent: revision, db });
      const instruction = confirmedInstruction(revision);
      if (dispatch.status === "WAITING_MODEL" && instruction) {
        return stateResult({ state: "REVISION_WAITING_RESPONSE", order: row, submission, intent: revision, instruction, obligation: true, reason: "REVISION_PROVIDER_CONFIRMED" });
      }
      if (dispatch.status === "DELIVERY_UNKNOWN") {
        return stateResult({ state: "REVISION_DELIVERY_UNKNOWN", order: row, submission, intent: revision, reason: "REVISION_OUTCOME_UNKNOWN" });
      }
      if (dispatch.status === "DISPATCH_BLOCKED") {
        return stateResult({ state: "REVISION_DISPATCH_BLOCKED", order: row, submission, intent: revision, reason: String(dispatch.blockedCode || "PROVIDER_THREAD_UNAVAILABLE") });
      }
      if (dispatch.status === "DISPATCH_CANCELLED") {
        return stateResult({ state: "REVISION_DISPATCH_CANCELLED", order: row, submission, intent: revision, reason: "REVISION_DISPATCH_CANCELLED" });
      }
      return stateResult({ state: "REVISION_DISPATCH_PENDING", order: row, submission, intent: revision, reason: dispatch.status });
    }
    if (reviewStatus === "APPROVED") {
      return stateResult({ state: "NO_MODEL_OBLIGATION", order: row, submission, reason: "APPROVED_RESPONSE" });
    }
    return stateResult({ state: "RESPONSE_RECEIVED", order: row, submission, reason: "RESPONSE_AWAITING_MANAGER" });
  }

  const task = await latestIntent({ agencyId, orderId: row.id, kind: "TASK", db });
  const instruction = confirmedInstruction(task);
  if (instruction) {
    return stateResult({ state: "INITIAL_WAITING_RESPONSE", order: row, intent: task, instruction, obligation: true, reason: "TASK_PROVIDER_CONFIRMED" });
  }
  if (String(task?.state || "") === "RECONCILE_REQUIRED") {
    return stateResult({ state: "INITIAL_DELIVERY_UNKNOWN", order: row, intent: task, reason: "TASK_OUTCOME_UNKNOWN" });
  }
  if (task) return stateResult({ state: "INITIAL_DISPATCH_PENDING", order: row, intent: task, reason: `TASK_${String(task.state || "PLANNED")}` });
  return stateResult({ state: "NO_INSTRUCTION", order: row, reason: "TASK_INTENT_MISSING" });
}


async function fenceCustomModelObligationTransition({ agencyId, orderId, now = new Date(), db } = {}) {
  if (!agencyId || !orderId || !db?.customOrder?.findFirst || !db?.customOrder?.updateMany) {
    const error = new Error("CustomOrder storage is required for model-obligation transition fencing");
    error.code = "CUSTOM_MODEL_OBLIGATION_FENCE_REQUIRED";
    error.status = 500;
    throw error;
  }
  if (typeof db.$queryRawUnsafe === "function") {
    await db.$queryRawUnsafe(
      `SELECT "id" FROM "CustomOrder" WHERE "id" = $1 AND "agencyId" = $2 FOR UPDATE`,
      String(orderId), String(agencyId),
    );
  }
  const order = await db.customOrder.findFirst({ where: { id: String(orderId), agencyId: String(agencyId) } });
  if (!order) return { missing: true, changed: false, order: null };
  const revision = order.updatedAt ? new Date(order.updatedAt) : null;
  if (!revision || !Number.isFinite(revision.getTime())) {
    const error = new Error("CustomOrder.updatedAt revision is required for model-obligation transition fencing");
    error.code = "CUSTOM_MODEL_OBLIGATION_REVISION_REQUIRED";
    error.status = 500;
    throw error;
  }
  const requested = now instanceof Date ? now : new Date(now);
  const fenceAt = new Date(Math.max(Number.isFinite(requested.getTime()) ? requested.getTime() : Date.now(), revision.getTime() + 1));
  const changed = await db.customOrder.updateMany({
    where: { id: String(orderId), agencyId: String(agencyId), updatedAt: order.updatedAt },
    data: { updatedAt: fenceAt },
  });
  if (Number(changed?.count || 0) !== 1) {
    const error = new Error("Custom model-obligation transition raced another provider/business commit; retry from current state");
    error.code = "CUSTOM_MODEL_OBLIGATION_FENCE_CONFLICT";
    error.status = 409;
    throw error;
  }
  return { missing: false, changed: true, order: { ...order, updatedAt: fenceAt }, previousUpdatedAt: revision, updatedAt: fenceAt };
}


const PRECOMMIT_REFERENCE_STATES = ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"];

async function supersedePrecommitInitialReferences({ agencyId, orderId, now = new Date(), reason = "MODEL_RESPONSE_ACCEPTED", db } = {}) {
  if (!agencyId || !orderId || !db?.telegramDeliveryIntent?.findMany || !db?.telegramDeliveryIntent?.updateMany) {
    const error = new Error("TelegramDeliveryIntent storage is required to supersede initial references after a model response");
    error.code = "CUSTOM_MODEL_REFERENCE_SUPERSEDE_STORAGE_REQUIRED";
    error.status = 500;
    throw error;
  }
  const rows = await db.telegramDeliveryIntent.findMany({
    where: {
      agencyId: String(agencyId),
      customOrderId: String(orderId),
      kind: "REFERENCE",
      state: { in: PRECOMMIT_REFERENCE_STATES },
      commitStartedAt: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let cancelled = 0;
  let raced = 0;
  for (const row of rows || []) {
    const state = String(row.state || "");
    if (!PRECOMMIT_REFERENCE_STATES.includes(state) || row.commitStartedAt != null) continue;
    const revision = Number(row.claimRevision || 0);
    const changed = await db.telegramDeliveryIntent.updateMany({
      where: {
        id: String(row.id),
        agencyId: String(agencyId),
        kind: "REFERENCE",
        state,
        claimRevision: revision,
        commitStartedAt: null,
      },
      data: {
        state: "CANCELLED",
        deviceId: null,
        userId: null,
        memberId: null,
        accessEpoch: null,
        claimTokenHash: null,
        claimUntil: null,
        claimRevision: revision + 1,
        outcomeReason: `INITIAL_REFERENCE_SUPERSEDED:${String(reason || "MODEL_RESPONSE_ACCEPTED").slice(0, 180)}`,
        updatedAt: now,
      },
    });
    if (Number(changed?.count || 0) === 1) cancelled += 1;
    else raced += 1; // A provider begin may have crossed COMMITTING; response remains valid and that effect settles historically.
  }
  return { scanned: (rows || []).length, cancelled, raced };
}

function reminderBindingFromObligation(obligation) {
  if (!obligation?.modelOwesResponse || !obligation.currentInstruction) return null;
  const instruction = obligation.currentInstruction;
  return {
    cycleId: `${instruction.kind}:${instruction.intentId}`,
    intentId: instruction.intentId,
    kind: instruction.kind,
    accountId: instruction.accountId,
    replyToMessageId: instruction.remoteMessageId,
    recipientTelegramUserId: instruction.recipientTelegramUserId,
    remoteSentAt: instruction.remoteSentAt,
  };
}

module.exports = {
  deriveCustomModelObligation,
  reminderBindingFromObligation,
  confirmedInstruction,
  fenceCustomModelObligationTransition,
  supersedePrecommitInitialReferences,
};
