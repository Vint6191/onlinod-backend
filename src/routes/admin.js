const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { adminRequired } = require("../middleware/admin");

const router = express.Router();
router.use(adminRequired);

const subSchema = z.object({
  plan: z.string().max(80).optional(),
  status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "CANCELLED", "LOCKED"]).optional(),
  corePricePerCreatorCents: z.number().int().min(0).optional(),
  currentPeriodEnd: z.string().datetime().optional().nullable(),
  trialEndsAt: z.string().datetime().optional().nullable(),
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
  const active = new Set(snaps.filter(s => s.active && !s.revokedAt).map(s => s.creatorId));
  const issues = [];
  let score = 100;
  for (const c of creators) {
    if (c.status === "READY" && !active.has(c.id)) { score -= 18; issues.push({ severity: "ERROR", message: `${c.displayName} is READY but has no active snapshot` }); }
    if (c.status === "NOT_CREATOR") { score -= 6; issues.push({ severity: "WARNING", message: `${c.displayName} is NOT_CREATOR` }); }
  }
  if (agency.status === "LOCKED" || agency.status === "PAST_DUE") { score -= 25; issues.push({ severity: "ERROR", message: `Agency status is ${agency.status}` }); }
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 80 ? "healthy" : score >= 55 ? "warning" : "critical", issues };
}

router.get("/agencies", async (_req, res) => {
  const agencies = await prisma.agency.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      members: { include: { user: true }, orderBy: { createdAt: "asc" } },
      creators: true,
      accessSnapshots: { select: { id: true, active: true, revokedAt: true, creatorId: true, createdAt: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return res.json({ ok: true, agencies: agencies.map(a => {
    const owner = a.members.find(m => m.role === "OWNER") || a.members[0] || null;
    return {
      id: a.id, name: a.name, plan: a.plan, status: a.status || "TRIAL",
      createdAt: a.createdAt, updatedAt: a.updatedAt,
      owner: owner?.user ? { id: owner.user.id, email: owner.user.email, name: owner.user.name } : null,
      counts: { members: a.members.length, creators: a.creators.length, readyCreators: a.creators.filter(c => c.status === "READY").length, activeSnapshots: a.accessSnapshots.filter(s => s.active && !s.revokedAt).length },
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
      creators: { include: { billingProfile: true, accessSnapshots: { orderBy: { createdAt: "desc" }, take: 5 } }, orderBy: { createdAt: "desc" } },
      accessSnapshots: { orderBy: { createdAt: "desc" }, take: 100 },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 5 },
      adminActionLogs: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND", error: "Agency not found" });
  return res.json({ ok: true, agency, health: health(agency) });
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
  if (!["DRAFT","READY","NOT_CREATOR","AUTH_FAILED","DISABLED"].includes(status)) return res.status(400).json({ ok:false, error:"Invalid status" });
  const before = await prisma.creatorAccount.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ ok:false, error:"Creator not found" });
  const creator = await prisma.creatorAccount.update({ where: { id: before.id }, data: { status } });
  await adminLog(req, { agencyId: before.agencyId, action: "admin.creator_status_changed", targetType: "creator", targetId: before.id, before, after: creator, reason: req.body?.reason || null });
  return res.json({ ok:true, creator });
});

router.delete("/creators/:id", async (req, res) => {
  const before = await prisma.creatorAccount.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ ok:false, error:"Creator not found" });
  await prisma.creatorAccount.delete({ where: { id: before.id } });
  await adminLog(req, { agencyId: before.agencyId, action: "admin.creator_deleted", targetType: "creator", targetId: before.id, before, after: null, reason: "admin cleanup" });
  return res.json({ ok:true, deleted: before });
});

router.get("/live-feed", async (req, res) => {
  const agencyId = String(req.query.agencyId || "").trim() || undefined;
  const logs = await prisma.adminActionLog.findMany({ where: agencyId ? { agencyId } : undefined, orderBy: { createdAt: "desc" }, take: 100 });
  return res.json({ ok: true, events: logs.map(x => ({ id:x.id, source:"admin", action:x.action, agencyId:x.agencyId, actorUserId:x.adminUserId, targetType:x.targetType, targetId:x.targetId, metadata:{reason:x.reason}, createdAt:x.createdAt })) });
});

module.exports = router;
