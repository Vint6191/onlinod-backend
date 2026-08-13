"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const servicePath = path.join(__dirname, "billing-nowpayments-service.js");
const serviceSource = fs.readFileSync(servicePath, "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "routes", "billing.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
const schemaSource = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const migrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260813143000_nowpayments_billing_v1", "migration.sql"), "utf8");
const hardeningMigrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260813190000_nowpayments_billing_hardening_v13_1", "migration.sql"), "utf8");

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
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

function loadService(prismaMock = {}, auditMock = async () => null) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prismaMock;
    if (request === "./audit-service") return { audit: auditMock };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(servicePath)];
    return require(servicePath);
  } finally {
    Module._load = original;
  }
}

function independentlyStable(value) {
  if (Array.isArray(value)) return value.map(independentlyStable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = independentlyStable(value[key]);
    return out;
  }
  return value;
}

function parsePrismaModelFields(source) {
  const models = new Map();
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match;
  while ((match = re.exec(source))) {
    const fields = new Set();
    for (const rawLine of match[2].split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = line.match(/^(\w+)\s+/)?.[1];
      if (field) fields.add(field);
    }
    models.set(match[1], { body: match[2], fields });
  }
  return models;
}

function makeProcessingDb({ failOrderUpdateOnce = false } = {}) {
  const eventsByKey = new Map();
  let eventSeq = 0;
  let orderUpdateFailures = failOrderUpdateOnce ? 1 : 0;
  let order = {
    id: "order-1", agencyId: "agency-1", status: "CHECKOUT_CREATED", amountCents: 2000, currency: "USD",
    providerInvoiceId: "invoice-1", providerStatus: "waiting", testMode: true, paidAt: null, activatedAt: null,
    billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 1, createdAt: new Date("2026-08-13T12:00:00Z"), updatedAt: new Date("2026-08-13T12:00:00Z"),
  };
  const attempts = new Map();
  const paymentIdFromWhere = (where = {}) => where.providerPaymentId || where.provider_testMode_providerPaymentId?.providerPaymentId || null;
  let subscriptionWrites = 0;
  let agencyWrites = 0;
  let lastSubscriptionWrite = null;
  const db = {
    billingOrder: {
      findUnique: async ({ where }) => where.id === order.id ? { ...order } : null,
      update: async ({ where, data }) => {
        assert.equal(where.id, order.id);
        if (orderUpdateFailures > 0) { orderUpdateFailures -= 1; throw new Error("transient db write"); }
        order = { ...order, ...data, updatedAt: new Date() };
        return { ...order };
      },
      updateMany: async ({ where, data }) => {
        if (where.id !== order.id || (where.activatedAt === null && order.activatedAt)) return { count: 0 };
        order = { ...order, ...data, updatedAt: new Date() };
        return { count: 1 };
      },
      findFirst: async ({ where } = {}) => where?.id === order.id && (!where.agencyId || where.agencyId === order.agencyId) ? { ...order } : null,
    },
    billingPaymentAttempt: {
      findUnique: async ({ where }) => attempts.get(paymentIdFromWhere(where)) || null,
      findFirst: async () => {
        const rows = [...attempts.values()];
        return rows.length ? { ...rows[rows.length - 1] } : null;
      },
      upsert: async ({ where, create, update }) => {
        const providerPaymentId = paymentIdFromWhere(where);
        let row = attempts.get(providerPaymentId);
        if (!row) row = { id: `attempt-${attempts.size + 1}`, ...create, order: { ...order } };
        else row = { ...row, ...update, order: { ...order } };
        attempts.set(providerPaymentId, row);
        return { ...row };
      },
    },
    billingProviderEvent: {
      create: async ({ data }) => {
        if (eventsByKey.has(data.eventKey)) { const err = new Error("unique"); err.code = "P2002"; throw err; }
        const row = { id: `event-${++eventSeq}`, receivedAt: new Date(), processedAt: null, processingError: null, paymentAttemptId: null, ...data };
        eventsByKey.set(data.eventKey, row);
        return { ...row };
      },
      findUnique: async ({ where }) => {
        const row = eventsByKey.get(where.eventKey);
        return row ? { ...row } : null;
      },
      update: async ({ where, data }) => {
        const entry = [...eventsByKey.entries()].find(([, row]) => row.id === where.id);
        assert.ok(entry, `event ${where.id} exists`);
        const [key, row] = entry;
        const next = { ...row, ...data };
        eventsByKey.set(key, next);
        return { ...next };
      },
    },
    agencySubscription: {
      findFirst: async () => ({ id: "sub-1", agencyId: "agency-1", status: "TRIAL", billingMode: "MANUAL", billingPeriod: "MONTHLY", currentPeriodStart: null, currentPeriodEnd: null }),
      update: async ({ data }) => { subscriptionWrites += 1; lastSubscriptionWrite = { ...data }; return { id: "sub-1", ...data }; },
      create: async ({ data }) => { subscriptionWrites += 1; lastSubscriptionWrite = { ...data }; return { id: "sub-created", ...data }; },
    },
    agency: { update: async ({ data }) => { agencyWrites += 1; return { id: "agency-1", ...data }; } },
    $transaction: async (fn) => fn(db),
    _events: eventsByKey,
    _getOrder: () => ({ ...order }),
    _setOrder: (patch) => { order = { ...order, ...patch }; },
    _seedAttempt: (row) => { attempts.set(row.providerPaymentId, { id: row.id || `attempt-${attempts.size + 1}`, orderId: order.id, provider: "NOWPAYMENTS", testMode: order.testMode === true, order: { ...order }, ...row }); },
    _activationWrites: () => ({ subscriptionWrites, agencyWrites }),
    _lastSubscriptionWrite: () => lastSubscriptionWrite ? { ...lastSubscriptionWrite } : null,
  };
  return db;
}

test("V13 Prisma billing schema and migration are additive and every declared model index references real fields", () => {
  for (const name of ["BillingOrder", "BillingPaymentAttempt", "BillingProviderEvent"]) assert.match(schemaSource, new RegExp(`model ${name}\\s*\\{`));
  assert.match(schemaSource, /billingOrders\s+BillingOrder\[\]/);
  assert.match(migrationSource, /CREATE TABLE "BillingOrder"/);
  assert.match(migrationSource, /CREATE TABLE "BillingPaymentAttempt"/);
  assert.match(migrationSource, /CREATE TABLE "BillingProviderEvent"/);
  assert.match(schemaSource, /@@unique\(\[provider, testMode, providerInvoiceId\]\)/);
  assert.match(schemaSource, /@@unique\(\[provider, testMode, providerPaymentId\]\)/);
  assert.match(schemaSource, /checkoutKey\s+String\?/);
  assert.match(schemaSource, /@@unique\(\[agencyId, provider, testMode, checkoutKey\]\)/);
  assert.match(migrationSource, /BillingOrder_provider_testMode_providerInvoiceId_key/);
  assert.match(migrationSource, /BillingPaymentAttempt_provider_testMode_providerPaymentId_key/);
  assert.match(hardeningMigrationSource, /ADD COLUMN "checkoutKey" TEXT/);
  assert.match(hardeningMigrationSource, /BillingOrder_agencyId_provider_testMode_checkoutKey_key/);
  assert.doesNotMatch(migrationSource + hardeningMigrationSource, /\bDROP\s+(?:TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);

  const models = parsePrismaModelFields(schemaSource);
  const errors = [];
  for (const [name, model] of models) {
    const indexRe = /@@(?:index|unique|id)\s*\(\s*\[([^\]]+)\]/g;
    let m;
    while ((m = indexRe.exec(model.body))) {
      for (const raw of m[1].split(",")) {
        const field = raw.trim().match(/^(\w+)/)?.[1];
        if (field && !model.fields.has(field)) errors.push(`${name}.${field}`);
      }
    }
  }
  assert.deepEqual(errors, []);
});

test("NOWPayments sandbox/live configuration never leaks secrets and uses official default API bases", () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_API_BASE: undefined,
}, () => {
  const service = loadService();
  const privateConfig = service.providerConfig();
  const publicConfig = service.publicProviderConfig();
  assert.equal(privateConfig.apiBase, "https://api-sandbox.nowpayments.io/v1");
  assert.equal(publicConfig.environment, "sandbox");
  assert.equal(publicConfig.configured, true);
  assert.equal(publicConfig.testMode, true);
  assert.equal("apiKey" in publicConfig, false);
  assert.equal("ipnSecret" in publicConfig, false);
}));

test("provider configuration rejects local callback URLs, unofficial API bases and invalid timeout input", () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://127.0.0.1:3000", NOWPAYMENTS_API_BASE: "https://lookalike.example/v1", NOWPAYMENTS_TIMEOUT_MS: "nope",
}, () => {
  const service = loadService();
  const privateConfig = service.providerConfig();
  const publicConfig = service.publicProviderConfig();
  assert.equal(privateConfig.timeoutMs, 15000);
  assert.equal(privateConfig.publicUrlValid, false);
  assert.equal(privateConfig.apiBaseValid, false);
  assert.equal(publicConfig.configured, false);
  assert.ok(publicConfig.missingConfiguration.includes("PUBLIC_BASE_URL (public HTTPS URL)"));
  assert.ok(publicConfig.missingConfiguration.some((item) => item.startsWith("NOWPAYMENTS_API_BASE")));
}));

test("NOWPayments IPN signature verification uses deterministic recursive sorting + HMAC SHA-512", () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "very-secret", PUBLIC_BASE_URL: "https://api.example.com",
}, () => {
  const service = loadService();
  const payload = { payment_status: "finished", nested: { z: 2, a: 1 }, payment_id: 77, array: [{ b: 2, a: 1 }] };
  const canonical = JSON.stringify(independentlyStable(payload));
  const signature = crypto.createHmac("sha512", "very-secret").update(canonical).digest("hex");
  assert.equal(service.verifyIpnSignature(payload, signature), true);
  assert.equal(service.verifyIpnSignature({ ...payload, payment_status: "failed" }, signature), false);
  assert.equal(service.verifyIpnSignature(payload, "abc"), false);
}));

test("provider statuses are monotonic and never regress a paid/partial/terminal order due to a late stale event", () => {
  const service = loadService();
  assert.equal(service.monotonicOrderStatus("PAID", "confirmed"), "PAID");
  assert.equal(service.monotonicOrderStatus("PAID", "refunded"), "REFUNDED");
  assert.equal(service.monotonicOrderStatus("PARTIALLY_PAID", "waiting"), "PARTIALLY_PAID");
  assert.equal(service.monotonicOrderStatus("FAILED", "waiting"), "FAILED");
  assert.equal(service.monotonicOrderStatus("EXPIRED", "confirming"), "EXPIRED");
  assert.equal(service.monotonicOrderStatus("FAILED", "finished"), "PAID");
});

test("final paid status is fail-closed unless payment id, invoice, fiat price currency and amount match the local billing order", () => {
  const service = loadService();
  const order = { amountCents: 12345, currency: "USD", providerInvoiceId: "inv-1" };
  assert.deepEqual(service.validateProviderPaymentForOrder(order, { payment_id: "p-1", invoice_id: "inv-1", price_amount: "123.45", price_currency: "usd" }, { requirePrice: true }), { ok: true });
  assert.throws(() => service.validateProviderPaymentForOrder(order, { payment_id: "p-1", invoice_id: "inv-1", price_amount: "12.34", price_currency: "usd" }, { requirePrice: true }), /amount does not match/);
  assert.throws(() => service.validateProviderPaymentForOrder(order, { payment_id: "p-1", invoice_id: "inv-1", price_amount: "123.45", price_currency: "eur" }, { requirePrice: true }), /currency does not match/);
  assert.throws(() => service.validateProviderPaymentForOrder(order, { payment_id: "p-1", invoice_id: "other", price_amount: "123.45", price_currency: "usd" }, { requirePrice: true }), /invoice does not match/);
  assert.throws(() => service.validateProviderPaymentForOrder(order, { invoice_id: "inv-1", price_amount: "123.45", price_currency: "usd" }, { requirePrice: true }), /missing payment_id/);
});

test("checkout snapshots real creator prices, creates a hosted invoice, and sends only backend-owned callback/order fields", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_CASE: "success", NODE_ENV: "test",
}, async () => {
  const service = loadService();
  const created = [];
  const db = {
    agencySubscription: { findFirst: async () => ({ billingPeriod: "THREE_MONTHS", billingMode: "MANUAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [
      { id: "c1", displayName: "One", username: "one", billingProfile: { tier: "STARTER", corePriceCents: 2000, aiChatterEnabled: true, aiChatterPriceCents: 1000, outreachEnabled: false, outreachPriceCents: 0, billingExcluded: false } },
      { id: "c2", displayName: "Excluded", username: "x", billingProfile: { tier: "CUSTOM", corePriceCents: 9000, aiChatterEnabled: false, aiChatterPriceCents: 0, outreachEnabled: false, outreachPriceCents: 0, billingExcluded: true } },
      { id: "c3", displayName: "No profile", username: "missing", billingProfile: null },
    ] },
    agency: { findUnique: async () => ({ id: "a1", name: "Agency", plan: "PRO" }) },
    billingOrder: {
      findUnique: async () => null,
      create: async ({ data }) => { const row = { id: "order-1", createdAt: new Date(), updatedAt: new Date(), paidAt: null, activatedAt: null, expiresAt: null, providerInvoiceId: null, providerInvoiceUrl: null, providerStatus: null, ...data }; created.push(row); return row; },
      update: async ({ data }) => ({ ...created[0], ...data }),
    },
  };
  const previousFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: "invoice-1", invoice_url: "https://nowpayments.io/payment/?iid=invoice-1" }) };
  };
  try {
    const result = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_123456", db });
    assert.equal(result.order.amountCents, 15000); // ((2000 + 1000) + default 2000) * 3 months
    assert.equal(request.url, "https://api-sandbox.nowpayments.io/v1/invoice");
    assert.equal(request.body.price_amount, 150);
    assert.equal(request.body.price_currency, "usd");
    assert.equal(request.body.order_id, "order-1");
    assert.equal(created[0].checkoutKey, "checkout_request_123456");
    assert.equal("case" in request.body, false);
    assert.equal(request.body.ipn_callback_url, "https://api.example.com/api/billing/nowpayments/ipn");
    assert.match(result.checkoutUrl, /^https:\/\/nowpayments\.io\//);
  } finally { global.fetch = previousFetch; }
}));

test("checkout audit failure after provider invoice creation does not destroy a reusable payment invoice", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NODE_ENV: "test",
}, async () => {
  let order = null;
  const db = {
    agencySubscription: { findFirst: async () => ({ billingPeriod: "MONTHLY", billingMode: "MANUAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [{ id: "c1", displayName: "One", username: "one", billingProfile: { tier: "STARTER", corePriceCents: 2000, aiChatterEnabled: false, aiChatterPriceCents: 0, outreachEnabled: false, outreachPriceCents: 0, billingExcluded: false } }] },
    agency: { findUnique: async () => ({ id: "a1", name: "Agency", plan: "PRO" }) },
    billingOrder: {
      findUnique: async () => order ? { ...order } : null,
      create: async ({ data }) => { order = { id: "order-audit", createdAt: new Date(), updatedAt: new Date(), paidAt: null, activatedAt: null, expiresAt: null, providerInvoiceId: null, providerInvoiceUrl: null, providerStatus: null, ...data }; return { ...order }; },
      update: async ({ data }) => { order = { ...order, ...data, updatedAt: new Date() }; return { ...order }; },
    },
  };
  const previousFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async () => { providerCalls += 1; return { ok: true, status: 201, text: async () => JSON.stringify({ id: "invoice-audit", invoice_url: "https://nowpayments.io/payment/?iid=invoice-audit" }) }; };
  try {
    const service = loadService(db, async () => { throw new Error("audit unavailable"); });
    const first = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_audit_123", db });
    assert.equal(first.order.status, "CHECKOUT_CREATED");
    assert.equal(first.checkoutUrl, "https://nowpayments.io/payment/?iid=invoice-audit");
    assert.equal(order.status, "CHECKOUT_CREATED");
    const second = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_audit_123", db });
    assert.equal(second.replayed, true);
    assert.equal(second.checkoutUrl, first.checkoutUrl);
    assert.equal(providerCalls, 1);
  } finally { global.fetch = previousFetch; }
}));

test("FREE_INTERNAL can use sandbox for testing but cannot accidentally create a live charge", async () => withEnv({
  NOWPAYMENTS_MODE: "live", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const service = loadService();
  let orderCreates = 0;
  const db = {
    agencySubscription: { findFirst: async () => ({ billingPeriod: "MONTHLY", billingMode: "FREE_INTERNAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [{ id: "c1", displayName: "One", username: "one", billingProfile: { tier: "STARTER", corePriceCents: 2000, aiChatterEnabled: false, aiChatterPriceCents: 0, outreachEnabled: false, outreachPriceCents: 0, billingExcluded: false } }] },
    agency: { findUnique: async () => ({ id: "a1", name: "Agency", plan: "PRO" }) },
    billingOrder: { findUnique: async () => null, create: async () => { orderCreates += 1; throw new Error("must not create"); } },
  };
  await assert.rejects(service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_live_123", db }), /live checkout is disabled/i);
  assert.equal(orderCreates, 0);
}));

test("checkout idempotency is persisted in BillingOrder and a retried request reuses the same hosted invoice without another provider call", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const existing = {
    id: "order-existing", agencyId: "a1", provider: "NOWPAYMENTS", status: "CHECKOUT_CREATED", amountCents: 2000, currency: "USD",
    billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 1, providerInvoiceId: "invoice-existing",
    providerInvoiceUrl: "https://nowpayments.io/payment/?iid=invoice-existing", providerStatus: "waiting", testMode: true,
    checkoutKey: "checkout_request_replay_123", paidAt: null, activatedAt: null, expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
  let providerCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => { providerCalls += 1; throw new Error("provider must not be called"); };
  try {
    const service = loadService();
    const db = { billingOrder: { findUnique: async () => ({ ...existing }) } };
    const result = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: existing.checkoutKey, db });
    assert.equal(result.replayed, true);
    assert.equal(result.order.id, existing.id);
    assert.equal(result.checkoutUrl, existing.providerInvoiceUrl);
    assert.equal(providerCalls, 0);
  } finally { global.fetch = previousFetch; }
}));

test("a failed sandbox invoice request with no remote invoice can be retried with the same checkout key", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  let order = {
    id: "order-retry", agencyId: "a1", provider: "NOWPAYMENTS", status: "FAILED", amountCents: 2000, currency: "USD",
    billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 1, providerInvoiceId: null, providerInvoiceUrl: null,
    providerStatus: "NOWPAYMENTS_REQUEST_FAILED", testMode: true, checkoutKey: "checkout_request_retry_123",
    paidAt: null, activatedAt: null, expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const db = {
    agencySubscription: { findFirst: async () => ({ billingPeriod: "MONTHLY", billingMode: "MANUAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [{ id: "c1", displayName: "One", username: "one", billingProfile: null }] },
    agency: { findUnique: async () => ({ id: "a1", name: "Agency", plan: "PRO" }) },
    billingOrder: {
      findUnique: async () => ({ ...order }),
      update: async ({ data }) => { order = { ...order, ...data, updatedAt: new Date() }; return { ...order }; },
    },
  };
  const previousFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async (_url, options) => {
    providerCalls += 1;
    const body = JSON.parse(options.body);
    assert.equal("case" in body, false);
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: "invoice-retry", invoice_url: "https://nowpayments.io/payment/?iid=invoice-retry" }) };
  };
  try {
    const service = loadService(db);
    const result = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: order.checkoutKey, db });
    assert.equal(providerCalls, 1);
    assert.equal(result.order.status, "CHECKOUT_CREATED");
    assert.equal(result.checkoutUrl, "https://nowpayments.io/payment/?iid=invoice-retry");
    assert.equal(order.providerInvoiceId, "invoice-retry");
  } finally { global.fetch = previousFetch; }
}));

test("an IPN event that fails transient processing stays retryable; the identical retry resumes instead of being acknowledged as done", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const db = makeProcessingDb({ failOrderUpdateOnce: true });
  const service = loadService(db);
  const payload = { payment_id: "payment-1", payment_status: "confirming", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  await assert.rejects(service.applyProviderPayment(payload, { signature: "sig", signatureVerified: true, db }), /transient db write/);
  const event = [...db._events.values()][0];
  assert.equal(event.processedAt, null);
  assert.match(event.processingError, /transient db write/);
  const retry = await service.applyProviderPayment(payload, { signature: "sig", signatureVerified: true, db });
  assert.equal(retry.duplicate, false);
  assert.equal(retry.order.status, "PROCESSING");
  const processed = [...db._events.values()][0];
  assert.ok(processed.processedAt instanceof Date);
  assert.equal(processed.processingError, null);
}));

test("a verified finished sandbox payment activates exactly once when sandbox activation is enabled", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "1", NODE_ENV: "test",
}, async () => {
  const db = makeProcessingDb();
  const service = loadService(db);
  const payload = { payment_id: "payment-paid", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  const first = await service.applyProviderPayment(payload, { signature: "sig-paid", signatureVerified: true, db });
  assert.equal(first.order.status, "PAID");
  assert.equal(first.activation.activated, true);
  assert.ok(db._getOrder().activatedAt instanceof Date);
  assert.deepEqual(db._activationWrites(), { subscriptionWrites: 1, agencyWrites: 1 });
  assert.equal(db._lastSubscriptionWrite()?.billingMode, "MANUAL");
  const second = await service.applyProviderPayment(payload, { signature: "sig-paid", signatureVerified: true, db });
  assert.equal(second.duplicate, true);
  assert.deepEqual(db._activationWrites(), { subscriptionWrites: 1, agencyWrites: 1 });
}));

test("sandbox entitlement activation preserves FREE_INTERNAL billing mode so a test payment cannot unlock accidental live charging", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "1", NODE_ENV: "test",
}, async () => {
  const db = makeProcessingDb();
  db.agencySubscription.findFirst = async () => ({ id: "sub-1", agencyId: "agency-1", status: "ACTIVE", billingMode: "FREE_INTERNAL", billingPeriod: "MONTHLY", currentPeriodStart: null, currentPeriodEnd: null });
  const service = loadService(db);
  const payload = { payment_id: "payment-free-internal", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  const result = await service.applyProviderPayment(payload, { signature: "sig-free", signatureVerified: true, db });
  assert.equal(result.activation.activated, true);
  assert.equal(db._lastSubscriptionWrite()?.billingMode, "FREE_INTERNAL");
}));

test("verified live payment activation switches a non-crypto subscription to CRYPTO billing mode", async () => withEnv({
  NOWPAYMENTS_MODE: "live", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NODE_ENV: "production",
}, async () => {
  const db = makeProcessingDb();
  db._setOrder({ testMode: false });
  db.agencySubscription.findFirst = async () => ({ id: "sub-1", agencyId: "agency-1", status: "ACTIVE", billingMode: "MANUAL", billingPeriod: "MONTHLY", currentPeriodStart: null, currentPeriodEnd: null });
  const service = loadService(db);
  const payload = { payment_id: "payment-live", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  const result = await service.applyProviderPayment(payload, { signature: "sig-live", signatureVerified: true, db });
  assert.equal(result.activation.activated, true);
  assert.equal(db._lastSubscriptionWrite()?.billingMode, "CRYPTO");
}));

test("manual reconciliation can activate an already-paid sandbox order after activation is intentionally enabled later", async () => {
  const db = makeProcessingDb();
  db._seedAttempt({ id: "attempt-1", providerPaymentId: "payment-late-activate", providerStatus: "finished" });
  const payload = { payment_id: "payment-late-activate", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
  try {
    await withEnv({ NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "0", NODE_ENV: "production" }, async () => {
      const service = loadService(db);
      const first = await service.reconcileOrder({ agencyId: "agency-1", orderId: "order-1", actorUserId: "owner", db });
      assert.equal(first.order.status, "PAID");
      assert.equal(first.order.activatedAt, null);
      assert.equal(db._activationWrites().subscriptionWrites, 0);
    });
    await withEnv({ NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "1", NODE_ENV: "production" }, async () => {
      const service = loadService(db);
      const second = await service.reconcileOrder({ agencyId: "agency-1", orderId: "order-1", actorUserId: "owner", db });
      assert.equal(second.order.status, "PAID");
      assert.ok(second.order.activatedAt);
      assert.equal(db._activationWrites().subscriptionWrites, 1);
    });
  } finally { global.fetch = previousFetch; }
});

test("provider payment identifiers are environment-scoped and a payment_id cannot be rebound to a different local order", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const db = makeProcessingDb();
  db._seedAttempt({ id: "attempt-bound", providerPaymentId: "payment-bound", providerStatus: "confirming" });
  const originalFindUnique = db.billingOrder.findUnique;
  db.billingOrder.findUnique = async ({ where }) => {
    if (where.id === "order-2") return { ...db._getOrder(), id: "order-2" };
    return originalFindUnique({ where });
  };
  const service = loadService(db);
  const payload = { payment_id: "payment-bound", payment_status: "finished", order_id: "order-2", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  await assert.rejects(service.applyProviderPayment(payload, { signature: "sig-cross", signatureVerified: true, db }), /already bound to another billing order/);
  assert.equal(db._getOrder().activatedAt, null);
  const event = [...db._events.values()][0];
  assert.ok(event.processedAt instanceof Date);
  assert.match(event.processingError, /already bound to another billing order/);
}));

test("provider events are environment-fenced even if an IPN secret were accidentally reused across sandbox and live", async () => withEnv({
  NOWPAYMENTS_MODE: "live", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const db = makeProcessingDb();
  const service = loadService(db);
  const payload = { payment_id: "payment-cross-env", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  await assert.rejects(service.applyProviderPayment(payload, { signature: "sig-cross-env", signatureVerified: true, db }), /environment does not match/i);
  assert.equal(db._getOrder().status, "CHECKOUT_CREATED");
  assert.equal(db._activationWrites().subscriptionWrites, 0);
}));

test("manual reconciliation refuses to query a sandbox order through a live provider environment", async () => {
  const db = makeProcessingDb();
  db._seedAttempt({ id: "attempt-env", providerPaymentId: "payment-env", providerStatus: "waiting" });
  await withEnv({ NOWPAYMENTS_MODE: "live", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com" }, async () => {
    const service = loadService(db);
    await assert.rejects(service.reconcileOrder({ agencyId: "agency-1", orderId: "order-1", actorUserId: "owner", db }), /belongs to the sandbox provider environment/);
  });
});

test("a signed final event with mismatched amount is stored as a permanent rejected provider event and never activates the order", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const db = makeProcessingDb();
  const service = loadService(db);
  const payload = { payment_id: "payment-1", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 19.99, price_currency: "usd" };
  await assert.rejects(service.applyProviderPayment(payload, { signature: "sig", signatureVerified: true, db }), /amount does not match/);
  assert.equal(db._getOrder().status, "CHECKOUT_CREATED");
  const event = [...db._events.values()][0];
  assert.ok(event.processedAt instanceof Date);
  assert.match(event.processingError, /amount does not match/);
  const duplicate = await service.applyProviderPayment(payload, { signature: "sig", signatureVerified: true, db });
  assert.equal(duplicate.duplicate, true);
  assert.equal(db._getOrder().activatedAt, null);
}));

test("billing HTTP boundary keeps signed IPN public, all checkout mutation owner-authenticated, and redirect success non-authoritative", () => {
  const ipnPos = routeSource.indexOf('router.post("/nowpayments/ipn"');
  const authPos = routeSource.indexOf("router.use(authRequired)");
  const checkoutPos = routeSource.indexOf('router.post("/checkout"');
  assert.ok(ipnPos >= 0 && authPos > ipnPos && checkoutPos > authPos);
  assert.match(routeSource, /router\.use\(ownerOnly\)/);
  assert.match(routeSource, /Redirects only inform|redirects only inform|never activate entitlements/i);
  assert.doesNotMatch(routeSource.slice(routeSource.indexOf('router.get("/checkout/success"'), authPos), /activatePaidOrder|AgencySubscription|billingMode/);
  assert.match(serverSource, /app\.use\("\/api\/billing", billingRoutes\)/);
});
