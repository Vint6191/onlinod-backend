
const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { adminRequired } = require("../middleware/admin");

const router = express.Router();
router.use(adminRequired);

const TIERS = {
  STARTER: { label: "Starter", priceCents: 2000, revenueLabel: "$0–$1k" },
  GROWTH: { label: "Growth", priceCents: 3000, revenueLabel: "$1k–$5k" },
  PRO: { label: "Pro", priceCents: 5000, revenueLabel: "$5k–$15k" },
  ELITE: { label: "Elite", priceCents: 15000, revenueLabel: "$15k+" },
  CUSTOM: { label: "Custom", priceCents: 0, revenueLabel: "manual" },
};

const subSchema = z.object({
  plan: z.string().max(80).optional(),
  status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "CANCELLED", "LOCKED"]).optional(),
  corePricePerCreatorCents: z.number().int().min(0).optional(),
  currentPeriodEnd: z.string().datetime().optional().nullable(),
  trialEndsAt: z.string().datetime().optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

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

async function adminLog(req, data) {
  try {
    await prisma.adminActionLog.create({ data: { adminUserId: req.admin.id, ...data } });
  } catch (err) {
    console.warn("[adminLog] failed:", err?.message || err);
  }
}

function health(agency) {
  const creators = agency.creators || [];
  const snaps = agency.accessSnapshots || [];
  const active = new Set(snaps.filter((s) => s.active && !s.revokedAt).map((s) => s.creatorId));
  const issues = [];
  let score = 100;

  for (const c of creators) {
    if (c.status === "READY" && !active.has(c.id)) {
      score -= 18;
      issues.push({ severity: "ERROR", targetType: "creator", targetId: c.id, message: `${c.displayName} is READY but has no active snapshot` });
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
  return { score, level: score >= 80 ? "healthy" : score >= 55 ? "warning" : "critical", issues };
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

router.get("/plans", async (_req, res) => {
  return res.json({
    ok: true,
    creatorTiers: TIERS,
    addons: {
      AI_CHATTER: { label: "AI Chatter", priceCents: 10000, scope: "creator/month" },
      OUTREACH: { label: "SFS + Comment Bot", priceCents: 2900, scope: "creator/month" },
    },
  });
});

router.get("/agencies", async (_req, res) => {
  const agencies = await prisma.agency.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      members: { include: { user: true }, orderBy: { createdAt: "asc" } },
      creators: { include: { billingProfile: true, accessSnapshots: { orderBy: { createdAt: "desc" }, take: 5 } } },
      accessSnapshots: { select: { id: true, active: true, revokedAt: true, creatorId: true, createdAt: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return res.json({ ok: true, agencies: agencies.map((a) => {
    const owner = a.members.find((m) => m.role === "OWNER") || a.members[0] || null;
    return {
      id: a.id, name: a.name, plan: a.plan, status: a.status || "TRIAL", createdAt: a.createdAt, updatedAt: a.updatedAt,
      owner: owner?.user ? { id: owner.user.id, email: owner.user.email, name: owner.user.name } : null,
      counts: { members: a.members.length, creators: a.creators.length, readyCreators: a.creators.filter((c) => c.status === "READY").length, activeSnapshots: a.accessSnapshots.filter((s) => s.active && !s.revokedAt).length },
      subscription: a.subscriptions[0] || null,
      health: health(a),
    };
  }) });
});

router.get("/agencies/:id", async (req, res) => {
  const agency = await prisma.agency.findUnique({
    where: { id: req.params.id },
    include: {
      members: { include: { user: true }, orderBy: { createdAt: "asc" } },
      creators: { include: { billingProfile: true, accessSnapshots: { orderBy: { createdAt: "desc" }, take: 10 } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] },
      accessSnapshots: { orderBy: { createdAt: "desc" }, take: 150 },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 5 },
      adminActionLogs: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });

  if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
  return res.json({ ok: true, agency, health: health(agency), creatorTiers: TIERS });
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

    const sub = beforeSub ? await prisma.agencySubscription.update({ where: { id: beforeSub.id }, data: subData }) : await prisma.agencySubscription.create({ data: { agencyId: agency.id, ...subData } });

    await adminLog(req, { agencyId: agency.id, action: "admin.subscription_changed", targetType: "agency", targetId: agency.id, before: { agency, subscription: beforeSub }, after: { agency: updated, subscription: sub }, reason: input.reason });
    return res.json({ ok: true, agency: updated, subscription: sub });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error" });
    return res.status(500).json({ ok: false, code: "ADMIN_SUBSCRIPTION_FAILED", error: err?.message || "Failed" });
  }
});

router.patch("/creators/:id/status", async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["DRAFT", "READY", "NOT_CREATOR", "AUTH_FAILED", "DISABLED"].includes(status)) return res.status(400).json({ ok: false, error: "Invalid status" });

  const before = await prisma.creatorAccount.findUnique({ where: { id: req.params.id }, include: { billingProfile: true } });
  if (!before) return res.status(404).json({ ok: false, error: "Creator not found" });

  const creator = await prisma.creatorAccount.update({ where: { id: before.id }, data: { status } });
  await adminLog(req, { agencyId: before.agencyId, action: "admin.creator_status_changed", targetType: "creator", targetId: before.id, before, after: creator, reason: req.body?.reason || null });
  return res.json({ ok: true, creator });
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

    const billing = before ? await prisma.creatorBillingProfile.update({ where: { creatorId: creator.id }, data }) : await prisma.creatorBillingProfile.create({ data: { creatorId: creator.id, ...data } });
    await adminLog(req, { agencyId: creator.agencyId, action: "admin.creator_billing_changed", targetType: "creator", targetId: creator.id, before, after: billing, reason: input.reason || "manual creator billing update" });
    return res.json({ ok: true, billing });
  } catch (err) {
    if (err?.issues) return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error" });
    return res.status(500).json({ ok: false, code: "ADMIN_CREATOR_BILLING_FAILED", error: err?.message || "Failed to update creator billing" });
  }
});

router.delete("/creators/:id", async (req, res) => {
  const before = await prisma.creatorAccount.findUnique({ where: { id: req.params.id }, include: { billingProfile: true, accessSnapshots: true } });
  if (!before) return res.status(404).json({ ok: false, error: "Creator not found" });

  await prisma.creatorAccount.delete({ where: { id: before.id } });
  await adminLog(req, { agencyId: before.agencyId, action: "admin.creator_deleted", targetType: "creator", targetId: before.id, before, after: null, reason: String(req.query.reason || "admin cleanup") });
  return res.json({ ok: true, deleted: before });
});

router.get("/live-feed", async (req, res) => {
  const agencyId = String(req.query.agencyId || "").trim() || undefined;
  const logs = await prisma.adminActionLog.findMany({ where: agencyId ? { agencyId } : undefined, orderBy: { createdAt: "desc" }, take: 100 });
  return res.json({ ok: true, events: logs.map((x) => ({ id: x.id, source: "admin", action: x.action, agencyId: x.agencyId, actorUserId: x.adminUserId, targetType: x.targetType, targetId: x.targetId, metadata: { before: x.before, after: x.after, reason: x.reason }, createdAt: x.createdAt })) });
});

module.exports = router;
