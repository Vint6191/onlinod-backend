"use strict";

const TIER_CATALOG = Object.freeze({
  STARTER: Object.freeze({ key: "STARTER", label: "Starter", revenueLabel: "$0–$1k" }),
  GROWTH: Object.freeze({ key: "GROWTH", label: "Growth", revenueLabel: "$1k–$5k" }),
  PRO: Object.freeze({ key: "PRO", label: "Pro", revenueLabel: "$5k–$15k" }),
  ELITE: Object.freeze({ key: "ELITE", label: "Elite", revenueLabel: "$15k+" }),
  CUSTOM: Object.freeze({ key: "CUSTOM", label: "Custom", revenueLabel: "manual" }),
});

const AUTO_TIER_RULES = Object.freeze([
  Object.freeze({ key: "STARTER", minRevenueCents: 0, maxRevenueCentsExclusive: 100_000 }),
  Object.freeze({ key: "GROWTH", minRevenueCents: 100_000, maxRevenueCentsExclusive: 500_000 }),
  Object.freeze({ key: "PRO", minRevenueCents: 500_000, maxRevenueCentsExclusive: 1_500_000 }),
  Object.freeze({ key: "ELITE", minRevenueCents: 1_500_000, maxRevenueCentsExclusive: null }),
]);

const ADDON_CATALOG = Object.freeze({
  aiChatter: Object.freeze({ key: "AI_CHATTER", label: "AI Chatter" }),
  outreach: Object.freeze({ key: "OUTREACH", label: "SFS + Comment Bot" }),
});

const PERIOD_CATALOG = Object.freeze({
  MONTHLY: Object.freeze({ key: "MONTHLY", label: "1 month", months: 1 }),
  THREE_MONTHS: Object.freeze({ key: "THREE_MONTHS", label: "3 months", months: 3 }),
  SIX_MONTHS: Object.freeze({ key: "SIX_MONTHS", label: "6 months", months: 6 }),
});

function cleanId(value, max = 180) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function badRequest(message, code = "BILLING_SELECTION_INVALID") {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  err.permanent = true;
  return err;
}

function normalizePeriod(value) {
  const key = String(value || "MONTHLY").trim().toUpperCase();
  if (!PERIOD_CATALOG[key]) throw badRequest("Billing period must be 1, 3 or 6 months", "BILLING_PERIOD_INVALID");
  return key;
}

function periodMonths(period) {
  return PERIOD_CATALOG[normalizePeriod(period)].months;
}

function normalizeTier(value) {
  const key = String(value || "STARTER").trim().toUpperCase();
  if (!TIER_CATALOG[key]) throw badRequest("Unknown creator billing tier", "BILLING_TIER_INVALID");
  return key;
}

function normalizeSelection(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const billingPeriod = normalizePeriod(source.billingPeriod || source.period || "MONTHLY");
  const rawCreators = Array.isArray(source.creators) ? source.creators : [];
  if (!rawCreators.length) throw badRequest("Select at least one creator to pay for", "BILLING_CREATORS_REQUIRED");
  if (rawCreators.length > 100) throw badRequest("A checkout can contain at most 100 creators", "BILLING_TOO_MANY_CREATORS");

  const seen = new Set();
  const creators = rawCreators.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw badRequest("Invalid creator checkout line");
    const creatorId = cleanId(row.creatorId);
    if (!creatorId) throw badRequest("Every checkout line needs creatorId", "BILLING_CREATOR_ID_REQUIRED");
    if (seen.has(creatorId)) throw badRequest("The same creator cannot appear twice in one checkout", "BILLING_CREATOR_DUPLICATE");
    seen.add(creatorId);
    return {
      creatorId,
      tier: normalizeTier(row.tier || "STARTER"),
      aiChatterEnabled: row.aiChatterEnabled === true,
      outreachEnabled: row.outreachEnabled === true,
    };
  });

  creators.sort((a, b) => a.creatorId.localeCompare(b.creatorId));
  return { billingPeriod, creators };
}

function automaticTierForRevenue(revenue30dCents) {
  const revenue = Math.max(0, Math.min(2_147_483_647, Math.round(Number(revenue30dCents || 0))));
  const rule = AUTO_TIER_RULES.find((row) => row.maxRevenueCentsExclusive === null || revenue < row.maxRevenueCentsExclusive) || AUTO_TIER_RULES[AUTO_TIER_RULES.length - 1];
  return rule.key;
}

function catalogForPolicy(policy) {
  if (!policy?.settings || !Number.isInteger(policy.revision)) throw Object.assign(new Error("Billing policy is required"), { code: "BILLING_COMMERCIAL_POLICY_REQUIRED", status: 503 });
  const settings = policy.settings;
  const tiers = Object.fromEntries(Object.entries(TIER_CATALOG).map(([key, row]) => [key, { ...row, priceCents: key === "CUSTOM" ? null : settings[key.toLowerCase() + "PriceCents"] }]));
  const addons = { aiChatter: { ...ADDON_CATALOG.aiChatter, priceCents: settings.aiChatterPriceCents }, outreach: { ...ADDON_CATALOG.outreach, priceCents: settings.outreachPriceCents } };
  return { tiers, addons };
}

function configuredPrices(profile, policy, tier = profile?.tier || "STARTER") {
  const { tiers, addons } = catalogForPolicy(policy);
  return {
    corePriceCents: profile?.corePriceOverrideCents ?? tiers[normalizeTier(tier)].priceCents ?? 0,
    aiChatterPriceCents: profile?.aiChatterPriceOverrideCents ?? addons.aiChatter.priceCents,
    outreachPriceCents: profile?.outreachPriceOverrideCents ?? addons.outreach.priceCents,
    corePriceSource: profile?.corePriceOverrideCents != null ? "OVERRIDE" : "CATALOG",
    aiChatterPriceSource: profile?.aiChatterPriceOverrideCents != null ? "OVERRIDE" : "CATALOG",
    outreachPriceSource: profile?.outreachPriceOverrideCents != null ? "OVERRIDE" : "CATALOG",
  };
}

function catalogForClient(policy) {
  const { tiers, addons } = catalogForPolicy(policy);
  return {
    automaticPricing: true,
    commercialPolicyRevision: policy.revision,
    trialDays: policy.settings.trialDays,
    tiers: Object.values(tiers).map((row) => {
      const rule = AUTO_TIER_RULES.find((candidate) => candidate.key === row.key);
      return { ...row, minRevenueCents: rule?.minRevenueCents ?? null, maxRevenueCentsExclusive: rule?.maxRevenueCentsExclusive ?? null, customerSelectable: false };
    }),
    addons: {
      aiChatter: { ...addons.aiChatter },
      outreach: { ...addons.outreach },
    },
    periods: [{ ...PERIOD_CATALOG.MONTHLY }],
  };
}


function priceCreatorSelection({ creator, requested, policy }) {
  if (!creator || !requested) throw badRequest("Creator checkout line is missing");
  const profile = creator.billingProfile || null;
  if (profile?.billingExcluded === true) {
    const err = new Error(`${creator.displayName || creator.username || "Creator"} is excluded from billing by an administrator`);
    err.code = "BILLING_CREATOR_EXCLUDED";
    err.status = 409;
    err.permanent = true;
    throw err;
  }

  const tier = normalizeTier(requested.tier || profile?.tier || "STARTER");
  const prices = configuredPrices(profile && profile.tier !== tier ? { ...profile, corePriceOverrideCents: null } : profile, policy, tier);
  if (tier === "CUSTOM" && (profile?.tier !== "CUSTOM" || profile.corePriceOverrideCents == null)) {
    throw badRequest("CUSTOM tier requires an explicit administrator price", "BILLING_CUSTOM_TIER_NOT_CONFIGURED");
  }
  const corePriceCents = prices.corePriceCents;

  if (corePriceCents <= 0) {
    const err = new Error("Selected creator tier has no billable core price");
    err.code = "BILLING_CORE_PRICE_INVALID";
    err.status = 409;
    err.permanent = true;
    throw err;
  }

  const aiChatterPriceCents = requested.aiChatterEnabled
    ? prices.aiChatterPriceCents
    : 0;
  const outreachPriceCents = requested.outreachEnabled
    ? prices.outreachPriceCents
    : 0;
  const monthlyCents = corePriceCents + aiChatterPriceCents + outreachPriceCents;

  return {
    creatorId: String(creator.id),
    creatorName: creator.displayName || creator.username || String(creator.id),
    creatorUsername: creator.username || null,
    tier,
    corePriceCents,
    aiChatterEnabled: requested.aiChatterEnabled === true,
    aiChatterPriceCents,
    outreachEnabled: requested.outreachEnabled === true,
    outreachPriceCents,
    billingExcluded: false,
    monthlyCents,
  };
}

module.exports = {
  TIER_CATALOG,
  catalogForPolicy, configuredPrices,
  AUTO_TIER_RULES,
  ADDON_CATALOG,
  PERIOD_CATALOG,
  catalogForClient,
  normalizePeriod,
  periodMonths,
  normalizeTier,
  automaticTierForRevenue,
  normalizeSelection,
  priceCreatorSelection,
};
