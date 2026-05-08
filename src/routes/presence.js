
"use strict";

const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const {
  applyPresenceSnapshot,
  applyPresenceSnapshotProgressive,
  applyPresenceEvents,
  listPresence,
} = require("../services/presence-service");
const { ensurePresenceJobForCreator } = require("../services/presence-scheduler");

const router = express.Router();

function agencyId(req) { return req.auth?.agencyId; }
function userId(req) { return req.auth?.userId; }

async function assertCreator(req, res, next) {
  const creatorId = String(req.params.creatorId || "");
  const creator = await prisma.creatorAccount.findFirst({
    where: { id: creatorId, agencyId: agencyId(req), deletedAt: null },
    select: { id: true, agencyId: true, displayName: true, username: true, remoteId: true },
  });
  if (!creator) return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
  req.creator = creator;
  return next();
}

const listQuery = z.object({
  status: z.enum(["visible", "online", "offline", "all"]).optional().default("visible"),
  limit: z.coerce.number().int().min(1).max(2000).optional().default(500),
});

router.get("/creators/:creatorId", assertCreator, async (req, res) => {
  try {
    const q = listQuery.parse(req.query || {});
    const result = await listPresence({ agencyId: agencyId(req), creatorId: req.creator.id, status: q.status, limit: q.limit });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error" });
    console.error("[presence/list] failed:", err);
    return res.status(500).json({ ok: false, code: "PRESENCE_LIST_FAILED", error: "Failed to load presence" });
  }
});

const snapshotSchema = z.object({
  deviceId: z.string().min(1).max(160).optional().nullable(),
  users: z.array(z.any()).max(5000).optional().default([]),
  capturedAt: z.string().optional().nullable(),
  source: z.string().max(80).optional().default("api_snapshot"),
  markAbsentOffline: z.boolean().optional().default(true),
  mode: z.enum(["replace", "append", "complete"]).optional().default("replace"),
  refreshId: z.string().max(200).optional().nullable(),
  refreshStartedAt: z.string().optional().nullable(),
  page: z.coerce.number().int().min(0).optional().nullable(),
  done: z.boolean().optional().default(false),
});

router.post("/creators/:creatorId/snapshot", assertCreator, async (req, res) => {
  try {
    const input = snapshotSchema.parse(req.body || {});
    const progressive = input.mode === "append" || input.mode === "complete" || input.done || String(input.source || "").includes("progressive");

    const result = progressive
      ? await applyPresenceSnapshotProgressive({
          agencyId: agencyId(req),
          creatorId: req.creator.id,
          deviceId: input.deviceId || null,
          users: input.users,
          capturedAt: input.capturedAt || new Date(),
          source: input.source || "api_snapshot_progressive",
          refreshId: input.refreshId || null,
          refreshStartedAt: input.refreshStartedAt || input.capturedAt || null,
          page: input.page || null,
          done: input.done || input.mode === "complete",
          metadata: { submittedByUserId: userId(req), route: "presence.snapshot", mode: input.mode },
        })
      : await applyPresenceSnapshot({
          agencyId: agencyId(req),
          creatorId: req.creator.id,
          deviceId: input.deviceId || null,
          users: input.users,
          capturedAt: input.capturedAt || new Date(),
          source: input.source || "api_snapshot",
          markAbsentOffline: input.markAbsentOffline !== false,
          metadata: { submittedByUserId: userId(req), route: "presence.snapshot" },
        });

    return res.json(result);
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    console.error("[presence/snapshot] failed:", err);
    return res.status(500).json({ ok: false, code: "PRESENCE_SNAPSHOT_FAILED", error: "Failed to save presence snapshot" });
  }
});

const eventsSchema = z.object({
  deviceId: z.string().min(1).max(160).optional().nullable(),
  events: z.array(z.any()).max(1000).default([]),
});

router.post("/creators/:creatorId/events", assertCreator, async (req, res) => {
  try {
    const input = eventsSchema.parse(req.body || {});
    const result = await applyPresenceEvents({ agencyId: agencyId(req), creatorId: req.creator.id, deviceId: input.deviceId || null, events: input.events });
    return res.json(result);
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    console.error("[presence/events] failed:", err);
    return res.status(500).json({ ok: false, code: "PRESENCE_EVENTS_FAILED", error: "Failed to ingest presence events" });
  }
});

router.post("/creators/:creatorId/refresh", assertCreator, async (req, res) => {
  try {
    const result = await ensurePresenceJobForCreator({
      creatorId: req.creator.id,
      agencyId: agencyId(req),
      priority: Number(req.body?.priority || 120),
      reason: req.body?.reason || "manual_presence_refresh",
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[presence/refresh] failed:", err);
    return res.status(500).json({ ok: false, code: "PRESENCE_REFRESH_FAILED", error: "Failed to queue refresh" });
  }
});

router.get("/agency/summary", async (req, res) => {
  try {
    const rows = await prisma.creatorPresenceSnapshot.findMany({
      where: { agencyId: agencyId(req), creator: { deletedAt: null } },
      orderBy: { capturedAt: "desc" },
      include: { creator: { select: { id: true, displayName: true, username: true, avatarUrl: true, status: true } } },
      take: 500,
    });
    return res.json({ ok: true, snapshots: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "PRESENCE_SUMMARY_FAILED", error: "Failed" });
  }
});

module.exports = router;
