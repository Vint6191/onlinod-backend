"use strict";

const express = require("express");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const {
  requireRegisteredDevice,
  assertCreatorSessionTargetActive,
  getCreatorSession,
  writeCreatorSession,
  revokeCreatorSession,
} = require("../services/creator-session-broker-service");

const router = express.Router();
router.use(authRequired);

const deviceIdSchema = z.string().trim().min(1).max(180);
const requestIdSchema = z.string().trim().min(8).max(180);

const cookieSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().max(32_768),
  domain: z.string().min(1).max(512),
  hostOnly: z.boolean().optional().nullable(),
  path: z.string().max(2048).optional().nullable(),
  secure: z.boolean().optional().nullable(),
  httpOnly: z.boolean().optional().nullable(),
  sameSite: z.string().max(32).optional().nullable(),
  expirationDate: z.number().finite().positive().optional().nullable(),
  session: z.boolean().optional().nullable(),
}).strict();

const payloadSchema = z.object({
  cookies: z.array(cookieSchema).min(1).max(256),
  storage: z.object({
    bcTokenSha: z.string().max(16_384).optional().nullable(),
  }).strict().optional().default({}),
  userAgent: z.string().max(2048).optional().nullable(),
}).strict();

const writeSchema = z.object({
  deviceId: deviceIdSchema,
  baseRevision: z.number().int().min(0),
  requestId: requestIdSchema,
  capturedAt: z.string().datetime().optional(),
  platformUserId: z.string().trim().min(1).max(160),
  payload: payloadSchema,
}).strict();

const revokeSchema = z.object({
  deviceId: deviceIdSchema,
  baseRevision: z.number().int().min(0),
  requestId: requestIdSchema,
  reason: z.string().trim().max(500).optional().nullable(),
}).strict();

async function authorize(req, creatorId, deviceId, { requireActive = true } = {}) {
  const creator = await requireCreatorAccess({
    agencyId: req.auth.agencyId,
    member: req.auth.membership || req.member,
    creatorId,
    db: prisma,
  });
  if (requireActive) assertCreatorSessionTargetActive(creator);
  const device = await requireRegisteredDevice({
    db: prisma,
    agencyId: req.auth.agencyId,
    userId: req.auth.userId,
    deviceId,
  });
  return { creator, device };
}

function sendError(res, error, fallbackCode) {
  if (error?.issues) {
    return res.status(400).json({
      ok: false,
      code: "VALIDATION_ERROR",
      error: error.issues[0]?.message || "Validation error",
      issues: error.issues,
    });
  }
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    ok: false,
    code: error?.code || fallbackCode,
    error: error?.message || "Creator session request failed",
    ...(error?.current ? { current: error.current } : {}),
  });
}

router.get("/:creatorId", async (req, res) => {
  try {
    const deviceId = deviceIdSchema.parse(req.query.deviceId);
    const { creator, device } = await authorize(req, req.params.creatorId, deviceId);
    const includePayload = String(req.query.includePayload ?? "0").trim() === "1";
    const state = await getCreatorSession({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      includePayload,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator_session.read",
      targetType: "creator_session",
      targetId: creator.id,
      metadata: { creatorId: creator.id, deviceId: device.id, revision: state.revision, status: state.status },
    });
    return res.json({ ok: true, creatorId: creator.id, state });
  } catch (error) {
    if (!error?.issues && Number(error?.status || 0) >= 500) console.error("[creator-sessions/get] failed:", error);
    return sendError(res, error, "CREATOR_SESSION_READ_FAILED");
  }
});

router.post("/:creatorId", async (req, res) => {
  try {
    const input = writeSchema.parse(req.body || {});
    const { creator, device } = await authorize(req, req.params.creatorId, input.deviceId);
    const result = await writeCreatorSession({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      actorUserId: req.auth.userId,
      deviceId: device.id,
      baseRevision: input.baseRevision,
      requestId: input.requestId,
      capturedAt: input.capturedAt,
      platformUserId: input.platformUserId,
      payload: input.payload,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: result.unchanged ? "creator_session.write_unchanged" : "creator_session.write",
      targetType: "creator_session",
      targetId: creator.id,
      metadata: {
        creatorId: creator.id,
        deviceId: device.id,
        revision: result.state.revision,
        status: result.state.status,
        idempotent: result.idempotent,
        unchanged: result.unchanged,
      },
    });
    return res.json({ ok: true, creatorId: creator.id, ...result });
  } catch (error) {
    if (!error?.issues && Number(error?.status || 0) >= 500) console.error("[creator-sessions/write] failed:", error);
    return sendError(res, error, "CREATOR_SESSION_WRITE_FAILED");
  }
});

router.post("/:creatorId/revoke", async (req, res) => {
  try {
    const input = revokeSchema.parse(req.body || {});
    const { creator, device } = await authorize(req, req.params.creatorId, input.deviceId, { requireActive: false });
    const result = await revokeCreatorSession({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      actorUserId: req.auth.userId,
      deviceId: device.id,
      baseRevision: input.baseRevision,
      requestId: input.requestId,
      reason: input.reason,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator_session.revoke",
      targetType: "creator_session",
      targetId: creator.id,
      metadata: {
        creatorId: creator.id,
        deviceId: device.id,
        revision: result.state.revision,
        status: result.state.status,
        idempotent: result.idempotent,
        unchanged: result.unchanged,
      },
    });
    return res.json({ ok: true, creatorId: creator.id, ...result });
  } catch (error) {
    if (!error?.issues && Number(error?.status || 0) >= 500) console.error("[creator-sessions/revoke] failed:", error);
    return sendError(res, error, "CREATOR_SESSION_REVOKE_FAILED");
  }
});

module.exports = router;
