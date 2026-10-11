"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createAdminSqlRuntime } = require("../test-support/admin-sql-runtime.cjs");
const service = require("../../src/services/billing-nowpayments-service");
const writes = require("../../src/services/database-write-contract-service");
const result = { ok: false, nativePostgres: false, externalProviders: false, productionAccessed: false,
  engine: "Current SQL + Prisma + PGlite; deterministic interruption boundaries", cases: [] };
Object.assign(process.env, { NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_SANDBOX_ACTIVATE: "true",
  NOWPAYMENTS_API_KEY: "isolated-proof", NOWPAYMENTS_IPN_SECRET: "isolated-event-proof", PUBLIC_BASE_URL: "https://proof.example.test" });
function proxy(target, replacements) {
  return new Proxy(target, { get(object, key) {
    if (Object.hasOwn(replacements, key)) return replacements[key];
    const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
  } });
}
function transactionPort(db, change, afterFailure) {
  return proxy(db, { $transaction: async (work, options) => {
    try { return await db.$transaction(tx => work(change(tx)), options); }
    catch (error) { if (afterFailure) await afterFailure(error); throw error; }
  } });
}
async function main() {
  const f = await createAdminSqlRuntime({ runtimePath: process.env.ONLINOD_SQL_PROOF_RUNTIME });
  const db = f.db;
  async function proof(name, work) {
    const evidence = await work(); result.cases.push({ name, ok: true, evidence: evidence || null }); console.log("PASS", name);
  }
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const signature = payload => crypto.createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(stable(payload))).digest("hex");
  const payload = (id, paymentId = `payment-${id}`, status = "finished") => ({ payment_id: paymentId, order_id: id,
    invoice_id: `invoice-${id}`, payment_status: status, price_amount: 100, price_currency: "usd", actually_paid: 100 });
  const deliver = (input, client = db) => service.handleNowPaymentsIpn({ payload: input, signature: signature(input), db: client });
  const order = id => db.billingOrder.findUnique({ where: { id } });
  const ledger = id => db.billingWalletTransaction.findMany({ where: { orderId: id }, orderBy: { createdAt: "asc" } });
  const auditCount = id => db.auditLog.count({ where: { targetId: id, action: { in: ["billing.payment_finished", "billing.payment_refunded"] } } });
  async function seed(id, { agencyId = "agency-a", testMode = true, subscription = false } = {}) {
    return db.billingOrder.create({ data: { id, agencyId, testMode, purpose: subscription ? "SUBSCRIPTION" : "WALLET_TOP_UP",
      amountCents: 10000, currency: "USD", billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: subscription ? 1 : 0,
      pricingSnapshot: subscription ? { lines: [{ creatorId: "creator-a", creatorName: "Proof creator", tier: "STARTER",
        corePriceCents: 10000, monthlyCents: 10000, lineTotalCents: 10000, aiChatterEnabled: false, outreachEnabled: false }] } : {},
      providerInvoiceId: `invoice-${id}`, status: "CHECKOUT_CREATED" } });
  }
  async function assertUnsettled(id) {
    assert.equal((await order(id)).status, "CHECKOUT_CREATED");
    assert.equal((await order(id)).activatedAt, null);
    assert.equal((await ledger(id)).length, 0);
    assert.equal(await db.billingPaymentAttempt.count({ where: { orderId: id } }), 0);
    assert.equal(await auditCount(id), 0);
  }
  try {
    await db.$queryRawUnsafe("SELECT 1 AS ready");
    await db.$transaction(async tx => {
      await writes.assertTeamControlPlaneWriteAdmission(tx); await writes.authorizeCreatorAccountWrite(tx);
      for (const id of ["agency-a", "agency-b"]) {
        await tx.agency.create({ data: { id, name: id } });
        await tx.user.create({ data: { id: `${id}-owner`, email: `${id}@example.test`, passwordHash: "synthetic" } });
        await tx.agencyMember.create({ data: { agencyId: id, userId: `${id}-owner`, role: "OWNER", roleKey: "owner" } });
      }
      await tx.creatorAccount.create({ data: { id: "creator-a", agencyId: "agency-a", displayName: "Proof creator", status: "READY" } });
    });
    assert.equal(await db.agency.count(), 2);

    await proof("Invalid signature cannot create a receipt or change money", async () => {
      await seed("signed");
      await assert.rejects(service.handleNowPaymentsIpn({ payload: payload("signed"), signature: "invalid", db }), { code: "NOWPAYMENTS_IPN_SIGNATURE_INVALID" });
      await assertUnsettled("signed"); assert.equal(await db.billingProviderEvent.count(), 0);
    });
    await proof("A signed top-up and its exact-byte retry produce one receipt, credit and audit", async () => {
      const first = await deliver(payload("signed"));
      const second = await deliver(payload("signed"));
      assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
      assert.equal((await ledger("signed")).length, 1); assert.equal(await auditCount("signed"), 1);
      assert.equal(await db.billingProviderEvent.count({ where: { orderId: "signed" } }), 1);
      assert.equal(Number((await ledger("signed"))[0].amountCents), 10000);
      return { receipts: 1, credits: 1, audits: 1 };
    });
    await proof("Overlapping deliveries of the same event converge to one financial result", async () => {
      await seed("overlap");
      const replies = await Promise.all(Array.from({ length: 8 }, () => deliver(payload("overlap"))));
      assert.equal(replies.filter(x => !x.duplicate).length, 1);
      assert.equal(await auditCount("overlap"), 1); assert.equal((await ledger("overlap")).length, 1);
      return { deliveries: 8, duplicates: 7, physicalSqlSessions: 1 };
    });
    await proof("A provider payment already bound to another agency cannot credit a second order", async () => {
      await seed("other", { agencyId: "agency-b" });
      await assert.rejects(deliver(payload("other", "payment-signed")), { code: "BILLING_PROVIDER_PAYMENT_ORDER_MISMATCH" });
      await assertUnsettled("other");
      assert.equal(await db.agencyBillingWallet.count({ where: { agencyId: "agency-b" } }), 0);
    });
    await proof("The unique payment row rejects a stale pre-read and rolls back attempted metadata changes", async () => {
      await seed("stale", { agencyId: "agency-b" });
      const before = await db.billingPaymentAttempt.findFirst({ where: { orderId: "signed" } });
      let hidden = false;
      const stale = transactionPort(db, tx => proxy(tx, { billingPaymentAttempt: proxy(tx.billingPaymentAttempt, {
        findUnique: async args => { const found = await tx.billingPaymentAttempt.findUnique(args); if (!hidden) { hidden = true; return null; } return found; },
      }) }));
      await assert.rejects(deliver({ ...payload("stale", "payment-signed"), actually_paid: 250 }, stale), { code: "BILLING_PROVIDER_PAYMENT_ORDER_MISMATCH" });
      assert.equal(hidden, true); await assertUnsettled("stale");
      const after = await db.billingPaymentAttempt.findFirst({ where: { orderId: "signed" } });
      assert.equal(String(after.actuallyPaid), String(before.actuallyPaid)); assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
      return { controlledStaleRead: true, nativeConcurrentWriter: false };
    });
    await proof("A required audit failure rolls back status, activation, attempt, wallet and receipt completion", async () => {
      await seed("audit-failure"); let failed = false;
      const broken = transactionPort(db, tx => proxy(tx, { auditLog: proxy(tx.auditLog, { create: async args => {
        if (!failed) { failed = true; throw Error("controlled required audit failure"); } return tx.auditLog.create(args);
      } }) }));
      await assert.rejects(deliver(payload("audit-failure"), broken), /controlled required audit/);
      await assertUnsettled("audit-failure");
      const event = await db.billingProviderEvent.findFirst({ where: { payload: { path: ["order_id"], equals: "audit-failure" } } });
      assert.equal(event.processedAt, null); assert.match(event.processingError, /required audit/);
      await deliver(payload("audit-failure")); assert.equal((await ledger("audit-failure")).length, 1); assert.equal(await auditCount("audit-failure"), 1);
    });
    await proof("Failure at the final receipt write cannot leave a committed credit or audit", async () => {
      await seed("receipt-failure"); let failed = false;
      const broken = transactionPort(db, tx => proxy(tx, { billingProviderEvent: proxy(tx.billingProviderEvent, { update: async args => {
        if (!failed && args.data.processedAt) { failed = true; throw Error("controlled final receipt failure"); }
        return tx.billingProviderEvent.update(args);
      } }) }));
      await assert.rejects(deliver(payload("receipt-failure"), broken), /controlled final receipt/);
      await assertUnsettled("receipt-failure");
      await deliver(payload("receipt-failure")); assert.equal((await ledger("receipt-failure")).length, 1); assert.equal(await auditCount("receipt-failure"), 1);
    });
    await proof("A delayed failure report cannot overwrite a successful retry receipt", async () => {
      await seed("late-error"); let failed = false, recovered = false;
      const broken = transactionPort(db, tx => proxy(tx, { auditLog: proxy(tx.auditLog, { create: async args => {
        if (!failed) { failed = true; throw Error("controlled first delivery failure"); } return tx.auditLog.create(args);
      } }) }), async () => { if (!recovered) { recovered = true; await deliver(payload("late-error")); } });
      await assert.rejects(deliver(payload("late-error"), broken), /controlled first delivery/);
      const event = await db.billingProviderEvent.findFirst({ where: { orderId: "late-error" } });
      assert.ok(event.processedAt); assert.equal(event.processingError, null);
      assert.equal((await ledger("late-error")).length, 1); assert.equal(await auditCount("late-error"), 1);
    });
    await proof("Late waiting does not regress a finished order or its payment status", async () => {
      await deliver(payload("signed", "payment-signed", "waiting"));
      assert.equal((await order("signed")).status, "PAID"); assert.equal((await order("signed")).providerStatus, "finished");
      assert.equal((await db.billingPaymentAttempt.findFirst({ where: { orderId: "signed" } })).providerStatus, "finished");
      assert.equal((await ledger("signed")).length, 1);
    });
    await proof("Refund, duplicate refund and delayed finished preserve one reversal and terminal state", async () => {
      await deliver(payload("signed", "payment-signed", "refunded"));
      assert.equal((await deliver(payload("signed", "payment-signed", "refunded"))).duplicate, true);
      await deliver({ ...payload("signed"), updated_at: "later-proof-event" });
      assert.equal((await order("signed")).status, "REFUNDED"); assert.equal((await order("signed")).providerStatus, "refunded");
      assert.equal((await db.billingPaymentAttempt.findFirst({ where: { orderId: "signed" } })).providerStatus, "refunded");
      const entries = await ledger("signed"); assert.equal(entries.length, 2);
      assert.equal(entries.reduce((n, x) => n + BigInt(x.amountCents), 0n), 0n);
    });
    await proof("The same payment id and signed payload in sandbox/live have independent receipts and wallets", async () => {
      for (const testMode of [true, false]) {
        const id = testMode ? "mode-test" : "mode-live";
        await seed(id, { agencyId: "agency-b", testMode });
        await db.billingPaymentAttempt.create({ data: { orderId: id, testMode, providerPaymentId: "same-mode-id", providerStatus: "waiting" } });
      }
      const input = { payment_id: "same-mode-id", payment_status: "finished", price_amount: 100, price_currency: "usd" };
      const sandbox = await deliver(input);
      process.env.NOWPAYMENTS_MODE = "live";
      try {
        const live = await deliver(input); assert.equal(sandbox.duplicate, false); assert.equal(live.duplicate, false);
        assert.equal(live.order.id, "mode-live"); assert.equal(sandbox.order.id, "mode-test");
        assert.equal((await ledger("mode-live")).length, 1); assert.equal((await ledger("mode-test")).length, 1);
      } finally { process.env.NOWPAYMENTS_MODE = "sandbox"; }
    });
    await proof("A subscription projection rolls back all grants if its final receipt cannot commit", async () => {
      await seed("subscription", { subscription: true }); let failed = false;
      const broken = transactionPort(db, tx => proxy(tx, { billingProviderEvent: proxy(tx.billingProviderEvent, { update: async args => {
        if (!failed && args.data.processedAt) { failed = true; throw Error("controlled subscription receipt failure"); }
        return tx.billingProviderEvent.update(args);
      } }) }));
      await assert.rejects(deliver(payload("subscription"), broken), /controlled subscription receipt/);
      await assertUnsettled("subscription"); assert.equal(await db.creatorBillingEntitlement.count(), 0); assert.equal(await db.billingOrderLine.count(), 0);
      await deliver(payload("subscription"));
      const before = await db.creatorBillingEntitlement.findUnique({ where: { creatorId: "creator-a" } });
      assert.ok(before.coreValidUntil); assert.equal(before.coreLastOrderId, "subscription");
      assert.equal((await deliver(payload("subscription"))).duplicate, true);
      const after = await db.creatorBillingEntitlement.findUnique({ where: { creatorId: "creator-a" } });
      assert.equal(after.coreValidUntil.getTime(), before.coreValidUntil.getTime()); assert.equal(await auditCount("subscription"), 1);
    });
    await proof("Subscription refund converges without a second grant or reversal", async () => {
      await deliver(payload("subscription", "payment-subscription", "refunded"));
      const before = await db.creatorBillingEntitlement.findUnique({ where: { creatorId: "creator-a" } });
      await deliver(payload("subscription", "payment-subscription", "refunded"));
      const after = await db.creatorBillingEntitlement.findUnique({ where: { creatorId: "creator-a" } });
      assert.equal(String(after.coreValidUntil), String(before.coreValidUntil));
      assert.equal(await db.billingOrderLine.count({ where: { orderId: "subscription", refundedAt: { not: null } } }), 1);
    });
    result.ok = true;
  } finally {
    if (process.env.ONLINOD_SQL_PROOF_OUTPUT) {
      const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT); fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "billing-events.json"), JSON.stringify(result, null, 2));
    }
    await f.close();
  }
}
const timer = setTimeout(() => { console.error("BILLING_EVENT_PROOF_TIMEOUT"); process.exit(1); }, 120000);
main().then(() => { clearTimeout(timer); console.log(JSON.stringify({ ok: result.ok, cases: result.cases.length })); }, error => {
  clearTimeout(timer); console.error(error); process.exitCode = 1;
});
