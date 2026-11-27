"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { discoveryAuthState, requestPaymentDiscovery } = require("./billing-discovery-auth-service");
const { reconcilePayments } = require("./billing-payment-discovery-service");

const token = (expiresAt = Date.now() + 300_000) => ["header", Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url"), randomUUID()].join(".");
const managedConfig = () => ({ environment: "sandbox", apiKey: "local-key", reconciliationEmail: randomUUID() + "@example.test", reconciliationPassword: "local-only password" });
const listRequest = (cfg, request) => requestPaymentDiscovery({ cfg, request, pathname: "/payment/?page=0", remaining: () => 10_000 });
const rejected = status => Object.assign(new Error("Provider response must not leak credentials"), { providerStatus: status, code: "NOWPAYMENTS_REQUEST_FAILED" });

test("merchant authentication is single-flight, cached and renewed before its five-minute lifetime", async t => {
  let now = Date.now(), authCount = 0, listCount = 0;
  t.mock.method(Date, "now", () => now);
  const cfg = managedConfig();
  const request = async (pathname, options) => {
    if (pathname === "/auth") {
      authCount += 1;
      assert.deepEqual(options.body, { email: cfg.reconciliationEmail, password: cfg.reconciliationPassword });
      await Promise.resolve();
      return { token: token(now + 300_000) };
    }
    assert.match(options.headers.Authorization, /^Bearer /);
    listCount += 1;
    return { data: [] };
  };
  await Promise.all(Array.from({ length: 4 }, () => listRequest(cfg, request)));
  assert.equal(authCount, 1); assert.equal(listCount, 4);
  now += 200_000;
  await listRequest(cfg, request); assert.equal(authCount, 1);
  now += 80_000;
  await listRequest(cfg, request); assert.equal(authCount, 2);
});

test("concurrent 401 responses share one JWT renewal and retry each list once", async () => {
  const cfg = managedConfig();
  let authCount = 0, listCount = 0, firstToken = null;
  const request = async (pathname, options) => {
    if (pathname === "/auth") {
      authCount += 1;
      const jwt = token(); if (authCount === 1) firstToken = jwt;
      return { token: jwt };
    }
    listCount += 1;
    if (options.headers.Authorization === `Bearer ${firstToken}`) throw rejected(401);
    return { data: [] };
  };
  await Promise.all(Array.from({ length: 4 }, () => listRequest(cfg, request)));
  assert.equal(authCount, 2); assert.equal(listCount, 8);
});

test("failed merchant authentication is classified without disclosing provider messages or credentials", async () => {
  const cfg = managedConfig();
  await assert.rejects(() => listRequest(cfg, async () => { throw rejected(401); }), error => {
    assert.equal(error.code, "PAYMENT_DISCOVERY_AUTH_FAILED");
    assert.doesNotMatch(error.message, /Provider response|local-only password/);
    return true;
  });
  let authCount = 0, listCount = 0;
  await assert.rejects(() => listRequest(cfg, async pathname => {
    if (pathname === "/auth") { authCount += 1; return { token: token() }; }
    listCount += 1; throw rejected(403);
  }), { code: "PAYMENT_DISCOVERY_AUTH_FAILED" });
  assert.equal(authCount, 2); assert.equal(listCount, 2);
});

test("expired or provider-rejected static JWT is unavailable until configuration changes", async () => {
  const cfg = { environment: "sandbox", reconciliationToken: token(Date.now() - 1000) };
  assert.deepEqual(discoveryAuthState(cfg), { configured: false, mode: "static", reason: "PAYMENT_DISCOVERY_AUTH_EXPIRED" });
  let calls = 0;
  await assert.rejects(() => listRequest(cfg, async () => { calls += 1; }), { code: "PAYMENT_DISCOVERY_AUTH_EXPIRED" });
  assert.equal(calls, 0);
  cfg.reconciliationToken = token();
  await assert.rejects(() => listRequest(cfg, async () => { calls += 1; throw rejected(401); }), { code: "PAYMENT_DISCOVERY_AUTH_EXPIRED" });
  assert.equal(calls, 1); assert.equal(discoveryAuthState(cfg).configured, false);
  cfg.reconciliationToken = token(); assert.equal(discoveryAuthState(cfg).configured, true);
});

function fixture({ attempts = [], progress = null } = {}) {
  const order = { id: "order-209", providerInvoiceId: "invoice-209", createdAt: new Date("2020-01-01T12:00:00Z"), reconciliationState: { discovery: progress, settledAmountCents: "1234" } };
  const applied = [];
  const db = {
    billingPaymentAttempt: { findMany: async ({ where, take }) => attempts.filter(a => !where.id?.gt || a.id > where.id.gt).slice(0, take) },
    $executeRawUnsafe: async (_sql, id, next, previous) => {
      assert.equal(id, order.id);
      if (JSON.stringify(order.reconciliationState.discovery) !== previous) return 0;
      order.reconciliationState.discovery = JSON.parse(next); return 1;
    },
  };
  const row = (paymentId, extra = {}) => ({ payment_id: paymentId, order_id: order.id, invoice_id: order.providerInvoiceId, payment_status: "finished", ...extra });
  const apply = async payment => { applied.push(payment.payment_id); };
  const run = (cfg, request, providerPaymentId) => reconcilePayments({ db, order: structuredClone(order), cfg, request, apply, providerPaymentId });
  return { order, applied, row, run };
}

test("manual payment-ID recovery does not depend on merchant authentication or discovery availability", async () => {
  for (const cfg of [{}, { reconciliationToken: token(Date.now() - 1000) }, managedConfig()]) {
    const f = fixture(), calls = [];
    const result = await f.run(cfg, async pathname => {
      calls.push(pathname);
      if (pathname === "/payment/manual-payment") return f.row("manual-payment");
      throw rejected(401);
    }, "manual-payment");
    assert.equal(result.reconciled, true); assert.equal(result.checked, 1);
    assert.deepEqual(f.applied, ["manual-payment"]);
    assert.equal(result.paymentIdRecoveryAvailable, true);
    assert.match(result.reason, /^PAYMENT_DISCOVERY_AUTH_/);
    if (!cfg.reconciliationEmail) assert.deepEqual(calls, ["/payment/manual-payment"]);
  }
});

test("listing outage preserves the known-payment continuation and all previously confirmed results", async () => {
  const attempts = Array.from({ length: 6 }, (_, i) => ({ id: "attempt-" + (i + 1), providerPaymentId: "payment-" + (i + 1) }));
  const f = fixture({ attempts }), cfg = { reconciliationToken: token() };
  let listFails = true;
  const request = async pathname => {
    if (pathname.startsWith("/payment/?")) {
      if (listFails) throw rejected(503);
      return { data: [], limit: 100 };
    }
    return f.row(pathname.split("/").at(-1));
  };
  const first = await f.run(cfg, request);
  assert.equal(first.checked, 4); assert.equal(first.more, true);
  assert.equal(first.reason, "PAYMENT_RECONCILIATION_RETRY_REQUIRED");
  assert.equal(f.order.reconciliationState.discovery.attemptCursor, "attempt-4");
  assert.equal(f.order.reconciliationState.settledAmountCents, "1234");
  listFails = false;
  const second = await f.run(cfg, request);
  assert.equal(second.checked, 2); assert.equal(second.more, false);
  assert.equal(f.order.reconciliationState.discovery.attemptCursor, null);
  assert.deepEqual(f.applied, attempts.map(a => a.providerPaymentId));
});

test("invoice filtering discards legacy or changed-scope pagination and keeps the invoice's full lifetime", async () => {
  for (const progress of [
    { cycle: "legacy", page: 12, rowOffset: 7, dateFrom: "2020-01-01", dateTo: "2026-01-01", complete: false },
    { version: 2, scope: "order:order-209", cycle: "unbound", page: 12, rowOffset: 7, dateFrom: "2020-01-01", dateTo: "2026-01-01", complete: false },
  ]) {
    const f = fixture({ progress });
    const result = await f.run({ reconciliationToken: token() }, async pathname => {
      const query = new URL("https://local.test" + pathname).searchParams;
      assert.equal(query.get("invoiceid"), f.order.providerInvoiceId);
      assert.equal(query.get("page"), "0"); assert.equal(query.get("dateFrom"), "2020-01-01");
      return { data: [f.row("new-deposit")], limit: 100 };
    });
    assert.equal(result.discovered, 1); assert.deepEqual(f.applied, ["new-deposit"]);
  }
});

test("a conflicting discovered binding stops at its exact row and cannot consume a foreign payment", async () => {
  const f = fixture(), cfg = { reconciliationToken: token() };
  const rows = [f.row("valid"), f.row("conflict", { invoice_id: "foreign-invoice" }), f.row("last")];
  const request = async () => ({ data: rows, limit: 100 });
  const first = await f.run(cfg, request);
  assert.equal(first.checked, 1); assert.equal(first.reason, "PAYMENT_RECONCILIATION_RETRY_REQUIRED");
  assert.equal(f.order.reconciliationState.discovery.rowOffset, 1);
  await f.run(cfg, request);
  assert.deepEqual(f.applied, ["valid"]);
  assert.equal(f.order.reconciliationState.discovery.rowOffset, 1);
  rows[1] = f.row("corrected");
  const resumed = await f.run(cfg, request);
  assert.equal(resumed.checked, 2); assert.equal(resumed.more, false);
  assert.deepEqual(f.applied, ["valid", "corrected", "last"]);
});

test("bounded row continuation eventually consumes every matching payment without restarting the page", async () => {
  const f = fixture(), cfg = { reconciliationToken: token() }, seenPages = [];
  const rows = Array.from({ length: 23 }, (_, i) => f.row("payment-" + i));
  const request = async pathname => {
    seenPages.push(new URL("https://local.test" + pathname).searchParams.get("page"));
    return { data: rows, limit: 100 };
  };
  assert.equal((await f.run(cfg, request)).more, true);
  assert.equal((await f.run(cfg, request)).more, true);
  assert.equal((await f.run(cfg, request)).more, false);
  assert.deepEqual(seenPages, ["0", "0", "0"]);
  assert.deepEqual(f.applied, rows.map(row => row.payment_id));
});
