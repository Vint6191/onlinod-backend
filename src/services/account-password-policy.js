"use strict";
const { z } = require("zod");
const MIN_PASSWORD_CHARACTERS = 8;
const MAX_PASSWORD_UTF8_BYTES = 72;
const passwordMessage = "Use at least 8 characters and no more than 72 UTF-8 bytes for a new password";
const newPasswordSchema = z.string().min(MIN_PASSWORD_CHARACTERS).refine(
  value => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_UTF8_BYTES,
  passwordMessage,
);
function assertNewPassword(value) {
  if (!newPasswordSchema.safeParse(value).success) {
    throw Object.assign(new Error(passwordMessage), { code: "PASSWORD_POLICY_INVALID", status: 400 });
  }
}
module.exports = { MIN_PASSWORD_CHARACTERS, MAX_PASSWORD_UTF8_BYTES, newPasswordSchema, assertNewPassword };
