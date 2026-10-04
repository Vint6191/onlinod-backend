"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma" && parent?.filename?.endsWith("creator-analytics-projection-service.js")) return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {
  projectSubscriptionState,
  projectSubscriptionFacts,
  upsertLocalMessageCoverage,
} = require("./creator-analytics-projection-service");
Module._load = originalLoad;

test("subscription state is rebuilt chronologically and refund does not invent expiry", () => {
  const events = [
    { id: "1", eventType: "SUBSCRIBED_PAID", observedPriceCents: 1000, currency: "USD", occurredAt: new Date("2026-01-01T00:00:00Z") },
    { id: "2", eventType: "AUTO_RENEW_DISABLED", observedPriceCents: null, currency: "USD", occurredAt: new Date("2026-01-02T00:00:00Z") },
    { id: "3", eventType: "RENEWED", observedPriceCents: 1000, currency: "USD", occurredAt: new Date("2026-02-01T00:00:00Z") },
    { id: "4", eventType: "REFUNDED", observedPriceCents: 1000, currency: "USD", occurredAt: new Date("2026-02-02T00:00:00Z") },
  ];
  const state = projectSubscriptionState(events);
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.currentPriceCents, 1000);
  assert.equal(state.autoRenewEnabled, false);
  assert.equal(state.lastRenewedAt.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(state.endedAt, null);
  assert.equal(state.updatedFromEventId, "4");
});

test("subscription projection materializes one current state and typed paid rows", async () => {
  const events = [
    { id: "e1", agencyId: "a", creatorId: "c", fanRecordId: "f", eventFingerprint: "a".repeat(64), externalTransactionId: "tx1", eventType: "SUBSCRIBED_PAID", observedPriceCents: 1000, currency: "USD", occurredAt: new Date("2026-01-01T00:00:00Z"), source: "NOTIFICATION", collectedAt: new Date("2026-01-02T00:00:00Z") },
    { id: "e2", agencyId: "a", creatorId: "c", fanRecordId: "f", eventFingerprint: "b".repeat(64), externalTransactionId: "tx2", eventType: "RENEWED", observedPriceCents: 1000, currency: "USD", occurredAt: new Date("2026-02-01T00:00:00Z"), source: "ONLYFANS_API", collectedAt: new Date("2026-02-02T00:00:00Z") },
  ];
  const createdPaid = [];
  const states = [];
  const db = {
    $queryRawUnsafe: async () => events.map(event => ({ ...event, fanId: event.fanRecordId })),
    $executeRawUnsafe: async (sql, payload) => {
      const rows = JSON.parse(payload);
      if (sql.includes('INSERT INTO "CreatorPaidSubscription"')) createdPaid.push(...rows);
      else if (sql.includes('INSERT INTO "CreatorSubscriptionState"')) states.push(...rows.map(create => ({create})));
      else throw new Error("unexpected SQL");
    },
    creatorSubscriptionEvent: { findMany: async args => {
      assert.deepEqual(args.where.id.in, ["e1", "e2"]);
      assert.equal(args.take, 2);
      return events;
    } },
    creatorPaidSubscription: {
      findMany: async () => [],
      create: async ({ data }) => { createdPaid.push(data); return data; },
      update: async () => { throw new Error("unexpected update"); },
    },
    creatorSubscriptionState: {
      updateMany: async () => ({count: 0}),
      upsert: async (args) => { states.push(args); return args.create; },
    },
  };
  const result = await projectSubscriptionFacts({ db, agencyId: "a", creatorId: "c", fanRecordIds: ["f"], eventIds: ["e1", "e2"], now: new Date("2026-03-01T00:00:00Z") });
  assert.equal(result.stateUpserts, 1);
  assert.equal(result.paidInserted, 2);
  assert.equal(createdPaid[1].paymentType, "RENEWAL");
  assert.equal(createdPaid[1].source, "ONLYFANS_API");
  assert.equal(states[0].create.status, "ACTIVE");
  assert.equal(states[0].create.updatedFromEventId, "e2");
});

test("the old best-effort daily writer is retired", () => {
  assert.equal(require("./creator-analytics-projection-service").rebuildCreatorDailyMetrics, undefined);
  const { contribution } = require("./analytics-fact-publication-service");
  assert.equal(contribution("CreatorPaidSubscription", { paidAt: "2026-08-01", amountCents: 1000 }).values.paidSubscriptionsCents, 1000);
});

test("local message coverage stores only metadata, never message payloads", async () => {
  let args = null;
  const db = { creatorLocalMessageCoverage: { upsert: async (value) => { args = value; return value.create; } } };
  await upsertLocalMessageCoverage({
    db, agencyId: "a", creatorId: "c", deviceId: "d", complete: true,
    knownDialogs: 10, incompleteDialogs: 0, messagesIndexed: 500,
    oldestMessageAt: "2025-01-01T00:00:00Z", newestMessageAt: "2026-08-01T00:00:00Z",
    verifiedAt: new Date("2026-08-02T00:00:00Z"),
  });
  assert.equal(args.create.coverageStatus, "COMPLETE");
  assert.equal(args.create.dialogsCovered, 10);
  assert.equal(args.create.messagesIndexed, 500);
  assert.equal("payload" in args.create, false);
  assert.equal("text" in args.create, false);
});
