"use strict";

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

function clearedProxyCredentials() {
  return {
    encryptedPayload: null,
    iv: null,
    tag: null,
    algorithm: null,
    payloadVersion: 1,
    encryptionMode: "CLIENT_E2E_V1",
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
    throw codedError("PROXY_OPAQUE_CREDENTIALS_INVALID", "Proxy credentials must use CLIENT_E2E_V1");
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

function opaqueProxyCredentialEnvelope(record) {
  if (!record?.hasCredentials) return null;
  if (String(record.encryptionMode || "") !== "CLIENT_E2E_V1") {
    throw codedError("PROXY_LEGACY_CREDENTIALS_UNSUPPORTED", "Legacy proxy credentials are not supported after the V20.22 cutover", 409);
  }
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
  clearedProxyCredentials,
  normalizeOpaqueProxyCredentials,
  opaqueProxyCredentialEnvelope,
};
