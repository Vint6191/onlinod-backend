"use strict";

const express = require("express");
const { z } = require("zod");
const { requireProductCreator, requireProductDevice, requireProductPermission, currentAccessEpoch } = require("../middleware/product-access");
const {
  PRODUCT_WRITE_KINDS,
  ProgrammaticOfWriteAuthorityError,
  reserveProgrammaticWrite,
  startProgrammaticWrite,
  prepareProgrammaticWrite,
  checkpointProgrammaticWrite,
  completeProgrammaticWrite,
  failProgrammaticWrite,
  reconcileProgrammaticWrite,
  getProgrammaticWrite,
} = require("../services/programmatic-of-write-authority-service");

const router = express.Router();
const PUBLIC_RESERVE_KINDS = new Set(["MASS_QUEUE_CREATE", "VAULT_RELAY_SEND", "VAULT_CREATE_LIST"]);
const PUBLIC_LEASE_KINDS = new Set([...PUBLIC_RESERVE_KINDS, "CUSTOM_RELAY_SEND"]);
const leaseSchema = z.object({
  deviceId: z.string().min(1).max(180),
  leaseToken: z.string().min(20).max(500),
  leaseRevision: z.number().int().min(1),
});
function sendError(res, error, fallback = "PROGRAMMATIC_WRITE_FAILED") {
  const status = Number(error?.status);
  return res.status(Number.isFinite(status) && status >= 400 && status < 600 ? status : 500).json({ ok: false, code: error?.code || fallback, error: error?.message || "Programmatic write request failed" });
}
function actor(req) {
  const member = req.auth.membership || req.member;
  return { agencyId: req.auth.agencyId, userId: req.auth.userId, memberId: member.id, accessEpoch: currentAccessEpoch(req) };
}
async function publicKindAccess(req, kind, creatorId, deviceId) {
  const normalized = String(kind || "").trim().toUpperCase();
  const config = PRODUCT_WRITE_KINDS[normalized];
  if (!config || !PUBLIC_RESERVE_KINDS.has(normalized)) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_KIND_FORBIDDEN", "This write kind is not available through the public product authority API", 403);
  requireProductDevice(req, deviceId, { requiredCode: "PROGRAMMATIC_WRITE_DEVICE_REQUIRED", mismatchCode: "PROGRAMMATIC_WRITE_DEVICE_IDENTITY_MISMATCH" });
  await requireProductCreator(req, creatorId);
  if (config.permissionKey) await requireProductPermission(req, config.permissionKey, { code: "PROGRAMMATIC_WRITE_PERMISSION_FORBIDDEN" });
  return { normalized, config };
}
function publicKindDevice(req, kind, deviceId) {
  const normalized = String(kind || "").trim().toUpperCase();
  const config = PRODUCT_WRITE_KINDS[normalized];
  if (!config || !PUBLIC_LEASE_KINDS.has(normalized)) throw new ProgrammaticOfWriteAuthorityError("PROGRAMMATIC_WRITE_KIND_FORBIDDEN", "This write kind is not available through the public product authority API", 403);
  requireProductDevice(req, deviceId, { requiredCode: "PROGRAMMATIC_WRITE_DEVICE_REQUIRED", mismatchCode: "PROGRAMMATIC_WRITE_DEVICE_IDENTITY_MISMATCH" });
  return { normalized, config };
}

router.post("/reserve", async (req, res) => {
  try {
    const input = z.object({
      kind: z.string().min(1).max(80), creatorId: z.string().min(1).max(180), deviceId: z.string().min(1).max(180),
      idempotencyKey: z.string().min(1).max(500), payloadFingerprint: z.string().min(8).max(200),
      payload: z.record(z.unknown()).optional(), targetId: z.string().max(180).optional().nullable(), fanId: z.string().max(180).optional().nullable(), dialogId: z.string().max(180).optional().nullable(),
      leaseMs: z.number().int().min(30_000).max(10 * 60_000).optional(), maxAttempts: z.number().int().min(1).max(20).optional(),
    }).parse(req.body || {});
    const { normalized, config } = await publicKindAccess(req, input.kind, input.creatorId, input.deviceId);
    return res.json(await reserveProgrammaticWrite({ ...actor(req), ...input, kind: normalized, permissionKeyOverride: config.permissionKey }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "PROGRAMMATIC_WRITE_RESERVE_FAILED");
  }
});

for (const action of ["start", "prepare-write"]) {
  router.post(`/:writeId/${action}`, async (req, res) => {
    try {
      const input = leaseSchema.extend({ creatorId: z.string().min(1).max(180), kind: z.string().min(1).max(80) }).parse(req.body || {});
      const { normalized, config } = publicKindDevice(req, input.kind, input.deviceId);
      await requireProductCreator(req, input.creatorId);
      if (config.permissionKey) await requireProductPermission(req, config.permissionKey, { code: "PROGRAMMATIC_WRITE_PERMISSION_FORBIDDEN" });
      const fn = action === "start" ? startProgrammaticWrite : prepareProgrammaticWrite;
      return res.json(await fn({ ...actor(req), writeId: req.params.writeId, ...input, kind: normalized, permissionKey: config.permissionKey }));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
      return sendError(res, error, action === "start" ? "PROGRAMMATIC_WRITE_START_FAILED" : "PROGRAMMATIC_WRITE_PREPARE_FAILED");
    }
  });
}

router.post("/:writeId/checkpoint", async (req, res) => {
  try {
    const input = leaseSchema.extend({ creatorId: z.string().min(1).max(180), kind: z.string().min(1).max(80), result: z.record(z.unknown()) }).parse(req.body || {});
    const { normalized, config } = publicKindDevice(req, input.kind, input.deviceId);
    await requireProductCreator(req, input.creatorId);
    if (config.permissionKey) await requireProductPermission(req, config.permissionKey, { code: "PROGRAMMATIC_WRITE_PERMISSION_FORBIDDEN" });
    return res.json(await checkpointProgrammaticWrite({ ...actor(req), writeId: req.params.writeId, ...input, kind: normalized, permissionKey: config.permissionKey }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "PROGRAMMATIC_WRITE_CHECKPOINT_FAILED");
  }
});

router.post("/:writeId/complete", async (req, res) => {
  try {
    const input = leaseSchema.extend({ creatorId: z.string().min(1).max(180), kind: z.string().min(1).max(80), result: z.record(z.unknown()).optional(), messageId: z.string().max(180).optional().nullable() }).parse(req.body || {});
    const { normalized, config } = publicKindDevice(req, input.kind, input.deviceId);
    return res.json(await completeProgrammaticWrite({ ...actor(req), writeId: req.params.writeId, ...input, kind: normalized, permissionKey: config.permissionKey }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "PROGRAMMATIC_WRITE_COMPLETE_FAILED");
  }
});

router.post("/:writeId/fail", async (req, res) => {
  try {
    const input = leaseSchema.extend({ creatorId: z.string().min(1).max(180), kind: z.string().min(1).max(80), failureCode: z.string().min(1).max(120), error: z.string().max(2000).optional(), retryAfterMs: z.number().int().min(0).max(60 * 60_000).optional(), facts: z.record(z.unknown()).optional() }).parse(req.body || {});
    const { normalized, config } = publicKindDevice(req, input.kind, input.deviceId);
    return res.json(await failProgrammaticWrite({ ...actor(req), writeId: req.params.writeId, ...input, kind: normalized, permissionKey: config.permissionKey }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "PROGRAMMATIC_WRITE_FAIL_FAILED");
  }
});

router.post("/:writeId/reconcile", async (req, res) => {
  try {
    const input = leaseSchema.extend({
      creatorId: z.string().min(1).max(180),
      kind: z.string().min(1).max(80),
      outcome: z.enum(["MATCHED", "PROVEN_NO_EFFECT", "WAIT_FOR_READBACK"]),
      result: z.record(z.unknown()).optional(),
    }).parse(req.body || {});
    const { normalized, config } = publicKindDevice(req, input.kind, input.deviceId);
    await requireProductCreator(req, input.creatorId);
    if (config.permissionKey) await requireProductPermission(req, config.permissionKey, { code: "PROGRAMMATIC_WRITE_PERMISSION_FORBIDDEN" });
    return res.json(await reconcileProgrammaticWrite({ ...actor(req), writeId: req.params.writeId, ...input, kind: normalized, permissionKey: config.permissionKey }));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues?.[0]?.message || "Validation error" });
    return sendError(res, error, "PROGRAMMATIC_WRITE_RECONCILE_FAILED");
  }
});

router.get("/:creatorId/:writeId", async (req, res) => {
  try {
    await requireProductCreator(req, req.params.creatorId);
    return res.json(await getProgrammaticWrite({ ...actor(req), creatorId: req.params.creatorId, writeId: req.params.writeId }));
  } catch (error) { return sendError(res, error, "PROGRAMMATIC_WRITE_GET_FAILED"); }
});

module.exports = router;
