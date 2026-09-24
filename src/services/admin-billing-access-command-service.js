"use strict";
const { adminError, billingPolicySchema, billingHoldSchema, entitlementSchema } = require("./admin-command-contract");
const { executeAdminCommand } = require("./admin-commit-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { lockAgencyBillingMutation, syncAgencyBillingAggregate, publicEntitlement } = require("./billing-entitlement-service");
const { configuredPrices } = require("./billing-catalog-service");
const { readCommercialPolicy } = require("./billing-commercial-policy-service");
const { dbAuthorityNow } = require("./db-time-authority-service");

async function lockLiveAgency(tx, agencyId) {
  await lockAgencyLifecycleBarrier({ db: tx, agencyId });
  await lockAgencyBillingMutation(tx, agencyId);
  const agency = await tx.agency.findUnique({ where: { id: agencyId } });
  if (!agency) throw adminError("AGENCY_NOT_FOUND", "Agency not found", 404);
  if (agency.deletedAt) throw adminError("AGENCY_RETIRED", "Agency is retired", 409);
  return agency;
}
function policyView(agency, subscription) {
  return { agencyId: agency.id, revision: agency.billingPolicyRevision, plan: agency.plan,
    trialEndsAt: agency.trialEndsAt || null, supportHold: agency.billingSupportHold,
    supportHoldReason: agency.billingSupportHoldReason || null,
    billingMode: subscription?.billingMode || "MANUAL", billingPeriod: subscription?.billingPeriod || "MONTHLY",
    corePricePerCreatorCents: subscription?.corePricePerCreatorCents ?? 2000,
  };
}
function checkRevision(actual, expected, code) {
  if (actual !== expected) throw adminError(code, "Configuration changed; reload before editing", 409, { currentRevision: actual });
}
async function latestSubscription(tx, agencyId) {
  return tx.agencySubscription.findFirst({ where: { agencyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}
async function setAdminBillingPolicy({ db, actor, commandId, agencyId, payload }) {
  if (Object.hasOwn(payload || {}, "status") || Object.hasOwn(payload || {}, "currentPeriodEnd")) throw adminError("AGENCY_BILLING_STATE_DOMAIN_MANAGED", "Paid validity is derived from creator access. Use the support hold action to lock billing status.", 409);
  if (payload?.corePricePerCreatorCents !== undefined) throw adminError("BILLING_AGENCY_PRICE_RETIRED", "Use the global catalog or an explicit per-model override", 409);
  const input = billingPolicySchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "billing.policy.set", targetId: agencyId, payload: input, work: async ({ tx }) => {
    const agency = await lockLiveAgency(tx, agencyId);
    checkRevision(agency.billingPolicyRevision, input.expectedRevision, "ADMIN_BILLING_POLICY_REVISION_CONFLICT");
    const subscription = await latestSubscription(tx, agencyId);
    const before = policyView(agency, subscription);
    const agencyPatch = {};
    if (input.plan !== undefined) agencyPatch.plan = input.plan;
    if (input.trialEndsAt !== undefined) agencyPatch.trialEndsAt = input.trialEndsAt === null ? null : new Date(input.trialEndsAt);
    if (Object.keys(agencyPatch).length) await tx.agency.update({ where: { id: agencyId }, data: agencyPatch });
    const patch = {};
    for (const key of ["billingMode", "billingPeriod"]) if (input[key] !== undefined) patch[key] = input[key];
    patch.trialEndsAt = input.trialEndsAt === undefined ? agency.trialEndsAt : agencyPatch.trialEndsAt;
    if (subscription) await tx.agencySubscription.update({ where: { id: subscription.id }, data: patch });
    else await tx.agencySubscription.create({ data: { agencyId, ...patch } });
    const aggregate = await syncAgencyBillingAggregate(tx, agencyId, await dbAuthorityNow({ db: tx }));
    const updated = await tx.agency.findUnique({ where: { id: agencyId } });
    const sub = await latestSubscription(tx, agencyId);
    const policy = policyView(updated, sub);
    return { agencyId, body: { ok: true, policy, aggregate }, audit: { before, after: policy, aggregate } };
  } });
}
async function setAdminBillingHold({ db, actor, commandId, agencyId, payload }) {
  const input = billingHoldSchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "billing.hold.set", targetId: agencyId, payload: input, work: async ({ tx }) => {
    const agency = await lockLiveAgency(tx, agencyId);
    checkRevision(agency.billingPolicyRevision, input.expectedRevision, "ADMIN_BILLING_POLICY_REVISION_CONFLICT");
    const before = policyView(agency, await latestSubscription(tx, agencyId));
    const now = await dbAuthorityNow({ db: tx });
    await tx.agency.update({ where: { id: agencyId }, data: { billingSupportHold: input.enabled, billingSupportHoldReason: input.enabled ? input.reason : null, billingSupportHoldAt: input.enabled ? now : null } });
    const aggregate = await syncAgencyBillingAggregate(tx, agencyId, now);
    const policy = policyView(await tx.agency.findUnique({ where: { id: agencyId } }), await latestSubscription(tx, agencyId));
    return { agencyId, body: { ok: true, policy, aggregate }, audit: { before, after: policy, aggregate } };
  } });
}
async function setAdminEntitlement({ db, actor, commandId, creatorId, payload }) {
  const input = entitlementSchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "billing.entitlement.set", targetId: creatorId, payload: input, work: async ({ tx }) => {
    const identity = await tx.creatorAccount.findUnique({ where: { id: creatorId }, select: { id: true, agencyId: true } });
    if (!identity) throw adminError("CREATOR_NOT_FOUND", "Creator not found", 404);
    await lockLiveAgency(tx, identity.agencyId);
    await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 FOR SHARE', creatorId);
    await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorBillingEntitlement" WHERE "creatorId"=$1 FOR UPDATE', creatorId);
    const creator = await tx.creatorAccount.findUnique({ where: { id: creatorId }, include: { billingProfile: true, billingEntitlement: true } });
    if (!creator || creator.deletedAt || creator.agencyId !== identity.agencyId) throw adminError("CREATOR_NOT_FOUND", "Creator is no longer active in this agency", 404);
    const before = creator.billingEntitlement;
    if ((before && before.agencyId !== identity.agencyId) || (creator.billingProfile && creator.billingProfile.agencyId !== identity.agencyId)) throw adminError("BILLING_SCOPE_MISMATCH", "Stored billing facts do not match the creator agency; explicit repair is required", 409);
    checkRevision(before?.entitlementRevision || 0, input.expectedRevision, "ADMIN_ENTITLEMENT_REVISION_CONFLICT");
    const now = await dbAuthorityNow({ db: tx });
    const profile = creator.billingProfile;
    const tier = input.tier || before?.tier || profile?.tier || "STARTER";
    const prices = configuredPrices(profile, await readCommercialPolicy({ db: tx, lock: true }), tier);
    const data = {};
    if (input.coreValidUntil !== undefined) {
      const until = input.coreValidUntil === null ? null : new Date(input.coreValidUntil);
      const active = until && until > now;
      const wasActive = before?.coreValidUntil && new Date(before.coreValidUntil) > now;
      Object.assign(data, { tier, coreSource: "ADMIN", corePriceCents: prices.corePriceCents,
        coreValidFrom: active ? (wasActive ? before.coreValidFrom || now : now) : before?.coreValidFrom || null,
        coreValidUntil: until, coreLastOrderId: null,
        subscriptionStartedAt: before?.subscriptionStartedAt || before?.coreValidFrom || (active ? now : null),
        currentPeriodStartedAt: active ? (wasActive ? before.currentPeriodStartedAt || before.coreValidFrom || now : now) : null,
        currentPeriodEndsAt: until, nextRenewalAt: null,
        billingAnchorDay: active ? (wasActive ? before.billingAnchorDay || now.getUTCDate() : now.getUTCDate()) : before?.billingAnchorDay || null,
        tierAtPeriodStart: tier, amountChargedForPeriodCents: 0, autoRenewEnabled: false, lastRenewalErrorCode: null, walletTestMode: null,
      });
    }
    // Only explicitly selected components lose their previous provenance.
    if (input.aiChatterValidUntil !== undefined) Object.assign(data, { aiChatterSource: "ADMIN", aiChatterValidUntil: input.aiChatterValidUntil === null ? null : new Date(input.aiChatterValidUntil), aiLastOrderId: null, aiChatterPriceCents: prices.aiChatterPriceCents });
    if (input.outreachValidUntil !== undefined) Object.assign(data, { outreachSource: "ADMIN", outreachValidUntil: input.outreachValidUntil === null ? null : new Date(input.outreachValidUntil), outreachLastOrderId: null, outreachPriceCents: prices.outreachPriceCents });
    const entitlement = before ? await tx.creatorBillingEntitlement.update({ where: { creatorId }, data }) : await tx.creatorBillingEntitlement.create({ data: { agencyId: identity.agencyId, creatorId, ...data } });
    const aggregate = await syncAgencyBillingAggregate(tx, identity.agencyId, now);
    return { agencyId: identity.agencyId, body: { ok: true, entitlement: publicEntitlement(entitlement, now), aggregate }, audit: { before: publicEntitlement(before, now), after: publicEntitlement(entitlement, now), aggregate } };
  } });
}
module.exports = { setAdminBillingPolicy, setAdminBillingHold, setAdminEntitlement, lockLiveAgency, policyView };
