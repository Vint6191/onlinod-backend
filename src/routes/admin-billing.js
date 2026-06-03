/* src/routes/admin-billing.js — Onlinod billing management
   ────────────────────────────────────────────────────────────
   Proper money view: subscription is on the AGENCY, but priced
   PER CONNECTED MODEL via CreatorBillingProfile. This surface gives
   the real MRR (filtered by agency status), a per-agency breakdown
   with each model's price, and bulk/per-model billing operations.

   Mounted at /api/admin/billing (adminRequired).

     GET  /overview            — global MRR + per-agency rollup (real, status-filtered)
     GET  /agency/:id          — one agency: subscription + every model with line price
     PATCH /creator/:id        — set a model's tier/price/addons/excluded (reuses fields)
     POST /agency/:id/apply-tier — bulk: set tier for ALL models of an agency
     GET  /tiers               — tier catalog + addon prices
   ──────────────────────────────────────────────────────────── */

"use strict";

const express = require("express");
const prisma = require("../prisma");
const { adminRequired } = require("../middleware/admin");

const router = express.Router();
router.use(adminRequired);

// Tier catalog — keep in sync with admin.js TIERS.
const TIERS = {
  STARTER: { label: "Starter", priceCents: 2000, revenueLabel: "$0–$1k" },
  GROWTH:  { label: "Growth",  priceCents: 3000, revenueLabel: "$1k–$5k" },
  PRO:     { label: "Pro",     priceCents: 5000, revenueLabel: "$5k–$15k" },
  ELITE:   { label: "Elite",   priceCents: 15000, revenueLabel: "$15k+" },
  CUSTOM:  { label: "Custom",  priceCents: 0,    revenueLabel: "manual" },
};
const ADDON_DEFAULTS = { aiChatterPriceCents: 10000, outreachPriceCents: 2900 };

// Agency statuses that count as paying / billable.
const BILLABLE_STATUSES = new Set(["ACTIVE", "PAST_DUE", "GRACE"]);

async function adminLog(req, data) {
  try { await prisma.adminActionLog.create({ data: { adminUserId: req.admin.id, ...data } }); }
  catch (err) { console.warn("[adminBilling.log]", err?.message || err); }
}
function sendErr(res, err, code = "ADMIN_BILLING_FAILED") {
  const status = Number(err?.status || 500) || 500;
  return res.status(status).json({ ok: false, code: err?.code || code, error: String(err?.message || "Failed") });
}

// Line total for a single model's billing profile.
function lineCents(bp) {
  if (!bp || bp.billingExcluded) return 0;
  let c = Number(bp.corePriceCents || 0);
  if (bp.aiChatterEnabled) c += Number(bp.aiChatterPriceCents || 0);
  if (bp.outreachEnabled) c += Number(bp.outreachPriceCents || 0);
  return c;
}

router.get("/tiers", (_req, res) => res.json({ ok: true, tiers: TIERS, addons: ADDON_DEFAULTS }));

// ════════════════════════════════════════════════════════════════
// GLOBAL OVERVIEW — real MRR with proper status filtering + rollup
// ════════════════════════════════════════════════════════════════
router.get("/overview", async (req, res) => {
  try {
    // Pull every non-deleted agency with its latest subscription + creators' billing.
    const agencies = await prisma.agency.findMany({
      where: { deletedAt: null },
      include: {
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
        creators: {
          where: { deletedAt: null },
          include: { billingProfile: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    let mrrCents = 0;
    let billedModels = 0;
    let trialMrrCents = 0; // potential MRR sitting in trial (not yet billed)
    const rows = [];

    for (const a of agencies) {
      const sub = a.subscriptions[0] || null;
      const status = a.status || sub?.status || "TRIAL";
      const billable = BILLABLE_STATUSES.has(status);

      let agencyCents = 0;
      let modelsCounted = 0;
      const addons = { aiChatter: 0, outreach: 0 };

      for (const c of a.creators) {
        const bp = c.billingProfile;
        const line = lineCents(bp);
        if (line > 0) {
          agencyCents += line;
          modelsCounted += 1;
          if (bp.aiChatterEnabled) addons.aiChatter += Number(bp.aiChatterPriceCents || 0);
          if (bp.outreachEnabled) addons.outreach += Number(bp.outreachPriceCents || 0);
        }
      }

      if (billable) { mrrCents += agencyCents; billedModels += modelsCounted; }
      else if (status === "TRIAL") { trialMrrCents += agencyCents; }

      rows.push({
        agencyId: a.id,
        name: a.name,
        plan: a.plan,
        status,
        billable,
        modelsTotal: a.creators.length,
        modelsBilled: modelsCounted,
        monthlyCents: agencyCents,
        addons,
        currentPeriodEnd: a.currentPeriodEnd || sub?.currentPeriodEnd || null,
        trialEndsAt: a.trialEndsAt || sub?.trialEndsAt || null,
      });
    }

    rows.sort((x, y) => y.monthlyCents - x.monthlyCents);

    return res.json({
      ok: true,
      mrr: {
        billedCents: mrrCents,
        trialPotentialCents: trialMrrCents,
        billedModels,
        billableAgencies: rows.filter((r) => r.billable).length,
        totalAgencies: rows.length,
      },
      agencies: rows,
    });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// AGENCY DETAIL — subscription + every model with its line price
// ════════════════════════════════════════════════════════════════
router.get("/agency/:id", async (req, res) => {
  try {
    const agency = await prisma.agency.findUnique({
      where: { id: req.params.id },
      include: {
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
        creators: { where: { deletedAt: null }, include: { billingProfile: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND" });

    const sub = agency.subscriptions[0] || null;
    const status = agency.status || sub?.status || "TRIAL";

    const models = agency.creators.map((c) => {
      const bp = c.billingProfile;
      return {
        creatorId: c.id,
        displayName: c.displayName,
        username: c.username,
        creatorStatus: c.status,
        tier: bp?.tier || null,
        tierMode: bp?.tierMode || "MANUAL",
        corePriceCents: bp ? Number(bp.corePriceCents || 0) : null,
        aiChatterEnabled: !!bp?.aiChatterEnabled,
        aiChatterPriceCents: Number(bp?.aiChatterPriceCents || ADDON_DEFAULTS.aiChatterPriceCents),
        outreachEnabled: !!bp?.outreachEnabled,
        outreachPriceCents: Number(bp?.outreachPriceCents || ADDON_DEFAULTS.outreachPriceCents),
        billingExcluded: !!bp?.billingExcluded,
        hasProfile: !!bp,
        lineCents: lineCents(bp),
      };
    });

    const monthlyCents = models.reduce((s, m) => s + m.lineCents, 0);

    return res.json({
      ok: true,
      agency: { id: agency.id, name: agency.name, plan: agency.plan, status, currentPeriodEnd: agency.currentPeriodEnd, trialEndsAt: agency.trialEndsAt },
      subscription: sub,
      billable: BILLABLE_STATUSES.has(status),
      models,
      monthlyCents,
      tiers: TIERS,
    });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// PATCH a single model's billing (create profile if missing)
// ════════════════════════════════════════════════════════════════
router.patch("/creator/:id", async (req, res) => {
  try {
    const creator = await prisma.creatorAccount.findUnique({ where: { id: req.params.id }, include: { billingProfile: true } });
    if (!creator) return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND" });

    const b = req.body || {};
    const before = creator.billingProfile || null;

    // If a tier is provided and price not explicitly set, take the tier's price.
    let corePriceCents = before?.corePriceCents ?? TIERS.STARTER.priceCents;
    if (b.tier && TIERS[b.tier] && b.corePriceCents == null && b.tier !== "CUSTOM") corePriceCents = TIERS[b.tier].priceCents;
    if (b.corePriceCents != null) corePriceCents = Math.max(0, Math.min(1_000_000, Number(b.corePriceCents) || 0));

    const data = {
      tier: b.tier && TIERS[b.tier] ? b.tier : (before?.tier || "STARTER"),
      tierMode: b.tierMode || before?.tierMode || "MANUAL",
      corePriceCents,
      aiChatterEnabled: b.aiChatterEnabled != null ? !!b.aiChatterEnabled : (before?.aiChatterEnabled ?? false),
      aiChatterPriceCents: b.aiChatterPriceCents != null ? Math.max(0, Number(b.aiChatterPriceCents) || 0) : (before?.aiChatterPriceCents ?? ADDON_DEFAULTS.aiChatterPriceCents),
      outreachEnabled: b.outreachEnabled != null ? !!b.outreachEnabled : (before?.outreachEnabled ?? false),
      outreachPriceCents: b.outreachPriceCents != null ? Math.max(0, Number(b.outreachPriceCents) || 0) : (before?.outreachPriceCents ?? ADDON_DEFAULTS.outreachPriceCents),
      billingExcluded: b.billingExcluded != null ? !!b.billingExcluded : (before?.billingExcluded ?? false),
      notes: b.notes !== undefined ? b.notes : (before?.notes ?? null),
    };

    const billing = before
      ? await prisma.creatorBillingProfile.update({ where: { creatorId: creator.id }, data })
      : await prisma.creatorBillingProfile.create({ data: { agencyId: creator.agencyId, creatorId: creator.id, ...data } });

    await adminLog(req, {
      agencyId: creator.agencyId, action: "billing.creator_changed",
      targetType: "creator", targetId: creator.id, before, after: billing, reason: b.reason || "billing update",
    });

    return res.json({ ok: true, billing, lineCents: lineCents(billing) });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// BULK — apply a tier to ALL models of an agency at once
// ════════════════════════════════════════════════════════════════
router.post("/agency/:id/apply-tier", async (req, res) => {
  try {
    const tier = String(req.body?.tier || "");
    if (!TIERS[tier]) return res.status(400).json({ ok: false, code: "BAD_TIER" });
    const includeExcluded = req.body?.includeExcluded === true;

    const agency = await prisma.agency.findUnique({ where: { id: req.params.id }, include: { creators: { where: { deletedAt: null }, include: { billingProfile: true } } } });
    if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND" });

    const price = TIERS[tier].priceCents;
    let updated = 0;
    for (const c of agency.creators) {
      if (!includeExcluded && c.billingProfile?.billingExcluded) continue;
      const data = { tier, corePriceCents: price, tierMode: "MANUAL" };
      if (c.billingProfile) await prisma.creatorBillingProfile.update({ where: { creatorId: c.id }, data });
      else await prisma.creatorBillingProfile.create({ data: { agencyId: agency.id, creatorId: c.id, ...data } });
      updated += 1;
    }

    await adminLog(req, { agencyId: agency.id, action: "billing.bulk_tier", targetType: "agency", targetId: agency.id, after: { tier, price, updated } });
    return res.json({ ok: true, updated, tier, priceCents: price });
  } catch (err) { return sendErr(res, err); }
});

module.exports = router;
