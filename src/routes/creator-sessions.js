"use strict";

const express = require("express");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const {
  assertCreatorSessionTargetActive,
  getCreatorSession,
  migrateCreatorSessionToOpaque,
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

const legacyWriteSchema = z.object({ ...writeCommon, payload: payloadSchema }).strict();
const opaqueWriteSchema = z.object({
  ...writeCommon,
  opaquePayload: opaquePayloadSchema,
  credentialHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  coherenceHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
}).strict();
const writeSchema = z.union([opaqueWriteSchema, legacyWriteSchema]);
const migrateOpaqueSchema = z.object({
  deviceId: deviceIdSchema,
  expectedRevision: z.number().int().positive(),
  platformUserId: z.string().trim().min(1).max(160),
  credentialHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  coherenceHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  opaquePayload: opaquePayloadSchema,
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
  // + user + current AMK/CDK enrollment. Legacy SERVER_V1 remains normal bearer
  // authorization during the migration window.
  return { creator, device: { id: boundDeviceId } };
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

router.post("/:creatorId/migrate-opaque", async (req, res) => {
  try {
    const input = migrateOpaqueSchema.parse(req.body || {});
    const { creator, device } = await authorize(req, req.params.creatorId, input.deviceId);
    const result = await migrateCreatorSessionToOpaque({
      db: prisma, agencyId: req.auth.agencyId, creatorId: creator.id, deviceId: device.id, member: req.auth.membership || req.member,
      expectedRevision: input.expectedRevision, platformUserId: input.platformUserId, credentialHash: input.credentialHash, coherenceHash: input.coherenceHash, opaquePayload: input.opaquePayload,
    });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "creator_session.migrated_client_e2e", targetType: "creator_session", targetId: creator.id, metadata: { creatorId: creator.id, deviceId: device.id, revision: result.state.revision, keyVersion: result.state.keyVersion, migrated: result.migrated } });
    return res.json({ ok: true, creatorId: creator.id, ...result });
  } catch (error) { return sendError(res, error, "CREATOR_SESSION_MIGRATION_FAILED"); }
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
      ...("opaquePayload" in input
        ? { opaquePayload: input.opaquePayload, credentialHash: input.credentialHash, coherenceHash: input.coherenceHash }
        : { payload: input.payload }),
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
