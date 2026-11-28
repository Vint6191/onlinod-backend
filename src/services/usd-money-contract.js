"use strict";

// NOD monetary values use the OnlyFans USD contract. A missing currency may
// inherit that contract only at an explicitly documented source/input boundary;
// persisted financial facts always have to carry the canonical USD value.
const USD_CURRENCY = "USD";

function normalizeUsdCurrency(value, { allowMissing = false } = {}) {
  if (value === undefined) return allowMissing ? USD_CURRENCY : null;
  return typeof value === "string" && value.trim().toUpperCase() === USD_CURRENCY ? USD_CURRENCY : null;
}

function isCanonicalUsdCurrency(value) {
  return value === USD_CURRENCY;
}

function requireUsdCurrency(value, { allowMissing = false, code = "UNSUPPORTED_CURRENCY" } = {}) {
  const currency = normalizeUsdCurrency(value, { allowMissing });
  if (!currency) throw Object.assign(new Error("Only USD monetary values are supported."), { code, status: 400 });
  return currency;
}

module.exports = { USD_CURRENCY, normalizeUsdCurrency, isCanonicalUsdCurrency, requireUsdCurrency };
