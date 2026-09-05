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

function loadSettingsService({ auditImpl = async () => null } = {}) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "bcryptjs") return { compare: async () => true, hash: async () => "hash" };
    if (request === "../prisma") return {};
    if (request === "./auth-service") return { publicUser: (u) => u, issuePasswordReset: async () => ({ emailResult: { ok: true, skipped: false } }) };
    if (request === "./audit-service") return { audit: auditImpl };
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
      updateMany: async ({ where, data }) => {
        if (!stored || where.id !== "tg-1" || where.agencyId !== "agency-1") return { count: 0 };
        const state = String(stored.lifecycleState || "ACTIVE");
        const allowedState = !where.lifecycleState || where.lifecycleState === state
          || (Array.isArray(where.OR) && where.OR.some((entry) => entry?.lifecycleState === state || (entry?.lifecycleState === null && !stored.lifecycleState)));
        if (!allowedState) return { count: 0 };
        stored = { ...stored, ...data };
        return { count: 1 };
      },
      delete: async ({ where }) => { assert.equal(where.id, "tg-1"); stored = null; return {}; },
    },
  };
  db.$transaction = async (fn) => fn(db);
  const owner = { id: "member-owner", userId: "user-owner", role: "OWNER", roleKey: "owner", accessEpoch: 1, assignedCreators: "all" };
  const admin = { id: "member-admin", userId: "user-admin", role: "ADMIN", roleKey: "admin", accessEpoch: 1, assignedCreators: "all" };
  const chatter = { id: "member-chatter", userId: "user-chatter", role: "OPERATOR", roleKey: "chatter", accessEpoch: 1, assignedCreators: ["creator-1"] };
  db.agencyMember = {
    findFirst: async ({ where }) => {
      const candidates = [owner, admin, chatter];
      const found = candidates.find((member) => member.id === where.id && member.userId === where.userId);
      return found ? { ...found, agencyId: "agency-1", deletedAt: null, deactivatedAt: null } : null;
    },
  };
  const leaseTo = (member, deviceId, creatorId = "creator-1") => {
    stored = {
      ...stored,
      runtimeClaimedByDeviceId: deviceId,
      runtimeClaimToken: `token-${member.id}`,
      runtimeClaimUntil: new Date(Date.now() + 60_000),
      runtimeLeaseUserId: member.userId,
      runtimeLeaseMemberId: member.id,
      runtimeLeaseAccessEpoch: member.accessEpoch,
      runtimeLeaseCreatorId: creatorId,
    };
    return { deviceId, claimToken: stored.runtimeClaimToken };
  };
  const added = await service.addTelegramMtprotoAccount({
    agencyId: "agency-1",
    member: owner,
    apiId: 12345678,
    apiHash: "0123456789abcdef0123456789abcdef",
    session: "SESSION_SECRET_VALUE",
    db,
  });
  assert.deepEqual(added, { available: true, account: { id: "tg-1", apiId: 12345678, sessionReady: true, lifecycleState: "ACTIVE", retirementRequestedAt: null, drainRequired: false, drainCompleted: false, forceRetireAvailable: false } });
  assert.equal(stored.agencyId, "agency-1");
  assert.equal(stored.encryptedPayload.includes("SESSION_SECRET_VALUE"), false);
  assert.equal(stored.encryptedPayload.includes("0123456789abcdef"), false);
  assert.equal(stored.algorithm, "aes-256-gcm");

  const listed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: owner, db });
  assert.deepEqual(listed, { available: true, accounts: [{ id: "tg-1", apiId: 12345678, sessionReady: true, lifecycleState: "ACTIVE", retirementRequestedAt: null, drainRequired: false, drainCompleted: false, forceRetireAvailable: false }], reminders: DEFAULT_REMINDERS });
  assert.equal(JSON.stringify(listed).includes("SESSION_SECRET_VALUE"), false);
  assert.equal(JSON.stringify(listed).includes("0123456789abcdef"), false);

  const adminListed = await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: admin, db });
  assert.equal(adminListed.available, true);
  assert.deepEqual(await service.getTelegramMtprotoSettings({ agencyId: "agency-1", member: { role: "CHATTER" }, db }), { available: false, reason: "OWNER_OR_ADMIN_ONLY", accounts: [], reminders: DEFAULT_REMINDERS });
  await assert.rejects(() => service.addTelegramMtprotoAccount({ agencyId: "agency-1", member: { role: "MANAGER" }, apiId: 1, apiHash: "0123456789abcdef0123456789abcdef", session: "x", db }), /owner or administrator/);

  const authMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "authorize", db });
  assert.deepEqual(authMaterial, { accountId: "tg-1", apiId: 12345678, apiHash: "0123456789abcdef0123456789abcdef", session: "" });
  const adminLease = leaseTo(admin, "device-admin");
  const messagingMaterial = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: admin, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", ...adminLease, db });
  assert.equal(messagingMaterial.session, "SESSION_SECRET_VALUE");
  const chatterLease = leaseTo(chatter, "device-chatter");
  const chatterMaterial = await service.issueTelegramMtprotoLocalMaterial({
    agencyId: "agency-1",
    member: chatter,
    accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", ...chatterLease, db,
  });
  assert.equal(chatterMaterial.session, "SESSION_SECRET_VALUE", "creator-scoped chatter execution is allowed without Telegram settings-management rights");

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "./custom-content-submissions-service") {
      return {
        assertCustomSubmissionTelegramSourceAccess: async ({ agencyId, member: actor, submissionId, creatorId, accountId, messageIds }) => {
          assert.equal(agencyId, "agency-1");
          assert.equal(actor.id, chatter.id);
          assert.equal(submissionId, "submission-history-1");
          assert.equal(creatorId, "creator-1");
          assert.equal(accountId, "tg-1");
          assert.deepEqual(messageIds, ["801"]);
          return { ok: true, accountId: "tg-1", telegramSourceUserId: "987654321012345678", telegramMessageIds: ["801"] };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const sourceMaterial = await service.issueTelegramMtprotoLocalMaterial({
      agencyId: "agency-1", member: chatter, accountId: "tg-1", creatorId: "creator-1", submissionId: "submission-history-1", messageIds: ["801"], purpose: "customs-source-read", ...chatterLease, db,
    });
    assert.equal(sourceMaterial.session, "SESSION_SECRET_VALUE");
    assert.equal(sourceMaterial.sourceTelegramUserId, "987654321012345678");
  } finally {
    Module._load = originalLoad;
  }
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: chatter, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", deviceId: "device-other", claimToken: chatterLease.claimToken, db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_LEASE_INVALID",
    "messaging secret material is issued only to the signed Desktop that owns the current runtime lease",
  );
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: chatter, accountId: "tg-1", purpose: "messaging", ...chatterLease, db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_SCOPE_REQUIRED",
    "messaging material can never be requested as a raw Telegram-account secret without a creator scope",
  );
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: chatter, accountId: "tg-1", creatorId: "creator-1", purpose: "authorize", db }),
    /owner or administrator/i,
    "authorization and Telegram account management remain owner/admin-only",
  );

  const storedSession = await service.storeTelegramMtprotoSession({ agencyId: "agency-1", member: owner, accountId: "tg-1", session: "LOCAL_DESKTOP_SESSION", db });
  assert.deepEqual(storedSession, { id: "tg-1", apiId: 12345678, sessionReady: true, lifecycleState: "ACTIVE", retirementRequestedAt: null, drainRequired: false, drainCompleted: false, forceRetireAvailable: false });
  assert.equal(stored.encryptedPayload.includes("LOCAL_DESKTOP_SESSION"), false);
  const ownerLease = leaseTo(owner, "device-owner");
  const after = await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", creatorId: "creator-1", purpose: "messaging", ...ownerLease, db });
  assert.equal(after.session, "LOCAL_DESKTOP_SESSION");

  const retiring = await service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db });
  assert.equal(retiring.ok, true);
  assert.equal(retiring.retired, false);
  assert.equal(retiring.lifecycleState, "RETIRING");
  assert.equal(retiring.drainRequired, true, "committed ACTIVE -> RETIRING is returned as lifecycle state, not a generic failed DELETE");
  stored = {
    ...stored,
    retirementDrainCompletedAt: new Date(),
    runtimeClaimedByDeviceId: null, runtimeClaimToken: null, runtimeClaimUntil: null,
    runtimeLeaseUserId: null, runtimeLeaseMemberId: null, runtimeLeaseAccessEpoch: null, runtimeLeaseCreatorId: null,
  };
  await service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db });
  assert.equal(stored, null);
});

test("Telegram account deletion is fail-closed while Customs delivery/thread/source authority still depends on it", async () => {
  const service = loadSettingsService();
  const owner = { id: "owner", userId: "user-owner", role: "OWNER", roleKey: "owner" };
  const baseDb = () => {
    const account = { id: "tg-1", agencyId: "agency-1", lifecycleState: "ACTIVE", retirementRequestedAt: null, retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimUntil: null, runtimeClaimGeneration: 0, runtimeDrainedGeneration: 0 };
    const db = {
      agencyTelegramMtprotoAccount: {
        findFirst: async () => ({ ...account }),
        updateMany: async ({ where, data }) => {
          const state = String(account.lifecycleState || "ACTIVE");
          const allowed = !where.lifecycleState || where.lifecycleState === state
            || (Array.isArray(where.OR) && where.OR.some((entry) => entry?.lifecycleState === state || (entry?.lifecycleState === null && !account.lifecycleState)));
          if (!allowed) return { count: 0 };
          if (where.runtimeClaimGeneration !== undefined && Number(where.runtimeClaimGeneration) !== Number(account.runtimeClaimGeneration || 0)) return { count: 0 };
          if (where.runtimeDrainedGeneration !== undefined && Number(where.runtimeDrainedGeneration) !== Number(account.runtimeDrainedGeneration || 0)) return { count: 0 };
          Object.assign(account, data);
          return { count: 1 };
        },
        delete: async () => ({}),
      },
      creatorAccount: { updateMany: async () => ({ count: 1 }) },
    };
    db.$transaction = async (fn) => fn(db);
    return db;
  };

  {
    const db = baseDb();
    db.telegramDeliveryIntent = {
      findFirst: async () => ({ id: "delivery-1", kind: "REFERENCE", state: "RECONCILE_REQUIRED" }),
      findMany: async () => [],
    };
    await assert.rejects(
      () => service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db }),
      (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE" && error?.status === 409,
    );
  }

  {
    const db = baseDb();
    db.telegramDeliveryIntent = {
      findFirst: async () => null,
      findMany: async () => [{ customOrderId: "order-1" }],
    };
    db.customOrder = { findFirst: async () => ({ id: "order-1" }) };
    await assert.rejects(
      () => service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db }),
      (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE",
      "a confirmed TASK thread for a pending Custom order must keep its provider account recoverable",
    );
  }

  {
    const db = baseDb();
    db.telegramDeliveryIntent = { findFirst: async () => null, findMany: async () => [] };
    db.customContentSubmission = { findMany: async ({ where }) => {
      assert.equal(where.telegramSourceAccountId, "tg-1");
      return [{ id: "submission-1", reviewStatus: "APPROVED", telegramMessageIds: [501, 502], ofMediaIds: ["9001"] }];
    } };
    await assert.rejects(
      () => service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db }),
      (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE",
      "any incomplete pinned Telegram source, including APPROVED content, must keep the provider account available",
    );
  }

  {
    const db = baseDb();
    db.telegramDeliveryIntent = { findFirst: async () => null, findMany: async () => [] };
    db.customContentSubmission = { findFirst: async () => null };
    db.telegramInboundEvent = { findFirst: async ({ where }) => {
      assert.equal(where.accountId, "tg-1");
      assert.deepEqual(where.projectionState.in, ["PENDING", "FAILED_RETRYABLE", "REVIEW_REQUIRED"]);
      return { id: "inbound-unresolved-1", projectionState: "REVIEW_REQUIRED" };
    } };
    await assert.rejects(
      () => service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db }),
      (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE",
      "unresolved canonical provider observations must block account retirement before credentials can be orphaned",
    );
  }
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
  const admin = { id: "member-admin", userId: "user-admin", role: "ADMIN", roleKey: "admin", accessEpoch: 1, assignedCreators: "all" };
  db.agencyMember = { findFirst: async () => ({ ...admin, agencyId: "a", deletedAt: null, deactivatedAt: null }) };
  await service.addTelegramMtprotoAccount({ agencyId: "a", member: admin, apiId: 9001, apiHash: "0123456789abcdef0123456789abcdef", db });
  stored = { ...stored, runtimeClaimedByDeviceId: "device-admin", runtimeClaimToken: "token-admin", runtimeClaimUntil: new Date(Date.now() + 60_000), runtimeLeaseUserId: admin.userId, runtimeLeaseMemberId: admin.id, runtimeLeaseAccessEpoch: admin.accessEpoch, runtimeLeaseCreatorId: "creator-api" };
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "a", member: admin, accountId: "tg-api-only", creatorId: "creator-api", purpose: "messaging", deviceId: "device-admin", claimToken: "token-admin", db }),
    (error) => error?.code === "SETTINGS_TELEGRAM_SESSION_REQUIRED",
  );
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "a", member: admin, accountId: "tg-api-only", purpose: "test", db }),
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
  assert.match(routeSource, /router\.post\("\/telegram\/accounts\/:accountId\/force-retire"/);
  assert.match(routeSource, /router\.post\("\/telegram\/accounts\/:accountId\/local-material"/);
  assert.match(routeSource, /router\.put\("\/telegram\/accounts\/:accountId\/session"/);
  assert.match(routeSource, /router\.post\("\/telegram\/runtime\/claim"/);
  assert.match(routeSource, /router\.post\("\/telegram\/runtime\/:accountId\/release"/);
  assert.match(routeSource, /Cache-Control", "no-store, private/);
  const addBlock = routeSource.split('router.post("/telegram/accounts"')[1].split('router.delete("/telegram/accounts/:accountId"')[0];
  const materialBlock = routeSource.split('router.post("/telegram/accounts/:accountId/local-material"')[1].split('router.put("/telegram/accounts/:accountId/session"')[0];
  const sessionBlock = routeSource.split('router.put("/telegram/accounts/:accountId/session"')[1].split('router.get("/runtime"')[0];
  assert.match(addBlock, /requireProductDevice\(req, req\.body\?\.deviceId\)/);
  assert.match(materialBlock, /requireProductDevice\(req, req\.body\?\.deviceId\)/);
  assert.match(materialBlock, /claimToken: req\.body\?\.claimToken/);
  assert.match(materialBlock, /submissionId: req\.body\?\.submissionId/);
  assert.match(sessionBlock, /requireProductDevice\(req, req\.body\?\.deviceId\)/);

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

test("Telegram planning and account retirement serialize on the account row so new business work wins without leaving RETIRING poison", async () => {
  const settings = loadSettingsService();
  const { planTelegramDeliveryIntent } = require("./telegram-delivery-authority-service");
  const owner = { id: "member-owner-race", userId: "user-owner-race", role: "OWNER", roleKey: "owner", accessEpoch: 3, assignedCreators: "all" };
  const account = { id: "tg-race", agencyId: "agency-1", lifecycleState: "ACTIVE", retirementRequestedAt: null, retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimUntil: null };
  const creator = { id: "creator-race", agencyId: "agency-1", displayName: "Model", username: "model", status: "READY", deletedAt: null, telegramContact: "@model", telegramUserId: "991", telegramAccountId: "tg-race" };
  const order = { id: "order-race", agencyId: "agency-1", creatorId: creator.id, dialogId: "dialog-race", scenario: "race", type: "CONTENT", status: "PENDING", telegramTaskMessageId: null, createdAt: new Date("2026-09-05T12:00:00.000Z"), updatedAt: new Date("2026-09-05T12:00:00.000Z"), creator };
  const intents = [];
  let createSeq = 0;
  let txTail = Promise.resolve();
  let plannerTouchedResolve;
  const plannerTouched = new Promise((resolve) => { plannerTouchedResolve = resolve; });
  let allowPlannerResolve;
  const allowPlanner = new Promise((resolve) => { allowPlannerResolve = resolve; });
  let pausePlannerAccountTouch = true;

  const db = {
    creatorAccount: {
      findFirst: async ({ where }) => where.id === creator.id && where.agencyId === "agency-1" ? { ...creator } : null,
      updateMany: async () => ({ count: 0 }),
    },
    agencyTelegramMtprotoAccount: {
      findFirst: async ({ where }) => where.id === account.id && where.agencyId === account.agencyId ? { ...account } : null,
      updateMany: async ({ where, data }) => {
        const expected = where.lifecycleState;
        const activeOrLegacy = Array.isArray(where.OR) && where.OR.some((part) => part?.lifecycleState === "ACTIVE");
        const matchesState = expected ? String(account.lifecycleState) === String(expected) : (activeOrLegacy ? String(account.lifecycleState) === "ACTIVE" : true);
        if (where.id !== account.id || where.agencyId !== account.agencyId || !matchesState) return { count: 0 };
        if (pausePlannerAccountTouch && (expected === "ACTIVE" || activeOrLegacy) && data.lifecycleState === "ACTIVE") {
          pausePlannerAccountTouch = false;
          plannerTouchedResolve();
          await allowPlanner;
        }
        Object.assign(account, data);
        return { count: 1 };
      },
      delete: async () => { account.lifecycleState = "RETIRED"; return {}; },
    },
    customOrder: {
      findFirst: async ({ where }) => {
        if (where.id === order.id && where.agencyId === order.agencyId) return { ...order, creator: { ...creator } };
        if (where.agencyId === order.agencyId && where.status === "PENDING" && where.id?.in?.includes(order.id)) return { id: order.id };
        return null;
      },
    },
    telegramDeliveryIntent: {
      findUnique: async ({ where }) => intents.find((row) => row.logicalKey === where.logicalKey) || null,
      findFirst: async ({ where }) => intents.find((row) => {
        if (where.agencyId && row.agencyId !== where.agencyId) return false;
        if (where.accountId && row.accountId !== where.accountId) return false;
        if (where.state?.in && !where.state.in.includes(row.state)) return false;
        return true;
      }) || null,
      findMany: async () => [],
      create: async ({ data }) => {
        const row = { id: `intent-race-${++createSeq}`, claimRevision: 0, claimUntil: null, commitStartedAt: null, remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, outcomeReason: null, confirmationAuthority: null, confirmedAt: null, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(data) };
        intents.push(row);
        return { ...row };
      },
    },
    customContentSubmission: { findFirst: async () => null },
    telegramInboundEvent: { findFirst: async () => null },
    auditLog: { create: async ({ data }) => ({ id: "audit-race", ...data }) },
    async $transaction(fn) {
      const previous = txTail;
      let release;
      txTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try { return await fn(this); } finally { release(); }
    },
  };

  const planning = planTelegramDeliveryIntent({ agencyId: "agency-1", member: owner, orderId: order.id, kind: "TASK", db });
  await plannerTouched;
  const retirement = settings.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: account.id, db });
  await new Promise((resolve) => setImmediate(resolve));
  allowPlannerResolve();

  const planned = await planning;
  assert.equal(planned.created, true);
  await assert.rejects(retirement, (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE");
  assert.equal(account.lifecycleState, "ACTIVE", "retirement must not poison the account after a racing planner established durable work first");
  assert.equal(intents.length, 1);
  assert.equal(intents[0].state, "PLANNED");
});


test("F42 current Telegram account resolution excludes RETIRING accounts", async () => {
  const { resolveTelegramAccountId } = require("./custom-order-reminders");
  const rows = [
    { id: "tg-active", agencyId: "agency-1", lifecycleState: "ACTIVE" },
    { id: "tg-retiring", agencyId: "agency-1", lifecycleState: "RETIRING" },
  ];
  const matchesLifecycle = (row, where) => {
    if (where.lifecycleState !== undefined && String(row.lifecycleState || "ACTIVE") !== String(where.lifecycleState)) return false;
    if (Array.isArray(where.OR) && !where.OR.some((part) => part.lifecycleState === row.lifecycleState || (part.lifecycleState === null && row.lifecycleState == null))) return false;
    return true;
  };
  const db = { agencyTelegramMtprotoAccount: {
    findFirst: async ({ where }) => rows.find((row) => row.id === where.id && row.agencyId === where.agencyId && matchesLifecycle(row, where)) || null,
    findMany: async ({ where, take }) => rows.filter((row) => row.agencyId === where.agencyId && matchesLifecycle(row, where)).slice(0, take),
  } };
  assert.equal(await resolveTelegramAccountId({ agencyId: "agency-1", creator: { telegramAccountId: null }, db }), "tg-active");
  assert.equal(await resolveTelegramAccountId({ agencyId: "agency-1", creator: { telegramAccountId: "tg-retiring" }, db }), null, "explicit RETIRING assignment must fail closed instead of silently rerouting through Auto");
  rows[0].lifecycleState = "RETIRING";
  assert.equal(await resolveTelegramAccountId({ agencyId: "agency-1", creator: { telegramAccountId: null }, db }), null);
});

test("F42 QR session handoff cannot commit after ACTIVE -> RETIRING", async () => {
  const service = loadSettingsService();
  const owner = { id: "owner", userId: "user-owner", role: "OWNER", roleKey: "owner" };
  const account = {
    id: "tg-1", agencyId: "agency-1", apiId: 12345, lifecycleState: "ACTIVE", retirementRequestedAt: null, retirementDrainCompletedAt: null,
    encryptedPayload: "", iv: "", tag: "", algorithm: "aes-256-gcm", payloadVersion: 1,
  };
  // Create valid encrypted material through service first.
  let row = null;
  const db = {
    agencyTelegramMtprotoAccount: {
      create: async ({ data }) => { row = { id: "tg-1", lifecycleState: "ACTIVE", ...data }; return { id: "tg-1", apiId: data.apiId }; },
      findFirst: async ({ where }) => row && where.id === row.id && where.agencyId === row.agencyId ? { ...row } : null,
      updateMany: async ({ where, data }) => {
        if (!row || where.id !== row.id || where.agencyId !== row.agencyId) return { count: 0 };
        if (where.lifecycleState && String(row.lifecycleState || "ACTIVE") !== String(where.lifecycleState)) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
    async $transaction(fn) { return fn(this); },
  };
  await service.addTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef", db });
  // Authorization material may have been issued while ACTIVE. Retirement wins before handoff.
  await service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "authorize", db });
  row.lifecycleState = "RETIRING";
  await assert.rejects(
    () => service.issueTelegramMtprotoLocalMaterial({ agencyId: "agency-1", member: owner, accountId: "tg-1", purpose: "authorize", db }),
    (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_RETIRING",
    "new QR authorization must be rejected after retirement begins",
  );
  await assert.rejects(
    () => service.storeTelegramMtprotoSession({ agencyId: "agency-1", member: owner, accountId: "tg-1", session: "NEW_SESSION", db }),
    (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_RETIRING",
  );
});

test("F43 force retirement is explicit, audited, and impossible while server blockers remain", async () => {
  let requiredAuditSeen = false;
  const service = loadSettingsService({ auditImpl: async (args) => { requiredAuditSeen = args.required === true && args.action === "settings.telegram.account_force_retired_lost_runtime"; return { id: "audit-force" }; } });
  const owner = { id: "owner", userId: "user-owner", role: "OWNER", roleKey: "owner" };
  const makeDb = ({ blocker = false } = {}) => {
    let account = { id: "tg-lost", agencyId: "agency-1", apiId: 7, lifecycleState: "RETIRING", retirementRequestedAt: new Date(), retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimUntil: null };
    const creators = [{ id: "creator-1", agencyId: "agency-1", telegramAccountId: "tg-lost" }];
    const db = {
      agencyTelegramMtprotoAccount: {
        updateMany: async ({ where, data }) => {
          if (!account || where.id !== account.id || where.agencyId !== account.agencyId || (where.lifecycleState && where.lifecycleState !== account.lifecycleState)) return { count: 0 };
          Object.assign(account, data); return { count: 1 };
        },
        findFirst: async ({ where }) => account && where.id === account.id && where.agencyId === account.agencyId ? { ...account } : null,
        delete: async () => { account = null; return {}; },
      },
      telegramDeliveryIntent: { findFirst: async () => blocker ? ({ id: "intent-1", state: "RECONCILE_REQUIRED" }) : null, findMany: async () => [] },
      customContentSubmission: { findMany: async () => [] },
      telegramInboundEvent: { findFirst: async () => null },
      creatorAccount: { updateMany: async ({ where, data }) => { for (const creator of creators) if (creator.agencyId === where.agencyId && creator.telegramAccountId === where.telegramAccountId) Object.assign(creator, data); return { count: 1 }; } },
      async $transaction(fn) { return fn(this); },
      _get: () => ({ account, creators }),
    };
    return db;
  };

  const blocked = makeDb({ blocker: true });
  await assert.rejects(() => service.forceRetireLostTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-lost", reason: "PC destroyed", acknowledgeLostObservations: true, db: blocked }), (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE");
  assert.ok(blocked._get().account, "server blockers prevent force deletion");

  const live = makeDb();
  live._get().account.runtimeClaimedByDeviceId = "device-live";
  live._get().account.runtimeClaimUntil = new Date(Date.now() + 60_000);
  await assert.rejects(() => service.forceRetireLostTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-lost", reason: "PC lost", acknowledgeLostObservations: true, db: live }), (error) => error?.code === "SETTINGS_TELEGRAM_FORCE_RETIRE_RUNTIME_LIVE");

  const clean = makeDb();
  await assert.rejects(() => service.forceRetireLostTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-lost", reason: "", acknowledgeLostObservations: true, db: clean }), (error) => error?.code === "SETTINGS_TELEGRAM_FORCE_RETIRE_REASON_REQUIRED");
  await assert.rejects(() => service.forceRetireLostTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-lost", reason: "PC destroyed", acknowledgeLostObservations: false, db: clean }), (error) => error?.code === "SETTINGS_TELEGRAM_FORCE_RETIRE_ACK_REQUIRED");
  const result = await service.forceRetireLostTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-lost", reason: "PC destroyed", acknowledgeLostObservations: true, db: clean });
  assert.equal(result.forced, true);
  assert.equal(clean._get().account, null);
  assert.equal(clean._get().creators[0].telegramAccountId, null);
  assert.equal(requiredAuditSeen, true);
});

test("F43 mandatory force-retire audit failure rolls back the decision", async () => {
  const service = loadSettingsService({ auditImpl: async (args) => { assert.equal(args.required, true); throw new Error("audit down"); } });
  const owner = { id: "owner", userId: "user-owner", role: "OWNER", roleKey: "owner" };
  let account = { id: "tg-lost", agencyId: "agency-1", lifecycleState: "RETIRING" };
  const db = {
    agencyTelegramMtprotoAccount: {
      updateMany: async ({ where, data }) => account && where.id === account.id && where.lifecycleState === account.lifecycleState ? (Object.assign(account, data), { count: 1 }) : { count: 0 },
      findFirst: async () => account ? { ...account } : null,
      delete: async () => { account = null; return {}; },
    },
    telegramDeliveryIntent: { findFirst: async () => null, findMany: async () => [] },
    customContentSubmission: { findMany: async () => [] }, telegramInboundEvent: { findFirst: async () => null }, creatorAccount: { updateMany: async () => ({ count: 0 }) },
    async $transaction(fn) { return fn(this); },
  };
  await assert.rejects(() => service.forceRetireLostTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-lost", reason: "lost disk", acknowledgeLostObservations: true, db }), /audit down/);
  assert.ok(account, "force-retire cannot commit when mandatory audit fails");
});

test("F44 retirement blocker remains exact beyond 1000 historical TASKs regardless of insertion order", async () => {
  const service = loadSettingsService();
  const owner = { id: "owner", userId: "owner-user", role: "OWNER", roleKey: "owner" };
  const account = { id: "tg-old", agencyId: "agency-1", lifecycleState: "ACTIVE", retirementRequestedAt: null, retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimUntil: null, runtimeClaimGeneration: 0, runtimeDrainedGeneration: 0 };
  const orders = Array.from({ length: 1001 }, (_, i) => ({ id: `order-${String(i + 1).padStart(4, "0")}`, agencyId: "agency-1", creatorId: "creator-1", status: i === 1000 ? "PENDING" : "COMPLETED" }));
  const tasks = Array.from({ length: 1001 }, (_, i) => ({ id: `task-${String(i + 1).padStart(4, "0")}`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: `order-${String(i + 1).padStart(4, "0")}`, accountId: "tg-old", kind: "TASK", state: "CONFIRMED" }));
  const page = (rows, { where = {}, take = rows.length, cursor = null, skip = 0 } = {}, match) => {
    let out = rows.filter((row) => match(row, where)).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (cursor?.id) { const idx = out.findIndex((row) => row.id === cursor.id); if (idx >= 0) out = out.slice(idx + (skip ? 1 : 0)); }
    return out.slice(0, take).map((row) => ({ ...row }));
  };
  const matchOrder = (row, where) => {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
    return true;
  };
  const matchIntent = (row, where) => {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.accountId && row.accountId !== where.accountId) return false;
    if (where.kind && row.kind !== where.kind) return false;
    if (where.state && row.state !== where.state) return false;
    if (where.customOrderId?.in && !where.customOrderId.in.includes(row.customOrderId)) return false;
    return true;
  };
  for (const taskRows of [tasks, [...tasks].reverse()]) {
    const state = { ...account };
    const db = {
      agencyTelegramMtprotoAccount: {
        findFirst: async ({ where }) => where.id === state.id && where.agencyId === state.agencyId ? { ...state } : null,
        updateMany: async ({ where, data }) => {
          if (where.id !== state.id || where.agencyId !== state.agencyId) return { count: 0 };
          const current = String(state.lifecycleState || "ACTIVE");
          const lifecycleOk = !where.lifecycleState || where.lifecycleState === current || (Array.isArray(where.OR) && where.OR.some((entry) => entry.lifecycleState === current || (entry.lifecycleState === null && !state.lifecycleState)));
          if (!lifecycleOk) return { count: 0 };
          Object.assign(state, data); return { count: 1 };
        },
        delete: async () => { throw new Error("retirement must be blocked before delete"); },
      },
      creatorAccount: { updateMany: async () => ({ count: 0 }) },
      telegramDeliveryIntent: {
        findFirst: async () => null,
        findMany: async (args) => page(taskRows, args, matchIntent),
      },
      customOrder: {
        findMany: async (args) => page(orders, args, matchOrder),
        findFirst: async ({ where }) => orders.find((row) => matchOrder(row, where)) || null,
      },
      customContentSubmission: { findMany: async () => [] },
      telegramInboundEvent: { findFirst: async () => null },
    };
    db.$transaction = async (fn) => fn(db);
    await assert.rejects(
      () => service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-old", db }),
      (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE",
    );
  }
});

test("F44 retirement blocks incomplete account-pinned source even when source user identity still needs repair", async () => {
  const service = loadSettingsService();
  const owner = { id: "owner", userId: "owner-user", role: "OWNER", roleKey: "owner" };
  const account = { id: "tg-1", agencyId: "agency-1", lifecycleState: "ACTIVE", retirementRequestedAt: null, retirementDrainCompletedAt: null, runtimeClaimedByDeviceId: null, runtimeClaimUntil: null, runtimeClaimGeneration: 0, runtimeDrainedGeneration: 0 };
  const db = {
    agencyTelegramMtprotoAccount: {
      findFirst: async () => ({ ...account }),
      updateMany: async ({ data }) => { Object.assign(account, data); return { count: 1 }; },
      delete: async () => { throw new Error("must remain blocked"); },
    },
    creatorAccount: { updateMany: async () => ({ count: 0 }) },
    telegramDeliveryIntent: { findFirst: async () => null, findMany: async () => [] },
    customOrder: { findMany: async () => [] },
    customContentSubmission: {
      findMany: async ({ where }) => {
        assert.equal(where.telegramSourceAccountId, "tg-1");
        assert.equal(where.telegramSourceUserId, undefined, "retirement must not require repaired source-user identity to see the account dependency");
        return [{ id: "submission-repair", agencyId: "agency-1", creatorId: "creator-1", telegramSourceAccountId: "tg-1", telegramSourceUserId: null, telegramMessageIds: [701], ofMediaIds: [] }];
      },
    },
    telegramInboundEvent: { findFirst: async () => null },
  };
  db.$transaction = async (fn) => fn(db);
  await assert.rejects(
    () => service.removeTelegramMtprotoAccount({ agencyId: "agency-1", member: owner, accountId: "tg-1", db }),
    (error) => error?.code === "SETTINGS_TELEGRAM_ACCOUNT_IN_USE",
  );
});
