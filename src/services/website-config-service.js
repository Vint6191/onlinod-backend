"use strict";

function externalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}
function mailConfiguration(env = process.env) {
  const key = String(env.SNAPSHOT_ENCRYPTION_KEY || "");
  const encryptedPayloads = /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, "base64").length === 32;
  let publicOrigin = false;
  try {
    const url = new URL(env.APP_URL || env.PUBLIC_BASE_URL || "");
    publicOrigin = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" &&
      (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch (_) {}
  return { available: Boolean(env.RESEND_API_KEY && encryptedPayloads && publicOrigin) };
}
function requireAuthMail(res) {
  if (mailConfiguration().available) return true;
  res.status(503).json({ ok: false, code: "AUTH_EMAIL_UNAVAILABLE", error: "Email delivery is not configured. Contact support." });
  return false;
}
function websiteConfig(env = process.env) {
  const releases = {};
  for (const platform of ["windows", "macos"]) {
    const prefix = `NOD_${platform.toUpperCase()}_`;
    const url = externalUrl(env[prefix + "DOWNLOAD_URL"]);
    const version = String(env[prefix + "VERSION"] || "").trim().slice(0, 60);
    const sha256 = String(env[prefix + "SHA256"] || "").trim().toLowerCase();
    const available = Boolean(url && version && /^[a-f0-9]{64}$/.test(sha256));
    releases[platform] = { label: platform === "windows" ? "Windows" : "macOS", confirmed: available,
      url: available ? url : null, version: available ? version : null, sha256: available ? sha256 : null,
      sizeBytes: Number(env[prefix + "SIZE_BYTES"]) > 0 ? Number(env[prefix + "SIZE_BYTES"]) : null,
      minimumOS: String(env[prefix + "MINIMUM_OS"] || "").slice(0, 100) || null,
      architecture: String(env[prefix + "ARCHITECTURE"] || "").slice(0, 40) || null };
  }
  return { ok: true, email: mailConfiguration(env), releases,
    support: { available: Boolean(env.RESEND_API_KEY && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SUPPORT_EMAIL || "")) },
    legal: { terms: externalUrl(env.NOD_TERMS_URL), privacy: externalUrl(env.NOD_PRIVACY_URL) } };
}
async function websitePricing(db) {
  const { readCommercialPolicy } = require("./billing-commercial-policy-service");
  const { catalogForClient } = require("./billing-catalog-service");
  const policy = await readCommercialPolicy({ db });
  const catalog = catalogForClient(policy);
  return { ok: true, status: "CURRENT", currency: policy.currency, revision: policy.revision,
    settings: policy.settings, tiers: catalog.tiers.filter(t => t.key !== "CUSTOM").map(t => ({ key: t.key, label: t.label, min: t.minRevenueCents, max: t.maxRevenueCentsExclusive, cents: t.priceCents })) };
}
module.exports = { externalUrl, mailConfiguration, requireAuthMail, websiteConfig, websitePricing };
