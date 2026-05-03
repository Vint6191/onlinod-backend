"use strict";

const express = require("express");
const { z } = require("zod");
const { ingestTeamEvents } = require("../services/telemetry-ingest-service");
const prisma = require("../prisma");

const router = express.Router();

const ingestSchema = z.object({
  deviceId: z.string().min(1).max(160).optional().nullable(),
  agencyId: z.string().optional().nullable(),
  events: z.array(z.any()).max(1000),
});

router.post("/events/ingest", async (req, res) => {
  try {
    const input = ingestSchema.parse(req.body || {});
    const agencyId = input.agencyId || req.auth.agencyId;

    if (agencyId !== req.auth.agencyId) {
      const member = await prisma.agencyMember.findFirst({
        where: { agencyId, userId: req.auth.userId, deletedAt: null, agency: { deletedAt: null } },
      });
      if (!member) return res.status(403).json({ ok: false, code: "TELEMETRY_AGENCY_FORBIDDEN", error: "No access to agency" });
    }

    const result = await ingestTeamEvents({
      agencyId,
      deviceId: input.deviceId || req.auth.deviceId || null,
      userId: req.auth.userId,
      events: input.events,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    console.error("[telemetry/ingest] failed:", err);
    return res.status(500).json({ ok: false, code: "TELEMETRY_INGEST_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/events", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await prisma.teamActivityEvent.findMany({
      where: { agencyId: req.auth.agencyId },
      orderBy: { ts: "desc" },
      take: limit,
    });
    return res.json({ ok: true, events: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TELEMETRY_EVENTS_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
