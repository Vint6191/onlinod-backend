"use strict";
const { reserveLoginAttempt, releaseSuccessfulAttempt } = require("../services/login-admission-service");
const { authUnavailable } = require("./auth-unavailable");
function loginAdmission({ db, surface }) {
  return async (req, res, next) => {
    let reservations;
    try {
      reservations = await reserveLoginAttempt({ db, surface, ip: req.ip || req.socket?.remoteAddress, email: req.body?.email });
    } catch (error) {
      if (error?.code === "LOGIN_RATE_LIMITED") {
        res.set("Retry-After", String(error.retryAfter));
        return res.status(429).json({ ok: false, code: error.code, error: error.message, retryAfterSeconds: error.retryAfter });
      }
      return authUnavailable(res, error, "LOGIN_ADMISSION_UNAVAILABLE");
    }
    // Count failures AND concurrent attempts; successful login refunds exactly once.
    // Interrupted/ambiguous responses conservatively retain the reservation until expiry.
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) void releaseSuccessfulAttempt({ db, reservations })
        .catch(() => { console.error("[auth] login reservation refund unavailable"); });
    });
    return next();
  };
}
module.exports = { loginAdmission };
