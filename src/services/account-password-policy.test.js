"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { newPasswordSchema, assertNewPassword } = require("./account-password-policy");
test("new credentials are bounded by UTF-8 bytes at the bcrypt boundary", () => {
  for (const value of ["A".repeat(71), "A".repeat(72), "Ж".repeat(36), "🙂".repeat(18)]) {
    assert.equal(newPasswordSchema.safeParse(value).success, true);
    assert.doesNotThrow(() => assertNewPassword(value));
  }
  for (const value of ["short", "A".repeat(73), "Ж".repeat(36) + "X", "🙂".repeat(18) + "x"]) {
    assert.equal(newPasswordSchema.safeParse(value).success, false);
    assert.throws(() => assertNewPassword(value), { code: "PASSWORD_POLICY_INVALID", status: 400 });
  }
});
