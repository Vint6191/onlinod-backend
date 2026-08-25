"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const {
  registerDeviceIdentity,
  initializeAgencyCryptoRoot,
  getCryptoStatus,
  listCryptoDevices,
  getCryptoSecurityDebt,
  getRecoveryEnvelope,
  recoverOwnerDevice,
  pendingDevices,
  getDeviceApprovalPlan,
  approveDevice,
  getCreatorKeyState,
  initializeCreatorKeyState,
  getDeviceRevocationPlan,
  getRootRotationPlan,
  beginRootRotation,
  getRootRotationBridge,
  getRootRotationProgress,
  finalizeRootRotation,
  getCreatorRotationPlan,
  commitCreatorKeyRotation,
  retireCurrentDeviceIdentity,
  softRevokeDevice,
} = require("../services/client-e2e-keyring-service");

const router = express.Router();
router.use(authRequired);

const deviceId = z.string().trim().min(1).max(180);
const publicKey = z.string().trim().min(16).max(4096);
const recoveryProof = z.string().trim().min(40).max(128);
const actorProof = recoveryProof;
const wrapEnvelope = z.object({
  ephemeralPublicKey: z.string().trim().min(16).max(4096),
  ciphertext: z.string().trim().min(16).max(4096),
  iv: z.string().trim().min(8).max(256),
  tag: z.string().trim().min(8).max(256),
  algorithm: z.literal("x25519-hkdf-sha256-aes-256-gcm-v1"),
}).strict();
const recoveryEnvelope = z.object({
  ciphertext: z.string().trim().min(16).max(4096),
  iv: z.string().trim().min(8).max(256),
  tag: z.string().trim().min(8).max(256),
  algorithm: z.literal("aes-256-gcm-recovery-v1"),
}).strict();
const rootBridgeEnvelope = z.object({
  ciphertext: z.string().trim().min(16).max(4096),
  iv: z.string().trim().min(8).max(256),
  tag: z.string().trim().min(8).max(256),
  algorithm: z.literal("aes-256-gcm-root-bridge-v1"),
}).strict();

const creatorSecretEnvelope = z.object({
  encryptionMode: z.literal("CLIENT_E2E_V1"),
  keyVersion: z.number().int().positive(),
  ciphertext: z.string().trim().min(1).max(1_500_000),
  iv: z.string().trim().min(8).max(256),
  tag: z.string().trim().min(8).max(256),
  algorithm: z.literal("aes-256-gcm-client-e2e-v1"),
}).strict();

function fail(res, error, fallback) {
  if (error?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues[0]?.message || "Validation error", issues: error.issues });
  return res.status(Number(error?.status) || 500).json({
    ok: false,
    code: error?.code || fallback,
    error: error?.message || "Encryption key request failed",
    ...(error?.current ? { current: error.current } : {}),
    ...(error?.creatorId ? { creatorId: error.creatorId } : {}),
    ...(Number.isInteger(error?.currentVersion) ? { currentVersion: error.currentVersion } : {}),
    ...(Number.isInteger(error?.pendingCreatorCount) ? { pendingCreatorCount: error.pendingCreatorCount } : {}),
  });
}

function actor(req) {
  return {
    agencyId: req.auth.agencyId,
    userId: req.auth.userId,
    member: req.auth.membership || req.member,
  };
}

function actorDevice(req, suppliedDeviceId) {
  return requireAuthDevice(req, suppliedDeviceId, {
    requiredCode: "CRYPTO_AUTH_DEVICE_BOUND_TOKEN_REQUIRED",
    mismatchCode: "CRYPTO_AUTH_DEVICE_MISMATCH",
  });
}

router.put("/device-identity", async (req, res) => {
  try {
    const input = z.object({ deviceId, publicKey }).strict().parse(req.body || {});
    const boundDeviceId = actorDevice(req, input.deviceId);
    const result = await registerDeviceIdentity({ db: prisma, ...actor(req), deviceId: boundDeviceId, publicKey: input.publicKey });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: result.idempotent ? "crypto.device_identity_seen" : "crypto.device_identity_registered",
      targetType: "worker_device",
      targetId: input.deviceId,
      metadata: { fingerprint: result.identity.fingerprint, status: result.identity.status, idempotent: result.idempotent },
    });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICE_IDENTITY_FAILED"); }
});


router.post("/device-identity/retire-self", async (req, res) => {
  try {
    const input = z.object({ deviceId }).strict().parse(req.body || {});
    const boundDeviceId = actorDevice(req, input.deviceId);
    const result = await retireCurrentDeviceIdentity({ db: prisma, ...actor(req), deviceId: boundDeviceId });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "crypto.device_identity_self_retired",
      targetType: "worker_device",
      targetId: result.deviceId,
      metadata: {
        targetHadOwnerRoot: result.targetHadOwnerRoot,
        affectedCreatorIds: result.affectedCreatorIds,
        rootRotationRequired: result.rootRotationRequired,
        creatorRotationRequired: result.creatorRotationRequired,
        idempotent: result.idempotent,
      },
    });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICE_SELF_RETIRE_FAILED"); }
});

router.get("/status", async (req, res) => {
  try {
    const id = deviceId.parse(req.query.deviceId);
    const state = await getCryptoStatus({ db: prisma, ...actor(req), deviceId: actorDevice(req, id) });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, ...state });
  } catch (error) { return fail(res, error, "CRYPTO_STATUS_FAILED"); }
});

router.get("/devices", async (req, res) => {
  try {
    const devices = await listCryptoDevices({ db: prisma, ...actor(req) });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, devices });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICES_FAILED"); }
});

router.get("/security-debt", async (req, res) => {
  try {
    const securityDebt = await getCryptoSecurityDebt({ db: prisma, ...actor(req) });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, securityDebt });
  } catch (error) { return fail(res, error, "CRYPTO_SECURITY_DEBT_FAILED"); }
});

router.post("/initialize", async (req, res) => {
  try {
    const input = z.object({ deviceId, recoveryEnvelope, ownerWrap: wrapEnvelope, recoveryProof }).strict().parse(req.body || {});
    const boundDeviceId = actorDevice(req, input.deviceId);
    const result = await initializeAgencyCryptoRoot({ db: prisma, ...actor(req), deviceId: boundDeviceId, recoveryEnvelope: input.recoveryEnvelope, ownerWrap: input.ownerWrap, recoveryProof: input.recoveryProof });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "crypto.root_initialized", targetType: "agency_crypto_root", targetId: req.auth.agencyId, metadata: { rootVersion: result.root.version, deviceId: input.deviceId } });
    return res.status(201).json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_INITIALIZE_FAILED"); }
});

router.get("/recovery-envelope", async (req, res) => {
  try {
    const envelope = await getRecoveryEnvelope({ db: prisma, ...actor(req) });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, envelope });
  } catch (error) { return fail(res, error, "CRYPTO_RECOVERY_ENVELOPE_FAILED"); }
});

router.post("/recover-owner-device", async (req, res) => {
  try {
    const input = z.object({ deviceId, rootVersion: z.number().int().positive(), ownerWrap: wrapEnvelope, recoveryProof }).strict().parse(req.body || {});
    const boundDeviceId = actorDevice(req, input.deviceId);
    const result = await recoverOwnerDevice({ db: prisma, ...actor(req), deviceId: boundDeviceId, rootVersion: input.rootVersion, ownerWrap: input.ownerWrap, recoveryProof: input.recoveryProof });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "crypto.owner_device_recovered", targetType: "worker_device", targetId: input.deviceId, metadata: { rootVersion: result.root.version } });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_RECOVERY_FAILED"); }
});

router.get("/pending-devices", async (req, res) => {
  try {
    const devices = await pendingDevices({ db: prisma, ...actor(req) });
    return res.json({ ok: true, devices });
  } catch (error) { return fail(res, error, "CRYPTO_PENDING_DEVICES_FAILED"); }
});

router.get("/devices/:deviceId/approval-plan", async (req, res) => {
  try {
    const plan = await getDeviceApprovalPlan({ db: prisma, ...actor(req), targetDeviceId: deviceId.parse(req.params.deviceId) });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, plan });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICE_APPROVAL_PLAN_FAILED"); }
});

router.post("/devices/:deviceId/approve", async (req, res) => {
  try {
    const input = z.object({
      approverDeviceId: deviceId,
      expectedRootVersion: z.number().int().positive(),
      actorProof,
      ownerWrap: wrapEnvelope.optional().nullable(),
      creatorWraps: z.array(z.object({ creatorId: z.string().trim().min(1).max(180), keyVersion: z.number().int().positive(), rootVersion: z.number().int().positive(), envelope: wrapEnvelope }).strict()).max(10000).optional().default([]),
    }).strict().parse(req.body || {});
    const approverDeviceId = actorDevice(req, input.approverDeviceId);
    const result = await approveDevice({ db: prisma, ...actor(req), approverDeviceId, targetDeviceId: deviceId.parse(req.params.deviceId), expectedRootVersion: input.expectedRootVersion, actorProof: input.actorProof, ownerWrap: input.ownerWrap || null, creatorWraps: input.creatorWraps });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "crypto.device_approved", targetType: "worker_device", targetId: result.targetDeviceId, metadata: { approverDeviceId: input.approverDeviceId, targetIsOwner: result.targetIsOwner, creatorWrapCount: result.creatorWrapCount, rootVersion: result.rootVersion } });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICE_APPROVAL_FAILED"); }
});

router.get("/creators/:creatorId/key-state", async (req, res) => {
  try {
    const id = deviceId.parse(req.query.deviceId);
    const creator = await requireCreatorAccess({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.params.creatorId, db: prisma });
    const state = await getCreatorKeyState({ db: prisma, agencyId: req.auth.agencyId, creatorId: creator.id, deviceId: actorDevice(req, id), member: req.auth.membership || req.member, userId: req.auth.userId });
    return res.json({ ok: true, state });
  } catch (error) { return fail(res, error, "CRYPTO_CREATOR_KEY_STATE_FAILED"); }
});

router.post("/creators/:creatorId/initialize-key", async (req, res) => {
  try {
    const input = z.object({ deviceId, actorProof }).strict().parse(req.body || {});
    const result = await initializeCreatorKeyState({
      db: prisma,
      ...actor(req),
      creatorId: req.params.creatorId,
      deviceId: actorDevice(req, input.deviceId),
      actorProof: input.actorProof,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "crypto.creator_key_initialized",
      targetType: "creator",
      targetId: result.state.creatorId,
      metadata: {
        created: result.created,
        activeVersion: result.state.activeVersion,
        rootVersion: result.state.rootVersion,
      },
    });
    return res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_CREATOR_KEY_INITIALIZATION_FAILED"); }
});


router.get("/devices/:deviceId/revocation-plan", async (req, res) => {
  try {
    const actorDeviceId = actorDevice(req, deviceId.parse(req.query.actorDeviceId));
    const plan = await getDeviceRevocationPlan({
      db: prisma,
      ...actor(req),
      actorDeviceId,
      targetDeviceId: deviceId.parse(req.params.deviceId),
    });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, plan });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICE_REVOCATION_PLAN_FAILED"); }
});


router.get("/root-rotation/plan", async (req, res) => {
  try {
    const actorDeviceId = actorDevice(req, deviceId.parse(req.query.deviceId));
    const plan = await getRootRotationPlan({ db: prisma, ...actor(req), actorDeviceId });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, plan });
  } catch (error) { return fail(res, error, "CRYPTO_ROOT_ROTATION_PLAN_FAILED"); }
});

router.post("/root-rotation/begin", async (req, res) => {
  try {
    const input = z.object({
      actorDeviceId: deviceId,
      actorProof,
      expectedRootVersion: z.number().int().positive(),
      recoveryEnvelope,
      recoveryProof,
      rootBridge: rootBridgeEnvelope,
      ownerWraps: z.array(z.object({ deviceId, envelope: wrapEnvelope }).strict()).min(1).max(10000),
    }).strict().parse(req.body || {});
    const result = await beginRootRotation({ db: prisma, ...actor(req), ...input, actorDeviceId: actorDevice(req, input.actorDeviceId) });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "crypto.root_rotation_started",
      targetType: "agency_crypto_root",
      targetId: req.auth.agencyId,
      metadata: { actorDeviceId: input.actorDeviceId, previousRootVersion: result.previousRootVersion, activeRootVersion: result.activeRootVersion, ownerWrapCount: result.ownerWrapCount, pendingCreatorCount: result.pendingCreatorIds.length },
    });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_ROOT_ROTATION_BEGIN_FAILED"); }
});

router.get("/root-rotation/bridge", async (req, res) => {
  try {
    const actorDeviceId = actorDevice(req, deviceId.parse(req.query.deviceId));
    const fromVersion = z.coerce.number().int().positive().parse(req.query.fromVersion);
    const bridge = await getRootRotationBridge({ db: prisma, ...actor(req), actorDeviceId, fromVersion });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, bridge });
  } catch (error) { return fail(res, error, "CRYPTO_ROOT_ROTATION_BRIDGE_FAILED"); }
});

router.get("/root-rotation/progress", async (req, res) => {
  try {
    const actorDeviceId = actorDevice(req, deviceId.parse(req.query.deviceId));
    const progress = await getRootRotationProgress({ db: prisma, ...actor(req), actorDeviceId });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, progress });
  } catch (error) { return fail(res, error, "CRYPTO_ROOT_ROTATION_PROGRESS_FAILED"); }
});

router.post("/root-rotation/finalize", async (req, res) => {
  try {
    const input = z.object({ actorDeviceId: deviceId, actorProof }).strict().parse(req.body || {});
    const result = await finalizeRootRotation({ db: prisma, ...actor(req), actorDeviceId: actorDevice(req, input.actorDeviceId), actorProof: input.actorProof });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "crypto.root_rotation_finalized", targetType: "agency_crypto_root", targetId: req.auth.agencyId, metadata: result });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_ROOT_ROTATION_FINALIZE_FAILED"); }
});

router.get("/creators/:creatorId/rotation-plan", async (req, res) => {
  try {
    const actorDeviceId = actorDevice(req, deviceId.parse(req.query.deviceId));
    const creator = await requireCreatorAccess({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.params.creatorId, db: prisma });
    const plan = await getCreatorRotationPlan({ db: prisma, ...actor(req), actorDeviceId, creatorId: creator.id });
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, plan });
  } catch (error) { return fail(res, error, "CRYPTO_CREATOR_ROTATION_PLAN_FAILED"); }
});

router.post("/creators/:creatorId/rotate", async (req, res) => {
  try {
    const input = z.object({
      actorDeviceId: deviceId,
      actorProof,
      expectedKeyVersion: z.number().int().positive(),
      expectedCurrentRootVersion: z.number().int().positive(),
      expectedTargetRootVersion: z.number().int().positive(),
      session: z.object({ expectedRevision: z.number().int().positive(), opaquePayload: creatorSecretEnvelope }).strict().optional().nullable(),
      proxy: z.object({
        proxyId: z.string().trim().min(1).max(180),
        expectedProxyVersion: z.number().int().positive(),
        expectedProfileVersion: z.number().int().nonnegative(),
        opaqueCredentials: creatorSecretEnvelope,
      }).strict().optional().nullable(),
      deviceWraps: z.array(z.object({ deviceId, envelope: wrapEnvelope }).strict()).max(10000).default([]),
    }).strict().parse(req.body || {});
    const creator = await requireCreatorAccess({ agencyId: req.auth.agencyId, member: req.auth.membership || req.member, creatorId: req.params.creatorId, db: prisma });
    const result = await commitCreatorKeyRotation({
      db: prisma,
      ...actor(req),
      actorDeviceId: actorDevice(req, input.actorDeviceId),
      actorProof: input.actorProof,
      creatorId: creator.id,
      expectedKeyVersion: input.expectedKeyVersion,
      expectedCurrentRootVersion: input.expectedCurrentRootVersion,
      expectedTargetRootVersion: input.expectedTargetRootVersion,
      session: input.session || null,
      proxy: input.proxy || null,
      deviceWraps: input.deviceWraps,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "crypto.creator_key_rotated",
      targetType: "creator",
      targetId: creator.id,
      metadata: {
        actorDeviceId: input.actorDeviceId,
        previousKeyVersion: result.previousKeyVersion,
        activeKeyVersion: result.activeKeyVersion,
        previousRootVersion: result.previousRootVersion,
        activeRootVersion: result.activeRootVersion,
        wrappedDeviceCount: result.wrappedDeviceCount,
        sessionRevision: result.sessionRevision,
        proxyVersion: result.proxyVersion,
        networkProfileVersion: result.networkProfileVersion,
      },
    });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_CREATOR_ROTATION_FAILED"); }
});

router.post("/devices/:deviceId/revoke", async (req, res) => {
  try {
    const input = z.object({ actorDeviceId: deviceId, actorProof }).strict().parse(req.body || {});
    const result = await softRevokeDevice({ db: prisma, ...actor(req), actorDeviceId: actorDevice(req, input.actorDeviceId), targetDeviceId: deviceId.parse(req.params.deviceId), actorProof: input.actorProof });
    await audit({ agencyId: req.auth.agencyId, actorUserId: req.auth.userId, action: "crypto.device_soft_revoked", targetType: "worker_device", targetId: result.targetDeviceId, metadata: { actorDeviceId: input.actorDeviceId, strongRotationRequired: result.strongRotationRequired, targetHadOwnerRoot: result.targetHadOwnerRoot, affectedCreatorIds: result.affectedCreatorIds } });
    return res.json({ ok: true, ...result });
  } catch (error) { return fail(res, error, "CRYPTO_DEVICE_REVOKE_FAILED"); }
});

module.exports = router;
