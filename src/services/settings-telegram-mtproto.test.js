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
    creatorAccount: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async ({ where }) => where.id === "creator-1" && where.agencyId === "agency-1" ? { id: "creator-1", agencyId: "agency-1", displayName: "Model", username: "model", status: "READY", telegramContact: "@model", telegramAccountId: "tg-1", deletedAt: null } : null,
      findMany: async ({ where }) => where.agencyId === "agency-1" ? [{ id: "creator-1", telegramContact: "@model", telegramAccountId: "tg-1" }] : [],
    },
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
  assert.deepEqual(added, { available: true, account: { id: "tg-1", apiId: 12345678, sessionReady: true, customBotReady: false, customBotUsername: null } });
  assert.equal(stored.agencyId, "agency-1");
  assert.equal(stored.encryptedPayload.includes("SESSION_SECRET_VALUE"), false);
  assert.equal(stored.encryptedPayload.includes("0123456789abcdef"), false);
  assert.equal(stored.algorithm, "aes-256-gcm");

  const listed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: owner, db });
  assert.deepEqual(listed, { available: true, accounts: [{ id: "tg-1", apiId: 12345678, sessionReady: true, customBotReady: false, customBotUsername: null }], reminders: DEFAULT_REMINDERS });
  assert.equal(JSON.stringify(listed).includes("SESSION_SECRET_VALUE"), false);
  assert.equal(JSON.stringify(listed).includes("0123456789abcdef"), false);

  const adminListed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: { role: "ADMIN" }, db });
  assert.equal(adminListed.available, true);
  assert.deepEqual(await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: { role: "CHATTER" }, db }), { available: false, reason: "OWNER_OR_ADMIN_ONLY", accounts: [], reminders: DEFAULT_REMINDERS });
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "agency-1", member: { role: "MANAGER" }, apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", session: "x", db }), /owner or administrator/);

  const authMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "authorize", db });
  assert.deepEqual(authMaterial, { accountId: "tg-1", apiId: 12345678, apiHash: "0123456789abcdef0123456789abcdef", session: "" });
  const messagingMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: { role: "ADMIN" }, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", db });
  assert.equal(messagingMaterial.session, "SESSION_SECRET_VALUE");
  const chatterMaterial = await service.issueTelegramMtprotoLocalMaterial({
    agencyId: "agency-1",
    member: { role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"] },
    accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", db,
  });
  assert.equal(chatterMaterial.session, "SESSION_SECRET_VALUE", "creator-scoped chatter execution is allowed without Telegram settings-management rights");
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: { role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"] }, accountId: "tg-1", purpose: "messaging", db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_SCOPE_REQUIRED",
    "messaging material can never be requested as a raw Telegram-account secret without a creator scope",
  );
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: { role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"] }, accountId: "tg-1", creatorId: "creator-1", purpose: "authorize", db }),
    /owner or administrator/i,
    "authorization and Telegram account management remain owner/admin-only",
  );

  const storedSession = await service.storeTelegramMtprotoSession({ agencyId: "agency-1", member: owner, accountId: "tg-1", session: "LOCAL_DESKTOP_SESSION", db });
  assert.deepEqual(storedSession, { id: "tg-1", apiId: 12345678, sessionReady: true, customBotReady: false, customBotUsername: null });
  assert.equal(stored.encryptedPayload.includes("LOCAL_DESKTOP_SESSION"), false);
  const after = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", db });
  assert.equal(after.session, "LOCAL_DESKTOP_SESSION");

  await service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db });
  assert.equal(stored, null);
});


test("standard BotFather upload bot is validated once, encrypted, creator-scoped and never exposed in settings", async () => {
  const service = loadSettingsService();
  let stored = null;
  const db = {
    workspaceSetting: { findUnique: async () => null, upsert: async () => ({}) },
    creatorAccount: {
      findFirst: async ({ where }) => where.id === "creator-1" ? { id: "creator-1", agencyId: "agency-1", telegramContact: "@model", telegramAccountId: "tg-1", deletedAt: null } : null,
      findMany: async () => [{ id: "creator-1", telegramContact: "@model", telegramAccountId: "tg-1" }],
      updateMany: async () => ({ count: 0 }),
    },
    agencyTelegramMtprotoAccount: {
      create: async ({ data }) => { stored = { id: "tg-1", ...data, customBotUsername: null }; return { id: "tg-1", apiId: data.apiId }; },
      findMany: async ({ where }) => stored && where.agencyId === "agency-1" ? [{ ...stored }] : [],
      findFirst: async ({ where }) => {
        if (where.customBotUsername !== undefined) {
          if (!stored || stored.customBotUsername !== where.customBotUsername) return null;
          if (where.id?.not && stored.id === where.id.not) return null;
          return { id: stored.id, agencyId: stored.agencyId };
        }
        return stored && where.id === "tg-1" && where.agencyId === "agency-1" ? { ...stored } : null;
      },
      update: async ({ data }) => { stored = { ...stored, ...data }; return { id: "tg-1" }; },
    },
  };
  const owner = { role: "OWNER", userId: "owner-1" };
  await service.addTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, apiId: 12345678, apiHash: "0123456789abcdef0123456789abcdef", session: "USER_SESSION", db });
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_1234567890";
  const fetchImpl = async (url, options) => {
    assert.equal(url, `https://api.telegram.org/bot${token}/getMe`);
    assert.equal(options.method, "POST");
    return { ok: true, async json() { return { ok: true, result: { id: 42, is_bot: true, username: "onlinod_upload_bot" } }; } };
  };
  const saved = await service.storeTelegramStandardBot({ agencyId: "agency-1", member: owner, accountId: "tg-1", botToken: token, db, fetchImpl });
  assert.deepEqual(saved, { id: "tg-1", apiId: 12345678, sessionReady: true, customBotReady: true, customBotUsername: "@onlinod_upload_bot" });
  assert.equal(stored.encryptedPayload.includes(token), false, "bot token is encrypted inside the existing credential blob");

  const listed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: owner, db });
  assert.equal(listed.accounts[0].customBotReady, true);
  assert.equal(listed.accounts[0].customBotUsername, "@onlinod_upload_bot");
  assert.equal(JSON.stringify(listed).includes(token), false);

  const authMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "authorize", db });
  assert.equal("customBotToken" in authMaterial, false, "authorization flow never receives the bot token");
  const chatterMaterial = await service.issueTelegramMtprotoLocalMaterial({
    agencyId: "agency-1", member: { role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"] },
    accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", db,
  });
  assert.equal(chatterMaterial.customBotToken, token, "only creator-scoped MAIN execution material contains the bot token");
  assert.equal(chatterMaterial.customBotUsername, "@onlinod_upload_bot");

  await service.storeTelegramMtprotoSession({ agencyId: "agency-1", member: owner, accountId: "tg-1", session: "REAUTHED_USER_SESSION", db });
  const afterReauth = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", db });
  assert.equal(afterReauth.customBotToken, token, "reauthorizing the user account preserves the upload bot");

  const removed = await service.removeTelegramStandardBot({ agencyId: "agency-1", member: owner, accountId: "tg-1", db });
  assert.equal(removed.customBotReady, false);
  const afterRemove = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", db });
  assert.equal(afterRemove.session, "REAUTHED_USER_SESSION");
  assert.equal("customBotToken" in afterRemove, false);
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
    creatorAccount: {
      findFirst: async ({ where }) => where.id === "creator-api" ? { id: "creator-api", agencyId: "a", displayName: "Model", username: "model", status: "READY", telegramContact: "@model", telegramAccountId: "tg-api-only", deletedAt: null } : null,
      findMany: async () => [{ id: "creator-api", telegramContact: "@model", telegramAccountId: "tg-api-only" }],
    },
    agencyTelegramMtprotoAccount: {
      findFirst: async () => ({
        id: "tg-api-only",
        apiId: 9001,
        encryptedPayload: "", iv: "", tag: "", algorithm: "aes-256-gcm", payloadVersion: 1,
      }),
      findMany: async () => [{ id: "tg-api-only" }],
    },
  };
  // Use the real credential encryptor shape by creating an API-only record first.
  let stored = null;
  db.agencyTelegramMtprotoAccount.create = async ({ data }) => { stored = { id: "tg-api-only", ...data }; return { id: "tg-api-only", apiId: data.apiId }; };
  db.agencyTelegramMtprotoAccount.findFirst = async () => stored;
  await service.addTelegramMtprotoAccount({ agencyId: "a", member: { role: "ADMIN" }, apiId: 9001, apiHash: "0123456789abcdef0123456789abcdef", db });
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "a", member: { role: "ADMIN" }, accountId: "tg-api-only", creatorId: "creator-api", purpose: "messaging", db }),
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
  assert.match(routeSource, /router\.post\("\/telegram\/runtime\/claim"/);
  assert.match(routeSource, /router\.post\("\/telegram\/runtime\/:accountId\/release"/);
  assert.match(routeSource, /Cache-Control", "no-store, private/);

  assert.doesNotMatch(routeSource, /\/auth\/start|\/auth\/code|\/auth\/password|\/test-status|\/:accountId\/test/);
  assert.doesNotMatch(serviceSource, /telegram-mtproto-runtime|beginTelegramAuthorization|testTelegramConnection/);
  assert.doesNotMatch(packageSource, /"teleproto"/);
  assert.doesNotMatch(routeSource, /auth\.sendCode|auth\.signIn|auth\.checkPassword|TelegramClient|StringSession/);
  assert.equal(fs.existsSync(path.join(root, "src", "services", "telegram-mtproto-runtime.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "services", "telegram-mtproto-runtime.test.js")), false);

  assert.match(schemaSource, /model AgencyTelegramMtprotoAccount/);
  const telegramAccountBlock = schemaSource.split("model AgencyTelegramMtprotoAccount")[1].split("model AgencyMember")[0];
  assert.match(telegramAccountBlock, /runtimeClaimedByDeviceId\s+String\?/);
  assert.match(telegramAccountBlock, /runtimeClaimToken\s+String\?/);
  assert.match(telegramAccountBlock, /runtimeClaimUntil\s+DateTime\?/);
  assert.doesNotMatch(telegramAccountBlock, /createdAt|updatedAt|deletedAt|username|displayName|phone/);
});
