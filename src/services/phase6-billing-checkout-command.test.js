"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
function fixture(t) {
  const config = {
    NOWPAYMENTS_MODE: "sandbox",
    NOWPAYMENTS_API_KEY: "synthetic",
    NOWPAYMENTS_IPN_SECRET: "synthetic",
    PUBLIC_BASE_URL: "https://backend.test",
  };
  const old = Object.fromEntries(Object.keys(config).map((k) => [k, process.env[k]]));
  Object.assign(process.env, config);
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const f = { orders: [], calls: 0, authorized: true, epoch: 1, depth: 0, fetch: null };
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  f.db = {
    $executeRawUnsafe: async () => 0,
    $transaction: async (fn) => {
      f.depth++;
      try {
        return await fn({ ...f.db, $transaction: undefined });
      } finally {
        f.depth--;
      }
    },
    agency: { findUnique: async () => ({ id: "agency", name: "Agency", plan: "PRO" }) },
    agencySubscription: { findFirst: async () => ({ billingMode: "MANUAL" }) },
    billingOrder: {
      findUnique: async ({ where }) => {
        const row = f.orders.find((o) => matches(o, where.agencyId_provider_testMode_checkoutKey || where));
        return row ? { ...row } : null;
      },
      create: async ({ data }) => {
        if (
          f.orders.some(
            (o) => o.agencyId === data.agencyId && o.testMode === data.testMode && o.checkoutKey === data.checkoutKey
          )
        )
          throw Object.assign(Error("unique"), { code: "P2002" });
        const row = {
          id: randomUUID(),
          providerInvoiceId: null,
          providerInvoiceUrl: null,
          providerStatus: null,
          ...data,
        };
        f.orders.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of f.orders)
          if (matches(row, where)) {
            Object.assign(row, data);
            count++;
          }
        return { count };
      },
    },
  };
  const original = Module._load;
  Module._load = function (name, parent, main) {
    if (name === "../prisma") return f.db;
    if (name === "./audit-service") return { audit: async () => {} };
    return original.call(this, name, parent, main);
  };
  try {
    delete require.cache[require.resolve("./billing-nowpayments-service")];
    f.service = require("./billing-nowpayments-service");
  } finally {
    Module._load = original;
  }
  global.fetch = async (_url, options) => {
    assert.equal(f.depth, 0, "provider must be outside transactions");
    f.calls++;
    const body = JSON.parse(options.body);
    if (f.fetch) return f.fetch(body);
    return {
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          invoice_id: "invoice-" + body.order_id,
          invoice_url: "https://sandbox.nowpayments.io/payment/" + body.order_id,
          order_id: body.order_id,
          price_amount: body.price_amount,
          price_currency: "usd",
        }),
    };
  };
  f.authorize = async () => {
    if (!f.authorized) throw Object.assign(Error("revoked"), { code: "REVOKED" });
    if (f.epoch !== 1) throw Object.assign(Error("stale"), { code: "STALE" });
  };
  f.input = {
    agencyId: "agency",
    actorUserId: "owner",
    checkoutKey: randomUUID(),
    amountCents: 6000,
    expectedTestMode: true,
    authorize: f.authorize,
    recoverReserved: true,
    db: f.db,
  };
  f.run = (overrides) => f.service.createWalletTopUpCheckout({ ...f.input, ...overrides });
  return f;
}
test("lost response replay returns one invoice and one reservation", async (t) => {
  const f = fixture(t),
    first = await f.run();
  const replay = await f.run();
  assert.equal(f.calls, 1);
  assert.equal(f.orders.length, 1);
  assert.equal(replay.order.id, first.order.id);
  assert.equal(replay.checkoutUrl, first.checkoutUrl);
  assert.equal(replay.replayed, true);
});
for (const state of ["PROCESSING", "PARTIALLY_PAID", "PAID", "REFUNDED", "EXPIRED", "FAILED", "CANCELLED"]) {
  test(`late invoice success preserves ${state}`, async (t) => {
    const f = fixture(t);
    f.fetch = async (body) => {
      Object.assign(f.orders[0], { status: state, providerStatus: "newer-status" });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            invoice_id: "id",
            invoice_url: "https://sandbox.nowpayments.io/payment/id",
            order_id: body.order_id,
          }),
      };
    };
    const r = await f.run();
    assert.equal(r.order.status, state);
    assert.equal(r.order.providerStatus, "newer-status");
    assert.equal(r.order.providerInvoiceId, "id");
    if (!["PROCESSING", "PARTIALLY_PAID"].includes(state)) assert.equal(r.checkoutUrl, "");
  });
  test(`late invoice failure preserves ${state}`, async (t) => {
    const f = fixture(t);
    f.fetch = async () => {
      Object.assign(f.orders[0], { status: state, providerStatus: "newer-status" });
      throw Error("lost response");
    };
    const r = await f.run();
    assert.equal(r.order.status, state);
    assert.equal(r.order.providerStatus, "newer-status");
    await f.run();
    assert.equal(f.calls, 1);
  });
}
test("timeout keeps unknown outcome, never repeats invoice POST after restart", async (t) => {
  const f = fixture(t);
  f.fetch = async () => {
    throw Error("timeout");
  };
  const first = await f.run();
  assert.equal(first.order.status, "CREATED");
  assert.equal(first.order.providerStatus, "INVOICE_OUTCOME_UNKNOWN");
  assert.equal(first.checkoutUrl, "");
  assert.match(first.recoveryNote, /not.*confirmed/);
  await f.run();
  assert.equal(f.calls, 1);
});
test("concurrent replay while provider is blocked observes reservation without submitting", async (t) => {
  const f = fixture(t);
  let unblock, entered;
  const started = new Promise((r) => (entered = r));
  f.fetch = async () => {
    entered();
    await new Promise((r) => (unblock = r));
    throw Error("lost");
  };
  const first = f.run();
  await started;
  const second = await f.run();
  assert.equal(second.order.status, "CREATED");
  assert.equal(f.calls, 1);
  unblock();
  await first;
  assert.equal(f.calls, 1);
});
test("existing failed sandbox order cannot be reset and reissued", async (t) => {
  const f = fixture(t);
  await f.run();
  Object.assign(f.orders[0], { status: "FAILED", providerInvoiceId: null, providerInvoiceUrl: null });
  await f.run();
  assert.equal(f.calls, 1);
  assert.equal(f.orders[0].status, "FAILED");
});
test("changed amount, actor or provider mode cannot repurpose UUID", async (t) => {
  const f = fixture(t);
  await f.run();
  await assert.rejects(() => f.run({ amountCents: 7000 }), { code: "BILLING_CHECKOUT_SELECTION_MISMATCH" });
  await assert.rejects(() => f.run({ actorUserId: "another-owner" }), { code: "BILLING_CHECKOUT_ACTOR_MISMATCH" });
  process.env.NOWPAYMENTS_MODE = "live";
  await assert.rejects(() => f.run({ expectedTestMode: false }), { code: "BILLING_PROVIDER_ENVIRONMENT_MISMATCH" });
  assert.equal(f.calls, 1);
});
test("provider mode switch recovers old order without exposing its checkout URL", async (t) => {
  const f = fixture(t);
  await f.run();
  process.env.NOWPAYMENTS_MODE = "live";
  const r = await f.run();
  assert.equal(r.checkoutUrl, "");
  assert.equal(r.order.providerInvoiceUrl, null);
  assert.equal(f.calls, 1);
});
test("stale mode before reservation cannot become a live invoice", async (t) => {
  const f = fixture(t);
  process.env.NOWPAYMENTS_MODE = "live";
  await assert.rejects(() => f.run(), { code: "BILLING_PROVIDER_ENVIRONMENT_MISMATCH" });
  assert.equal(f.orders.length, 0);
  assert.equal(f.calls, 0);
});
test("revoked owner cannot create, replay, or receive a late checkout URL", async (t) => {
  const f = fixture(t);
  f.authorized = false;
  await assert.rejects(() => f.run(), { code: "REVOKED" });
  assert.equal(f.orders.length, 0);
  f.authorized = true;
  await f.run();
  f.authorized = false;
  await assert.rejects(() => f.run(), { code: "REVOKED" });
  f.authorized = true;
  f.fetch = async () => {
    f.authorized = false;
    throw Error("lost");
  };
  await assert.rejects(() => f.run({ checkoutKey: randomUUID() }), { code: "REVOKED" });
  assert.equal(f.calls, 2);
});
test("epoch change while provider runs persists invoice but refuses presentation", async (t) => {
  const f = fixture(t);
  f.fetch = async () => {
    f.epoch++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ invoice_id: "id", invoice_url: "https://sandbox.nowpayments.io/payment/id" }),
    };
  };
  await assert.rejects(() => f.run(), { code: "STALE" });
  assert.equal(f.orders[0].status, "CHECKOUT_CREATED");
  assert.equal(f.calls, 1);
});
for (const reply of [
  { invoice_id: "id", invoice_url: "https://nowpayments.io/payment/id" },
  { invoice_id: "id", invoice_url: "https://sandbox.nowpayments.io/payment/id", price_amount: 500 },
  { unexpected: true },
])
  test("invalid invoice reply leaves recoverable uncertainty without repeat", async (t) => {
    const f = fixture(t);
    f.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(reply) });
    const r = await f.run();
    assert.equal(r.checkoutUrl, "");
    assert.equal(r.order.status, "CREATED");
    assert.equal(r.order.providerStatus, "INVOICE_OUTCOME_UNKNOWN");
    await f.run();
    assert.equal(f.calls, 1);
  });
test("database loss after invoice acceptance retains one reservation for recovery", async (t) => {
  const f = fixture(t);
  const original = f.db.billingOrder.updateMany;
  let once = true;
  f.db.billingOrder.updateMany = async (args) => {
    if (once) {
      once = false;
      throw Error("disk failure");
    }
    return original(args);
  };
  const r = await f.run();
  assert.equal(r.order.status, "CREATED");
  assert.equal(r.checkoutUrl, "");
  await f.run();
  assert.equal(f.calls, 1);
});
