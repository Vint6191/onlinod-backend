"use strict";

const express = require("express");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { creatorManagementRequired } = require("../middleware/creator-management-permissions");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const { publishCreatorSessionRevision, waitForCreatorSessionRevisionEvents } = require("../services/creator-session-revision-events");
const {
  assertCreatorSessionTargetActive,
  getCreatorSession,
  writeCreatorSession,
} = require("../services/creator-session-broker-service");
const { revokeCreatorConnection } = require("../services/creator-enrollment-authority-service");

const router = express.Router();
router.use(authRequired);

const deviceIdSchema = z.string().trim().min(1).max(180);
const requestIdSchema = z.string().trim().min(8).max(180);
const eventCursorSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const eventWaitSchema = z.coerce.number().int().min(250).max(25_000).default(20_000);

const writeCommon = {
  deviceId: deviceIdSchema,
  baseRevision: z.number().int().min(0),
  requestId: requestIdSchema,
  capturedAt: z.string().datetime().optional(),
  platformUserId: z.string().trim().min(1).max(160),
};

const opaquePayloadSchema = z.object({
  encryptionMode: z.literal("CLIENT_E2E_V1"),
  keyVersion: z.number().int().positive(),
  ciphertext: z.string().trim().min(1).max(700_000),
  iv: z.string().trim().min(1).max(128),
  tag: z.string().trim().min(1).max(128),
  algorithm: z.literal("aes-256-gcm-client-e2e-v1"),
}).strict();

const writeSchema = z.object({
  ...writeCommon,
  opaquePayload: opaquePayloadSchema,
  credentialHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  coherenceHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  portableReady: z.boolean().optional().default(false),
}).strict();

const revokeSchema = z.object({
  deviceId: deviceIdSchema,
  baseRevision: z.number().int().min(0),
  requestId: requestIdSchema,
  reason: z.string().trim().max(500).optional().nullable(),
}).strict();

async function authorize(req, creatorId, deviceId, { requireActive = true } = {}) {
  const boundDeviceId = requireAuthDevice(req, deviceId, {
    requiredCode: "CREATOR_SESSION_DEVICE_BOUND_TOKEN_REQUIRED",
    mismatchCode: "CREATOR_SESSION_AUTH_DEVICE_MISMATCH",
  });
  const creator = await requireCreatorAccess({
    agencyId: req.auth.agencyId,
    member: req.auth.membership || req.member,
    creatorId,
    db: prisma,
  });
  if (requireActive) assertCreatorSessionTargetActive(creator);
  // The signed access token is the request-level logical-device authority.
  // Do not consult WorkerDevice here: it is mutable telemetry and can point at
  // another workspace on the same physical PC. CLIENT_E2E_V1 operations are
  // additionally fenced in the broker service by immutable DeviceCryptoIdentity
  // + user + current AMK/CDK enrollment. V20.22 cutover is CLIENT_E2E_V1-only:
  // there is no bearer-authorized legacy secret path left in normal runtime.
  return { creator, device: { id: boundDeviceId } };
}


async function filterAuthorizedRevisionEvents(req, events) {
  const allowed = [];
  for (const event of events) {
    try {
      await requireCreatorAccess({
        agencyId: req.auth.agencyId,
        member: req.auth.membership || req.member,
        creatorId: event.creatorId,
        db: prisma,
      });
      allowed.push(event);
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 403 || status === 404) continue;
      throw error;
    }
  }
  return allowed;
}

function publishRevisionHint(input) {
  try {
    publishCreatorSessionRevision(input);
  } catch (error) {
    // Hint delivery must never turn an already committed canonical CAS write
    // into an apparent failure. The 30s creator heartbeat remains the repair
    // path if this in-memory transport is unavailable.
    console.error("[creator-sessions/revision-hint] failed:", error);
  }
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


router.get("/events", async (req, res) => {
  try {
    requireAuthDevice(req, deviceIdSchema.parse(req.query.deviceId), {
      requiredCode: "CREATOR_SESSION_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "CREATOR_SESSION_AUTH_DEVICE_MISMATCH",
    });
    const afterSeq = eventCursorSchema.parse(req.query.afterSeq ?? 0);
    const waitMs = eventWaitSchema.parse(req.query.waitMs ?? 20_000);
    const clientStreamId = typeof req.query.streamId === "string" ? req.query.streamId.trim().slice(0, 180) : "";
    const result = await waitForCreatorSessionRevisionEvents({
      agencyId: req.auth.agencyId,
      streamId: clientStreamId || null,
      afterSeq,
      waitMs,
    });
    const events = await filterAuthorizedRevisionEvents(req, result.events);
    return res.json({ ok: true, streamId: result.streamId, cursor: result.cursor, events });
  } catch (error) {
    if (!error?.issues && Number(error?.status || 0) >= 500) console.error("[creator-sessions/events] failed:", error);
    return sendError(res, error, "CREATOR_SESSION_EVENTS_FAILED");
  }
});

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
      deviceId: device.id,
      member: req.auth.membership || req.member,
      userId: req.auth.userId,
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
      actorMember: req.auth.membership || req.member,
      deviceId: device.id,
      baseRevision: input.baseRevision,
      requestId: input.requestId,
      capturedAt: input.capturedAt,
      platformUserId: input.platformUserId,
      opaquePayload: input.opaquePayload,
      credentialHash: input.credentialHash,
      coherenceHash: input.coherenceHash,
      portableReady: input.portableReady,
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
    if (!result.idempotent && !result.unchanged) {
      publishRevisionHint({
        agencyId: req.auth.agencyId,
        creatorId: creator.id,
        revision: result.state.revision,
        status: result.state.status,
        sourceDeviceId: device.id,
        requestId: input.requestId,
      });
    }
    return res.json({ ok: true, creatorId: creator.id, ...result });
  } catch (error) {
    if (!error?.issues && Number(error?.status || 0) >= 500) console.error("[creator-sessions/write] failed:", error);
    return sendError(res, error, "CREATOR_SESSION_WRITE_FAILED");
  }
});

router.post("/:creatorId/revoke", creatorManagementRequired, async (req, res) => {
  try {
    const input = revokeSchema.parse(req.body || {});
    const { creator, device } = await authorize(req, req.params.creatorId, input.deviceId, { requireActive: false });
    const result = await revokeCreatorConnection({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      userId: req.auth.userId,
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
    if (!result.idempotent && !result.unchanged) {
      publishRevisionHint({
        agencyId: req.auth.agencyId,
        creatorId: creator.id,
        revision: result.state.revision,
        status: result.state.status,
        sourceDeviceId: device.id,
        requestId: input.requestId,
      });
    }
    return res.json({ ok: true, creatorId: creator.id, ...result });
  } catch (error) {
    if (!error?.issues && Number(error?.status || 0) >= 500) console.error("[creator-sessions/revoke] failed:", error);
    return sendError(res, error, "CREATOR_SESSION_REVOKE_FAILED");
  }
});

module.exports = router;
