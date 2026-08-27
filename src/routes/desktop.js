"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { buildDesktopBootstrap, accessibleCreatorIdSet } = require("../services/desktop-bootstrap-service");
const { buildDesktopSecretDelta } = require("../services/desktop-secret-delta-service");
const { audit } = require("../services/audit-service");
const { waitForDesktopControlEvents } = require("../services/desktop-control-events");

const router = express.Router();
router.use(authRequired);

const controlCursorSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const controlWaitSchema = z.coerce.number().int().min(250).max(25_000);
const controlDeviceSchema = z.string().trim().min(1).max(180);

async function filterAuthorizedControlEvents(req, events) {
  const creatorProtectedTypes = new Set([
    "SESSION_REVISION_CHANGED",
    "NETWORK_REVISION_CHANGED",
    "KEY_VERSION_CHANGED",
  ]);
  const creatorIds = Array.from(new Set((Array.isArray(events) ? events : [])
    .filter((event) => creatorProtectedTypes.has(String(event?.type || "")) || (event?.type === "JOB_AVAILABLE" && event?.creatorId))
    .map((event) => String(event?.creatorId || "").trim())
    .filter(Boolean)));
  const allowedIds = await accessibleCreatorIdSet({
    db: prisma,
    agencyId: req.auth.agencyId,
    member: req.auth.membership || req.member,
    creatorIds,
  });
  return (Array.isArray(events) ? events : []).filter((event) => {
    const type = String(event?.type || "");
    if (type === "ACCESS_EPOCH_CHANGED" || type === "CREATOR_REVOKED") return true;
    if (type === "JOB_AVAILABLE" && !event?.creatorId) return true;
    if (creatorProtectedTypes.has(type) || type === "JOB_AVAILABLE") return allowedIds.has(String(event?.creatorId || ""));
    return false;
  });
}

router.get("/control/events", async (req, res) => {
  try {
    const deviceId = requireAuthDevice(req, controlDeviceSchema.parse(req.query.deviceId), {
      requiredCode: "DESKTOP_CONTROL_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "DESKTOP_CONTROL_AUTH_DEVICE_MISMATCH",
    });
    const afterSeq = controlCursorSchema.parse(req.query.afterSeq ?? 0);
    const waitMs = controlWaitSchema.parse(req.query.waitMs ?? 20_000);
    const clientStreamId = typeof req.query.streamId === "string" ? req.query.streamId.trim().slice(0, 180) : "";
    const result = await waitForDesktopControlEvents({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      memberId: req.auth.membership?.id || req.member?.id || null,
      deviceId,
      streamId: clientStreamId || null,
      afterSeq,
      waitMs,
    });
    const events = await filterAuthorizedControlEvents(req, result.events);
    res.setHeader("Cache-Control", "no-store, private");
    return res.json({ ok: true, streamId: result.streamId, cursor: result.cursor, events });
  } catch (error) {
    if (error?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues[0]?.message || "Validation error", issues: error.issues });
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[desktop/control/events] failed:", error);
    return res.status(status).json({ ok: false, code: error?.code || "DESKTOP_CONTROL_EVENTS_FAILED", error: error?.message || "Desktop control channel failed" });
  }
});

router.post("/bootstrap", async (req, res) => {
  try {
    const deviceId = String(req.auth?.deviceId || "").trim();
    if (!deviceId) {
      return res.status(401).json({
        ok: false,
        code: "DESKTOP_BOOTSTRAP_DEVICE_BOUND_TOKEN_REQUIRED",
        error: "Desktop bootstrap requires a device-bound session",
      });
    }
    const bootstrap = await buildDesktopBootstrap({
      db: prisma,
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      member: req.auth.membership || req.member,
      deviceId,
    });
    return res.json(bootstrap);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[desktop/bootstrap] failed:", error);
    return res.status(status).json({
      ok: false,
      code: error?.code || "DESKTOP_BOOTSTRAP_FAILED",
      error: error?.message || "Desktop bootstrap failed",
    });
  }
});

const secretDeltaSchema = z.object({
  requests: z.array(z.object({
    creatorId: z.string().trim().min(1).max(180),
    session: z.boolean().optional().default(false),
    network: z.boolean().optional().default(false),
  }).strict()).min(1).max(250),
}).strict();

router.post("/bootstrap/secrets", async (req, res) => {
  try {
    const deviceId = String(req.auth?.deviceId || "").trim();
    if (!deviceId) {
      return res.status(401).json({ ok: false, code: "DESKTOP_SECRET_DEVICE_BOUND_TOKEN_REQUIRED", error: "Secret delta requires a device-bound session" });
    }
    const input = secretDeltaSchema.parse(req.body || {});
    const result = await buildDesktopSecretDelta({
      db: prisma,
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      member: req.auth.membership || req.member,
      deviceId,
      requests: input.requests,
    });
    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "desktop.secret_delta.read",
      targetType: "desktop_secret_delta",
      targetId: deviceId,
      metadata: {
        requestCount: input.requests.length,
        sessionCount: input.requests.filter((x) => x.session).length,
        networkCount: input.requests.filter((x) => x.network).length,
      },
    });
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    return res.json(result);
  } catch (error) {
    if (error?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: error.issues[0]?.message || "Validation error", issues: error.issues });
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[desktop/bootstrap/secrets] failed:", error);
    return res.status(status).json({ ok: false, code: error?.code || "DESKTOP_SECRET_DELTA_FAILED", error: error?.message || "Desktop secret delta failed" });
  }
});

module.exports = router;
