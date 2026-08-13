"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const serviceSource = fs.readFileSync(path.join(__dirname, "settings-service.js"), "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "routes", "settings.js"), "utf8");
const accessSource = fs.readFileSync(path.join(__dirname, "team-access-control.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "src", "routes", "admin.js"), "utf8");

function loadSettingsService() {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "bcryptjs") return { compare: async () => true, hash: async () => "hash" };
    if (request === "../prisma") return {};
    if (request === "./auth-service") return { publicUser: (u) => u, issuePasswordReset: async () => ({ emailResult: { ok: true, skipped: false } }) };
    if (request === "./audit-service") return { audit: async () => null };
    if (request === "./team-access-control") return { canUsePermission: async () => true, isOwner: (member) => member?.role === "OWNER" || member?.roleKey === "owner" };
    if (request === "./billing-nowpayments-service") return { publicProviderConfig: () => ({ providerKey: "NOWPAYMENTS", environment: "disabled", configured: false, checkoutAvailable: false, testMode: false, feePaidByUser: false, sandboxActivationEnabled: false, liveCheckoutBlockedByInternalTestMode: false, missingConfiguration: ["NOWPAYMENTS_MODE"] }), recentOrders: async () => [] };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./settings-service")];
    return require("./settings-service");
  } finally {
    Module._load = original;
  }
}

test("workspace settings normalize real IANA/time/date preferences", () => {
  const service = loadSettingsService();
  assert.equal(service.isValidTimezone("Europe/Kyiv"), true);
  assert.equal(service.isValidTimezone("UTC+3-onlinod"), false);
  assert.deepEqual(service.normalizeWorkspacePreferences({ timezone: "Europe/Kyiv", timeFormat: "12h", dateFormat: "YYYY-MM-DD" }), {
    timezone: "Europe/Kyiv", timeFormat: "12h", dateFormat: "YYYY-MM-DD",
  });
  assert.deepEqual(service.normalizeWorkspacePreferences({ timezone: "fake", timeFormat: "x", dateFormat: "x" }), {
    timezone: "UTC", timeFormat: "24h", dateFormat: "DD.MM.YYYY",
  });
});

test("workspace mutation is guarded by a dedicated server permission", () => {
  assert.match(accessSource, /workspace\.manage_settings/);
  assert.match(accessSource, /Edit workspace settings/);
  assert.match(serviceSource, /canUsePermission\(\{ member, key: "workspace\.manage_settings"/);
  assert.match(serviceSource, /SETTINGS_WORKSPACE_FORBIDDEN/);
  assert.doesNotMatch(routeSource, /allowedSettings\s*=\s*\["timezone"/);
});

test("account settings are real self-service routes with read-only email", () => {
  for (const fragment of [
    'router.get("/account"',
    'router.patch("/account/profile"',
    'router.post("/account/avatar"',
    'router.post("/account/password"',
    'router.post("/account/forgot-password"',
    'router.delete("/account/sessions/:sessionId"',
    'router.post("/account/sessions/revoke-others"',
  ]) assert.ok(routeSource.includes(fragment), fragment);
  assert.match(serviceSource, /bcrypt\.compare\(current, user\.passwordHash\)/);
  assert.match(serviceSource, /refreshSession\.updateMany/);
  assert.match(serviceSource, /deviceId: \{ not: deviceId \}/);
  assert.doesNotMatch(serviceSource, /data:\s*\{[^}]*email:/s);
});

test("avatar upload is bounded and validates file bytes", () => {
  assert.match(routeSource, /3 \* 1024 \* 1024/);
  assert.match(routeSource, /image\/jpeg/);
  assert.match(routeSource, /89504e470d0a1a0a/);
  assert.match(routeSource, /WEBP/);
  assert.match(routeSource, /LIMIT_FILE_SIZE/);
});

test("billing settings read model is owner-only and supports explicit free internal test mode", () => {
  assert.match(serviceSource, /if \(!isOwner\(member\)\) return \{ available: false, reason: "OWNER_ONLY" \}/);
  assert.match(serviceSource, /billingMode === "FREE_INTERNAL"/);
  assert.match(serviceSource, /publicProviderConfig\(\)/);
  assert.match(serviceSource, /recentOrders\(/);
  assert.match(adminSource, /"FREE_INTERNAL"/);
  assert.match(adminSource, /billingMode: input\.billingMode/);
  assert.match(adminSource, /billingPeriod: input\.billingPeriod/);
  assert.doesNotMatch(routeSource, /checkout|payment-method|invoice\/create/i);
});

test("settings audit never includes plaintext passwords", () => {
  assert.match(serviceSource, /settings\.account\.password_changed/);
  const auditLine = serviceSource.split("\n").find((line) => line.includes('settings.account.password_changed')) || "";
  assert.doesNotMatch(auditLine, /currentPassword|newPassword|passwordHash/);
});

test("workspace patch validates all fields before any persistent write", async () => {
  const service = loadSettingsService();
  let writes = 0;
  const db = {
    agency: {
      findUnique: async () => ({ id: "agency-1", name: "Original", plan: "PRO", status: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null }),
      update: async () => { writes += 1; return {}; },
    },
    workspaceSetting: {
      findMany: async () => [],
      upsert: async () => { writes += 1; return {}; },
    },
    $transaction: async (fn) => fn(db),
  };
  await assert.rejects(
    service.updateWorkspaceSettings({ agencyId: "agency-1", actorUserId: "user-1", member: { role: "OWNER" }, patch: { name: "Changed", timezone: "not/a-zone" }, db }),
    /valid IANA timezone/,
  );
  assert.equal(writes, 0);
});

test("billing read model is owner-only, filters deleted creators and keeps FREE_INTERNAL explicit", async () => {
  const service = loadSettingsService();
  const db = {
    agency: { findUnique: async () => ({ id: "agency-1", name: "Agency", plan: "PRO", status: "ACTIVE" }) },
    agencySubscription: { findFirst: async () => ({ id: "sub-1", status: "ACTIVE", billingMode: "FREE_INTERNAL", billingPeriod: "MONTHLY", corePricePerCreatorCents: 2000, trialEndsAt: null, graceUntil: null, currentPeriodStart: null, currentPeriodEnd: null }) },
    creatorAccount: { findMany: async () => [
      { id: "creator-1", displayName: "Alive", username: "alive", billingProfile: { tier: "STARTER", corePriceCents: 2000, aiChatterEnabled: false, aiChatterPriceCents: 0, outreachEnabled: false, outreachPriceCents: 0, billingExcluded: false } },
      { id: "creator-2", displayName: "No profile", username: "missing", billingProfile: null },
    ] },
  };
  const result = await service.getBillingSettings({ agencyId: "agency-1", member: { role: "OWNER" }, db });
  assert.equal(result.available, true);
  assert.equal(result.provider.internalTestMode, true);
  assert.equal(result.provider.testMode, false);
  assert.equal(result.provider.checkoutAvailable, false);
  assert.equal(result.creators.length, 2);
  assert.equal(result.billedCreators, 2);
  assert.equal(result.creators[1].tier, "STARTER");
  assert.equal(result.creators[1].lineTotalCents, 2000);
  assert.equal(result.monthlyTotalCents, 4000);
  assert.deepEqual(await service.getBillingSettings({ agencyId: "agency-1", member: { role: "CHATTER" }, db }), { available: false, reason: "OWNER_ONLY" });
});

test("only the newest live refresh session on the current device is marked THIS DEVICE", async () => {
  const service = loadSettingsService();
  const sessions = [
    { id: "new", deviceId: "device-1", client: "desktop", userAgent: "UA", createdAt: new Date("2026-08-13T10:00:00Z"), lastUsedAt: new Date("2026-08-13T10:10:00Z"), expiresAt: new Date("2026-09-01T00:00:00Z"), rememberDevice: true },
    { id: "old-same-device", deviceId: "device-1", client: "desktop", userAgent: "UA", createdAt: new Date("2026-08-12T10:00:00Z"), lastUsedAt: new Date("2026-08-12T10:10:00Z"), expiresAt: new Date("2026-09-01T00:00:00Z"), rememberDevice: true },
    { id: "other", deviceId: "device-2", client: "desktop", userAgent: "UA2", createdAt: new Date("2026-08-13T09:00:00Z"), lastUsedAt: new Date("2026-08-13T09:10:00Z"), expiresAt: new Date("2026-09-01T00:00:00Z"), rememberDevice: false },
  ];
  const db = {
    user: { findUnique: async () => ({ id: "user-1", email: "a@b.c" }) },
    refreshSession: { findMany: async () => sessions },
  };
  const result = await service.getAccountSettings({ userId: "user-1", currentDeviceId: "device-1", db });
  assert.equal(result.sessions.filter((row) => row.isThisDevice).length, 1);
  assert.equal(result.sessions.find((row) => row.isThisDevice).id, "new");
});
