"use strict";

const { randomUUID } = require("node:crypto");
const prisma = require("../prisma");
const { encryptTelegramCredentials, decryptTelegramCredentials } = require("./telegram-mtproto-credentials");

const AUTH_TTL_MS = 10 * 60 * 1000;
const AUTH_CONNECT_TIMEOUT_MS = 45 * 1000;
const CLIENT_DISCONNECT_GRACE_MS = 1500;
const TEST_RECIPIENT = "@runronin";
const TEST_MESSAGE = "ONLINOD Telegram connection test ✅";
const TEST_SEND_COOLDOWN_MS = 20 * 1000;
const AUTH_START_COOLDOWN_MS = 15 * 1000;

const REAUTH_ERROR_CODES = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_DUPLICATED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "USER_DEACTIVATED",
]);

function cleanText(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value) {
  const phone = cleanText(value, 32).replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    const err = new Error("Telegram phone must be in international format, for example +380501234567");
    err.code = "SETTINGS_TELEGRAM_PHONE_INVALID";
    err.status = 400;
    throw err;
  }
  return phone;
}

function normalizeCode(value) {
  const code = cleanText(value, 16).replace(/\s+/g, "");
  if (!/^\d{3,10}$/.test(code)) {
    const err = new Error("Telegram confirmation code is invalid");
    err.code = "SETTINGS_TELEGRAM_CODE_INVALID";
    err.status = 400;
    throw err;
  }
  return code;
}

function normalizePassword(value) {
  const password = String(value ?? "");
  if (!password || password.length > 512) {
    const err = new Error("Telegram 2FA password is required");
    err.code = "SETTINGS_TELEGRAM_PASSWORD_INVALID";
    err.status = 400;
    throw err;
  }
  return password;
}

function rpcErrorCode(error) {
  const direct = cleanText(error?.errorMessage || error?.code || error?.message, 240).toUpperCase();
  const match = direct.match(/(?:^|\b)([A-Z][A-Z0-9_]{2,})(?:_\d+)?(?:\b|$)/);
  return match?.[1] || "TELEGRAM_MTPROTO_ERROR";
}

function floodWaitSeconds(error) {
  const text = `${String(error?.errorMessage || "")} ${String(error?.message || "")}`.toUpperCase();
  const match = text.match(/FLOOD_(?:PREMIUM_)?WAIT_(\d+)/);
  if (match) return Math.max(1, Number(match[1]));
  const seconds = Number(error?.seconds || error?.retryAfter || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function publicTelegramError(error) {
  const rawCode = rpcErrorCode(error);
  const retryAfterSeconds = floodWaitSeconds(error);
  const reauthRequired = REAUTH_ERROR_CODES.has(rawCode);
  const code = retryAfterSeconds ? "SETTINGS_TELEGRAM_FLOOD_WAIT" : reauthRequired ? "SETTINGS_TELEGRAM_REAUTH_REQUIRED" : `SETTINGS_TELEGRAM_${rawCode}`;
  let message = cleanText(error?.message || error?.errorMessage, 240) || "Telegram MTProto request failed";
  if (retryAfterSeconds) message = `Telegram asked this account to wait ${retryAfterSeconds} seconds before retrying`;
  if (reauthRequired) message = "Telegram session is no longer valid. Authorize the account again.";
  return { code, message, retryAfterSeconds, reauthRequired, rawCode };
}

function throwPublicTelegramError(error) {
  const pub = publicTelegramError(error);
  const err = new Error(pub.message);
  err.code = pub.code;
  err.status = pub.retryAfterSeconds ? 429 : pub.reauthRequired ? 409 : 400;
  err.retryAfterSeconds = pub.retryAfterSeconds;
  err.reauthRequired = pub.reauthRequired;
  err.rawTelegramCode = pub.rawCode;
  throw err;
}

async function readAccount({ agencyId, accountId, db = prisma }) {
  const id = cleanText(accountId, 180);
  const row = await db.agencyTelegramMtprotoAccount.findFirst({
    where: { id, agencyId },
    select: {
      id: true,
      agencyId: true,
      apiId: true,
      encryptedPayload: true,
      iv: true,
      tag: true,
      algorithm: true,
      payloadVersion: true,
    },
  });
  if (!row) {
    const err = new Error("Telegram connection not found");
    err.code = "SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  let credentials;
  try {
    credentials = decryptTelegramCredentials(row);
  } catch (_) {
    const err = new Error("Stored Telegram credentials cannot be decrypted");
    err.code = "SETTINGS_TELEGRAM_STORAGE_UNAVAILABLE";
    err.status = 503;
    throw err;
  }
  return { ...row, apiHash: credentials.apiHash, session: credentials.session };
}

async function saveSession({ agencyId, accountId, session, db = prisma }) {
  const account = await readAccount({ agencyId, accountId, db });
  const cleanSession = String(session ?? "").trim();
  if (!cleanSession) {
    const err = new Error("Telegram authorization did not produce a session");
    err.code = "SETTINGS_TELEGRAM_SESSION_EMPTY";
    err.status = 502;
    throw err;
  }
  if (cleanSession.length > 262144) {
    const err = new Error("MTProto session must be smaller than 256 KB");
    err.code = "SETTINGS_TELEGRAM_SESSION_INVALID";
    err.status = 400;
    throw err;
  }
  const encrypted = encryptTelegramCredentials({ apiHash: account.apiHash, session: cleanSession });
  await db.agencyTelegramMtprotoAccount.update({
    where: { id: account.id },
    data: {
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      tag: encrypted.tag,
      algorithm: encrypted.algorithm,
      payloadVersion: encrypted.payloadVersion,
    },
  });
  return cleanSession;
}

async function clearSession({ agencyId, accountId, db = prisma }) {
  const account = await readAccount({ agencyId, accountId, db });
  const encrypted = encryptTelegramCredentials({ apiHash: account.apiHash, session: "" });
  await db.agencyTelegramMtprotoAccount.update({
    where: { id: account.id },
    data: {
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      tag: encrypted.tag,
      algorithm: encrypted.algorithm,
      payloadVersion: encrypted.payloadVersion,
    },
  });
}

function defaultClientFactory({ apiId, apiHash, session }) {
  // Lazy loading keeps ordinary backend boot/tests independent from Telegram until
  // an MTProto connection is actually requested.
  // eslint-disable-next-line global-require
  const { TelegramClient } = require("teleproto");
  // eslint-disable-next-line global-require
  const { StringSession } = require("teleproto/sessions");
  // eslint-disable-next-line global-require
  const { NewMessage } = require("teleproto/events");
  const sessionObject = new StringSession(String(session || ""));
  const client = new TelegramClient(sessionObject, Number(apiId), String(apiHash), {
    connectionRetries: 5,
    autoReconnect: true,
  });
  return { client, NewMessage, saveSession: () => String(client.session.save() || "") };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function telegramId(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "object" && value !== null && typeof value.toString === "function" ? value.toString() : String(value);
  const match = String(raw).match(/-?\d+/);
  if (!match) return null;
  const normalized = match[0].replace(/^-/, "");
  return /^\d{1,20}$/.test(normalized) ? normalized : null;
}

function messageId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : value === undefined || value === null ? null : cleanText(value, 80) || null;
}

function createTelegramMtprotoRuntime({ db = prisma, clientFactory = defaultClientFactory, now = () => Date.now() } = {}) {
  const challenges = new Map();
  const activeChallengeByAccount = new Map();
  const runtimes = new Map();
  const testWatches = new Map();
  const lastTestSend = new Map();
  const lastAuthStart = new Map();

  function touch(challenge) {
    challenge.updatedAt = now();
    challenge.revision += 1;
  }

  function setStage(challenge, stage) {
    challenge.stage = stage;
    touch(challenge);
  }

  function challengePublic(challenge) {
    return {
      challengeId: challenge.id,
      accountId: challenge.accountId,
      stage: challenge.stage,
      errorCode: challenge.lastError?.code || null,
      errorMessage: challenge.lastError?.message || null,
      retryAfterSeconds: challenge.lastError?.retryAfterSeconds || null,
    };
  }

  async function disposeClient(entry, timeoutMs = CLIENT_DISCONNECT_GRACE_MS) {
    if (!entry?.client) return;
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => entry.client.disconnect?.()).catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(50, Number(timeoutMs) || CLIENT_DISCONNECT_GRACE_MS));
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function disposeClientSoon(entry) {
    void disposeClient(entry).catch(() => undefined);
  }

  function clearChallengeTimer(challenge) {
    if (challenge?.connectTimer) {
      clearTimeout(challenge.connectTimer);
      challenge.connectTimer = null;
    }
  }

  async function forgetAccount(accountId) {
    const id = cleanText(accountId, 180);
    const challengeId = activeChallengeByAccount.get(id);
    if (challengeId) {
      const challenge = challenges.get(challengeId);
      if (challenge) {
        challenge.cancelled = true;
        clearChallengeTimer(challenge);
        challenge.codeDeferred?.reject?.(new Error("Authorization cancelled"));
        challenge.passwordDeferred?.reject?.(new Error("Authorization cancelled"));
        challenge.codeDeferred = null;
        challenge.passwordDeferred = null;
        disposeClientSoon(challenge.clientEntry);
        challenges.delete(challengeId);
      }
      activeChallengeByAccount.delete(id);
    }
    const runtime = runtimes.get(id);
    runtimes.delete(id);
    testWatches.delete(id);
    lastTestSend.delete(id);
    disposeClientSoon(runtime);
  }

  async function attachInboundHandler(accountId, entry) {
    if (entry.inboundAttached) return;
    entry.inboundAttached = true;
    try {
      const NewMessage = entry.NewMessage;
      if (!NewMessage || typeof entry.client.addEventHandler !== "function") return;
      entry.client.addEventHandler(async (event) => {
        try {
          const watch = testWatches.get(accountId);
          if (!watch || watch.receivedAt) return;
          const message = event?.message;
          let sender = telegramId(message?.senderId?.userId ?? message?.senderId);
          if (!sender && typeof message?.getSender === "function") sender = telegramId((await message.getSender())?.id);
          if (!sender || sender !== watch.resolvedUserId) return;
          watch.receivedAt = new Date(now()).toISOString();
          watch.receivedMessageId = messageId(message?.id);
        } catch (_) {}
      }, new NewMessage({}));
    } catch (_) {
      // A fake test client or an older compatible client may not expose events.
      // Sending remains available; live receive state simply stays pending.
    }
  }

  async function createConnectedClient({ agencyId, accountId, requireSession = true }) {
    const existing = runtimes.get(accountId);
    if (existing) return existing;
    const account = await readAccount({ agencyId, accountId, db });
    if (requireSession && !account.session) {
      const err = new Error("Telegram account has not been authorized yet");
      err.code = "SETTINGS_TELEGRAM_SESSION_REQUIRED";
      err.status = 409;
      throw err;
    }
    const entry = clientFactory({ apiId: account.apiId, apiHash: account.apiHash, session: account.session });
    entry.accountId = account.id;
    entry.agencyId = agencyId;
    entry.inboundAttached = false;
    try {
      await entry.client.connect();
      // getMe forces an authorization check instead of treating a TCP connection
      // as a valid logged-in Telegram account.
      await entry.client.getMe();
      await attachInboundHandler(account.id, entry);
      runtimes.set(account.id, entry);
      return entry;
    } catch (error) {
      await disposeClient(entry);
      const pub = publicTelegramError(error);
      if (pub.reauthRequired) await clearSession({ agencyId, accountId, db }).catch(() => undefined);
      throwPublicTelegramError(error);
    }
  }

  async function beginAuthorization({ agencyId, accountId, phone }) {
    const account = await readAccount({ agencyId, accountId, db });
    const normalizedPhone = normalizePhone(phone);
    const previousStart = Number(lastAuthStart.get(account.id) || 0);
    const remainingMs = AUTH_START_COOLDOWN_MS - (now() - previousStart);
    if (remainingMs > 0) {
      const err = new Error(`Wait ${Math.ceil(remainingMs / 1000)} seconds before requesting another Telegram login code`);
      err.code = "SETTINGS_TELEGRAM_AUTH_COOLDOWN";
      err.status = 429;
      err.retryAfterSeconds = Math.ceil(remainingMs / 1000);
      throw err;
    }
    lastAuthStart.set(account.id, now());
    await forgetAccount(account.id);

    const clientEntry = clientFactory({ apiId: account.apiId, apiHash: account.apiHash, session: "" });
    clientEntry.accountId = account.id;
    clientEntry.agencyId = agencyId;
    clientEntry.inboundAttached = false;
    const challenge = {
      id: randomUUID(),
      agencyId,
      accountId: account.id,
      phone: normalizedPhone,
      clientEntry,
      stage: "CONNECTING",
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
      codeDeferred: null,
      passwordDeferred: null,
      lastError: null,
      cancelled: false,
      connectTimer: null,
    };
    challenges.set(challenge.id, challenge);
    activeChallengeByAccount.set(account.id, challenge.id);

    challenge.connectTimer = setTimeout(() => {
      if (challenge.cancelled || challenge.stage !== "CONNECTING") return;
      challenge.cancelled = true;
      challenge.lastError = {
        code: "SETTINGS_TELEGRAM_CONNECT_TIMEOUT",
        message: "Telegram connection did not reach the login-code stage within 45 seconds",
        retryAfterSeconds: null,
      };
      setStage(challenge, "ERROR");
      activeChallengeByAccount.delete(account.id);
      disposeClientSoon(clientEntry);
    }, AUTH_CONNECT_TIMEOUT_MS);
    challenge.connectTimer.unref?.();

    setImmediate(() => {
      void (async () => {
        try {
          await clientEntry.client.start({
          phoneNumber: async () => challenge.phone,
          phoneCode: async () => {
            if (challenge.cancelled) throw new Error("Authorization cancelled");
            clearChallengeTimer(challenge);
            challenge.codeDeferred = deferred();
            setStage(challenge, "CODE");
            return challenge.codeDeferred.promise;
          },
          password: async () => {
            if (challenge.cancelled) throw new Error("Authorization cancelled");
            clearChallengeTimer(challenge);
            challenge.passwordDeferred = deferred();
            setStage(challenge, "PASSWORD");
            return challenge.passwordDeferred.promise;
          },
          onError: (error) => {
            challenge.lastError = publicTelegramError(error);
          },
          });
          if (challenge.cancelled) return;
          clearChallengeTimer(challenge);
          const serialized = clientEntry.saveSession();
          await saveSession({ agencyId, accountId: account.id, session: serialized, db });
          await attachInboundHandler(account.id, clientEntry);
          runtimes.set(account.id, clientEntry);
          challenge.lastError = null;
          setStage(challenge, "AUTHORIZED");
          activeChallengeByAccount.delete(account.id);
        } catch (error) {
          if (challenge.cancelled) return;
          clearChallengeTimer(challenge);
          challenge.lastError = publicTelegramError(error);
          setStage(challenge, "ERROR");
          activeChallengeByAccount.delete(account.id);
          disposeClientSoon(clientEntry);
        }
      })();
    });

    // Never keep the HTTP request open while Telegram negotiates a DC or sends
    // the login code. The Desktop polls challenge status independently.
    return challengePublic(challenge);
  }

  function getChallenge({ agencyId, accountId, challengeId }) {
    const id = cleanText(challengeId, 180);
    const challenge = challenges.get(id);
    if (!challenge || challenge.agencyId !== agencyId || challenge.accountId !== accountId) {
      const err = new Error("Telegram authorization session was not found or expired");
      err.code = "SETTINGS_TELEGRAM_AUTH_NOT_FOUND";
      err.status = 404;
      throw err;
    }
    if (now() - challenge.updatedAt > AUTH_TTL_MS) {
      challenge.cancelled = true;
      clearChallengeTimer(challenge);
      activeChallengeByAccount.delete(accountId);
      challenges.delete(id);
      challenge.codeDeferred?.reject?.(new Error("Authorization expired"));
      challenge.passwordDeferred?.reject?.(new Error("Authorization expired"));
      disposeClientSoon(challenge.clientEntry);
      const err = new Error("Telegram authorization session expired. Start authorization again.");
      err.code = "SETTINGS_TELEGRAM_AUTH_EXPIRED";
      err.status = 410;
      throw err;
    }
    return challenge;
  }

  function authorizationStatus({ agencyId, accountId, challengeId }) {
    return challengePublic(getChallenge({ agencyId, accountId, challengeId }));
  }

  async function cancelAuthorization({ agencyId, accountId, challengeId }) {
    const challenge = getChallenge({ agencyId, accountId, challengeId });
    if (!["AUTHORIZED", "ERROR", "CANCELLED"].includes(challenge.stage)) {
      challenge.cancelled = true;
      clearChallengeTimer(challenge);
      challenge.lastError = null;
      challenge.codeDeferred?.reject?.(new Error("Authorization cancelled"));
      challenge.passwordDeferred?.reject?.(new Error("Authorization cancelled"));
      challenge.codeDeferred = null;
      challenge.passwordDeferred = null;
      setStage(challenge, "CANCELLED");
      activeChallengeByAccount.delete(accountId);
      disposeClientSoon(challenge.clientEntry);
    }
    return challengePublic(challenge);
  }

  async function submitCode({ agencyId, accountId, challengeId, code }) {
    const challenge = getChallenge({ agencyId, accountId, challengeId });
    if (challenge.stage !== "CODE" || !challenge.codeDeferred) {
      const err = new Error("Telegram is not waiting for a confirmation code");
      err.code = "SETTINGS_TELEGRAM_AUTH_STAGE_INVALID";
      err.status = 409;
      throw err;
    }
    const pending = challenge.codeDeferred;
    challenge.codeDeferred = null;
    challenge.lastError = null;
    setStage(challenge, "VERIFYING_CODE");
    pending.resolve(normalizeCode(code));
    return challengePublic(challenge);
  }

  async function submitPassword({ agencyId, accountId, challengeId, password }) {
    const challenge = getChallenge({ agencyId, accountId, challengeId });
    if (challenge.stage !== "PASSWORD" || !challenge.passwordDeferred) {
      const err = new Error("Telegram is not waiting for a 2FA password");
      err.code = "SETTINGS_TELEGRAM_AUTH_STAGE_INVALID";
      err.status = 409;
      throw err;
    }
    const pending = challenge.passwordDeferred;
    challenge.passwordDeferred = null;
    challenge.lastError = null;
    setStage(challenge, "VERIFYING_PASSWORD");
    pending.resolve(normalizePassword(password));
    return challengePublic(challenge);
  }

  async function testConnection({ agencyId, accountId }) {
    const previous = Number(lastTestSend.get(accountId) || 0);
    const remainingMs = TEST_SEND_COOLDOWN_MS - (now() - previous);
    if (remainingMs > 0) {
      const err = new Error(`Wait ${Math.ceil(remainingMs / 1000)} seconds before sending another Telegram test`);
      err.code = "SETTINGS_TELEGRAM_TEST_COOLDOWN";
      err.status = 429;
      err.retryAfterSeconds = Math.ceil(remainingMs / 1000);
      throw err;
    }
    const entry = await createConnectedClient({ agencyId, accountId, requireSession: true });
    try {
      const username = TEST_RECIPIENT.replace(/^@/, "");
      const resolved = await entry.client.api.contacts.resolveUsername({ username });
      const resolvedUserId = telegramId(resolved?.peer?.userId)
        || telegramId((Array.isArray(resolved?.users) ? resolved.users : [])[0]?.id);
      if (!resolvedUserId) {
        const err = new Error(`Telegram resolved ${TEST_RECIPIENT}, but no user id was returned`);
        err.code = "SETTINGS_TELEGRAM_TEST_RESOLVE_FAILED";
        err.status = 502;
        throw err;
      }
      const sent = await entry.client.sendMessage(TEST_RECIPIENT, { message: TEST_MESSAGE });
      const sentAt = new Date(now()).toISOString();
      lastTestSend.set(accountId, now());
      testWatches.set(accountId, {
        recipient: TEST_RECIPIENT,
        resolvedUserId,
        sentAt,
        sentMessageId: messageId(sent?.id),
        receivedAt: null,
        receivedMessageId: null,
      });
      return {
        ok: true,
        recipient: TEST_RECIPIENT,
        resolvedUserId,
        message: TEST_MESSAGE,
        sentAt,
        sentMessageId: messageId(sent?.id),
      };
    } catch (error) {
      if (error?.code && String(error.code).startsWith("SETTINGS_")) throw error;
      const pub = publicTelegramError(error);
      if (pub.reauthRequired) {
        await clearSession({ agencyId, accountId, db }).catch(() => undefined);
        await forgetAccount(accountId).catch(() => undefined);
      }
      throwPublicTelegramError(error);
    }
  }

  function testStatus({ agencyId, accountId }) {
    const runtime = runtimes.get(accountId);
    if (runtime && runtime.agencyId !== agencyId) return { ok: true, started: false };
    const watch = testWatches.get(accountId);
    if (!watch) return { ok: true, started: false };
    return {
      ok: true,
      started: true,
      recipient: watch.recipient,
      resolvedUserId: watch.resolvedUserId,
      sentAt: watch.sentAt,
      sentMessageId: watch.sentMessageId,
      received: Boolean(watch.receivedAt),
      receivedAt: watch.receivedAt,
      receivedMessageId: watch.receivedMessageId,
    };
  }

  function runtimeStatus(accountId) {
    const challengeId = activeChallengeByAccount.get(accountId);
    const challenge = challengeId ? challenges.get(challengeId) : null;
    return {
      connected: runtimes.has(accountId),
      authStage: challenge && !["AUTHORIZED", "ERROR", "CANCELLED"].includes(challenge.stage) ? challenge.stage : null,
    };
  }

  return {
    beginAuthorization,
    submitCode,
    submitPassword,
    authorizationStatus,
    cancelAuthorization,
    testConnection,
    testStatus,
    runtimeStatus,
    forgetAccount,
    _private: { readAccount, saveSession, clearSession, telegramId, publicTelegramError },
  };
}

const singleton = createTelegramMtprotoRuntime();

module.exports = {
  TEST_RECIPIENT,
  TEST_MESSAGE,
  createTelegramMtprotoRuntime,
  beginTelegramAuthorization: (input) => singleton.beginAuthorization(input),
  submitTelegramAuthorizationCode: (input) => singleton.submitCode(input),
  submitTelegramAuthorizationPassword: (input) => singleton.submitPassword(input),
  getTelegramAuthorizationStatus: (input) => singleton.authorizationStatus(input),
  cancelTelegramAuthorization: (input) => singleton.cancelAuthorization(input),
  testTelegramConnection: (input) => singleton.testConnection(input),
  getTelegramTestStatus: (input) => singleton.testStatus(input),
  getTelegramRuntimeStatus: (accountId) => singleton.runtimeStatus(accountId),
  forgetTelegramAccountRuntime: (accountId) => singleton.forgetAccount(accountId),
};
