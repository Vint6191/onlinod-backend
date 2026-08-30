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
  rebuildCreatorDailyMetrics,
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
    creatorSubscriptionEvent: { findMany: async () => events },
    creatorPaidSubscription: {
      findFirst: async () => null,
      create: async ({ data }) => { createdPaid.push(data); return data; },
      update: async () => { throw new Error("unexpected update"); },
    },
    creatorSubscriptionState: {
      upsert: async (args) => { states.push(args); return args.create; },
    },
  };
  const result = await projectSubscriptionFacts({ db, agencyId: "a", creatorId: "c", fanRecordIds: ["f"], now: new Date("2026-03-01T00:00:00Z") });
  assert.equal(result.stateUpserts, 1);
  assert.equal(result.paidInserted, 2);
  assert.equal(createdPaid[1].paymentType, "RENEWAL");
  assert.equal(createdPaid[1].source, "ONLYFANS_API");
  assert.equal(states[0].create.status, "ACTIVE");
  assert.equal(states[0].create.updatedFromEventId, "e2");
});

test("daily metrics are a derived relational cache, including paid subscriptions", async () => {
  const upserts = [];
  const db = {
    async $queryRawUnsafe(sql) {
      if (sql.includes('"CreatorMessagesDaily"')) return [{ day: new Date("2026-08-01T00:00:00Z"), incoming: 2n, outgoing: 3n, dialogs: 2n }];
      if (sql.includes('"CreatorPostLike"')) return [{ day: new Date("2026-08-01T00:00:00Z"), count: 4n, fans: 3n }];
      if (sql.includes('"CreatorPostComment"')) return [{ day: new Date("2026-08-01T00:00:00Z"), count: 2n, fans: 2n }];
      if (sql.includes('"CreatorSubscriptionEvent"')) return [{ day: new Date("2026-08-01T00:00:00Z"), subscribed: 1n, renewed: 1n, expired: 0n, auto_renew_disabled: 1n }];
      if (sql.includes('"CreatorSale"')) return [{ day: new Date("2026-08-01T00:00:00Z"), message_sales: 2n, post_sales: 1n, buyers: 2n, cents: 4000n }];
      if (sql.includes('"CreatorTip"')) return [{ day: new Date("2026-08-01T00:00:00Z"), count: 1n, cents: 500n }];
      if (sql.includes('"CreatorPaidSubscription"')) return [{ day: new Date("2026-08-01T00:00:00Z"), count: 1n, cents: 1000n }];
      return [];
    },
    creatorDailyMetrics: { upsert: async (args) => { upserts.push(args); return args.create; } },
  };
  const result = await rebuildCreatorDailyMetrics({ db, agencyId: "a", creatorId: "c", from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-01T23:59:00Z"), now: new Date("2026-08-02T00:00:00Z") });
  assert.equal(result.days, 1);
  const row = upserts[0].create;
  assert.equal(row.likes, 4);
  assert.equal(row.messageSales, 2);
  assert.equal(row.tipsCents, 500);
  assert.equal(row.paidSubscriptionsCents, 1000);
  assert.equal(row.totalObservedRevenueCents, 5500);
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
