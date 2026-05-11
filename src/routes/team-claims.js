"use strict";

const express = require("express");
const { z } = require("zod");
const {
  ingestMoneyEvent,
  applyOverride,
  listDisputable,
  sweepLocks,
  hashEvent,
} = require("../services/money-attribution-service");
const prisma = require("../prisma");

const router = express.Router();

// --------------------------------------------------------------------
// POST /api/team/claims/ingest
// --------------------------------------------------------------------
// Electron sends one money event with its locally-computed
// auto-attribution. Backend stores it and returns the canonical row.
// Idempotent on (agencyId, eventHash) — duplicates are accepted and
// return the existing row.
//
// Multiple chatters' Electrons may report the same event (each sees
// the WS frame on their own machine). First write wins, others get
// `deduped: true`.

const ingestSchema = z.object({
  type: z.string().min(1).max(80),
  ts: z.union([z.number(), z.string()]),
  amount: z.number().nonnegative(),
  currency: z.string().max(8).optional().nullable(),
  accountId: z.string().min(1).max(160),
  fanId: z.string().min(1).max(160),
  creatorRef: z.string().max(160).optional().nullable(),

  // Optional semantic identity from websocket-listener. These prevent
  // two same-price PPVs in the same second from being deduped together.
  eventHash: z.string().max(120).optional().nullable(),
  messageId: z.string().max(160).optional().nullable(),
  purchaseMessageId: z.string().max(160).optional().nullable(),
  notificationId: z.string().max(160).optional().nullable(),
  toastId: z.string().max(160).optional().nullable(),
  targetUrl: z.string().max(1000).optional().nullable(),

  // Auto-attribution payload computed on the chatter's Electron.
  autoAttributedToMemberId: z.string().max(160).optional().nullable(),
  autoAttributedToUserId: z.string().max(160).optional().nullable(),
  autoReason: z.string().max(80).optional().nullable(),
});

router.post("/ingest", async (req, res) => {
  try {
    const payload = ingestSchema.parse(req.body || {});
    const result = await ingestMoneyEvent({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      payload,
    });
    return res.json(result);
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
        issues: err.issues,
      });
    }
    console.error("[claims/ingest] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "CLAIMS_INGEST_FAILED",
      error: err?.message || "Failed",
    });
  }
});

// --------------------------------------------------------------------
// POST /api/team/claims/override
// --------------------------------------------------------------------
// Manual claim/release/manager_override. Any agency member can claim
// or release; manager_override requires the actor to have one of the
// privileged roles.

const overrideSchema = z.object({
  eventHash: z.string().min(1).max(80),
  action: z.enum(["claim", "release", "manager_override"]),
  reason: z.string().max(500).optional().nullable(),
  targetMemberId: z.string().max(160).optional().nullable(),
});

router.post("/override", async (req, res) => {
  try {
    const input = overrideSchema.parse(req.body || {});

    // manager_override requires an admin/manager. Roles considered
    // privileged: owner, manager. Anything else gets 403.
    if (input.action === "manager_override") {
      const member = await prisma.agencyMember.findFirst({
        where: { agencyId: req.auth.agencyId, userId: req.auth.userId, deletedAt: null },
        select: { roleKey: true, role: true },
      });
      const roleKey = String(member?.roleKey || member?.role || "").toLowerCase();
      if (!["owner", "manager", "admin"].includes(roleKey)) {
        return res.status(403).json({
          ok: false,
          code: "MANAGER_OVERRIDE_FORBIDDEN",
          error: "Only owner / manager / admin can apply manager_override",
        });
      }
    }

    const result = await applyOverride({
      agencyId: req.auth.agencyId,
      byUserId: req.auth.userId,
      byMemberId: null, // actor is resolved from req.auth.userId; targetMemberId is only the new owner
      eventHash: input.eventHash,
      action: input.action,
      targetMemberId: input.targetMemberId,
      reason: input.reason,
    });

    if (!result.ok) {
      const status = result.code === "ATTRIBUTION_LOCKED" ? 409
                   : result.code === "NOT_OWNER" ? 403
                   : result.code === "ATTRIBUTION_NOT_FOUND" ? 404
                   : 400;
      return res.status(status).json(result);
    }

    return res.json(result);
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues[0]?.message || "Validation error",
        issues: err.issues,
      });
    }
    console.error("[claims/override] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "CLAIMS_OVERRIDE_FAILED",
      error: err?.message || "Failed",
    });
  }
});

// --------------------------------------------------------------------
// GET /api/team/claims/disputable
// --------------------------------------------------------------------
// Money events from the last 48h that are still inside the dispute
// window. Visible to ANY agency member.

router.get("/disputable", async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const rows = await listDisputable({
      agencyId: req.auth.agencyId,
      limit,
    });
    return res.json({
      ok: true,
      count: rows.length,
      attributions: rows,
    });
  } catch (err) {
    console.error("[claims/disputable] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "CLAIMS_DISPUTABLE_FAILED",
      error: err?.message || "Failed",
    });
  }
});

// --------------------------------------------------------------------
// GET /api/team/claims/audit
// --------------------------------------------------------------------
// History for one event, or all events for one member in a range.

router.get("/audit", async (req, res) => {
  try {
    const eventHash = req.query.eventHash ? String(req.query.eventHash) : null;
    const memberId = req.query.memberId ? String(req.query.memberId) : null;
    const days = Math.min(90, Math.max(1, Number(req.query.days || 7)));
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    if (eventHash) {
      const row = await prisma.moneyAttribution.findUnique({
        where: { agencyId_eventHash: { agencyId: req.auth.agencyId, eventHash } },
      });
      if (!row) return res.json({ ok: true, attribution: null });
      return res.json({ ok: true, attribution: row });
    }

    if (memberId) {
      const rows = await prisma.moneyAttribution.findMany({
        where: {
          agencyId: req.auth.agencyId,
          occurredAt: { gte: from },
          OR: [
            { attributedToMemberId: memberId },
            { autoAttributedToMemberId: memberId },
          ],
        },
        orderBy: { occurredAt: "desc" },
        take: 500,
      });
      return res.json({ ok: true, count: rows.length, attributions: rows });
    }

    const rows = await prisma.moneyAttribution.findMany({
      where: {
        agencyId: req.auth.agencyId,
        occurredAt: { gte: from },
      },
      orderBy: { occurredAt: "desc" },
      take: 500,
    });
    return res.json({ ok: true, count: rows.length, attributions: rows });
  } catch (err) {
    console.error("[claims/audit] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "CLAIMS_AUDIT_FAILED",
      error: err?.message || "Failed",
    });
  }
});

// --------------------------------------------------------------------
// POST /api/team/claims/sweep (admin/cron)
// --------------------------------------------------------------------
// Lock attributions past the grace period. Safe to call repeatedly.
// Suitable for a periodic job (every hour).

router.post("/sweep", async (req, res) => {
  try {
    const member = await prisma.agencyMember.findFirst({
      where: { agencyId: req.auth.agencyId, userId: req.auth.userId, deletedAt: null },
      select: { roleKey: true, role: true },
    });
    const roleKey = String(member?.roleKey || member?.role || "").toLowerCase();
    if (!["owner", "manager", "admin"].includes(roleKey)) {
      return res.status(403).json({ ok: false, code: "SWEEP_FORBIDDEN" });
    }
    const result = await sweepLocks();
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "CLAIMS_SWEEP_FAILED",
      error: err?.message || "Failed",
    });
  }
});

module.exports = router;
