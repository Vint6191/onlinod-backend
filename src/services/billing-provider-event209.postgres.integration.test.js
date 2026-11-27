"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHmac } = require("node:crypto");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("PostgreSQL + HTTP: an unresolved signed invoice callback remains retryable after binding, including old receipts", { skip: !enabled }, async () => {
  const db = require("../prisma"), express = require("express");
  const service = require("./billing-nowpayments-service");
  const { assertTeamControlPlaneWriteAdmission } = require("./database-write-contract-service");
  const { cleanupAgencyFixture } = require("../../scripts/test-support/phase2-postgres-integration-authority");
  const agencyId = "payment209-" + randomUUID(), userId = agencyId + "-owner";
  const config = { NOWPAYMENTS_MODE: "sandbox", NOWPAYMENTS_SANDBOX_ACTIVATE: "true", NOWPAYMENTS_API_KEY: "local-proof",
    NOWPAYMENTS_IPN_SECRET: "local-proof-signature", PUBLIC_BASE_URL: "https://proof.example.test" };
  const before = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  let server;
  Object.assign(process.env, config);
  try {
    await db.$transaction(async tx => {
      await assertTeamControlPlaneWriteAdmission(tx);
      await tx.agency.create({ data: { id: agencyId, name: "Unresolved payment regression" } });
      await tx.user.create({ data: { id: userId, email: userId + "@example.test", passwordHash: "synthetic" } });
      await tx.agencyMember.create({ data: { agencyId, userId, role: "OWNER", roleKey: "owner" } });
    });
    const app = express(); app.use(express.json()); app.use("/api/billing", require("../routes/billing"));
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/billing/nowpayments/ipn`;
    for (const legacyProcessed of [false, true]) {
      const id = randomUUID(), invoiceId = "invoice-" + id, paymentId = "payment-" + id;
      const order = await db.billingOrder.create({ data: { agencyId, purpose: "WALLET_TOP_UP", status: "CREATED", amountCents: 10000,
        currency: "USD", billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 0, pricingSnapshot: {}, testMode: true } });
      const payload = { payment_id: paymentId, invoice_id: invoiceId, payment_status: "finished", price_amount: 100,
        price_currency: "usd", pay_currency: "usdttrc20", pay_amount: 100, actually_paid: 100 };
      const signature = createHmac("sha512", config.NOWPAYMENTS_IPN_SECRET).update(service.stableJson(payload)).digest("hex");
      const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-nowpayments-sig": signature }, body: JSON.stringify(payload) });
      const pending = await send(); assert.equal(pending.status, 503); assert.equal((await pending.json()).code, "BILLING_ORDER_BINDING_PENDING");
      const receipt = await db.billingProviderEvent.findFirst({ where: { signature } });
      assert.equal(receipt.processedAt, null); assert.equal(receipt.processingError, "ORDER_NOT_FOUND");
      assert.equal(await db.billingWalletTransaction.count({ where: { orderId: order.id } }), 0);
      if (legacyProcessed) await db.billingProviderEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date() } });
      await db.billingOrder.update({ where: { id: order.id }, data: { providerInvoiceId: invoiceId } });
      const accepted = await send(); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).duplicate, false);
      const duplicate = await send(); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
      const ledger = await db.billingWalletTransaction.findMany({ where: { orderId: order.id } });
      assert.equal(ledger.length, 1); assert.equal(ledger[0].amountCents, 10000n);
      const resolved = await db.billingProviderEvent.findUnique({ where: { id: receipt.id } });
      assert.ok(resolved.processedAt); assert.equal(resolved.processingError, null); assert.equal(resolved.orderId, order.id);
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try { await cleanupAgencyFixture(db, { agencyId, userIds: [userId] }); }
    finally { await db.$disconnect(); }
  }
});
