"use strict";

const { adminError, pricingSchema } = require("./admin-command-contract");
const { executeAdminCommand } = require("./admin-commit-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { lockAgencyBillingMutation } = require("./billing-entitlement-service");
const { TIER_CATALOG, ADDON_CATALOG } = require("./billing-catalog-service");

function lineCents(row) {
  return row.billingExcluded ? 0 : row.corePriceCents + (row.aiChatterEnabled ? row.aiChatterPriceCents : 0) + (row.outreachEnabled ? row.outreachPriceCents : 0);
}

async function setPricingWithinTransaction({ tx, creatorId, payload }) {
  const identity = await tx.creatorAccount.findUnique({ where: { id: creatorId }, select: { id: true, agencyId: true } });
  if (!identity) throw adminError("CREATOR_NOT_FOUND", "Creator not found", 404);
  const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: identity.agencyId });
  if (!lifecycle.row || lifecycle.row.deletedAt) throw adminError("AGENCY_RETIRED", "Agency is retired", 409);
  await lockAgencyBillingMutation(tx, identity.agencyId);
  await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 FOR SHARE', creatorId, identity.agencyId);
  await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorBillingProfile" WHERE "creatorId"=$1 FOR UPDATE', creatorId);
  const creator = await tx.creatorAccount.findUnique({ where: { id: creatorId }, include: { billingProfile: true } });
  if (!creator || creator.deletedAt || creator.agencyId !== identity.agencyId) throw adminError("CREATOR_NOT_FOUND", "Creator is no longer active in this agency", 404);
  const before = creator.billingProfile;
  const revision = before?.pricingRevision || 0;
  if (revision !== payload.expectedRevision) throw adminError("ADMIN_PRICING_REVISION_CONFLICT", "Pricing changed; reload before editing", 409, { currentRevision: revision });
  const { expectedRevision: _revision, reason: _reason, ...patch } = payload;
  // A deliberate tier/price edit switches to MANUAL unless explicitly rejected
  // as a conflicting AUTO request. Revenue observations remain domain-owned.
  if (patch.tierMode === "AUTO" && (patch.tier !== undefined || patch.corePriceCents !== undefined)) throw adminError("ADMIN_AUTO_PRICING_CONFLICT", "AUTO pricing cannot include a manual tier or core price", 400);
  if ((patch.tier !== undefined || patch.corePriceCents !== undefined) && patch.tierMode === undefined) patch.tierMode = "MANUAL";
  if (patch.tier === "CUSTOM" && patch.corePriceCents === undefined) throw adminError("ADMIN_CUSTOM_PRICE_REQUIRED", "CUSTOM tier requires an explicit core price", 400);
  if (patch.tier && patch.tier !== "CUSTOM" && patch.corePriceCents === undefined) patch.corePriceCents = TIER_CATALOG[patch.tier].priceCents;
  const defaults = {
    agencyId: identity.agencyId, creatorId, tier: "STARTER", tierMode: "AUTO",
    corePriceCents: TIER_CATALOG.STARTER.priceCents, aiChatterEnabled: false,
    aiChatterPriceCents: ADDON_CATALOG.aiChatter.priceCents, outreachEnabled: false,
    outreachPriceCents: ADDON_CATALOG.outreach.priceCents, billingExcluded: false,
  };
  const billing = before
    ? await tx.creatorBillingProfile.update({ where: { creatorId }, data: patch })
    : await tx.creatorBillingProfile.create({ data: { ...defaults, ...patch } });
  return { agencyId: identity.agencyId, body: { ok: true, billing, lineCents: lineCents(billing), configuredLineCents: lineCents(billing) }, audit: { before: before || null, after: billing } };
}

async function setAdminPricing({ db, actor, commandId, creatorId, payload }) {
  const normalized = pricingSchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "billing.pricing.set", targetId: creatorId, payload: normalized,
    work: ({ tx, payload: input }) => setPricingWithinTransaction({ tx, creatorId, payload: input }),
  });
}

module.exports = { setAdminPricing, setPricingWithinTransaction, lineCents };
