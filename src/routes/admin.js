/* src/routes/admin.js — Onlinod admin v2
   ────────────────────────────────────────────────────────────
   Full replacement. Backwards-compatible with v1 endpoints
   (frontends using /agencies, /agencies/:id, /creators/:id/...
   keep working).
   
   New surface:
     Dashboard:
       GET    /dashboard
       GET    /system/health
   
     Agencies:
       PATCH  /agencies/:id           (rename / notes)
       DELETE /agencies/:id           (soft delete, ?hard=1 for real)
       POST   /agencies/:id/restore
       POST   /agencies/:id/impersonate
   
     Members:
       GET    /agencies/:id/members
       PATCH  /members/:memberId/role
       PATCH  /members/:memberId/permissions
       DELETE /members/:memberId
   
     Users:
       GET    /users                  (filters: q, unverified, no_agency, disabled)
       GET    /users/:id
       PATCH  /users/:id              (disable/enable, name)
       POST   /users/:id/force-logout
       POST   /users/:id/reset-password
   
     Creators (cross-agency):
       GET    /creators
   
     Devices:
       GET    /devices
       POST   /devices/:id/kick
   
     Audit:
       GET    /audit                  (filters: q, agencyId, action, date range)
   
     Admin users:
       GET    /admin-users
       POST   /admin-users
       PATCH  /admin-users/:id        (disable/enable, name, role)
       POST   /admin-users/:id/reset-password
   
   Imports the existing v1 logic — DO NOT remove `/plans`,
   `/agencies` (list), `/agencies/:id`, `/agencies/:id/subscription`,
   `/creators/:id/status`, `/creators/:id/billing`,
   `/creators/:id` (delete), `/live-feed` — they remain below.
   ────────────────────────────────────────────────────────────
*/

"use strict";

const express   = require("express");
const crypto    = require("node:crypto");
const bcrypt    = require("bcryptjs");
const { z }     = require("zod");
const prisma    = require("../prisma");
const { adminRequired } = require("../middleware/admin");
const { signAccessToken } = require("../utils/tokens");

const router = express.Router();
router.use(adminRequired);


// ════════════════════════════════════════════════════════════
// Shared helpers / constants
// ════════════════════════════════════════════════════════════

const TIERS = {
  STARTER: { label: "Starter", priceCents: 2000, revenueLabel: "$0–$1k" },
  GROWTH:  { label: "Growth",  priceCents: 3000, revenueLabel: "$1k–$5k" },
  PRO:     { label: "Pro",     priceCents: 5000, revenueLabel: "$5k–$15k" },
  ELITE:   { label: "Elite",   priceCents: 15000, revenueLabel: "$15k+" },
  CUSTOM:  { label: "Custom",  priceCents: 0,    revenueLabel: "manual" },
};

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

async function adminLog(req, data) {
  // Best-effort. Never throws — admin actions must succeed even if
  // the audit insert breaks.
  try {
    await prisma.adminActionLog.create({
      data: { adminUserId: req.admin.id, ...data },
    });
  } catch (err) {
    console.warn("[adminLog] failed:", err?.message || err);
  }
}

function ensureSuperAdmin(req, res) {
  if (req.admin?.role && req.admin.role !== "SUPER_ADMIN") {
    res.status(403).json({
      ok: false,
      code: "ADMIN_INSUFFICIENT_ROLE",
      error: "This action requires SUPER_ADMIN role",
    });
    return false;
  }
  return true;
}

function validationError(res, err) {
  return res.status(400).json({
    ok: false,
    code: "VALIDATION_ERROR",
    error: err.issues?.[0]?.message || "Validation error",
    issues: err.issues || [],
  });
}

function defaultBilling(tier) {
  const key = TIERS[tier] ? tier : "STARTER";
  return {
    tier: key,
    tierMode: "MANUAL",
    corePriceCents: TIERS[key].priceCents,
    revenue30dCents: 0,
    aiChatterEnabled: false,
    aiChatterPriceCents: 10000,
    outreachEnabled: false,
    outreachPriceCents: 2900,
    billingExcluded: false,
    notes: null,
  };
}

function health(agency) {
  // Same heuristic as v1 admin.js, kept for UI compatibility.
  const creators = agency.creators || [];
  const snaps = agency.accessSnapshots || [];
  const active = new Set(snaps.filter((s) => s.active && !s.revokedAt).map((s) => s.creatorId));
  const issues = [];
  let score = 100;

  for (const c of creators) {
    if (c.deletedAt) continue;
    if (c.status === "READY" && !active.has(c.id)) {
      score -= 18;
      issues.push({ severity: "ERROR",   targetType: "creator", targetId: c.id, message: `${c.displayName} is READY but has no active snapshot` });
    }
    if (c.status === "NOT_CREATOR") {
      score -= 6;
      issues.push({ severity: "WARNING", targetType: "creator", targetId: c.id, message: `${c.displayName} is NOT_CREATOR` });
    }
    if (c.status === "READY" && c.username && !c.remoteId) {
      score -= 8;
      issues.push({ severity: "WARNING", targetType: "creator", targetId: c.id, message: `${c.displayName} has username but no remoteId — possible duplicate` });
    }
    if (c.partition === "persist:acct_demo") {
      score -= 10;
      issues.push({ severity: "WARNING", targetType: "creator", targetId: c.id, message: `${c.displayName} uses persist:acct_demo — likely test duplicate` });
    }
  }

  if (agency.status === "LOCKED" || agency.status === "PAST_DUE") {
    score -= 25;
    issues.push({ severity: "ERROR", targetType: "agency", targetId: agency.id, message: `Agency status is ${agency.status}` });
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    level: score >= 80 ? "healthy" : score >= 55 ? "warning" : "critical",
    issues,
  };
}


// ════════════════════════════════════════════════════════════
// GET /plans   (v1, kept)
// ════════════════════════════════════════════════════════════

router.get("/plans", async (_req, res) => {
  return res.json({
    ok: true,
    creatorTiers: TIERS,
    addons: {
      AI_CHATTER: { label: "AI Chatter",          priceCents: 10000, scope: "creator/month" },
      OUTREACH:   { label: "SFS + Comment Bot",   priceCents: 2900,  scope: "creator/month" },
    },
  });
});


// ════════════════════════════════════════════════════════════
// GET /dashboard   — landing metrics
// Single round-trip with everything the dashboard screen needs.
// ════════════════════════════════════════════════════════════

router.get("/dashboard", async (_req, res) => {
  try {
    // Counts. We compute multiple in parallel — Postgres handles it fine.
    const [
      agenciesTotal,
      agenciesActive,
      agenciesTrial,
      agenciesLocked,
      usersTotal,
      usersUnverified,
      creatorsTotal,
      creatorsReady,
      creatorsProblem,
      devicesTotal,
      activeSnapshotsTotal,
      recentActions,
      recentSignups,
      mrrAggregate,
    ] = await Promise.all([
      prisma.agency.count({ where: { deletedAt: null } }),
      prisma.agency.count({ where: { deletedAt: null, status: "ACTIVE" } }),
      prisma.agency.count({ where: { deletedAt: null, status: "TRIAL" } }),
      prisma.agency.count({ where: { deletedAt: null, status: { in: ["LOCKED", "PAST_DUE"] } } }),
      prisma.user.count({ where: { disabledAt: null } }),
      prisma.user.count({ where: { disabledAt: null, emailVerifiedAt: null } }),
      prisma.creatorAccount.count({ where: { deletedAt: null } }),
      prisma.creatorAccount.count({ where: { deletedAt: null, status: "READY" } }),
      prisma.creatorAccount.count({ where: { deletedAt: null, status: { in: ["NOT_CREATOR", "AUTH_FAILED", "DISABLED"] } } }),
      prisma.workerDevice.count(),
      prisma.accessSnapshot.count({ where: { active: true, revokedAt: null } }),
      prisma.adminActionLog.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.user.findMany({
        where: { disabledAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true },
      }),
      // Sum of all per-creator core prices for non-excluded billing profiles.
      // Active subscriptions only.
      prisma.creatorBillingProfile.aggregate({
        where: {
          billingExcluded: false,
          // Join via creator → agency status, but Prisma doesn't allow that
          // directly here. We approximate: include all non-excluded profiles.
          // Real MRR will be filtered client-side in the dashboard later.
        },
        _sum: { corePriceCents: true, aiChatterPriceCents: true, outreachPriceCents: true },
      }),
    ]);

    // Devices online — within last 5 min.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const devicesOnline = await prisma.workerDevice.count({
      where: { lastSeenAt: { gte: fiveMinAgo } },
    });

    return res.json({
      ok: true,
      counts: {
        agencies: {
          total: agenciesTotal,
          active: agenciesActive,
          trial: agenciesTrial,
          locked: agenciesLocked,
        },
        users: {
          total: usersTotal,
          unverified: usersUnverified,
        },
        creators: {
          total: creatorsTotal,
          ready: creatorsReady,
          problem: creatorsProblem,
        },
        devices: {
          total: devicesTotal,
          online: devicesOnline,
        },
        snapshots: {
          active: activeSnapshotsTotal,
        },
      },
      mrr: {
        // Rough — full filter happens in agency detail page.
        coreCents: Number(mrrAggregate._sum.corePriceCents || 0),
        aiChatterCents: Number(mrrAggregate._sum.aiChatterPriceCents || 0),
        outreachCents: Number(mrrAggregate._sum.outreachPriceCents || 0),
      },
      recentActions: recentActions.map((x) => ({
        id: x.id,
        action: x.action,
        agencyId: x.agencyId,
        adminUserId: x.adminUserId,
        targetType: x.targetType,
        targetId: x.targetId,
        createdAt: x.createdAt,
        reason: x.reason,
      })),
      recentSignups,
    });
  } catch (err) {
    console.error("[admin/dashboard] failed:", err);
    return res.status(500).json({ ok: false, code: "DASHBOARD_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// GET /system/health   — system status panel
// ════════════════════════════════════════════════════════════

router.get("/system/health", async (_req, res) => {
  const result = {
    ok: true,
    server: {
      version: process.env.npm_package_version || "0.7.1",
      node: process.version,
      uptime: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    db: { ok: false, latencyMs: null, error: null },
    env: {
      hasResendKey: !!process.env.RESEND_API_KEY,
      hasSnapshotKey: !!process.env.SNAPSHOT_ENCRYPTION_KEY,
      hasJwtSecret: !!process.env.JWT_SECRET && process.env.JWT_SECRET !== "change-me-super-long-random-secret",
      publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
      nodeEnv: process.env.NODE_ENV || "development",
    },
  };

  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    result.db.ok = true;
    result.db.latencyMs = Date.now() - t0;
  } catch (err) {
    result.db.ok = false;
    result.db.error = String(err?.message || err);
    result.ok = false;
  }

  return res.json(result);
});


// ════════════════════════════════════════════════════════════
// AGENCIES
// ════════════════════════════════════════════════════════════

// GET /agencies   (v1, kept; soft-deleted hidden by default, ?includeDeleted=1 to show)
router.get("/agencies", async (req, res) => {
  try {
    const includeDeleted = req.query.includeDeleted === "1";

    const agencies = await prisma.agency.findMany({
      where: includeDeleted ? {} : { deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        members:        { include: { user: true }, orderBy: { createdAt: "asc" } },
        creators:       { include: { billingProfile: true, accessSnapshots: { orderBy: { createdAt: "desc" }, take: 5 } } },
        accessSnapshots: { select: { id: true, active: true, revokedAt: true, creatorId: true, createdAt: true } },
        subscriptions:  { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    return res.json({
      ok: true,
      agencies: agencies.map((a) => {
        const owner = a.members.find((m) => m.role === "OWNER") || a.members[0] || null;
        return {
          id: a.id,
          name: a.name,
          plan: a.plan,
          status: a.status || "TRIAL",
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          deletedAt: a.deletedAt,
          owner: owner?.user ? { id: owner.user.id, email: owner.user.email, name: owner.user.name } : null,
          counts: {
            members: a.members.length,
            creators: a.creators.filter((c) => !c.deletedAt).length,
            readyCreators: a.creators.filter((c) => c.status === "READY" && !c.deletedAt).length,
            activeSnapshots: a.accessSnapshots.filter((s) => s.active && !s.revokedAt).length,
          },
          subscription: a.subscriptions[0] || null,
          health: health(a),
        };
      }),
    });
  } catch (err) {
    console.error("[admin/agencies] failed:", err);
    return res.status(500).json({ ok: false, code: "AGENCIES_LIST_FAILED", error: err?.message || "Failed" });
  }
});

// GET /agencies/:id   (v1, kept)
router.get("/agencies/:id", async (req, res) => {
  const agency = await prisma.agency.findUnique({
    where: { id: req.params.id },
    include: {
      members: { include: { user: true }, orderBy: { createdAt: "asc" } },
      creators: {
        include: { billingProfile: true, accessSnapshots: { orderBy: { createdAt: "desc" }, take: 10 } },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      },
      accessSnapshots: { orderBy: { createdAt: "desc" }, take: 150 },
      subscriptions:   { orderBy: { createdAt: "desc" }, take: 5 },
      adminActionLogs: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });

  if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
  return res.json({ ok: true, agency, health: health(agency), creatorTiers: TIERS });
});

// PATCH /agencies/:id   — rename / change status notes
const agencyPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/agencies/:id", async (req, res) => {
  try {
    const input = agencyPatchSchema.parse(req.body);
    const before = await prisma.agency.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });

    const updated = await prisma.agency.update({
      where: { id: before.id },
      data: { name: input.name ?? undefined },
    });

    await adminLog(req, {
      agencyId: before.id,
      action: "admin.agency_updated",
      targetType: "agency",
      targetId: before.id,
      before, after: updated, reason: input.reason || null,
    });

    return res.json({ ok: true, agency: updated });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "AGENCY_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

// DELETE /agencies/:id   — soft delete (default), or hard with ?hard=1 (super-admin only)
router.delete("/agencies/:id", async (req, res) => {
  try {
    const hard = req.query.hard === "1";
    if (hard && !ensureSuperAdmin(req, res)) return;

    const reason = String(req.query.reason || req.body?.reason || "").slice(0, 500) || null;

    const before = await prisma.agency.findUnique({
      where: { id: req.params.id },
      include: { members: true, creators: true, accessSnapshots: true },
    });
    if (!before) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });

    if (hard) {
      await prisma.agency.delete({ where: { id: before.id } });
      await adminLog(req, {
        agencyId: before.id,
        action: "admin.agency_hard_deleted",
        targetType: "agency",
        targetId: before.id,
        before, after: null, reason,
      });
      return res.json({ ok: true, hard: true, deleted: before });
    }

    const updated = await prisma.agency.update({
      where: { id: before.id },
      data: {
        deletedAt: new Date(),
        deletedReason: reason,
        status: "LOCKED",
      },
    });

    // Revoke all refresh sessions for this agency so live sessions die.
    await prisma.refreshSession.updateMany({
      where: { agencyId: before.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await adminLog(req, {
      agencyId: before.id,
      action: "admin.agency_soft_deleted",
      targetType: "agency",
      targetId: before.id,
      before, after: updated, reason,
    });

    return res.json({ ok: true, hard: false, agency: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AGENCY_DELETE_FAILED", error: err?.message || "Failed" });
  }
});

// POST /agencies/:id/restore   — undo soft delete
router.post("/agencies/:id/restore", async (req, res) => {
  try {
    const before = await prisma.agency.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
    if (!before.deletedAt) return res.status(409).json({ ok: false, code: "AGENCY_NOT_DELETED", error: "Agency is not deleted" });

    const updated = await prisma.agency.update({
      where: { id: before.id },
      data: { deletedAt: null, deletedReason: null, status: "TRIAL" },
    });

    await adminLog(req, {
      agencyId: before.id,
      action: "admin.agency_restored",
      targetType: "agency",
      targetId: before.id,
      before, after: updated, reason: req.body?.reason || null,
    });

    return res.json({ ok: true, agency: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AGENCY_RESTORE_FAILED", error: err?.message || "Failed" });
  }
});

// POST /agencies/:id/impersonate
//
// Issues a short-lived ImpersonationToken bound to (admin → user, agency).
// Frontend opens the customer console at /?impersonate=<token>; that page
// claims the token via /api/admin/impersonate/claim and gets a real
// access+refresh pair scoped to the target user.
//
// Body: { userId? }  — if omitted, falls back to the agency's OWNER.
const impersonateBodySchema = z.object({
  userId: z.string().optional(),
});

router.post("/agencies/:id/impersonate", async (req, res) => {
  try {
    const body = impersonateBodySchema.parse(req.body || {});

    const agency = await prisma.agency.findUnique({
      where: { id: req.params.id },
      include: { members: { include: { user: true } } },
    });
    if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });

    // Resolve target user.
    let member = null;
    if (body.userId) {
      member = agency.members.find((m) => m.userId === body.userId) || null;
    }
    if (!member) {
      member = agency.members.find((m) => m.role === "OWNER") || agency.members[0] || null;
    }
    if (!member) {
      return res.status(409).json({ ok: false, code: "AGENCY_HAS_NO_MEMBER", error: "Agency has no members to impersonate" });
    }

    const rawToken = newToken(48);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await prisma.impersonationToken.create({
      data: {
        tokenHash: sha256(rawToken),
        adminUserId: req.admin.id,
        targetUserId: member.userId,
        targetAgencyId: agency.id,
        expiresAt,
      },
    });

    await adminLog(req, {
      agencyId: agency.id,
      action: "admin.impersonate_issued",
      targetType: "user",
      targetId: member.userId,
      before: null,
      after: { adminId: req.admin.id, expiresAt },
      reason: req.body?.reason || null,
    });

    const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const url = baseUrl ? `${baseUrl}/?impersonate=${rawToken}` : `/?impersonate=${rawToken}`;

    return res.json({
      ok: true,
      url,
      token: rawToken,
      expiresAt,
      target: {
        userId: member.userId,
        userEmail: member.user.email,
        agencyId: agency.id,
        agencyName: agency.name,
      },
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "IMPERSONATE_FAILED", error: err?.message || "Failed" });
  }
});

// PATCH /agencies/:id/subscription   (v1, kept)
const subSchema = z.object({
  plan: z.string().max(80).optional(),
  status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "CANCELLED", "LOCKED"]).optional(),
  corePricePerCreatorCents: z.number().int().min(0).optional(),
  currentPeriodEnd: z.string().datetime().optional().nullable(),
  trialEndsAt: z.string().datetime().optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/agencies/:id/subscription", async (req, res) => {
  try {
    const input = subSchema.parse(req.body);
    const agency = await prisma.agency.findUnique({ where: { id: req.params.id } });
    if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });

    const beforeSub = await prisma.agencySubscription.findFirst({ where: { agencyId: agency.id }, orderBy: { createdAt: "desc" } });

    const updated = await prisma.agency.update({
      where: { id: agency.id },
      data: {
        plan: input.plan || agency.plan,
        status: input.status || agency.status || "TRIAL",
        currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : input.currentPeriodEnd === null ? null : agency.currentPeriodEnd,
        trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : input.trialEndsAt === null ? null : agency.trialEndsAt,
      },
    });

    const subData = {
      status: input.status || beforeSub?.status || "TRIAL",
      corePricePerCreatorCents: input.corePricePerCreatorCents ?? beforeSub?.corePricePerCreatorCents ?? 2000,
      currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : beforeSub?.currentPeriodEnd || null,
      trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : beforeSub?.trialEndsAt || null,
    };

    const sub = beforeSub
      ? await prisma.agencySubscription.update({ where: { id: beforeSub.id }, data: subData })
      : await prisma.agencySubscription.create({ data: { agencyId: agency.id, ...subData } });

    await adminLog(req, {
      agencyId: agency.id,
      action: "admin.subscription_changed",
      targetType: "agency",
      targetId: agency.id,
      before: { agency, subscription: beforeSub },
      after:  { agency: updated, subscription: sub },
      reason: input.reason,
    });
    return res.json({ ok: true, agency: updated, subscription: sub });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ADMIN_SUBSCRIPTION_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// MEMBERS
// ════════════════════════════════════════════════════════════

router.get("/agencies/:id/members", async (req, res) => {
  try {
    const members = await prisma.agencyMember.findMany({
      where: { agencyId: req.params.id },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    return res.json({ ok: true, members });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MEMBERS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

const memberRoleSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MANAGER", "OPERATOR"]),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/members/:memberId/role", async (req, res) => {
  try {
    const input = memberRoleSchema.parse(req.body);
    const before = await prisma.agencyMember.findUnique({
      where: { id: req.params.memberId },
      include: { user: true },
    });
    if (!before) return res.status(404).json({ ok: false, code: "MEMBER_NOT_FOUND", error: "Member not found" });

    // Don't allow demoting the last OWNER.
    if (before.role === "OWNER" && input.role !== "OWNER") {
      const otherOwners = await prisma.agencyMember.count({
        where: { agencyId: before.agencyId, role: "OWNER", id: { not: before.id } },
      });
      if (otherOwners === 0) {
        return res.status(409).json({ ok: false, code: "LAST_OWNER", error: "Cannot demote the last OWNER" });
      }
    }

    const updated = await prisma.agencyMember.update({
      where: { id: before.id },
      data: { role: input.role },
    });

    await adminLog(req, {
      agencyId: before.agencyId,
      action: "admin.member_role_changed",
      targetType: "member",
      targetId: before.id,
      before, after: updated, reason: input.reason || null,
    });
    return res.json({ ok: true, member: updated });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "MEMBER_ROLE_FAILED", error: err?.message || "Failed" });
  }
});

const memberPermsSchema = z.object({
  permissions: z.record(z.any()),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/members/:memberId/permissions", async (req, res) => {
  try {
    const input = memberPermsSchema.parse(req.body);
    const before = await prisma.agencyMember.findUnique({ where: { id: req.params.memberId } });
    if (!before) return res.status(404).json({ ok: false, code: "MEMBER_NOT_FOUND", error: "Member not found" });

    const updated = await prisma.agencyMember.update({
      where: { id: before.id },
      data: { permissions: input.permissions },
    });

    await adminLog(req, {
      agencyId: before.agencyId,
      action: "admin.member_permissions_changed",
      targetType: "member",
      targetId: before.id,
      before, after: updated, reason: input.reason || null,
    });
    return res.json({ ok: true, member: updated });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "MEMBER_PERMS_FAILED", error: err?.message || "Failed" });
  }
});

router.delete("/members/:memberId", async (req, res) => {
  try {
    const before = await prisma.agencyMember.findUnique({
      where: { id: req.params.memberId },
      include: { user: true },
    });
    if (!before) return res.status(404).json({ ok: false, code: "MEMBER_NOT_FOUND", error: "Member not found" });

    // Last OWNER guard.
    if (before.role === "OWNER") {
      const otherOwners = await prisma.agencyMember.count({
        where: { agencyId: before.agencyId, role: "OWNER", id: { not: before.id } },
      });
      if (otherOwners === 0) {
        return res.status(409).json({ ok: false, code: "LAST_OWNER", error: "Cannot remove the last OWNER" });
      }
    }

    await prisma.agencyMember.delete({ where: { id: before.id } });

    // Kill all refresh sessions for this user/agency pair.
    await prisma.refreshSession.updateMany({
      where: { userId: before.userId, agencyId: before.agencyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await adminLog(req, {
      agencyId: before.agencyId,
      action: "admin.member_kicked",
      targetType: "member",
      targetId: before.id,
      before, after: null,
      reason: String(req.query.reason || req.body?.reason || "").slice(0, 500) || null,
    });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MEMBER_DELETE_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════

router.get("/users", async (req, res) => {
  try {
    const q          = String(req.query.q || "").trim();
    const unverified = req.query.unverified === "1";
    const noAgency   = req.query.no_agency === "1";
    const disabled   = req.query.disabled === "1";

    const where = {};
    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name:  { contains: q, mode: "insensitive" } },
      ];
    }
    if (unverified) where.emailVerifiedAt = null;
    if (disabled)   where.disabledAt = { not: null };
    if (!disabled)  where.disabledAt = where.disabledAt ?? null;

    let users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        _count: { select: { agencies: true } },
      },
    });

    if (noAgency) {
      users = users.filter((u) => u._count.agencies === 0);
    }

    return res.json({
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl,
        emailVerifiedAt: u.emailVerifiedAt,
        disabledAt: u.disabledAt,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        agenciesCount: u._count.agencies,
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "USERS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        agencies: { include: { agency: true } },
      },
    });
    if (!user) return res.status(404).json({ ok: false, code: "USER_NOT_FOUND", error: "User not found" });

    const sessions = await prisma.refreshSession.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        emailVerifiedAt: user.emailVerifiedAt,
        disabledAt: user.disabledAt,
        disabledReason: user.disabledReason,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
      memberships: user.agencies.map((m) => ({
        id: m.id,
        agency: { id: m.agency.id, name: m.agency.name, status: m.agency.status, deletedAt: m.agency.deletedAt },
        role: m.role,
        permissions: m.permissions,
        createdAt: m.createdAt,
      })),
      sessions,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "USER_READ_FAILED", error: err?.message || "Failed" });
  }
});

const userPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  disabled: z.boolean().optional(),
  disabledReason: z.string().max(500).optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/users/:id", async (req, res) => {
  try {
    const input = userPatchSchema.parse(req.body);
    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ ok: false, code: "USER_NOT_FOUND", error: "User not found" });

    const data = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.disabled === true)  { data.disabledAt = before.disabledAt || new Date(); data.disabledReason = input.disabledReason || null; }
    if (input.disabled === false) { data.disabledAt = null; data.disabledReason = null; }

    const updated = await prisma.user.update({ where: { id: before.id }, data });

    if (input.disabled === true) {
      // Kill all refresh sessions on disable.
      await prisma.refreshSession.updateMany({
        where: { userId: before.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await adminLog(req, {
      agencyId: null,
      action: "admin.user_updated",
      targetType: "user",
      targetId: before.id,
      before, after: updated, reason: input.reason || null,
    });
    return res.json({ ok: true, user: updated });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "USER_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/users/:id/force-logout", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ ok: false, code: "USER_NOT_FOUND", error: "User not found" });

    const result = await prisma.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await adminLog(req, {
      agencyId: null,
      action: "admin.user_force_logout",
      targetType: "user",
      targetId: user.id,
      before: null,
      after: { revokedSessions: result.count },
      reason: req.body?.reason || null,
    });

    return res.json({ ok: true, revokedSessions: result.count });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "USER_FORCE_LOGOUT_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/users/:id/reset-password", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ ok: false, code: "USER_NOT_FOUND", error: "User not found" });

    // Generate a temp password. Admin shows it once, user changes it.
    // We don't email it — that's customer's responsibility.
    const tempPassword = newToken(9).slice(0, 14);
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.refreshSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await adminLog(req, {
      agencyId: null,
      action: "admin.user_password_reset",
      targetType: "user",
      targetId: user.id,
      before: null, after: null,
      reason: req.body?.reason || null,
    });

    return res.json({ ok: true, tempPassword });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "USER_PASSWORD_RESET_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// CREATORS — cross-agency listing + per-creator ops
// ════════════════════════════════════════════════════════════

router.get("/creators", async (req, res) => {
  try {
    const q        = String(req.query.q || "").trim();
    const status   = String(req.query.status || "").trim().toUpperCase();
    const tier     = String(req.query.tier || "").trim().toUpperCase();
    const agencyId = String(req.query.agencyId || "").trim();
    const noSnap   = req.query.no_snapshot === "1";

    const where = { deletedAt: null };
    if (q) {
      where.OR = [
        { displayName: { contains: q, mode: "insensitive" } },
        { username:    { contains: q, mode: "insensitive" } },
        { remoteId:    { contains: q, mode: "insensitive" } },
      ];
    }
    if (status)   where.status = status;
    if (agencyId) where.agencyId = agencyId;

    let creators = await prisma.creatorAccount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        agency: { select: { id: true, name: true, status: true, deletedAt: true } },
        billingProfile: true,
        accessSnapshots: {
          where: { active: true, revokedAt: null },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (tier)   creators = creators.filter((c) => c.billingProfile?.tier === tier);
    if (noSnap) creators = creators.filter((c) => c.accessSnapshots.length === 0);

    return res.json({
      ok: true,
      creators: creators.map((c) => ({
        id: c.id,
        agencyId: c.agencyId,
        agencyName: c.agency?.name,
        displayName: c.displayName,
        username: c.username,
        remoteId: c.remoteId,
        avatarUrl: c.avatarUrl,
        status: c.status,
        partition: c.partition,
        createdAt: c.createdAt,
        billingTier: c.billingProfile?.tier || null,
        billingExcluded: !!c.billingProfile?.billingExcluded,
        revenue30dCents: Number(c.billingProfile?.revenue30dCents || 0),
        hasActiveSnapshot: c.accessSnapshots.length > 0,
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "CREATORS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

// PATCH /creators/:id/status   (v1, kept)
router.patch("/creators/:id/status", async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["DRAFT", "READY", "NOT_CREATOR", "AUTH_FAILED", "DISABLED"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status" });
  }

  const before = await prisma.creatorAccount.findUnique({ where: { id: req.params.id }, include: { billingProfile: true } });
  if (!before) return res.status(404).json({ ok: false, error: "Creator not found" });

  const creator = await prisma.creatorAccount.update({ where: { id: before.id }, data: { status } });
  await adminLog(req, {
    agencyId: before.agencyId,
    action: "admin.creator_status_changed",
    targetType: "creator",
    targetId: before.id,
    before, after: creator, reason: req.body?.reason || null,
  });
  return res.json({ ok: true, creator });
});

// PATCH /creators/:id/billing   (v1, kept)
const billingSchema = z.object({
  tier: z.enum(["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"]).optional(),
  tierMode: z.enum(["MANUAL", "AUTO"]).optional(),
  corePriceCents: z.number().int().min(0).max(1000000).optional(),
  revenue30dCents: z.number().int().min(0).max(10000000000).optional(),
  aiChatterEnabled: z.boolean().optional(),
  aiChatterPriceCents: z.number().int().min(0).max(1000000).optional(),
  outreachEnabled: z.boolean().optional(),
  outreachPriceCents: z.number().int().min(0).max(1000000).optional(),
  billingExcluded: z.boolean().optional(),
  notes: z.string().max(3000).optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/creators/:id/billing", async (req, res) => {
  try {
    const input = billingSchema.parse(req.body);
    const creator = await prisma.creatorAccount.findUnique({ where: { id: req.params.id }, include: { billingProfile: true } });
    if (!creator) return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });

    const before = creator.billingProfile || null;
    const tier = input.tier || before?.tier || "STARTER";
    const d = defaultBilling(tier);
    const data = {
      agencyId: creator.agencyId,
      tier,
      tierMode: input.tierMode || before?.tierMode || d.tierMode,
      corePriceCents: input.corePriceCents ?? before?.corePriceCents ?? d.corePriceCents,
      revenue30dCents: input.revenue30dCents ?? before?.revenue30dCents ?? d.revenue30dCents,
      aiChatterEnabled: input.aiChatterEnabled ?? before?.aiChatterEnabled ?? d.aiChatterEnabled,
      aiChatterPriceCents: input.aiChatterPriceCents ?? before?.aiChatterPriceCents ?? d.aiChatterPriceCents,
      outreachEnabled: input.outreachEnabled ?? before?.outreachEnabled ?? d.outreachEnabled,
      outreachPriceCents: input.outreachPriceCents ?? before?.outreachPriceCents ?? d.outreachPriceCents,
      billingExcluded: input.billingExcluded ?? before?.billingExcluded ?? d.billingExcluded,
      notes: input.notes !== undefined ? input.notes : before?.notes || null,
    };

    const billing = before
      ? await prisma.creatorBillingProfile.update({ where: { creatorId: creator.id }, data })
      : await prisma.creatorBillingProfile.create({ data: { creatorId: creator.id, ...data } });

    await adminLog(req, {
      agencyId: creator.agencyId,
      action: "admin.creator_billing_changed",
      targetType: "creator",
      targetId: creator.id,
      before, after: billing,
      reason: input.reason || "manual creator billing update",
    });
    return res.json({ ok: true, billing });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ADMIN_CREATOR_BILLING_FAILED", error: err?.message || "Failed to update creator billing" });
  }
});

// DELETE /creators/:id   (v1, kept; now soft-delete by default)
router.delete("/creators/:id", async (req, res) => {
  const hard = req.query.hard === "1";
  if (hard && !ensureSuperAdmin(req, res)) return;

  const before = await prisma.creatorAccount.findUnique({
    where: { id: req.params.id },
    include: { billingProfile: true, accessSnapshots: true },
  });
  if (!before) return res.status(404).json({ ok: false, error: "Creator not found" });

  if (hard) {
    await prisma.creatorAccount.delete({ where: { id: before.id } });
  } else {
    await prisma.creatorAccount.update({
      where: { id: before.id },
      data: { deletedAt: new Date(), status: "DISABLED" },
    });
    // Revoke active snapshots so live workers stop using them.
    await prisma.accessSnapshot.updateMany({
      where: { creatorId: before.id, active: true, revokedAt: null },
      data: { active: false, revokedAt: new Date() },
    });
  }

  await adminLog(req, {
    agencyId: before.agencyId,
    action: hard ? "admin.creator_hard_deleted" : "admin.creator_soft_deleted",
    targetType: "creator",
    targetId: before.id,
    before, after: null,
    reason: String(req.query.reason || req.body?.reason || "admin cleanup"),
  });
  return res.json({ ok: true, hard, deleted: before });
});


// ════════════════════════════════════════════════════════════
// DEVICES
// ════════════════════════════════════════════════════════════

router.get("/devices", async (req, res) => {
  try {
    const q        = String(req.query.q || "").trim();
    const agencyId = String(req.query.agencyId || "").trim();
    const onlyOnline  = req.query.online === "1";
    const onlyOffline = req.query.offline === "1";

    const where = {};
    if (agencyId) where.agencyId = agencyId;
    if (q) {
      where.OR = [
        { deviceName: { contains: q, mode: "insensitive" } },
        { platform:   { contains: q, mode: "insensitive" } },
      ];
    }

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (onlyOnline)  where.lastSeenAt = { gte: fiveMinAgo };
    if (onlyOffline) where.lastSeenAt = { lt: fiveMinAgo };

    const devices = await prisma.workerDevice.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      take: 500,
    });

    return res.json({ ok: true, devices });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "DEVICES_LIST_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/devices/:id/kick", async (req, res) => {
  try {
    const device = await prisma.workerDevice.findUnique({ where: { id: req.params.id } });
    if (!device) return res.status(404).json({ ok: false, code: "DEVICE_NOT_FOUND", error: "Device not found" });

    // Queue command for Electron to pick up on next heartbeat.
    const command = await prisma.deviceCommand.create({
      data: {
        deviceId: device.id,
        agencyId: device.agencyId,
        command: "FORCE_LOGOUT",
        payload: { reason: req.body?.reason || "admin kick" },
        issuedByAdmin: req.admin.id,
      },
    });

    // Also revoke refresh sessions for this user immediately.
    await prisma.refreshSession.updateMany({
      where: { userId: device.userId, agencyId: device.agencyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await adminLog(req, {
      agencyId: device.agencyId,
      action: "admin.device_kicked",
      targetType: "device",
      targetId: device.id,
      before: device, after: null,
      reason: req.body?.reason || null,
    });

    return res.json({ ok: true, command });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "DEVICE_KICK_FAILED", error: err?.message || "Failed" });
  }
});


// ════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════

router.get("/audit", async (req, res) => {
  try {
    const q        = String(req.query.q || "").trim();
    const agencyId = String(req.query.agencyId || "").trim();
    const action   = String(req.query.action || "").trim();
    const target   = String(req.query.targetType || "").trim();
    const before   = req.query.before  ? new Date(String(req.query.before))  : null;
    const after    = req.query.after   ? new Date(String(req.query.after))   : null;
    const limit    = Math.min(500, Math.max(10, Number(req.query.limit) || 100));

    // Combine admin actions and audit logs into one feed. Each kind has
    // its own table — we read both and merge sorted by createdAt desc.
    const whereAdmin = {};
    const whereAudit = {};

    if (agencyId) { whereAdmin.agencyId = agencyId; whereAudit.agencyId = agencyId; }
    if (action)   { whereAdmin.action   = { contains: action, mode: "insensitive" }; whereAudit.action   = { contains: action, mode: "insensitive" }; }
    if (target)   { whereAdmin.targetType = target; whereAudit.targetType = target; }

    if (before || after) {
      const dateFilter = {};
      if (before) dateFilter.lt  = before;
      if (after)  dateFilter.gte = after;
      whereAdmin.createdAt = dateFilter;
      whereAudit.createdAt = dateFilter;
    }

    const [adminActions, auditLogs] = await Promise.all([
      prisma.adminActionLog.findMany({ where: whereAdmin, orderBy: { createdAt: "desc" }, take: limit }),
      prisma.auditLog.findMany({       where: whereAudit, orderBy: { createdAt: "desc" }, take: limit }),
    ]);

    const events = [
      ...adminActions.map((x) => ({
        id: `admin:${x.id}`,
        kind: "admin",
        action: x.action,
        agencyId: x.agencyId,
        actorAdminId: x.adminUserId,
        actorUserId: null,
        targetType: x.targetType,
        targetId: x.targetId,
        metadata: { before: x.before, after: x.after, reason: x.reason },
        createdAt: x.createdAt,
      })),
      ...auditLogs.map((x) => ({
        id: `audit:${x.id}`,
        kind: "user",
        action: x.action,
        agencyId: x.agencyId,
        actorAdminId: null,
        actorUserId: x.actorUserId,
        targetType: x.targetType,
        targetId: x.targetId,
        metadata: x.metadata,
        createdAt: x.createdAt,
      })),
    ];

    events.sort((a, b) => b.createdAt - a.createdAt);

    let filtered = events;
    if (q) {
      const needle = q.toLowerCase();
      filtered = events.filter((e) =>
        (e.action || "").toLowerCase().includes(needle) ||
        (e.targetId || "").toLowerCase().includes(needle) ||
        (e.agencyId || "").toLowerCase().includes(needle)
      );
    }

    return res.json({ ok: true, events: filtered.slice(0, limit) });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUDIT_FAILED", error: err?.message || "Failed" });
  }
});

// /live-feed   (v1, kept) — live tail of admin actions
router.get("/live-feed", async (req, res) => {
  const agencyId = String(req.query.agencyId || "").trim() || undefined;
  const logs = await prisma.adminActionLog.findMany({
    where: agencyId ? { agencyId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json({
    ok: true,
    events: logs.map((x) => ({
      id: x.id,
      source: "admin",
      action: x.action,
      agencyId: x.agencyId,
      actorUserId: x.adminUserId,
      targetType: x.targetType,
      targetId: x.targetId,
      metadata: { before: x.before, after: x.after, reason: x.reason },
      createdAt: x.createdAt,
    })),
  });
});


// ════════════════════════════════════════════════════════════
// ADMIN USERS  (manage admins of Onlinod itself)
// ════════════════════════════════════════════════════════════

router.get("/admin-users", async (_req, res) => {
  try {
    const admins = await prisma.adminUser.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, email: true, name: true, role: true, active: true,
        lastLoginAt: true, createdAt: true,
      },
    });
    return res.json({ ok: true, admins });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "ADMIN_USERS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

const adminCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120).optional(),
  role: z.enum(["SUPER_ADMIN", "SUPPORT"]).optional(),
});

router.post("/admin-users", async (req, res) => {
  try {
    if (!ensureSuperAdmin(req, res)) return;

    const input = adminCreateSchema.parse(req.body);
    const email = input.email.toLowerCase().trim();

    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ ok: false, code: "EMAIL_TAKEN", error: "Admin with this email already exists" });

    const passwordHash = await bcrypt.hash(input.password, 12);
    const admin = await prisma.adminUser.create({
      data: {
        email,
        passwordHash,
        name: input.name || null,
        role: input.role || "SUPER_ADMIN",
        active: true,
      },
    });

    await adminLog(req, {
      agencyId: null,
      action: "admin.admin_created",
      targetType: "admin",
      targetId: admin.id,
      before: null, after: { id: admin.id, email: admin.email, role: admin.role },
      reason: req.body?.reason || null,
    });

    return res.status(201).json({
      ok: true,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, active: admin.active },
    });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ADMIN_CREATE_FAILED", error: err?.message || "Failed" });
  }
});

const adminPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  role: z.enum(["SUPER_ADMIN", "SUPPORT"]).optional(),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/admin-users/:id", async (req, res) => {
  try {
    if (!ensureSuperAdmin(req, res)) return;

    const input = adminPatchSchema.parse(req.body);
    const before = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ ok: false, code: "ADMIN_NOT_FOUND", error: "Admin not found" });

    // Don't allow self-disable (lock yourself out).
    if (input.active === false && before.id === req.admin.id) {
      return res.status(409).json({ ok: false, code: "CANNOT_DISABLE_SELF", error: "Cannot disable yourself" });
    }

    const data = {};
    if (input.name   !== undefined) data.name   = input.name;
    if (input.active !== undefined) data.active = input.active;
    if (input.role   !== undefined) data.role   = input.role;

    const updated = await prisma.adminUser.update({ where: { id: before.id }, data });

    if (input.active === false) {
      await prisma.adminSession.updateMany({
        where: { adminUserId: before.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await adminLog(req, {
      agencyId: null,
      action: "admin.admin_updated",
      targetType: "admin",
      targetId: before.id,
      before, after: updated, reason: input.reason || null,
    });

    return res.json({ ok: true, admin: updated });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ADMIN_UPDATE_FAILED", error: err?.message || "Failed" });
  }
});

const adminPasswordResetSchema = z.object({
  password: z.string().min(8),
  reason: z.string().max(500).optional().nullable(),
});

router.post("/admin-users/:id/reset-password", async (req, res) => {
  try {
    if (!ensureSuperAdmin(req, res)) return;

    const input = adminPasswordResetSchema.parse(req.body);
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ ok: false, code: "ADMIN_NOT_FOUND", error: "Admin not found" });

    const passwordHash = await bcrypt.hash(input.password, 12);
    await prisma.$transaction([
      prisma.adminUser.update({ where: { id: target.id }, data: { passwordHash } }),
      prisma.adminSession.updateMany({
        where: { adminUserId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await adminLog(req, {
      agencyId: null,
      action: "admin.admin_password_reset",
      targetType: "admin",
      targetId: target.id,
      before: null, after: null, reason: input.reason || null,
    });

    return res.json({ ok: true });
  } catch (err) {
    if (err?.issues) return validationError(res, err);
    return res.status(500).json({ ok: false, code: "ADMIN_PASSWORD_RESET_FAILED", error: err?.message || "Failed" });
  }
});


module.exports = router;
