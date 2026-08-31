"use strict";

const express = require("express");
const { z } = require("zod");
const {
  listDisputable,
  sweepLocks,
  purgeExpiredLegacyAttributions,
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
const { reconcileHistoricalTeamMoneyBatch } = require("../services/team-money-reconciliation-service");
const prisma = require("../prisma");
const { TEAM_CAPABILITIES, canUseTeamCapability } = require("../services/team-capabilities");

const router = express.Router();

function memberCreatorScope(member) {
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

function creatorScopeWhere(allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return {};
  const ids = Array.from(new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean)));
  return { creatorId: { in: ids.length ? ids : ["__none__"] } };
}

function creatorAllowed(creatorId, allowedCreatorIds) {
  if (!Array.isArray(allowedCreatorIds)) return true;
  const ids = new Set(allowedCreatorIds.map(String).map((id) => id.trim()).filter(Boolean));
  return ids.has(String(creatorId || ""));
}

async function loadActorMember(req) {
  if (!req.auth?.agencyId || !req.auth?.userId) return null;
  return prisma.agencyMember.findFirst({
    where: { agencyId: req.auth.agencyId, userId: req.auth.userId, deletedAt: null, deactivatedAt: null },
    select: { id: true, agencyId: true, userId: true, roleKey: true, role: true, permissions: true, assignedCreators: true },
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

function stripManualResolutionPayload(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result || null;
  const safe = { ...result };
  delete safe.manualResolution;
  delete safe.manualResolutions;
  return safe;
}

function claimRowForViewer(row, { actorMemberId, canViewAudit }) {
  if (!row || canViewAudit || isOwnClaimRow(row, actorMemberId)) return row;
  return {
    ...row,
    history: [],
    manualResolutions: [],
    result: stripManualResolutionPayload(row.result),
  };
}

async function claimsContext(req, actor) {
  const [viewAttribution, claimOwn, releaseOwn, resolveAttribution, overrideAttribution, viewAudit] = await Promise.all([
    canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.VIEW_ATTRIBUTION }),
    canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.CLAIM_OWN }),
    canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.RELEASE_OWN }),
    canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.RESOLVE_ATTRIBUTION }),
    canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.OVERRIDE_ATTRIBUTION }),
    canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.VIEW_AUDIT }),
  ]);
  const capabilities = { viewAttribution, claimOwn, releaseOwn, resolveAttribution, overrideAttribution, viewAudit };
  // A write-only override permission must not implicitly disclose claim rows.
  // The workspace opens only with an actual read/discovery capability;
  // overrideAttribution remains an action capability layered on top.
  const canViewClaims = viewAttribution || claimOwn || releaseOwn || resolveAttribution || viewAudit;
  if (!canViewClaims) return { forbidden: true, capabilities };

  const allowedCreatorIds = memberCreatorScope(actor);
  const canResolveOthers = resolveAttribution || overrideAttribution;
  const memberWhere = canResolveOthers
    ? { agencyId: req.auth.agencyId, deletedAt: null }
    : { agencyId: req.auth.agencyId, id: actor.id, deletedAt: null };

  const [members, creators] = await Promise.all([
    prisma.agencyMember.findMany({
      where: memberWhere,
      include: {
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
        teamFunctions: { select: { functionKey: true } },
      },
      orderBy: [{ deactivatedAt: "asc" }, { createdAt: "asc" }],
      take: 10000,
    }),
    prisma.creatorAccount.findMany({
      where: {
        agencyId: req.auth.agencyId,
        deletedAt: null,
        ...(Array.isArray(allowedCreatorIds) ? { id: { in: allowedCreatorIds.length ? allowedCreatorIds : ["__none__"] } } : {}),
      },
      select: { id: true, displayName: true, username: true, avatarUrl: true },
      orderBy: { displayName: "asc" },
      take: 10000,
    }),
  ]);

  return {
    forbidden: false,
    context: {
      ok: true,
      agencyId: req.auth.agencyId,
      viewerMemberId: actor.id,
      creatorScope: Array.isArray(allowedCreatorIds) ? allowedCreatorIds : "all",
      capabilities,
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId || null,
        name: member.displayName || member.user?.name || member.user?.email || "member",
        email: member.user?.email || null,
        avatarUrl: member.user?.avatarUrl || null,
        status: member.deactivatedAt ? "deactivated" : "active",
        roleKey: String(member.roleKey || member.role || "chatter").toLowerCase(),
        functions: Array.from(new Set((member.teamFunctions || []).map((row) => String(row.functionKey || "").trim().toUpperCase()).filter(Boolean))),
      })),
      creators: creators.map((creator) => ({
        id: creator.id,
        displayName: creator.displayName || creator.username || creator.id,
        username: creator.username || null,
        avatarUrl: creator.avatarUrl || null,
      })),
    },
  };
}

// --------------------------------------------------------------------
// GET /api/team/claims/context
// --------------------------------------------------------------------
// V9 desktop bootstrap. Returns only the server-authoritative capability
// matrix and selector metadata needed by the Claims UI. Regular chatters
// receive only their own member row; the agency member directory is exposed
// only to viewers who can resolve/override attribution. Creator rows are
// always intersected with the viewer's creator scope.
router.get("/context", async (req, res) => {
  try {
    const actor = await loadActorMember(req);
    if (!actor) return res.status(403).json({ ok: false, code: "NOT_AGENCY_MEMBER", error: "No agency membership" });
    const result = await claimsContext(req, actor);
    if (result.forbidden) {
      return res.status(403).json({ ok: false, code: "CLAIMS_VIEW_FORBIDDEN", error: "Claims permission is required" });
    }
    return res.json(result.context);
  } catch (err) {
    console.error("[claims/context] failed:", err);
    return res.status(500).json({ ok: false, code: "CLAIMS_CONTEXT_FAILED", error: err?.message || "Failed" });
  }
});

// --------------------------------------------------------------------
// Legacy client-side money ingest was retired by Audit15. Claims may only
// resolve or audit money facts that already exist in canonical Team ledgers.
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// POST /api/team/claims/override
// --------------------------------------------------------------------
// Manual claim/release/manager_override.
// Chatters can claim/release only eligible tip rows tied to their work.
// manager_override is owner/manager-only. PPV is handled by PPV ledger.
// Subscriptions are not Team member revenue and are intentionally not claimable.

const overrideSchema = z.object({
  eventHash: z.string().min(1).max(120),
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
    const allowedCreatorIds = memberCreatorScope(actor);
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
      allowedCreatorIds,
    });

    // Audit15 Closure2: current Claims never writes legacy MoneyAttribution.
    // Any still-retained tip row is migration input only and will become a
    // TeamTipLedger row through the automatic locked migration sweep.

    if (!result.ok) {
      const status = result.code === "ATTRIBUTION_LOCKED" ? 409
                   : result.code === "CREATOR_ACCESS_FORBIDDEN" ? 403
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
    const [senior, canClaimOwn, canReleaseOwn, canViewAudit] = await Promise.all([
      canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.VIEW_ATTRIBUTION }),
      canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.CLAIM_OWN }),
      canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.RELEASE_OWN }),
      canUseTeamCapability({ member: actor, key: TEAM_CAPABILITIES.VIEW_AUDIT }),
    ]);
    const allowedCreatorIds = memberCreatorScope(actor);
    if (!senior && !canClaimOwn && !canReleaseOwn) {
      return res.status(403).json({ ok: false, code: "CLAIMS_VIEW_FORBIDDEN", error: "Claims permission is required" });
    }
    const [tipRows, legacyRows] = await Promise.all([
      listTipClaims({
        agencyId: req.auth.agencyId,
        limit,
        actorMemberId: actor.id,
        senior,
        allowedCreatorIds,
      }),
      listDisputable({
        agencyId: req.auth.agencyId,
        limit,
        actorMemberId: actor.id,
        senior,
        allowedCreatorIds,
      }),
    ]);
    const rows = [...tipRows, ...hideMigratedLegacyRows(tipRows, legacyRows)]
      .sort((a, b) => new Date(b.occurredAt || b.receivedAt || 0).getTime() - new Date(a.occurredAt || a.receivedAt || 0).getTime())
      .slice(0, limit)
      .map((row) => claimRowForViewer(row, { actorMemberId: actor.id, canViewAudit }));
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
    const allowedCreatorIds = memberCreatorScope(actor);

    if (eventHash) {
      const tipRow = await getTipClaimByHash({ agencyId: req.auth.agencyId, eventHash, allowedCreatorIds });
      if (tipRow) {
        if (!senior && !isOwnClaimRow(tipRow, actor.id)) {
          return res.status(403).json({ ok: false, code: "CLAIMS_AUDIT_FORBIDDEN" });
        }
        return res.json({ ok: true, attribution: tipRow });
      }

      const row = await prisma.moneyAttribution.findUnique({
        where: { agencyId_eventHash: { agencyId: req.auth.agencyId, eventHash } },
      });
      if (!row || !isLegacyClaimableRow(row) || !creatorAllowed(row.creatorId, allowedCreatorIds)) return res.json({ ok: true, attribution: null });
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
          allowedCreatorIds,
        }),
        prisma.moneyAttribution.findMany({
          where: {
            agencyId: req.auth.agencyId,
            ...creatorScopeWhere(allowedCreatorIds),
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
      ...creatorScopeWhere(allowedCreatorIds),
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
        allowedCreatorIds,
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
    const canonicalMoneyBackfill = dryRun
      ? { ok: true, skipped: true, reason: "DRY_RUN" }
      : await reconcileHistoricalTeamMoneyBatch({
          agencyId: req.auth.agencyId,
          saleLimit: Math.min(1000, limit),
          tipLimit: Math.min(1000, limit),
          retentionDays,
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
      canonicalMoneyBackfill,
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
