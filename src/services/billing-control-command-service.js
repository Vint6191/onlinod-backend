"use strict";
const { digest } = require("./team-command-contract");
const { fail } = require("./management-command-contract");
const { isOwner } = require("./team-access-control");
const { readCommercialPolicy } = require("./billing-commercial-policy-service");
const { publicProviderConfig } = require("./billing-nowpayments-service");
const { publicEntitlement, isFuture } = require("./billing-entitlement-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const wallet = require("./billing-wallet-service");

// Value snapshot plus the database-owned pricing/entitlement revisions. No
// wall-clock flags, balance, or collector timestamps: unrelated income and
// wallet credits must not continuously invalidate a creator's editor.
function billingControlRevision(creator, policy, testMode) {
  const p = creator.billingProfile,
    e = creator.billingEntitlement;
  return digest(
    JSON.parse(
      JSON.stringify([
        1,
        creator.id,
        testMode === true,
        policy.revision,
        p
          ? [
              p.id,
              p.pricingRevision,
              p.tier,
              p.tierMode,
              p.billingExcluded,
              p.aiChatterEnabled,
              p.outreachEnabled,
              p.corePriceCents,
              p.aiChatterPriceCents,
              p.outreachPriceCents,
              p.corePriceOverrideCents,
              p.aiChatterPriceOverrideCents,
              p.outreachPriceOverrideCents,
            ]
          : null,
        e
          ? [
              e.id,
              e.entitlementRevision,
              e.autoRenewEnabled,
              e.coreValidFrom,
              e.coreValidUntil,
              e.nextRenewalAt,
              e.walletTestMode,
            ]
          : null,
      ])
    )
  );
}
function assertBillingOwner(member) {
  if (!isOwner(member)) throw fail("BILLING_OWNER_ONLY", "Plan & Billing is available to the workspace owner", 403);
}
async function applyBillingControl(tx, agencyId, userId, member, command) {
  assertBillingOwner(member);
  const p = command.payload,
    creatorId = command.targetId;
  const creator = await tx.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    include: { billingProfile: true, billingEntitlement: true },
  });
  if (!creator) throw fail("BILLING_CREATOR_NOT_FOUND", "Creator not found", 404);
  const policy = await readCommercialPolicy({ db: tx, lock: true });
  const testMode = publicProviderConfig().testMode === true;
  if (billingControlRevision(creator, policy, testMode) !== p.expectedRevision)
    throw fail("BILLING_CONTROL_VERSION_CONFLICT", "Billing changed. Refresh before submitting a new action.");
  const common = { db: tx, agencyId, creatorId, actorUserId: userId };
  if (command.action === "billing.preferences") {
    await wallet.setCreatorBillingPreferences({
      ...common,
      aiChatterEnabled: p.aiChatterEnabled,
      outreachEnabled: p.outreachEnabled,
    });
    return { billingReference: {} };
  }
  if (command.action === "billing.cancelRenewal") {
    const result = await wallet.cancelCreatorRenewal(common);
    return { billingReference: { changed: result.changed === true } };
  }
  if (testMode !== p.testMode)
    throw fail("BILLING_WALLET_ENVIRONMENT_MISMATCH", "Billing environment changed. Refresh before starting.");
  const now = await dbAuthorityNow({ db: tx });
  if (isFuture(creator.billingEntitlement?.coreValidUntil, now) !== p.expectedActive)
    throw fail("BILLING_CONTROL_VERSION_CONFLICT", "The paid period changed. Refresh before starting.");
  const result = await wallet.startCreatorSubscription({
    ...common,
    testMode,
    now,
    expectedChargeCents: p.expectedChargeCents,
  });
  return {
    billingReference: { alreadyActive: result.alreadyActive === true, periodId: result.period?.id || null, testMode },
  };
}
async function currentBillingControl(tx, agencyId, command, ref) {
  const creator = await tx.creatorAccount.findFirst({
    where: { id: command.targetId, agencyId, deletedAt: null },
    include: { billingProfile: true, billingEntitlement: true },
  });
  if (!creator) return null;
  const policy = await readCommercialPolicy({ db: tx });
  const revision = billingControlRevision(creator, policy, publicProviderConfig().testMode === true);
  const base = { ok: true, creatorId: creator.id, revision };
  if (command.action === "billing.preferences")
    return {
      ...base,
      preferences: {
        aiChatterEnabled: creator.billingProfile?.aiChatterEnabled === true,
        outreachEnabled: creator.billingProfile?.outreachEnabled === true,
      },
    };
  const b = ref.billingReference;
  const now = await dbAuthorityNow({ db: tx });
  const entitlement = publicEntitlement(creator.billingEntitlement, now);
  if (command.action === "billing.cancelRenewal") return { ...base, changed: b.changed, entitlement };
  const [balance, period] = await Promise.all([
    tx.agencyBillingWallet.findUnique({ where: { agencyId_testMode: { agencyId, testMode: b.testMode } } }),
    b.periodId
      ? tx.creatorBillingPeriod.findFirst({ where: { id: b.periodId, agencyId, creatorId: creator.id } })
      : null,
  ]);
  if (b.periodId && !period) return null;
  return {
    ...base,
    alreadyActive: b.alreadyActive,
    entitlement,
    wallet: wallet.publicWallet(balance),
    period: wallet.publicBillingPeriod(period),
    pricing: null,
  };
}
module.exports = { billingControlRevision, assertBillingOwner, applyBillingControl, currentBillingControl };
