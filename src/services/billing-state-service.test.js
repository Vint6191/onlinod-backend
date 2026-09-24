"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { effectiveBillingState, liveEntitlementEnd, activeCore, readBillingDashboard } = require("./billing-state-service");
const now = new Date("2026-09-24T12:00:00Z"), past = new Date(now.getTime() - 1), future = new Date(now.getTime() + 1);
const agency = { id: "a", status: "ACTIVE", trialEndsAt: null };
const state = patch => effectiveBillingState({ agency, now, ...patch });

test("effective state ignores stale ACTIVE and both null and expired trial deadlines", () => {
  for (const trialEndsAt of [null, past, now]) assert.equal(state({ agency: { ...agency, status: "TRIAL", trialEndsAt } }).status, "PAST_DUE");
});
test("unexpired trial works without an AgencySubscription row", () => {
  assert.equal(state({ agency: { ...agency, trialEndsAt: future } }).status, "TRIAL");
});
test("only current core facts restore ACTIVE; cached subscription period cannot restore it", () => {
  assert.equal(state({ activeUntil: future }).status, "ACTIVE");
  assert.equal(state({ activeUntil: now, subscription: { status: "ACTIVE", currentPeriodEnd: future } }).status, "PAST_DUE");
});
test("hold and agency retirement dominate paid, free and trial modes while preserving the factual paid end", () => {
  for (const patch of [{ billingSupportHold: true }, { deletedAt: past }]) {
    const value = state({ agency: { ...agency, ...patch, trialEndsAt: future }, billingMode: "FREE_INTERNAL", activeUntil: future });
    assert.equal(value.status, "LOCKED"); assert.equal(value.currentPeriodEnd, future);
  }
});
test("FREE_INTERNAL is explicit and CANCELLED is preserved only after all time-based access ends", () => {
  assert.equal(state({ subscription: { billingMode: "FREE_INTERNAL" } }).status, "ACTIVE");
  assert.equal(state({ subscription: { status: "CANCELLED" } }).status, "CANCELLED");
  assert.equal(state({ subscription: { status: "CANCELLED" }, activeUntil: future }).status, "ACTIVE");
});
test("paid start is inclusive, paid end is exclusive, historical unspecified start remains valid", () => {
  for (const coreValidFrom of [null, past, now]) assert.equal(activeCore({ coreValidFrom, coreValidUntil: future }, now), true);
  for (const coreValidFrom of [future, "invalid"]) assert.equal(activeCore({ coreValidFrom, coreValidUntil: future }, now), false);
  assert.equal(activeCore({ coreValidUntil: now }, now), false);
});
test("a deleted or foreign creator/entitlement cannot keep another agency ACTIVE", () => {
  const c = { id: "c", agencyId: "a", billingEntitlement: { creatorId: "c", agencyId: "a", coreValidUntil: future } };
  assert.equal(liveEntitlementEnd([c], "a", now), future);
  for (const corrupt of [{ ...c, deletedAt: past }, { ...c, agencyId: "b" },
    { ...c, billingEntitlement: { ...c.billingEntitlement, agencyId: "b" } },
    { ...c, billingEntitlement: { ...c.billingEntitlement, creatorId: "other" } }]) assert.equal(liveEntitlementEnd([corrupt], "a", now), null);
});
test("future scheduled grants are excluded while the maximum currently valid grant wins", () => {
  const c = (id, end, from = null) => ({ id, agencyId: "a", billingEntitlement: { creatorId: id, agencyId: "a", coreValidFrom: from, coreValidUntil: end } });
  const later = new Date("2027-01-01");
  assert.equal(liveEntitlementEnd([c("a", future), c("b", later, future)], "a", now), future);
  assert.equal(liveEntitlementEnd([c("a", future), c("b", later)], "a", now), later);
});
test("state computation requires an explicit valid authority clock and an existing agency", () => {
  assert.throws(() => effectiveBillingState({ agency }), /CLOCK_REQUIRED/);
  assert.throws(() => effectiveBillingState({ agency: null, now }), { code: "AGENCY_NOT_FOUND" });
});
test("dashboard never rounds unsafe SQL monetary totals into a plausible figure", async () => {
  const row = { total: "1", active: "1", trial: "0", locked: "0", core: "2000", ai: "0", outreach: "0" };
  const db = { $queryRawUnsafe: async () => [row] };
  assert.deepEqual(await readBillingDashboard({ db }), { counts: { total: 1, active: 1, trial: 0, locked: 0 }, mrr: { coreCents: 2000, aiChatterCents: 0, outreachCents: 0 } });
  row.core = "9007199254740993";
  await assert.rejects(readBillingDashboard({ db }), /STATE_INVALID/);
});
