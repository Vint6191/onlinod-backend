"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const load = createRequire(path.join(process.env.NOD_USD_BILLING_BACKEND_ROOT || path.resolve(__dirname, "../.."), "package.json"));
const wallet = load("./src/services/billing-wallet-service");
const payments = load("./src/services/billing-nowpayments-service");
const { valuePayment } = load("./src/services/billing-payment-value-service");

const unsupported = error => error.code === "BILLING_CURRENCY_UNSUPPORTED" && error.status === 409;

test("USD billing reads preserve exact cents and the USD contract", () => {
  assert.deepEqual(wallet.publicWallet({ id: "w", currency: "USD", balanceCents: 1701n, testMode: true }),
    { id: "w", currency: "USD", balanceCents: 1701, testMode: true, updatedAt: null });
  const row = payments.publicOrder({ id: "o", currency: "USD", amountCents: 2500, status: "PAID" });
  assert.equal(row.currency, "USD"); assert.equal(row.amountCents, 2500);
});

test("historical unsupported wallet and transaction money is unavailable instead of relabeled", () => {
  assert.throws(() => wallet.publicWallet({ id: "w", currency: "EUR", balanceCents: 1701n }), unsupported);
  assert.throws(() => wallet.publicWalletTransaction({ id: "t", currency: "GBP", amountCents: 2500n, balanceAfterCents: 2500n }), unsupported);
  assert.throws(() => payments.publicOrder({ id: "o", currency: "EUR", amountCents: 2500 }), unsupported);
});

test("a matching foreign provider quote cannot authorize a foreign legacy NOD order", () => {
  assert.throws(() => payments.validateProviderPaymentForOrder(
    { id: "o", currency: "EUR", amountCents: 2500, providerInvoiceId: "invoice" },
    { payment_id: "payment", invoice_id: "invoice", price_currency: "eur", price_amount: "25.00" },
    { requirePrice: true }), unsupported);
  assert.deepEqual(payments.validateProviderPaymentForOrder(
    { id: "o", currency: "USD", amountCents: 2500, providerInvoiceId: "invoice" },
    { payment_id: "payment", invoice_id: "invoice", price_currency: "usd", price_amount: "25.00" },
    { requirePrice: true }), { ok: true });
});

test("wallet API does not expose unsupported legacy balances or fabricate USD zero", async () => {
  await assert.rejects(wallet.getWalletState({ agencyId: "a", db: {
    agencyBillingWallet: { findUnique: async () => ({ id: "w", currency: "EUR", balanceCents: 9000n }) },
    billingWalletTransaction: { findMany: async () => [] },
  } }), unsupported);
  const empty = await wallet.getWalletState({ agencyId: "a", db: {
    agencyBillingWallet: { findUnique: async () => null }, billingWalletTransaction: { findMany: async () => [] },
  } });
  assert.equal(empty.wallet.currency, "USD"); assert.equal(empty.wallet.balanceCents, 0);
});

test("provider settlement asset remains evidence for a USD quote, never another NOD accounting currency", () => {
  const quote = { price_currency: "usd", price_amount: "25.00", pay_currency: "btc", pay_amount: "0.001", actually_paid: "0.001" };
  const paid = valuePayment({ currency: "USD" }, quote);
  assert.equal(paid.ok, true); assert.equal(paid.amountCents, 2500n); assert.equal(paid.evidence.currency, "USD");
  assert.equal(valuePayment({ currency: "EUR" }, { ...quote, price_currency: "eur" }).reason, "SETTLEMENT_CURRENCY_UNSUPPORTED");
});

function recoveryFixture({ marker = false, counts = [] } = {}) {
  const now = new Date("2026-11-27T12:00:00.000Z"), writes = [];
  const params = { billingRecoveryVersion: 1, financialReceiptVersion: 1, financialTraversalVersion: 2,
    collectionContractVersion: 1, collectionType: "FINANCIAL", collectionMode: "catchup", collectionGeneration: "recovery",
    collectionRequestedAt: now.toISOString(), analyticsContractVersion: 1, sourceTimezone: "UTC",
    scanFrom: "2026-10-28", scanTo: "2026-11-26", startDate: "2026-10-28T00:00:00.000Z", endDate: "2026-11-26T23:59:59.000Z" };
  params.financialWindowGeneration = params.collectionGeneration;
  params.financialWindows = load("./src/services/financial-receipt-authority").planWindows(params, null);
  return { writes, now, job: { id: "j", agencyId: "a", creatorId: "c", jobKey: "financial_transactions_scan", params, startedAt: now },
    receipt: { complete: true, row: { id: "r", jobId: "j", agencyId: "a", creatorId: "c", generation: "recovery",
      windows: params.financialWindows, proof: { semanticsVersion: 3, ...(marker ? { currencyContract: "USD_ONLY_V1" } : {}),
        windows: [{ exhausted: true, matched: true, rejected: 0, count: 1, grossCents: 2500, netCents: 1701 }] } } },
    db: { $queryRawUnsafe: async () => counts, $executeRawUnsafe: async (sql, ...args) => {
      if (sql.includes('INSERT INTO "CreatorBillingRecoverySnapshot"')) writes.push(args); return 1;
    } } };
}

test("billing recovery cannot publish old foreign or compacted unproven money", async () => {
  const recovery = load("./src/services/billing-financial-recovery-service");
  for (const [counts, code] of [[[{ windowIndex: 0, retained: 1n, unsupported: 1n }], "UNSUPPORTED_CURRENCY"], [[], "CURRENCY_EVIDENCE_UNAVAILABLE"]]) {
    const input = recoveryFixture({ counts });
    await assert.rejects(recovery.publish(input), { code }); assert.equal(input.writes.length, 0);
  }
});

test("billing recovery certifies a new USD run or complete retained USD evidence with exact net cents", async () => {
  const recovery = load("./src/services/billing-financial-recovery-service");
  for (const options of [{ marker: true }, { counts: [{ windowIndex: 0, retained: 1n, unsupported: 0n }] }]) {
    const input = recoveryFixture(options); assert.equal((await recovery.publish(input)).published, true);
    assert.equal(input.writes.length, 1); assert.equal(input.writes[0][4], 1701);
    assert.equal(JSON.parse(input.writes[0].at(-1)).currencyContract, "USD_ONLY_V1");
  }
});
