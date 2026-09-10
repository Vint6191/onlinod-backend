"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEBT,
  PROVIDER_OPERATIONAL_BACKFILL_GENERATION,
  PROVIDER_OPERATIONAL_BACKFILL_LANE_KEY,
  reconcileProviderOperationalDebtForOrder,
  providerOperationalBackfillReady,
  requireProviderOperationalBackfillReady,
} = require("./provider-operational-debt-authority-service");

function clone(value) { return value == null ? value : structuredClone(value); }
function matches(row, where = {}) {
  for (const [key, expected] of Object.entries(where || {})) {
    const actual = row[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if (Array.isArray(expected.in) && !expected.in.map(String).includes(String(actual))) return false;
      continue;
    }
    if (expected === null ? actual !== null : String(actual) !== String(expected)) return false;
  }
  return true;
}

function fixture() {
  const now = new Date("2026-09-09T20:30:00.000Z");
  const orders = [{
    id: "order-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", status: "PENDING",
    telegramTaskMessageId: null, telegramReferenceMessageIds: [], deliveredAt: null, lastReminderAt: null,
    telegramCancellationWaivedAt: null, providerOperationalDirty: true,
  }];
  const intents = [];
  const submissions = [];
  const debts = [];
  let coverage = null;
  const tx = {
    async $queryRawUnsafe() { return []; },
    customOrder: {
      async findFirst({ where }) { return clone(orders.find((row) => matches(row, where)) || null); },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of orders) if (matches(row, where)) { Object.assign(row, clone(data)); count += 1; }
        return { count };
      },
    },
    telegramDeliveryIntent: {
      async findMany({ where }) { return intents.filter((row) => matches(row, where)).map(clone); },
      async findFirst({ where }) { return clone(intents.find((row) => matches(row, where)) || null); },
    },
    customContentSubmission: {
      async findMany({ where }) { return submissions.filter((row) => matches(row, where)).map(clone); },
    },
    providerOperationalDebt: {
      async deleteMany({ where }) {
        let removed = 0;
        for (let i = debts.length - 1; i >= 0; i -= 1) if (matches(debts[i], where)) { debts.splice(i, 1); removed += 1; }
        return { count: removed };
      },
      async createMany({ data }) { debts.push(...data.map(clone)); return { count: data.length }; },
      async findMany({ where }) { return debts.filter((row) => matches(row, where)).map(clone); },
    },
    phase2WorkCoverage: {
      async findUnique({ where }) {
        const k = where.agencyId_family_generation;
        return k && String(k.agencyId) === "agency-1" ? clone(coverage) : null;
      },
    },
  };
  const db = { ...tx, async $transaction(work) { return work(tx); } };
  return { db, now, orders, intents, submissions, debts, completeBackfill() { coverage = { agencyId: "agency-1", family: "PROVIDER_OPERATIONAL", generation: "phase2_provider_operational_coverage_v1", active: true, enumerationState: "COMPLETE", completedAt: now }; } };
}

function confirmedIntent(overrides = {}) {
  const at = new Date("2026-09-09T20:00:00.000Z");
  return {
    id: "intent-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", customSubmissionId: null,
    accountId: "tg-1", kind: "TASK", state: "CONFIRMED", commitStartedAt: at, remoteMessageId: 501,
    remoteRecipientTelegramUserId: "1001", remoteSentAt: at, confirmedAt: at, projectionBlockedAt: null,
    providerBindingRetryAt: null, outcomeReason: null, createdAt: at, updatedAt: at,
    ...overrides,
  };
}

test("exact order projection creates only current provider debt and marks the order clean", async () => {
  const fx = fixture();
  fx.intents.push(confirmedIntent());
  fx.submissions.push({
    id: "submission-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    telegramSourceAccountId: "tg-2", telegramSourceUserId: "2002", telegramMessageIds: [1, 2], ofMediaIds: [11],
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW", receivedAt: fx.now, createdAt: fx.now,
  });

  const result = await reconcileProviderOperationalDebtForOrder({ agencyId: "agency-1", orderId: "order-1", db: fx.db, now: fx.now });
  assert.equal(result.ok, true);
  assert.equal(fx.orders[0].providerOperationalDirty, false);
  assert.equal(fx.debts.some((row) => row.debtClass === DEBT.CONFIRMED_PROJECTION_DEBT && row.accountId === "tg-1"), true);
  assert.equal(fx.debts.some((row) => row.debtClass === DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY && row.accountId === "tg-1"), true);
  assert.equal(fx.debts.some((row) => row.debtClass === DEBT.INCOMPLETE_SOURCE_RELAY && row.accountId === "tg-2"), true);
});

test("A2: order reprojection cannot delete external projection work owned by another projector", async () => {
  const fx = fixture();
  fx.debts.push({
    id: "pod_external_delivery-1", agencyId: "agency-1", accountId: "tg-external",
    debtClass: DEBT.CUSTOM_EXTERNAL_PROJECTION_DEBT, objectType: "AutomationDelivery", objectId: "delivery-1",
    customOrderId: "order-1", creatorId: "creator-1", reasonCode: "CUSTOM_EXTERNAL_PROJECTION_DEBT", createdAt: fx.now, updatedAt: fx.now,
  });
  fx.intents.push(confirmedIntent());

  await reconcileProviderOperationalDebtForOrder({ agencyId: "agency-1", orderId: "order-1", db: fx.db, now: fx.now });

  assert.equal(fx.debts.some((row) => row.id === "pod_external_delivery-1" && row.debtClass === DEBT.CUSTOM_EXTERNAL_PROJECTION_DEBT), true);
  assert.equal(fx.debts.some((row) => row.debtClass === DEBT.CURRENT_PROVIDER_THREAD_CAPABILITY), true);
});

test("reprojection clears stale debt when canonical provider debt is gone", async () => {
  const fx = fixture();
  fx.intents.push(confirmedIntent({ projectionBlockedAt: fx.now }));
  await reconcileProviderOperationalDebtForOrder({ agencyId: "agency-1", orderId: "order-1", db: fx.db, now: fx.now });
  assert.equal(fx.debts.some((row) => row.debtClass === DEBT.CONFIRMED_PROJECTION_DEBT), true);

  fx.orders[0].status = "COMPLETED";
  fx.orders[0].telegramTaskMessageId = 501;
  fx.orders[0].deliveredAt = fx.now;
  fx.intents[0].projectionBlockedAt = null;
  await reconcileProviderOperationalDebtForOrder({ agencyId: "agency-1", orderId: "order-1", db: fx.db, now: new Date(fx.now.getTime() + 1000) });
  assert.equal(fx.debts.length, 0);
});

test("provider operational authority fails closed until one-time current-debt backfill is complete", async () => {
  const fx = fixture();
  assert.equal(await providerOperationalBackfillReady({ db: fx.db, agencyId: "agency-1" }), false);
  await assert.rejects(() => requireProviderOperationalBackfillReady({ db: fx.db, agencyId: "agency-1" }), (error) => error?.code === "PROVIDER_OPERATIONAL_DEBT_BACKFILL_INCOMPLETE" && error?.status === 503);
  fx.completeBackfill();
  assert.equal(await providerOperationalBackfillReady({ db: fx.db, agencyId: "agency-1" }), true);
  assert.equal(await requireProviderOperationalBackfillReady({ db: fx.db, agencyId: "agency-1" }), true);
});
