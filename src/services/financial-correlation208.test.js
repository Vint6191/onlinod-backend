"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const correlation = require("./financial-correlation-service");
const { mergeNotificationMoney } = require("./creator-fact-write-authority");

test("payout observation keeps the original notification neighborhood and cannot upgrade fuzzy proof to exact", () => {
  const previous = { id: "source", externalNotificationId: "n", fanRecordId: "fan", amountCents: 1000,
    currency: "USD", purchasedAt: new Date("2026-11-27T12:00:00.000Z") };
  const first = correlation.neighborhoodEvidence(previous, { externalTransactionId: "t1" }, "SALE");
  assert.equal(first.state, "UNIQUE"); assert.equal(first.occurredAt, previous.purchasedAt.toISOString());
  const ambiguous = { ...first, state: "AMBIGUOUS", ambiguousAt: "2026-11-27T13:00:00.000Z" };
  const canonical = { ...previous, externalTransactionId: "t1", financialCorrelation: ambiguous,
    source: "ONLYFANS_API", amountCents: 1000, netCents: 800, transactionStatus: "done" };
  assert.deepEqual(correlation.neighborhoodEvidence(canonical, { externalTransactionId: "t1" }, "SALE"), ambiguous);
  const replay = mergeNotificationMoney("creatorSale", canonical, { externalNotificationId: "n", externalTransactionId: null });
  assert.deepEqual(replay.financialCorrelation, ambiguous);
  const strong = mergeNotificationMoney("creatorSale", canonical, { externalNotificationId: "n", externalTransactionId: "t1" });
  assert.equal(strong.financialCorrelation.state, "EXACT"); assert.equal(strong.netCents, 800);
});

test("a newly ambiguous correlation retains manual ownership and requires evidence or a later explicit decision", () => {
  const fact = { financialCorrelation: { version: 1, kind: "NEIGHBORHOOD", state: "AMBIGUOUS", ambiguousAt: "2026-11-27T13:00:00.000Z" } };
  const root = { status: "attributed", attributedMemberId: "owner", resolvedSource: "manual_claim_resolution",
    resolvedAt: new Date("2026-11-27T12:00:00.000Z") };
  assert.equal(correlation.requiresReview(fact, root), true);
  assert.equal(correlation.requiresReview(fact, { ...root, resolvedAt: new Date("2026-11-27T13:01:00.000Z") }), false);
  assert.equal(correlation.requiresReview(fact, { ...root, status: "rejected", attributedMemberId: null }), false);
  const conflict = { ...root, status: "conflict", attributionBasis: "FINANCIAL_IDENTITY_AMBIGUOUS" };
  assert.deepEqual(correlation.restoredManualDecision(fact, conflict), {});
  const strong = { financialCorrelation: { ...fact.financialCorrelation, kind: "EXACT", state: "EXACT" } };
  assert.equal(correlation.requiresReview(strong, conflict), false);
  assert.deepEqual(correlation.restoredManualDecision(strong, conflict), { status: "attributed", attributionBasis: "MANUAL_OVERRIDE_PRESERVED" });
  assert.deepEqual(correlation.restoredManualDecision(strong, { ...conflict, resolvedSource: "manual_manager_resolution" }),
    { status: "resolved", attributionBasis: "MANUAL_OVERRIDE_PRESERVED" });
  assert.deepEqual(correlation.restoredManualDecision(strong, { ...conflict, attributedMemberId: null }), {});
});

test("canonical corrections preserve money identity but withdraw invalid neighborhood ownership evidence", () => {
  const at = new Date("2026-11-27T12:00:00.000Z"), now = new Date(+at + 60000);
  const evidence = { version: 1, kind: "NEIGHBORHOOD", state: "UNIQUE", fanId: "fan", amountCents: 1000, currency: "USD", occurredAt: at.toISOString() };
  const previous = { externalTransactionId: "t1", financialCorrelation: evidence };
  const incoming = { externalTransactionId: "t1", fanRecordId: "fan", amountCents: 1000, currency: "USD", occurredAt: at };
  assert.deepEqual(correlation.neighborhoodEvidence(previous, incoming, "TIP", now), evidence);
  for (const patch of [{ fanRecordId: "other" }, { amountCents: 2000 }, { currency: "EUR" }, { occurredAt: new Date(+at + 5001) }]) {
    const changed = correlation.neighborhoodEvidence(previous, { ...incoming, ...patch }, "TIP", now);
    assert.equal(changed.state, "AMBIGUOUS"); assert.equal(changed.reason, "SOURCE_NEIGHBORHOOD_CHANGED");
    assert.equal(changed.occurredAt, evidence.occurredAt);
  }
  const exact = { ...evidence, kind: "EXACT", state: "EXACT" };
  assert.deepEqual(correlation.neighborhoodEvidence({ ...previous, financialCorrelation: exact }, { ...incoming, amountCents: 2000 }, "TIP", now), exact);
});
