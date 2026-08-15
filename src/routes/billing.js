"use strict";

const express = require("express");
const { authRequired } = require("../middleware/auth");
const { isOwner } = require("../services/team-access-control");
const {
  createWalletTopUpCheckout,
  resumeCheckout,
  getSandboxCheckoutState,
  startSandboxInvoicePayment,
  refreshSandboxInvoicePayment,
  handleNowPaymentsIpn,
  reconcileOrder,
  publicProviderConfig,
} = require("../services/billing-nowpayments-service");
const {
  startCreatorSubscription,
  cancelCreatorRenewal,
  setCreatorBillingPreferences,
  publicWallet,
  publicBillingPeriod,
} = require("../services/billing-wallet-service");
const { publicEntitlement } = require("../services/billing-entitlement-service");

const router = express.Router();

function sendError(res, err, fallbackCode = "BILLING_FAILED") {
  const status = Math.max(400, Math.min(599, Number(err?.status || 500) || 500));
  return res.status(status).json({ ok: false, code: err?.code || fallbackCode, error: String(err?.message || "Billing request failed") });
}

function ownerOnly(req, res, next) {
  if (!isOwner(req.auth?.membership)) {
    return res.status(403).json({ ok: false, code: "BILLING_OWNER_ONLY", error: "Plan & Billing is available to workspace owners only" });
  }
  return next();
}

function safeHtml(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#0d0912;color:#f6f2f8;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}.card{max-width:560px;margin:24px;padding:32px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:#15101d;box-shadow:0 24px 70px rgba(0,0,0,.35)}h1{margin:0 0 12px;font-size:28px}p{margin:0;color:#b8afc2}.mark{color:#fbbf24;font-weight:800;letter-spacing:.08em;font-size:12px;margin-bottom:8px}</style></head><body><main class="card"><div class="mark">ONLINOD BILLING</div><h1>${title}</h1><p>${message}</p></main></body></html>`;
}


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sandboxMoney(order) {
  return `$${(Number(order?.amountCents || 0) / 100).toFixed(2)}`;
}

function sandboxCheckoutHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return res.type("html");
}

function sandboxCheckoutHtml({ order, attempt = null, currencies = [], token, error = null }) {
  const orderId = escapeHtml(order?.id || "");
  const safeToken = encodeURIComponent(String(token || ""));
  const actionBase = `/api/billing/sandbox-checkout/${encodeURIComponent(String(order?.id || ""))}`;
  const status = escapeHtml(order?.status || "CHECKOUT_CREATED");
  const amount = sandboxMoney(order);
  const options = currencies.map((currency) => `<option value="${escapeHtml(currency)}">${escapeHtml(String(currency).toUpperCase())}</option>`).join("");
  const attemptBlock = attempt ? `
    <section class="payment">
      <div class="row"><span>Payment ID</span><strong>${escapeHtml(attempt.providerPaymentId || "—")}</strong></div>
      <div class="row"><span>Provider status</span><strong>${escapeHtml(attempt.providerStatus || "waiting")}</strong></div>
      <div class="row"><span>Locked invoice price</span><strong>${escapeHtml(attempt.priceAmount || (Number(order.amountCents || 0) / 100).toFixed(2))} ${escapeHtml(String(attempt.priceCurrency || order.currency || "USD").toUpperCase())}</strong></div>
      <div class="row"><span>Sandbox pay amount</span><strong>${escapeHtml(attempt.payAmount || "—")} ${escapeHtml(String(attempt.payCurrency || "").toUpperCase())}</strong></div>
      ${attempt.payAddress ? `<div class="address"><span>Sandbox pay address</span><code>${escapeHtml(attempt.payAddress)}</code></div>` : ""}
      ${attempt.payinExtraId ? `<div class="address"><span>Memo / extra ID</span><code>${escapeHtml(attempt.payinExtraId)}</code></div>` : ""}
      <form method="post" action="${actionBase}/refresh?token=${safeToken}"><button type="submit">Refresh provider status</button></form>
    </section>` : `
    <form method="post" action="${actionBase}/start?token=${safeToken}" class="choose">
      <label for="payCurrency">Choose test asset / network</label>
      <select id="payCurrency" name="payCurrency" required><option value="" selected disabled>Select currency</option>${options}</select>
      <button type="submit" ${options ? "" : "disabled"}>Next step</button>
    </form>`;
  const terminal = ["PAID", "REFUNDED", "EXPIRED", "FAILED", "CANCELLED"].includes(String(order?.status || ""));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ONLINOD · NOWPayments Sandbox</title><style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0c0911;color:#f7f3fb;font:15px/1.45 Inter,Segoe UI,Arial,sans-serif;min-height:100vh}.wrap{width:min(760px,calc(100vw - 40px));margin:36px auto 60px}.brand{font-size:12px;letter-spacing:.14em;color:#fbbf24;font-weight:800}.card{margin-top:12px;padding:28px;border:1px solid #33283f;border-radius:18px;background:#15101d;box-shadow:0 28px 90px rgba(0,0,0,.38)}h1{font-size:28px;margin:4px 0 8px}.sub{color:#b9afc4;margin:0 0 20px}.warning{padding:13px 15px;border:1px solid #76411f;background:#2a190e;color:#ffd39c;border-radius:12px;font-weight:700}.amount{display:flex;justify-content:space-between;align-items:end;margin:22px 0;padding:18px;border-radius:14px;background:#0d0912}.amount span,.row span,.address span{color:#95899f;font-size:12px;text-transform:uppercase;letter-spacing:.07em}.amount strong{font-size:32px}.meta{color:#80758a;font-size:12px}.choose{display:grid;gap:12px;margin-top:20px}.choose label{font-weight:700}select,button{font:inherit;border-radius:10px;border:1px solid #433650}select{background:#0e0a13;color:#fff;padding:13px}button{cursor:pointer;background:#f5b51b;color:#241900;font-weight:800;padding:13px 18px;border-color:#f5b51b}button:disabled{opacity:.45;cursor:not-allowed}.payment{display:grid;gap:10px;margin-top:20px}.row{display:flex;justify-content:space-between;gap:20px;padding:12px 0;border-bottom:1px solid #2c2335}.row strong{text-align:right;word-break:break-all}.address{display:grid;gap:7px;padding:12px 0}.address code{padding:12px;border-radius:9px;background:#09070c;word-break:break-all;color:#e6dcef}.err{margin-top:16px;padding:12px;border-radius:10px;border:1px solid #7a2940;background:#2b1019;color:#ffb3c5}.done{margin-top:16px;padding:12px;border-radius:10px;border:1px solid #276144;background:#10251b;color:#9df0be}.foot{margin-top:18px;color:#7e7288;font-size:12px}
  </style></head><body><main class="wrap"><div class="brand">ONLINOD PAYMENT · NOWPAYMENTS SANDBOX</div><section class="card"><h1>Secure sandbox checkout</h1><p class="sub">This window uses the official NOWPayments sandbox API. Live billing uses NOWPayments hosted checkout.</p><div class="warning">TEST ENVIRONMENT — DO NOT SEND REAL CRYPTO TO ANY ADDRESS SHOWN HERE.</div><div class="amount"><div><span>ONLINOD top-up locked to</span><div class="meta">Order ${orderId} · ${escapeHtml(order?.currency || "USD")}</div></div><strong>${escapeHtml(amount)}</strong></div><div class="row"><span>ONLINOD order status</span><strong>${status}</strong></div>${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}${terminal ? `<div class="done">This checkout is terminal. Return to ONLINOD and refresh Plan & Billing.</div>` : attemptBlock}<div class="foot">The amount credited to ONLINOD can only come from the locked server-side order (${escapeHtml(amount)}). Provider responses with a different USD amount are rejected.</div></section></main></body></html>`;
}

// Public provider callback. Authentication is the NOWPayments HMAC signature.
router.post("/nowpayments/ipn", async (req, res) => {
  try {
    const signature = String(req.get("x-nowpayments-sig") || "");
    const result = await handleNowPaymentsIpn({ payload: req.body || {}, signature });
    return res.json({ ok: true, duplicate: result.duplicate === true });
  } catch (err) {
    if (Number(err?.status) >= 500) console.error("[billing/ipn] failed:", err);
    return sendError(res, err, "NOWPAYMENTS_IPN_FAILED");
  }
});

// Hosted checkout redirects only inform the customer. They never activate entitlements.
router.get("/checkout/success", (_req, res) => {
  res.type("html").send(safeHtml("Payment received", "NOWPayments is processing the payment. Return to ONLINOD and refresh Plan & Billing; access is granted only after the backend verifies the final payment status."));
});
router.get("/checkout/cancel", (_req, res) => {
  res.type("html").send(safeHtml("Checkout cancelled", "No subscription change was made. You can return to ONLINOD and create another checkout whenever you are ready."));
});

// Public sandbox checkout is authorized by a short-lived HMAC token bound to
// one sandbox BillingOrder + provider invoice. It never accepts live orders.
router.get("/sandbox-checkout/:orderId", async (req, res) => {
  try {
    const state = await getSandboxCheckoutState({ orderId: req.params.orderId, token: req.query?.token, includeCurrencies: true });
    return sandboxCheckoutHeaders(res).send(sandboxCheckoutHtml({ ...state, token: req.query?.token }));
  } catch (err) {
    return sandboxCheckoutHeaders(res).status(Number(err?.status || 500)).send(sandboxCheckoutHtml({ order: { id: req.params.orderId, amountCents: 0, currency: "USD", status: "ERROR" }, token: req.query?.token, error: String(err?.message || "Sandbox checkout failed") }));
  }
});

router.post("/sandbox-checkout/:orderId/start", async (req, res) => {
  try {
    const result = await startSandboxInvoicePayment({ orderId: req.params.orderId, token: req.query?.token, payCurrency: req.body?.payCurrency });
    return sandboxCheckoutHeaders(res).send(sandboxCheckoutHtml({ ...result, token: req.query?.token }));
  } catch (err) {
    try {
      const state = await getSandboxCheckoutState({ orderId: req.params.orderId, token: req.query?.token, includeCurrencies: true });
      return sandboxCheckoutHeaders(res).status(Number(err?.status || 400)).send(sandboxCheckoutHtml({ ...state, token: req.query?.token, error: String(err?.message || "Sandbox payment could not start") }));
    } catch (_) {
      return sandboxCheckoutHeaders(res).status(Number(err?.status || 500)).send(sandboxCheckoutHtml({ order: { id: req.params.orderId, amountCents: 0, currency: "USD", status: "ERROR" }, token: req.query?.token, error: String(err?.message || "Sandbox payment could not start") }));
    }
  }
});

router.post("/sandbox-checkout/:orderId/refresh", async (req, res) => {
  try {
    const result = await refreshSandboxInvoicePayment({ orderId: req.params.orderId, token: req.query?.token });
    return sandboxCheckoutHeaders(res).send(sandboxCheckoutHtml({ ...result, token: req.query?.token }));
  } catch (err) {
    try {
      const state = await getSandboxCheckoutState({ orderId: req.params.orderId, token: req.query?.token, includeCurrencies: false });
      return sandboxCheckoutHeaders(res).status(Number(err?.status || 400)).send(sandboxCheckoutHtml({ ...state, token: req.query?.token, error: String(err?.message || "Sandbox payment status refresh failed") }));
    } catch (_) {
      return sandboxCheckoutHeaders(res).status(Number(err?.status || 500)).send(sandboxCheckoutHtml({ order: { id: req.params.orderId, amountCents: 0, currency: "USD", status: "ERROR" }, token: req.query?.token, error: String(err?.message || "Sandbox payment status refresh failed") }));
    }
  }
});

router.use(authRequired);
router.use(ownerOnly);

router.get("/provider", (_req, res) => res.json({ ok: true, provider: publicProviderConfig() }));

router.post("/quote", (_req, res) => {
  return res.status(410).json({ ok: false, code: "BILLING_DIRECT_CHECKOUT_DEPRECATED", error: "Creator checkout was replaced by wallet billing. Top up the workspace balance and start a monthly creator subscription." });
});

router.post("/checkout", (_req, res) => {
  return res.status(410).json({ ok: false, code: "BILLING_DIRECT_CHECKOUT_DEPRECATED", error: "Creator checkout was replaced by wallet billing. Top up the workspace balance and start a monthly creator subscription." });
});

router.post("/wallet/top-up", async (req, res) => {
  try {
    const result = await createWalletTopUpCheckout({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      checkoutKey: req.body?.checkoutKey,
      amountCents: req.body?.amountCents,
    });
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, "BILLING_TOP_UP_CHECKOUT_FAILED");
  }
});

router.post("/orders/:orderId/resume", async (req, res) => {
  try {
    const result = await resumeCheckout({ agencyId: req.auth.agencyId, orderId: req.params.orderId });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, "BILLING_CHECKOUT_RESUME_FAILED");
  }
});

router.patch("/creators/:creatorId/preferences", async (req, res) => {
  try {
    const profile = await setCreatorBillingPreferences({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      aiChatterEnabled: req.body?.aiChatterEnabled === true,
      outreachEnabled: req.body?.outreachEnabled === true,
      actorUserId: req.auth.userId,
    });
    return res.json({ ok: true, preferences: { aiChatterEnabled: profile.aiChatterEnabled === true, outreachEnabled: profile.outreachEnabled === true } });
  } catch (err) {
    return sendError(res, err, "BILLING_PREFERENCES_UPDATE_FAILED");
  }
});

router.post("/creators/:creatorId/start", async (req, res) => {
  try {
    const provider = publicProviderConfig();
    const result = await startCreatorSubscription({
      agencyId: req.auth.agencyId,
      creatorId: req.params.creatorId,
      actorUserId: req.auth.userId,
      testMode: provider.testMode === true,
    });
    return res.json({
      ok: true,
      alreadyActive: result.alreadyActive === true,
      wallet: publicWallet(result.wallet),
      entitlement: publicEntitlement(result.entitlement),
      period: publicBillingPeriod(result.period),
      pricing: result.pricing || null,
    });
  } catch (err) {
    return sendError(res, err, "BILLING_SUBSCRIPTION_START_FAILED");
  }
});

router.post("/creators/:creatorId/cancel-renewal", async (req, res) => {
  try {
    const result = await cancelCreatorRenewal({ agencyId: req.auth.agencyId, creatorId: req.params.creatorId, actorUserId: req.auth.userId });
    return res.json({ ok: true, changed: result.changed === true, entitlement: publicEntitlement(result.entitlement) });
  } catch (err) {
    return sendError(res, err, "BILLING_CANCEL_RENEWAL_FAILED");
  }
});

router.post("/orders/:orderId/reconcile", async (req, res) => {
  try {
    const result = await reconcileOrder({ agencyId: req.auth.agencyId, orderId: req.params.orderId, actorUserId: req.auth.userId });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, "BILLING_RECONCILE_FAILED");
  }
});

module.exports = router;
