"use strict";
const { randomUUID } = require("node:crypto");

const PAGE_SIZE = 100;
function bindingError(code, message) { return Object.assign(new Error(message), { code, status: 409, permanent: true }); }
function paymentId(value) {
  const id = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(id)) throw bindingError("BILLING_PROVIDER_PAYMENT_ID_INVALID", "Enter the payment ID shown by NOWPayments");
  return id;
}
function boundPayment(payload, order, expectedId, knownBinding = false) {
  const actual = paymentId(payload?.payment_id ?? payload?.id);
  if (expectedId && actual !== expectedId) throw bindingError("BILLING_PROVIDER_PAYMENT_ID_MISMATCH", "Provider returned a different payment");
  const owner = String(payload?.order_id || ""), invoice = String(payload?.invoice_id || "");
  if (owner && owner !== order.id) throw bindingError("BILLING_PROVIDER_ORDER_MISMATCH", "This payment belongs to another order");
  if (invoice && order.providerInvoiceId && invoice !== order.providerInvoiceId) throw bindingError("BILLING_PROVIDER_INVOICE_MISMATCH", "This payment belongs to another invoice");
  if (!knownBinding && owner !== order.id && (!order.providerInvoiceId || invoice !== order.providerInvoiceId)) throw bindingError("BILLING_PROVIDER_ORDER_BINDING_MISSING", "Provider did not prove which invoice owns this payment");
  return { ...payload, payment_id: actual, order_id: order.id };
}
async function saveProgress(db, orderId, previous, next) {
  // CAS protects pagination from concurrent refresh clicks. Financial facts are
  // independently idempotent; a lost cursor race may re-read a page, never skip it.
  return db.$executeRawUnsafe(`UPDATE "BillingOrder"
    SET "reconciliationState"=jsonb_set(coalesce("reconciliationState",'{}'::jsonb),'{discovery}',$2::jsonb,true), "updatedAt"=now()
    WHERE id=$1 AND coalesce("reconciliationState"->'discovery','null'::jsonb)=$3::jsonb`, orderId, JSON.stringify(next), JSON.stringify(previous || null));
}
async function reconcilePayments({ db, order, cfg, providerPaymentId, request, apply }) {
  const started = Date.now(), deadline = started + 20_000;
  const remaining = () => Math.max(250, deadline - Date.now());
  let checked = 0, discovered = 0, reason = null;
  const errors = [];
  const consume = async (payload, expectedId, knownBinding = false) => {
    await apply(boundPayment(payload, order, expectedId, knownBinding), { signature: null, signatureVerified: false, source: "RECONCILIATION", db });
    checked += 1;
  };
  if (providerPaymentId) {
    const id = paymentId(providerPaymentId);
    await consume(await request(`/payment/${encodeURIComponent(id)}`, { timeoutMs: remaining() }), id);
  }
  const previous = order.reconciliationState?.discovery || null;
  const old = previous && typeof previous === "object" ? previous : {};
  const progress = { ...old };
  const attempts = await db.billingPaymentAttempt.findMany({ where: {
    orderId: order.id, ...(old.attemptCursor ? { id: { gt: old.attemptCursor } } : {}),
  }, orderBy: { id: "asc" }, take: 5 });
  let advancedAttempts = 0;
  for (const attempt of attempts.slice(0, 4)) {
    if (Date.now() >= deadline - 1000) { reason = "PAYMENT_RECONCILIATION_CONTINUES"; break; }
    if (attempt.providerPaymentId !== providerPaymentId) {
      try { await consume(await request(`/payment/${encodeURIComponent(attempt.providerPaymentId)}`, { timeoutMs: remaining() }), attempt.providerPaymentId, true); }
      catch (error) { errors.push(String(error.code || "PAYMENT_RECONCILIATION_FAILED")); }
    }
    progress.attemptCursor = attempt.id; advancedAttempts += 1;
  }
  if (advancedAttempts === attempts.length) progress.attemptCursor = null;
  if (!cfg.reconciliationToken) {
    reason = reason || "PAYMENT_DISCOVERY_AUTH_REQUIRED";
  } else if (Date.now() < deadline - 1000) {
    // Official GET /payment list requires the merchant JWT in addition to the
    // API key. The public invoice endpoint does not expose payment discovery.
    // Source: https://nowpayments.io/blog/how-to-use-your-nowpayments-payment-api-to-the-full-extent
    if (!progress.cycle || progress.complete) {
      const upper = new Date(); upper.setUTCDate(upper.getUTCDate() + 1);
      progress.cycle = randomUUID(); progress.page = 0; progress.rowOffset = 0; progress.complete = false;
      progress.dateFrom = new Date(order.createdAt).toISOString().slice(0, 10);
      progress.dateTo = upper.toISOString().slice(0, 10);
    }
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(progress.page || 0), sortBy: "created_at", orderBy: "asc", dateFrom: progress.dateFrom, dateTo: progress.dateTo });
    const page = await request(`/payment/?${query}`, { headers: { Authorization: `Bearer ${cfg.reconciliationToken}` }, timeoutMs: remaining() });
    const rows = Array.isArray(page?.data) ? page.data : null;
    if (!rows || rows.length > PAGE_SIZE) throw Object.assign(new Error("Invalid payment discovery response"), { code: "NOWPAYMENTS_DISCOVERY_RESPONSE_INVALID", status: 502 });
    let consumedRows = Math.min(rows.length, Number(progress.rowOffset) || 0), matchedThisPage = 0;
    for (let i = consumedRows; i < rows.length; i += 1) {
      if (Date.now() >= deadline - 1000 || matchedThisPage >= 10) break;
      const row = rows[i];
      const belongs = String(row?.order_id || "") === order.id || (!!order.providerInvoiceId && String(row?.invoice_id || "") === order.providerInvoiceId);
      if (belongs) {
        // Invalid bindings stop at their exact row; they are never silently
        // skipped while advancing the durable cursor.
        await consume(row); discovered += 1; matchedThisPage += 1;
      }
      consumedRows = i + 1;
    }
    const returnedLimit = Number(page.limit);
    const effectiveLimit = Number.isInteger(returnedLimit) && returnedLimit > 0 && returnedLimit <= PAGE_SIZE ? returnedLimit : PAGE_SIZE;
    const pageComplete = consumedRows === rows.length;
    progress.rowOffset = pageComplete ? 0 : consumedRows;
    progress.page = Number(progress.page || 0) + (pageComplete ? 1 : 0);
    progress.complete = pageComplete && rows.length < effectiveLimit;
    reason = progress.complete && !progress.attemptCursor ? null : "PAYMENT_RECONCILIATION_CONTINUES";
  } else reason = "PAYMENT_RECONCILIATION_CONTINUES";
  progress.checkedAt = new Date().toISOString();
  progress.retryRequired = errors.length > 0;
  if (errors.length) reason = "PAYMENT_RECONCILIATION_RETRY_REQUIRED";
  await saveProgress(db, order.id, previous, progress);
  return { reconciled: checked > 0, checked, discovered, reason: reason || (checked ? null : "PAYMENT_NOT_FOUND"),
    more: !progress.complete && !!cfg.reconciliationToken || !!progress.attemptCursor || errors.length > 0,
    paymentIdRecoveryAvailable: true };
}
module.exports = { reconcilePayments, boundPayment, paymentId };
