"use strict";

const crypto = require("node:crypto");
const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");
const { assertDeviceCanUseCreatorKey } = require("./client-e2e-keyring-service");
const { canAccessCreator } = require("../middleware/automation-permissions");

async function runSessionSerializable(db, work) {
  const options = { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await db.$transaction(work, options); }
    catch (error) {
      lastError = error;
      if (String(error?.code || "") !== "P2034") throw error;
    }
  }
  const error = new Error("Creator session changed concurrently; refresh and retry");
  error.code = "CREATOR_SESSION_WRITE_CONFLICT";
  error.status = 409;
  error.cause = lastError;
  throw error;
}

async function runSessionReadSerializable(db, work) {
  const options = { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await db.$transaction(work, options); }
    catch (error) {
      lastError = error;
      if (String(error?.code || "") !== "P2034") throw error;
    }
  }
  const error = new Error("Creator session authorization changed concurrently; refresh and retry");
  error.code = "CREATOR_SESSION_READ_CONFLICT";
  error.status = 409;
  error.cause = lastError;
  throw error;
}

function text(value, max = 4096) {
  const result = String(value ?? "");
  return result.length > max ? result.slice(0, max) : result;
}

function nullableText(value, max = 4096) {
  if (value === null || value === undefined) return null;
  const result = text(value, max).trim();
  return result || null;
}

function normalizeSameSite(value) {
  const result = nullableText(value, 32);
  if (!result) return null;
  return ["no_restriction", "lax", "strict", "unspecified"].includes(result) ? result : null;
}

const SESSION_COOKIE_NOISE_EXACT = new Set([
  "lang",
  "cookiesaccepted",
  "ref_src",
  "__cf_bm",
  "_cfuvid",
  "streams",
  "_fbp",
  "_gid",
  "_gcl_au",
]);

function isPortableSessionCookieName(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower || SESSION_COOKIE_NOISE_EXACT.has(lower)) return false;
  if (lower.startsWith("cloudfront-")) return false;
  if (lower.startsWith("__cf") || lower.startsWith("cf_")) return false;
  if (lower === "_ga" || lower.startsWith("_ga_") || lower.startsWith("_gat_")) return false;
  return true;
}

function isOnlyFansCookieDomain(domainInput) {
  const host = String(domainInput || "").trim().replace(/^\.+/, "").toLowerCase();
  return host === "onlyfans.com" || host.endsWith(".onlyfans.com");
}

function normalizeCookie(cookie) {
  const source = cookie && typeof cookie === "object" && !Array.isArray(cookie) ? cookie : {};
  const name = nullableText(source.name, 256);
  const domain = nullableText(source.domain, 512);
  if (!name || !domain || !isOnlyFansCookieDomain(domain) || !isPortableSessionCookieName(name)) return null;

  const expiration = Number(source.expirationDate);
  const rawExpirationDate = Number.isFinite(expiration) && expiration > 0 ? expiration : null;
  const session = source.session === true || rawExpirationDate === null;
  const expirationDate = session ? null : rawExpirationDate;

  const hostOnly = source.hostOnly === true ? true : source.hostOnly === false ? false : !domain.startsWith(".");
  const rawPath = nullableText(source.path, 2048) || "/";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  return {
    name,
    value: text(source.value, 32_768),
    domain,
    hostOnly,
    path,
    secure: source.secure !== false,
    httpOnly: source.httpOnly === true,
    sameSite: normalizeSameSite(source.sameSite),
    session,
    expirationDate,
  };
}

function cookieIdentity(cookie) {
  return `${String(cookie.domain || "").trim().replace(/^\.+/, "").toLowerCase()}\u0000${String(cookie.path || "/").trim() || "/"}\u0000${String(cookie.name || "").trim()}`;
}

function assertNoDuplicateCookies(cookies) {
  const seen = new Set();
  for (const cookie of cookies) {
    const key = cookieIdentity(cookie);
    if (seen.has(key)) {
      const error = new Error("Duplicate OnlyFans cookie identity is not allowed");
      error.code = "CREATOR_SESSION_DUPLICATE_COOKIE";
      error.status = 400;
      throw error;
    }
    seen.add(key);
  }
}

function isCreatorSessionTargetActiveStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  // DRAFT is intentionally allowed: the future broker-first creator-connect flow
  // must be able to establish canonical R1 before complete-runtime marks READY.
  return status === "DRAFT" || status === "READY";
}

function assertCreatorSessionTargetActive(creator) {
  if (isCreatorSessionTargetActiveStatus(creator?.status)) return;
  const error = new Error("Creator is not active for session-broker access");
  error.code = "CREATOR_SESSION_CREATOR_INACTIVE";
  error.status = 409;
  throw error;
}

async function requireLiveCreatorSessionWriteTarget({ db, agencyId, creatorId, platformUserId = null }) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, remoteId: true, status: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  assertCreatorSessionTargetActive(creator);
  if (platformUserId && creator.remoteId && String(creator.remoteId) !== String(platformUserId)) {
    const error = new Error("The verified OnlyFans identity does not match this creator");
    error.code = "CREATOR_SESSION_IDENTITY_MISMATCH";
    error.status = 409;
    throw error;
  }
  return creator;
}

async function requireLiveCreatorSessionReader({ db, agencyId, creatorId, userId = null, member = null }) {
  const liveMember = userId
    ? await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } })
    : member;
  if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
    const error = new Error("Agency membership is no longer active");
    error.code = "CREATOR_SESSION_MEMBER_INACTIVE";
    error.status = 403;
    throw error;
  }
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true, agencyId: true, status: true },
  });
  if (!creator) {
    const error = new Error("Creator not found");
    error.code = "CREATOR_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  assertCreatorSessionTargetActive(creator);
  if (!canAccessCreator(liveMember, creatorId)) {
    const error = new Error("Creator access was revoked before session material could be read");
    error.code = "CREATOR_SESSION_ACCESS_REVOKED";
    error.status = 403;
    throw error;
  }
  return { member: liveMember, creator };
}

function normalizePayload(payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const cookies = Array.isArray(source.cookies)
    ? source.cookies.map(normalizeCookie).filter(Boolean).slice(0, 256)
    : [];
  cookies.sort((left, right) => {
    const l = `${left.domain}\u0000${left.path}\u0000${left.name}`;
    const r = `${right.domain}\u0000${right.path}\u0000${right.name}`;
    return l.localeCompare(r);
  });

  const storageSource = source.storage && typeof source.storage === "object" && !Array.isArray(source.storage)
    ? source.storage
    : {};

  return {
    cookies,
    storage: {
      bcTokenSha: nullableText(storageSource.bcTokenSha, 16_384),
    },
    userAgent: nullableText(source.userAgent, 2048),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function hashesForPayload(payload) {
  const normalized = normalizePayload(payload);
  const credentialShape = {
    cookies: normalized.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, hostOnly: cookie.hostOnly, path: cookie.path })),
    storage: normalized.storage,
    userAgent: normalized.userAgent,
  };
  return {
    payload: normalized,
    credentialHash: hash(credentialShape),
    coherenceHash: hash(normalized),
  };
}

function normalizeOpaquePayload(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (String(source.encryptionMode || "") !== "CLIENT_E2E_V1") {
    const error = new Error("Unsupported creator session encryption mode");
    error.code = "CREATOR_SESSION_E2E_MODE_INVALID"; error.status = 400; throw error;
  }
  const keyVersion = Math.floor(Number(source.keyVersion));
  if (!Number.isInteger(keyVersion) || keyVersion < 1) { const error = new Error("keyVersion must be positive"); error.code = "CREATOR_SESSION_E2E_KEY_VERSION_INVALID"; error.status = 400; throw error; }
  if (String(source.algorithm || "") !== "aes-256-gcm-client-e2e-v1") { const error = new Error("Unsupported creator session E2E algorithm"); error.code = "CREATOR_SESSION_E2E_ALGORITHM_INVALID"; error.status = 400; throw error; }
  function b64(value, bytes, code) {
    const raw = Buffer.from(String(value || ""), "base64");
    if (raw.length !== bytes) { const error = new Error("Invalid creator session E2E envelope"); error.code = code; error.status = 400; throw error; }
    return raw.toString("base64");
  }
  const ciphertextRaw = Buffer.from(String(source.ciphertext || ""), "base64");
  if (!ciphertextRaw.length || ciphertextRaw.length > 512 * 1024) { const error = new Error("Invalid creator session E2E ciphertext"); error.code = "CREATOR_SESSION_E2E_CIPHERTEXT_INVALID"; error.status = 400; throw error; }
  return {
    encryptionMode: "CLIENT_E2E_V1", keyVersion, payloadVersion: 1,
    ciphertext: ciphertextRaw.toString("base64"),
    iv: b64(source.iv, 12, "CREATOR_SESSION_E2E_IV_INVALID"),
    tag: b64(source.tag, 16, "CREATOR_SESSION_E2E_TAG_INVALID"),
    algorithm: "aes-256-gcm-client-e2e-v1",
  };
}

function normalizeHash(value, code) {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) { const error = new Error("A SHA-256 hash is required"); error.code = code; error.status = 400; throw error; }
  return hash;
}

function publicState(record, { includePayload = false, allowLegacyDecrypt = true } = {}) {
  if (!record) {
    return {
      revision: 0, status: "MISSING", payloadVersion: 1, encryptionMode: null, keyVersion: null, platformUserId: null,
      credentialHash: null, coherenceHash: null, capturedAt: null, capturedByDeviceId: null, sourceRequestId: null,
      revokedAt: null, updatedAt: null, ...(includePayload ? { payload: null, opaquePayload: null } : {}),
    };
  }

  let payload = null;
  let opaquePayload = null;
  const encryptionMode = String(record.encryptionMode || "SERVER_V1");
  if (includePayload && record.status === "ACTIVE") {
    if (!record.encryptedPayload || !record.iv || !record.tag) {
      const error = new Error("Active creator session is missing encrypted payload fields"); error.code = "CREATOR_SESSION_CORRUPT"; error.status = 500; throw error;
    }
    if (encryptionMode === "CLIENT_E2E_V1") {
      opaquePayload = {
        encryptionMode: "CLIENT_E2E_V1",
        keyVersion: Number(record.keyVersion || 0),
        payloadVersion: Number(record.payloadVersion || 1),
        ciphertext: record.encryptedPayload, iv: record.iv, tag: record.tag, algorithm: record.algorithm,
      };
    } else {
      if (!allowLegacyDecrypt) { const error = new Error("Legacy server-decrypted creator session payload is disabled for this agency"); error.code = "CREATOR_SESSION_LEGACY_DECRYPT_DISABLED"; error.status = 409; throw error; }
      payload = decryptSnapshot(record);
    }
  }

  return {
    revision: Number(record.revision || 0), status: String(record.status || "MISSING"), payloadVersion: Number(record.payloadVersion || 1),
    encryptionMode, keyVersion: record.keyVersion == null ? null : Number(record.keyVersion), platformUserId: record.platformUserId || null,
    credentialHash: record.credentialHash || null, coherenceHash: record.coherenceHash || null, capturedAt: record.capturedAt || null,
    capturedByDeviceId: record.capturedByDeviceId || null, sourceRequestId: record.sourceRequestId || null, revokedAt: record.revokedAt || null, updatedAt: record.updatedAt || null,
    ...(includePayload ? { payload, opaquePayload } : {}),
  };
}

async function requireRegisteredDevice({ db, agencyId, userId, deviceId }) {
  const id = nullableText(deviceId, 180);
  if (!id) {
    const error = new Error("A registered deviceId is required");
    error.code = "CREATOR_SESSION_DEVICE_REQUIRED";
    error.status = 400;
    throw error;
  }
  const device = await db.workerDevice.findFirst({
    where: { id, agencyId, userId },
    select: { id: true, agencyId: true, userId: true, lastSeenAt: true },
  });
  if (!device) {
    const error = new Error("This device is not registered for the current user and agency");
    error.code = "CREATOR_SESSION_DEVICE_NOT_REGISTERED";
    error.status = 403;
    throw error;
  }
  return device;
}

async function getCreatorSession({ db, agencyId, creatorId, includePayload = true, deviceId = null, member = null, userId = null }) {
  if (!includePayload) {
    const record = await db.creatorSessionState.findUnique({ where: { creatorId } });
    if (record && record.agencyId !== agencyId) { const error = new Error("Creator session state belongs to a different agency"); error.code = "CREATOR_SESSION_AGENCY_MISMATCH"; error.status = 403; throw error; }
    return publicState(record, { includePayload: false });
  }

  // Secret-bearing reads must observe membership/access, creator lifecycle,
  // opaque-enforcement state and the session row in one Serializable snapshot.
  // Otherwise a route-authorized request can race demotion/access removal,
  // creator deletion, session revocation or crypto-shred and decrypt stale bytes.
  return runSessionReadSerializable(db, async (tx) => {
    const record = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (record && record.agencyId !== agencyId) { const error = new Error("Creator session state belongs to a different agency"); error.code = "CREATOR_SESSION_AGENCY_MISMATCH"; error.status = 403; throw error; }
    if (!record || record.status !== "ACTIVE") return publicState(record, { includePayload: true });

    const live = await requireLiveCreatorSessionReader({ db: tx, agencyId, creatorId, userId, member });
    const mode = String(record.encryptionMode || "SERVER_V1");
    if (mode === "CLIENT_E2E_V1") {
      if (!deviceId) { const error = new Error("An enrolled device context is required to read opaque creator session material"); error.code = "CREATOR_SESSION_E2E_DEVICE_CONTEXT_REQUIRED"; error.status = 403; throw error; }
      await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: Number(record.keyVersion), deviceId, member: live.member });
      return publicState(record, { includePayload: true, allowLegacyDecrypt: false });
    }

    const root = await tx.agencyCryptoRoot.findUnique({ where: { agencyId } });
    const allowLegacyDecrypt = root?.enforceOpaqueSecrets !== true;
    return publicState(record, { includePayload: true, allowLegacyDecrypt });
  });
}

async function migrateCreatorSessionToOpaque({ db, agencyId, creatorId, deviceId, member, expectedRevision, platformUserId, credentialHash, coherenceHash, opaquePayload }) {
  const revision = Math.floor(Number(expectedRevision));
  if (!Number.isInteger(revision) || revision < 1) { const error = new Error("expectedRevision must be positive"); error.code = "CREATOR_SESSION_MIGRATION_REVISION_INVALID"; error.status = 400; throw error; }
  const identity = nullableText(platformUserId, 160);
  if (!identity) { const error = new Error("platformUserId is required"); error.code = "CREATOR_SESSION_PLATFORM_USER_REQUIRED"; error.status = 400; throw error; }
  const normalizedCredentialHash = normalizeHash(credentialHash, "CREATOR_SESSION_CREDENTIAL_HASH_INVALID");
  const normalizedCoherenceHash = normalizeHash(coherenceHash, "CREATOR_SESSION_COHERENCE_HASH_INVALID");
  const stored = normalizeOpaquePayload(opaquePayload);
  return db.$transaction(async (tx) => {
    await requireLiveCreatorSessionWriteTarget({ db: tx, agencyId, creatorId, platformUserId: identity });
    const current = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (!current || current.agencyId !== agencyId) throw sessionConflict(current);
    if (current.status !== "ACTIVE") { const error = new Error("Only an active creator session can migrate to opaque encryption"); error.code = "CREATOR_SESSION_MIGRATION_NOT_ACTIVE"; error.status = 409; throw error; }
    if (Number(current.revision) !== revision || current.platformUserId !== identity || current.credentialHash !== normalizedCredentialHash || current.coherenceHash !== normalizedCoherenceHash) {
      throw sessionConflict(current);
    }
    if (String(current.encryptionMode || "SERVER_V1") === "CLIENT_E2E_V1") {
      if (Number(current.keyVersion) === stored.keyVersion) return { state: publicState(current, { includePayload: false }), migrated: false, alreadyOpaque: true };
      const error = new Error("Creator session encryption generation changed before migration"); error.code = "CREATOR_SESSION_MIGRATION_KEY_CONFLICT"; error.status = 409; throw error;
    }
    await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: stored.keyVersion, deviceId, member });
    const updated = await tx.creatorSessionState.updateMany({
      where: { creatorId, agencyId, revision, status: "ACTIVE", encryptionMode: "SERVER_V1", platformUserId: identity, credentialHash: normalizedCredentialHash, coherenceHash: normalizedCoherenceHash },
      data: { payloadVersion: stored.payloadVersion, encryptionMode: stored.encryptionMode, keyVersion: stored.keyVersion, encryptedPayload: stored.ciphertext, iv: stored.iv, tag: stored.tag, algorithm: stored.algorithm },
    });
    if (updated.count !== 1) {
      const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
      if (raced && String(raced.encryptionMode || "SERVER_V1") === "CLIENT_E2E_V1" && Number(raced.revision) === revision && Number(raced.keyVersion) === stored.keyVersion && raced.coherenceHash === normalizedCoherenceHash) {
        return { state: publicState(raced, { includePayload: false }), migrated: false, alreadyOpaque: true };
      }
      throw sessionConflict(raced);
    }
    const next = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    return { state: publicState(next, { includePayload: false }), migrated: true, alreadyOpaque: false };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

function sessionConflict(current) {
  const error = new Error("Creator session revision is stale");
  error.code = "CREATOR_SESSION_REVISION_CONFLICT";
  error.status = 409;
  error.current = publicState(current, { includePayload: false });
  return error;
}

function sameWriteRequest(current, { requestId, deviceId, coherenceHash, platformUserId }) {
  if (!current || current.sourceRequestId !== requestId || current.capturedByDeviceId !== deviceId) return false;
  if (current.coherenceHash !== coherenceHash || current.platformUserId !== platformUserId) {
    const error = new Error("requestId was already used for different creator session data");
    error.code = "CREATOR_SESSION_REQUEST_ID_REUSED";
    error.status = 409;
    throw error;
  }
  return true;
}

function sameRevokeRequest(current, { requestId, deviceId }) {
  return Boolean(current
    && current.status === "REVOKED"
    && current.sourceRequestId === requestId
    && current.capturedByDeviceId === deviceId);
}

async function writeCreatorSession({
  db, agencyId, creatorId, actorUserId, actorMember, deviceId, baseRevision, requestId, capturedAt, platformUserId,
  payload = null, opaquePayload = null, credentialHash: suppliedCredentialHash = null, coherenceHash: suppliedCoherenceHash = null,
}) {
  const revision = Math.max(0, Math.floor(Number(baseRevision) || 0));
  const normalizedRequestId = nullableText(requestId, 180);
  if (!normalizedRequestId) { const error = new Error("requestId is required"); error.code = "CREATOR_SESSION_REQUEST_ID_REQUIRED"; error.status = 400; throw error; }
  const identity = nullableText(platformUserId, 160);
  if (!identity) { const error = new Error("platformUserId is required"); error.code = "CREATOR_SESSION_PLATFORM_USER_REQUIRED"; error.status = 400; throw error; }
  await requireLiveCreatorSessionWriteTarget({ db, agencyId, creatorId, platformUserId: identity });

  const useOpaque = Boolean(opaquePayload);
  let stored;
  let credentialHash;
  let coherenceHash;
  if (useOpaque) {
    stored = normalizeOpaquePayload(opaquePayload);
    credentialHash = normalizeHash(suppliedCredentialHash, "CREATOR_SESSION_CREDENTIAL_HASH_INVALID");
    coherenceHash = normalizeHash(suppliedCoherenceHash, "CREATOR_SESSION_COHERENCE_HASH_INVALID");
    await assertDeviceCanUseCreatorKey({ db, agencyId, creatorId, keyVersion: stored.keyVersion, deviceId, member: actorMember });
  } else {
    const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
    if (root?.enforceOpaqueSecrets === true) { const error = new Error("Legacy plaintext creator session writes are disabled for this agency"); error.code = "CREATOR_SESSION_LEGACY_WRITE_DISABLED"; error.status = 409; throw error; }
    const hashed = hashesForPayload(payload);
    const normalizedPayload = hashed.payload; credentialHash = hashed.credentialHash; coherenceHash = hashed.coherenceHash;
    if (!normalizedPayload.cookies.length) { const error = new Error("At least one OnlyFans cookie is required"); error.code = "CREATOR_SESSION_COOKIES_REQUIRED"; error.status = 400; throw error; }
    assertNoDuplicateCookies(normalizedPayload.cookies);
    const strongCookieNames = new Set(normalizedPayload.cookies.map((cookie) => String(cookie.name || "").toLowerCase()));
    if (!strongCookieNames.has("sess") && !strongCookieNames.has("auth_id")) { const error = new Error("A strong OnlyFans auth cookie is required"); error.code = "CREATOR_SESSION_STRONG_AUTH_COOKIE_REQUIRED"; error.status = 400; throw error; }
    const encrypted = encryptSnapshot(normalizedPayload);
    stored = { encryptionMode: "SERVER_V1", keyVersion: null, payloadVersion: encrypted.payloadVersion, ciphertext: encrypted.encryptedPayload, iv: encrypted.iv, tag: encrypted.tag, algorithm: encrypted.algorithm };
  }
  const captured = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(captured.getTime())) { const error = new Error("capturedAt is invalid"); error.code = "CREATOR_SESSION_CAPTURED_AT_INVALID"; error.status = 400; throw error; }

  return runSessionSerializable(db, async (tx) => {
    await requireLiveCreatorSessionWriteTarget({ db: tx, agencyId, creatorId, platformUserId: identity });
    if (useOpaque) {
      await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: stored.keyVersion, deviceId, member: actorMember });
    } else {
      const root = await tx.agencyCryptoRoot.findUnique({ where: { agencyId } });
      if (root?.enforceOpaqueSecrets === true) {
        const error = new Error("Legacy plaintext creator session writes are disabled for this agency");
        error.code = "CREATOR_SESSION_LEGACY_WRITE_DISABLED";
        error.status = 409;
        throw error;
      }
    }
    const current = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (sameWriteRequest(current, { requestId: normalizedRequestId, deviceId, coherenceHash, platformUserId: identity })) return { state: publicState(current, { includePayload: false }), idempotent: true, unchanged: true };
    if (!current) {
      if (revision !== 0) throw sessionConflict(null);
      try {
        const created = await tx.creatorSessionState.create({ data: {
          agencyId, creatorId, revision: 1, status: "ACTIVE", payloadVersion: stored.payloadVersion, encryptionMode: stored.encryptionMode, keyVersion: stored.keyVersion,
          encryptedPayload: stored.ciphertext, iv: stored.iv, tag: stored.tag, algorithm: stored.algorithm, platformUserId: identity, credentialHash, coherenceHash, capturedAt: captured,
          capturedByUserId: actorUserId, capturedByDeviceId: deviceId, sourceRequestId: normalizedRequestId, revokedAt: null, revokeReason: null,
        } });
        return { state: publicState(created, { includePayload: false }), idempotent: false, unchanged: false };
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
        if (sameWriteRequest(raced, { requestId: normalizedRequestId, deviceId, coherenceHash, platformUserId: identity })) return { state: publicState(raced, { includePayload: false }), idempotent: true, unchanged: true };
        throw sessionConflict(raced);
      }
    }
    if (current.agencyId !== agencyId || Number(current.revision) !== revision) throw sessionConflict(current);
    if (current.status === "REVOKED") { const error = new Error("Revoked creator session requires an explicit re-initialize flow"); error.code = "CREATOR_SESSION_REVOKED"; error.status = 409; error.current = publicState(current, { includePayload: false }); throw error; }
    const sameRepresentation = String(current.encryptionMode || "SERVER_V1") === stored.encryptionMode && (stored.encryptionMode !== "CLIENT_E2E_V1" || Number(current.keyVersion) === Number(stored.keyVersion));
    if (current.status === "ACTIVE" && current.coherenceHash === coherenceHash && current.platformUserId === identity && sameRepresentation) return { state: publicState(current, { includePayload: false }), idempotent: false, unchanged: true };
    const updated = await tx.creatorSessionState.updateMany({ where: { creatorId, agencyId, revision }, data: {
      revision: { increment: 1 }, status: "ACTIVE", payloadVersion: stored.payloadVersion, encryptionMode: stored.encryptionMode, keyVersion: stored.keyVersion,
      encryptedPayload: stored.ciphertext, iv: stored.iv, tag: stored.tag, algorithm: stored.algorithm, platformUserId: identity, credentialHash, coherenceHash, capturedAt: captured,
      capturedByUserId: actorUserId, capturedByDeviceId: deviceId, sourceRequestId: normalizedRequestId, revokedAt: null, revokeReason: null,
    } });
    if (updated.count !== 1) {
      const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
      if (sameWriteRequest(raced, { requestId: normalizedRequestId, deviceId, coherenceHash, platformUserId: identity })) return { state: publicState(raced, { includePayload: false }), idempotent: true, unchanged: true };
      throw sessionConflict(raced);
    }
    const next = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    return { state: publicState(next, { includePayload: false }), idempotent: false, unchanged: false };
  });
}

async function revokeCreatorSession({ db, agencyId, creatorId, actorUserId, deviceId, baseRevision, requestId, reason }) {
  const revision = Math.max(0, Math.floor(Number(baseRevision) || 0));
  const normalizedRequestId = nullableText(requestId, 180);
  if (!normalizedRequestId) {
    const error = new Error("requestId is required");
    error.code = "CREATOR_SESSION_REQUEST_ID_REQUIRED";
    error.status = 400;
    throw error;
  }

  return db.$transaction(async (tx) => {
    const current = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (!current) {
      if (revision !== 0) throw sessionConflict(null);
      return { state: publicState(null, { includePayload: false }), idempotent: false, unchanged: true };
    }
    if (current.agencyId !== agencyId) throw sessionConflict(current);
    if (sameRevokeRequest(current, { requestId: normalizedRequestId, deviceId })) {
      return { state: publicState(current, { includePayload: false }), idempotent: true, unchanged: true };
    }
    if (Number(current.revision) !== revision) throw sessionConflict(current);
    if (current.status === "REVOKED") {
      return { state: publicState(current, { includePayload: false }), idempotent: false, unchanged: true };
    }

    const now = new Date();
    const updated = await tx.creatorSessionState.updateMany({
      where: { creatorId, agencyId, revision, status: "ACTIVE" },
      data: {
        revision: { increment: 1 },
        status: "REVOKED",
        encryptedPayload: null,
        iv: null,
        tag: null,
        algorithm: null,
        keyVersion: null,
        credentialHash: null,
        coherenceHash: null,
        capturedAt: now,
        capturedByUserId: actorUserId,
        capturedByDeviceId: deviceId,
        sourceRequestId: normalizedRequestId,
        revokedAt: now,
        revokeReason: nullableText(reason, 500),
      },
    });
    if (updated.count !== 1) {
      const raced = await tx.creatorSessionState.findUnique({ where: { creatorId } });
      if (sameRevokeRequest(raced, { requestId: normalizedRequestId, deviceId })) {
        return { state: publicState(raced, { includePayload: false }), idempotent: true, unchanged: true };
      }
      throw sessionConflict(raced);
    }
    const next = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    return { state: publicState(next, { includePayload: false }), idempotent: false, unchanged: false };
  }, { maxWait: 10_000, timeout: 30_000 });
}

module.exports = {
  normalizePayload,
  assertNoDuplicateCookies,
  isCreatorSessionTargetActiveStatus,
  assertCreatorSessionTargetActive,
  hashesForPayload,
  normalizeOpaquePayload,
  publicState,
  requireRegisteredDevice,
  getCreatorSession,
  migrateCreatorSessionToOpaque,
  writeCreatorSession,
  revokeCreatorSession,
};
