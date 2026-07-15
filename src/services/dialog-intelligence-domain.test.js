"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyPurchase,
  purchaseCountsAsRevenue,
  purchaseIdempotencyKey,
  allocatePackagePrice,
  advanceKnownMessageStreak,
} = require("./dialog-intelligence-domain");

test("purchase classification follows opened/free/media rules", () => {
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 2500, isOpened: true }), "SOLD");
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 2500, isOpened: false }), "NOT_OPENED");
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 2500, isOpened: true, isFree: true }), "FREE");
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 0, isOpened: true }), "FREE");
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: false, hasFanMedia: true, priceCents: 2500, isOpened: true }), "EXCLUDED_FAN_MEDIA");
  assert.equal(classifyPurchase({ messageResolved: false, priceCents: 2500 }), "UNRESOLVED_MESSAGE");
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: false, priceCents: 2500 }), "UNRESOLVED_MEDIA");
  assert.equal(classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 2500, isOpened: true, deletedUser: true }), "DELETED_USER");
});

test("deleted buyer sale remains revenue", () => {
  assert.equal(purchaseCountsAsRevenue({ status: "DELETED_USER", isOpened: true, isFree: false, priceCents: 5000 }), true);
  assert.equal(purchaseCountsAsRevenue({ status: "NOT_OPENED", isOpened: false, isFree: false, priceCents: 5000 }), false);
  assert.equal(purchaseCountsAsRevenue({ status: "FREE", isOpened: true, isFree: true, priceCents: 0 }), false);
  assert.equal(purchaseCountsAsRevenue({ status: "REFUNDED", isOpened: true, isFree: false, priceCents: 5000 }), false);
});

test("event id and fallback fingerprints are deterministic", () => {
  assert.equal(
    purchaseIdempotencyKey({ creatorId: "creator-1", sourceEventId: "event-9" }),
    "vault_purchase:creator-1:event-9",
  );
  const source = { creatorId: "creator-1", buyerId: "fan-2", sourceMessageId: "77", occurredAt: "2026-07-15T10:00:00.000Z", amountCents: 1900 };
  assert.equal(purchaseIdempotencyKey(source), purchaseIdempotencyKey({ ...source }));
  assert.notEqual(purchaseIdempotencyKey(source), purchaseIdempotencyKey({ ...source, amountCents: 2000 }));
});


test("package price is allocated once across creator media and never to fan media", () => {
  assert.deepEqual(
    allocatePackagePrice(1001, [
      { mediaId: "creator-a", isFanMedia: false },
      { mediaId: "fan-a", isFanMedia: true },
      { mediaId: "creator-b", isFanMedia: false },
    ]),
    [500, 0, 501],
  );
  assert.deepEqual(allocatePackagePrice(1000, [{ isFanMedia: true }]), [0]);
  assert.equal(allocatePackagePrice(1001, [{ isFanMedia: false }, { isFanMedia: false }]).reduce((a, b) => a + b, 0), 1001);
});

test("terminal and deleted-message statuses remain distinct from technical scan failures", () => {
  assert.equal(classifyPurchase({ refunded: true }), "REFUNDED");
  assert.equal(classifyPurchase({ invalid: true }), "INVALID");
  assert.equal(classifyPurchase({ messageResolved: false, deletedMessage: true }), "DELETED_MESSAGE");
});


test("known-message streak increments once and stops exactly at threshold", () => {
  const first = advanceKnownMessageStreak({ startingStreak: 0, threshold: 3, observations: [{ known: true, changed: false }] });
  assert.deepEqual(first, { streak: 1, threshold: 3, stop: false });
  const second = advanceKnownMessageStreak({ startingStreak: first.streak, threshold: 3, observations: [{ known: true, changed: false }] });
  assert.deepEqual(second, { streak: 2, threshold: 3, stop: false });
  const third = advanceKnownMessageStreak({ startingStreak: second.streak, threshold: 3, observations: [{ known: true, changed: false }] });
  assert.deepEqual(third, { streak: 3, threshold: 3, stop: true });
});

test("mutable message resets known streak", () => {
  const result = advanceKnownMessageStreak({
    startingStreak: 2,
    threshold: 3,
    observations: [{ known: true, changed: true }, { known: true, changed: false }],
  });
  assert.deepEqual(result, { streak: 1, threshold: 3, stop: false });
});


test("mutable opened state is treated as changed and reclassifies NOT_OPENED to SOLD", () => {
  const before = classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 2500, isOpened: false });
  const after = classifyPurchase({ messageResolved: true, mediaResolved: true, hasCreatorMedia: true, priceCents: 2500, isOpened: true });
  const known = advanceKnownMessageStreak({
    startingStreak: 2,
    threshold: 3,
    observations: [{ known: true, changed: true }],
  });
  assert.equal(before, "NOT_OPENED");
  assert.equal(after, "SOLD");
  assert.deepEqual(known, { streak: 0, threshold: 3, stop: false });
});
