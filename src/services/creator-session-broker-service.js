"use strict";

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

function isCreatorSessionTargetActiveStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  // DRAFT is intentionally allowed so broker-first creator connect can publish
  // canonical R1 before complete-connection marks the creator READY.
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

function publicState(record, { includePayload = false } = {}) {
  if (!record) {
    return {
      revision: 0, status: "MISSING", payloadVersion: 1, portableReady: false, encryptionMode: null, keyVersion: null, platformUserId: null,
      credentialHash: null, coherenceHash: null, capturedAt: null, capturedByDeviceId: null, sourceRequestId: null,
      revokedAt: null, updatedAt: null, ...(includePayload ? { payload: null, opaquePayload: null } : {}),
    };
  }

  let opaquePayload = null;
  const encryptionMode = String(record.encryptionMode || "CLIENT_E2E_V1");
  if (includePayload && record.status === "ACTIVE") {
    if (encryptionMode !== "CLIENT_E2E_V1") {
      const error = new Error("Legacy creator session envelopes are not supported after the V20.22 cutover");
      error.code = "CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED"; error.status = 409; throw error;
    }
    if (!record.encryptedPayload || !record.iv || !record.tag || !record.algorithm || !record.keyVersion) {
      const error = new Error("Active creator session is missing client-side encrypted payload fields"); error.code = "CREATOR_SESSION_CORRUPT"; error.status = 500; throw error;
    }
    opaquePayload = {
      encryptionMode: "CLIENT_E2E_V1",
      keyVersion: Number(record.keyVersion),
      payloadVersion: Number(record.payloadVersion || 1),
      ciphertext: record.encryptedPayload, iv: record.iv, tag: record.tag, algorithm: record.algorithm,
    };
  }

  return {
    revision: Number(record.revision || 0), status: String(record.status || "MISSING"), payloadVersion: Number(record.payloadVersion || 1),
    portableReady: record.portableReady === true, encryptionMode, keyVersion: record.keyVersion == null ? null : Number(record.keyVersion), platformUserId: record.platformUserId || null,
    credentialHash: record.credentialHash || null, coherenceHash: record.coherenceHash || null, capturedAt: record.capturedAt || null,
    capturedByDeviceId: record.capturedByDeviceId || null, sourceRequestId: record.sourceRequestId || null, revokedAt: record.revokedAt || null, updatedAt: record.updatedAt || null,
    ...(includePayload ? { payload: null, opaquePayload } : {}),
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

  // Secret-bearing reads observe membership/access, creator lifecycle and the
  // exact canonical row in one Serializable snapshot. The backend never
  // decrypts creator credentials after the V20.22 CLIENT_E2E-only cutover.
  return runSessionReadSerializable(db, async (tx) => {
    const record = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (record && record.agencyId !== agencyId) { const error = new Error("Creator session state belongs to a different agency"); error.code = "CREATOR_SESSION_AGENCY_MISMATCH"; error.status = 403; throw error; }
    if (!record || record.status !== "ACTIVE") return publicState(record, { includePayload: true });
    if (String(record.encryptionMode || "") !== "CLIENT_E2E_V1") {
      const error = new Error("Legacy creator session envelopes are not supported after the V20.22 cutover");
      error.code = "CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED"; error.status = 409; throw error;
    }
    const live = await requireLiveCreatorSessionReader({ db: tx, agencyId, creatorId, userId, member });
    if (!deviceId) { const error = new Error("An enrolled device context is required to read creator session material"); error.code = "CREATOR_SESSION_E2E_DEVICE_CONTEXT_REQUIRED"; error.status = 403; throw error; }
    await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: Number(record.keyVersion), deviceId, member: live.member });
    return publicState(record, { includePayload: true });
  });
}

const CREATOR_SESSION_CAPTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function sessionConflict(current) {
  const error = new Error("Creator session revision is stale");
  error.code = "CREATOR_SESSION_REVISION_CONFLICT";
  error.status = 409;
  error.current = publicState(current, { includePayload: false });
  return error;
}

function captureTimeConflict(code, message, current = null) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  if (current) error.current = publicState(current, { includePayload: false });
  return error;
}

function assertCapturedAtNotFromFuture(captured, now = new Date()) {
  if (captured.getTime() > now.getTime() + CREATOR_SESSION_CAPTURE_CLOCK_SKEW_MS) {
    throw captureTimeConflict(
      "CREATOR_SESSION_CAPTURED_AT_FUTURE",
      "Creator session evidence is too far in the future",
    );
  }
}

function canonicalCapturedAtForWrite(current, captured) {
  if (!current?.capturedAt) return captured;
  const currentCaptured = new Date(current.capturedAt);
  if (Number.isNaN(currentCaptured.getTime())) return captured;
  if (captured.getTime() < currentCaptured.getTime() - CREATOR_SESSION_CAPTURE_CLOCK_SKEW_MS) {
    throw captureTimeConflict(
      "CREATOR_SESSION_CAPTURED_AT_STALE",
      "Creator session evidence is older than the current canonical evidence",
      current,
    );
  }
  // Tolerate bounded clock skew between devices without ever moving the
  // canonical freshness watermark backwards.
  return captured.getTime() >= currentCaptured.getTime() ? captured : currentCaptured;
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
  opaquePayload, credentialHash: suppliedCredentialHash, coherenceHash: suppliedCoherenceHash, portableReady: suppliedPortableReady = false,
}) {
  const revision = Math.max(0, Math.floor(Number(baseRevision) || 0));
  const normalizedRequestId = nullableText(requestId, 180);
  if (!normalizedRequestId) { const error = new Error("requestId is required"); error.code = "CREATOR_SESSION_REQUEST_ID_REQUIRED"; error.status = 400; throw error; }
  const identity = nullableText(platformUserId, 160);
  if (!identity) { const error = new Error("platformUserId is required"); error.code = "CREATOR_SESSION_PLATFORM_USER_REQUIRED"; error.status = 400; throw error; }
  await requireLiveCreatorSessionWriteTarget({ db, agencyId, creatorId, platformUserId: identity });

  if (!opaquePayload) {
    const error = new Error("Creator session writes require CLIENT_E2E_V1 opaquePayload");
    error.code = "CREATOR_SESSION_E2E_REQUIRED"; error.status = 400; throw error;
  }
  const stored = normalizeOpaquePayload(opaquePayload);
  const credentialHash = normalizeHash(suppliedCredentialHash, "CREATOR_SESSION_CREDENTIAL_HASH_INVALID");
  const coherenceHash = normalizeHash(suppliedCoherenceHash, "CREATOR_SESSION_COHERENCE_HASH_INVALID");
  const portableReady = suppliedPortableReady === true;
  await assertDeviceCanUseCreatorKey({ db, agencyId, creatorId, keyVersion: stored.keyVersion, deviceId, member: actorMember });
  const captured = capturedAt ? new Date(capturedAt) : new Date();
  if (Number.isNaN(captured.getTime())) { const error = new Error("capturedAt is invalid"); error.code = "CREATOR_SESSION_CAPTURED_AT_INVALID"; error.status = 400; throw error; }
  assertCapturedAtNotFromFuture(captured);

  return runSessionSerializable(db, async (tx) => {
    await requireLiveCreatorSessionWriteTarget({ db: tx, agencyId, creatorId, platformUserId: identity });
    await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: stored.keyVersion, deviceId, member: actorMember });
    const current = await tx.creatorSessionState.findUnique({ where: { creatorId } });
    if (sameWriteRequest(current, { requestId: normalizedRequestId, deviceId, coherenceHash, platformUserId: identity })) return { state: publicState(current, { includePayload: false }), idempotent: true, unchanged: true };
    if (!current) {
      if (revision !== 0) throw sessionConflict(null);
      try {
        const created = await tx.creatorSessionState.create({ data: {
          agencyId, creatorId, revision: 1, status: "ACTIVE", payloadVersion: stored.payloadVersion, portableReady, encryptionMode: "CLIENT_E2E_V1", keyVersion: stored.keyVersion,
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
    if (String(current.encryptionMode || "") !== "CLIENT_E2E_V1") {
      const error = new Error("Legacy creator session envelopes cannot be updated after the V20.22 cutover");
      error.code = "CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED"; error.status = 409; throw error;
    }
    const canonicalCapturedAt = canonicalCapturedAtForWrite(current, captured);
    const sameRepresentation = Number(current.keyVersion) === Number(stored.keyVersion);
    if (current.status === "ACTIVE" && current.coherenceHash === coherenceHash && current.platformUserId === identity && current.portableReady === portableReady && sameRepresentation) return { state: publicState(current, { includePayload: false }), idempotent: false, unchanged: true };
    const updated = await tx.creatorSessionState.updateMany({ where: { creatorId, agencyId, revision, encryptionMode: "CLIENT_E2E_V1" }, data: {
      revision: { increment: 1 }, status: "ACTIVE", payloadVersion: stored.payloadVersion, portableReady, encryptionMode: "CLIENT_E2E_V1", keyVersion: stored.keyVersion,
      encryptedPayload: stored.ciphertext, iv: stored.iv, tag: stored.tag, algorithm: stored.algorithm, platformUserId: identity, credentialHash, coherenceHash, capturedAt: canonicalCapturedAt,
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
        portableReady: false,
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
  isCreatorSessionTargetActiveStatus,
  assertCreatorSessionTargetActive,
  normalizeOpaquePayload,
  publicState,
  requireRegisteredDevice,
  getCreatorSession,
  writeCreatorSession,
  revokeCreatorSession,
};
