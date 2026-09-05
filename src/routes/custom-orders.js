"use strict";

const express = require("express");
const prisma = require("../prisma");
const {
  createCustomOrder,
  getCustomOrder,
  getCustomOrderByClientMutationId,
  listCustomOrders,
  updateCustomOrder,
} = require("../services/custom-orders-service");
const {
  claimCustomContentSubmissionUploadWork,
  commitCustomContentSubmissionMedia,
  createCustomContentSubmission,
  listCustomContentSubmissions,
  reserveCustomContentSubmissionRelayWrite,
  closeCustomContentSubmissionRelayWriteUnresolved,
  resolveCustomContentSubmissionRelayWriteMatched,
} = require("../services/custom-content-submissions-service");
const { finalizeCustomContentSubmissionLibrary } = require("../services/custom-content-library-service");
const { listCustomContentReviewQueue, reviewCustomContentSubmission } = require("../services/custom-content-review-service");
const {
  assignUnassignedCustomContentSubmission,
  listAwaitingCustomRevisions,
  listCustomSubmissionAssignmentCandidates,
  listUnassignedCustomContentSubmissions,
} = require("../services/custom-content-workflow-service");
const {
  getCustomVaultDestination,
  setCustomVaultDestination,
} = require("../services/custom-vault-destination-service");
const { listCustomNonContentOperations } = require("../services/custom-noncontent-operations-service");
const { listCustomReadyDeliveries, getCustomReadyDelivery } = require("../services/custom-content-delivery-service");

const {
  planTelegramDeliveryIntent,
  listTelegramDeliveryWork,
  claimTelegramDeliveryIntent,
  beginTelegramDeliveryIntent,
  confirmTelegramDeliveryIntent,
  markTelegramDeliveryUnknown,
  markTelegramDeliveryProvenNotSent,
  failTelegramDeliveryPrecommit,
  getTelegramOrderContext,
  reconcileTelegramDeliveryIntent,
} = require("../services/telegram-delivery-authority-service");
const { ingestTelegramInboundEvent } = require("../services/telegram-inbound-authority-service");
const { requireProductDevice, requireProductPermission, currentAccessEpoch } = require("../middleware/product-access");

const router = express.Router();
function bool(value) { return value === true || value === "1" || String(value || "").toLowerCase() === "true"; }
function sendError(res, err, fallbackCode) {
  const status = Number(err?.status);
  return res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 500).json({ ok: false, code: err?.code || fallbackCode, error: err?.message || "Request failed" });
}

router.get("/", async (req, res) => {
  try {
    const result = await listCustomOrders({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.query.creatorId || null, dialogId: req.query.dialogId || null, status: req.query.status || null, pendingOnly: bool(req.query.pendingOnly), limit: req.query.limit, offset: req.query.offset, db: prisma });
    return res.json(result);
  } catch (err) { return sendError(res, err, "CUSTOM_ORDERS_LIST_FAILED"); }
});

router.get("/operations/non-content", async (req, res) => {
  try {
    return res.json(await listCustomNonContentOperations({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      horizonHours: req.query.horizonHours,
      limit: req.query.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_NONCONTENT_OPERATIONS_FAILED"); }
});

router.get("/vault-destination", async (req, res) => {
  try {
    return res.json(await getCustomVaultDestination({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.query.creatorId, db: prisma }));
  } catch (err) { return sendError(res, err, "CUSTOM_VAULT_DESTINATION_GET_FAILED"); }
});

router.patch("/vault-destination", async (req, res) => {
  try {
    await requireProductPermission(req, "content.manage_vault", { code: "CUSTOM_VAULT_DESTINATION_FORBIDDEN" });
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "folderId")) {
      throw Object.assign(new Error("folderId is required; use null to clear"), { code: "CUSTOM_VAULT_DESTINATION_PATCH_INVALID", status: 400 });
    }
    return res.json(await setCustomVaultDestination({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.body?.creatorId, folderId: req.body?.folderId, db: prisma }));
  } catch (err) { return sendError(res, err, "CUSTOM_VAULT_DESTINATION_UPDATE_FAILED"); }
});

router.post("/", async (req, res) => {
  try {
    const result = await createCustomOrder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, input: req.body || {}, db: prisma });
    return res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err) { return sendError(res, err, "CUSTOM_ORDER_CREATE_FAILED"); }
});

router.get("/submissions", async (req, res) => {
  try {
    return res.json(await listCustomContentSubmissions({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      creatorId: req.query.creatorId,
      customOrderId: req.query.customOrderId,
      unassigned: bool(req.query.unassigned),
      limit: req.query.limit,
      offset: req.query.offset,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_LIST_FAILED"); }
});


router.get("/submissions/unassigned-queue", async (req, res) => {
  try {
    return res.json(await listUnassignedCustomContentSubmissions({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      limit: req.query.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_UNASSIGNED_QUEUE_FAILED"); }
});

router.get("/submissions/:submissionId/assignment-candidates", async (req, res) => {
  try {
    return res.json(await listCustomSubmissionAssignmentCandidates({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      limit: req.query.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_ASSIGNMENT_CANDIDATES_FAILED"); }
});

router.post("/submissions/:submissionId/assign-unassigned", async (req, res) => {
  try {
    return res.json(await assignUnassignedCustomContentSubmission({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      customOrderId: req.body?.customOrderId,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_ASSIGN_UNASSIGNED_FAILED"); }
});

router.get("/revision-queue", async (req, res) => {
  try {
    return res.json(await listAwaitingCustomRevisions({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      limit: req.query.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_REVISION_QUEUE_FAILED"); }
});

router.get("/by-client-mutation/:clientMutationId", async (req, res) => {
  try { return res.json(await getCustomOrderByClientMutationId({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, clientMutationId: req.params.clientMutationId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_CLIENT_MUTATION_LOOKUP_FAILED"); }
});

router.post("/submissions", (_req, res) => {
  return res.status(410).json({ ok: false, code: "CUSTOM_SUBMISSION_RAW_INGRESS_RETIRED", error: "Raw Telegram message IDs are no longer a submission authority. Use proven Telegram inbound events or the audited manual-import endpoint." });
});

router.post("/submissions/manual-import", async (req, res) => {
  try {
    await requireProductPermission(req, "content.review_customs", { code: "CUSTOM_SUBMISSION_MANUAL_IMPORT_FORBIDDEN" });
    return res.status(201).json(await createCustomContentSubmission({
      agencyId: req.auth.agencyId, member: req.auth.membership || req.member, input: { ...(req.body || {}), manualImportReason: req.body?.reason || req.body?.manualImportReason }, db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_MANUAL_IMPORT_FAILED"); }
});

router.post("/submissions/upload-work", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await claimCustomContentSubmissionUploadWork({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      deviceId: req.body?.deviceId,
      leases: req.body?.leases,
      limit: req.body?.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_UPLOAD_WORK_FAILED"); }
});


router.post("/submissions/:submissionId/relay-write/reserve", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await reserveCustomContentSubmissionRelayWrite({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      deviceId: req.body?.deviceId,
      submissionId: req.params.submissionId,
      expectedIndex: req.body?.expectedIndex,
      expectedTelegramMessageId: req.body?.telegramMessageId,
      accessEpoch: currentAccessEpoch(req),
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_RELAY_WRITE_RESERVE_FAILED"); }
});

router.post("/submissions/:submissionId/relay-write/close-unresolved", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await closeCustomContentSubmissionRelayWriteUnresolved({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      deviceId: req.body?.deviceId,
      submissionId: req.params.submissionId,
      expectedIndex: req.body?.expectedIndex,
      writeId: req.body?.writeId,
      leaseToken: req.body?.leaseToken,
      leaseRevision: req.body?.leaseRevision,
      reason: req.body?.reason,
      accessEpoch: currentAccessEpoch(req),
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_RELAY_WRITE_CLOSE_FAILED"); }
});

router.post("/submissions/:submissionId/relay-write/resolve-unresolved-matched", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await resolveCustomContentSubmissionRelayWriteMatched({
      agencyId: req.auth.agencyId, member: req.auth.membership || req.member, deviceId: req.body?.deviceId,
      submissionId: req.params.submissionId, expectedIndex: req.body?.expectedIndex, writeId: req.body?.writeId,
      mediaId: req.body?.mediaId, messageId: req.body?.messageId, accessEpoch: currentAccessEpoch(req), db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_RELAY_WRITE_RESOLVE_FAILED"); }
});

router.post("/submissions/:submissionId/media-commit", async (req, res) => {
  try {
    if (req.body?.mediaId !== undefined) {
      return res.status(410).json({ ok: false, code: "CUSTOM_SUBMISSION_MEDIA_ASSERTION_RETIRED", error: "mediaId is projected only from the confirmed CUSTOM_RELAY_SEND result." });
    }
    return res.json(await commitCustomContentSubmissionMedia({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      expectedIndex: req.body?.expectedIndex,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_MEDIA_COMMIT_FAILED"); }
});

router.post("/submissions/:submissionId/content-library-finalize", async (req, res) => {
  try {
    return res.json(await finalizeCustomContentSubmissionLibrary({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      mediaHints: req.body?.mediaHints,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_LIBRARY_FINALIZE_FAILED"); }
});

router.patch("/submissions/:submissionId", (_req, res) => {
  return res.status(410).json({ ok: false, code: "CUSTOM_SUBMISSION_GENERIC_ASSIGN_RETIRED", error: "Use the review-authorized assignment workflow." });
});


router.get("/ready-deliveries", async (req, res) => {
  try {
    return res.json(await listCustomReadyDeliveries({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      limit: req.query.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_DELIVERY_LIST_FAILED"); }
});

router.get("/ready-deliveries/:customOrderId", async (req, res) => {
  try {
    return res.json(await getCustomReadyDelivery({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      customOrderId: req.params.customOrderId,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_DELIVERY_GET_FAILED"); }
});

router.post("/ready-deliveries/:customOrderId/confirm-send", (_req, res) => {
  return res.status(410).json({ ok: false, code: "CUSTOM_DELIVERY_DIRECT_CONFIRM_RETIRED", error: "Fan delivery is projected only from durable MESSAGE_SEND_CONFIRMED network events." });
});


router.get("/review-queue", async (req, res) => {
  try {
    return res.json(await listCustomContentReviewQueue({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      status: req.query.status || "WAITING_REVIEW",
      limit: req.query.limit,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_REVIEW_QUEUE_FAILED"); }
});

router.post("/submissions/:submissionId/review", async (req, res) => {
  try {
    return res.json(await reviewCustomContentSubmission({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      action: req.body?.action,
      comment: req.body?.comment,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_REVIEW_ACTION_FAILED"); }
});

router.post("/telegram-inbound", async (req, res) => {
  try {
    requireProductDevice(req, req.body?.deviceId);
    return res.json(await ingestTelegramInboundEvent({
      agencyId: req.auth.agencyId, member: req.auth.membership || req.member, accountId: req.body?.accountId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken,
      senderTelegramUserId: req.body?.senderTelegramUserId, messageId: req.body?.messageId, replyToMessageId: req.body?.replyToMessageId, groupedId: req.body?.groupedId,
      hasMedia: req.body?.hasMedia === true, text: req.body?.text, sentAt: req.body?.sentAt, db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_INBOUND_FAILED"); }
});

router.post("/telegram-deliveries/work", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await listTelegramDeliveryWork({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, limit: req.body?.limit, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_WORK_FAILED"); }
});

router.post("/telegram-deliveries/:intentId/claim", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await claimTelegramDeliveryIntent({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, deviceId: req.body?.deviceId, runtimeClaimToken: req.body?.runtimeClaimToken, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_CLAIM_FAILED"); }
});
router.post("/telegram-deliveries/:intentId/begin", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await beginTelegramDeliveryIntent({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, deviceId: req.body?.deviceId, runtimeClaimToken: req.body?.runtimeClaimToken, claimToken: req.body?.claimToken, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_BEGIN_FAILED"); }
});
router.post("/telegram-deliveries/:intentId/confirm", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await confirmTelegramDeliveryIntent({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, remoteMessageId: req.body?.remoteMessageId, remoteRecipientTelegramUserId: req.body?.remoteRecipientTelegramUserId, remoteSentAt: req.body?.remoteSentAt, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_CONFIRM_FAILED"); }
});
router.post("/telegram-deliveries/:intentId/unknown", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await markTelegramDeliveryUnknown({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, reason: req.body?.reason, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_UNKNOWN_FAILED"); }
});
router.post("/telegram-deliveries/:intentId/proven-not-sent", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await markTelegramDeliveryProvenNotSent({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, reason: req.body?.reason, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_PROVEN_NOT_SENT_FAILED"); }
});

router.post("/telegram-deliveries/:intentId/fail-precommit", async (req, res) => {
  try { requireProductDevice(req, req.body?.deviceId); return res.json(await failTelegramDeliveryPrecommit({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, reason: req.body?.reason, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_PRECOMMIT_FAILED"); }
});
router.post("/telegram-deliveries/:intentId/reconcile", async (req, res) => {
  try {
    await requireProductPermission(req, "content.review_customs", { code: "TELEGRAM_DELIVERY_RECONCILE_FORBIDDEN" });
    return res.json(await reconcileTelegramDeliveryIntent({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, intentId: req.params.intentId, resolution: req.body?.resolution, remoteMessageId: req.body?.remoteMessageId, remoteRecipientTelegramUserId: req.body?.remoteRecipientTelegramUserId, remoteSentAt: req.body?.remoteSentAt, reason: req.body?.reason, db: prisma }));
  } catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_RECONCILE_FAILED"); }
});

router.get("/:orderId/telegram-context", async (req, res) => {
  try { return res.json(await getTelegramOrderContext({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_ORDER_CONTEXT_FAILED"); }
});

router.post("/:orderId/telegram-deliveries/plan", async (req, res) => {
  try { return res.json(await planTelegramDeliveryIntent({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, kind: req.body?.kind, clientIntentId: req.body?.clientIntentId, reference: req.body?.reference, db: prisma })); }
  catch (err) { return sendError(res, err, "TELEGRAM_DELIVERY_PLAN_FAILED"); }
});


router.post("/reminders/claim", (_req, res) => {
  return res.status(410).json({ ok: false, code: "CUSTOM_REMINDER_LEGACY_PROTOCOL_RETIRED", error: "Reminder execution moved to TelegramDeliveryIntent authority." });
});


router.get("/:orderId", async (req, res) => {
  try { return res.json(await getCustomOrder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_GET_FAILED"); }
});

router.patch("/:orderId", async (req, res) => {
  try { return res.json(await updateCustomOrder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, input: req.body || {}, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_UPDATE_FAILED"); }
});

router.post("/:orderId/telegram-task", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_TELEGRAM_LEGACY_PROTOCOL_RETIRED" }));
router.post("/:orderId/telegram-delivery", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_TELEGRAM_LEGACY_PROTOCOL_RETIRED" }));
router.post("/:orderId/telegram-status", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_TELEGRAM_LEGACY_PROTOCOL_RETIRED" }));
router.post("/:orderId/remind-now", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_TELEGRAM_LEGACY_PROTOCOL_RETIRED" }));
router.post("/:orderId/remind-now/ack", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_TELEGRAM_LEGACY_PROTOCOL_RETIRED" }));
router.post("/:orderId/reminders/ack", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_REMINDER_LEGACY_PROTOCOL_RETIRED" }));
router.post("/:orderId/reminders/fail", (_req, res) => res.status(410).json({ ok: false, code: "CUSTOM_REMINDER_LEGACY_PROTOCOL_RETIRED" }));

module.exports = router;
