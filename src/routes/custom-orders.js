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
  armTelegramCustomUpload,
  recordTelegramCustomSubmission,
  prepareTelegramStatusNotification,
} = require("../services/custom-orders-service");
const {
  claimDueReminders,
  acknowledgeReminder,
  releaseReminderClaim,
} = require("../services/custom-order-reminders");

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

router.post("/", async (req, res) => {
  try { return res.status(201).json(await createCustomOrder({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, input: req.body || {}, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_CREATE_FAILED"); }
});

router.post("/telegram-inbound", async (req, res) => {
  try {
    return res.json(await recordTelegramInboundReply({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      accountId: req.body?.accountId,
      deviceId: req.body?.deviceId,
      claimToken: req.body?.claimToken,
      transport: req.body?.transport,
      senderTelegramUserId: req.body?.senderTelegramUserId,
      messageId: req.body?.messageId,
      replyToMessageId: req.body?.replyToMessageId,
      sentAt: req.body?.sentAt,
      db: prisma,
    }));
  } catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_INBOUND_FAILED"); }
});


router.post("/telegram-upload/arm", async (req, res) => {
  try { return res.json(await armTelegramCustomUpload({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, accountId: req.body?.accountId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, senderTelegramUserId: req.body?.senderTelegramUserId, uploadKey: req.body?.uploadKey, controlMessageId: req.body?.controlMessageId, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_UPLOAD_ARM_FAILED"); }
});

router.post("/telegram-upload/submission", async (req, res) => {
  try { return res.json(await recordTelegramCustomSubmission({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, accountId: req.body?.accountId, deviceId: req.body?.deviceId, claimToken: req.body?.claimToken, senderTelegramUserId: req.body?.senderTelegramUserId, messageIds: req.body?.messageIds, sentAt: req.body?.sentAt, db: prisma })); }
  catch (err) { return sendError(res, err, "CUSTOM_ORDER_TELEGRAM_SUBMISSION_FAILED"); }
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
  try { return res.json(await recordTelegramDelivery({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, orderId: req.params.orderId, taskMessageId: req.body?.taskMessageId, referenceMessageIds: req.body?.referenceMessageIds, transport: req.body?.transport, botControlMessageId: req.body?.botControlMessageId, db: prisma })); }
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
