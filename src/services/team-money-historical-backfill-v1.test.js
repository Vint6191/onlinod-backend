"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-money-reconciliation-service");
delete require.cache[prismaPath];
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
delete require.cache[servicePath];
const { reconcileHistoricalTeamMoneyBatch } = require(servicePath);

function saleBackfillDb() {
  let query = null;
  let purchase = null;
  const sale = {
    id: "sale-historical-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanId: "fan-internal-1",
    eventFingerprint: "sale-historical-fp",
    externalNotificationId: "notification-historical-1",
    externalTransactionId: null,
    saleType: "MESSAGE",
    messageId: "message-historical-1",
    amountCents: 1900,
    currency: "USD",
    purchasedAt: new Date("2026-08-01T10:00:00Z"),
    transactionStatus: "done",
    fan: { onlyFansUserId: "fan-of-1" },
    creator: { id: "creator-1", username: "creator", displayName: "Creator" },
  };
  const sent = {
    agencyId: "agency-1",
    creatorId: "creator-1",
    accountId: "creator-1",
    messageId: "message-historical-1",
    dialogId: "fan-of-1",
    fanId: "fan-of-1",
    memberId: "member-1",
    userId: "user-1",
    deviceId: "device-1",
    source: "manual",
    sentAt: new Date("2026-08-01T09:58:00Z"),
  };
  const db = {
    creatorSale: {
      async findMany(args) { query = args; return [{ id: sale.id }]; },
      async findUnique({ where }) { return where.id === sale.id ? { ...sale } : null; },
    },
    creatorTip: { async findMany() { return []; } },
    teamPpvPurchaseLedger: {
      async findUnique() { return purchase ? { ...purchase } : null; },
      async findMany() { return []; },
      async create({ data }) { purchase = { id: "team-purchase-1", ...data }; return { ...purchase }; },
      async update({ data }) { purchase = { ...purchase, ...data }; return { ...purchase }; },
    },
    teamTipLedger: {},
    creatorFinancialTransaction: { async findUnique() { return null; } },
    teamSentMessageLedger: { async findFirst() { return { ...sent }; } },
    agencyMember: { async findFirst() { return { id: "member-1", userId: "user-1" }; } },
    teamPpvResolveJob: { async upsert({ create }) { return { id: "job-1", ...create }; } },
  };
  return { db, getQuery: () => query, getPurchase: () => purchase };
}

test("historical sale backfill selects only unlinked MESSAGE facts and uses relation as durable progress", async () => {
  const fx = saleBackfillDb();
  const now = new Date("2026-08-12T00:00:00Z");
  const result = await reconcileHistoricalTeamMoneyBatch({ db: fx.db, agencyId: "agency-1", saleLimit: 25, tipLimit: 25, retentionDays: 180, now });
  assert.equal(result.ok, true);
  assert.equal(result.sales.selected, 1);
  assert.equal(result.sales.linked, 1);
  assert.equal(result.sales.failed, 0);
  assert.deepEqual(fx.getQuery().where, {
    agencyId: "agency-1",
    saleType: "MESSAGE",
    purchasedAt: { gte: new Date("2026-02-13T00:00:00.000Z") },
    teamPpvPurchase: { is: null },
  });
  assert.equal(fx.getQuery().take, 25);
  assert.equal(fx.getPurchase().creatorSaleId, "sale-historical-1");
  assert.equal(fx.getPurchase().attributedMemberId, "member-1");
});

function tipBackfillDb() {
  let query = null;
  let attribution = null;
  const tip = {
    id: "tip-historical-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanId: "fan-internal-1",
    eventFingerprint: "tip-historical-fp",
    externalNotificationId: "tip-notification-1",
    externalTransactionId: null,
    messageId: "tip-message-1",
    amountCents: 700,
    currency: "USD",
    tippedAt: new Date("2026-08-01T11:00:00Z"),
    transactionStatus: "done",
    fan: { onlyFansUserId: "fan-of-1" },
    creator: { id: "creator-1", username: "creator", displayName: "Creator" },
  };
  const sent = {
    agencyId: "agency-1",
    creatorId: "creator-1",
    accountId: "creator-1",
    messageId: "tip-message-1",
    dialogId: "fan-of-1",
    fanId: "fan-of-1",
    memberId: null,
    userId: null,
    source: "automation",
    sentAt: new Date("2026-08-01T10:59:00Z"),
  };
  const db = {
    creatorSale: { async findMany() { return []; } },
    creatorTip: {
      async findMany(args) { query = args; return [{ id: tip.id }]; },
      async findUnique({ where }) { return where.id === tip.id ? { ...tip } : null; },
    },
    teamPpvPurchaseLedger: {},
    teamTipLedger: {
      async findFirst() { return attribution ? { ...attribution } : null; },
      async create({ data }) { attribution = { id: "team-tip-1", history: [], ...data }; return { ...attribution }; },
      async update({ data }) { attribution = { ...attribution, ...data }; return { ...attribution }; },
    },
    teamSentMessageLedger: {
      async findFirst() { return { ...sent }; },
      async findMany() { return []; },
    },
    agencyMember: { async findFirst() { return null; } },
  };
  return { db, getQuery: () => query, getAttribution: () => attribution };
}

test("historical tip backfill attaches CreatorTip and exact non-human source stays creator revenue", async () => {
  const fx = tipBackfillDb();
  const now = new Date("2026-08-12T00:00:00Z");
  const result = await reconcileHistoricalTeamMoneyBatch({ db: fx.db, agencyId: "agency-1", saleLimit: 25, tipLimit: 40, retentionDays: 180, now });
  assert.equal(result.ok, true);
  assert.equal(result.tips.selected, 1);
  assert.equal(result.tips.linked, 1);
  assert.deepEqual(fx.getQuery().where, {
    agencyId: "agency-1",
    tippedAt: { gte: new Date("2026-02-13T00:00:00.000Z") },
    teamTipAttribution: { is: null },
  });
  assert.equal(fx.getQuery().take, 40);
  assert.equal(fx.getAttribution().creatorTipId, "tip-historical-1");
  assert.equal(fx.getAttribution().status, "creator_revenue");
  assert.equal(fx.getAttribution().attributedMemberId, null);
});

test("historical backfill skips cleanly before additive Team money models are available", async () => {
  const result = await reconcileHistoricalTeamMoneyBatch({ db: { creatorSale: {}, creatorTip: {} } });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});
