"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-money-reconciliation-service");
delete require.cache[prismaPath];
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
delete require.cache[servicePath];
const {
  classifySentSource,
  reconcileCreatorSaleToTeam,
  reconcileCreatorTipToTeam,
} = require(servicePath);

function dbFixture({ sent = null, existing = null, financialStatus = "done", memberActive = true } = {}) {
  const sale = {
    id: "sale-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanId: "fan-internal-1",
    eventFingerprint: "sale-fp-1",
    externalNotificationId: "notification-1",
    externalTransactionId: "transaction-1",
    saleType: "MESSAGE",
    messageId: "message-1",
    amountCents: 2500,
    currency: "USD",
    purchasedAt: new Date("2026-08-12T10:00:00Z"),
    transactionStatus: financialStatus,
    fan: { onlyFansUserId: "of-fan-1" },
    creator: { id: "creator-1", username: "vilgelmina", displayName: "Vilgelmina" },
  };
  const financial = {
    id: "financial-1",
    creatorId: "creator-1",
    externalTransactionId: "transaction-1",
    transactionStatus: financialStatus,
  };
  let purchase = existing ? { ...existing } : null;
  let resolveJob = null;

  const db = {
    creatorSale: {
      async findUnique({ where }) { return where.id === sale.id ? { ...sale } : null; },
    },
    creatorFinancialTransaction: {
      async findUnique() { return { ...financial }; },
    },
    teamSentMessageLedger: {
      async findFirst({ where }) {
        if (!sent) return null;
        if (where.messageId !== sent.messageId) return null;
        if (where.creatorId && where.creatorId !== sent.creatorId) return null;
        if (where.accountId && where.accountId !== sent.accountId) return null;
        return { ...sent };
      },
    },
    agencyMember: {
      async findFirst({ where }) {
        if (!memberActive || !sent?.memberId || where.id !== sent.memberId) return null;
        return { id: sent.memberId, userId: sent.userId || "user-1" };
      },
    },
    teamPpvPurchaseLedger: {
      async findUnique({ where }) {
        if (!purchase) return null;
        if (where.creatorSaleId) return purchase.creatorSaleId === where.creatorSaleId ? { ...purchase } : null;
        if (where.agencyId_purchaseId) {
          const key = where.agencyId_purchaseId;
          return purchase.agencyId === key.agencyId && purchase.purchaseId === key.purchaseId ? { ...purchase } : null;
        }
        return null;
      },
      async findMany() { return []; },
      async create({ data }) {
        purchase = { id: "team-purchase-1", createdAt: new Date(), ...data };
        return { ...purchase };
      },
      async update({ where, data }) {
        assert.equal(where.id, purchase.id);
        purchase = { ...purchase, ...data };
        return { ...purchase };
      },
    },
    teamPpvResolveJob: {
      async upsert({ create, update }) {
        resolveJob = resolveJob ? { ...resolveJob, ...update } : { id: "job-1", ...create };
        return { ...resolveJob };
      },
      async updateMany({ data }) {
        if (resolveJob) resolveJob = { ...resolveJob, ...data };
        return { count: resolveJob ? 1 : 0 };
      },
    },
  };

  return {
    db,
    getPurchase: () => purchase,
    getResolveJob: () => resolveJob,
  };
}

function manualSent(memberId = "member-1") {
  return {
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    memberId,
    userId: "user-1",
    deviceId: "device-1",
    dialogId: "of-fan-1",
    fanId: "of-fan-1",
    messageId: "message-1",
    sentAt: new Date("2026-08-12T09:58:00Z"),
    source: "manual",
  };
}

test("source classification never treats automation/broadcast as human manual", () => {
  assert.equal(classifySentSource({ source: "manual" }), "MANUAL");
  assert.equal(classifySentSource({ source: "manual_chat" }), "MANUAL");
  assert.equal(classifySentSource({ source: "automation" }), "NON_HUMAN");
  assert.equal(classifySentSource({ source: "broadcast" }), "NON_HUMAN");
  assert.equal(classifySentSource({ source: "mystery" }), "UNKNOWN");
});

test("exact CreatorSale.messageId + confirmed manual provenance attributes PPV to active member", async () => {
  const fx = dbFixture({ sent: manualSent() });
  const result = await reconcileCreatorSaleToTeam({ db: fx.db, saleId: "sale-1" });
  assert.equal(result.ok, true);
  assert.equal(result.proposedStatus, "attributed");
  assert.equal(result.attributionBasis, "EXACT_MESSAGE_MANUAL");
  const row = fx.getPurchase();
  assert.equal(row.attributedMemberId, "member-1");
  assert.equal(row.creatorSaleId, "sale-1");
  assert.equal(row.financialTransactionId, "financial-1");
  assert.equal(row.financialStatus, "done");
  assert.equal(row.fanId, "of-fan-1");
  assert.equal(fx.getResolveJob().status, "resolved");
});

test("exact automation provenance is creator revenue and cannot inherit logged-in member", async () => {
  const automation = { ...manualSent(), memberId: null, userId: null, source: "automation" };
  const fx = dbFixture({ sent: automation });
  const result = await reconcileCreatorSaleToTeam({ db: fx.db, saleId: "sale-1" });
  assert.equal(result.proposedStatus, "creator_revenue");
  const row = fx.getPurchase();
  assert.equal(row.status, "creator_revenue");
  assert.equal(row.attributedMemberId, null);
  assert.equal(row.attributionBasis, "EXACT_MESSAGE_NON_HUMAN");
});

test("missing exact message provenance remains unresolved instead of using last-chatter timing", async () => {
  const fx = dbFixture({ sent: null });
  const result = await reconcileCreatorSaleToTeam({ db: fx.db, saleId: "sale-1" });
  assert.equal(result.proposedStatus, "unresolved");
  assert.equal(result.attributionBasis, "MESSAGE_PROVENANCE_MISSING");
  assert.equal(fx.getPurchase().attributedMemberId, null);
  assert.equal(fx.getResolveJob().status, "pending");
});

test("exact provenance disagreement becomes an explicit conflict instead of silently stealing attribution", async () => {
  const existing = {
    id: "old-purchase",
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    purchaseId: "notification-1",
    messageId: "message-1",
    amountCents: 2500,
    purchasedAt: new Date("2026-08-12T10:00:00Z"),
    status: "attributed",
    attributedMemberId: "member-old",
    attributedUserId: "user-old",
    resolvedSource: "legacy_auto_resolver",
    creatorSaleId: null,
  };
  const fx = dbFixture({ sent: manualSent("member-new"), existing });
  const result = await reconcileCreatorSaleToTeam({ db: fx.db, saleId: "sale-1" });
  assert.equal(result.proposedStatus, "conflict");
  assert.equal(fx.getPurchase().status, "conflict");
  assert.equal(fx.getPurchase().attributedMemberId, "member-old");
  assert.equal(fx.getResolveJob().status, "conflict");
  assert.deepEqual(
    fx.getResolveJob().result.candidates.map((row) => row.memberId).sort(),
    ["member-new", "member-old"],
  );
});

test("manual Claims resolution is never overwritten by later automatic reconciliation", async () => {
  const existing = {
    id: "old-purchase",
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    purchaseId: "notification-1",
    messageId: "message-1",
    amountCents: 2500,
    purchasedAt: new Date("2026-08-12T10:00:00Z"),
    status: "attributed",
    attributedMemberId: "manager-selected-member",
    resolvedSource: "manual_claim_resolution",
    creatorSaleId: null,
  };
  const fx = dbFixture({ sent: manualSent("different-member"), existing });
  const result = await reconcileCreatorSaleToTeam({ db: fx.db, saleId: "sale-1" });
  assert.equal(result.preservedManualResolution, true);
  assert.equal(fx.getPurchase().attributedMemberId, "manager-selected-member");
  assert.equal(fx.getPurchase().resolvedSource, "manual_claim_resolution");
});

test("payout undo keeps attribution evidence but financially disables the purchase", async () => {
  const fx = dbFixture({ sent: manualSent(), financialStatus: "undo" });
  const result = await reconcileCreatorSaleToTeam({ db: fx.db, saleId: "sale-1" });
  assert.equal(result.financialRefunded, true);
  assert.equal(fx.getPurchase().financialStatus, "undo");
  assert.equal(fx.getPurchase().attributedMemberId, "member-1");
  // No pending resolver job is created for reversed money.
  assert.equal(fx.getResolveJob(), null);
});


function tipDbFixture({ exactSent = null, recent = [], financialStatus = "done", existing = null } = {}) {
  const tip = {
    id: "creator-tip-1",
    agencyId: "agency-1",
    creatorId: "creator-1",
    fanId: "fan-internal-1",
    eventFingerprint: "tip-fingerprint-1",
    externalNotificationId: "tip-notification-1",
    externalTransactionId: "tip-transaction-1",
    messageId: exactSent ? "tip-message-1" : null,
    amountCents: 1000,
    currency: "USD",
    tippedAt: new Date("2026-08-12T11:00:00Z"),
    transactionStatus: financialStatus,
    fan: { onlyFansUserId: "of-fan-1" },
    creator: { id: "creator-1", username: "vilgelmina", displayName: "Vilgelmina" },
  };
  let attribution = existing ? { ...existing } : null;
  const db = {
    creatorTip: { async findUnique() { return { ...tip }; } },
    teamSentMessageLedger: {
      async findFirst({ where }) {
        if (!exactSent || where.messageId !== exactSent.messageId) return null;
        if (where.creatorId && where.creatorId !== exactSent.creatorId) return null;
        return { ...exactSent };
      },
      async findMany() { return recent.map((row) => ({ ...row })); },
    },
    agencyMember: {
      async findFirst({ where }) {
        const candidate = [exactSent, ...recent].find((row) => row?.memberId === where.id);
        return candidate ? { id: candidate.memberId, userId: candidate.userId || `user-${candidate.memberId}` } : null;
      },
    },
    teamTipLedger: {
      async findFirst() { return attribution ? { ...attribution } : null; },
      async create({ data }) { attribution = { id: "team-tip-1", createdAt: new Date(), ...data }; return { ...attribution }; },
      async update({ data }) { attribution = { ...attribution, ...data }; return { ...attribution }; },
    },
  };
  return { db, getAttribution: () => attribution };
}

function tipSent({ memberId = "member-1", source = "manual", minutesBefore = 2 } = {}) {
  return {
    agencyId: "agency-1", accountId: "creator-1", creatorId: "creator-1",
    memberId, userId: `user-${memberId}`, deviceId: "device-1",
    dialogId: "of-fan-1", fanId: "of-fan-1", messageId: "tip-message-1",
    sentAt: new Date(Date.parse("2026-08-12T11:00:00Z") - minutesBefore * 60_000), source,
  };
}

test("tip exact message provenance auto-attributes only the proven manual sender", async () => {
  const fx = tipDbFixture({ exactSent: tipSent() });
  const result = await reconcileCreatorTipToTeam({ db: fx.db, tipId: "creator-tip-1" });
  assert.equal(result.proposedStatus, "attributed");
  assert.equal(result.attributionBasis, "EXACT_MESSAGE_MANUAL");
  assert.equal(fx.getAttribution().attributedMemberId, "member-1");
  assert.equal(fx.getAttribution().creatorTipId, "creator-tip-1");
});

test("tip exact automation message stays creator revenue", async () => {
  const fx = tipDbFixture({ exactSent: { ...tipSent({ source: "automation" }), memberId: null, userId: null } });
  const result = await reconcileCreatorTipToTeam({ db: fx.db, tipId: "creator-tip-1" });
  assert.equal(result.proposedStatus, "creator_revenue");
  assert.equal(fx.getAttribution().attributedMemberId, null);
  assert.equal(result.attributionBasis, "EXACT_MESSAGE_NON_HUMAN");
});

test("one recent chatter is evidence only and does not auto-own a tip", async () => {
  const recent = [{ ...tipSent({ memberId: "member-recent", minutesBefore: 5 }), messageId: "other-message" }];
  const fx = tipDbFixture({ recent });
  const result = await reconcileCreatorTipToTeam({ db: fx.db, tipId: "creator-tip-1" });
  assert.equal(result.proposedStatus, "unresolved");
  assert.equal(result.attributionBasis, "SINGLE_RECENT_CANDIDATE_EVIDENCE_ONLY");
  assert.equal(fx.getAttribution().attributedMemberId, null);
  assert.deepEqual(fx.getAttribution().candidates.map((row) => row.memberId), ["member-recent"]);
});

test("multiple recent tip candidates create conflict but no guessed owner", async () => {
  const recent = [
    { ...tipSent({ memberId: "member-a", minutesBefore: 4 }), messageId: "a" },
    { ...tipSent({ memberId: "member-b", minutesBefore: 7 }), messageId: "b" },
  ];
  const fx = tipDbFixture({ recent });
  const result = await reconcileCreatorTipToTeam({ db: fx.db, tipId: "creator-tip-1" });
  assert.equal(result.proposedStatus, "conflict");
  assert.equal(fx.getAttribution().attributedMemberId, null);
  assert.equal(fx.getAttribution().candidates.length, 2);
});

test("tip payout undo is retained as evidence but marked financially reversed", async () => {
  const fx = tipDbFixture({ exactSent: tipSent(), financialStatus: "undo" });
  const result = await reconcileCreatorTipToTeam({ db: fx.db, tipId: "creator-tip-1" });
  assert.equal(result.financialRefunded, true);
  assert.equal(fx.getAttribution().financialStatus, "undo");
  assert.equal(fx.getAttribution().attributedMemberId, "member-1");
});
