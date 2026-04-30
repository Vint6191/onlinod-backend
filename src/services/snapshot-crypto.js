const crypto = require("node:crypto");

function getKey() {
  const raw = process.env.SNAPSHOT_ENCRYPTION_KEY || "";

  if (!raw && process.env.NODE_ENV !== "production") {
    // Local-only fallback for development. Never rely on this in production.
    return crypto.createHash("sha256").update("onlinod-dev-snapshot-key").digest();
  }

  if (!raw) {
    throw new Error("SNAPSHOT_ENCRYPTION_KEY is missing");
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("SNAPSHOT_ENCRYPTION_KEY must be 32 bytes encoded as base64");
  }

  return key;
}

function encryptSnapshot(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);

  const json = JSON.stringify(payload || {});
  const encrypted = Buffer.concat([
    cipher.update(json, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    encryptedPayload: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    algorithm: "aes-256-gcm",
    payloadVersion: 1,
  };
}

function decryptSnapshot(record) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(record.iv, "base64")
  );

  decipher.setAuthTag(Buffer.from(record.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.encryptedPayload, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

function hashUserAgent(userAgent) {
  if (!userAgent) return null;
  return crypto.createHash("sha256").update(String(userAgent)).digest("hex");
}

module.exports = {
  encryptSnapshot,
  decryptSnapshot,
  hashUserAgent,
};
