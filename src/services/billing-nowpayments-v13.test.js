"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const servicePath = path.join(__dirname, "billing-nowpayments-service.js");
const entitlementServicePath = path.join(__dirname, "billing-entitlement-service.js");
const serviceSource = fs.readFileSync(servicePath, "utf8");
const entitlementServiceSource = fs.readFileSync(entitlementServicePath, "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "routes", "billing.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "src", "routes", "admin.js"), "utf8");
const schemaSource = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const migrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260813143000_nowpayments_billing_v1", "migration.sql"), "utf8");
const hardeningMigrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260813190000_nowpayments_billing_hardening_v13_1", "migration.sql"), "utf8");
const entitlementMigrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260813223000_per_creator_billing_entitlements_v13_3", "migration.sql"), "utf8");
const entitlementRepairMigrationSource = fs.readFileSync(path.join(root, "prisma", "migrations", "20260814002000_billing_v13_3_1_repair", "migration.sql"), "utf8");

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

function loadEntitlementService(prismaMock = {}) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prismaMock;
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(entitlementServicePath)];
    return require(entitlementServicePath);
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
    billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 1,
    pricingSnapshot: { lines: [{ creatorId: "creator-1", creatorName: "Creator One", creatorUsername: "one", tier: "STARTER", corePriceCents: 2000, aiChatterEnabled: false, aiChatterPriceCents: 0, outreachEnabled: false, outreachPriceCents: 0, monthlyCents: 2000, lineTotalCents: 2000 }] },
    createdAt: new Date("2026-08-13T12:00:00Z"), updatedAt: new Date("2026-08-13T12:00:00Z"),
  };
  const attempts = new Map();
  const lines = new Map([["line-1", {
    id: "line-1", orderId: "order-1", agencyId: "agency-1", creatorId: "creator-1", creatorName: "Creator One", creatorUsername: "one",
    tier: "STARTER", corePriceCents: 2000, aiChatterEnabled: false, aiChatterPriceCents: 0, outreachEnabled: false, outreachPriceCents: 0,
    monthlyCents: 2000, periodMonths: 1, lineTotalCents: 2000, previousTier: null, corePreviousValidUntil: null, coreGrantedUntil: null,
    aiPreviousValidUntil: null, aiGrantedUntil: null, outreachPreviousValidUntil: null, outreachGrantedUntil: null, activatedAt: null, refundedAt: null,
    createdAt: new Date("2026-08-13T12:00:00Z"), updatedAt: new Date("2026-08-13T12:00:00Z"),
  }]]);
  const entitlements = new Map();
  const profiles = new Map();
  const paymentIdFromWhere = (where = {}) => where.providerPaymentId || where.provider_testMode_providerPaymentId?.providerPaymentId || null;
  let subscriptionWrites = 0;
  let agencyWrites = 0;
  let lastSubscriptionWrite = null;
  let subscription = { id: "sub-1", agencyId: "agency-1", status: "TRIAL", billingMode: "MANUAL", billingPeriod: "MONTHLY", currentPeriodStart: null, currentPeriodEnd: null };

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
        if (orderUpdateFailures > 0) { orderUpdateFailures -= 1; throw new Error("transient db write"); }
        if (where.id !== order.id || (where.status !== undefined && where.status !== order.status) || (where.activatedAt === null && order.activatedAt)) return { count: 0 };
        order = { ...order, ...data, updatedAt: new Date() };
        return { count: 1 };
      },
      findFirst: async ({ where } = {}) => where?.id === order.id && (!where.agencyId || where.agencyId === order.agencyId) ? { ...order } : null,
    },
    billingOrderLine: {
      findMany: async ({ where }) => [...lines.values()].filter((row) => !where?.orderId || row.orderId === where.orderId).map((row) => ({ ...row })),
      findFirst: async ({ where } = {}) => {
        const candidates = [...lines.values()]
          .filter((row) => !where?.creatorId || row.creatorId === where.creatorId)
          .filter((row) => !where?.orderId?.not || row.orderId !== where.orderId.not)
          .filter((row) => where?.activatedAt?.not === null ? row.activatedAt != null : true)
          .filter((row) => where?.refundedAt === null ? row.refundedAt == null : true)
          .filter((row) => where?.coreGrantedUntil?.not === null ? row.coreGrantedUntil != null : true)
          .filter((row) => where?.aiGrantedUntil?.not === null ? row.aiGrantedUntil != null : true)
          .filter((row) => where?.outreachGrantedUntil?.not === null ? row.outreachGrantedUntil != null : true)
          .filter((row) => where?.aiChatterEnabled === true ? row.aiChatterEnabled === true : true)
          .filter((row) => where?.outreachEnabled === true ? row.outreachEnabled === true : true)
          .sort((a, b) => new Date(b.activatedAt || b.createdAt) - new Date(a.activatedAt || a.createdAt));
        const row = candidates[0];
        return row ? { ...row, order: { id: row.orderId, status: "PAID", paidAt: order.paidAt || null, activatedAt: row.activatedAt } } : null;
      },
      create: async ({ data }) => {
        if ([...lines.values()].some((row) => row.orderId === data.orderId && row.creatorId === data.creatorId)) { const err = new Error("unique"); err.code = "P2002"; throw err; }
        const row = { id: `line-${lines.size + 1}`, createdAt: new Date(), updatedAt: new Date(), activatedAt: null, refundedAt: null, ...data };
        lines.set(row.id, row); return { ...row };
      },
      createMany: async ({ data }) => { for (const item of data) { const row = { id: `line-${lines.size + 1}`, createdAt: new Date(), updatedAt: new Date(), activatedAt: null, refundedAt: null, ...item }; lines.set(row.id, row); } return { count: data.length }; },
      deleteMany: async ({ where }) => { let count = 0; for (const [id, row] of [...lines]) if (!where?.orderId || row.orderId === where.orderId) { lines.delete(id); count += 1; } return { count }; },
      update: async ({ where, data }) => { const row = lines.get(where.id); assert.ok(row); const next = { ...row, ...data, updatedAt: new Date() }; lines.set(where.id, next); return { ...next }; },
    },
    creatorBillingEntitlement: {
      findUnique: async ({ where }) => { const row = entitlements.get(where.creatorId); return row ? { ...row } : null; },
      findFirst: async ({ where }) => {
        const now = where?.coreValidUntil?.gt || new Date(0);
        const rows = [...entitlements.values()].filter((row) => row.agencyId === where.agencyId && row.coreValidUntil && new Date(row.coreValidUntil) > now).sort((a, b) => new Date(b.coreValidUntil) - new Date(a.coreValidUntil));
        return rows[0] ? { ...rows[0] } : null;
      },
      upsert: async ({ where, create, update }) => {
        const current = entitlements.get(where.creatorId);
        const next = current ? { ...current, ...update, updatedAt: new Date() } : { id: `ent-${entitlements.size + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        entitlements.set(where.creatorId, next); return { ...next };
      },
      update: async ({ where, data }) => { const current = entitlements.get(where.creatorId); assert.ok(current); const next = { ...current, ...data, updatedAt: new Date() }; entitlements.set(where.creatorId, next); return { ...next }; },
    },
    creatorBillingProfile: {
      upsert: async ({ where, create, update }) => { const current = profiles.get(where.creatorId); const next = current ? { ...current, ...update } : { id: `profile-${profiles.size + 1}`, ...create }; profiles.set(where.creatorId, next); return { ...next }; },
    },
    billingPaymentAttempt: {
      findUnique: async ({ where }) => attempts.get(paymentIdFromWhere(where)) || null,
      findFirst: async () => { const rows = [...attempts.values()]; return rows.length ? { ...rows[rows.length - 1] } : null; },
      upsert: async ({ where, create, update }) => {
        const providerPaymentId = paymentIdFromWhere(where);
        let row = attempts.get(providerPaymentId);
        if (!row) row = { id: `attempt-${attempts.size + 1}`, ...create, order: { ...order } };
        else row = { ...row, ...update, order: { ...order } };
        attempts.set(providerPaymentId, row); return { ...row };
      },
    },
    billingProviderEvent: {
      create: async ({ data }) => { if (eventsByKey.has(data.eventKey)) { const err = new Error("unique"); err.code = "P2002"; throw err; } const row = { id: `event-${++eventSeq}`, receivedAt: new Date(), processedAt: null, processingError: null, paymentAttemptId: null, ...data }; eventsByKey.set(data.eventKey, row); return { ...row }; },
      findUnique: async ({ where }) => { const row = eventsByKey.get(where.eventKey); return row ? { ...row } : null; },
      update: async ({ where, data }) => { const entry = [...eventsByKey.entries()].find(([, row]) => row.id === where.id); assert.ok(entry, `event ${where.id} exists`); const [key, row] = entry; const next = { ...row, ...data }; eventsByKey.set(key, next); return { ...next }; },
    },
    agencySubscription: {
      findFirst: async () => ({ ...subscription }),
      update: async ({ data }) => { subscriptionWrites += 1; lastSubscriptionWrite = { ...data }; subscription = { ...subscription, ...data }; return { ...subscription }; },
      create: async ({ data }) => { subscriptionWrites += 1; lastSubscriptionWrite = { ...data }; subscription = { id: "sub-created", ...data }; return { ...subscription }; },
    },
    agency: { update: async ({ data }) => { agencyWrites += 1; return { id: "agency-1", ...data }; } },
    $transaction: async (fn) => fn(db),
    _events: eventsByKey,
    _getOrder: () => ({ ...order }),
    _setOrder: (patch) => { order = { ...order, ...patch }; },
    _setSubscription: (patch) => { subscription = { ...subscription, ...patch }; },
    _seedAttempt: (row) => { attempts.set(row.providerPaymentId, { id: row.id || `attempt-${attempts.size + 1}`, orderId: order.id, provider: "NOWPAYMENTS", testMode: order.testMode === true, order: { ...order }, ...row }); },
    _activationWrites: () => ({ subscriptionWrites, agencyWrites }),
    _lastSubscriptionWrite: () => lastSubscriptionWrite ? { ...lastSubscriptionWrite } : null,
    _entitlements: entitlements,
    _lines: lines,
  };
  return db;
}

test("V13 Prisma billing schema and migration are additive and every declared model index references real fields", () => {
  for (const name of ["BillingOrder", "BillingOrderLine", "CreatorBillingEntitlement", "BillingPaymentAttempt", "BillingProviderEvent"]) assert.match(schemaSource, new RegExp(`model ${name}\\s*\\{`));
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
  assert.match(entitlementMigrationSource, /CREATE TABLE "BillingOrderLine"/);
  assert.match(entitlementMigrationSource, /CREATE TABLE "CreatorBillingEntitlement"/);
  assert.match(entitlementMigrationSource, /ADD COLUMN "requestHash" TEXT/);
  assert.match(entitlementMigrationSource, /"currentPeriodEnd" > CURRENT_TIMESTAMP/);
  assert.doesNotMatch(migrationSource + hardeningMigrationSource + entitlementMigrationSource, /\bDROP\s+(?:TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);

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
    const result = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_123456", selection: { billingPeriod: "THREE_MONTHS", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: true, outreachEnabled: false }, { creatorId: "c3", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db });
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
    const first = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_audit_123", selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db });
    assert.equal(first.order.status, "CHECKOUT_CREATED");
    assert.equal(first.checkoutUrl, "https://nowpayments.io/payment/?iid=invoice-audit");
    assert.equal(order.status, "CHECKOUT_CREATED");
    const second = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_audit_123", selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db });
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
  await assert.rejects(service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: "checkout_request_live_123", selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db }), /live checkout is disabled/i);
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
    const result = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: existing.checkoutKey, selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db });
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
    const result = await service.createCheckout({ agencyId: "a1", actorUserId: "u1", checkoutKey: order.checkoutKey, selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db });
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


test("V13.3 quote charges only explicitly selected creators and server-prices tiers/add-ons/period", async () => {
  const service = loadService();
  const db = {
    agencySubscription: { findFirst: async () => ({ billingMode: "MANUAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [
      { id: "c1", displayName: "One", username: "one", billingProfile: { tier: "STARTER", corePriceCents: 2000, aiChatterPriceCents: 10000, outreachPriceCents: 2900, billingExcluded: false } },
      { id: "c2", displayName: "Two", username: "two", billingProfile: { tier: "STARTER", corePriceCents: 2000, aiChatterPriceCents: 10000, outreachPriceCents: 2900, billingExcluded: false } },
    ] },
    agency: { findUnique: async () => ({ id: "agency-1", name: "Agency", plan: "dev" }) },
  };
  const quote = await service.calculateCheckoutSnapshot({
    agencyId: "agency-1",
    selection: { billingPeriod: "THREE_MONTHS", creators: [{ creatorId: "c2", tier: "GROWTH", aiChatterEnabled: true, outreachEnabled: true }] },
    db,
  });
  assert.equal(quote.billedCreators, 1);
  assert.equal(quote.lines[0].creatorId, "c2");
  assert.equal(quote.lines[0].corePriceCents, 3000);
  assert.equal(quote.lines[0].monthlyCents, 15900);
  assert.equal(quote.amountCents, 47700);
  assert.equal(quote.periodMonths, 3);
});

test("V13.3 quote preserves the existing agency core-price default for a creator without an explicit billing profile", async () => {
  const service = loadService();
  const db = {
    agencySubscription: { findFirst: async () => ({ billingMode: "MANUAL", corePricePerCreatorCents: 2500 }) },
    creatorAccount: { findMany: async () => [{ id: "c1", displayName: "Defaulted", username: "defaulted", billingProfile: null }] },
    agency: { findUnique: async () => ({ id: "agency-1", name: "Agency", plan: "dev" }) },
  };
  const quote = await service.calculateCheckoutSnapshot({
    agencyId: "agency-1",
    selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] },
    db,
  });
  assert.equal(quote.lines[0].corePriceCents, 2500);
  assert.equal(quote.amountCents, 2500);
});

test("V13.3 quote fails closed when a selected creator is admin-excluded or belongs outside the agency selection", async () => {
  const service = loadService();
  const db = {
    agencySubscription: { findFirst: async () => ({ billingMode: "MANUAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [{ id: "c1", displayName: "Excluded", username: "x", billingProfile: { tier: "STARTER", corePriceCents: 2000, billingExcluded: true } }] },
    agency: { findUnique: async () => ({ id: "agency-1", name: "Agency", plan: "dev" }) },
  };
  await assert.rejects(service.calculateCheckoutSnapshot({ agencyId: "agency-1", selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER" }] }, db }), /excluded from billing/i);
  db.creatorAccount.findMany = async () => [];
  await assert.rejects(service.calculateCheckoutSnapshot({ agencyId: "agency-1", selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "other-agency", tier: "STARTER" }] }, db }), /unavailable in this workspace/i);
});

test("V13.3 checkout idempotency key cannot be replayed with a different creator selection", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const service = loadService();
  const firstSelection = { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] };
  const requestHash = crypto.createHash("sha256").update(service.stableJson(firstSelection)).digest("hex");
  const existing = { id: "existing", agencyId: "agency-1", provider: "NOWPAYMENTS", status: "CHECKOUT_CREATED", testMode: true, checkoutKey: "same_key_1234567890", requestHash, providerInvoiceUrl: "https://nowpayments.io/payment/?iid=x" };
  const db = { billingOrder: { findUnique: async () => existing } };
  await assert.rejects(service.createCheckout({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: existing.checkoutKey, selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c2", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db }), /different billing selection/i);
}));

test("V13.3 concurrent idempotency collision re-checks request binding before replaying a raced invoice", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const service = loadService();
  const ourSelection = { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] };
  const otherSelection = { billingPeriod: "MONTHLY", creators: [{ creatorId: "c2", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] };
  const otherHash = crypto.createHash("sha256").update(service.stableJson(otherSelection)).digest("hex");
  let reads = 0;
  const raced = { id: "raced", agencyId: "agency-1", provider: "NOWPAYMENTS", status: "CHECKOUT_CREATED", testMode: true, checkoutKey: "race_key_1234567890", requestHash: otherHash, providerInvoiceUrl: "https://nowpayments.io/payment/?iid=raced" };
  const db = {
    agencySubscription: { findFirst: async () => ({ billingPeriod: "MONTHLY", billingMode: "MANUAL", corePricePerCreatorCents: 2000 }) },
    creatorAccount: { findMany: async () => [{ id: "c1", displayName: "One", username: "one", billingProfile: null }] },
    agency: { findUnique: async () => ({ id: "agency-1", name: "Agency", plan: "PRO" }) },
    billingOrder: {
      findUnique: async () => (++reads === 1 ? null : raced),
      create: async () => { const err = new Error("unique"); err.code = "P2002"; throw err; },
    },
  };
  await assert.rejects(
    service.createCheckout({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: raced.checkoutKey, selection: ourSelection, db }),
    (err) => err?.code === "BILLING_CHECKOUT_SELECTION_MISMATCH",
  );
}));

test("V13.3 refuses to reuse a pre-V13.3 checkout key that is not bound to an explicit creator selection", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com",
}, async () => {
  const service = loadService();
  const existing = { id: "legacy", agencyId: "agency-1", provider: "NOWPAYMENTS", status: "CHECKOUT_CREATED", testMode: true, checkoutKey: "legacy_key_1234567890", requestHash: null, providerInvoiceUrl: "https://nowpayments.io/payment/?iid=legacy" };
  const db = { billingOrder: { findUnique: async () => existing } };
  await assert.rejects(service.createCheckout({ agencyId: "agency-1", actorUserId: "owner", checkoutKey: existing.checkoutKey, selection: { billingPeriod: "MONTHLY", creators: [{ creatorId: "c1", tier: "STARTER", aiChatterEnabled: false, outreachEnabled: false }] }, db }), (err) => err?.code === "BILLING_LEGACY_CHECKOUT_KEY");
}));

test("V13.3 activation extends only order-line creators and leaves an unselected creator entitlement unchanged", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "1", NODE_ENV: "test",
}, async () => {
  const db = makeProcessingDb();
  const untouchedUntil = new Date("2027-01-01T00:00:00Z");
  db._entitlements.set("creator-2", { id: "ent-2", agencyId: "agency-1", creatorId: "creator-2", tier: "PRO", coreValidFrom: new Date("2026-01-01T00:00:00Z"), coreValidUntil: untouchedUntil, aiChatterValidUntil: null, outreachValidUntil: null, coreLastOrderId: "older-order" });
  const service = loadService(db);
  const payload = { payment_id: "payment-selected-only", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  const result = await service.applyProviderPayment(payload, { signature: "sig-selected", signatureVerified: true, db });
  assert.equal(result.activation.activated, true);
  assert.equal(db._entitlements.has("creator-1"), true);
  assert.equal(db._entitlements.get("creator-1").coreSource, "PAYMENT");
  assert.equal(db._entitlements.get("creator-1").corePriceCents, 2000);
  assert.equal(db._entitlements.get("creator-2").coreValidUntil.toISOString(), untouchedUntil.toISOString());
  assert.equal(db._entitlements.get("creator-2").coreLastOrderId, "older-order");
}));

test("V13.3 refund rolls back only entitlements last granted by that order", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "1", NODE_ENV: "test",
}, async () => {
  const db = makeProcessingDb();
  const service = loadService(db);
  const paid = { payment_id: "payment-refund", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  await service.applyProviderPayment(paid, { signature: "sig-paid-refund", signatureVerified: true, db });
  assert.ok(db._entitlements.get("creator-1")?.coreValidUntil);
  const refunded = { ...paid, payment_status: "refunded" };
  const result = await service.applyProviderPayment(refunded, { signature: "sig-refunded", signatureVerified: true, db });
  assert.equal(result.order.status, "REFUNDED");
  assert.equal(db._entitlements.get("creator-1")?.coreValidUntil, null);
  assert.ok([...db._lines.values()][0].refundedAt instanceof Date);
}));

test("V13.3 can activate a pre-migration V13.2 paid order by materializing immutable lines from pricingSnapshot", async () => withEnv({
  NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_API_KEY: "key", NOWPAYMENTS_IPN_SECRET: "secret", PUBLIC_BASE_URL: "https://api.example.com", NOWPAYMENTS_SANDBOX_ACTIVATE: "1", NODE_ENV: "test",
}, async () => {
  const db = makeProcessingDb();
  db._lines.clear();
  const service = loadService(db);
  const payload = { payment_id: "payment-legacy-v132", payment_status: "finished", order_id: "order-1", invoice_id: "invoice-1", price_amount: 20, price_currency: "usd" };
  const result = await service.applyProviderPayment(payload, { signature: "sig-legacy", signatureVerified: true, db });
  assert.equal(result.activation.activated, true);
  assert.equal(db._lines.size, 1);
  assert.equal([...db._lines.values()][0].creatorId, "creator-1");
  assert.equal(db._entitlements.get("creator-1").coreLastOrderId, "order-1");
}));

test("V13.3 expiry reconciliation marks a paid workspace PAST_DUE only when no creator entitlement remains active", async () => {
  const now = new Date("2026-09-01T00:00:00Z");
  let subscriptionStatus = "ACTIVE";
  let agencyStatus = "ACTIVE";
  const subscription = { id: "sub-expired", agencyId: "agency-1", status: "ACTIVE", billingMode: "CRYPTO", currentPeriodEnd: new Date("2026-08-31T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") };
  const db = {
    agencySubscription: {
      findMany: async () => [{ ...subscription }],
      findFirst: async () => ({ ...subscription }),
      update: async ({ data }) => { subscriptionStatus = data.status || subscriptionStatus; return { ...subscription, ...data }; },
    },
    creatorBillingEntitlement: { findFirst: async () => null },
    agency: { update: async ({ data }) => { agencyStatus = data.status || agencyStatus; return { id: "agency-1", ...data }; } },
  };
  db.$transaction = async (fn) => fn(db);
  const service = loadEntitlementService(db);
  const result = await service.reconcileExpiredBillingStates({ now, db });
  assert.deepEqual(result, { scanned: 1, expired: 1, repaired: 0 });
  assert.equal(subscriptionStatus, "PAST_DUE");
  assert.equal(agencyStatus, "PAST_DUE");
});

test("V13.3 expiry reconciliation repairs a stale agency period from the latest active per-creator entitlement", async () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const activeUntil = new Date("2026-10-15T00:00:00Z");
  let write = null;
  const subscription = { id: "sub-stale", agencyId: "agency-1", status: "ACTIVE", billingMode: "CRYPTO", currentPeriodEnd: new Date("2026-08-31T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") };
  const db = {
    agencySubscription: { findMany: async () => [{ ...subscription }], findFirst: async () => ({ ...subscription }), update: async ({ data }) => { write = { ...data }; return { ...subscription, ...data }; } },
    creatorBillingEntitlement: { findFirst: async () => ({ creatorId: "creator-1", agencyId: "agency-1", coreValidUntil: activeUntil }) },
    agency: { update: async () => ({ id: "agency-1" }) },
  };
  db.$transaction = async (fn) => fn(db);
  const service = loadEntitlementService(db);
  const result = await service.reconcileExpiredBillingStates({ now, db });
  assert.deepEqual(result, { scanned: 1, expired: 0, repaired: 1 });
  assert.equal(write.status, "ACTIVE");
  assert.equal(write.currentPeriodEnd.toISOString(), activeUntil.toISOString());
});

test("V13.3 migration relationalizes legacy V13 order lines, backfills paid creator access first and never revives an expired legacy period", () => {
  assert.match(entitlementMigrationSource, /INSERT INTO "BillingOrderLine"/);
  assert.match(entitlementMigrationSource, /ON CONFLICT \("orderId", "creatorId"\) DO NOTHING/);
  assert.match(entitlementMigrationSource, /jsonb_array_elements\(COALESCE\(o\."pricingSnapshot"->'lines'/);
  assert.match(entitlementMigrationSource, /o\."status" = 'PAID'/);
  assert.match(entitlementMigrationSource, /o\."activatedAt" IS NOT NULL/);
  assert.match(entitlementMigrationSource, /ls\."currentPeriodEnd" > CURRENT_TIMESTAMP/);
  assert.match(entitlementMigrationSource, /JOIN "CreatorBillingProfile" bp/);
  assert.match(entitlementMigrationSource, /ls\."billingMode" <> 'FREE_INTERNAL'/);
  assert.match(entitlementMigrationSource, /'PAYMENT'::"BillingEntitlementSource"/);
  assert.match(entitlementMigrationSource, /'LEGACY'::"BillingEntitlementSource"/);
});

test("V13.3.1 refund never resurrects a payment predecessor that was already refunded", async () => {
  const activatedA = new Date("2026-08-01T00:00:00Z");
  const activatedB = new Date("2026-08-10T00:00:00Z");
  const aUntil = new Date("2026-09-01T00:00:00Z");
  const bUntil = new Date("2026-10-01T00:00:00Z");
  const lines = [
    { id: "line-a", orderId: "order-a", agencyId: "agency-1", creatorId: "creator-1", tier: "STARTER", corePriceCents: 2000, coreGrantedUntil: aUntil, activatedAt: activatedA, refundedAt: new Date("2026-08-20T00:00:00Z") },
    { id: "line-b", orderId: "order-b", agencyId: "agency-1", creatorId: "creator-1", tier: "GROWTH", corePriceCents: 3500, previousTier: "STARTER", corePreviousSource: "PAYMENT", corePreviousPriceCents: 2000, corePreviousValidUntil: aUntil, coreGrantedUntil: bUntil, activatedAt: activatedB, refundedAt: null },
  ];
  let entitlement = { id: "ent-1", agencyId: "agency-1", creatorId: "creator-1", tier: "GROWTH", coreSource: "PAYMENT", corePriceCents: 3500, coreValidUntil: bUntil, coreLastOrderId: "order-b" };
  const orders = new Map([
    ["order-a", { id: "order-a", status: "REFUNDED", paidAt: activatedA, activatedAt: activatedA }],
    ["order-b", { id: "order-b", status: "REFUNDED", paidAt: activatedB, activatedAt: activatedB }],
  ]);
  const db = {
    billingOrder: { findUnique: async ({ where }) => { const row = orders.get(where.id); return row ? { ...row, agencyId: "agency-1" } : null; } },
    billingOrderLine: {
      findMany: async ({ where }) => lines.filter((row) => row.orderId === where.orderId).map((row) => ({ ...row })),
      findFirst: async ({ where }) => {
        const rows = lines.filter((row) => row.creatorId === where.creatorId && row.orderId !== where.orderId.not && row.activatedAt && !row.refundedAt && row.coreGrantedUntil && orders.get(row.orderId)?.status === "PAID");
        const row = rows.sort((a, b) => b.activatedAt - a.activatedAt)[0];
        return row ? { ...row, order: orders.get(row.orderId) } : null;
      },
      update: async ({ where, data }) => { const row = lines.find((candidate) => candidate.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    creatorBillingEntitlement: {
      findUnique: async () => ({ ...entitlement }),
      update: async ({ data }) => { entitlement = { ...entitlement, ...data }; return { ...entitlement }; },
      findFirst: async () => null,
    },
    agencySubscription: { findFirst: async () => ({ id: "sub-1", agencyId: "agency-1", status: "ACTIVE", billingMode: "CRYPTO", currentPeriodEnd: bUntil }), update: async ({ data }) => data },
    agency: { update: async ({ data }) => data },
  };
  db.$transaction = async (fn) => fn(db);
  const service = loadEntitlementService(db);
  await service.refundOrderEntitlements({ order: { id: "order-b", agencyId: "agency-1", activatedAt: activatedB }, db });
  assert.equal(entitlement.coreValidUntil, null);
  assert.equal(entitlement.coreLastOrderId, null);
  assert.equal(entitlement.coreSource, "LEGACY");
});

test("V13.3.1 refund restores the latest still-paid predecessor but preserves a later admin tier edit", async () => {
  const activatedA = new Date("2026-08-01T00:00:00Z");
  const activatedB = new Date("2026-08-10T00:00:00Z");
  const aUntil = new Date("2026-09-01T00:00:00Z");
  const bUntil = new Date("2026-10-01T00:00:00Z");
  const lines = [
    { id: "line-a", orderId: "order-a", agencyId: "agency-1", creatorId: "creator-1", tier: "STARTER", corePriceCents: 2000, coreGrantedUntil: aUntil, activatedAt: activatedA, refundedAt: null },
    { id: "line-b", orderId: "order-b", agencyId: "agency-1", creatorId: "creator-1", tier: "GROWTH", corePriceCents: 3500, previousTier: "STARTER", corePreviousSource: "PAYMENT", corePreviousPriceCents: 2000, corePreviousValidUntil: aUntil, coreGrantedUntil: bUntil, activatedAt: activatedB, refundedAt: null },
  ];
  let entitlement = { id: "ent-1", agencyId: "agency-1", creatorId: "creator-1", tier: "ELITE", coreSource: "PAYMENT", corePriceCents: 3500, coreValidUntil: bUntil, coreLastOrderId: "order-b" };
  const orders = new Map([
    ["order-a", { id: "order-a", status: "PAID", paidAt: activatedA, activatedAt: activatedA }],
    ["order-b", { id: "order-b", status: "REFUNDED", paidAt: activatedB, activatedAt: activatedB }],
  ]);
  const db = {
    billingOrder: { findUnique: async ({ where }) => { const row = orders.get(where.id); return row ? { ...row, agencyId: "agency-1" } : null; } },
    billingOrderLine: {
      findMany: async ({ where }) => lines.filter((row) => row.orderId === where.orderId).map((row) => ({ ...row })),
      findFirst: async ({ where }) => {
        const rows = lines.filter((row) => row.creatorId === where.creatorId && row.orderId !== where.orderId.not && row.activatedAt && !row.refundedAt && row.coreGrantedUntil && orders.get(row.orderId)?.status === "PAID");
        const row = rows.sort((a, b) => b.activatedAt - a.activatedAt)[0];
        return row ? { ...row, order: orders.get(row.orderId) } : null;
      },
      update: async ({ where, data }) => { const row = lines.find((candidate) => candidate.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    creatorBillingEntitlement: {
      findUnique: async () => ({ ...entitlement }),
      update: async ({ data }) => { entitlement = { ...entitlement, ...data }; return { ...entitlement }; },
      findFirst: async ({ where }) => where.creator?.deletedAt === null && entitlement.coreValidUntil > where.coreValidUntil.gt ? ({ ...entitlement }) : null,
    },
    agencySubscription: { findFirst: async () => ({ id: "sub-1", agencyId: "agency-1", status: "ACTIVE", billingMode: "CRYPTO", currentPeriodEnd: bUntil }), update: async ({ data }) => data },
    agency: { update: async ({ data }) => data },
  };
  db.$transaction = async (fn) => fn(db);
  const service = loadEntitlementService(db);
  await service.refundOrderEntitlements({ order: { id: "order-b", agencyId: "agency-1", activatedAt: activatedB }, db });
  assert.equal(entitlement.coreLastOrderId, "order-a");
  assert.equal(entitlement.coreValidUntil.toISOString(), aUntil.toISOString());
  assert.equal(entitlement.corePriceCents, 2000);
  assert.equal(entitlement.coreSource, "PAYMENT");
  assert.equal(entitlement.tier, "ELITE");
});

test("V13.3.1 aggregate lookup excludes soft-deleted creators", async () => {
  const now = new Date("2026-09-01T00:00:00Z");
  let entitlementWhere = null;
  const subscription = { id: "sub-1", agencyId: "agency-1", status: "ACTIVE", billingMode: "CRYPTO", currentPeriodEnd: new Date("2026-08-31T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") };
  const db = {
    agencySubscription: { findFirst: async () => ({ ...subscription }), update: async ({ data }) => ({ ...subscription, ...data }) },
    creatorBillingEntitlement: { findFirst: async ({ where }) => { entitlementWhere = where; return null; } },
    agency: { update: async ({ data }) => ({ id: "agency-1", ...data }) },
  };
  const service = loadEntitlementService(db);
  const result = await service.syncAgencyBillingAggregate(db, "agency-1", now);
  assert.equal(result.status, "PAST_DUE");
  assert.deepEqual(entitlementWhere.creator, { deletedAt: null });
});

test("V13.3.1 repair migration activates migrated lines and makes already-refunded legacy owners fail closed", () => {
  assert.match(entitlementRepairMigrationSource, /UPDATE "BillingOrderLine" l[\s\S]*"activatedAt" = o\."activatedAt"/);
  assert.match(entitlementRepairMigrationSource, /"coreGrantedUntil" = e\."coreValidUntil"/);
  assert.match(entitlementRepairMigrationSource, /e\."coreLastOrderId" = o\."id"[\s\S]*o\."status" = 'REFUNDED'/);
  assert.match(entitlementRepairMigrationSource, /"coreValidUntil" = NULL/);
  assert.match(entitlementRepairMigrationSource, /"refundedAt" = COALESCE/);
  for (const destructive of [/DROP TABLE/i, /DROP COLUMN/i, /TRUNCATE/i, /DELETE FROM/i]) assert.doesNotMatch(entitlementRepairMigrationSource, destructive);
});

test("V13.3.2 billing entitlement mutations serialize on the agency row before touching creator grants", async () => {
  const service = loadEntitlementService({});
  const calls = [];
  await service.lockAgencyBillingMutation({
    $queryRawUnsafe: async (sql, agencyId) => { calls.push({ sql, agencyId }); return [{ id: agencyId }]; },
  }, "agency-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agencyId, "agency-1");
  assert.match(calls[0].sql, /SELECT "id" FROM "Agency" WHERE "id" = \$1 FOR UPDATE/);
  assert.match(entitlementServiceSource, /await lockAgencyBillingMutation\(tx, identity\.agencyId\);[\s\S]*?billingOrder\.findUnique[\s\S]*?order\.status !== "PAID"[\s\S]*?ensureOrderLines\(tx, order\)/);
  assert.match(entitlementServiceSource, /where: \{ id: orderId, status: "PAID", activatedAt: null \}/);
  assert.match(entitlementServiceSource, /refundOrderEntitlements[\s\S]*?await lockAgencyBillingMutation\(tx, agencyId\);[\s\S]*?billingOrder\.findUnique[\s\S]*?currentOrder\.status !== "REFUNDED"[\s\S]*?billingOrderLine\.findMany/);
  assert.match(entitlementServiceSource, /syncAgencyBillingAggregate[\s\S]*?await lockAgencyBillingMutation\(tx, agencyId\)/);
});

test("V13.3.2 admin dated-access edits and creator deletion join the same agency billing lock", () => {
  const entitlementRoute = adminSource.match(/router\.patch\("\/creators\/:id\/entitlement"[\s\S]*?return res\.json\(\{ ok: true, entitlement:[\s\S]*?\n\}\);/)?.[0] || "";
  const deleteRoute = adminSource.match(/router\.delete\("\/creators\/:id"[\s\S]*?return res\.json\(\{ ok: true, hard, deleted: before \}\);/)?.[0] || "";
  assert.match(adminSource, /lockAgencyBillingMutation/);
  assert.match(entitlementRoute, /await lockAgencyBillingMutation\(tx, identity\.agencyId\)/);
  assert.match(entitlementRoute, /tx\.creatorAccount\.findUnique/);
  assert.match(deleteRoute, /await lockAgencyBillingMutation\(tx, before\.agencyId\)/);
});

test("V13.3.2 concurrent provider status update cannot regress REFUNDED back to PAID from a stale finished snapshot", async () => {
  const service = loadService();
  let current = {
    id: "order-race", agencyId: "agency-1", status: "PAID", amountCents: 2000, currency: "USD",
    providerInvoiceId: "invoice-race", providerStatus: "finished", testMode: true,
    paidAt: new Date("2026-08-14T00:00:00Z"), activatedAt: new Date("2026-08-14T00:00:01Z"),
  };
  let writes = 0;
  const db = {
    billingOrder: {
      updateMany: async ({ where, data }) => {
        writes += 1;
        if (writes === 1) {
          // Simulate a concurrent refund committing after this callback read PAID.
          current = { ...current, status: "REFUNDED", providerStatus: "refunded" };
          return { count: 0 };
        }
        if (where.id !== current.id || where.status !== current.status) return { count: 0 };
        current = { ...current, ...data };
        return { count: 1 };
      },
      findUnique: async () => ({ ...current }),
    },
  };
  const payload = { payment_status: "finished", payment_id: "payment-race", invoice_id: "invoice-race", price_amount: 20, price_currency: "usd" };
  const result = await service.updateOrderStatusMonotonically(db, { ...current }, "finished", payload);
  assert.equal(writes, 2);
  assert.equal(result.candidateStatus, "REFUNDED");
  assert.equal(result.order.status, "REFUNDED");
});

test("V13.3.2 activation/refund re-read order state after the agency lock", () => {
  assert.match(entitlementServiceSource, /const identity = await tx\.billingOrder\.findUnique[\s\S]*?await lockAgencyBillingMutation\(tx, identity\.agencyId\);[\s\S]*?const order = await tx\.billingOrder\.findUnique/);
  assert.match(entitlementServiceSource, /where: \{ id: orderId, status: "PAID", activatedAt: null \}/);
  assert.match(entitlementServiceSource, /await lockAgencyBillingMutation\(tx, agencyId\);[\s\S]*?const currentOrder = await tx\.billingOrder\.findUnique[\s\S]*?currentOrder\.status !== "REFUNDED"/);
});

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

test("V13.3.1 expiry scheduler reconciles future ACTIVE aggregates and does not count an unchanged healthy aggregate as repaired", async () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const activeUntil = new Date("2026-10-15T00:00:00Z");
  let findManyArgs = null;
  let updates = 0;
  const subscription = { id: "sub-future", agencyId: "agency-1", status: "ACTIVE", billingMode: "CRYPTO", currentPeriodEnd: activeUntil, createdAt: new Date("2026-01-01T00:00:00Z") };
  const db = {
    agencySubscription: {
      findMany: async (args) => { findManyArgs = args; return [{ ...subscription }]; },
      findFirst: async () => ({ ...subscription }),
      update: async ({ data }) => { updates += 1; return { ...subscription, ...data }; },
    },
    creatorBillingEntitlement: { findFirst: async () => ({ creatorId: "creator-1", agencyId: "agency-1", coreValidUntil: activeUntil }) },
    agency: { update: async () => ({ id: "agency-1" }) },
  };
  db.$transaction = async (fn) => fn(db);
  const service = loadEntitlementService(db);
  const result = await service.reconcileExpiredBillingStates({ now, db });
  assert.deepEqual(result, { scanned: 1, expired: 0, repaired: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(findManyArgs.where, "currentPeriodEnd"), false);
  assert.equal(updates, 1);
});


test("V13.3.1 creator soft/hard delete recomputes billing aggregate in the delete transaction", () => {
  const deleteRoute = adminSource.match(/router\.delete\("\/creators\/:id"[\s\S]*?return res\.json\(\{ ok: true, hard, deleted: before \}\);/)?.[0] || "";
  assert.match(deleteRoute, /prisma\.\$transaction/);
  assert.match(deleteRoute, /syncAgencyBillingAggregate\(tx, before\.agencyId, deletedAt\)/);
  assert.match(deleteRoute, /tx\.creatorAccount\.update/);
  assert.match(deleteRoute, /tx\.creatorAccount\.delete/);
});
