"use strict";

const express = require("express");
const { z } = require("zod");
const { settleTelegramDeliveryWithClaim } = require("../services/telegram-delivery-authority-service");
const router = express.Router();
const receipt = z.object({
  authorityVersion: z.literal("TELEGRAM_COMMIT_RECEIPT_V1"),
  deviceId: z.string().min(1).max(180), claimToken: z.string().min(20).max(500),
  creatorId: z.string().min(1).max(180), accountId: z.string().min(1).max(180), kind: z.string().min(1).max(40),
  outcome: z.enum(["CONFIRMED", "UNKNOWN"]),
  remoteMessageId: z.string().regex(/^[1-9]\d*$/).max(20).optional().nullable(),
  remoteRecipientTelegramUserId: z.string().regex(/^\d{1,20}$/).optional().nullable(),
  remoteSentAt: z.string().datetime().optional().nullable(), reason: z.string().max(500).optional().nullable(),
}).strict();

// Deliberately no JWT or billing admission: the original commit capability can
// only checkpoint the already-authorized request. It cannot plan, claim, begin,
// mark not-sent, fetch private material, or return order/payload details.
router.post("/:intentId", async (req, res) => {
  try {
    const { authorityVersion: _version, ...input } = receipt.parse(req.body || {});
    return res.json(await settleTelegramDeliveryWithClaim({ ...input, intentId: req.params.intentId }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: "Invalid Telegram receipt" });
    const status = Number(error?.status);
    if (!Number.isInteger(status) || status < 400 || status >= 500) {
      return res.status(500).json({ ok: false, code: "TELEGRAM_DELIVERY_SETTLEMENT_FAILED", error: "Telegram receipt settlement failed" });
    }
    return res.status(status).json({
      ok: false, code: error?.code || "TELEGRAM_DELIVERY_SETTLEMENT_FAILED", error: error?.message || "Telegram receipt settlement failed",
    });
  }
});

module.exports = router;
