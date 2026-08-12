"use strict";

const express = require("express");
const { z } = require("zod");
const { ingestTeamEvents } = require("../services/telemetry-ingest-service");
const prisma = require("../prisma");
const { TEAM_CAPABILITIES, canUseTeamCapability } = require("../services/team-capabilities");

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
        where: { agencyId, userId: req.auth.userId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
      });
      if (!member) return res.status(403).json({ ok: false, code: "TELEMETRY_AGENCY_FORBIDDEN", error: "No access to agency" });
    }

    const result = await ingestTeamEvents({
      agencyId,
      deviceId: input.deviceId || req.auth.deviceId || null,
      userId: req.auth.userId,
      memberId: req.auth.memberId || null,
      events: input.events,
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    console.error("[telemetry/ingest] failed:", err);
    return res.status(500).json({ ok: false, code: "TELEMETRY_INGEST_FAILED", error: err?.message || "Failed" });
  }
});

function telemetryCreatorScope(member) {
  const isOwner = String(member?.role || "").toUpperCase() === "OWNER" || String(member?.roleKey || "").toLowerCase() === "owner";
  if (isOwner) return null;
  const raw = member?.assignedCreators;
  if (raw === null || raw === undefined || raw === "all") return null;
  if (Array.isArray(raw)) return Array.from(new Set(raw.map(String).map((id) => id.trim()).filter(Boolean)));
  if (raw && typeof raw === "object") {
    if (raw.all === true || raw.mode === "all") return null;
    const ids = Array.isArray(raw.creatorIds) ? raw.creatorIds : (Array.isArray(raw.ids) ? raw.ids : []);
    return Array.from(new Set(ids.map(String).map((id) => id.trim()).filter(Boolean)));
  }
  return [];
}

router.get("/events", async (req, res) => {
  try {
    const member = await prisma.agencyMember.findFirst({
      where: { agencyId: req.auth.agencyId, userId: req.auth.userId, deletedAt: null, deactivatedAt: null },
      select: { id: true, agencyId: true, userId: true, role: true, roleKey: true, permissions: true, assignedCreators: true },
    });
    if (!member) return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    if (!(await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.VIEW_ANALYTICS }))) {
      return res.status(403).json({ ok: false, code: "TEAM_ANALYTICS_VIEW_REQUIRED", error: "team.analytics.view permission is required" });
    }
    const includeMoney = await canUseTeamCapability({ member, key: TEAM_CAPABILITIES.VIEW_ATTRIBUTION });
    const allowedCreatorIds = telemetryCreatorScope(member);
    const creatorWhere = Array.isArray(allowedCreatorIds)
      ? { creatorId: { in: allowedCreatorIds.length ? allowedCreatorIds : ["__none__"] } }
      : {};
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await prisma.teamActivityEvent.findMany({
      where: { agencyId: req.auth.agencyId, ...creatorWhere },
      orderBy: { ts: "desc" },
      take: limit,
      select: {
        id: true, deviceId: true, userId: true, memberId: true, creatorId: true, fanId: true,
        eventKind: true, actionSource: true, lifecycle: true, dialogId: true, messageId: true,
        correlationId: true, coverageId: true, startedAt: true, endedAt: true, durationSeconds: true,
        automationDeliveryId: true, broadcastDispatchId: true, priceCents: true, currency: true,
        isPpv: true, mediaCount: true, ts: true, localId: true, source: true,
      },
    });
    const events = includeMoney ? rows : rows.map((row) => ({ ...row, priceCents: null, currency: null }));
    return res.json({ ok: true, events, moneyVisible: includeMoney });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "TELEMETRY_EVENTS_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
