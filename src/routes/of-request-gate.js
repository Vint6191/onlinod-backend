"use strict";

const express = require("express");
const { z } = require("zod");
const { requireAuthDevice } = require("../middleware/auth");
const {
  acquireOfRequestSlot,
  acknowledgeOfRequestStarted,
  cancelOfRequestPermit,
  getOfRequestGateSnapshot,
  DEFAULT_INTERVAL_MS,
} = require("../services/of-request-gate-service");

const router = express.Router();
const scopeSchema = z.object({
  deviceId: z.string().min(1).max(200),
  creatorId: z.string().min(1).max(200),
});
const acquireSchema = scopeSchema.extend({
  priority: z.enum(["critical_write", "interactive", "realtime", "normal", "background"]),
  operation: z.string().min(1).max(160),
  source: z.string().max(240).optional().nullable(),
  timeoutMs: z.number().int().min(5_000).max(60_000).optional(),
});
const permitSchema = scopeSchema.extend({ permitId: z.string().min(1).max(200) });

function authUserId(req) { return req.auth?.userId || req.user?.id; }
function validationError(res, error) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: error.issues?.[0]?.message || "Validation error",
  });
}
function serviceError(res, next, error) {
  if (error instanceof z.ZodError) return validationError(res, error);
  if (error?.status) return res.status(error.status).json({ ok: false, code: error.code || "OF_GATE_FAILED", error: error.message });
  return next(error);
}

router.post("/acquire", async (req, res, next) => {
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  req.once("aborted", onClose);
  res.once("close", onClose);
  try {
    const input = acquireSchema.parse(req.body);
    const deviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "OF_GATE_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "OF_GATE_DEVICE_IDENTITY_MISMATCH",
    });
    const permit = await acquireOfRequestSlot({
      userId: authUserId(req),
      agencyId: req.auth?.agencyId,
      member: req.auth?.membership || req.member,
      ...input,
      deviceId,
      intervalMs: DEFAULT_INTERVAL_MS,
      signal: controller.signal,
    });
    if (!res.writableEnded) return res.json({ ok: true, ...permit });
  } catch (error) {
    if (res.writableEnded || controller.signal.aborted) return;
    return serviceError(res, next, error);
  } finally {
    req.removeListener("aborted", onClose);
    res.removeListener("close", onClose);
  }
});

// Called immediately after Desktop initiates the actual OF transport. The next
// permit cannot be granted until this acknowledgement plus 700ms.
router.post("/started", async (req, res, next) => {
  try {
    const input = permitSchema.parse(req.body);
    const deviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "OF_GATE_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "OF_GATE_DEVICE_IDENTITY_MISMATCH",
    });
    const started = await acknowledgeOfRequestStarted({
      userId: authUserId(req),
      agencyId: req.auth?.agencyId,
      member: req.auth?.membership || req.member,
      ...input,
      deviceId,
    });
    return res.json({ ok: true, ...started });
  } catch (error) {
    return serviceError(res, next, error);
  }
});

router.post("/cancel", async (req, res, next) => {
  try {
    const input = permitSchema.parse(req.body);
    const deviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "OF_GATE_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "OF_GATE_DEVICE_IDENTITY_MISMATCH",
    });
    const result = await cancelOfRequestPermit({
      userId: authUserId(req),
      agencyId: req.auth?.agencyId,
      member: req.auth?.membership || req.member,
      ...input,
      deviceId,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return serviceError(res, next, error);
  }
});

router.get("/status", (_req, res) => res.json({ ok: true, ...getOfRequestGateSnapshot() }));

module.exports = router;
