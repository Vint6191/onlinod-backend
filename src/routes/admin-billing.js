const { setPricingHandler, bulkPricingHandler, cancelBulkPricingHandler, commercialPolicyHandler } = require("./admin-command-handlers");
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
     POST /agency/:id/apply-tier — bulk: explicit manifest, maximum 100 models; durable 202 receipt
     GET  /tiers               — tier catalog + addon prices
   ──────────────────────────────────────────────────────────── */

"use strict";

const express = require("express");
const prisma = require("../prisma");
const { adminRequired } = require("../middleware/admin");
const { adminHttpAuditMiddleware } = require("../middleware/admin-audit");
const { dbAuthorityNow } = require("../services/db-time-authority-service");
const { effectiveBillingState, liveEntitlementEnd, activeCore, scopedEntitlement } = require("../services/billing-state-service");
const { publicEntitlement } = require("../services/billing-entitlement-service");

const router = require("./admin-router").createAdminRouter();
router.use(adminRequired);
router.use(require("../middleware/admin-read-boundary").adminReadBoundary);
router.use(adminHttpAuditMiddleware);

// All admin pricing readers and writers use the canonical domain catalog.
const { catalogForPolicy, configuredPrices } = require("../services/billing-catalog-service");
const { readCommercialPolicy } = require("../services/billing-commercial-policy-service");

// Agency statuses that count as paying / billable.
const BILLABLE_STATUSES = new Set(["ACTIVE"]);

function sendErr(res, err, code = "ADMIN_BILLING_FAILED") {
  const status = Number(err?.status || 500) || 500;
  return res.status(status).json({ ok: false, code: err?.code || code, error: String(err?.message || "Failed") });
}

// Line total for a single model's billing profile.
function configuredLineCents(profile, policy) {
  if (profile?.billingExcluded) return 0;
  const bp = { ...profile, ...configuredPrices(profile, policy) };
  let c = Number(bp.corePriceCents || 0);
  if (bp.aiChatterEnabled) c += Number(bp.aiChatterPriceCents || 0);
  if (bp.outreachEnabled) c += Number(bp.outreachPriceCents || 0);
  return c;
}

function activePaidLineCents(entitlement, now = new Date()) {
  if (!entitlement) return 0;
  let cents = 0;
  if (activeCore(entitlement, now)) cents += Number(entitlement.corePriceCents || 0);
  if (entitlement.aiChatterValidUntil && new Date(entitlement.aiChatterValidUntil) > now) cents += Number(entitlement.aiChatterPriceCents || 0);
  if (entitlement.outreachValidUntil && new Date(entitlement.outreachValidUntil) > now) cents += Number(entitlement.outreachPriceCents || 0);
  return cents;
}

router.get("/commercial-policy", async (_req, res) => res.json(await readCommercialPolicy({ db: prisma })));
router.patch("/commercial-policy", commercialPolicyHandler);
router.get("/tiers", async (_req, res) => {
  const policy = await readCommercialPolicy({ db: prisma });
  const { tiers, addons } = catalogForPolicy(policy);
  return res.json({ ok: true, tiers, addons: { aiChatterPriceCents: addons.aiChatter.priceCents, outreachPriceCents: addons.outreach.priceCents }, commercialPolicyRevision: policy.revision });
});

// ════════════════════════════════════════════════════════════════
// GLOBAL OVERVIEW — real MRR with proper status filtering + rollup
// ════════════════════════════════════════════════════════════════
router.get("/overview", async (req, res) => {
  try {
    const policy = await readCommercialPolicy({ db: prisma });
    const now = await dbAuthorityNow({ db: prisma });
    // Pull every non-deleted agency with its latest subscription + creators' billing.
    const agencies = await prisma.agency.findMany({
      where: { deletedAt: null },
      include: {
        subscriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
        creators: {
          where: { deletedAt: null },
          include: { billingProfile: true, billingEntitlement: true },
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
      const activeUntil = liveEntitlementEnd(a.creators, a.id, now);
      const { status } = effectiveBillingState({ agency: a, subscription: sub, activeUntil, now });
      const billable = BILLABLE_STATUSES.has(status) && sub?.billingMode !== "FREE_INTERNAL";

      let agencyCents = 0;
      let modelsCounted = 0;
      const addons = { aiChatter: 0, outreach: 0 };

      for (const c of a.creators) {
        const bp = c.billingProfile;
        const ent = scopedEntitlement(c, a.id);
        const line = activePaidLineCents(ent, now);
        if (line > 0) {
          agencyCents += line;
          modelsCounted += 1;
          if (ent?.aiChatterValidUntil && new Date(ent.aiChatterValidUntil) > now) addons.aiChatter += Number(ent.aiChatterPriceCents || 0);
          if (ent?.outreachValidUntil && new Date(ent.outreachValidUntil) > now) addons.outreach += Number(ent.outreachPriceCents || 0);
        }
      }

      if (billable) { mrrCents += agencyCents; billedModels += modelsCounted; }
      else if (status === "TRIAL") {
        trialMrrCents += a.creators.reduce((sum, creator) => sum + configuredLineCents(creator.billingProfile, policy), 0);
      }

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
        currentPeriodEnd: activeUntil,
        trialEndsAt: a.trialEndsAt || null,
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
        subscriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
        creators: { where: { deletedAt: null }, include: { billingProfile: true, billingEntitlement: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!agency) return res.status(404).json({ ok: false, code: "AGENCY_NOT_FOUND" });

    const policy = await readCommercialPolicy({ db: prisma });
    const sub = agency.subscriptions[0] || null;
    const now = await dbAuthorityNow({ db: prisma });
    const activeUntil = liveEntitlementEnd(agency.creators, agency.id, now);
    const { status, billingMode } = effectiveBillingState({ agency, subscription: sub, activeUntil, now });

    const models = agency.creators.map((c) => {
      const bp = c.billingProfile;
      const ent = scopedEntitlement(c, agency.id);
      return {
        creatorId: c.id,
        displayName: c.displayName,
        username: c.username,
        creatorStatus: c.status,
        tier: bp?.tier || null,
        tierMode: bp?.tierMode || "AUTO",
        ...configuredPrices(bp, policy),
        aiChatterEnabled: !!bp?.aiChatterEnabled,
        outreachEnabled: !!bp?.outreachEnabled,
        billingExcluded: !!bp?.billingExcluded,
        hasProfile: !!bp,
        pricingRevision: bp?.pricingRevision || 0,
        configuredLineCents: configuredLineCents(bp, policy),
        activeLineCents: activePaidLineCents(ent, now),
        entitlement: publicEntitlement(ent, now),
      };
    });

    const monthlyCents = models.reduce((s, m) => s + m.activeLineCents, 0);

    return res.json({
      ok: true,
      agency: { id: agency.id, name: agency.name, plan: agency.plan, status, currentPeriodEnd: activeUntil, trialEndsAt: agency.trialEndsAt },
      subscription: sub ? { ...sub, status, currentPeriodEnd: activeUntil, trialEndsAt: agency.trialEndsAt, graceUntil: null } : null,
      billable: BILLABLE_STATUSES.has(status) && billingMode !== "FREE_INTERNAL",
      models,
      monthlyCents,
      tiers: catalogForPolicy(policy).tiers,
      commercialPolicyRevision: policy.revision,
    });
  } catch (err) { return sendErr(res, err); }
});

// ════════════════════════════════════════════════════════════════
// PATCH a single model's billing (create profile if missing)
// ════════════════════════════════════════════════════════════════
router.patch("/creator/:id", setPricingHandler);

// ════════════════════════════════════════════════════════════════
// BULK — immutable bounded selection, existing DomainWorkItem execution
// ════════════════════════════════════════════════════════════════
router.post("/agency/:id/apply-tier", bulkPricingHandler);
router.post("/agency/:id/apply-tier/cancel", cancelBulkPricingHandler);

module.exports = router;
