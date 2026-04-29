const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "change-me-super-long-random-secret") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET is missing or unsafe");
    }
    return "dev-secret-only-for-local-tests";
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
};
