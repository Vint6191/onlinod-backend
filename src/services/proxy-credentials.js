"use strict";

const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");

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

  if (password.length > 4096) {
    const error = new Error("Proxy password is too long");
    error.code = "PROXY_PASSWORD_TOO_LONG";
    error.status = 400;
    throw error;
  }

  if (type === "SOCKS4" || type === "SOCKS4A") {
    if (password) {
      const error = new Error(`${type} supports USERID only; password authentication is not supported`);
      error.code = "PROXY_AUTH_UNSUPPORTED_FOR_TYPE";
      error.status = 400;
      throw error;
    }
    return username ? { username, password: "" } : null;
  }

  if (!username && !password) return null;
  if (!username) {
    const error = new Error("Proxy username is required when password authentication is configured");
    error.code = "PROXY_USERNAME_REQUIRED";
    error.status = 400;
    throw error;
  }
  return { username, password };
}

function encryptProxyCredentials(type, value) {
  const normalized = normalizeProxyCredentials(type, value);
  if (!normalized) {
    return {
      encryptedPayload: null,
      iv: null,
      tag: null,
      algorithm: null,
      payloadVersion: 1,
      hasCredentials: false,
      usernameHint: null,
    };
  }
  const encrypted = encryptSnapshot({
    username: normalized.username,
    password: normalized.password,
  });
  return {
    encryptedPayload: encrypted.encryptedPayload,
    iv: encrypted.iv,
    tag: encrypted.tag,
    algorithm: encrypted.algorithm,
    payloadVersion: encrypted.payloadVersion,
    hasCredentials: true,
    usernameHint: usernameHint(normalized.username),
  };
}

function decryptProxyCredentials(record) {
  if (!record?.hasCredentials) return null;
  if (!record.encryptedPayload || !record.iv || !record.tag) {
    const error = new Error("Proxy credentials are marked configured but encrypted material is incomplete");
    error.code = "PROXY_CREDENTIALS_CORRUPT";
    error.status = 500;
    throw error;
  }
  const value = decryptSnapshot(record);
  return normalizeProxyCredentials(record.type, value);
}

module.exports = {
  normalizeProxyCredentials,
  encryptProxyCredentials,
  decryptProxyCredentials,
  usernameHint,
};
