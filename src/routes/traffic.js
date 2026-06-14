"use strict";

const express = require("express");
const { z } = require("zod");
const {
  upsertTrafficSourceScan,
  upsertTrafficFanValueSnapshots,
  ingestSubscriptionEvent,
  getTrafficOverview,
  getTrafficSourceMembers,
  updateTrafficSourceCost,
  scheduleTrafficRefresh,
} = require("../services/traffic-service");

const router = express.Router();

function actorUserId(req) {
  return req.auth?.userId || req.user?.id || null;
}

function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
    issues: err.issues || [],
  });
}

function serviceError(res, err, fallbackCode) {
  const code = err?.code || fallbackCode || "TRAFFIC_FAILED";
  const status = code === "NOT_YOUR_DEVICE" || code === "NOT_A_MEMBER" || code === "DEVICE_CREATOR_AGENCY_MISMATCH" || code === "INSUFFICIENT_TEAM_ROLE" ? 403
    : code === "CREATOR_NOT_FOUND" || code === "TRAFFIC_SOURCE_NOT_FOUND" ? 404
    : 500;
  return res.status(status).json({ ok: false, code, error: err?.message || "Traffic request failed" });
}

const sourceScanSchema = z.object({
  deviceId: z.string().min(1),
  creatorId: z.string().min(1),
  accountId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  hydrateLimit: z.number().int().min(0).max(5000).optional(),
  forceHydrate: z.boolean().optional(),
  sources: z.array(z.any()).max(1000).optional().default([]),
  members: z.array(z.any()).max(5000).optional().default([]),
});

router.post("/sources/upsert", async (req, res) => {
  try {
    const input = sourceScanSchema.parse(req.body || {});
    const result = await upsertTrafficSourceScan({
      deviceId: input.deviceId,
      userId: actorUserId(req),
      creatorId: input.creatorId,
      accountId: input.accountId,
      sources: input.sources,
      members: input.members,
      hydrateLimit: input.hydrateLimit ?? 1000,
      forceHydrate: input.forceHydrate === true,
    });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[traffic/sources/upsert] failed:", err);
    return serviceError(res, err, "TRAFFIC_SOURCES_UPSERT_FAILED");
  }
});

const snapshotsSchema = z.object({
  deviceId: z.string().min(1),
  creatorId: z.string().min(1),
  snapshots: z.array(z.any()).max(5000).optional().default([]),
});

router.post("/value-snapshots/upsert", async (req, res) => {
  try {
    const input = snapshotsSchema.parse(req.body || {});
    const result = await upsertTrafficFanValueSnapshots({
      deviceId: input.deviceId,
      userId: actorUserId(req),
      creatorId: input.creatorId,
      snapshots: input.snapshots,
    });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[traffic/value-snapshots/upsert] failed:", err);
    return serviceError(res, err, "TRAFFIC_VALUE_SNAPSHOTS_UPSERT_FAILED");
  }
});

const subscriptionIngestSchema = z.object({
  deviceId: z.string().min(1),
  creatorId: z.string().min(1),
  accountId: z.string().optional().nullable(),
  event: z.object({
    fanId: z.string().min(1),
    eventType: z.string().optional().nullable(),
    amountCents: z.number().int().nonnegative().optional(),
    amount: z.union([z.number(), z.string()]).optional().nullable(),
    price: z.union([z.number(), z.string()]).optional().nullable(),
    currency: z.string().optional().nullable(),
    occurredAt: z.union([z.string(), z.number(), z.date()]).optional().nullable(),
    createdAt: z.union([z.string(), z.number(), z.date()]).optional().nullable(),
    ts: z.union([z.string(), z.number()]).optional().nullable(),
    externalEventId: z.string().optional().nullable(),
    eventHash: z.string().optional().nullable(),
    toastId: z.string().optional().nullable(),
    notificationId: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    metadata: z.any().optional(),
  }).passthrough(),
});

router.post("/subscriptions/ingest", async (req, res) => {
  try {
    const input = subscriptionIngestSchema.parse(req.body || {});
    const result = await ingestSubscriptionEvent({
      deviceId: input.deviceId,
      userId: actorUserId(req),
      creatorId: input.creatorId,
      accountId: input.accountId,
      event: input.event,
    });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[traffic/subscriptions/ingest] failed:", err);
    return serviceError(res, err, "TRAFFIC_SUBSCRIPTION_INGEST_FAILED");
  }
});


const trafficRefreshSchema = z.object({
  force: z.boolean().optional(),
  rangeKey: z.string().optional().nullable(),
  accountId: z.string().optional().nullable(),
  localAccountId: z.string().optional().nullable(),
  accountManifestId: z.string().optional().nullable(),
  creatorRemoteId: z.string().optional().nullable(),
  remoteId: z.string().optional().nullable(),
  creatorUsername: z.string().optional().nullable(),
  username: z.string().optional().nullable(),
  creatorDisplayName: z.string().optional().nullable(),
}).passthrough();

router.post("/creators/:creatorId/refresh", async (req, res) => {
  try {
    const input = trafficRefreshSchema.parse(req.body || {});
    const result = await scheduleTrafficRefresh({
      userId: actorUserId(req),
      creatorId: req.params.creatorId,
      force: input.force === true,
      accountHints: {
        accountId: input.accountId || input.localAccountId || input.accountManifestId || null,
        localAccountId: input.localAccountId || input.accountId || input.accountManifestId || null,
        accountManifestId: input.accountManifestId || input.localAccountId || input.accountId || null,
        creatorRemoteId: input.creatorRemoteId || input.remoteId || null,
        remoteId: input.remoteId || input.creatorRemoteId || null,
        creatorUsername: input.creatorUsername || input.username || null,
        username: input.username || input.creatorUsername || null,
        creatorDisplayName: input.creatorDisplayName || null,
      },
    });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[traffic/refresh] failed:", err);
    return serviceError(res, err, "TRAFFIC_REFRESH_FAILED");
  }
});

router.get("/creators/:creatorId/overview", async (req, res) => {
  try {
    const result = await getTrafficOverview({ userId: actorUserId(req), creatorId: req.params.creatorId, rangeKey: req.query.range || "all" });
    return res.json(result);
  } catch (err) {
    console.error("[traffic/overview] failed:", err);
    return serviceError(res, err, "TRAFFIC_OVERVIEW_FAILED");
  }
});


const sourceCostSchema = z.object({
  costCents: z.number().int().nonnegative().optional(),
  cost: z.union([z.number(), z.string()]).optional().nullable(),
  currency: z.string().optional().nullable(),
});

router.patch("/creators/:creatorId/sources/:sourceId", async (req, res) => {
  try {
    const input = sourceCostSchema.parse(req.body || {});
    const result = await updateTrafficSourceCost({
      userId: actorUserId(req),
      creatorId: req.params.creatorId,
      sourceId: req.params.sourceId,
      costCents: input.costCents ?? Math.round(Number(String(input.cost || 0).replace(/[^0-9.,-]/g, "").replace(",", ".")) * 100),
      currency: input.currency || null,
    });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    console.error("[traffic/source-update] failed:", err);
    return serviceError(res, err, "TRAFFIC_SOURCE_UPDATE_FAILED");
  }
});

router.get("/creators/:creatorId/sources/:sourceId/members", async (req, res) => {
  try {
    const result = await getTrafficSourceMembers({
      userId: actorUserId(req),
      creatorId: req.params.creatorId,
      sourceId: req.params.sourceId,
      rangeKey: req.query.range || "all",
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0,
      onlyPaying: String(req.query.onlyPaying || req.query.paying || "").toLowerCase() === "true" || String(req.query.onlyPaying || req.query.paying || "") === "1",
    });
    return res.json(result);
  } catch (err) {
    console.error("[traffic/source-members] failed:", err);
    return serviceError(res, err, "TRAFFIC_SOURCE_MEMBERS_FAILED");
  }
});

module.exports = router;
