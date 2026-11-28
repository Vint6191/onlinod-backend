"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createRequire } = require("node:module");

async function run({ runtime, backendRoot, legacyBackendRoot }) {
  const load = createRequire(path.join(backendRoot, "package.json"));
  const legacy = createRequire(path.join(legacyBackendRoot, "package.json"));
  const { db } = runtime, checks = [];
  const check = async (name, work) => {
    const row = { name, ok: false }; checks.push(row);
    try { await work(row); row.ok = true; }
    catch (error) { row.error = { code: error.code, message: error.message, actual: error.actual, expected: error.expected }; }
  };
  const { runRootCommit } = load("./src/services/db-commit-kernel");
  const write = fn => runRootCommit(db, ({ tx }) => fn(tx));
  const scope = await legacy("./scripts/audit/analytics-traffic/fixture.cjs").scope(db,
    { agencyId: "usd215-db", creatorId: "usd215-db-creator", userId: "usd215-db-user" });
  const oldReceipts = await db.$queryRawUnsafe('SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name');
  const orderData = { agencyId: scope.agencyId, amountCents: 2500, billingPeriod: "MONTHLY", periodMonths: 1,
    billedCreators: 0, pricingSnapshot: {}, purpose: "WALLET_TOP_UP", status: "PAID", testMode: true };
  await write(async tx => {
    await tx.agencyBillingWallet.create({ data: { id: "usd215-legacy-wallet", agencyId: scope.agencyId, testMode: true,
      currency: "EUR", balanceCents: 1701n } });
    await tx.billingOrder.create({ data: { id: "usd215-legacy-order", ...orderData, currency: "EUR" } });
  });
  const before = await db.agencyBillingWallet.findUnique({ where: { id: "usd215-legacy-wallet" } });
  await check("delivered215 exposes retained foreign wallet as available money", async () => {
    const value = await legacy("./src/services/billing-wallet-service").getWalletState({ db, agencyId: scope.agencyId, testMode: true });
    assert.equal(value.wallet.currency, "EUR"); assert.equal(value.wallet.balanceCents, 1701);
  });
  const upgraded = await runtime.upgrade();
  await check("actual installer upgrades 47 to 48 and repeat preserves every previous migration receipt", async out => {
    assert.equal(oldReceipts.length, 47); assert.equal(upgraded.migrationCount, 48);
    assert.deepEqual(upgraded.receipts.slice(0, 47), oldReceipts); out.migrations = 48;
  });
  await check("migration preserves original historical amount and currency without relabeling", async () => {
    assert.deepEqual(await db.agencyBillingWallet.findUnique({ where: { id: before.id } }), before);
    const order = await db.billingOrder.findUnique({ where: { id: "usd215-legacy-order" } });
    assert.equal(order.currency, "EUR"); assert.equal(order.amountCents, 2500); assert.equal(order.activatedAt, null);
  });
  await check("native legacy wallet read and paid-order credit reject without balance or activation mutation", async () => {
    const wallet = load("./src/services/billing-wallet-service");
    await assert.rejects(wallet.getWalletState({ db, agencyId: scope.agencyId, testMode: true }), { code: "BILLING_CURRENCY_UNSUPPORTED" });
    await assert.rejects(wallet.creditPaidTopUp({ db, orderId: "usd215-legacy-order", sandboxActivationEnabled: true }), { code: "BILLING_CURRENCY_UNSUPPORTED" });
    assert.deepEqual(await db.agencyBillingWallet.findUnique({ where: { id: before.id } }), before);
    assert.equal(await db.billingWalletTransaction.count({ where: { agencyId: scope.agencyId } }), 0);
  });
  const blocked = error => /USD_CURRENCY_REQUIRED/.test(error.message);
  await check("native new foreign wallet and order inserts are rejected by SQL before persistence", async () => {
    await assert.rejects(write(tx => tx.agencyBillingWallet.create({ data: { id: "usd215-bad-wallet", agencyId: scope.agencyId,
      testMode: false, currency: "GBP", balanceCents: 900n } })), blocked);
    await assert.rejects(write(tx => tx.billingOrder.create({ data: { id: "usd215-bad-order", ...orderData, currency: "EUR" } })), blocked);
    assert.equal(await db.agencyBillingWallet.count({ where: { id: "usd215-bad-wallet" } }), 0);
    assert.equal(await db.billingOrder.count({ where: { id: "usd215-bad-order" } }), 0);
  });
  await check("native USD wallet and order persist exact cents and cannot switch to foreign currency", async () => {
    await write(async tx => {
      await tx.agencyBillingWallet.create({ data: { id: "usd215-good-wallet", agencyId: scope.agencyId, currency: "USD", balanceCents: 4101n } });
      await tx.billingOrder.create({ data: { id: "usd215-good-order", ...orderData, currency: "USD" } });
    });
    await assert.rejects(write(tx => tx.agencyBillingWallet.update({ where: { id: "usd215-good-wallet" }, data: { currency: "EUR" } })), blocked);
    const value = await load("./src/services/billing-wallet-service").getWalletState({ db, agencyId: scope.agencyId });
    assert.equal(value.wallet.currency, "USD"); assert.equal(value.wallet.balanceCents, 4101);
  });
  await check("native canonical money SQL rejects explicit foreign input and accepts USD", async () => {
    const add = currency => write(async tx => {
      await load("./src/services/creator-fact-write-authority").lockCreatorFacts(tx, scope.agencyId, scope.creatorId);
      return tx.creatorFinancialTransaction.create({ data: { id: "usd215-db-financial-" + currency, agencyId: scope.agencyId,
        creatorId: scope.creatorId, externalTransactionId: "usd215-db-tx-" + currency, transactionType: "tip",
        amountCents: 501, netCents: 401, occurredAt: new Date(), currency } });
    });
    await assert.rejects(add("EUR"), blocked); assert.equal((await add("USD")).amountCents, 501);
  });
  await check("native bare and nested financial evidence guards reject foreign even under a USD outer label", async () => {
    const add = (id, financialFact) => write(async tx => {
      await load("./src/services/earnings-generation-service").lock(tx, scope.creatorId);
      return tx.creatorEarningsLedgerEntry.create({ data: { agencyId: scope.agencyId, creatorId: scope.creatorId,
        transactionId: id, occurredAt: new Date(), category: "tips", grossCents: 501n, netCents: 401n,
        status: "done", observedAt: new Date(), financialFact } });
    });
    for (const [i, financialFact] of [{ currency: "EUR" }, { version: 1, value: { currency: "EUR" } },
      { currency: "USD", value: { currency: "GBP" } }, { value: { currency: null } }].entries()) {
      await assert.rejects(add("usd215-bad-evidence-" + i, financialFact), blocked);
    }
    assert.equal((await add("usd215-good-evidence", { version: 1, value: { currency: "USD" } })).netCents, 401n);
  });
  await check("catalog installs all 29 guards and 11 bounded unsupported-evidence indexes", async out => {
    const guards = await db.$queryRawUnsafe("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%_usd_guard' ORDER BY tgname");
    const indexes = await db.$queryRawUnsafe("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE '%_unsupported_usd_idx' ORDER BY indexname");
    assert.equal(guards.length, 29); assert.equal(indexes.length, 11); out.guards = 29; out.indexes = 11;
  });
  return { ok: checks.every(row => row.ok), engine: "native PostgreSQL, actual install-all and application services", checks };
}

module.exports = { run };
if (require.main === module) (async () => {
  const runtime = await require(process.env.NOD_USD_LEGACY_FIXTURE).createLegacyRuntime();
  try {
    const result = await run({ runtime, backendRoot: path.resolve(__dirname, "../.."), legacyBackendRoot: process.env.NOD_USD_LEGACY_BACKEND_ROOT });
    fs.writeFileSync(path.join(process.env.NOD_AUDIT_NATIVE_OUTPUT, "usd-database-result.json"), JSON.stringify(result, (_, v) => typeof v === "bigint" ? String(v) : v, 2));
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
