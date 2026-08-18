"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { encryptTelegramCredentials, decryptTelegramCredentials } = require("./telegram-mtproto-credentials");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../prisma") return {};
  return originalLoad.call(this, request, parent, isMain);
};
let runtimeModule;
try {
  delete require.cache[require.resolve("./telegram-mtproto-runtime")];
  runtimeModule = require("./telegram-mtproto-runtime");
} finally {
  Module._load = originalLoad;
}
const { createTelegramMtprotoRuntime, TEST_RECIPIENT, TEST_MESSAGE } = runtimeModule;

function makeDb({ session = "" } = {}) {
  const encrypted = encryptTelegramCredentials({ apiHash: "0123456789abcdef0123456789abcdef", session });
  let row = {
    id: "tg-1",
    agencyId: "agency-1",
    apiId: 12345678,
    ...encrypted,
  };
  return {
    get row() { return row; },
    agencyTelegramMtprotoAccount: {
      findFirst: async ({ where }) => where.id === row.id && where.agencyId === row.agencyId ? { ...row } : null,
      update: async ({ where, data }) => {
        assert.equal(where.id, row.id);
        row = { ...row, ...data };
        return { ...row };
      },
    },
  };
}

class FakeNewMessage {
  constructor(options) { this.options = options; }
}

function makeClientFactory({ requirePassword = true, connectError = null, sendError = null } = {}) {
  const instances = [];
  const factory = ({ apiId, apiHash, session }) => {
    const handlers = [];
    let savedSession = session;
    const sent = [];
    const client = {
      connected: false,
      async connect() {
        if (connectError) throw connectError;
        this.connected = true;
      },
      async disconnect() { this.connected = false; },
      async getMe() {
        if (connectError) throw connectError;
        return { id: 777n };
      },
      async start({ phoneNumber, phoneCode, password, onError }) {
        assert.equal(apiId, 12345678);
        assert.equal(apiHash, "0123456789abcdef0123456789abcdef");
        assert.equal(await phoneNumber(), "+380501234567");
        let code = await phoneCode();
        while (code !== "12345") {
          onError(Object.assign(new Error("PHONE_CODE_INVALID"), { errorMessage: "PHONE_CODE_INVALID" }));
          code = await phoneCode();
        }
        if (requirePassword) {
          let secret = await password();
          while (secret !== "correct horse") {
            onError(Object.assign(new Error("PASSWORD_HASH_INVALID"), { errorMessage: "PASSWORD_HASH_INVALID" }));
            secret = await password();
          }
        }
        savedSession = "SAVED_SESSION_AFTER_AUTH";
        this.connected = true;
      },
      addEventHandler(handler, event) {
        assert.deepEqual(event.options, {});
        handlers.push(handler);
      },
      api: {
        contacts: {
          async resolveUsername({ username }) {
            assert.equal(username, "runronin");
            return { peer: { userId: 987654321012345678n }, users: [{ id: 987654321012345678n }] };
          },
        },
      },
      async sendMessage(recipient, options) {
        if (sendError) throw sendError;
        assert.equal(recipient, TEST_RECIPIENT);
        assert.equal(options.message, TEST_MESSAGE);
        sent.push({ recipient, options });
        return { id: 44 };
      },
    };
    const entry = {
      client,
      NewMessage: FakeNewMessage,
      saveSession: () => savedSession,
      handlers,
      sent,
      async emitIncoming(senderId, id = 55) {
        for (const handler of handlers) {
          await handler({ message: { id, senderId: { userId: BigInt(senderId) } } });
        }
      },
    };
    instances.push(entry);
    return entry;
  };
  factory.instances = instances;
  return factory;
}

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timeout");
}

async function waitAuthStage(runtime, base, stages, timeoutMs = 1500) {
  const wanted = new Set(Array.isArray(stages) ? stages : [stages]);
  let latest = null;
  await waitUntil(() => {
    latest = runtime.authorizationStatus(base);
    return wanted.has(latest.stage);
  }, timeoutMs);
  return latest;
}

test("MTProto authorization survives invalid code/password, stores session, resolves @runronin, sends fixed test and matches reply sender id", async () => {
  const db = makeDb();
  const factory = makeClientFactory({ requirePassword: true });
  let clock = Date.now();
  const runtime = createTelegramMtprotoRuntime({ db, clientFactory: factory, now: () => clock });

  const started = await runtime.beginAuthorization({ agencyId: "agency-1", accountId: "tg-1", phone: "+380 50 123 45 67" });
  assert.ok(["CONNECTING", "CODE"].includes(started.stage));
  assert.ok(started.challengeId);
  const authBase = { agencyId: "agency-1", accountId: "tg-1", challengeId: started.challengeId };
  await waitAuthStage(runtime, authBase, "CODE");

  const checkingBadCode = await runtime.submitCode({ ...authBase, code: "11111" });
  assert.equal(checkingBadCode.stage, "VERIFYING_CODE");
  const badCode = await waitAuthStage(runtime, authBase, "CODE");
  assert.match(badCode.errorCode || "", /PHONE_CODE_INVALID/);

  const checkingGoodCode = await runtime.submitCode({ ...authBase, code: "12345" });
  assert.equal(checkingGoodCode.stage, "VERIFYING_CODE");
  await waitAuthStage(runtime, authBase, "PASSWORD");

  const checkingBadPassword = await runtime.submitPassword({ ...authBase, password: "wrong" });
  assert.equal(checkingBadPassword.stage, "VERIFYING_PASSWORD");
  const badPassword = await waitAuthStage(runtime, authBase, "PASSWORD");
  assert.match(badPassword.errorCode || "", /PASSWORD_HASH_INVALID/);

  const checkingPassword = await runtime.submitPassword({ ...authBase, password: "correct horse" });
  assert.equal(checkingPassword.stage, "VERIFYING_PASSWORD");
  const authorized = await waitAuthStage(runtime, authBase, "AUTHORIZED");
  const decrypted = decryptTelegramCredentials(db.row);
  assert.equal(decrypted.apiHash, "0123456789abcdef0123456789abcdef");
  assert.equal(decrypted.session, "SAVED_SESSION_AFTER_AUTH");
  assert.equal(runtime.runtimeStatus("tg-1").connected, true);

  clock += 30_000;
  const sent = await runtime.testConnection({ agencyId: "agency-1", accountId: "tg-1" });
  assert.equal(sent.recipient, "@runronin");
  assert.equal(sent.resolvedUserId, "987654321012345678");
  assert.equal(sent.message, "ONLINOD Telegram connection test ✅");
  assert.equal(sent.sentMessageId, "44");

  const active = factory.instances.at(-1);
  await active.emitIncoming("111", 56);
  assert.equal(runtime.testStatus({ agencyId: "agency-1", accountId: "tg-1" }).received, false);
  await active.emitIncoming("987654321012345678", 57);
  const status = runtime.testStatus({ agencyId: "agency-1", accountId: "tg-1" });
  assert.equal(status.received, true);
  assert.equal(status.receivedMessageId, "57");
  assert.equal(status.resolvedUserId, "987654321012345678");

  await runtime.forgetAccount("tg-1");
});

test("invalid stored session is cleared and forces reauthorization", async () => {
  const db = makeDb({ session: "STALE_SESSION" });
  const error = Object.assign(new Error("SESSION_REVOKED"), { errorMessage: "SESSION_REVOKED" });
  const runtime = createTelegramMtprotoRuntime({ db, clientFactory: makeClientFactory({ connectError: error }) });
  await assert.rejects(
    () => runtime.testConnection({ agencyId: "agency-1", accountId: "tg-1" }),
    (err) => err?.code === "SETTINGS_TELEGRAM_REAUTH_REQUIRED" && err?.status === 409,
  );
  assert.equal(decryptTelegramCredentials(db.row).session, "");
});

test("Telegram flood wait is surfaced as retryable cooldown and test recipient cannot be overridden", async () => {
  const db = makeDb({ session: "VALID_SESSION" });
  const flood = Object.assign(new Error("FLOOD_WAIT_42"), { errorMessage: "FLOOD_WAIT_42" });
  const factory = makeClientFactory({ sendError: flood });
  const runtime = createTelegramMtprotoRuntime({ db, clientFactory: factory });
  await assert.rejects(
    () => runtime.testConnection({ agencyId: "agency-1", accountId: "tg-1", recipient: "@someone_else" }),
    (err) => err?.code === "SETTINGS_TELEGRAM_FLOOD_WAIT" && err?.status === 429 && err?.retryAfterSeconds === 42,
  );
  assert.equal(factory.instances[0].sent.length, 0);
});

test("authorization start is non-blocking and cancel/restart is not held hostage by a hung disconnect", async () => {
  const db = makeDb();
  const instances = [];
  const factory = ({ session }) => {
    let savedSession = session;
    const client = {
      async start({ phoneNumber }) {
        await phoneNumber();
        await new Promise(() => {});
      },
      async disconnect() {
        await new Promise(() => {});
      },
      async connect() {},
      async getMe() { return { id: 1n }; },
    };
    const entry = { client, NewMessage: FakeNewMessage, saveSession: () => savedSession };
    instances.push(entry);
    return entry;
  };
  let clock = Date.now();
  const runtime = createTelegramMtprotoRuntime({ db, clientFactory: factory, now: () => clock });

  const before = Date.now();
  const first = await runtime.beginAuthorization({ agencyId: "agency-1", accountId: "tg-1", phone: "+380501234567" });
  assert.ok(Date.now() - before < 500, "start route must return immediately instead of waiting on Telegram");
  assert.equal(first.stage, "CONNECTING");

  const cancelled = await runtime.cancelAuthorization({
    agencyId: "agency-1",
    accountId: "tg-1",
    challengeId: first.challengeId,
  });
  assert.equal(cancelled.stage, "CANCELLED");

  clock += 16_000;
  const restartBefore = Date.now();
  const second = await runtime.beginAuthorization({ agencyId: "agency-1", accountId: "tg-1", phone: "+380501234567" });
  assert.ok(Date.now() - restartBefore < 500, "restart must not await a stuck client.disconnect()");
  assert.equal(second.stage, "CONNECTING");
  assert.notEqual(second.challengeId, first.challengeId);
  assert.ok(instances.length >= 2);
});
