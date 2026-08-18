"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const routeSource = fs.readFileSync(path.join(root, "src", "routes", "settings.js"), "utf8");
const schemaSource = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

function loadSettingsService() {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "bcryptjs") return { compare: async () => true, hash: async () => "hash" };
    if (request === "../prisma") return {};
    if (request === "./auth-service") return { publicUser: (u) => u, issuePasswordReset: async () => ({ emailResult: { ok: true, skipped: false } }) };
    if (request === "./audit-service") return { audit: async () => null };
    if (request === "./team-access-control") return { canUsePermission: async () => true, isOwner: (member) => member?.role === "OWNER" || member?.roleKey === "owner" };
    if (request === "./billing-nowpayments-service") return { publicProviderConfig: () => ({ providerKey: "NOWPAYMENTS", environment: "disabled", configured: false, checkoutAvailable: false, testMode: false, feePaidByUser: false, sandboxActivationEnabled: false, liveAutoPricingEnabled: false, liveCheckoutBlockedByInternalTestMode: false, missingConfiguration: ["NOWPAYMENTS_MODE"] }), recentOrders: async () => [] };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./settings-service")];
    return require("./settings-service");
  } finally {
    Module._load = original;
  }
}

test("Telegram MTProto storage is agency-scoped, owner-only and never returns secrets", async () => {
  const service = loadSettingsService();
  let stored = null;
  const db = {
    agencyTelegramMtprotoAccount: {
      create: async ({ data }) => {
        stored = { id: "tg-1", ...data };
        return { id: "tg-1", apiId: data.apiId };
      },
      findMany: async ({ where }) => {
        assert.equal(where.agencyId, "agency-1");
        return stored ? [{ ...stored }] : [];
      },
      findFirst: async ({ where }) => where.id === "tg-1" && where.agencyId === "agency-1" ? { id: "tg-1" } : null,
      delete: async ({ where }) => { assert.equal(where.id, "tg-1"); stored = null; return {}; },
    },
  };
  const owner = { role: "OWNER" };
  const added = await service.addTelegramMtprotoAccount({
    agencyId: "agency-1",
    member: owner,
    apiId: 12345678,
    apiHash: "0123456789abcdef0123456789abcdef",
    session: "SESSION_SECRET_VALUE",
    db,
  });
  assert.deepEqual(added, { available: true, account: { id: "tg-1", apiId: 12345678, sessionReady: true, connected: false, authStage: null } });
  assert.equal(stored.agencyId, "agency-1");
  assert.equal(stored.encryptedPayload.includes("SESSION_SECRET_VALUE"), false);
  assert.equal(stored.encryptedPayload.includes("0123456789abcdef"), false);
  assert.equal(stored.algorithm, "aes-256-gcm");

  const listed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: owner, db });
  assert.deepEqual(listed, { available: true, accounts: [{ id: "tg-1", apiId: 12345678, sessionReady: true, connected: false, authStage: null }] });
  assert.equal(JSON.stringify(listed).includes("SESSION_SECRET_VALUE"), false);
  assert.equal(JSON.stringify(listed).includes("0123456789abcdef"), false);

  assert.deepEqual(await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: { role: "CHATTER" }, db }), { available: false, reason: "OWNER_ONLY", accounts: [] });
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "agency-1", member: { role: "MANAGER" }, apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", session: "x", db }), /Only the agency owner/);

  await service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db });
  assert.equal(stored, null);
});

test("Telegram MTProto API credentials validate id/hash and allow session to be added later", async () => {
  const service = loadSettingsService();
  let writes = 0;
  const db = { agencyTelegramMtprotoAccount: { create: async () => { writes += 1; } } };
  const owner = { role: "OWNER" };
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "a", member: owner, apiId: "abc", apiHash: "0123456789abcdef0123456789abcdef", session: "session", db }), /positive integer/);
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "a", member: owner, apiId: 1, apiHash: "wrong", session: "session", db }), /32 hexadecimal/);
  const apiOnly = await service.addTelegramMtprotoAccount({ agencyId: "a", member: owner, apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", db });
  assert.equal(apiOnly.available, true);
  assert.equal(writes, 1);
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "a", member: owner, apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", session: "x".repeat(262145), db }), /smaller than 256 KB/);
  assert.equal(writes, 1);
});

test("Settings routes expose owner-scoped MTProto auth and a fixed @runronin connection test without recipient input", () => {
  assert.match(routeSource, /router\.get\("\/telegram"/);
  assert.match(routeSource, /router\.post\("\/telegram\/accounts"/);
  assert.match(routeSource, /router\.delete\("\/telegram\/accounts\/:accountId"/);
  assert.match(routeSource, /\/telegram\/accounts\/:accountId\/auth\/start/);
  assert.match(routeSource, /\/telegram\/accounts\/:accountId\/auth\/code/);
  assert.match(routeSource, /\/telegram\/accounts\/:accountId\/auth\/password/);
  assert.match(routeSource, /router\.get\("\/telegram\/accounts\/:accountId\/auth\/:challengeId"/);
  assert.match(routeSource, /router\.delete\("\/telegram\/accounts\/:accountId\/auth\/:challengeId"/);
  assert.match(routeSource, /\/telegram\/accounts\/:accountId\/test/);
  assert.match(routeSource, /\/telegram\/accounts\/:accountId\/test-status/);
  const testRoute = routeSource.split('router.post("/telegram/accounts/:accountId/test"')[1].split('router.get("/telegram/accounts/:accountId/test-status"')[0];
  assert.doesNotMatch(testRoute, /req\.body|recipient|username/);
  assert.doesNotMatch(routeSource, /auth\.exportLoginToken|QR/i);
  assert.match(schemaSource, /model AgencyTelegramMtprotoAccount/);
  assert.doesNotMatch(schemaSource.split("model AgencyTelegramMtprotoAccount")[1].split("model AgencyMember")[0], /createdAt|updatedAt|deletedAt|username|displayName|phone/);
});
