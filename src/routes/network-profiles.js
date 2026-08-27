"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { creatorManagementRequired } = require("../middleware/creator-management-permissions");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { audit } = require("../services/audit-service");
const { publishDesktopControlEvent } = require("../services/desktop-control-events");
const {
  createProxyEndpoint,
  createProxyForCreator,
  updateProxyEndpoint,
  deleteProxyEndpoint,
  setCreatorNetworkProfile,
  listNetworkSettings,
  getCreatorNetworkManifest,
  getCreatorNetworkRuntime,
  getProxyCredentialContext,
  getProxyTestMaterial,
} = require("../services/creator-network-profile-service");

const router = express.Router();
router.use(authRequired);

const proxyType = z.enum(["HTTP", "HTTPS", "SOCKS4", "SOCKS4A", "SOCKS5"]);
const opaqueCredentials = z.object({
  encryptionMode: z.literal("CLIENT_E2E_V1"),
  keyVersion: z.number().int().positive(),
  algorithm: z.literal("aes-256-gcm-client-e2e-v1"),
  ciphertext: z.string().min(1).max(1_000_000),
  iv: z.string().min(1).max(4096),
  tag: z.string().min(1).max(4096),
}).strict();
const credentialMutation = z.object({
  mode: z.enum(["KEEP", "REPLACE", "CLEAR"]),
  opaqueCredentials: opaqueCredentials.optional(),
  usernameHint: z.string().max(512).optional().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.mode === "REPLACE" && !value.opaqueCredentials) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "REPLACE requires CLIENT_E2E_V1 opaqueCredentials" });
  }
  if (value.mode !== "REPLACE" && value.opaqueCredentials) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.mode} must not include credential material` });
  }
});
const createProxySchema = z.object({
  label: z.string().trim().min(1).max(120),
  type: proxyType,
  host: z.string().trim().min(1).max(512),
  port: z.number().int().min(1).max(65535),
  enabled: z.boolean().optional(),
}).strict();
const createCreatorProxySchema = z.object({
  expectedNetworkVersion: z.number().int().min(0),
  deviceId: z.string().trim().min(1).max(180),
  label: z.string().trim().min(1).max(120),
  type: proxyType,
  host: z.string().trim().min(1).max(512),
  port: z.number().int().min(1).max(65535),
  enabled: z.boolean().optional(),
  opaqueCredentials: opaqueCredentials.optional(),
  usernameHint: z.string().max(512).optional().nullable(),
}).strict();
const updateProxySchema = z.object({
  expectedVersion: z.number().int().positive(),
  label: z.string().trim().min(1).max(120).optional(),
  type: proxyType.optional(),
  host: z.string().trim().min(1).max(512).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  enabled: z.boolean().optional(),
  credentials: credentialMutation.optional(),
  deviceId: z.string().trim().min(1).max(180).optional(),
}).strict();
const deleteProxySchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const profileSchema = z.object({
  expectedVersion: z.number().int().min(0),
  mode: z.enum(["DIRECT", "PROXY"]),
  proxyEndpointId: z.string().trim().min(1).max(180).optional().nullable(),
}).strict();
const deviceIdSchema = z.string().trim().min(1).max(180);

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
    error: error?.message || "Network profile request failed",
    ...(error?.current ? { current: error.current } : {}),
    ...(Number.isInteger(error?.assignedCreatorCount) ? { assignedCreatorCount: error.assignedCreatorCount } : {}),
  });
}

async function creatorAccess(req, creatorId) {
  return requireCreatorAccess({
    agencyId: req.auth.agencyId,
    member: req.auth.membership,
    creatorId,
    db: prisma,
  });
}

function publishNetworkHint(req, creatorId, networkVersion) {
  try {
    publishDesktopControlEvent({
      type: "NETWORK_REVISION_CHANGED",
      agencyId: req.auth.agencyId,
      creatorId,
      networkVersion,
      sourceDeviceId: req.auth?.deviceId || null,
      requestId: req.headers?.["x-request-id"] || null,
    });
  } catch (error) {
    console.error("[network-profiles/control-hint] failed:", error);
  }
}

async function registeredDevice(req, rawDeviceId) {
  const parsedDeviceId = deviceIdSchema.parse(rawDeviceId);
  const boundDeviceId = requireAuthDevice(req, parsedDeviceId, {
    requiredCode: "NETWORK_AUTH_DEVICE_BOUND_TOKEN_REQUIRED",
    mismatchCode: "NETWORK_AUTH_DEVICE_MISMATCH",
  });
  // WorkerDevice is live telemetry, not durable crypto authority.  A device-
  // bound JWT proves the logical request device; CLIENT_E2E_V1 secret paths
  // additionally prove immutable DeviceCryptoIdentity + current AMK/CDK
  // enrollment inside creator-network-profile-service.
  return { id: boundDeviceId };
}

router.get("/", creatorManagementRequired, async (req, res) => {
  try {
    const scope = await allowedCreatorScope({ agencyId: req.auth.agencyId, member: req.auth.membership, db: prisma });
    const state = await listNetworkSettings({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorIds: scope.broad ? null : scope.creatorIds,
    });
    return res.json({ ok: true, canManage: true, ...state });
  } catch (error) {
    return sendError(res, error, "NETWORK_SETTINGS_READ_FAILED");
  }
});

router.post("/proxies", creatorManagementRequired, async (req, res) => {
  try {
    const input = createProxySchema.parse(req.body || {});
    const result = await createProxyEndpoint({ db: prisma, agencyId: req.auth.agencyId, actorUserId: req.auth.userId, actorMember: req.auth.membership, input });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "network_proxy.created",
      targetType: "proxy_endpoint",
      targetId: result.proxy.id,
      metadata: { type: result.proxy.type, host: result.proxy.host, port: result.proxy.port, hasCredentials: result.proxy.hasCredentials },
    });
    return res.status(201).json({ ok: true, proxy: result.proxy });
  } catch (error) {
    return sendError(res, error, "PROXY_CREATE_FAILED");
  }
});

router.patch("/proxies/:proxyId", creatorManagementRequired, async (req, res) => {
  try {
    const input = updateProxySchema.parse(req.body || {});
    const device = input.deviceId ? await registeredDevice(req, input.deviceId) : null;
    const result = await updateProxyEndpoint({
      db: prisma,
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      actorMember: req.auth.membership,
      deviceId: device?.id || null,
      proxyId: req.params.proxyId,
      expectedVersion: input.expectedVersion,
      patch: input,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: result.unchanged ? "network_proxy.update_unchanged" : "network_proxy.updated",
      targetType: "proxy_endpoint",
      targetId: result.proxy.id,
      metadata: { version: result.proxy.version, runtimeChanged: result.runtimeChanged },
    });
    if (result.runtimeChanged) {
      const affected = await prisma.creatorNetworkProfile.findMany({
        where: { agencyId: req.auth.agencyId, proxyEndpointId: result.proxy.id, mode: "PROXY" },
        select: { creatorId: true, version: true },
        take: 10000,
      });
      for (const profile of affected) publishNetworkHint(req, profile.creatorId, profile.version);
    }
    return res.json({ ok: true, proxy: result.proxy, unchanged: result.unchanged, runtimeChanged: result.runtimeChanged });
  } catch (error) {
    return sendError(res, error, "PROXY_UPDATE_FAILED");
  }
});

router.delete("/proxies/:proxyId", creatorManagementRequired, async (req, res) => {
  try {
    const input = deleteProxySchema.parse(req.body || {});
    const result = await deleteProxyEndpoint({ db: prisma, agencyId: req.auth.agencyId, actorUserId: req.auth.userId, actorMember: req.auth.membership, proxyId: req.params.proxyId, expectedVersion: input.expectedVersion });
    if (result.deleted) {
      await audit({
        agencyId: req.auth.agencyId,
        actorUserId: req.auth.userId,
        action: "network_proxy.deleted",
        targetType: "proxy_endpoint",
        targetId: req.params.proxyId,
        metadata: {},
      });
    }
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error, "PROXY_DELETE_FAILED");
  }
});

router.get("/proxies/:proxyId/credential-context", creatorManagementRequired, async (req, res) => {
  try {
    const device = await registeredDevice(req, req.query?.deviceId);
    const context = await getProxyCredentialContext({ db: prisma, agencyId: req.auth.agencyId, proxyId: req.params.proxyId });
    if (context.creatorId) await creatorAccess(req, context.creatorId);
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, deviceId: device.id, context });
  } catch (error) {
    return sendError(res, error, "PROXY_CREDENTIAL_CONTEXT_FAILED");
  }
});

router.post("/proxies/:proxyId/test-material", creatorManagementRequired, async (req, res) => {
  try {
    const device = await registeredDevice(req, req.body?.deviceId);
    const context = await getProxyCredentialContext({ db: prisma, agencyId: req.auth.agencyId, proxyId: req.params.proxyId });
    if (context.creatorId) await creatorAccess(req, context.creatorId);
    const proxy = await getProxyTestMaterial({ db: prisma, agencyId: req.auth.agencyId, proxyId: req.params.proxyId, deviceId: device.id, member: req.auth.membership, userId: req.auth.userId });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "network_proxy.test_material_read",
      targetType: "proxy_endpoint",
      targetId: proxy.id,
      metadata: { deviceId: device.id, type: proxy.type, version: proxy.version, encryptionMode: proxy.encryptionMode },
    });
    return res.json({ ok: true, proxy });
  } catch (error) {
    return sendError(res, error, "PROXY_TEST_MATERIAL_FAILED");
  }
});

router.get("/creators/:creatorId/manifest", async (req, res) => {
  try {
    const creator = await creatorAccess(req, req.params.creatorId);
    const profile = await getCreatorNetworkManifest({ db: prisma, agencyId: req.auth.agencyId, creatorId: creator.id });
    return res.json({ ok: true, profile });
  } catch (error) {
    return sendError(res, error, "CREATOR_NETWORK_MANIFEST_FAILED");
  }
});

router.get("/creators/:creatorId/runtime", async (req, res) => {
  try {
    const creator = await creatorAccess(req, req.params.creatorId);
    const device = await registeredDevice(req, req.query?.deviceId);
    const profile = await getCreatorNetworkRuntime({ db: prisma, agencyId: req.auth.agencyId, creatorId: creator.id, deviceId: device.id, member: req.auth.membership, userId: req.auth.userId });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator_network.runtime_read",
      targetType: "creator_network_profile",
      targetId: creator.id,
      metadata: { creatorId: creator.id, deviceId: device.id, mode: profile.mode, version: profile.version, proxyEndpointId: profile.proxyEndpointId },
    });
    return res.json({ ok: true, profile });
  } catch (error) {
    return sendError(res, error, "CREATOR_NETWORK_RUNTIME_FAILED");
  }
});

router.post("/creators/:creatorId/proxy", creatorManagementRequired, async (req, res) => {
  try {
    const input = createCreatorProxySchema.parse(req.body || {});
    const creator = await creatorAccess(req, req.params.creatorId);
    const device = await registeredDevice(req, input.deviceId);
    const result = await createProxyForCreator({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      actorUserId: req.auth.userId,
      actorMember: req.auth.membership,
      deviceId: device.id,
      expectedNetworkVersion: input.expectedNetworkVersion,
      input,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "creator_network.proxy_created_and_assigned",
      targetType: "creator_network_profile",
      targetId: creator.id,
      metadata: { creatorId: creator.id, proxyEndpointId: result.proxy.id, networkVersion: result.profile.version, encryptionMode: result.proxy.encryptionMode },
    });
    publishNetworkHint(req, creator.id, result.profile.version);
    return res.status(201).json({ ok: true, proxy: result.proxy, profile: result.profile });
  } catch (error) {
    return sendError(res, error, "CREATOR_PROXY_CREATE_FAILED");
  }
});

router.put("/creators/:creatorId", creatorManagementRequired, async (req, res) => {
  try {
    const input = profileSchema.parse(req.body || {});
    const creator = await creatorAccess(req, req.params.creatorId);
    const result = await setCreatorNetworkProfile({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      actorUserId: req.auth.userId,
      actorMember: req.auth.membership,
      expectedVersion: input.expectedVersion,
      mode: input.mode,
      proxyEndpointId: input.proxyEndpointId,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: result.unchanged ? "creator_network.assignment_unchanged" : "creator_network.assignment_changed",
      targetType: "creator_network_profile",
      targetId: creator.id,
      metadata: { creatorId: creator.id, mode: result.profile.mode, proxyEndpointId: result.profile.proxyEndpointId, version: result.profile.version },
    });
    if (!result.unchanged) publishNetworkHint(req, creator.id, result.profile.version);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error, "CREATOR_NETWORK_UPDATE_FAILED");
  }
});

module.exports = router;
