"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createMemoryDb } = require("../../scripts/test-support/admin-command-memory-db");
const { setAdminBillingPolicy, setAdminBillingHold, setAdminEntitlement } = require("./admin-billing-access-command-service");
const { syncAgencyBillingAggregate } = require("./billing-entitlement-service");
const actor = { adminId: "admin-a", sessionId: "session-a", accessEpoch: 1 };
const until = new Date("2026-11-23T12:00:00Z");
const context = m => ({ db: m.db, actor, commandId: randomUUID(), agencyId: "agency-a", creatorId: "creator-a" });
function paid(m) {
  m.state.entitlements.push({ id: "ent-a", agencyId: "agency-a", creatorId: "creator-a", entitlementRevision: 1,
    tier: "PRO", coreSource: "PAYMENT", corePriceCents: 5000, coreValidFrom: m.clock, coreValidUntil: until, coreLastOrderId: "paid-order",
    aiChatterSource: "PAYMENT", aiChatterValidUntil: until, aiChatterPriceCents: 8000, aiLastOrderId: "paid-addon",
    autoRenewEnabled: true, nextRenewalAt: until, walletTestMode: false, amountChargedForPeriodCents: 13000,
  });
}

test("policy null clears both trial fields atomically and paid period stays derived", async () => {
  const m = createMemoryDb(); paid(m);
  m.state.agencies[0].trialEndsAt = until; m.state.subscriptions[0].trialEndsAt = until;
  const result = await setAdminBillingPolicy({ ...context(m), payload: { expectedRevision: 1, reason: "Trial replaced by paid access", trialEndsAt: null, plan: "pro" } });
  assert.equal(result.statusCode, 200); assert.equal(m.state.agencies[0].trialEndsAt, null); assert.equal(m.state.subscriptions[0].trialEndsAt, null);
  assert.deepEqual(m.state.agencies[0].currentPeriodEnd, until); assert.deepEqual(m.state.subscriptions[0].currentPeriodEnd, until);
  assert.equal(m.state.audit.length, 1); assert.ok(result.body.policy.revision > 1);
});
test("policy audit failure cannot leave half of Agency/Subscription changed", async () => {
  const m = createMemoryDb({ failAudit: true }); const before = structuredClone(m.state);
  await assert.rejects(setAdminBillingPolicy({ ...context(m), payload: { expectedRevision: 1, reason: "Edit", plan: "changed", billingMode: "CRYPTO" } }), /audit unavailable/);
  assert.deepEqual(m.state, before);
});
test("legacy direct paid validity/status edits receive a domain-managed rejection", async () => {
  const m = createMemoryDb();
  for (const field of [{ status: "ACTIVE" }, { currentPeriodEnd: null }]) await assert.rejects(setAdminBillingPolicy({ ...context(m), payload: { expectedRevision: 1, reason: "Edit", ...field } }), { code: "AGENCY_BILLING_STATE_DOMAIN_MANAGED" });
  assert.equal(m.state.commands.length, 0);
});
test("hold survives payment aggregate updates and release derives access rather than forcing ACTIVE", async () => {
  const m = createMemoryDb(); paid(m);
  const hold = await setAdminBillingHold({ ...context(m), payload: { expectedRevision: 1, reason: "Manual billing review", enabled: true } });
  assert.equal(hold.body.aggregate.status, "LOCKED");
  await m.db.$transaction(tx => syncAgencyBillingAggregate(tx, "agency-a", m.clock, { payment: { testMode: false, billingPeriod: "MONTHLY" } }));
  assert.equal(m.state.agencies[0].status, "LOCKED"); assert.equal(m.state.subscriptions[0].status, "LOCKED");
  assert.equal(m.state.entitlements[0].coreLastOrderId, "paid-order");
  m.state.entitlements[0].coreValidUntil = null;
  const released = await setAdminBillingHold({ ...context(m), payload: { expectedRevision: m.state.agencies[0].billingPolicyRevision, reason: "Review completed", enabled: false } });
  assert.equal(released.body.aggregate.status, "PAST_DUE"); assert.equal(released.body.aggregate.currentPeriodEnd, null);
});
test("a payment policy change invalidates an old admin form even when aggregate dates are unrelated", async () => {
  const m = createMemoryDb(); paid(m);
  await m.db.$transaction(tx => syncAgencyBillingAggregate(tx, "agency-a", m.clock, { payment: { testMode: false, billingPeriod: "THREE_MONTHS" } }));
  const result = await setAdminBillingPolicy({ ...context(m), payload: { expectedRevision: 1, reason: "Old form", billingMode: "MANUAL" } });
  assert.equal(result.statusCode, 409); assert.equal(m.state.subscriptions[0].billingMode, "CRYPTO");
});
test("add-on grant preserves core paid price, source, wallet consent and order attribution", async () => {
  const m = createMemoryDb(); paid(m); const core = structuredClone(m.state.entitlements[0]);
  const result = await setAdminEntitlement({ ...context(m), payload: { expectedRevision: 1, reason: "AI support extension", aiChatterValidUntil: "2026-12-01T00:00:00Z" } });
  assert.equal(result.statusCode, 200);
  const row = m.state.entitlements[0];
  for (const field of ["corePriceCents", "coreSource", "coreLastOrderId", "autoRenewEnabled", "walletTestMode", "amountChargedForPeriodCents", "coreValidUntil"]) assert.deepEqual(row[field], core[field], field);
  assert.equal(row.aiChatterSource, "ADMIN"); assert.equal(row.aiLastOrderId, null); assert.equal(result.body.entitlement.entitlementRevision, 2);
});
test("core manual grant has explicit ADMIN provenance and cannot silently opt into wallet renewal", async () => {
  const m = createMemoryDb(); paid(m);
  const result = await setAdminEntitlement({ ...context(m), payload: { expectedRevision: 1, reason: "Support extension", coreValidUntil: "2026-12-01T00:00:00Z", tier: "ELITE" } });
  assert.equal(result.statusCode, 200); const row = m.state.entitlements[0];
  assert.equal(row.coreSource, "ADMIN"); assert.equal(row.autoRenewEnabled, false); assert.equal(row.nextRenewalAt, null); assert.equal(row.amountChargedForPeriodCents, 0);
  assert.equal(row.aiLastOrderId, "paid-addon"); assert.equal(row.aiChatterPriceCents, 8000);
});
test("grant plus aggregate and audit roll back together on storage failure", async () => {
  const m = createMemoryDb({ failAudit: true }); paid(m); const before = structuredClone(m.state);
  await assert.rejects(setAdminEntitlement({ ...context(m), payload: { expectedRevision: 1, reason: "Revoke", coreValidUntil: null } }), /audit unavailable/);
  assert.deepEqual(m.state, before);
});
test("entitlement same-command retry never applies the grant twice", async () => {
  const m = createMemoryDb(); paid(m);
  const args = { ...context(m), payload: { expectedRevision: 1, reason: "Revoke AI", aiChatterValidUntil: null } };
  const first = await setAdminEntitlement(args); const second = await setAdminEntitlement(args);
  assert.deepEqual(first.body, second.body); assert.equal(second.replayed, true); assert.equal(m.state.audit.length, 1);
});
test("concurrent stale entitlement intents conflict instead of replacing paid access", async () => {
  const m = createMemoryDb(); paid(m);
  const result = await Promise.all([setAdminEntitlement({ ...context(m), payload: { expectedRevision: 1, reason: "AI extension", aiChatterValidUntil: "2027-01-01T00:00:00Z" } }), setAdminEntitlement({ ...context(m), payload: { expectedRevision: 1, reason: "Stale revoke", coreValidUntil: null } })]);
  assert.deepEqual(result.map(r => r.statusCode), [200, 409]); assert.deepEqual(m.state.entitlements[0].coreValidUntil, until);
});
test("retired agency cannot accept admin policy, hold or entitlement commands", async () => {
  const m = createMemoryDb(); m.state.agencies[0].deletedAt = m.clock;
  for (const [fn, payload] of [[setAdminBillingPolicy, { plan: "pro" }], [setAdminBillingHold, { enabled: true }], [setAdminEntitlement, { coreValidUntil: null }]]) {
    const result = await fn({ ...context(m), payload: { expectedRevision: 1, reason: "Edit", ...payload } }); assert.equal(result.body.code, "AGENCY_RETIRED");
  }
});
test("FREE_INTERNAL preserves policy while aggregate dates still clear when no live grants remain", async () => {
  const m = createMemoryDb(); m.state.subscriptions[0].billingMode = "FREE_INTERNAL"; m.state.subscriptions[0].currentPeriodEnd = until;
  const result = await m.db.$transaction(tx => syncAgencyBillingAggregate(tx, "agency-a", m.clock));
  assert.equal(result.billingMode, "FREE_INTERNAL"); assert.equal(result.status, "ACTIVE"); assert.equal(result.currentPeriodEnd, null);
  assert.equal(m.state.subscriptions[0].currentPeriodEnd, null);
});
test("SUPPORT cannot set a global agency billing hold", async () => {
  const m = createMemoryDb(); m.state.admins[0].role = "SUPPORT";
  await assert.rejects(setAdminBillingHold({ ...context(m), payload: { expectedRevision: 1, reason: "Hold", enabled: true } }), { code: "ADMIN_INSUFFICIENT_ROLE" });
});
test("cross-agency aggregate excludes other agency facts", async () => {
  const m = createMemoryDb(); paid(m);
  m.state.agencies.push({ ...m.state.agencies[0], id: "agency-b" });
  m.state.creators.push({ id: "creator-b", agencyId: "agency-b", deletedAt: null });
  m.state.entitlements.push({ ...m.state.entitlements[0], id: "ent-b", creatorId: "creator-b", agencyId: "agency-b", coreValidUntil: new Date("2030-01-01") });
  const result = await m.db.$transaction(tx => syncAgencyBillingAggregate(tx, "agency-a", m.clock)); assert.deepEqual(result.currentPeriodEnd, until);
});

test("historical mismatched billing scope is rejected instead of silently crossing agencies", async () => {
  const { setAdminPricing } = require("./admin-pricing-command-service");
  const m = createMemoryDb(); paid(m); m.state.profiles[0].agencyId = "wrong-agency";
  const grant = await setAdminEntitlement({ ...context(m), payload: { expectedRevision: 1, reason: "Grant", coreValidUntil: null } });
  const price = await setAdminPricing({ ...context(m), payload: { expectedRevision: 1, reason: "Price", corePriceCents: 9 } });
  assert.equal(grant.body.code, "BILLING_SCOPE_MISMATCH"); assert.equal(price.body.code, "BILLING_SCOPE_MISMATCH");
  assert.equal(m.state.profiles[0].corePriceCents, 2000); assert.deepEqual(m.state.entitlements[0].coreValidUntil, until);
});
test("aggregate ignores a historical entitlement linked to a creator from another agency", async () => {
  const m = createMemoryDb(); paid(m); m.state.creators[0].agencyId = "other-agency";
  const result = await m.db.$transaction(tx => syncAgencyBillingAggregate(tx, "agency-a", m.clock));
  assert.equal(result.currentPeriodEnd, null); assert.equal(result.status, "PAST_DUE");
});
