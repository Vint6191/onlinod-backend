"use strict";

const crypto = require("node:crypto");
const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");

const CLIENT_E2E_ALGORITHM = "aes-256-gcm-client-e2e-v1";

function codedError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function clean(value, max = 2048) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function usernameHint(username) {
  const value = clean(username, 512);
  if (!value) return null;
  if (value.length === 1) return "*";
  if (value.length === 2) return `${value[0]}*`;
  return `${value[0]}${"*".repeat(Math.min(6, Math.max(1, value.length - 2)))}${value[value.length - 1]}`;
}

function normalizeProxyCredentials(typeInput, value) {
  const type = clean(typeInput, 32).toUpperCase();
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const username = clean(source.username, 512);
  const password = String(source.password ?? "");

  if (password.length > 4096) throw codedError("PROXY_PASSWORD_TOO_LONG", "Proxy password is too long");

  if (type === "SOCKS4" || type === "SOCKS4A") {
    if (password) throw codedError("PROXY_AUTH_UNSUPPORTED_FOR_TYPE", `${type} supports USERID only; password authentication is not supported`);
    return username ? { username, password: "" } : null;
  }

  if (!username && !password) return null;
  if (!username) throw codedError("PROXY_USERNAME_REQUIRED", "Proxy username is required when password authentication is configured");
  return { username, password };
}

function proxyCredentialHash(value) {
  const normalized = value ? { username: String(value.username || ""), password: String(value.password || "") } : null;
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function serverEncryptedProxyCredentials(type, value) {
  const normalized = normalizeProxyCredentials(type, value);
  if (!normalized) return clearedProxyCredentials();
  const encrypted = encryptSnapshot({ username: normalized.username, password: normalized.password });
  return {
    encryptedPayload: encrypted.encryptedPayload,
    iv: encrypted.iv,
    tag: encrypted.tag,
    algorithm: encrypted.algorithm,
    payloadVersion: encrypted.payloadVersion,
    encryptionMode: "SERVER_V1",
    keyVersion: null,
    hasCredentials: true,
    usernameHint: usernameHint(normalized.username),
  };
}

function clearedProxyCredentials() {
  return {
    encryptedPayload: null,
    iv: null,
    tag: null,
    algorithm: null,
    payloadVersion: 1,
    encryptionMode: "SERVER_V1",
    keyVersion: null,
    hasCredentials: false,
    usernameHint: null,
  };
}

function opaqueString(value, field, max = 1_000_000) {
  const text = clean(value, max);
  if (!text) throw codedError("PROXY_OPAQUE_CREDENTIALS_INVALID", `${field} is required for client-side encrypted proxy credentials`);
  return text;
}

function normalizeOpaqueProxyCredentials(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (String(source.encryptionMode || "") !== "CLIENT_E2E_V1") {
    throw codedError("PROXY_OPAQUE_CREDENTIALS_INVALID", "Client-side proxy credentials must use CLIENT_E2E_V1");
  }
  const keyVersion = Math.floor(Number(source.keyVersion));
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw codedError("PROXY_OPAQUE_CREDENTIALS_INVALID", "Client-side proxy credentials require a positive keyVersion");
  const algorithm = opaqueString(source.algorithm, "algorithm", 128);
  if (algorithm !== CLIENT_E2E_ALGORITHM) throw codedError("PROXY_OPAQUE_CREDENTIALS_INVALID", "Unsupported client-side proxy credential algorithm");
  const ciphertext = opaqueString(source.ciphertext || source.encryptedPayload, "ciphertext");
  const iv = opaqueString(source.iv, "iv", 4096);
  const tag = opaqueString(source.tag, "tag", 4096);
  const hint = source.usernameHint == null ? null : clean(source.usernameHint, 512) || null;
  return {
    encryptedPayload: ciphertext,
    iv,
    tag,
    algorithm,
    payloadVersion: 1,
    encryptionMode: "CLIENT_E2E_V1",
    keyVersion,
    hasCredentials: true,
    usernameHint: hint,
  };
}

function decryptServerProxyCredentials(record) {
  if (!record?.hasCredentials) return null;
  if (String(record.encryptionMode || "SERVER_V1") !== "SERVER_V1") {
    throw codedError("PROXY_CREDENTIALS_OPAQUE", "Proxy credentials are client-side encrypted", 409);
  }
  if (!record.encryptedPayload || !record.iv || !record.tag) throw codedError("PROXY_CREDENTIALS_CORRUPT", "Proxy credentials are marked configured but encrypted material is incomplete", 500);
  const value = decryptSnapshot(record);
  return normalizeProxyCredentials(record.type, value);
}

function opaqueProxyCredentialEnvelope(record) {
  if (!record?.hasCredentials || String(record.encryptionMode || "SERVER_V1") !== "CLIENT_E2E_V1") return null;
  if (!record.encryptedPayload || !record.iv || !record.tag || !record.algorithm || !record.keyVersion) {
    throw codedError("PROXY_CREDENTIALS_CORRUPT", "Client-side proxy credential envelope is incomplete", 500);
  }
  return {
    encryptionMode: "CLIENT_E2E_V1",
    keyVersion: Number(record.keyVersion),
    algorithm: record.algorithm,
    ciphertext: record.encryptedPayload,
    iv: record.iv,
    tag: record.tag,
  };
}

module.exports = {
  CLIENT_E2E_ALGORITHM,
  normalizeProxyCredentials,
  serverEncryptedProxyCredentials,
  clearedProxyCredentials,
  normalizeOpaqueProxyCredentials,
  decryptServerProxyCredentials,
  opaqueProxyCredentialEnvelope,
  proxyCredentialHash,
  usernameHint,
};
