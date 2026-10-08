"use strict";
function authUnavailable(res, error, code = "AUTH_AUTHORITY_UNAVAILABLE") {
  // No bearer, credentials, SQL text or connection URL in this diagnostic.
  const causeCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : "INTERNAL_ERROR";
  console.error("[auth] authority unavailable", { code, causeCode });
  res.set("Retry-After", "2");
  return res.status(503).json({ ok: false, code, error: "Authorization is temporarily unavailable. Please retry.", retryable: true });
}
module.exports = { authUnavailable };
