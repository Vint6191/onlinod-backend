"use strict";

const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");

function encryptTelegramCredentials({ apiHash, session }) {
  return encryptSnapshot({
    apiHash: String(apiHash || ""),
    session: String(session || ""),
  });
}

function decryptTelegramCredentials(record) {
  const value = decryptSnapshot(record);
  return {
    apiHash: String(value?.apiHash || ""),
    session: String(value?.session || ""),
  };
}

module.exports = {
  encryptTelegramCredentials,
  decryptTelegramCredentials,
};
