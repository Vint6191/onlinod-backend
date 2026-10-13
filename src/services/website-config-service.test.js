"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { websiteConfig, websitePricing } = require("./website-config-service");
const { DEFAULT_SETTINGS } = require("./billing-commercial-policy-service");
test("public configuration contains no secrets and requires real mail prerequisites", () => {
  const env = { RESEND_API_KEY: "private-key", SNAPSHOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), SUPPORT_EMAIL: "support@example.test", DATABASE_URL: "private-db", APP_URL: "https://nod.example.test" };
  const config = websiteConfig(env); assert.equal(config.email.available, true); assert.equal(config.support.available, true);
  assert.ok(!JSON.stringify(config).includes("private")); assert.ok(!JSON.stringify(config).includes(env.SNAPSHOT_ENCRYPTION_KEY));
  assert.equal(websiteConfig({ RESEND_API_KEY: "present" }).email.available, false); assert.equal(websiteConfig({}).support.available, false);
  for (const APP_URL of ["", "http://nod.example.test", "https://nod.example.test/path", "https://user:pass@nod.example.test"]) {
    assert.equal(websiteConfig({ ...env, APP_URL }).email.available, false);
  }
});
test("a release needs HTTPS, a version and SHA-256; invalid links never become downloads", () => {
  const env = { NOD_WINDOWS_DOWNLOAD_URL: "https://downloads.example.test/NOD.exe", NOD_WINDOWS_VERSION: "1.0.0", NOD_WINDOWS_SHA256: "a".repeat(64) };
  assert.equal(websiteConfig(env).releases.windows.confirmed, true);
  for (const value of ["javascript:alert(1)", "http://downloads.example.test/NOD.exe", "https://user:pass@example.test/NOD.exe"]) {
    assert.equal(websiteConfig({ ...env, NOD_WINDOWS_DOWNLOAD_URL: value }).releases.windows.url, null);
  }
  assert.equal(websiteConfig({ ...env, NOD_WINDOWS_SHA256: "" }).releases.windows.confirmed, false);
});
test("public pricing reads current global policy and fails if unavailable instead of showing seed prices", async () => {
  const settings = { ...DEFAULT_SETTINGS, trialDays: 21, starterPriceCents: 2700 };
  const data = await websitePricing({ systemSetting: { findUnique: async () => ({ revision: 17, value: settings }) } });
  assert.equal(data.revision, 17); assert.equal(data.settings.trialDays, 21); assert.equal(data.tiers[0].cents, 2700); assert.equal(data.tiers[1].min, 100000);
  await assert.rejects(() => websitePricing({ systemSetting: { findUnique: async () => null } }), { code: "BILLING_COMMERCIAL_POLICY_UNAVAILABLE" });
});
