"use strict";

const { createHash } = require("node:crypto");

// NOWPayments merchant JWTs expire after five minutes. Optional server-only
// credentials let discovery renew them; payment-ID recovery needs only the API
// key. Never persist a merchant password/token in an order or expose it to UI.
// https://nowpayments.zendesk.com/hc/en-us/articles/21345824322717-API-and-endpoint-description
const TOKEN_LIFETIME_MS = 5 * 60_000;
const TOKEN_SKEW_MS = 30_000;
let cached = null;
let rejectedStaticKey = null;

function staticTokenKey(cfg) {
  return createHash("sha256").update(JSON.stringify([cfg.environment, cfg.apiBase, cfg.apiKey, cfg.reconciliationToken])).digest("hex");
}

function tokenExpiresAt(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch (_) { return null; }
}

function discoveryAuthState(cfg, now = Date.now()) {
  if (cfg.reconciliationEmail && cfg.reconciliationPassword) return { configured: true, mode: "managed", reason: null };
  if (!cfg.reconciliationToken) return { configured: false, mode: "none", reason: "PAYMENT_DISCOVERY_AUTH_REQUIRED" };
  const expiresAt = tokenExpiresAt(cfg.reconciliationToken);
  if (rejectedStaticKey === staticTokenKey(cfg) || expiresAt !== null && expiresAt <= now + TOKEN_SKEW_MS)
    return { configured: false, mode: "static", reason: "PAYMENT_DISCOVERY_AUTH_EXPIRED" };
  return { configured: true, mode: "static", reason: null };
}

function authError(code, providerStatus) {
  return Object.assign(new Error("Automatic payment discovery could not authenticate; payment-ID recovery remains available"), {
    code, status: 503, ...(providerStatus ? { providerStatus } : {}),
  });
}

async function managedToken({ cfg, request, remaining, rejectedToken = null }) {
  const key = createHash("sha256").update(JSON.stringify([
    cfg.environment, cfg.apiBase, cfg.apiKey, cfg.reconciliationEmail, cfg.reconciliationPassword,
  ])).digest("hex");
  if (!cached || cached.key !== key) cached = { key, token: null, expiresAt: 0, pending: null };
  const entry = cached;
  // A concurrent reader may already have replaced the rejected JWT. Reuse its
  // new token instead of forcing another authentication request.
  if (entry.token && entry.token !== rejectedToken && entry.expiresAt > Date.now()) return entry.token;
  if (entry.pending) return entry.pending;
  entry.token = null;
  entry.pending = (async () => {
    let result;
    try {
      result = await request("/auth", { method: "POST", body: {
        email: cfg.reconciliationEmail, password: cfg.reconciliationPassword,
      }, timeoutMs: remaining() });
    } catch (error) {
      // Provider messages can contain request details. Only the classified
      // status crosses this boundary; credentials never enter errors or logs.
      throw authError("PAYMENT_DISCOVERY_AUTH_FAILED", error?.providerStatus);
    }
    const token = typeof result?.token === "string" ? result.token.trim() : "";
    const now = Date.now(), expiresAt = Math.min(tokenExpiresAt(token) ?? Infinity, now + TOKEN_LIFETIME_MS) - TOKEN_SKEW_MS;
    if (!token || token.length > 10000 || expiresAt <= now) throw authError("PAYMENT_DISCOVERY_AUTH_FAILED");
    entry.token = token;
    entry.expiresAt = expiresAt;
    return token;
  })();
  try { return await entry.pending; }
  finally { entry.pending = null; }
}

async function requestPaymentDiscovery({ cfg, request, pathname, remaining }) {
  const state = discoveryAuthState(cfg);
  if (!state.configured) throw authError(state.reason);
  const managed = state.mode === "managed";
  let token = managed ? await managedToken({ cfg, request, remaining }) : cfg.reconciliationToken;
  const send = () => request(pathname, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: remaining() });
  try { return await send(); }
  catch (error) {
    if (![401, 403].includes(Number(error?.providerStatus))) throw error;
    if (!managed) {
      rejectedStaticKey = staticTokenKey(cfg);
      throw authError("PAYMENT_DISCOVERY_AUTH_EXPIRED", error.providerStatus);
    }
    token = await managedToken({ cfg, request, remaining, rejectedToken: token });
    try { return await send(); }
    catch (retryError) {
      if ([401, 403].includes(Number(retryError?.providerStatus))) {
        if (cached?.token === token) { cached.token = null; cached.expiresAt = 0; }
        throw authError("PAYMENT_DISCOVERY_AUTH_FAILED", retryError.providerStatus);
      }
      throw retryError;
    }
  }
}

module.exports = { discoveryAuthState, requestPaymentDiscovery };
