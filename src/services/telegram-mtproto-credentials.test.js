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


test("optional standard bot token round-trips encrypted and is omitted when not configured", () => {
  const apiHash = "0123456789abcdef0123456789abcdef";
  const session = "SESSION";
  const customBotToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_1234567890";
  const encrypted = encryptTelegramCredentials({ apiHash, session, customBotToken });
  assert.equal(encrypted.encryptedPayload.includes(customBotToken), false);
  assert.deepEqual(decryptTelegramCredentials(encrypted), { apiHash, session, customBotToken });

  const withoutBot = encryptTelegramCredentials({ apiHash, session });
  assert.deepEqual(decryptTelegramCredentials(withoutBot), { apiHash, session });
  assert.equal("customBotToken" in decryptTelegramCredentials(withoutBot), false);
});
