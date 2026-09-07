"use strict";

const express = require("express");
const { z } = require("zod");
const {
  ProgrammaticOfWriteAuthorityError,
  completeNativeMassWriteWithSettlementToken,
  settleNativeMassWriteProvenNoEffect,
} = require("../services/programmatic-of-write-authority-service");
const { settleCustomManualDeliveryWithCapability } = require("../services/custom-content-delivery-tracking-service");

const router = express.Router();

function sendError(res, error, fallback = "MASS_NATIVE_SETTLEMENT_FAILED") {
  const status = Number(error?.status);
  return res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    code: error?.code || fallback,
    error: error?.message || "Native MASS settlement failed",
  });
}

// Settlement-only capability endpoint. The random replay-safe capability is minted
// only after the authenticated preflight has durably crossed COMMITTING. This
// endpoint cannot authorize or create a new external write; it can only attach
// the exact provider response to that already-authorized physical request. It is
// intentionally outside authRequired so logout/member retirement racing a 2xx
// cannot erase an external fact that has already happened.
router.post("/mass-native/:writeId/complete", async (req, res) => {
  try {
    const input = z.object({
      authorityVersion: z.literal("MASS_NATIVE_V3"),
      settlementToken: z.string().min(20).max(500),
      deviceId: z.string().min(1).max(180),
      requestKey: z.string().min(3).max(500),
      queueId: z.string().min(1).max(180),
      writeCommitRevision: z.number().int().min(1),
      kind: z.enum(["MASS_NATIVE_QUEUE_CREATE", "MASS_NATIVE_QUEUE_CANCEL"]).optional(),
    }).parse(req.body || {});
    return res.json(await completeNativeMassWriteWithSettlementToken({
      ...input,
      writeId: req.params.writeId,
      expectedKind: input.kind || null,
    }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    if (error instanceof ProgrammaticOfWriteAuthorityError) return sendError(res, error);
    return sendError(res, error);
  }
});


router.post("/mass-native/:writeId/reject", async (req, res) => {
  try {
    const input = z.object({
      authorityVersion: z.literal("MASS_NATIVE_V3"), settlementToken: z.string().min(20).max(500), deviceId: z.string().min(1).max(180),
      requestKey: z.string().min(3).max(500), writeCommitRevision: z.number().int().min(1), providerStatus: z.number().int().min(400).max(499),
    }).parse(req.body || {});
    return res.json(await settleNativeMassWriteProvenNoEffect({ ...input, writeId: req.params.writeId }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error);
  }
});

router.post("/custom-manual/:writeId/settle", async (req, res) => {
  try {
    const input = z.object({
      authorityVersion: z.literal("CUSTOM_MANUAL_V2"), settlementToken: z.string().min(20).max(500), deviceId: z.string().min(1).max(180),
      networkRequestId: z.string().min(1).max(220), writeCommitRevision: z.number().int().min(1),
      outcome: z.enum(["PROVEN_SUCCESS", "PROVEN_NO_EFFECT"]), providerStatus: z.number().int().min(100).max(599),
      messageId: z.string().min(1).max(220).optional().nullable(), occurredAt: z.string().datetime().optional().nullable(),
    }).parse(req.body || {});
    return res.json(await settleCustomManualDeliveryWithCapability({ ...input, writeId: req.params.writeId }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "CUSTOM_MANUAL_SETTLEMENT_FAILED");
  }
});

module.exports = router;
