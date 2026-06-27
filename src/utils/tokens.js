const jwt = require("jsonwebtoken");

const DEFAULT_DEV_SECRET = "dev-secret-only-for-local-tests";
const UNSAFE_SECRETS = new Set([
  "change-me-super-long-random-secret",
  "dev-secret-only-for-local-tests",
  "secret",
  "password",
  "12345",
]);

function assertStrongSecret(secret) {
  const value = String(secret || "");
  const uniqueChars = new Set(value).size;

  if (value.length < 32 || uniqueChars < 16 || UNSAFE_SECRETS.has(value)) {
    throw new Error("JWT_SECRET must be at least 32 chars and contain at least 16 unique characters");
  }
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET is missing");
    }
    return DEFAULT_DEV_SECRET;
  }

  if (process.env.NODE_ENV === "production") {
    assertStrongSecret(secret);
  } else if (UNSAFE_SECRETS.has(secret)) {
    return DEFAULT_DEV_SECRET;
  }

  return secret;
}

function accessTokenTtl() {
  return process.env.ACCESS_TOKEN_TTL || "15m";
}

function refreshTokenDays() {
  const n = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function signAccessToken(payload) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: accessTokenTtl(),
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret());
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  refreshTokenDays,
  assertStrongSecret,
};
