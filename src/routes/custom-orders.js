"use strict";

const express = require("express");
const prisma = require("../prisma");
const {
  createCustomOrder,
  listCustomOrders,
  updateCustomOrder,
  recordTelegramDelivery,
  prepareTelegramTask,
  prepareManualReminder,
  recordManualReminder,
  recordTelegramInboundReply,
  prepareTelegramStatusNotification,
} = require("../services/custom-orders-service");
const {
  assignCustomContentSubmission,
  claimCustomContentSubmissionUploadWork,
  commitCustomContentSubmissionMedia,
  createCustomContentSubmission,
  listCustomContentSubmissions,
} = require("../services/custom-content-submissions-service");
const { finalizeCustomContentSubmissionLibrary } = require("../services/custom-content-library-service");
const { listCustomContentReviewQueue, reviewCustomContentSubmission } = require("../services/custom-content-review-service");
const {
  claimDueReminders,
  acknowledgeReminder,
  releaseReminderClaim,
} = require("../services/custom-order-reminders");
const {
  getCustomVaultDestination,
  setCustomVaultDestination,
} = require("../services/custom-vault-destination-service");

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

router.get("/vault-destination", async (req, res) => {
  try {
    return res.json(await getCustomVaultDestination({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.query.creatorId, db: prisma }));
  } catch (err) { return sendError(res, err, "CUSTOM_VAULT_DESTINATION_GET_FAILED"); }
});

router.patch("/vault-destination", async (req, res) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "folderId")) {
      throw Object.assign(new Error("folderId is required; use null to clear"), { code: "CUSTOM_VAULT_DESTINATION_PATCH_INVALID", status: 400 });
    }
    return res.json(await setCustomVaultDestination({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.body?.creatorId, folderId: req.body?.folderId, db: prisma }));
  } catch (err) { return sendError(res, err, "CUSTOM_VAULT_DESTINATION_UPDATE_FAILED"); }
});

router.post("/", async (req, res) => {
  try { return res.status(201).json(await createCustomOrder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, input: req.body || {}, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_CREATE_FAILED"); }
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

router.post("/submissions", async (req, res) => {
  try {
    return res.status(201).json(await createCustomContentSubmission({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      input: req.body || {},
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_CREATE_FAILED"); }
});

router.post("/submissions/upload-work", async (req, res) => {
  try {
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

router.post("/submissions/:submissionId/media-commit", async (req, res) => {
  try {
    return res.json(await commitCustomContentSubmissionMedia({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      expectedIndex: req.body?.expectedIndex,
      mediaId: req.body?.mediaId,
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

router.patch("/submissions/:submissionId", async (req, res) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "customOrderId")) {
      const error = Object.assign(new Error("customOrderId is required"), { code: "CUSTOM_SUBMISSION_PATCH_INVALID", status: 400 });
      throw error;
    }
    return res.json(await assignCustomContentSubmission({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      submissionId: req.params.submissionId,
      customOrderId: req.body.customOrderId,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_SUBMISSION_UPDATE_FAILED"); }
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
    return res.json(await recordTelegramInboundReply({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      accountId: req.body?.accountId,
      deviceId: req.body?.deviceId,
      claimToken: req.body?.claimToken,
      senderTelegramUserId: req.body?.senderTelegramUserId,
      messageId: req.body?.messageId,
      replyToMessageId: req.body?.replyToMessageId,
      sentAt: req.body?.sentAt,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_INBOUND_FAILED"); }
});

router.post("/reminders/claim", async (req, res) => {
  try {
    return res.json(await claimDueReminders({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, deviceId: req.body?.deviceId, limit: req.body?.limit, db: prisma }));
  } catch (err) { return sendError(res, err, "CUSTOM_ORDER_REMINDER_CLAIM_FAILED"); }
});

router.patch("/:orderId", async (req, res) => {
  try { return res.json(await updateCustomOrder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, input: req.body || {}, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_UPDATE_FAILED"); }
});

router.post("/:orderId/telegram-task", async (req, res) => {
  try { return res.json(await prepareTelegramTask({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_PREPARE_FAILED"); }
});

router.post("/:orderId/telegram-delivery", async (req, res) => {
  try { return res.json(await recordTelegramDelivery({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, taskMessageId: req.body?.taskMessageId, referenceMessageIds: req.body?.referenceMessageIds, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_RECORD_FAILED"); }
});

router.post("/:orderId/telegram-status", async (req, res) => {
  try { return res.json(await prepareTelegramStatusNotification({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_STATUS_FAILED"); }
});

router.post("/:orderId/remind-now", async (req, res) => {
  try { return res.json(await prepareManualReminder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_REMIND_NOW_FAILED"); }
});

router.post("/:orderId/remind-now/ack", async (req, res) => {
  try { return res.json(await recordManualReminder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_REMIND_NOW_ACK_FAILED"); }
});

router.post("/:orderId/reminders/ack", async (req, res) => {
  try { return res.json(await acknowledgeReminder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, claimToken: req.body?.claimToken, messageId: req.body?.messageId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_REMINDER_ACK_FAILED"); }
});

router.post("/:orderId/reminders/fail", async (req, res) => {
  try { return res.json(await releaseReminderClaim({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, claimToken: req.body?.claimToken, retryable: req.body?.retryable !== false, deliveryUnknown: req.body?.deliveryUnknown === true, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_REMINDER_FAIL_FAILED"); }
});

module.exports = router;
