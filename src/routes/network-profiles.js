"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { creatorManagementRequired } = require("../middleware/creator-management-permissions");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { requireRegisteredDevice } = require("../services/creator-session-broker-service");
const { audit } = require("../services/audit-service");
const {
  createProxyEndpoint,
  updateProxyEndpoint,
  deleteProxyEndpoint,
  setCreatorNetworkProfile,
  listNetworkSettings,
  getCreatorNetworkManifest,
  getCreatorNetworkRuntime,
  getProxyTestMaterial,
} = require("../services/creator-network-profile-service");

const router = express.Router();
router.use(authRequired);

const proxyType = z.enum(["HTTP", "HTTPS", "SOCKS4", "SOCKS4A", "SOCKS5"]);
const credentials = z.object({
  username: z.string().max(512).optional().nullable(),
  password: z.string().max(4096).optional().nullable(),
}).strict();
const credentialMutation = z.object({
  mode: z.enum(["KEEP", "REPLACE", "CLEAR"]),
  credentials: credentials.optional(),
}).strict();
const createProxySchema = z.object({
  label: z.string().trim().min(1).max(120),
  type: proxyType,
  host: z.string().trim().min(1).max(512),
  port: z.number().int().min(1).max(65535),
  enabled: z.boolean().optional(),
  credentials: credentials.optional(),
}).strict();
const updateProxySchema = z.object({
  expectedVersion: z.number().int().positive(),
  label: z.string().trim().min(1).max(120).optional(),
  type: proxyType.optional(),
  host: z.string().trim().min(1).max(512).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  enabled: z.boolean().optional(),
  credentials: credentialMutation.optional(),
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

async function registeredDevice(req, rawDeviceId) {
  return requireRegisteredDevice({
    db: prisma,
    agencyId: req.auth.agencyId,
    userId: req.auth.userId,
    deviceId: deviceIdSchema.parse(rawDeviceId),
  });
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
    const result = await createProxyEndpoint({ db: prisma, agencyId: req.auth.agencyId, actorUserId: req.auth.userId, input });
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
    const result = await updateProxyEndpoint({
      db: prisma,
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
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
    return res.json({ ok: true, proxy: result.proxy, unchanged: result.unchanged, runtimeChanged: result.runtimeChanged });
  } catch (error) {
    return sendError(res, error, "PROXY_UPDATE_FAILED");
  }
});

router.delete("/proxies/:proxyId", creatorManagementRequired, async (req, res) => {
  try {
    const input = deleteProxySchema.parse(req.body || {});
    const result = await deleteProxyEndpoint({ db: prisma, agencyId: req.auth.agencyId, proxyId: req.params.proxyId, expectedVersion: input.expectedVersion });
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

router.post("/proxies/:proxyId/test-material", creatorManagementRequired, async (req, res) => {
  try {
    const device = await registeredDevice(req, req.body?.deviceId);
    const proxy = await getProxyTestMaterial({ db: prisma, agencyId: req.auth.agencyId, proxyId: req.params.proxyId });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "network_proxy.test_material_read",
      targetType: "proxy_endpoint",
      targetId: proxy.id,
      metadata: { deviceId: device.id, type: proxy.type, version: proxy.version },
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
    const profile = await getCreatorNetworkRuntime({ db: prisma, agencyId: req.auth.agencyId, creatorId: creator.id });
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

router.put("/creators/:creatorId", creatorManagementRequired, async (req, res) => {
  try {
    const input = profileSchema.parse(req.body || {});
    const creator = await creatorAccess(req, req.params.creatorId);
    const result = await setCreatorNetworkProfile({
      db: prisma,
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      actorUserId: req.auth.userId,
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
    return res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error, "CREATOR_NETWORK_UPDATE_FAILED");
  }
});

module.exports = router;
