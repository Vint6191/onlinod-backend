"use strict";

const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");

function encryptTelegramCredentials({ apiHash, session, customBotToken }) {
  const payload = {
    apiHash: String(apiHash || ""),
    session: String(session || ""),
  };
  const token = String(customBotToken || "").trim();
  if (token) payload.customBotToken = token;
  return encryptSnapshot(payload);
}

function decryptTelegramCredentials(record) {
  const value = decryptSnapshot(record);
  const result = {
    apiHash: String(value?.apiHash || ""),
    session: String(value?.session || ""),
  };
  const token = String(value?.customBotToken || "").trim();
  if (token) result.customBotToken = token;
  return result;
}

module.exports = {
  encryptTelegramCredentials,
  decryptTelegramCredentials,
};
