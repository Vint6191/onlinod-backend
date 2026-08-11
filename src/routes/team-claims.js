"use strict";

const express = require("express");
const { z } = require("zod");
const {
  ingestMoneyEvent,
  applyOverride,
  listDisputable,
  sweepLocks,
  purgeExpiredLegacyAttributions,
  hashEvent,
  LEGACY_CLAIMABLE_EVENT_TYPES,
} = require("../services/money-attribution-service");
const {
  applyTipOverride,
  listTipClaims,
  getTipClaimByHash,
  listTipAudit,
  migrateLegacyTipsToTipLedger,
  purgeExpiredTipLedger,
} = require("../services/team-tip-ledger-service");
const prisma = require("../prisma");
const { TEAM_CAPABILITIES, canUseTeamCapability } = require("../services/team-capabilities");

const router = express.Router();


async function loadActorMember(req) {
  if (!req.auth?.agencyId || !req.auth?.userId) return null;
  return prisma.agencyMember.findFirst({
    where: { agencyId: req.auth.agencyId, userId: req.auth.userId, deletedAt: null },
    select: { id: true, agencyId: true, userId: true, roleKey: true, role: true, permissions: true },
  });
}

async function requireClaimsCapability(req, res, key) {
  const member = await loadActorMember(req);
  if (!member) {
    res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    return null;
  }
  if (!(await canUseTeamCapability({ member, key }))) {
    res.status(403).json({
      ok: false,
      code: "CLAIMS_PERMISSION_REQUIRED",
      error: `${key} permission is required`,
    });
    return null;
  }
  return member;
}

function isLegacyClaimableRow(row) {
  return row && LEGACY_CLAIMABLE_EVENT_TYPES.has(String(row.eventType || ""));
}

function isOwnClaimRow(row, memberId) {
  if (!row || !memberId) return false;
  if (row.attributedToMemberId === memberId || row.autoAttributedToMemberId === memberId) return true;
  if (row.ledgerType === "tip") {
    const candidates = []
      .concat(Array.isArray(row.candidates) ? row.candidates : [])
      .concat(Array.isArray(row.weakCandidates) ? row.weakCandidates : []);
    return candidates.some((c) => String(c?.memberId || "") === String(memberId));
  }
  return false;
}

function hideMigratedLegacyRows(tipRows, legacyRows) {
  const tipHashes = new Set((tipRows || []).map((row) => String(row?.eventHash || "")).filter(Boolean));
  return (legacyRows || []).filter((row) => !tipHashes.has(String(row?.eventHash || "")));
}

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
  dialogId: z.string().max(160).optional().nullable(),
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
    const parsed = ingestSchema.parse(req.body || {});
    const actor = await loadActorMember(req);
    if (!actor) {
      return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    }

    // Do not trust chatter-submitted auto attribution. Senior users may
    // import/repair events for another member, but a regular chatter can
    // only submit himself as the auto-attributed actor. Tip auto-attribution
    // is still recomputed from TeamSentMessageLedger on the backend; this
    // clamp only prevents poisoned weak candidates / legacy fallback rows.
    const canOverrideAttribution = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.OVERRIDE_ATTRIBUTION });
    const payload = canOverrideAttribution
      ? parsed
      : {
          ...parsed,
          autoAttributedToMemberId: actor.id,
          autoAttributedToUserId: actor.userId || null,
        };

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
// Manual claim/release/manager_override.
// Chatters can claim/release only eligible tip rows tied to their work.
// manager_override is owner/manager-only. PPV is handled by PPV ledger.
// Subscriptions are not Team member revenue and are intentionally not claimable.

const overrideSchema = z.object({
  eventHash: z.string().min(1).max(80),
  action: z.enum(["claim", "release", "manager_override"]),
  reason: z.string().max(500).optional().nullable(),
  targetMemberId: z.string().max(160).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "manager_override" && String(value.reason || "").trim().length < 3) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "A reason of at least 3 characters is required for manager_override" });
  }
});

router.post("/override", async (req, res) => {
  try {
    const input = overrideSchema.parse(req.body || {});

    const actor = await loadActorMember(req);
    if (!actor) {
      return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    }

    // Chatter actions are intentionally narrow: claim/release only their own
    // eligible tip rows. Agency-wide dispute resolution stays
    // owner/manager-only through manager_override and PPV Claims.
    const canOverrideAttribution = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.OVERRIDE_ATTRIBUTION });
    if (input.action === "manager_override" && !canOverrideAttribution) {
      return res.status(403).json({
        ok: false,
        code: "ATTRIBUTION_OVERRIDE_FORBIDDEN",
        error: "money.override_attribution permission is required",
      });
    }
    if (input.action === "claim" && !(await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.CLAIM_OWN }))) {
      return res.status(403).json({ ok: false, code: "CLAIM_FORBIDDEN", error: "money.claim permission is required" });
    }
    if (input.action === "release" && !(await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.RELEASE_OWN }))) {
      return res.status(403).json({ ok: false, code: "RELEASE_FORBIDDEN", error: "money.release_own_claim permission is required" });
    }

    let result = await applyTipOverride({
      agencyId: req.auth.agencyId,
      byUserId: req.auth.userId,
      byMemberId: actor.id,
      eventHash: input.eventHash,
      action: input.action,
      targetMemberId: input.targetMemberId,
      reason: input.reason,
      senior: canOverrideAttribution,
    });

    // Cross-version fallback: old v15 tip rows may still live in
    // MoneyAttribution until a one-time migration/backfill is run.
    if (!result.ok && result.code === "TIP_NOT_FOUND") {
      result = await applyOverride({
        agencyId: req.auth.agencyId,
        byUserId: req.auth.userId,
        byMemberId: null, // actor is resolved from req.auth.userId; targetMemberId is only the new owner
        eventHash: input.eventHash,
        action: input.action,
        targetMemberId: input.targetMemberId,
        reason: input.reason,
      });
    }

    if (!result.ok) {
      const status = result.code === "ATTRIBUTION_LOCKED" ? 409
                   : result.code === "NOT_OWNER" || result.code === "CLAIM_NOT_ELIGIBLE" || result.code === "TIP_CONFLICT_MANAGER_REQUIRED" || result.code === "PPV_CLAIMS_MOVED_TO_LEDGER" ? 403
                   : result.code === "ATTRIBUTION_NOT_FOUND" || result.code === "TIP_NOT_FOUND" ? 404
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
// window. Owner/manager sees all tip claims; chatters see only
// their own eligible rows. PPV conflicts are not exposed here.

router.get("/disputable", async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const actor = await loadActorMember(req);
    if (!actor) {
      return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    }
    const senior = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.VIEW_ATTRIBUTION });
    const canClaimOwn = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.CLAIM_OWN });
    const canReleaseOwn = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.RELEASE_OWN });
    if (!senior && !canClaimOwn && !canReleaseOwn) {
      return res.status(403).json({ ok: false, code: "CLAIMS_VIEW_FORBIDDEN", error: "Claims permission is required" });
    }
    const [tipRows, legacyRows] = await Promise.all([
      listTipClaims({
        agencyId: req.auth.agencyId,
        limit,
        actorMemberId: actor.id,
        senior,
      }),
      listDisputable({
        agencyId: req.auth.agencyId,
        limit,
        actorMemberId: actor.id,
        senior,
      }),
    ]);
    const rows = [...tipRows, ...hideMigratedLegacyRows(tipRows, legacyRows)]
      .sort((a, b) => new Date(b.occurredAt || b.receivedAt || 0).getTime() - new Date(a.occurredAt || a.receivedAt || 0).getTime())
      .slice(0, limit);
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
    const actor = await loadActorMember(req);
    if (!actor) {
      return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    }
    const senior = await canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.VIEW_AUDIT });

    if (eventHash) {
      const tipRow = await getTipClaimByHash({ agencyId: req.auth.agencyId, eventHash });
      if (tipRow) {
        if (!senior && !isOwnClaimRow(tipRow, actor.id)) {
          return res.status(403).json({ ok: false, code: "CLAIMS_AUDIT_FORBIDDEN" });
        }
        return res.json({ ok: true, attribution: tipRow });
      }

      const row = await prisma.moneyAttribution.findUnique({
        where: { agencyId_eventHash: { agencyId: req.auth.agencyId, eventHash } },
      });
      if (!row || !isLegacyClaimableRow(row)) return res.json({ ok: true, attribution: null });
      if (!senior && !isOwnClaimRow(row, actor.id)) {
        return res.status(403).json({ ok: false, code: "CLAIMS_AUDIT_FORBIDDEN" });
      }
      return res.json({ ok: true, attribution: row });
    }

    if (memberId) {
      const requestedMemberId = String(memberId || "");
      if (!senior && requestedMemberId !== actor.id) {
        return res.status(403).json({ ok: false, code: "CLAIMS_AUDIT_FORBIDDEN" });
      }
      const [tipRows, legacyRows] = await Promise.all([
        listTipAudit({
          agencyId: req.auth.agencyId,
          memberId: requestedMemberId,
          from,
          limit: 500,
          senior,
          actorMemberId: actor.id,
        }),
        prisma.moneyAttribution.findMany({
          where: {
            agencyId: req.auth.agencyId,
            eventType: { in: Array.from(LEGACY_CLAIMABLE_EVENT_TYPES) },
            occurredAt: { gte: from },
            OR: [
              { attributedToMemberId: requestedMemberId },
              { autoAttributedToMemberId: requestedMemberId },
            ],
          },
          orderBy: { occurredAt: "desc" },
          take: 500,
        }),
      ]);
      const rows = [...tipRows, ...hideMigratedLegacyRows(tipRows, legacyRows)].sort((a, b) => new Date(b.occurredAt || b.receivedAt || 0).getTime() - new Date(a.occurredAt || a.receivedAt || 0).getTime());
      return res.json({ ok: true, count: rows.length, attributions: rows });
    }

    const where = {
      agencyId: req.auth.agencyId,
      eventType: { in: Array.from(LEGACY_CLAIMABLE_EVENT_TYPES) },
      occurredAt: { gte: from },
    };
    if (!senior) {
      where.OR = [
        { attributedToMemberId: actor.id },
        { autoAttributedToMemberId: actor.id },
      ];
    }
    const [tipRows, legacyRows] = await Promise.all([
      listTipAudit({
        agencyId: req.auth.agencyId,
        from,
        limit: 500,
        senior,
        actorMemberId: actor.id,
      }),
      prisma.moneyAttribution.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: 500,
      }),
    ]);
    const rows = [...tipRows, ...hideMigratedLegacyRows(tipRows, legacyRows)].sort((a, b) => new Date(b.occurredAt || b.receivedAt || 0).getTime() - new Date(a.occurredAt || a.receivedAt || 0).getTime()).slice(0, 500);
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
// Claims maintenance. Safe to call repeatedly.
// - migrate fresh legacy tip rows from MoneyAttribution to TeamTipLedger
// - lock remaining legacy rows after the 48h grace period
// - purge ledgers older than the 180-day retention window

router.post("/sweep", async (req, res) => {
  try {
    const member = await requireClaimsCapability(req, res, TEAM_CAPABILITIES.OVERRIDE_ATTRIBUTION);
    if (!member) return;
    const retentionDays = Math.min(730, Math.max(1, Number(req.query.retentionDays || req.body?.retentionDays || 180)));
    const limit = Math.min(20000, Math.max(1, Number(req.query.limit || req.body?.limit || 5000)));
    const dryRun = String(req.query.dryRun || req.body?.dryRun || "").toLowerCase() === "true";

    // Run legacy tip migration before legacy lock sweep. The migration reads
    // and deletes MoneyAttribution tip rows; doing it in parallel with locks
    // creates noisy write/delete races on the same rows.
    const legacyTipMigration = await migrateLegacyTipsToTipLedger({
      agencyId: req.auth.agencyId,
      limit,
      retentionDays,
      dryRun,
      deleteLegacy: true,
    });
    const legacyLocks = await sweepLocks({ agencyId: req.auth.agencyId });

    const [tipLedgerPurge, legacyAttributionPurge] = await Promise.all([
      purgeExpiredTipLedger({
        agencyId: req.auth.agencyId,
        retentionDays,
        limit,
        dryRun,
      }),
      purgeExpiredLegacyAttributions({
        agencyId: req.auth.agencyId,
        retentionDays,
        limit,
        dryRun,
      }),
    ]);

    return res.json({
      ok: Boolean(legacyTipMigration?.ok && tipLedgerPurge?.ok && legacyAttributionPurge?.ok),
      retentionDays,
      dryRun,
      legacyTipMigration,
      legacyLocks,
      tipLedgerPurge,
      legacyAttributionPurge,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: "CLAIMS_SWEEP_FAILED",
      error: err?.message || "Failed",
    });
  }
});

module.exports = router;
