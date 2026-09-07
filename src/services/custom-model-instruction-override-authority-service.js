"use strict";

const { audit } = require("./audit-service");
const { fenceCustomModelObligationTransition } = require("./custom-model-obligation-authority-service");

const PRECOMMIT_STATES = new Set(["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"]);
const BLOCKING_STATES = new Set(["COMMITTING", "RECONCILE_REQUIRED"]);

function fail(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : null;
}

async function latestTargetSubmission({ agencyId, creatorId, customOrderId, excludeSubmissionId = null, db }) {
  if (!db?.customContentSubmission?.findFirst) return null;
  return db.customContentSubmission.findFirst({
    where: {
      agencyId,
      creatorId,
      customOrderId,
      ...(excludeSubmissionId ? { id: { not: String(excludeSubmissionId) } } : {}),
    },
    select: { id: true, reviewStatus: true, pipelineDisposition: true, receivedAt: true, createdAt: true },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

async function relevantModelInstruction({ agencyId, creatorId, customOrderId, excludeSubmissionId = null, db }) {
  if (!db?.telegramDeliveryIntent?.findFirst) {
    throw fail("CUSTOM_MODEL_INSTRUCTION_STORAGE_REQUIRED", "Telegram model-instruction storage is required for a human response override", 500);
  }
  const latest = await latestTargetSubmission({ agencyId, creatorId, customOrderId, excludeSubmissionId, db });
  const review = String(latest?.reviewStatus || "WAITING_REVIEW");
  if (latest && review !== "REVISION_REQUESTED") {
    throw fail("CUSTOM_MODEL_RESPONSE_TARGET_BUSY", "The target Custom already has a response that is not awaiting a revision", 409);
  }

  const kind = latest ? "REVISION_REQUEST" : "TASK";
  const intent = await db.telegramDeliveryIntent.findFirst({
    where: {
      agencyId,
      customOrderId,
      kind,
      ...(kind === "REVISION_REQUEST" ? { customSubmissionId: String(latest.id) } : {}),
    },
    select: {
      id: true, agencyId: true, creatorId: true, customOrderId: true, customSubmissionId: true,
      kind: true, state: true, claimRevision: true, commitStartedAt: true, remoteMessageId: true,
      remoteRecipientTelegramUserId: true, remoteSentAt: true, confirmedAt: true, outcomeReason: true,
      createdAt: true, updatedAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (intent && String(intent.creatorId || creatorId) !== String(creatorId)) {
    throw fail("CUSTOM_MODEL_INSTRUCTION_TARGET_CONFLICT", "The current model instruction belongs to a different creator", 409);
  }
  return { latestSubmission: latest || null, kind, intent: intent || null };
}

function decisionForInstruction(intent) {
  if (!intent) return { decision: "NO_INSTRUCTION", allow: true, supersede: false };
  const state = String(intent.state || "");
  if (PRECOMMIT_STATES.has(state) && intent.commitStartedAt == null) {
    return { decision: "SUPERSEDE_PRECOMMIT", allow: true, supersede: true };
  }
  if (state === "CONFIRMED") return { decision: "CONFIRMED_EXPLICIT_OVERRIDE", allow: true, supersede: false };
  if (state === "CANCELLED") return { decision: "PROVEN_NO_EFFECT_OR_CANCELLED", allow: true, supersede: false };
  if (state === "COMMITTING") return { decision: "BLOCK_COMMITTING", allow: false, supersede: false };
  if (state === "RECONCILE_REQUIRED") return { decision: "BLOCK_UNKNOWN_OUTCOME", allow: false, supersede: false };
  // Unknown/legacy state must never be treated as proof of no external effect.
  return { decision: "BLOCK_UNRESOLVED_STATE", allow: false, supersede: false };
}

async function reloadInstruction({ agencyId, instructionId, db }) {
  if (!instructionId) return null;
  return db.telegramDeliveryIntent.findFirst({
    where: { id: String(instructionId), agencyId },
    select: {
      id: true, agencyId: true, creatorId: true, customOrderId: true, customSubmissionId: true,
      kind: true, state: true, claimRevision: true, commitStartedAt: true, remoteMessageId: true,
      remoteRecipientTelegramUserId: true, remoteSentAt: true, confirmedAt: true, outcomeReason: true,
      createdAt: true, updatedAt: true,
    },
  });
}

async function adjudicateHumanModelResponseOverride({
  agencyId,
  creatorId,
  customOrderId,
  excludeSubmissionId = null,
  actorUserId = null,
  context = "MANUAL_RESPONSE",
  now = new Date(),
  db,
} = {}) {
  const scopedAgencyId = clean(agencyId);
  const scopedCreatorId = clean(creatorId);
  const orderId = clean(customOrderId);
  if (!scopedAgencyId || !scopedCreatorId || !orderId) {
    throw fail("CUSTOM_MODEL_RESPONSE_OVERRIDE_SCOPE_REQUIRED", "agencyId, creatorId and customOrderId are required", 400);
  }
  if (!db?.customOrder?.findFirst || !db?.customOrder?.updateMany || !db?.telegramDeliveryIntent?.findFirst) {
    throw fail("CUSTOM_MODEL_RESPONSE_OVERRIDE_STORAGE_REQUIRED", "Transactional Custom/Telegram read storage is required for a human response override", 500);
  }

  // This is the common causal lane with beginTelegramDeliveryIntent(). In PostgreSQL the row lock
  // serializes us against a provider commit permit; the explicit updatedAt bump also protects the
  // same boundary in CAS-only test/storage adapters. If begin won first, the intent is already
  // COMMITTING/UNKNOWN below and the response is rejected. If the human response wins, a stale
  // begin() cannot CAS the old order revision and therefore cannot start the provider effect.
  const fence = await fenceCustomModelObligationTransition({ agencyId: scopedAgencyId, orderId, now, db });
  if (fence.missing) throw fail("CUSTOM_MODEL_RESPONSE_ORDER_NOT_FOUND", "Target CustomOrder was not found", 404);
  if (String(fence.order?.creatorId || scopedCreatorId) !== scopedCreatorId) {
    throw fail("CUSTOM_MODEL_RESPONSE_CREATOR_CONFLICT", "Target CustomOrder belongs to a different creator", 409);
  }

  let lane = await relevantModelInstruction({
    agencyId: scopedAgencyId,
    creatorId: scopedCreatorId,
    customOrderId: orderId,
    excludeSubmissionId,
    db,
  });
  let intent = lane.intent;
  let outcome = decisionForInstruction(intent);

  if (outcome.supersede && intent) {
    if (!db?.telegramDeliveryIntent?.updateMany) {
      throw fail("CUSTOM_MODEL_RESPONSE_OVERRIDE_STORAGE_REQUIRED", "Transactional Telegram write storage is required to supersede a precommit model instruction", 500);
    }
    const changed = await db.telegramDeliveryIntent.updateMany({
      where: {
        id: String(intent.id),
        agencyId: scopedAgencyId,
        kind: String(intent.kind),
        state: { in: ["PLANNED", "CLAIMED", "FAILED_PRECOMMIT"] },
        claimRevision: Number(intent.claimRevision || 0),
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
        claimRevision: Number(intent.claimRevision || 0) + 1,
        outcomeReason: `HUMAN_RESPONSE_SUPERSEDED:${clean(context, 120) || "MANUAL_RESPONSE"}`,
        updatedAt: now,
      },
    });
    if (Number(changed?.count || 0) !== 1) {
      // The only safe retry is to classify the CURRENT durable provider state. Never assume that a
      // failed precommit CAS means "not sent": it may have crossed COMMITTING concurrently.
      intent = await reloadInstruction({ agencyId: scopedAgencyId, instructionId: intent.id, db });
      outcome = decisionForInstruction(intent);
      if (!outcome.allow || outcome.supersede) {
        if (String(intent?.state) === "COMMITTING") {
          throw fail("CUSTOM_MODEL_INSTRUCTION_COMMITTING", "The model instruction has crossed the provider commit boundary; settle it before accepting a manual response", 409);
        }
        if (String(intent?.state) === "RECONCILE_REQUIRED") {
          throw fail("CUSTOM_MODEL_INSTRUCTION_OUTCOME_UNKNOWN", "The model instruction provider outcome is unknown; reconcile it before accepting a manual response", 409);
        }
        throw fail("CUSTOM_MODEL_INSTRUCTION_OVERRIDE_RACE", "The model instruction changed while the human response override was being adjudicated", 409);
      }
    } else {
      intent = await reloadInstruction({ agencyId: scopedAgencyId, instructionId: intent.id, db }) || { ...intent, state: "CANCELLED" };
      outcome = { decision: "SUPERSEDED_PRECOMMIT", allow: true, supersede: false };
    }
  }

  if (!outcome.allow) {
    if (String(intent?.state) === "COMMITTING") {
      throw fail("CUSTOM_MODEL_INSTRUCTION_COMMITTING", "The model instruction has crossed the provider commit boundary; settle it before accepting a manual response", 409);
    }
    if (String(intent?.state) === "RECONCILE_REQUIRED") {
      throw fail("CUSTOM_MODEL_INSTRUCTION_OUTCOME_UNKNOWN", "The model instruction provider outcome is unknown; reconcile it before accepting a manual response", 409);
    }
    throw fail("CUSTOM_MODEL_INSTRUCTION_UNRESOLVED", "The current model instruction is not proven safe for a human response override", 409);
  }

  await audit({
    agencyId: scopedAgencyId,
    actorUserId: actorUserId || null,
    action: "custom_model_instruction.human_response_override",
    targetType: "CustomOrder",
    targetId: orderId,
    metadata: {
      creatorId: scopedCreatorId,
      context: clean(context, 120),
      instructionKind: lane.kind,
      instructionId: intent?.id || null,
      instructionState: intent?.state || null,
      decision: outcome.decision,
      latestSubmissionId: lane.latestSubmission?.id || null,
    },
    db,
    required: true,
  });

  return {
    ok: true,
    decision: outcome.decision,
    instructionKind: lane.kind,
    instructionId: intent?.id || null,
    instructionState: intent?.state || null,
    latestSubmissionId: lane.latestSubmission?.id || null,
    orderRevision: fence.updatedAt || null,
  };
}

module.exports = {
  PRECOMMIT_STATES,
  BLOCKING_STATES,
  relevantModelInstruction,
  decisionForInstruction,
  adjudicateHumanModelResponseOverride,
};
