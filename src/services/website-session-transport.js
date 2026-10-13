"use strict";
const { randomUUID } = require("node:crypto");

// Browser transport for the existing account/session authority. No parallel
// account store and no bearer/refresh credentials in JavaScript storage.
const COOKIE = "nod_web_";
function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    try { result[key] = decodeURIComponent(part.slice(at + 1)); } catch (_) {}
  }
  return result;
}
function options(req) {
  return { httpOnly: true, secure: req.secure === true, sameSite: "lax", path: "/api/web" };
}
function requireWebsiteRequest(req, res, next) {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  const expected = `${req.protocol}://${req.get("host")}`;
  if ((origin && origin !== expected) || req.get("sec-fetch-site") === "cross-site" || req.get("x-nod-client") !== "website") {
    return res.status(403).json({ ok: false, code: "WEBSITE_ORIGIN_REQUIRED", error: "Open this form on the NOD website" });
  }
  return next();
}
function authenticateCookie(req, _res, next) {
  // The web surface only accepts its own HttpOnly credential, never a supplied
  // Authorization header or arbitrary body token from a different client.
  const jar = cookies(req);
  delete req.headers.authorization;
  if (jar[COOKIE + "access"]) req.headers.authorization = `Bearer ${jar[COOKIE + "access"]}`;
  req.websiteRemember = jar[COOKIE + "remember"] === "1";
  next();
}
function prepareAuthRequest(req, res, next) {
  authenticateCookie(req, res, () => {});
  if (req.method === "POST" && ["/login", "/refresh", "/logout"].includes(req.path)) {
    const jar = cookies(req);
    if (req.path !== "/login") req.body = { refreshToken: jar[COOKIE + "refresh"] || "" };
    const storedDevice = /^web-[a-f0-9-]{36}$/.test(jar[COOKIE + "device"] || "") ? jar[COOKIE + "device"] : null;
    req.websiteDevice = storedDevice || (req.path === "/login" ? "web-" + randomUUID() : null);
    req.body = { ...req.body, client: "website", deviceId: req.websiteDevice,
      authorizationScopeIncarnation: req.path === "/login" ? "web-auth-" + randomUUID() : null };
    if (req.path === "/login") req.websiteRemember = req.body.rememberDevice === true;
  }
  next();
}
function replySession(req, res, data, web) {
  if (!web) return res.json(data);
  const persistent = req.websiteRemember;
  for (const [suffix, value, expiry] of [
    ["access", data.accessToken, data.accessTokenExpiresAt],
    ["refresh", data.refreshToken, data.refreshTokenExpiresAt],
    ["remember", persistent ? "1" : "0", data.refreshTokenExpiresAt],
    ["device", req.websiteDevice, data.refreshTokenExpiresAt],
  ]) {
    const opt = options(req);
    if (persistent && expiry) opt.expires = new Date(expiry);
    res.cookie(COOKIE + suffix, value, opt);
  }
  const { accessToken, refreshToken, ...publicSession } = data;
  return res.json(publicSession);
}
function clearSession(req, res) {
  for (const suffix of ["access", "refresh", "remember", "device"]) res.clearCookie(COOKIE + suffix, options(req));
}
module.exports = { requireWebsiteRequest, authenticateCookie, prepareAuthRequest, replySession, clearSession };
