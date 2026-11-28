"use strict";

const express = require("express");
const { z } = require("zod");
const { AUTHORITY_VERSION, completeActionMessageWithSettlementToken } = require("../services/automation-message-settlement-service");
const { AUTHORITY_VERSION: COMMENT_AUTHORITY_VERSION, completeActionCommentWithSettlementToken } = require("../services/automation-comment-settlement-service");
const router = express.Router();
const receiptSchema = z.object({
  authorityVersion: z.literal(AUTHORITY_VERSION),
  deviceId: z.string().min(1).max(180),
  operationId: z.string().min(1).max(500),
  writeCommitRevision: z.number().int().min(1),
  settlementToken: z.string().min(20).max(500),
  messageId: z.string().min(1).max(160),
  sentAt: z.string().datetime({ offset: true }),
}).strict();

// A narrow post-commit capability remains usable after logout or lease expiry.
// It only attaches an exact provider ACK to the already-authorized operation.
router.post("/:deliveryId/complete", async (req, res) => {
  try {
    const input = receiptSchema.parse(req.body || {});
    return res.json(await completeActionMessageWithSettlementToken({ ...input, deliveryId: req.params.deliveryId }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: "Invalid message receipt" });
    const status = Number(error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 500).json({
      ok: false, code: error?.code || "ACTION_MESSAGE_SETTLEMENT_FAILED",
      error: status >= 400 && status < 500 ? error.message : "Message receipt settlement failed",
    });
  }
});

const commentReceiptSchema = z.object({
  authorityVersion: z.literal(COMMENT_AUTHORITY_VERSION),
  deviceId: z.string().min(1).max(180),
  operationId: z.string().min(1).max(500),
  writeCommitRevision: z.number().int().min(1),
  settlementToken: z.string().min(20).max(500),
  postId: z.string().min(1).max(160),
  commentId: z.string().min(1).max(160),
  commentedAt: z.string().datetime({ offset: true }),
  providerStatus: z.number().int().min(200).max(299),
}).strict();

router.post("/:deliveryId/comment-complete", async (req, res) => {
  try {
    const input = commentReceiptSchema.parse(req.body || {});
    return res.json(await completeActionCommentWithSettlementToken({ ...input, deliveryId: req.params.deliveryId }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: "Invalid comment receipt" });
    const status = Number(error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 500).json({
      ok: false, code: error?.code || "ACTION_COMMENT_SETTLEMENT_FAILED",
      error: status >= 400 && status < 500 ? error.message : "Comment receipt settlement failed",
    });
  }
});

module.exports = router;
