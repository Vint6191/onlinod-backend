const { operationHandler, setBillingPolicyHandler, setBillingHoldHandler, setEntitlementHandler, setPricingHandler, createAdminHandler, patchAdminHandler, resetAdminPasswordHandler } = require("./admin-command-handlers");
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
const { getRetentionSettings, updateRetentionSettings, resetRetentionSettings, runRetentionSweep } = require("../services/retention-service");
const { dbAuthorityNow } = require("../services/db-time-authority-service");
const { publicEntitlement, lockAgencyBillingMutation, syncAgencyBillingAggregate } = require("../services/billing-entitlement-service");
const { TIER_CATALOG } = require("../services/billing-catalog-service");
const { retireCreatorWithinTransaction, publishCreatorRetirementControlEvents } = require("../services/creator-lifecycle-authority-service");
const { assertTeamControlPlaneWriteAdmission } = require("../services/phase2-release-compatibility-authority-service");
const { assertAgencyHasOperationalOwner } = require("../services/team-operational-owner-authority-service");
const {
  removeMember: removeTeamMember,
  updateMemberAccessByPlatformAdmin,
  assertUserDisableOwnerSafety,
} = require("../services/team-administration-service");
const {
  agencyCustomPipelineBlockers,
  assertAgencyCustomPipelineRetirable,
  lockAgencyPipelineLifecycle,
  lockAgencyPipelineLifecycleExclusive,
} = require("../services/custom-content-pipeline-authority-service");
const { assertAgencyMassCampaignRetirable } = require("../services/mass-campaign-authority-service");
const { publishDesktopControlEvent } = require("../services/desktop-control-events");
const { publishDomainWork, WORK_CLASS: PHASE2_WORK_CLASS } = require("../services/domain-work-authority-service");
const { acquireAuthorizationUserLock } = require("../services/authorization-session-authority-service");
const {
  listPoisonedSubscriberMaintenanceSignals,
  requeuePoisonedSubscriberMaintenanceSignal,
} = require("../services/subscriber-directory-maintenance-signal-service");
const { getRecurringSchedulerHealthSnapshot } = require("../services/job-scheduler");

const router = require("./admin-router").createAdminRouter();


function canonicalMemberRoleKeyFromLegacy(role) {
  const value = String(role || "").trim().toUpperCase();
  if (value === "OWNER") return "owner";
  if (value === "ADMIN" || value === "MANAGER") return "manager";
  return "chatter";
}

function memberIsCanonicalOwner(member) {
  return String(member?.role || "").trim().toUpperCase() === "OWNER"
    || String(member?.roleKey || "").trim().toLowerCase() === "owner";
}

function publishAdminMemberAccessEpoch(req, member, accessEpochOverride = null) {
  if (!member?.id || !member?.agencyId) return;
  const epoch = Number(accessEpochOverride ?? member.accessEpoch);
  if (!Number.isInteger(epoch) || epoch < 1) return;
  try {
    publishDesktopControlEvent({
      type: "ACCESS_EPOCH_CHANGED",
      agencyId: member.agencyId,
      accessEpoch: epoch,
      targetUserId: member.userId || member.user?.id || null,
      targetMemberId: member.id,
      sourceDeviceId: req.auth?.deviceId || null,
      requestId: req.headers?.["x-request-id"] || null,
    });
  } catch (error) {
    console.error("[admin/control-access-epoch] failed:", error);
  }
}

router.use(adminRequired);
router.use(require("../middleware/admin-read-boundary").adminReadBoundary);


// ════════════════════════════════════════════════════════════
// Shared helpers / constants
// ════════════════════════════════════════════════════════════

const TIERS = Object.freeze(Object.fromEntries(
  Object.entries(TIER_CATALOG).map(([key, row]) => [key, {
    label: row.label,
    priceCents: Number(row.priceCents || 0),
    revenueLabel: row.revenueLabel,
  }]),
));

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

function adminAuditMiddleware(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    if (!req.admin?.id) return;
    const pathForAction = String(req.route?.path || req.path || "unknown")
      .replace(/[^a-zA-Z0-9:_/-]+/g, "_")
      .slice(0, 140);

    const agencyIdForLog = req.params?.agencyId || (/^\/agencies\//.test(String(req.path || "")) ? req.params?.id : null);

    adminLog(req, {
      agencyId: agencyIdForLog || null,
      action: `admin.http.${String(req.method || "GET").toLowerCase()}.${pathForAction}`,
      targetType: "admin_route",
      targetId: req.params?.id || req.params?.memberId || req.params?.userId || req.params?.creatorId || null,
      after: {
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      },
    });
  });
  next();
}

router.use(adminAuditMiddleware);

function ensureSuperAdmin(req, res) {
  if (req.admin?.role !== "SUPER_ADMIN") {
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
    tierMode: key === "CUSTOM" ? "MANUAL" : "AUTO",
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
  const creators = agency.creators || [];
  const issues = [];
  let score = 100;

  for (const c of creators) {
    if (c.deletedAt) continue;
    const canonicalReady = c.sessionState?.status === "ACTIVE" && c.sessionState?.portableReady === true;
    if (c.status === "READY" && !canonicalReady) {
      score -= 18;
      issues.push({ severity: "ERROR", targetType: "creator", targetId: c.id, message: `${c.displayName} is READY but has no portable ACTIVE canonical session` });
    }
    if (c.status === "NOT_CREATOR") {
      score -= 6;
      issues.push({ severity: "WARNING", targetType: "creator", targetId: c.id, message: `${c.displayName} is NOT_CREATOR` });
    }
    if (c.status === "READY" && c.username && !c.remoteId) {
      score -= 8;
      issues.push({ severity: "WARNING", targetType: "creator", targetId: c.id, message: `${c.displayName} has username but no remoteId — possible duplicate` });
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
      activeCanonicalSessionsTotal,
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
      prisma.creatorSessionState.count({ where: { status: "ACTIVE", portableReady: true, creator: { deletedAt: null } } }),
      prisma.adminActionLog.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.user.findMany({
        where: { disabledAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, email: true, name: true, createdAt: true, emailVerifiedAt: true },
      }),
      // Exact active entitlement rows. Prices are snapshotted into the entitlement
      // when access is granted, so later pricing-config edits do not rewrite MRR.
      prisma.creatorBillingEntitlement.findMany({
        where: {
          agency: { deletedAt: null },
          OR: [
            { coreValidUntil: { gt: new Date() } },
            { aiChatterValidUntil: { gt: new Date() } },
            { outreachValidUntil: { gt: new Date() } },
          ],
        },
        select: {
          agencyId: true,
          agency: { select: { subscriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { billingMode: true } } } },
          corePriceCents: true, coreValidUntil: true,
          aiChatterPriceCents: true, aiChatterValidUntil: true,
          outreachPriceCents: true, outreachValidUntil: true,
        },
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
        canonicalSessions: {
          activePortable: activeCanonicalSessionsTotal,
        },
      },
      mrr: (() => {
        const now = new Date();
        let coreCents = 0;
        let aiChatterCents = 0;
        let outreachCents = 0;
        for (const row of mrrAggregate) {
          if (row.agency?.subscriptions?.[0]?.billingMode === "FREE_INTERNAL") continue;
          if (row.coreValidUntil && new Date(row.coreValidUntil) > now) coreCents += Number(row.corePriceCents || 0);
          if (row.aiChatterValidUntil && new Date(row.aiChatterValidUntil) > now) aiChatterCents += Number(row.aiChatterPriceCents || 0);
          if (row.outreachValidUntil && new Date(row.outreachValidUntil) > now) outreachCents += Number(row.outreachPriceCents || 0);
        }
        return { coreCents, aiChatterCents, outreachCents };
      })(),
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
  const recurringScheduler = getRecurringSchedulerHealthSnapshot();
  const result = {
    ok: recurringScheduler.status !== "DEGRADED",
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
    recurringScheduler,
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
// SYSTEM RETENTION SETTINGS
// SUPER_ADMIN only for writes because these settings delete data.
// ════════════════════════════════════════════════════════════

router.get("/system/retention", async (_req, res) => {
  try {
    const result = await getRetentionSettings();
    return res.json(result);
  } catch (err) {
    console.error("[admin/system/retention] failed:", err);
    return res.status(500).json({ ok: false, code: "RETENTION_SETTINGS_FAILED", error: err?.message || "Failed" });
  }
});

router.patch("/system/retention", async (req, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  try {
    const settings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : req.body || {};
    const result = await updateRetentionSettings({ settings, adminId: req.admin.id });
    await adminLog(req, {
      action: "RETENTION_SETTINGS_UPDATE",
      targetType: "system",
      targetId: "retention.policy.v1",
      meta: { settings: result.settings },
    });
    return res.json(result);
  } catch (err) {
    console.error("[admin/system/retention PATCH] failed:", err);
    return res.status(500).json({ ok: false, code: "RETENTION_SETTINGS_SAVE_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/system/retention/reset", async (req, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  try {
    const result = await resetRetentionSettings({ adminId: req.admin.id });
    await adminLog(req, {
      action: "RETENTION_SETTINGS_RESET",
      targetType: "system",
      targetId: "retention.policy.v1",
      meta: { source: result.source, settings: result.settings },
    });
    return res.json(result);
  } catch (err) {
    console.error("[admin/system/retention reset] failed:", err);
    return res.status(500).json({ ok: false, code: "RETENTION_SETTINGS_RESET_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/system/retention/run", async (req, res) => {
  if (!ensureSuperAdmin(req, res)) return;
  try {
    const result = await runRetentionSweep({});
    await adminLog(req, {
      action: "RETENTION_SWEEP_RUN",
      targetType: "system",
      targetId: "retention.policy.v1",
      meta: { totalDeleted: result.totalDeleted || 0, elapsedMs: result.elapsedMs || 0 },
    });
    return res.json(result);
  } catch (err) {
    console.error("[admin/system/retention run] failed:", err);
    return res.status(500).json({ ok: false, code: "RETENTION_SWEEP_FAILED", error: err?.message || "Failed" });
  }
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
        creators:       { include: { billingProfile: true, billingEntitlement: true, sessionState: { select: { status: true, portableReady: true, revision: true, updatedAt: true } } } },
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
            activeCanonicalSessions: a.creators.filter((c) => !c.deletedAt && c.sessionState?.status === "ACTIVE" && c.sessionState?.portableReady === true).length,
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
        include: { billingProfile: true, billingEntitlement: true, sessionState: { select: { status: true, portableReady: true, revision: true, updatedAt: true } } },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      },
      subscriptions:   { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5 },
      adminActionLogs: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });

  if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
  // This read intentionally works for soft-deleted agencies. Historical
  // installations could retire an Agency before the parent lifecycle fence
  // existed, leaving durable Custom / Telegram work behind. Surface that
  // debt to super-admins so the canonical recovery path is explicit:
  // restore -> converge/resolve work -> retire again.
  const customPipelineBlockers = await agencyCustomPipelineBlockers({ db: prisma, agencyId: agency.id });
  return res.json({ ok: true, agency, health: health(agency), customPipelineBlockers, creatorTiers: TIERS });
});

// PATCH /agencies/:id   — rename / change status notes
const agencyPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/agencies/:id", operationHandler("agency.update"));

// DELETE /agencies/:id   — soft delete (default), or hard with ?hard=1 (super-admin only)
router.delete("/agencies/:id", operationHandler("agency.retire"));

// POST /agencies/:id/restore   — undo soft delete
router.post("/agencies/:id/restore", operationHandler("agency.restore"));

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

// PATCH /agencies/:id/subscription — policy only; paid dates are domain-owned.
router.patch("/agencies/:id/subscription", setBillingPolicyHandler);
router.patch("/agencies/:id/billing-hold", setBillingHoldHandler);

// ════════════════════════════════════════════════════════════
// MEMBERS
// ════════════════════════════════════════════════════════════

router.get("/agencies/:id/members", async (req, res) => {
  try {
    const members = await prisma.agencyMember.findMany({
      where: { agencyId: req.params.id },
      include: { user: true },
      orderBy: { createdAt: "asc" },
      take: 10000});
    return res.json({ ok: true, members });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "MEMBERS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

const memberRoleSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MANAGER", "OPERATOR"]),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/members/:memberId/role", operationHandler("member.role.set", "memberId"));

const memberPermsSchema = z.object({
  permissions: z.record(z.any()),
  reason: z.string().max(500).optional().nullable(),
});

router.patch("/members/:memberId/permissions", operationHandler("member.permissions.set", "memberId"));

router.delete("/members/:memberId", operationHandler("member.remove", "memberId"));


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
        _count: { select: { memberships: true } },
      },
    });

    if (noAgency) {
      users = users.filter((u) => u._count.memberships === 0);
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
        agenciesCount: u._count.memberships,
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
        memberships: { include: { agency: true } },
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
        updatedAt: user.updatedAt,
      },
      memberships: user.memberships.map((m) => ({
        id: m.id,
        agency: { id: m.agency.id, name: m.agency.name, status: m.agency.status, deletedAt: m.agency.deletedAt },
        role: m.role,
        permissions: m.permissions,
        createdAt: m.createdAt,
      })),
      sessions: sessions.map(({id,agencyId,deviceId,createdAt,expiresAt,revokedAt}) => ({id,agencyId,deviceId,createdAt,expiresAt,revokedAt})),
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

router.patch("/users/:id", operationHandler("user.update"));

router.post("/users/:id/force-logout", operationHandler("user.logout"));

router.post("/users/:id/reset-password", operationHandler("user.password.reset"));


// ════════════════════════════════════════════════════════════
// CREATORS — cross-agency listing + per-creator ops
// ════════════════════════════════════════════════════════════

router.get("/creators", async (req, res) => {
  try {
    const q        = String(req.query.q || "").trim();
    const status   = String(req.query.status || "").trim().toUpperCase();
    const tier     = String(req.query.tier || "").trim().toUpperCase();
    const agencyId = String(req.query.agencyId || "").trim();
    const noCanonical = req.query.no_canonical === "1";

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
        sessionState: {
          select: { status: true, portableReady: true, revision: true, updatedAt: true },
        },
      },
    });

    if (tier)   creators = creators.filter((c) => c.billingProfile?.tier === tier);
    if (noCanonical) creators = creators.filter((c) => !(c.sessionState?.status === "ACTIVE" && c.sessionState?.portableReady === true));

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
        createdAt: c.createdAt,
        billingTier: c.billingProfile?.tier || null,
        billingExcluded: !!c.billingProfile?.billingExcluded,
        revenue30dCents: Number(c.billingProfile?.revenue30dCents || 0),
        hasPortableCanonicalSession: c.sessionState?.status === "ACTIVE" && c.sessionState?.portableReady === true,
        canonicalRevision: c.sessionState?.revision ?? null,
      })),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "CREATORS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

// PATCH /creators/:id/status   (v1 compatibility surface)
//
// CreatorAccount.status is no longer an admin-controlled toggle. READY is
// committed only by the verified enrollment/connection authority; DISABLED is
// committed by the full creator-removal workflow. Allowing this legacy route
// to write either direction would bypass identity proof, connection generation,
// Custom-pipeline retirement blockers, crypto/session retirement and access
// revocation. Keep the endpoint for old admin clients, but make it read-only
// except for an idempotent request for the already-current value.
router.patch("/creators/:id/status", async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["DRAFT", "READY", "NOT_CREATOR", "AUTH_FAILED", "DISABLED"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status" });
  }

  const before = await prisma.creatorAccount.findUnique({ where: { id: req.params.id }, include: { billingProfile: true } });
  if (!before) return res.status(404).json({ ok: false, error: "Creator not found" });
  if (String(before.status) === status) {
    return res.json({ ok: true, creator: before, unchanged: true });
  }

  const requestedAction = status === "READY"
    ? "Complete or reconnect the creator through the verified Creator Enrollment / Connection workflow."
    : status === "DISABLED"
      ? "Use the creator removal workflow so active Customs, external writes, session/crypto material and access are adjudicated atomically."
      : "Use the canonical creator lifecycle workflow instead of directly editing CreatorAccount.status.";

  return res.status(409).json({
    ok: false,
    code: "CREATOR_STATUS_MANAGED_BY_LIFECYCLE_AUTHORITY",
    error: "Creator status is managed by lifecycle authority and cannot be changed directly from the legacy admin endpoint.",
    currentStatus: before.status,
    requestedStatus: status,
    requestedAction,
  });
});

// PATCH /creators/:id/billing — compatibility URL, same authority as admin-billing.
router.patch("/creators/:id/billing", setPricingHandler);

// PATCH /creators/:id/entitlement — explicit component-scoped grant/revoke.
router.patch("/creators/:id/entitlement", setEntitlementHandler);

// DELETE /creators/:id   (v1, kept; now soft-delete by default)
router.delete("/creators/:id", operationHandler("creator.retire"));


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

router.post("/devices/:id/kick", operationHandler("device.kick"));


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
        id: true, email: true, name: true, role: true, active: true, accessEpoch: true,
        lastLoginAt: true, createdAt: true,
      },
      take: 10000});
    return res.json({ ok: true, admins });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "ADMIN_USERS_LIST_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/admin-users", createAdminHandler);
router.patch("/admin-users/:id", patchAdminHandler);
router.post("/admin-users/:id/reset-password", resetAdminPasswordHandler);

// ════════════════════════════════════════════════════════════
// Phase 3 Subscriber maintenance break-glass
// ════════════════════════════════════════════════════════════

router.get("/maintenance/subscriber-signals", async (req, res) => {
  try {
    if (!ensureSuperAdmin(req, res)) return;
    const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
    const signals = await listPoisonedSubscriberMaintenanceSignals({ db: prisma, limit });
    return res.json({
      ok: true,
      poisonThreshold: 100,
      count: signals.length,
      signals: signals.map((row) => ({
        id: row.id,
        agencyId: row.agencyId,
        creatorId: row.creatorId,
        kind: row.kind,
        dueAt: row.dueAt,
        attempts: row.attempts,
        revision: row.revision,
        claimUntil: row.claimUntil,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: err?.code || "SUBSCRIBER_MAINTENANCE_LIST_FAILED",
      error: String(err?.message || err || "Failed").slice(0, 1000),
    });
  }
});

router.post("/maintenance/subscriber-signals/:id/requeue", operationHandler("maintenance.subscriber.requeue"));

module.exports = router;
