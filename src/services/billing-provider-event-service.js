"use strict";

const { runDbTransaction, lockDbAdvisoryXact } = require("./db-transaction-service");

const COMMIT_OPTIONS = Object.freeze({
  profile: "BILLING_RECOVERY", timeout: 15000, maxWait: 5000, deadlineMs: 20000, maxAttempts: 3,
});

// The inbox survives a failed attempt. Its financial projection, receipt and
// required audit share one commit. There is no network IO in a projection.
async function runBillingProviderEvent({ db, provider, eventKey, paymentId, data, project, replay }) {
  await db.billingProviderEvent.createMany({
    data: [{ provider, eventKey, ...data }], skipDuplicates: true,
  });
  const eventLock = `${provider}:billing-event:${eventKey}`;
  const lockEvent = tx => lockDbAdvisoryXact({ db: tx, key: eventLock });
  try {
    return await runDbTransaction(db, async tx => {
      await lockEvent(tx);
      const event = await tx.billingProviderEvent.findUnique({ where: { eventKey } });
      if (!event) throw Object.assign(new Error("Billing provider inbox receipt is missing"), { code: "BILLING_PROVIDER_RECEIPT_MISSING" });
      if (event.processedAt) return replay(tx, event);
      // This identity is global, before any Agency/order lock. Even callbacks
      // naming different orders must re-read the payment binding after waiting.
      // Sandbox/live rows remain separate in SQL; sharing this narrow lock also
      // avoids choosing a lock namespace from an unverified order snapshot.
      if (paymentId) await lockDbAdvisoryXact({ db: tx, key: `${provider}:billing-payment:${paymentId}` });
      const result = await project(tx, event);
      await tx.billingProviderEvent.update({ where: { id: event.id }, data: {
        processedAt: new Date(), processingError: result.code === "ORDER_NOT_FOUND" ? result.code : null,
      } });
      return result;
    }, COMMIT_OPTIONS);
  } catch (error) {
    const permanent = error?.permanent === true || Number(error?.status) >= 400 && Number(error?.status) < 500;
    // A late failure reporter cannot erase a successful retry. It uses the
    // same event owner and updates only an unfinished receipt.
    await runDbTransaction(db, async tx => {
      await lockEvent(tx);
      await tx.billingProviderEvent.updateMany({ where: { eventKey, processedAt: null }, data: {
        processedAt: permanent ? new Date() : null,
        processingError: String(error?.message || error).slice(0, 500),
      } });
    }, COMMIT_OPTIONS).catch(() => undefined);
    throw error;
  }
}

module.exports = { runBillingProviderEvent };
