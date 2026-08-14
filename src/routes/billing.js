"use strict";

const express = require("express");
const { authRequired } = require("../middleware/auth");
const { isOwner } = require("../services/team-access-control");
const {
  createWalletTopUpCheckout,
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
