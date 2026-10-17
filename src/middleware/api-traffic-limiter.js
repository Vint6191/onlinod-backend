"use strict";

const { createHash } = require("node:crypto");
const rateLimit = require("express-rate-limit");
const { verifyAccessToken } = require("../utils/tokens");

function limit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1_000_000) : fallback;
}

// This identity separates resource budgets, never authorizes a request. The
// mounted route must still check the current session, member, device and creator.
// Only signature-verified claims may select a device bucket; body/header labels
// and rotating access/refresh tokens cannot mint another budget for that device.
function signedDeviceIdentity(req, verify) {
  const match = typeof req.headers.authorization === "string" && req.headers.authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const claims = verify(match[1]);
    if (!claims || typeof claims !== "object") return null;
    const scope = [claims.agencyId, claims.userId, claims.deviceId];
    if (scope.some(value => typeof value !== "string" || !value.trim() || value.length > 220)) return null;
    return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  } catch { return null; }
}

function createApiTrafficLimiter({ verify = verifyAccessToken, env = process.env } = {}) {
  const options = { windowMs: 60_000, standardHeaders: true, legacyHeaders: false };
  const reject = (code) => (req, res) => {
    const seconds = Math.max(1, Number(res.getHeader("Retry-After")) || 60);
    return res.status(429).json({ ok: false, code, error: "Request capacity is temporarily full. Please retry.", retryable: true, retryAfterMs: seconds * 1000 });
  };
  const publicLimiter = rateLimit({ ...options, limit: limit(env.API_RATE_LIMIT_PER_MIN, 1000), handler: reject("API_RATE_LIMITED") });
  const keyGenerator = (req) => req.apiTrafficDeviceIdentity;
  const deviceLimiter = rateLimit({ ...options, keyGenerator, limit: limit(env.API_DEVICE_RATE_LIMIT_PER_MIN, 1000), handler: reject("API_RATE_LIMITED") });
  // Each OF start needs acquire + acknowledgement. These bounded protocol
  // budgets support many creator timelines without consuming the UI/control
  // budget, and failed acquisition traffic cannot block started/cancel cleanup.
  const acquireLimiter = rateLimit({ ...options, keyGenerator, limit: limit(env.OF_GATE_ACQUIRE_RATE_LIMIT_PER_MIN, 20_000), handler: reject("OF_GATE_PROTOCOL_RATE_LIMITED") });
  const settlementLimiter = rateLimit({ ...options, keyGenerator, limit: limit(env.OF_GATE_SETTLEMENT_RATE_LIMIT_PER_MIN, 40_000), handler: reject("OF_GATE_PROTOCOL_RATE_LIMITED") });
  return (req, res, next) => {
    // Login/registration/recovery endpoints retain their anonymous IP budget
    // even if a caller attaches an unrelated valid access token.
    const publicAuth = /^\/(?:auth\/(?!me\/?$)|admin-auth(?:\/|$)|web\/auth(?:\/|$))/i.test(req.path);
    const identity = publicAuth ? null : signedDeviceIdentity(req, verify);
    if (!identity) return publicLimiter(req, res, next);
    req.apiTrafficDeviceIdentity = identity;
    if (req.method === "POST" && /^\/of-request-gate\/acquire\/?$/i.test(req.path)) return acquireLimiter(req, res, next);
    if (req.method === "POST" && /^\/of-request-gate\/(?:started|cancel)\/?$/i.test(req.path)) return settlementLimiter(req, res, next);
    return deviceLimiter(req, res, next);
  };
}

module.exports = { createApiTrafficLimiter };
