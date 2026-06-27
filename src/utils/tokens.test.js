"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertStrongSecret, refreshTokenDays } = require("./tokens");

test("assertStrongSecret rejects short or low-entropy JWT secrets", () => {
  assert.throws(() => assertStrongSecret("12345"), /JWT_SECRET/);
  assert.throws(() => assertStrongSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), /JWT_SECRET/);
});

test("assertStrongSecret accepts long high-entropy JWT secrets", () => {
  assert.doesNotThrow(() => assertStrongSecret("ONLINOD_prod_secret_2026_AaBbCcDdEeFf1234567890"));
});

test("refreshTokenDays falls back to 30 for invalid values", () => {
  const oldValue = process.env.REFRESH_TOKEN_TTL_DAYS;
  process.env.REFRESH_TOKEN_TTL_DAYS = "nope";
  try {
    assert.equal(refreshTokenDays(), 30);
  } finally {
    if (oldValue === undefined) delete process.env.REFRESH_TOKEN_TTL_DAYS;
    else process.env.REFRESH_TOKEN_TTL_DAYS = oldValue;
  }
});
