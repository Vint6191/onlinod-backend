"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", "..");
const routeSource = fs.readFileSync(path.join(root, "src", "routes", "settings.js"), "utf8");
const schemaSource = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

const DEFAULT_REMINDERS = {
  content: { enabled: true, firstAfterMinutes: 30, repeatEveryMinutes: 60, text: "Напоминание: у тебя есть незавершённый кастом «{custom}». Дедлайн: {deadline}." },
  call: { enabled: true, offsetsMinutes: [30, 5], text: "Созвон через {minutes} мин. Не пропусти: «{custom}»." },
  physical: { enabled: false, repeatEveryMinutes: 1440, text: "Напоминание по физическому заказу «{custom}»: проверь статус отправки." },
};

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

test("Telegram MTProto storage is agency-scoped, owner/admin managed and never returns secrets", async () => {
  const service = loadSettingsService();
  let stored = null;
  const db = {
    workspaceSetting: { findUnique: async () => null, upsert: async ({ create, update }) => ({ ...(create || update) }) },
    creatorAccount: { updateMany: async () => ({ count: 0 }) },
    agencyTelegramMtprotoAccount: {
      create: async ({ data }) => {
        stored = { id: "tg-1", ...data };
        return { id: "tg-1", apiId: data.apiId };
      },
      findMany: async ({ where }) => {
        assert.equal(where.agencyId, "agency-1");
        return stored ? [{ ...stored }] : [];
      },
      findFirst: async ({ where }) => where.id === "tg-1" && where.agencyId === "agency-1" ? { ...stored } : null,
      update: async ({ where, data }) => { assert.equal(where.id, "tg-1"); stored = { ...stored, ...data }; return { id: "tg-1" }; },
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
  assert.deepEqual(added, { available: true, account: { id: "tg-1", apiId: 12345678, sessionReady: true } });
  assert.equal(stored.agencyId, "agency-1");
  assert.equal(stored.encryptedPayload.includes("SESSION_SECRET_VALUE"), false);
  assert.equal(stored.encryptedPayload.includes("0123456789abcdef"), false);
  assert.equal(stored.algorithm, "aes-256-gcm");

  const listed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: owner, db });
  assert.deepEqual(listed, { available: true, accounts: [{ id: "tg-1", apiId: 12345678, sessionReady: true }], reminders: DEFAULT_REMINDERS });
  assert.equal(JSON.stringify(listed).includes("SESSION_SECRET_VALUE"), false);
  assert.equal(JSON.stringify(listed).includes("0123456789abcdef"), false);

  const adminListed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: { role: "ADMIN" }, db });
  assert.equal(adminListed.available, true);
  assert.deepEqual(await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: { role: "CHATTER" }, db }), { available: false, reason: "OWNER_OR_ADMIN_ONLY", accounts: [], reminders: DEFAULT_REMINDERS });
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "agency-1", member: { role: "MANAGER" }, apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", session: "x", db }), /owner or administrator/);

  const authMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "authorize", db });
  assert.deepEqual(authMaterial, { accountId: "tg-1", apiId: 12345678, apiHash: "0123456789abcdef0123456789abcdef", session: "" });
  const messagingMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: { role: "ADMIN" }, accountId: "tg-1", purpose: "messaging", db });
  assert.equal(messagingMaterial.session, "SESSION_SECRET_VALUE");

  const storedSession = await service.storeTelegramMtprotoSession({ agencyId: "agency-1", member: owner, accountId: "tg-1", session: "LOCAL_DESKTOP_SESSION", db });
  assert.deepEqual(storedSession, { id: "tg-1", apiId: 12345678, sessionReady: true });
  assert.equal(stored.encryptedPayload.includes("LOCAL_DESKTOP_SESSION"), false);
  const after = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "messaging", db });
  assert.equal(after.session, "LOCAL_DESKTOP_SESSION");

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

test("messaging material requires an authorized stored session", async () => {
  const service = loadSettingsService();
  const db = {
    agencyTelegramMtprotoAccount: {
      findFirst: async () => ({
        id: "tg-api-only",
        apiId: 9001,
        encryptedPayload: "", iv: "", tag: "", algorithm: "aes-256-gcm", payloadVersion: 1,
      }),
    },
  };
  // Use the real credential encryptor shape by creating an API-only record first.
  let stored = null;
  db.agencyTelegramMtprotoAccount.create = async ({ data }) => { stored = { id: "tg-api-only", ...data }; return { id: "tg-api-only", apiId: data.apiId }; };
  db.agencyTelegramMtprotoAccount.findFirst = async () => stored;
  await service.addTelegramMtprotoAccount({ agencyId: "a", member: { role: "ADMIN" }, apiId: 9001, apiHash: "0123456789abcdef0123456789abcdef", db });
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "a", member: { role: "ADMIN" }, accountId: "tg-api-only", purpose: "messaging", db }),
    (error) => error?.code === "SETTINGS_TELEGRAM_SESSION_REQUIRED",
  );
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "a", member: { role: "ADMIN" }, accountId: "tg-api-only", purpose: "test", db }),
    (error) => error?.code === "SETTINGS_TELEGRAM_LOCAL_PURPOSE_INVALID",
  );
});

test("Backend is MTProto storage-only: Desktop gets local material and hands a session back", () => {
  const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const serviceSource = fs.readFileSync(path.join(root, "src", "services", "settings-service.js"), "utf8");
  assert.match(routeSource, /router\.get\("\/telegram"/);
  assert.match(routeSource, /router\.patch\("\/telegram\/reminders"/);
  assert.match(routeSource, /router\.post\("\/telegram\/accounts"/);
  assert.match(routeSource, /router\.delete\("\/telegram\/accounts\/:accountId"/);
  assert.match(routeSource, /router\.post\("\/telegram\/accounts\/:accountId\/local-material"/);
  assert.match(routeSource, /router\.put\("\/telegram\/accounts\/:accountId\/session"/);
  assert.match(routeSource, /Cache-Control", "no-store, private/);

  assert.doesNotMatch(routeSource, /\/auth\/start|\/auth\/code|\/auth\/password|\/test-status|\/:accountId\/test/);
  assert.doesNotMatch(serviceSource, /telegram-mtproto-runtime|beginTelegramAuthorization|testTelegramConnection/);
  assert.doesNotMatch(packageSource, /"teleproto"/);
  assert.doesNotMatch(routeSource, /auth\.sendCode|auth\.signIn|auth\.checkPassword|TelegramClient|StringSession/);
  assert.equal(fs.existsSync(path.join(root, "src", "services", "telegram-mtproto-runtime.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "services", "telegram-mtproto-runtime.test.js")), false);

  assert.match(schemaSource, /model AgencyTelegramMtprotoAccount/);
  assert.doesNotMatch(schemaSource.split("model AgencyTelegramMtprotoAccount")[1].split("model AgencyMember")[0], /createdAt|updatedAt|deletedAt|username|displayName|phone/);
});
