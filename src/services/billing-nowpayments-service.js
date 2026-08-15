"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { audit } = require("./audit-service");
const { normalizeSelection, periodMonths, priceCreatorSelection } = require("./billing-catalog-service");
const { activatePaidOrderEntitlements, refundOrderEntitlements } = require("./billing-entitlement-service");
const { creditPaidTopUp, refundTopUp } = require("./billing-wallet-service");

const PROVIDER = "NOWPAYMENTS";
const PROCESSING_STATUSES = new Set(["waiting", "confirming", "confirmed", "sending"]);

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function isPublicHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return false;
    const parts = host.split(".");
    if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
      const octets = parts.map(Number);
      if (octets.some((n) => n < 0 || n > 255)) return false;
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function providerConfig() {
  const environment = clean(process.env.NOWPAYMENTS_MODE || "disabled", 20).toLowerCase();
  const apiKey = clean(process.env.NOWPAYMENTS_API_KEY, 500);
  const ipnSecret = clean(process.env.NOWPAYMENTS_IPN_SECRET, 500);
  const sandbox = environment === "sandbox";
  const live = environment === "live";
  const expectedApiBase = live ? "https://api.nowpayments.io/v1" : sandbox ? "https://api-sandbox.nowpayments.io/v1" : "";
  const explicitBase = clean(process.env.NOWPAYMENTS_API_BASE, 500).replace(/\/+$/, "");
  const apiBase = explicitBase || expectedApiBase;
  const apiBaseValid = !!expectedApiBase && apiBase === expectedApiBase;
  const publicBaseUrl = clean(process.env.PUBLIC_BASE_URL || process.env.API_PUBLIC_URL, 1000).replace(/\/+$/, "");
  const publicUrlValid = isPublicHttpsUrl(publicBaseUrl);
  const timeoutRaw = Number(process.env.NOWPAYMENTS_TIMEOUT_MS || 15_000);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(3_000, Math.min(60_000, timeoutRaw)) : 15_000;
  const configured = (sandbox || live) && !!apiKey && !!ipnSecret && apiBaseValid && publicUrlValid;
  return {
    provider: PROVIDER,
    environment,
    sandbox,
    live,
    apiKey,
    ipnSecret,
    apiBase,
    apiBaseValid,
    publicBaseUrl,
    publicUrlValid,
    configured,
    feePaidByUser: boolEnv("NOWPAYMENTS_FEE_PAID_BY_USER", false),
    sandboxActivationEnabled: sandbox && boolEnv("NOWPAYMENTS_SANDBOX_ACTIVATE", process.env.NODE_ENV !== "production"),
    timeoutMs,
  };
}

function publicProviderConfig() {
  const cfg = providerConfig();
  const missing = [];
  if (!cfg.apiKey) missing.push("NOWPAYMENTS_API_KEY");
  if (!cfg.ipnSecret) missing.push("NOWPAYMENTS_IPN_SECRET");
  if ((cfg.sandbox || cfg.live) && !cfg.apiBaseValid) missing.push("NOWPAYMENTS_API_BASE (use the official API base for the selected mode)");
  if (!cfg.publicBaseUrl || !cfg.publicUrlValid) missing.push("PUBLIC_BASE_URL (public HTTPS URL)");
  if (!cfg.sandbox && !cfg.live) missing.push("NOWPAYMENTS_MODE (sandbox or live)");
  return {
    providerKey: PROVIDER,
    environment: cfg.environment,
    configured: cfg.configured,
    checkoutAvailable: cfg.configured,
    testMode: cfg.sandbox,
    feePaidByUser: cfg.feePaidByUser,
    sandboxActivationEnabled: cfg.sandboxActivationEnabled,
    liveAutoPricingEnabled: boolEnv("BILLING_LIVE_AUTO_PRICING_ENABLED", false),
    missingConfiguration: missing,
  };
}

function decimalString(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(value);
}

function normalizeStatus(value) {
  return clean(value, 80).toLowerCase();
}

function orderStatusForProviderStatus(providerStatus) {
  const status = normalizeStatus(providerStatus);
  if (status === "finished") return "PAID";
  if (status === "partially_paid") return "PARTIALLY_PAID";
  if (status === "refunded") return "REFUNDED";
  if (status === "expired") return "EXPIRED";
  if (status === "failed") return "FAILED";
  if (PROCESSING_STATUSES.has(status)) return "PROCESSING";
  return "PROCESSING";
}

function monotonicOrderStatus(currentStatus, providerStatus) {
  const current = String(currentStatus || "CREATED");
  const next = orderStatusForProviderStatus(providerStatus);
  if (current === "REFUNDED") return "REFUNDED";
  if (current === "PAID") return next === "REFUNDED" ? "REFUNDED" : "PAID";
  if (current === "PARTIALLY_PAID" && next === "PROCESSING") return "PARTIALLY_PAID";
  if (["FAILED", "EXPIRED", "CANCELLED"].includes(current) && !["PAID", "REFUNDED"].includes(next)) return current;
  return next;
}

async function updateOrderStatusMonotonically(client, initialOrder, providerStatus, payload) {
  let current = initialOrder;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!current) throw permanentBindingError("Billing order disappeared during provider processing", "BILLING_ORDER_NOT_FOUND");
    const candidateStatus = monotonicOrderStatus(current.status, providerStatus);
    validateProviderPaymentForOrder(current, payload, { requirePrice: candidateStatus === "PAID" });
    const paidAt = candidateStatus === "PAID" ? (current.paidAt || new Date()) : current.paidAt;

    // Compare-and-retry prevents two concurrent provider callbacks from
    // overwriting a newer terminal state based on the same stale snapshot.
    // Example: REFUNDED must never regress to PAID because a late `finished`
    // callback read PAID milliseconds earlier.
    const claim = await client.billingOrder.updateMany({
      where: { id: current.id, status: current.status },
      data: { status: candidateStatus, providerStatus: providerStatus || current.providerStatus, paidAt },
    });
    if (claim.count === 1) {
      const fresh = await client.billingOrder.findUnique({ where: { id: current.id } });
      if (!fresh) throw permanentBindingError("Billing order disappeared during provider processing", "BILLING_ORDER_NOT_FOUND");
      return { order: fresh, candidateStatus: String(fresh.status) };
    }
    current = await client.billingOrder.findUnique({ where: { id: current.id } });
  }
  const err = new Error("Billing order changed too many times during provider processing");
  err.code = "BILLING_ORDER_CONCURRENT_UPDATE";
  err.status = 503;
  throw err;
}

function validateProviderPaymentForOrder(order, payload, { requirePrice = false } = {}) {
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  const providerPaymentId = clean(payload?.payment_id ?? payload?.id, 180);
  if (requirePrice && !providerPaymentId) {
    const err = new Error("NOWPayments final payment is missing payment_id");
    err.code = "BILLING_PROVIDER_PAYMENT_ID_MISSING";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
  const invoiceId = clean(payload?.invoice_id, 180);
  if (invoiceId && order.providerInvoiceId && invoiceId !== String(order.providerInvoiceId)) {
    const err = new Error("NOWPayments invoice does not match the ONLINOD billing order");
    err.code = "BILLING_PROVIDER_INVOICE_MISMATCH";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
  const currency = clean(payload?.price_currency, 40).toUpperCase();
  if (requirePrice && !currency) {
    const err = new Error("NOWPayments final payment is missing price_currency");
    err.code = "BILLING_PROVIDER_CURRENCY_MISSING";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
  if (currency && currency !== String(order.currency || "USD").toUpperCase()) {
    const err = new Error("NOWPayments payment currency does not match the ONLINOD billing order");
    err.code = "BILLING_PROVIDER_CURRENCY_MISMATCH";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
  const rawAmount = payload?.price_amount;
  if (requirePrice && (rawAmount === null || rawAmount === undefined || rawAmount === "")) {
    const err = new Error("NOWPayments final payment is missing price_amount");
    err.code = "BILLING_PROVIDER_AMOUNT_MISSING";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
  if (rawAmount !== null && rawAmount !== undefined && rawAmount !== "") {
    const amount = Number(rawAmount);
    const cents = Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : NaN;
    if (!Number.isSafeInteger(cents) || cents !== Number(order.amountCents)) {
      const err = new Error("NOWPayments payment amount does not match the ONLINOD billing order");
      err.code = "BILLING_PROVIDER_AMOUNT_MISMATCH";
      err.status = 409;
      err.permanent = true;
      throw err;
    }
  }
  return { ok: true };
}

async function nowPaymentsRequest(pathname, options = {}) {
  const cfg = providerConfig();
  if (!cfg.configured) {
    const err = new Error("NOWPayments is not configured");
    err.code = "NOWPAYMENTS_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.apiBase}${pathname}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const err = new Error(clean(payload?.message || payload?.error || `NOWPayments request failed (${response.status})`, 500));
      err.code = "NOWPAYMENTS_REQUEST_FAILED";
      err.status = 502;
      err.providerStatus = response.status;
      throw err;
    }
    return payload || {};
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error("NOWPayments request timed out");
      timeout.code = "NOWPAYMENTS_TIMEOUT";
      timeout.status = 504;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCheckoutKey(value) {
  const key = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    const err = new Error("A valid checkout idempotency key is required");
    err.code = "BILLING_CHECKOUT_KEY_INVALID";
    err.status = 400;
    err.permanent = true;
    throw err;
  }
  return key;
}

function checkoutKeyWhere(agencyId, testMode, checkoutKey) {
  return {
    agencyId_provider_testMode_checkoutKey: {
      agencyId: String(agencyId),
      provider: PROVIDER,
      testMode: testMode === true,
      checkoutKey,
    },
  };
}

function replayExistingCheckout(order, cfg = providerConfig()) {
  if (!order) return null;
  const checkoutUrl = checkoutUrlForOrder(order, cfg);
  if (checkoutUrl) return { order: publicOrder(order), checkoutUrl, replayed: true };
  const err = new Error(
    order.status === "CREATED"
      ? "The checkout request with this idempotency key is still in progress"
      : "The previous checkout request with this idempotency key did not produce a reusable invoice",
  );
  err.code = order.status === "CREATED" ? "BILLING_CHECKOUT_REQUEST_IN_PROGRESS" : "BILLING_CHECKOUT_PREVIOUS_ATTEMPT_FAILED";
  err.status = 409;
  err.permanent = true;
  throw err;
}

function requestHashForSelection(selection) {
  return sha256(stableJson(selection));
}

function assertCheckoutRequestBinding(order, requestHash) {
  if (!order) return;
  if (order.requestHash === null) {
    const err = new Error("This checkout key belongs to a legacy order without a bound creator selection; start a fresh checkout");
    err.code = "BILLING_LEGACY_CHECKOUT_KEY";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
  if (order.requestHash && String(order.requestHash) !== String(requestHash)) {
    const err = new Error("This checkout idempotency key is already bound to a different billing selection");
    err.code = "BILLING_CHECKOUT_SELECTION_MISMATCH";
    err.status = 409;
    err.permanent = true;
    throw err;
  }
}

async function runTransaction(client, fn) {
  return typeof client?.$transaction === "function" ? client.$transaction(fn) : fn(client);
}

async function calculateCheckoutSnapshot({ agencyId, selection, db = null }) {
  const client = db || prisma;
  const normalized = normalizeSelection(selection);
  const requestedIds = normalized.creators.map((row) => row.creatorId);
  const [subscription, creators, agency] = await Promise.all([
    client.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }),
    client.creatorAccount.findMany({
      where: { agencyId, deletedAt: null, id: { in: requestedIds } },
      include: { billingProfile: true },
      orderBy: { createdAt: "asc" },
    }),
    client.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true } }),
  ]);
  if (!agency) {
    const err = new Error("Agency not found");
    err.code = "BILLING_AGENCY_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  const byId = new Map(creators.map((creator) => [String(creator.id), creator]));
  const missing = requestedIds.filter((id) => !byId.has(String(id)));
  if (missing.length) {
    const err = new Error("One or more selected creators are unavailable in this workspace");
    err.code = "BILLING_CREATOR_NOT_FOUND";
    err.status = 404;
    err.permanent = true;
    throw err;
  }

  const defaultCorePriceCents = Math.max(0, Number(subscription?.corePricePerCreatorCents ?? 2000));
  const months = periodMonths(normalized.billingPeriod);
  const lines = normalized.creators.map((requested) => {
    const priced = priceCreatorSelection({ creator: byId.get(requested.creatorId), requested, defaultCorePriceCents });
    return { ...priced, periodMonths: months, lineTotalCents: priced.monthlyCents * months };
  });
  const monthlyTotalCents = lines.reduce((sum, row) => sum + row.monthlyCents, 0);
  const amountCents = lines.reduce((sum, row) => sum + row.lineTotalCents, 0);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    const err = new Error("Selected checkout has no billable creator lines");
    err.code = "BILLING_NOTHING_TO_CHARGE";
    err.status = 409;
    throw err;
  }
  return {
    agency,
    subscription,
    selection: normalized,
    requestHash: requestHashForSelection(normalized),
    billingPeriod: normalized.billingPeriod,
    periodMonths: months,
    billedCreators: lines.length,
    monthlyTotalCents,
    amountCents,
    currency: "USD",
    lines,
  };
}

function billingOrderLineCreateData(orderAgencyId, line) {
  return {
    agencyId: orderAgencyId,
    creatorId: line.creatorId,
    creatorName: line.creatorName,
    creatorUsername: line.creatorUsername || null,
    tier: line.tier,
    corePriceCents: line.corePriceCents,
    aiChatterEnabled: line.aiChatterEnabled === true,
    aiChatterPriceCents: line.aiChatterPriceCents,
    outreachEnabled: line.outreachEnabled === true,
    outreachPriceCents: line.outreachPriceCents,
    monthlyCents: line.monthlyCents,
    periodMonths: line.periodMonths,
    lineTotalCents: line.lineTotalCents,
  };
}

function invoiceUrls(orderId, cfg) {
  const encoded = encodeURIComponent(orderId);
  return {
    ipn_callback_url: `${cfg.publicBaseUrl}/api/billing/nowpayments/ipn`,
    success_url: `${cfg.publicBaseUrl}/api/billing/checkout/success?order_id=${encoded}`,
    cancel_url: `${cfg.publicBaseUrl}/api/billing/checkout/cancel?order_id=${encoded}`,
  };
}


const TERMINAL_ORDER_STATUSES = new Set(["PAID", "REFUNDED", "EXPIRED", "FAILED", "CANCELLED"]);

function isNowPaymentsHost(host) {
  const value = String(host || "").toLowerCase();
  return value === "nowpayments.io" || value.endsWith(".nowpayments.io");
}

function isSandboxHostedCheckoutHost(host) {
  return String(host || "").toLowerCase() === "sandbox.nowpayments.io";
}

function validateHostedCheckoutUrl(value, cfg = providerConfig()) {
  const text = clean(value, 2000);
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw permanentBindingError("NOWPayments returned an invalid hosted checkout URL", "BILLING_PROVIDER_CHECKOUT_URL_INVALID");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !isNowPaymentsHost(host)) {
    throw permanentBindingError("NOWPayments returned an untrusted hosted checkout URL", "BILLING_PROVIDER_CHECKOUT_URL_UNTRUSTED");
  }
  if (cfg.sandbox && !isSandboxHostedCheckoutHost(host)) {
    const err = permanentBindingError(
      "NOWPayments sandbox did not return its own hosted checkout. ONLINOD will not open a production NOWPayments invoice for a sandbox order.",
      "BILLING_SANDBOX_HOSTED_CHECKOUT_UNAVAILABLE",
    );
    err.status = 502;
    throw err;
  }
  if (cfg.live && isSandboxHostedCheckoutHost(host)) {
    const err = permanentBindingError(
      "NOWPayments live mode returned a sandbox hosted checkout URL",
      "BILLING_LIVE_CHECKOUT_ENVIRONMENT_MISMATCH",
    );
    err.status = 502;
    throw err;
  }
  return url.toString();
}

function checkoutUrlForOrder(order, cfg = providerConfig()) {
  if (!order) return "";
  if ((order.testMode === true) !== cfg.sandbox) return "";
  return validateHostedCheckoutUrl(order.providerInvoiceUrl, cfg);
}

function validateInvoiceResponseForOrder(order, invoice) {
  const providerOrderId = clean(invoice?.order_id, 180);
  if (providerOrderId && providerOrderId !== String(order.id)) {
    throw permanentBindingError("NOWPayments invoice order_id does not match the ONLINOD billing order", "BILLING_PROVIDER_ORDER_MISMATCH");
  }
  const currency = clean(invoice?.price_currency, 40).toUpperCase();
  if (currency && currency !== String(order.currency || "USD").toUpperCase()) {
    throw permanentBindingError("NOWPayments invoice currency does not match the ONLINOD billing order", "BILLING_PROVIDER_CURRENCY_MISMATCH");
  }
  if (invoice?.price_amount !== undefined && invoice?.price_amount !== null && invoice?.price_amount !== "") {
    const amount = Number(invoice.price_amount);
    const cents = Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : NaN;
    if (!Number.isSafeInteger(cents) || cents !== Number(order.amountCents)) {
      throw permanentBindingError("NOWPayments invoice amount does not match the ONLINOD billing order", "BILLING_PROVIDER_AMOUNT_MISMATCH");
    }
  }
}

async function resumeCheckout({ agencyId, orderId, db = null }) {
  const client = db || prisma;
  const cfg = providerConfig();
  const order = await client.billingOrder.findFirst({ where: { id: clean(orderId, 180), agencyId } });
  if (!order) {
    const err = new Error("Billing order not found");
    err.code = "BILLING_ORDER_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if ((order.testMode === true) !== cfg.sandbox) {
    const err = new Error(`Billing order belongs to the ${order.testMode ? "sandbox" : "live"} provider environment, but backend is configured for ${cfg.environment || "disabled"}`);
    err.code = "BILLING_PROVIDER_ENVIRONMENT_MISMATCH";
    err.status = 409;
    throw err;
  }
  if (TERMINAL_ORDER_STATUSES.has(String(order.status))) {
    const err = new Error(`This checkout is already ${String(order.status).toLowerCase()}`);
    err.code = "BILLING_CHECKOUT_NOT_RESUMABLE";
    err.status = 409;
    throw err;
  }
  const checkoutUrl = checkoutUrlForOrder(order, cfg);
  if (!checkoutUrl) {
    const err = new Error("This billing order does not have a reusable checkout");
    err.code = "BILLING_CHECKOUT_URL_UNAVAILABLE";
    err.status = 409;
    throw err;
  }
  return { order: publicOrder(order), checkoutUrl };
}

async function createCheckout({ agencyId, actorUserId, checkoutKey: rawCheckoutKey, selection, db = null }) {
  const client = db || prisma;
  const cfg = providerConfig();
  if (!cfg.configured) {
    const err = new Error("NOWPayments checkout is not configured on the backend");
    err.code = "NOWPAYMENTS_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const checkoutKey = normalizeCheckoutKey(rawCheckoutKey);
  const normalizedSelection = normalizeSelection(selection);
  const requestHash = requestHashForSelection(normalizedSelection);
  const existing = await client.billingOrder.findUnique({ where: checkoutKeyWhere(agencyId, cfg.sandbox, checkoutKey) });
  assertCheckoutRequestBinding(existing, requestHash);
  const retryFailedSandboxOrder = !!(existing && cfg.sandbox && existing.status === "FAILED" && !existing.providerInvoiceId && !existing.providerInvoiceUrl);
  if (existing && !retryFailedSandboxOrder) return replayExistingCheckout(existing);
  const snapshot = await calculateCheckoutSnapshot({ agencyId, selection: normalizedSelection, db: client });
  if (snapshot.subscription?.billingMode === "FREE_INTERNAL" && cfg.live) {
    const err = new Error("This workspace is in FREE_INTERNAL mode; live checkout is disabled to prevent accidental charges");
    err.code = "BILLING_FREE_INTERNAL_LIVE_CHECKOUT_DISABLED";
    err.status = 409;
    throw err;
  }
  let order;
  try {
    order = retryFailedSandboxOrder
      ? await runTransaction(client, async (tx) => {
          const updated = await tx.billingOrder.update({
            where: { id: existing.id },
            data: {
              status: "CREATED",
              providerStatus: null,
              amountCents: snapshot.amountCents,
              currency: snapshot.currency,
              billingPeriod: snapshot.billingPeriod,
              periodMonths: snapshot.periodMonths,
              billedCreators: snapshot.billedCreators,
              pricingSnapshot: {
                agencyName: snapshot.agency.name,
                plan: snapshot.agency.plan,
                monthlyTotalCents: snapshot.monthlyTotalCents,
                periodMonths: snapshot.periodMonths,
                selection: snapshot.selection,
                lines: snapshot.lines,
              },
              requestHash: snapshot.requestHash,
            },
          });
          if (tx.billingOrderLine?.deleteMany) await tx.billingOrderLine.deleteMany({ where: { orderId: updated.id } });
          if (tx.billingOrderLine?.createMany) {
            await tx.billingOrderLine.createMany({ data: snapshot.lines.map((line) => ({ orderId: updated.id, ...billingOrderLineCreateData(agencyId, line) })) });
          } else if (tx.billingOrderLine?.create) {
            for (const line of snapshot.lines) await tx.billingOrderLine.create({ data: { orderId: updated.id, ...billingOrderLineCreateData(agencyId, line) } });
          }
          return updated;
        })
      : await client.billingOrder.create({
          data: {
            agencyId,
            createdByUserId: actorUserId || null,
            provider: PROVIDER,
            status: "CREATED",
            amountCents: snapshot.amountCents,
            currency: snapshot.currency,
            billingPeriod: snapshot.billingPeriod,
            periodMonths: snapshot.periodMonths,
            billedCreators: snapshot.billedCreators,
            pricingSnapshot: {
              agencyName: snapshot.agency.name,
              plan: snapshot.agency.plan,
              monthlyTotalCents: snapshot.monthlyTotalCents,
              periodMonths: snapshot.periodMonths,
              selection: snapshot.selection,
              lines: snapshot.lines,
            },
            requestHash: snapshot.requestHash,
            lines: { create: snapshot.lines.map((line) => billingOrderLineCreateData(agencyId, line)) },
            testMode: cfg.sandbox,
            checkoutKey,
          },
        });
  } catch (err) {
    if (err?.code !== "P2002") throw err;
    const raced = await client.billingOrder.findUnique({ where: checkoutKeyWhere(agencyId, cfg.sandbox, checkoutKey) });
    if (!raced) throw err;
    // The unique constraint protects duplicate creation, but a concurrent caller
    // may have raced with a *different* selection under the same checkoutKey.
    // Re-check the binding before exposing that caller's invoice.
    assertCheckoutRequestBinding(raced, requestHash);
    return replayExistingCheckout(raced);
  }

  const priceAmount = Number((snapshot.amountCents / 100).toFixed(2));
  const body = {
    price_amount: priceAmount,
    price_currency: "usd",
    order_id: order.id,
    order_description: `ONLINOD ${snapshot.billingPeriod} · ${snapshot.billedCreators} creator${snapshot.billedCreators === 1 ? "" : "s"}`,
    ...invoiceUrls(order.id, cfg),
    is_fee_paid_by_user: cfg.feePaidByUser,
  };

  try {
    const invoice = await nowPaymentsRequest("/invoice", { method: "POST", body });
    const providerInvoiceId = clean(invoice.invoice_id ?? invoice.id, 180);
    const rawProviderInvoiceUrl = clean(invoice.invoice_url, 2000);
    validateInvoiceResponseForOrder(order, invoice);
    if (!providerInvoiceId || !rawProviderInvoiceUrl) {
      const err = new Error("NOWPayments invoice response did not contain invoice_id/invoice_url");
      err.code = "NOWPAYMENTS_INVOICE_INVALID";
      err.status = 502;
      throw err;
    }
    const providerInvoiceUrl = validateHostedCheckoutUrl(rawProviderInvoiceUrl, cfg);
    const updated = await client.billingOrder.update({
      where: { id: order.id },
      data: {
        status: "CHECKOUT_CREATED",
        providerInvoiceId,
        providerInvoiceUrl,
        providerStatus: clean(invoice.payment_status || invoice.status, 80) || "waiting",
      },
    });
    await audit({
      agencyId,
      actorUserId,
      action: "billing.checkout_created",
      targetType: "billing_order",
      targetId: order.id,
      metadata: { provider: PROVIDER, testMode: cfg.sandbox, amountCents: snapshot.amountCents, currency: snapshot.currency, billingPeriod: snapshot.billingPeriod, billedCreators: snapshot.billedCreators },
      db: client,
    }).catch(() => undefined);
    return { order: publicOrder(updated), checkoutUrl: checkoutUrlForOrder(updated, cfg) };
  } catch (err) {
    await client.billingOrder.update({ where: { id: order.id }, data: { status: "FAILED", providerStatus: clean(err?.code || "CREATE_INVOICE_FAILED", 80) } }).catch(() => undefined);
    throw err;
  }
}

function normalizeTopUpAmountCents(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 10_000_000) {
    const err = new Error("Balance top-up must be between $1.00 and $100,000.00");
    err.code = "BILLING_TOP_UP_AMOUNT_INVALID";
    err.status = 400;
    err.permanent = true;
    throw err;
  }
  return amount;
}

async function createWalletTopUpCheckout({ agencyId, actorUserId, checkoutKey: rawCheckoutKey, amountCents: rawAmountCents, db = null }) {
  const client = db || prisma;
  const cfg = providerConfig();
  if (!cfg.configured) {
    const err = new Error("NOWPayments checkout is not configured on the backend");
    err.code = "NOWPAYMENTS_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const checkoutKey = normalizeCheckoutKey(rawCheckoutKey);
  const amountCents = normalizeTopUpAmountCents(rawAmountCents);
  const requestHash = sha256(stableJson({ purpose: "WALLET_TOP_UP", amountCents, currency: "USD" }));
  const existing = await client.billingOrder.findUnique({ where: checkoutKeyWhere(agencyId, cfg.sandbox, checkoutKey) });
  assertCheckoutRequestBinding(existing, requestHash);
  const retryFailedSandboxOrder = !!(existing && cfg.sandbox && existing.status === "FAILED" && !existing.providerInvoiceId && !existing.providerInvoiceUrl);
  if (existing && !retryFailedSandboxOrder) return replayExistingCheckout(existing);

  const [agency, subscription] = await Promise.all([
    client.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true, plan: true } }),
    client.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!agency) {
    const err = new Error("Agency not found");
    err.code = "BILLING_AGENCY_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (subscription?.billingMode === "FREE_INTERNAL" && cfg.live) {
    const err = new Error("This workspace is in FREE_INTERNAL mode; live checkout is disabled to prevent accidental charges");
    err.code = "BILLING_FREE_INTERNAL_LIVE_CHECKOUT_DISABLED";
    err.status = 409;
    throw err;
  }

  const snapshot = { purpose: "WALLET_TOP_UP", agencyName: agency.name, plan: agency.plan, amountCents, currency: "USD" };
  let order;
  try {
    order = retryFailedSandboxOrder
      ? await runTransaction(client, async (tx) => tx.billingOrder.update({
          where: { id: existing.id },
          data: {
            purpose: "WALLET_TOP_UP", status: "CREATED", providerStatus: null, amountCents, currency: "USD",
            billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 0, pricingSnapshot: snapshot, requestHash,
            providerInvoiceId: null, providerInvoiceUrl: null, paidAt: null, activatedAt: null,
          },
        }))
      : await client.billingOrder.create({
          data: {
            agencyId, createdByUserId: actorUserId || null, provider: PROVIDER, purpose: "WALLET_TOP_UP", status: "CREATED",
            amountCents, currency: "USD", billingPeriod: "MONTHLY", periodMonths: 1, billedCreators: 0,
            pricingSnapshot: snapshot, requestHash, testMode: cfg.sandbox, checkoutKey,
          },
        });
  } catch (err) {
    if (err?.code !== "P2002") throw err;
    const raced = await client.billingOrder.findUnique({ where: checkoutKeyWhere(agencyId, cfg.sandbox, checkoutKey) });
    if (!raced) throw err;
    assertCheckoutRequestBinding(raced, requestHash);
    return replayExistingCheckout(raced);
  }

  const priceAmount = Number((amountCents / 100).toFixed(2));
  const body = {
    price_amount: priceAmount,
    price_currency: "usd",
    order_id: order.id,
    order_description: `ONLINOD balance top-up · $${priceAmount.toFixed(2)}`,
    ...invoiceUrls(order.id, cfg),
    is_fee_paid_by_user: cfg.feePaidByUser,
  };
  try {
    const invoice = await nowPaymentsRequest("/invoice", { method: "POST", body });
    const providerInvoiceId = clean(invoice.invoice_id ?? invoice.id, 180);
    const rawProviderInvoiceUrl = clean(invoice.invoice_url, 2000);
    validateInvoiceResponseForOrder(order, invoice);
    if (!providerInvoiceId || !rawProviderInvoiceUrl) {
      const err = new Error("NOWPayments invoice response did not contain invoice_id/invoice_url");
      err.code = "NOWPAYMENTS_INVOICE_INVALID";
      err.status = 502;
      throw err;
    }
    const providerInvoiceUrl = validateHostedCheckoutUrl(rawProviderInvoiceUrl, cfg);
    const updated = await client.billingOrder.update({
      where: { id: order.id },
      data: { status: "CHECKOUT_CREATED", providerInvoiceId, providerInvoiceUrl, providerStatus: clean(invoice.payment_status || invoice.status, 80) || "waiting" },
    });
    await audit({ agencyId, actorUserId, action: "billing.wallet_top_up_checkout_created", targetType: "billing_order", targetId: order.id, metadata: { provider: PROVIDER, testMode: cfg.sandbox, amountCents, currency: "USD" }, db: client }).catch(() => undefined);
    return { order: publicOrder(updated), checkoutUrl: checkoutUrlForOrder(updated, cfg) };
  } catch (err) {
    await client.billingOrder.update({ where: { id: order.id }, data: { status: "FAILED", providerStatus: clean(err?.code || "CREATE_INVOICE_FAILED", 80) } }).catch(() => undefined);
    throw err;
  }
}

function verifyIpnSignature(payload, signature) {
  const cfg = providerConfig();
  const received = clean(signature, 256).toLowerCase();
  if (!cfg.ipnSecret || !received || !/^[0-9a-f]{128}$/.test(received)) return false;
  const expected = crypto.createHmac("sha512", cfg.ipnSecret).update(stableJson(payload)).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function paymentAttemptData(payload) {
  return {
    providerStatus: clean(payload.payment_status || payload.status, 80) || null,
    priceAmount: decimalString(payload.price_amount),
    priceCurrency: clean(payload.price_currency, 40) || null,
    payAmount: decimalString(payload.pay_amount),
    payCurrency: clean(payload.pay_currency, 80) || null,
    payAddress: clean(payload.pay_address, 1000) || null,
    payinExtraId: clean(payload.payin_extra_id, 500) || null,
    purchaseId: clean(payload.purchase_id, 180) || null,
    actuallyPaid: decimalString(payload.actually_paid),
    outcomeAmount: decimalString(payload.outcome_amount ?? payload.outcome_price),
    outcomeCurrency: clean(payload.outcome_currency, 80) || null,
  };
}

function paymentAttemptUniqueWhere(providerPaymentId, testMode) {
  return {
    provider_testMode_providerPaymentId: {
      provider: PROVIDER,
      testMode: testMode === true,
      providerPaymentId: clean(providerPaymentId, 180),
    },
  };
}

function permanentBindingError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 409;
  err.permanent = true;
  return err;
}

async function activatePaidOrder(orderId, db = null) {
  return activatePaidOrderEntitlements({
    orderId,
    sandboxActivationEnabled: providerConfig().sandboxActivationEnabled,
    db: db || prisma,
  });
}

async function handleRefundedOrder(order, db = null) {
  return refundOrderEntitlements({ order, db: db || prisma });
}

async function applyProviderPayment(payload, { signature = null, signatureVerified = false, source = "IPN", db = null } = {}) {
  const client = db || prisma;
  const providerPaymentId = clean(payload.payment_id ?? payload.id, 180);
  const providerStatus = normalizeStatus(payload.payment_status || payload.status);
  const providerOrderId = clean(payload.order_id, 180);
  const config = providerConfig();
  let order = providerOrderId ? await client.billingOrder.findUnique({ where: { id: providerOrderId } }) : null;
  let existingAttempt = null;
  if (providerPaymentId && order) {
    existingAttempt = await client.billingPaymentAttempt.findUnique({
      where: paymentAttemptUniqueWhere(providerPaymentId, order.testMode),
      include: { order: true },
    });
  } else if (providerPaymentId) {
    existingAttempt = await client.billingPaymentAttempt.findFirst({
      where: { provider: PROVIDER, providerPaymentId, testMode: config.sandbox },
      include: { order: true },
      orderBy: { createdAt: "desc" },
    });
    order = existingAttempt?.order || null;
  }
  const bindingError =
    order && (config.sandbox || config.live) && (order.testMode === true) !== config.sandbox
      ? permanentBindingError("NOWPayments event environment does not match the billing order", "BILLING_PROVIDER_ENVIRONMENT_MISMATCH")
      : providerOrderId && order && providerOrderId !== String(order.id)
        ? permanentBindingError("NOWPayments order_id does not match the payment attempt order", "BILLING_PROVIDER_ORDER_MISMATCH")
        : existingAttempt && order && String(existingAttempt.orderId) !== String(order.id)
          ? permanentBindingError("NOWPayments payment_id is already bound to another billing order", "BILLING_PROVIDER_PAYMENT_ORDER_MISMATCH")
          : null;

  const eventKey = sha256(`${PROVIDER}\n${clean(signature, 256).toLowerCase()}\n${stableJson(payload)}`);
  let event;
  try {
    event = await client.billingProviderEvent.create({
      data: {
        provider: PROVIDER,
        eventKey,
        orderId: order?.id || null,
        providerStatus: providerStatus || null,
        signature: clean(signature, 256) || null,
        signatureVerified,
        payload,
      },
    });
  } catch (err) {
    if (err?.code !== "P2002") throw err;
    event = await client.billingProviderEvent.findUnique({ where: { eventKey } });
    if (!event) throw err;
    if (event.processedAt) {
      const existingOrder = event.orderId ? await client.billingOrder.findUnique({ where: { id: event.orderId } }) : order;
      return { duplicate: true, order: publicOrder(existingOrder) };
    }
  }

  try {
    if (bindingError) throw bindingError;
    if (!order) {
      await client.billingProviderEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), processingError: "ORDER_NOT_FOUND" } });
      return { duplicate: false, order: null, code: "ORDER_NOT_FOUND" };
    }

    let candidateStatus = monotonicOrderStatus(order.status, providerStatus);
    validateProviderPaymentForOrder(order, payload, { requirePrice: candidateStatus === "PAID" });

    let attempt = null;
    if (providerPaymentId) {
      attempt = await client.billingPaymentAttempt.upsert({
        where: paymentAttemptUniqueWhere(providerPaymentId, order.testMode),
        create: { orderId: order.id, provider: PROVIDER, testMode: order.testMode === true, providerPaymentId, ...paymentAttemptData(payload) },
        update: paymentAttemptData(payload),
      });
      if (event.paymentAttemptId !== attempt.id || event.orderId !== order.id) {
        await client.billingProviderEvent.update({ where: { id: event.id }, data: { paymentAttemptId: attempt.id, orderId: order.id } });
      }
    }

    const advanced = await updateOrderStatusMonotonically(client, order, providerStatus, payload);
    order = advanced.order;
    candidateStatus = advanced.candidateStatus;

    let activation = null;
    const purpose = String(order.purpose || "SUBSCRIPTION");
    if (candidateStatus === "PAID") {
      activation = purpose === "WALLET_TOP_UP"
        ? await creditPaidTopUp({ orderId: order.id, sandboxActivationEnabled: config.sandboxActivationEnabled, db: client })
        : await activatePaidOrder(order.id, client);
    }
    if (candidateStatus === "REFUNDED") {
      if (purpose === "WALLET_TOP_UP") await refundTopUp({ order, db: client });
      else await handleRefundedOrder(order, client);
    }

    await client.billingProviderEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), processingError: null } });
    if (candidateStatus === "PAID" || candidateStatus === "REFUNDED") {
      await audit({
        agencyId: order.agencyId,
        actorUserId: null,
        action: candidateStatus === "PAID" ? "billing.payment_finished" : "billing.payment_refunded",
        targetType: "billing_order",
        targetId: order.id,
        metadata: { provider: PROVIDER, providerStatus, source, testMode: order.testMode, activated: activation?.activated === true },
        db: client,
      });
    }
    return { duplicate: false, order: publicOrder(await client.billingOrder.findUnique({ where: { id: order.id } })), activation };
  } catch (err) {
    const permanent = err?.permanent === true || Number(err?.status) >= 400 && Number(err?.status) < 500;
    await client.billingProviderEvent.update({
      where: { id: event.id },
      data: { processedAt: permanent ? new Date() : null, processingError: clean(err?.message || err, 500) },
    }).catch(() => undefined);
    throw err;
  }
}

async function handleNowPaymentsIpn({ payload, signature, db = null }) {
  const cfg = providerConfig();
  if (!cfg.sandbox && !cfg.live) {
    const err = new Error("NOWPayments IPN processing is disabled until NOWPAYMENTS_MODE is sandbox or live");
    err.code = "NOWPAYMENTS_IPN_MODE_DISABLED";
    err.status = 503;
    throw err;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("Invalid NOWPayments IPN payload");
    err.code = "NOWPAYMENTS_IPN_INVALID";
    err.status = 400;
    throw err;
  }
  if (!verifyIpnSignature(payload, signature)) {
    const err = new Error("Invalid NOWPayments IPN signature");
    err.code = "NOWPAYMENTS_IPN_SIGNATURE_INVALID";
    err.status = 401;
    throw err;
  }
  return applyProviderPayment(payload, { signature, signatureVerified: true, source: "IPN", db });
}

async function reconcileOrder({ agencyId, orderId, actorUserId = null, db = null }) {
  const client = db || prisma;
  const order = await client.billingOrder.findFirst({ where: { id: clean(orderId, 180), agencyId } });
  if (!order) {
    const err = new Error("Billing order not found");
    err.code = "BILLING_ORDER_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  const cfg = providerConfig();
  if ((order.testMode === true) !== cfg.sandbox) {
    const err = new Error(`Billing order belongs to the ${order.testMode ? "sandbox" : "live"} provider environment, but backend is configured for ${cfg.environment || "disabled"}`);
    err.code = "BILLING_PROVIDER_ENVIRONMENT_MISMATCH";
    err.status = 409;
    throw err;
  }
  const attempt = await client.billingPaymentAttempt.findFirst({ where: { orderId: order.id }, orderBy: { updatedAt: "desc" } });
  if (!attempt?.providerPaymentId) {
    return { order: publicOrder(order), reconciled: false, reason: "PAYMENT_NOT_DETECTED_YET" };
  }
  const payload = await nowPaymentsRequest(`/payment/${encodeURIComponent(attempt.providerPaymentId)}`);
  const fetchedPaymentId = clean(payload?.payment_id ?? payload?.id, 180);
  const fetchedOrderId = clean(payload?.order_id, 180);
  if (fetchedPaymentId && fetchedPaymentId !== String(attempt.providerPaymentId)) {
    throw permanentBindingError("NOWPayments reconciliation returned a different payment_id", "BILLING_PROVIDER_PAYMENT_ID_MISMATCH");
  }
  if (fetchedOrderId && fetchedOrderId !== String(order.id)) {
    throw permanentBindingError("NOWPayments reconciliation returned a different order_id", "BILLING_PROVIDER_ORDER_MISMATCH");
  }
  const result = await applyProviderPayment(payload, { signature: null, signatureVerified: false, source: "RECONCILIATION", db: client });
  let reconciledOrder = result.order || publicOrder(order);
  let activation = result.activation || null;
  if (reconciledOrder?.status === "PAID" && !reconciledOrder.activatedAt) {
    // Recovery must preserve the order purpose. A wallet top-up is activated
    // only by crediting its wallet ledger; sending it through the legacy
    // subscription activator could claim activatedAt without crediting funds.
    activation = String(reconciledOrder.purpose || order.purpose || "SUBSCRIPTION") === "WALLET_TOP_UP"
      ? await creditPaidTopUp({ orderId: order.id, sandboxActivationEnabled: cfg.sandboxActivationEnabled, db: client })
      : await activatePaidOrder(order.id, client);
    reconciledOrder = publicOrder(await client.billingOrder.findUnique({ where: { id: order.id } })) || reconciledOrder;
  }
  await audit({ agencyId, actorUserId, action: "billing.payment_reconciled", targetType: "billing_order", targetId: order.id, metadata: { provider: PROVIDER, providerPaymentId: attempt.providerPaymentId, providerStatus: normalizeStatus(payload.payment_status || payload.status), activated: activation?.activated === true }, db: client });
  return { order: reconciledOrder, reconciled: true, activation };
}

function publicOrder(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    provider: String(row.provider || PROVIDER),
    purpose: String(row.purpose || "SUBSCRIPTION"),
    status: String(row.status),
    amountCents: Number(row.amountCents || 0),
    currency: String(row.currency || "USD"),
    billingPeriod: String(row.billingPeriod || "MONTHLY"),
    periodMonths: Number(row.periodMonths || 1),
    billedCreators: Number(row.billedCreators || 0),
    lines: Array.isArray(row.lines) ? row.lines.map((line) => ({
      creatorId: String(line.creatorId),
      creatorName: String(line.creatorName || line.creatorId),
      creatorUsername: line.creatorUsername || null,
      tier: String(line.tier || "STARTER"),
      corePriceCents: Number(line.corePriceCents || 0),
      aiChatterEnabled: line.aiChatterEnabled === true,
      aiChatterPriceCents: Number(line.aiChatterPriceCents || 0),
      outreachEnabled: line.outreachEnabled === true,
      outreachPriceCents: Number(line.outreachPriceCents || 0),
      monthlyCents: Number(line.monthlyCents || 0),
      periodMonths: Number(line.periodMonths || row.periodMonths || 1),
      lineTotalCents: Number(line.lineTotalCents || 0),
    })) : [],
    providerInvoiceId: row.providerInvoiceId || null,
    providerInvoiceUrl: row.providerInvoiceUrl || null,
    providerStatus: row.providerStatus || null,
    testMode: row.testMode === true,
    paidAt: row.paidAt ? new Date(row.paidAt).toISOString() : null,
    activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

async function recentOrders({ agencyId, limit = 10, db = null }) {
  const client = db || prisma;
  const rows = await client.billingOrder.findMany({ where: { agencyId }, include: { lines: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "desc" }, take: Math.max(1, Math.min(25, Number(limit || 10))) });
  return rows.map(publicOrder);
}

module.exports = {
  PROVIDER,
  providerConfig,
  publicProviderConfig,
  periodMonths,
  stableValue,
  stableJson,
  verifyIpnSignature,
  calculateCheckoutSnapshot,
  createCheckout,
  createWalletTopUpCheckout,
  resumeCheckout,
  handleNowPaymentsIpn,
  reconcileOrder,
  recentOrders,
  publicOrder,
  orderStatusForProviderStatus,
  monotonicOrderStatus,
  updateOrderStatusMonotonically,
  validateProviderPaymentForOrder,
  normalizeCheckoutKey,
  normalizeTopUpAmountCents,
  applyProviderPayment,
};
