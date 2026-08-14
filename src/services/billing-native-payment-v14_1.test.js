"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const servicePath = path.join(__dirname, "billing-nowpayments-service.js");
const routeSource = fs.readFileSync(path.join(root, "src", "routes", "billing.js"), "utf8");
const schemaSource = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const migrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260814163000_billing_native_nowpayments_v14_1", "migration.sql"), "utf8");

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key]; else process.env[key] = String(value);
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

function loadService(prismaMock = {}) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prismaMock;
    if (request === "./audit-service") return { audit: async () => null };
    if (request === "./billing-entitlement-service") return { activatePaidOrderEntitlements: async () => null, refundOrderEntitlements: async () => null };
    if (request === "./billing-wallet-service") return { creditPaidTopUp: async () => null, refundTopUp: async () => null };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(servicePath)];
    return require(servicePath);
  } finally {
    Module._load = original;
  }
}

function baseEnv(extra = {}) {
  return {
    NOWPAYMENTS_MODE: "sandbox",
    NOWPAYMENTS_API_KEY: "test-key",
    NOWPAYMENTS_IPN_SECRET: "test-secret",
    PUBLIC_BASE_URL: "https://api.example.com",
    NOWPAYMENTS_SANDBOX_ACTIVATE: "true",
    ...extra,
  };
}

function makeDb() {
  let order = null;
  let attempt = null;
  const db = {
    $transaction: async (fn) => fn(db),
    agency: { findUnique: async () => ({ id: "agency-1", name: "Agency", plan: "PRO" }) },
    agencySubscription: { findFirst: async () => ({ billingMode: "MANUAL" }) },
    billingOrder: {
      findUnique: async ({ where }) => {
        if (!order) return null;
        if (where?.id) return where.id === order.id ? { ...order } : null;
        const compound = where?.agencyId_provider_testMode_checkoutKey;
        return compound && compound.checkoutKey === order.checkoutKey ? { ...order } : null;
      },
      create: async ({ data }) => {
        order = { id: "order-native-1", providerInvoiceId: null, providerInvoiceUrl: null, providerStatus: null, paidAt: null, activatedAt: null, expiresAt: null, createdAt: new Date(), updatedAt: new Date(), lines: [], ...data };
        return { ...order };
      },
      update: async ({ where, data }) => {
        assert.equal(where.id, order.id);
        order = { ...order, ...data, updatedAt: new Date() };
        return { ...order };
      },
      findMany: async () => order ? [{ ...order, lines: [], paymentAttempts: attempt ? [{ ...attempt }] : [] }] : [],
    },
    billingPaymentAttempt: {
      findFirst: async ({ where }) => attempt && where.orderId === attempt.orderId ? { ...attempt } : null,
      upsert: async ({ create, update }) => {
        attempt = attempt ? { ...attempt, ...update, updatedAt: new Date() } : { id: "attempt-1", createdAt: new Date(), updatedAt: new Date(), ...create };
        return { ...attempt };
      },
    },
    _getOrder: () => order,
    _getAttempt: () => attempt,
  };
  return db;
}

test("V14.1 route makes native payment the primary wallet top-up and exposes provider currencies", () => {
  assert.match(routeSource, /createWalletTopUpPayment/);
  assert.match(routeSource, /wallet\/top-up\/currencies/);
  assert.match(routeSource, /payCurrency:\s*req\.body\?\.payCurrency/);
  assert.match(routeSource, /flow:\s*req\.body\?\.flow/);
  const topupBlock = routeSource.slice(routeSource.indexOf('router.post("/wallet/top-up"'), routeSource.indexOf('router.patch("/creators/'));
  assert.doesNotMatch(topupBlock, /createWalletTopUpCheckout/);
});

test("V14.1 schema persists native payment address and purchase id additively", () => {
  assert.match(schemaSource, /model BillingPaymentAttempt\s*\{[\s\S]*payAddress\s+String\?[\s\S]*payinExtraId\s+String\?[\s\S]*purchaseId\s+String\?/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "payAddress" TEXT/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "payinExtraId" TEXT/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "purchaseId" TEXT/);
  assert.doesNotMatch(migrationSource, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});

test("old desktop cannot accidentally create an invisible native payment", async () => withEnv(baseEnv(), async () => {
  const db = makeDb();
  const service = loadService(db);
  let calls = 0;
  const oldFetch = global.fetch;
  global.fetch = async () => { calls += 1; throw new Error("provider must not be called"); };
  try {
    await assert.rejects(
      service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_key_123456", amountCents: 6000, payCurrency: "btc", db }),
      (err) => err.code === "BILLING_NATIVE_PAYMENT_CLIENT_REQUIRED" && err.status === 426,
    );
    assert.equal(calls, 0);
    assert.equal(db._getOrder(), null);
  } finally { global.fetch = oldFetch; }
}));

test("native top-up uses GET currencies + POST payment, persists address, and never creates a hosted invoice", async () => withEnv(baseEnv(), async () => {
  const db = makeDb();
  const service = loadService(db);
  const requests = [];
  const oldFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/currencies")) return { ok: true, status: 200, text: async () => JSON.stringify({ currencies: ["eth", "btc", "usdttrc20"] }) };
    if (String(url).endsWith("/payment")) return { ok: true, status: 201, text: async () => JSON.stringify({
      payment_id: 5077125051,
      payment_status: "waiting",
      pay_address: "TXyzNativeAddress",
      payin_extra_id: "memo-42",
      price_amount: 61.37,
      price_currency: "usd",
      pay_amount: 61.991234,
      pay_currency: "usdttrc20",
      purchase_id: "purchase-native-1",
      actually_paid: 0,
      order_id: "order-native-1",
    }) };
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_key_123456", amountCents: 6137, payCurrency: "usdttrc20", flow: "native", db });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, "https://api-sandbox.nowpayments.io/v1/currencies");
    assert.equal(requests[1].url, "https://api-sandbox.nowpayments.io/v1/payment");
    assert.equal(requests[1].method, "POST");
    assert.deepEqual(requests[1].body, {
      price_amount: 61.37,
      price_currency: "usd",
      pay_currency: "usdttrc20",
      order_id: "order-native-1",
      order_description: "ONLINOD balance top-up · $61.37",
      ipn_callback_url: "https://api.example.com/api/billing/nowpayments/ipn",
      is_fee_paid_by_user: false,
    });
    assert.equal(requests.some((r) => r.url.endsWith("/invoice")), false);
    assert.equal(result.order.status, "PROCESSING");
    assert.equal(result.order.providerInvoiceUrl, null);
    assert.equal(result.payment.providerPaymentId, "5077125051");
    assert.equal(result.payment.payAddress, "TXyzNativeAddress");
    assert.equal(result.payment.payinExtraId, "memo-42");
    assert.equal(result.payment.payAmount, "61.991234");
    assert.equal(result.payment.payCurrency, "usdttrc20");
    assert.equal(result.payment.purchaseId, "purchase-native-1");
    assert.equal(db._getAttempt().payAddress, "TXyzNativeAddress");
    assert.equal(db._getAttempt().payinExtraId, "memo-42");
    assert.equal(db._getAttempt().purchaseId, "purchase-native-1");
  } finally { global.fetch = oldFetch; }
}));

test("same idempotency key replays the same native payment without another POST payment call", async () => withEnv(baseEnv(), async () => {
  const db = makeDb();
  const service = loadService(db);
  let paymentCalls = 0;
  const oldFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/currencies")) return { ok: true, status: 200, text: async () => JSON.stringify({ currencies: ["btc"] }) };
    if (String(url).endsWith("/payment")) {
      paymentCalls += 1;
      return { ok: true, status: 201, text: async () => JSON.stringify({ payment_id: "payment-1", payment_status: "waiting", pay_address: "bc1address", price_amount: 60, price_currency: "usd", pay_amount: 0.0008, pay_currency: "btc", order_id: "order-native-1" }) };
    }
    throw new Error(`unexpected ${url} ${options.method || "GET"}`);
  };
  try {
    const args = { agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_key_replay_123", amountCents: 6000, payCurrency: "btc", flow: "native", db };
    const first = await service.createWalletTopUpPayment(args);
    const second = await service.createWalletTopUpPayment(args);
    assert.equal(first.payment.providerPaymentId, "payment-1");
    assert.equal(second.replayed, true);
    assert.equal(second.payment.providerPaymentId, "payment-1");
    assert.equal(paymentCalls, 1);
  } finally { global.fetch = oldFetch; }
}));

test("changing pay currency is part of the idempotency binding", async () => withEnv(baseEnv(), async () => {
  const db = makeDb();
  const service = loadService(db);
  const oldFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/currencies")) return { ok: true, status: 200, text: async () => JSON.stringify({ currencies: ["btc", "eth"] }) };
    if (String(url).endsWith("/payment")) return { ok: true, status: 201, text: async () => JSON.stringify({ payment_id: "payment-1", payment_status: "waiting", pay_address: "bc1address", price_amount: 60, price_currency: "usd", pay_amount: 0.0008, pay_currency: "btc", order_id: "order-native-1" }) };
    throw new Error("unexpected");
  };
  try {
    const checkoutKey = "native_payment_currency_binding_123";
    await service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey, amountCents: 6000, payCurrency: "btc", flow: "native", db });
    await assert.rejects(
      service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey, amountCents: 6000, payCurrency: "eth", flow: "native", db }),
      (err) => err.code === "BILLING_CHECKOUT_SELECTION_MISMATCH",
    );
  } finally { global.fetch = oldFetch; }
}));

test("provider cannot switch the requested crypto currency in the create-payment response", async () => withEnv(baseEnv(), async () => {
  const db = makeDb();
  const service = loadService(db);
  const oldFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith("/currencies")) return { ok: true, status: 200, text: async () => JSON.stringify({ currencies: ["btc", "eth"] }) };
    if (String(url).endsWith("/payment")) return { ok: true, status: 201, text: async () => JSON.stringify({ payment_id: "payment-remote", payment_status: "waiting", pay_address: "eth-address", price_amount: 60, price_currency: "usd", pay_amount: 1, pay_currency: "eth", order_id: "order-native-1" }) };
    throw new Error("unexpected");
  };
  try {
    await assert.rejects(
      service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_currency_mismatch", amountCents: 6000, payCurrency: "btc", flow: "native", db }),
      (err) => err.code === "NOWPAYMENTS_PAYMENT_CURRENCY_MISMATCH",
    );
    // Remote payment_id exists, so fail closed: do not mark FAILED and allow an automatic duplicate retry.
    assert.equal(db._getOrder().status, "CREATED");
  } finally { global.fetch = oldFetch; }
}));

test("recent orders expose persisted native payment details for resume-after-restart UI", async () => {
  const db = makeDb();
  // Seed through the public method with a small local provider stub.
  const service = loadService(db);
  await withEnv(baseEnv(), async () => {
    const oldFetch = global.fetch;
    global.fetch = async (url) => String(url).endsWith("/currencies")
      ? { ok: true, status: 200, text: async () => JSON.stringify({ currencies: ["btc"] }) }
      : { ok: true, status: 201, text: async () => JSON.stringify({ payment_id: "payment-history", payment_status: "waiting", pay_address: "history-address", price_amount: 20, price_currency: "usd", pay_amount: 0.0002, pay_currency: "btc", order_id: "order-native-1" }) };
    try { await service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_history_key", amountCents: 2000, payCurrency: "btc", flow: "native", db }); }
    finally { global.fetch = oldFetch; }
  });
  const orders = await service.recentOrders({ agencyId: "agency-1", db });
  assert.equal(orders[0].payment.providerPaymentId, "payment-history");
  assert.equal(orders[0].payment.payAddress, "history-address");
  assert.equal(orders[0].providerInvoiceUrl, null);
});

test("replaying an existing native payment does not depend on the currencies endpoint", async () => withEnv(baseEnv(), async () => {
  const db = makeDb();
  const service = loadService(db);
  const oldFetch = global.fetch;
  let phase = "seed";
  global.fetch = async (url) => {
    if (phase === "replay") throw new Error("provider must not be contacted while replaying existing instructions");
    if (String(url).endsWith("/currencies")) return { ok: true, status: 200, text: async () => JSON.stringify({ currencies: ["btc"] }) };
    if (String(url).endsWith("/payment")) return { ok: true, status: 201, text: async () => JSON.stringify({ payment_id: "payment-replay-offline", payment_status: "waiting", pay_address: "bc1offline", price_amount: 60, price_currency: "usd", pay_amount: 0.0008, pay_currency: "btc", order_id: "order-native-1" }) };
    throw new Error("unexpected");
  };
  try {
    const args = { agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_replay_offline", amountCents: 6000, payCurrency: "btc", flow: "native", db };
    await service.createWalletTopUpPayment(args);
    phase = "replay";
    const replay = await service.createWalletTopUpPayment(args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.payment.payAddress, "bc1offline");
  } finally { global.fetch = oldFetch; }
}));

test("FREE_INTERNAL live top-up fails before any NOWPayments request", async () => withEnv(baseEnv({ NOWPAYMENTS_MODE: "live", NOWPAYMENTS_API_BASE: "https://api.nowpayments.io/v1" }), async () => {
  const db = makeDb();
  db.agencySubscription.findFirst = async () => ({ billingMode: "FREE_INTERNAL" });
  const service = loadService(db);
  const oldFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("provider must not be contacted"); };
  try {
    await assert.rejects(
      service.createWalletTopUpPayment({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: "native_payment_free_internal_live", amountCents: 6000, payCurrency: "btc", flow: "native", db }),
      (err) => err.code === "BILLING_FREE_INTERNAL_LIVE_CHECKOUT_DISABLED",
    );
    assert.equal(calls, 0);
    assert.equal(db._getOrder(), null);
  } finally { global.fetch = oldFetch; }
}));

test("partial provider status updates cannot erase persisted native payment instructions", () => {
  const service = loadService({});
  const update = service.paymentAttemptUpdateData({ payment_status: "confirming", actually_paid: 0 });
  assert.deepEqual(update, { providerStatus: "confirming", actuallyPaid: "0" });
  assert.equal("payAddress" in update, false);
  assert.equal("payinExtraId" in update, false);
  assert.equal("payAmount" in update, false);
  assert.equal("payCurrency" in update, false);
});

test("final native wallet payment is bound to the originally selected crypto asset/network", () => {
  const service = loadService({});
  const order = {
    id: "order-1", purpose: "WALLET_TOP_UP", amountCents: 6000, currency: "USD",
    pricingSnapshot: { flow: "NATIVE_PAYMENT", payCurrency: "usdttrc20" },
  };
  assert.deepEqual(service.validateProviderPaymentForOrder(order, {
    payment_id: "p-1", price_amount: 60, price_currency: "usd", pay_currency: "usdttrc20",
  }, { requirePrice: true }), { ok: true });
  assert.throws(() => service.validateProviderPaymentForOrder(order, {
    payment_id: "p-1", price_amount: 60, price_currency: "usd", pay_currency: "usdterc20",
  }, { requirePrice: true }), (err) => err.code === "BILLING_PROVIDER_PAY_CURRENCY_MISMATCH");
  assert.throws(() => service.validateProviderPaymentForOrder(order, {
    payment_id: "p-1", price_amount: 60, price_currency: "usd",
  }, { requirePrice: true }), (err) => err.code === "BILLING_PROVIDER_PAY_CURRENCY_MISSING");
});
