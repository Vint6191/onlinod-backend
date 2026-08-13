"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { audit } = require("./audit-service");

const PROVIDER = "NOWPAYMENTS";
const PROCESSING_STATUSES = new Set(["waiting", "confirming", "confirmed", "sending"]);
const SANDBOX_CASES = new Set(["success", "common", "failed", "partially_paid"]);

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
    sandboxCase: clean(process.env.NOWPAYMENTS_SANDBOX_CASE, 80).toLowerCase() || null,
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
    missingConfiguration: missing,
  };
}

function periodMonths(period) {
  if (period === "THREE_MONTHS") return 3;
  if (period === "SIX_MONTHS") return 6;
  return 1;
}

function addMonthsUtc(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
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

function replayExistingCheckout(order) {
  if (!order) return null;
  const checkoutUrl = clean(order.providerInvoiceUrl, 2000);
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

async function calculateCheckoutSnapshot({ agencyId, db = null }) {
  const client = db || prisma;
  const [subscription, profiles, agency] = await Promise.all([
    client.agencySubscription.findFirst({ where: { agencyId }, orderBy: { createdAt: "desc" } }),
    client.creatorBillingProfile.findMany({
      where: { agencyId },
      include: { creator: { select: { id: true, displayName: true, username: true, deletedAt: true } } },
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
  const lines = profiles
    .filter((row) => !row.creator?.deletedAt && row.billingExcluded !== true)
    .map((row) => {
      const core = Math.max(0, Number(row.corePriceCents || 0));
      const ai = row.aiChatterEnabled ? Math.max(0, Number(row.aiChatterPriceCents || 0)) : 0;
      const outreach = row.outreachEnabled ? Math.max(0, Number(row.outreachPriceCents || 0)) : 0;
      return {
        creatorId: String(row.creatorId),
        creatorName: row.creator?.displayName || row.creator?.username || String(row.creatorId),
        tier: String(row.tier || "STARTER"),
        corePriceCents: core,
        aiChatterEnabled: row.aiChatterEnabled === true,
        aiChatterPriceCents: ai,
        outreachEnabled: row.outreachEnabled === true,
        outreachPriceCents: outreach,
        monthlyCents: core + ai + outreach,
      };
    })
    .filter((row) => row.monthlyCents > 0);
  const monthlyTotalCents = lines.reduce((sum, row) => sum + row.monthlyCents, 0);
  const billingPeriod = String(subscription?.billingPeriod || "MONTHLY");
  const months = periodMonths(billingPeriod);
  const amountCents = monthlyTotalCents * months;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    const err = new Error("No billable creator lines are configured for this workspace");
    err.code = "BILLING_NOTHING_TO_CHARGE";
    err.status = 409;
    throw err;
  }
  return {
    agency,
    subscription,
    billingPeriod,
    periodMonths: months,
    billedCreators: lines.length,
    monthlyTotalCents,
    amountCents,
    currency: "USD",
    lines,
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

async function createCheckout({ agencyId, actorUserId, checkoutKey: rawCheckoutKey, db = null }) {
  const client = db || prisma;
  const cfg = providerConfig();
  if (!cfg.configured) {
    const err = new Error("NOWPayments checkout is not configured on the backend");
    err.code = "NOWPAYMENTS_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  if (cfg.sandbox && cfg.sandboxCase && !SANDBOX_CASES.has(cfg.sandboxCase)) {
    const err = new Error(`Unsupported NOWPayments sandbox case: ${cfg.sandboxCase}`);
    err.code = "NOWPAYMENTS_SANDBOX_CASE_INVALID";
    err.status = 503;
    throw err;
  }
  const checkoutKey = normalizeCheckoutKey(rawCheckoutKey);
  const existing = await client.billingOrder.findUnique({ where: checkoutKeyWhere(agencyId, cfg.sandbox, checkoutKey) });
  if (existing) return replayExistingCheckout(existing);
  const snapshot = await calculateCheckoutSnapshot({ agencyId, db: client });
  if (snapshot.subscription?.billingMode === "FREE_INTERNAL" && cfg.live) {
    const err = new Error("This workspace is in FREE_INTERNAL mode; live checkout is disabled to prevent accidental charges");
    err.code = "BILLING_FREE_INTERNAL_LIVE_CHECKOUT_DISABLED";
    err.status = 409;
    throw err;
  }
  let order;
  try {
    order = await client.billingOrder.create({
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
          lines: snapshot.lines,
        },
        testMode: cfg.sandbox,
        checkoutKey,
      },
    });
  } catch (err) {
    if (err?.code !== "P2002") throw err;
    const raced = await client.billingOrder.findUnique({ where: checkoutKeyWhere(agencyId, cfg.sandbox, checkoutKey) });
    if (!raced) throw err;
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
    ...(cfg.sandbox && cfg.sandboxCase ? { case: cfg.sandboxCase } : {}),
  };

  try {
    const invoice = await nowPaymentsRequest("/invoice", { method: "POST", body });
    const providerInvoiceId = clean(invoice.invoice_id ?? invoice.id, 180);
    const providerInvoiceUrl = clean(invoice.invoice_url, 2000);
    if (!providerInvoiceId || !providerInvoiceUrl) {
      const err = new Error("NOWPayments invoice response did not contain invoice_id/invoice_url");
      err.code = "NOWPAYMENTS_INVOICE_INVALID";
      err.status = 502;
      throw err;
    }
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
    return { order: publicOrder(updated), checkoutUrl: providerInvoiceUrl };
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
  const client = db || prisma;
  const cfg = providerConfig();
  return client.$transaction(async (tx) => {
    const order = await tx.billingOrder.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "PAID") return { activated: false, reason: "ORDER_NOT_PAID" };
    if (order.activatedAt) return { activated: false, reason: "ALREADY_ACTIVATED" };
    if (order.testMode && !cfg.sandboxActivationEnabled) return { activated: false, reason: "SANDBOX_ACTIVATION_DISABLED" };

    const claim = await tx.billingOrder.updateMany({
      where: { id: orderId, activatedAt: null },
      data: { activatedAt: new Date(), paidAt: order.paidAt || new Date() },
    });
    if (claim.count !== 1) return { activated: false, reason: "ALREADY_ACTIVATED" };

    const subscription = await tx.agencySubscription.findFirst({ where: { agencyId: order.agencyId }, orderBy: { createdAt: "desc" } });
    const now = new Date();
    const existingEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
    const extending = !!existingEnd && existingEnd > now && subscription?.status === "ACTIVE";
    const periodBase = extending ? existingEnd : now;
    const nextEnd = addMonthsUtc(periodBase, order.periodMonths);
    const data = {
      status: "ACTIVE",
      billingMode: order.testMode ? String(subscription?.billingMode || "FREE_INTERNAL") : "CRYPTO",
      billingPeriod: order.billingPeriod,
      currentPeriodStart: extending ? (subscription?.currentPeriodStart || now) : now,
      currentPeriodEnd: nextEnd,
      graceUntil: null,
    };
    if (subscription) await tx.agencySubscription.update({ where: { id: subscription.id }, data });
    else await tx.agencySubscription.create({ data: { agencyId: order.agencyId, ...data } });
    await tx.agency.update({ where: { id: order.agencyId }, data: { status: "ACTIVE", currentPeriodEnd: nextEnd } });
    return { activated: true, currentPeriodEnd: nextEnd };
  });
}

async function handleRefundedOrder(order, db = null) {
  if (!order?.activatedAt) return { downgraded: false };
  const client = db || prisma;
  return client.$transaction(async (tx) => {
    const newerPaid = await tx.billingOrder.findFirst({
      where: { agencyId: order.agencyId, status: "PAID", activatedAt: { not: null }, createdAt: { gt: order.createdAt }, id: { not: order.id } },
      orderBy: { createdAt: "desc" },
    });
    if (newerPaid) return { downgraded: false, reason: "NEWER_PAID_ORDER_EXISTS" };
    const subscription = await tx.agencySubscription.findFirst({ where: { agencyId: order.agencyId }, orderBy: { createdAt: "desc" } });
    if (subscription) await tx.agencySubscription.update({ where: { id: subscription.id }, data: { status: "PAST_DUE" } });
    await tx.agency.update({ where: { id: order.agencyId }, data: { status: "PAST_DUE" } });
    return { downgraded: true };
  });
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

    const candidateStatus = monotonicOrderStatus(order.status, providerStatus);
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

    const paidAt = candidateStatus === "PAID" ? (order.paidAt || new Date()) : order.paidAt;
    order = await client.billingOrder.update({
      where: { id: order.id },
      data: { status: candidateStatus, providerStatus: providerStatus || order.providerStatus, paidAt },
    });

    let activation = null;
    if (candidateStatus === "PAID") activation = await activatePaidOrder(order.id, client);
    if (candidateStatus === "REFUNDED") await handleRefundedOrder(order, client);

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
    activation = await activatePaidOrder(order.id, client);
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
    status: String(row.status),
    amountCents: Number(row.amountCents || 0),
    currency: String(row.currency || "USD"),
    billingPeriod: String(row.billingPeriod || "MONTHLY"),
    periodMonths: Number(row.periodMonths || 1),
    billedCreators: Number(row.billedCreators || 0),
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
  const rows = await client.billingOrder.findMany({ where: { agencyId }, orderBy: { createdAt: "desc" }, take: Math.max(1, Math.min(25, Number(limit || 10))) });
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
  handleNowPaymentsIpn,
  reconcileOrder,
  recentOrders,
  publicOrder,
  orderStatusForProviderStatus,
  monotonicOrderStatus,
  validateProviderPaymentForOrder,
  normalizeCheckoutKey,
  applyProviderPayment,
};
