"use strict";
const express = require("express");
const path = require("node:path");
const { rateLimit } = require("express-rate-limit");
const prisma = require("../prisma");
const { websiteConfig, websitePricing } = require("../services/website-config-service");
const { requireWebsiteRequest, authenticateCookie } = require("../services/website-session-transport");
const router = express.Router();
const site = path.join(__dirname, "../../public/site");
const pageHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" };

router.get("/api/site/config", (_req, res) => res.set("Cache-Control", "no-store").json(websiteConfig()));
router.get("/api/site/pricing", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try { return res.json(await websitePricing(prisma)); }
  catch (_) { return res.status(503).json({ ok: false, code: "PRICING_UNAVAILABLE", error: "Pricing is temporarily unavailable" }); }
});
router.use("/api/web/auth", requireWebsiteRequest, require("./auth").createAuthRouter({ web: true }));
router.use("/api/web/invitations", requireWebsiteRequest, authenticateCookie, require("./invitations"));
router.use("/api/web/workspace", requireWebsiteRequest, authenticateCookie, require("./workspace"));
router.use("/api/web/support", rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, code: "SUPPORT_RATE_LIMIT", error: "Please try again later" } }), requireWebsiteRequest, require("./website-support"));

const pages = { "/": "index", "/index.html": "index", "/pricing": "pricing", "/pricing.html": "pricing",
  "/download": "download", "/download.html": "download", "/questions": "questions", "/questions.html": "questions",
  "/help": "help", "/help.html": "help", "/auth.html": "auth", "/login": "auth", "/register": "auth",
  "/forgot-password": "auth", "/reset-password": "auth", "/verify-email": "auth", "/invite": "auth", "/account": "auth" };
for (const [route, file] of Object.entries(pages)) router.get(route, (_req, res) => res.set(pageHeaders).sendFile(path.join(site, file + ".html")));
router.get("/invite/:token", (_req, res) => res.set(pageHeaders).sendFile(path.join(site, "auth.html")));
router.use("/site", express.static(site, { index: false, dotfiles: "deny", setHeaders(res, file) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (file.endsWith(".html")) for (const [name, value] of Object.entries(pageHeaders)) res.setHeader(name, value);
} }));
module.exports = router;
