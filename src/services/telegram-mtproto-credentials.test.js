"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptTelegramCredentials, decryptTelegramCredentials } = require("./telegram-mtproto-credentials");

test("Telegram MTProto credential blob round-trips without plaintext storage", () => {
  const apiHash = "0123456789abcdef0123456789abcdef";
  const session = "SESSION_SECRET_VALUE";
  const encrypted = encryptTelegramCredentials({ apiHash, session });
  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.equal(encrypted.payloadVersion, 1);
  assert.equal(encrypted.encryptedPayload.includes(apiHash), false);
  assert.equal(encrypted.encryptedPayload.includes(session), false);
  assert.deepEqual(decryptTelegramCredentials(encrypted), { apiHash, session });
});
