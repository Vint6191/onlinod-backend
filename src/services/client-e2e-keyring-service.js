"use strict";

const crypto = require("node:crypto");
const { isOwner } = require("./team-access-control");
const { assignedCreatorIds, hasBroadCreatorAccess, canAccessCreator, allowedCreatorScope } = require("../middleware/automation-permissions");

const DEVICE_KEY_ALGORITHM = "x25519-spki-der-v1";
const WRAP_ALGORITHM = "x25519-hkdf-sha256-aes-256-gcm-v1";
const RECOVERY_ALGORITHM = "aes-256-gcm-recovery-v1";
const ROOT_BRIDGE_ALGORITHM = "aes-256-gcm-root-bridge-v1";

const CREATOR_SECRET_ALGORITHM = "aes-256-gcm-client-e2e-v1";

function normalizeCreatorSecretEnvelope(input, expectedKeyVersion, label = "Creator secret") {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (String(source.encryptionMode || "") !== "CLIENT_E2E_V1") {
    throw codedError("CRYPTO_ROTATION_ENVELOPE_MODE_INVALID", `${label} must use CLIENT_E2E_V1`, 400);
  }
  const keyVersion = Math.floor(Number(source.keyVersion));
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion !== Number(expectedKeyVersion)) {
    throw codedError("CRYPTO_ROTATION_ENVELOPE_VERSION_INVALID", `${label} keyVersion does not match the rotation generation`, 400);
  }
  if (String(source.algorithm || "") !== CREATOR_SECRET_ALGORITHM) {
    throw codedError("CRYPTO_ROTATION_ENVELOPE_ALGORITHM_INVALID", `${label} uses an unsupported algorithm`, 400);
  }
  const ciphertext = Buffer.from(String(source.ciphertext || source.encryptedPayload || ""), "base64");
  const iv = Buffer.from(String(source.iv || ""), "base64");
  const tag = Buffer.from(String(source.tag || ""), "base64");
  if (!ciphertext.length || ciphertext.length > 1024 * 1024 || iv.length !== 12 || tag.length !== 16) {
    throw codedError("CRYPTO_ROTATION_ENVELOPE_INVALID", `${label} envelope is malformed`, 400);
  }
  return {
    encryptedPayload: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    algorithm: CREATOR_SECRET_ALGORITHM,
    encryptionMode: "CLIENT_E2E_V1",
    keyVersion,
  };
}

async function serializableTransaction(db, fn, conflictCode = "CRYPTO_ROTATION_WRITE_CONFLICT") {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (String(error?.code || "") !== "P2034" || attempt >= 3) break;
    }
  }
  if (String(lastError?.code || "") === "P2034") {
    throw codedError(conflictCode, "Encryption state changed concurrently; refresh and retry", 409);
  }
  throw lastError;
}

function clean(value, max = 4096) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function codedError(code, message, status = 409, extra = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (extra && typeof extra === "object") Object.assign(error, extra);
  return error;
}

function requireOwner(member) {
  if (!isOwner(member)) throw codedError("CRYPTO_OWNER_REQUIRED", "Workspace owner approval is required for encryption key management", 403);
}

async function withFreshOwnerRead({ db, agencyId, userId, member, read, conflictCode = "CRYPTO_OWNER_READ_CONFLICT" }) {
  const actorUserId = clean(userId, 180);
  if (!actorUserId) throw codedError("CRYPTO_ACTOR_USER_REQUIRED", "Authenticated agency user is required for owner crypto reads", 403);
  return serializableTransaction(db, async (tx) => {
    const liveMember = await tx.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId: actorUserId } } });
    if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
      throw codedError("CRYPTO_APPROVER_INACTIVE", "Agency member is no longer active", 403);
    }
    requireOwner(liveMember);
    return read(tx, liveMember);
  }, conflictCode);
}

function requireIdentityUser(identity, userId) {
  if (!identity || String(identity.userId || "") !== String(userId || "")) {
    throw codedError("CRYPTO_DEVICE_USER_MISMATCH", "Device crypto identity is registered to a different agency member", 403);
  }
  return identity;
}

function parseX25519PublicKey(input) {
  const raw = Buffer.from(clean(input, 4096), "base64");
  if (!raw.length || raw.length > 256) throw codedError("CRYPTO_PUBLIC_KEY_INVALID", "Invalid X25519 public key", 400);
  let key;
  try {
    key = crypto.createPublicKey({ key: raw, format: "der", type: "spki" });
  } catch {
    throw codedError("CRYPTO_PUBLIC_KEY_INVALID", "Invalid X25519 public key", 400);
  }
  if (key.asymmetricKeyType !== "x25519") throw codedError("CRYPTO_PUBLIC_KEY_TYPE_INVALID", "Device key must be X25519", 400);
  const canonical = Buffer.from(key.export({ format: "der", type: "spki" }));
  return {
    publicKey: canonical.toString("base64"),
    fingerprint: crypto.createHash("sha256").update(canonical).digest("base64url"),
  };
}

function parseBase64Field(value, { code, label, minBytes, maxBytes }) {
  const text = clean(value, Math.ceil(maxBytes * 1.5) + 16);
  if (!text) throw codedError(code, `${label} is required`, 400);
  let raw;
  try { raw = Buffer.from(text, "base64"); } catch { raw = Buffer.alloc(0); }
  if (raw.length < minBytes || raw.length > maxBytes) throw codedError(code, `${label} has an invalid size`, 400);
  return raw.toString("base64");
}

function normalizeWrapEnvelope(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (clean(source.algorithm, 128) !== WRAP_ALGORITHM) throw codedError("CRYPTO_WRAP_ALGORITHM_UNSUPPORTED", "Unsupported device key wrap algorithm", 400);
  const ephemeral = parseX25519PublicKey(source.ephemeralPublicKey);
  return {
    ephemeralPublicKey: ephemeral.publicKey,
    ciphertext: parseBase64Field(source.ciphertext, { code: "CRYPTO_WRAP_CIPHERTEXT_INVALID", label: "Wrapped key ciphertext", minBytes: 32, maxBytes: 64 }),
    iv: parseBase64Field(source.iv, { code: "CRYPTO_WRAP_IV_INVALID", label: "Wrapped key IV", minBytes: 12, maxBytes: 12 }),
    tag: parseBase64Field(source.tag, { code: "CRYPTO_WRAP_TAG_INVALID", label: "Wrapped key tag", minBytes: 16, maxBytes: 16 }),
    algorithm: WRAP_ALGORITHM,
  };
}

function normalizeRecoveryProof(input) {
  const proof = Buffer.from(clean(input, 256), "base64");
  if (proof.length !== 32) throw codedError("CRYPTO_RECOVERY_PROOF_INVALID", "Recovery proof must be exactly 32 bytes", 400);
  return proof;
}

function recoveryProofHash(input) {
  const proof = Buffer.isBuffer(input) ? input : normalizeRecoveryProof(input);
  return crypto.createHash("sha256").update(proof).digest("base64");
}

function verifyRecoveryProof(root, input) {
  if (!root?.recoveryProofHash) throw codedError("CRYPTO_RECOVERY_PROOF_UNAVAILABLE", "Recovery proof is not pinned for this root; this intermediate root must be replaced through a controlled owner recovery/root reset before destructive key management can continue", 409);
  const proof = normalizeRecoveryProof(input);
  const actual = Buffer.from(recoveryProofHash(proof), "base64");
  const expected = Buffer.from(String(root.recoveryProofHash || ""), "base64");
  if (expected.length !== 32 || actual.length !== 32 || !crypto.timingSafeEqual(actual, expected)) throw codedError("CRYPTO_RECOVERY_PROOF_MISMATCH", "Recovery proof does not match the active Agency Master Key", 403);
  return true;
}

function verifyActorProof(root, input) {
  try {
    return verifyRecoveryProof(root, input);
  } catch (error) {
    if (error?.code === "CRYPTO_RECOVERY_PROOF_MISMATCH") {
      throw codedError("CRYPTO_ACTOR_PROOF_MISMATCH", "Destructive encryption management requires possession of the active Agency Master Key", 403);
    }
    if (error?.code === "CRYPTO_RECOVERY_PROOF_UNAVAILABLE") {
      throw codedError("CRYPTO_ACTOR_PROOF_UNAVAILABLE", "This root has no verifiable AMK-possession proof; replace the intermediate root through a controlled recovery before destructive encryption management", 409);
    }
    throw error;
  }
}

function normalizeRecoveryEnvelope(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (clean(source.algorithm, 128) !== RECOVERY_ALGORITHM) throw codedError("CRYPTO_RECOVERY_ALGORITHM_UNSUPPORTED", "Unsupported recovery envelope algorithm", 400);
  return {
    ciphertext: parseBase64Field(source.ciphertext, { code: "CRYPTO_RECOVERY_CIPHERTEXT_INVALID", label: "Recovery ciphertext", minBytes: 32, maxBytes: 64 }),
    iv: parseBase64Field(source.iv, { code: "CRYPTO_RECOVERY_IV_INVALID", label: "Recovery IV", minBytes: 12, maxBytes: 12 }),
    tag: parseBase64Field(source.tag, { code: "CRYPTO_RECOVERY_TAG_INVALID", label: "Recovery tag", minBytes: 16, maxBytes: 16 }),
    algorithm: RECOVERY_ALGORITHM,
    formatVersion: 1,
  };
}

function normalizeRootBridgeEnvelope(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (clean(source.algorithm, 128) !== ROOT_BRIDGE_ALGORITHM) throw codedError("CRYPTO_ROOT_BRIDGE_ALGORITHM_UNSUPPORTED", "Unsupported root bridge algorithm", 400);
  return {
    ciphertext: parseBase64Field(source.ciphertext, { code: "CRYPTO_ROOT_BRIDGE_CIPHERTEXT_INVALID", label: "Root bridge ciphertext", minBytes: 32, maxBytes: 32 }),
    iv: parseBase64Field(source.iv, { code: "CRYPTO_ROOT_BRIDGE_IV_INVALID", label: "Root bridge IV", minBytes: 12, maxBytes: 12 }),
    tag: parseBase64Field(source.tag, { code: "CRYPTO_ROOT_BRIDGE_TAG_INVALID", label: "Root bridge tag", minBytes: 16, maxBytes: 16 }),
    algorithm: ROOT_BRIDGE_ALGORITHM,
  };
}

function cryptoIdentityWhere(agencyId, deviceId) {
  return { agencyId_deviceId: { agencyId, deviceId } };
}

async function requireRegisteredDevice({ db, agencyId, userId, deviceId }) {
  const id = clean(deviceId, 180);
  if (!id) throw codedError("CRYPTO_DEVICE_REQUIRED", "Registered deviceId is required", 400);
  const device = await db.workerDevice.findFirst({
    where: { id, agencyId, userId },
    select: { id: true, agencyId: true, userId: true, deviceName: true, platform: true, appVersion: true, lastSeenAt: true },
  });
  if (!device) throw codedError("CRYPTO_DEVICE_NOT_REGISTERED", "This device is not registered for the current user and agency", 403);
  return device;
}

async function requireCryptoIdentityForUser({ db, agencyId, userId, deviceId, requireActive = false }) {
  const id = clean(deviceId, 180);
  if (!id) throw codedError("CRYPTO_DEVICE_REQUIRED", "Registered deviceId is required", 400);
  const identity = await db.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, id) });
  if (!identity) throw codedError("CRYPTO_DEVICE_IDENTITY_REQUIRED", "Register this device crypto identity first", 409);
  requireIdentityUser(identity, userId);
  if (identity.status === "REVOKED" || identity.revokedAt) throw codedError("CRYPTO_DEVICE_REVOKED", "This device crypto identity has been revoked", 403);
  if (requireActive && identity.status !== "ACTIVE") throw codedError("CRYPTO_DEVICE_NOT_ACTIVE", "This device crypto identity is not active", 403);
  return { id, identity };
}

function publicIdentity(identity) {
  if (!identity) return null;
  return {
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    algorithm: identity.algorithm,
    fingerprint: identity.fingerprint,
    status: identity.status,
    registeredAt: identity.registeredAt,
    activatedAt: identity.activatedAt,
    revokedAt: identity.revokedAt,
    updatedAt: identity.updatedAt,
  };
}

function publicRoot(root) {
  if (!root) return null;
  return {
    version: Number(root.version || 1),
    status: String(root.status || "ACTIVE"),
    initializedAt: root.initializedAt,
    updatedAt: root.updatedAt,
    recoveryProofAvailable: Boolean(root.recoveryProofHash),
  };
}

function publicOwnerWrap(wrap) {
  if (!wrap) return null;
  return {
    rootVersion: Number(wrap.rootVersion),
    deviceId: wrap.deviceId,
    ephemeralPublicKey: wrap.ephemeralPublicKey,
    ciphertext: wrap.ciphertext,
    iv: wrap.iv,
    tag: wrap.tag,
    algorithm: wrap.algorithm,
    createdAt: wrap.createdAt,
    revokedAt: wrap.revokedAt,
  };
}

function publicCreatorWrap(wrap) {
  return {
    creatorId: wrap.creatorId,
    keyVersion: Number(wrap.keyVersion),
    deviceId: wrap.deviceId,
    ephemeralPublicKey: wrap.ephemeralPublicKey,
    ciphertext: wrap.ciphertext,
    iv: wrap.iv,
    tag: wrap.tag,
    algorithm: wrap.algorithm,
    createdAt: wrap.createdAt,
    revokedAt: wrap.revokedAt,
  };
}

async function activeCryptoCreatorIds({ db, agencyId }) {
  const rows = await db.creatorAccount.findMany({
    where: { agencyId, deletedAt: null },
    select: { id: true },
  });
  return Array.from(new Set(rows.map((row) => String(row.id || "")).filter(Boolean))).sort();
}

async function findRootExposureDebt({ db, agencyId, root: rootInput = null }) {
  const root = rootInput || await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  if (!root) return { deviceIds: [], exposures: [] };
  const [activeCreatorIds, identities, members] = await Promise.all([
    activeCryptoCreatorIds({ db, agencyId }),
    db.deviceCryptoIdentity.findMany({ where: { agencyId }, select: { deviceId: true, userId: true, status: true, revokedAt: true } }),
    db.agencyMember.findMany({ where: { agencyId }, select: { userId: true, role: true, roleKey: true, deletedAt: true, deactivatedAt: true } }),
  ]);
  const creatorKeyStates = activeCreatorIds.length ? await db.creatorCryptoKeyState.findMany({
    where: { agencyId, creatorId: { in: activeCreatorIds } },
    select: { rootVersion: true },
  }) : [];
  const referencedRootVersions = Array.from(new Set([
    Number(root.version || 0),
    ...creatorKeyStates.map((row) => Number(row.rootVersion || 0)),
  ].filter((value) => Number.isInteger(value) && value > 0))).sort((a, b) => a - b);
  if (!referencedRootVersions.length) return { deviceIds: [], exposures: [] };

  // Historical AMK knowledge is represented by owner-wrap history, not by the
  // continued existence of a DeviceCryptoIdentity row. Deleting/re-enrolling an
  // identity must never erase the fact that a physical device previously knew a
  // root generation that still protects active state.
  const ownerWraps = await db.agencyCryptoOwnerKeyWrap.findMany({
    where: { agencyId, rootVersion: { in: referencedRootVersions } },
    select: { deviceId: true, rootVersion: true },
  });
  if (!ownerWraps.length) return { deviceIds: [], exposures: [] };

  const identityByDeviceId = new Map(identities.map((row) => [String(row.deviceId), row]));
  const memberByUserId = new Map(members.map((row) => [String(row.userId), row]));
  const seen = new Set();
  const exposures = [];
  for (const row of ownerWraps) {
    const deviceId = String(row.deviceId || "");
    const rootVersion = Number(row.rootVersion || 0);
    if (!deviceId || !referencedRootVersions.includes(rootVersion)) continue;
    const identity = identityByDeviceId.get(deviceId) || null;
    const agencyMember = identity ? (memberByUserId.get(String(identity.userId || "")) || null) : null;
    const stillTrustedOwner = Boolean(
      identity
      && identity.status === "ACTIVE"
      && !identity.revokedAt
      && agencyMember
      && !agencyMember.deletedAt
      && !agencyMember.deactivatedAt
      && isOwner(agencyMember)
    );
    if (stillTrustedOwner) continue;
    const key = `${deviceId}:${rootVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    exposures.push({ deviceId, rootVersion });
  }
  return {
    deviceIds: Array.from(new Set(exposures.map((row) => row.deviceId))).sort(),
    exposures: exposures.sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.rootVersion - b.rootVersion),
  };
}

async function findUntrustedCreatorExposureDebt({ db, agencyId }) {
  const [activeCreatorIds, identities, members] = await Promise.all([
    activeCryptoCreatorIds({ db, agencyId }),
    db.deviceCryptoIdentity.findMany({
      where: { agencyId },
      select: { deviceId: true, userId: true, status: true, revokedAt: true },
    }),
    db.agencyMember.findMany({
      where: { agencyId },
      select: { userId: true, role: true, roleKey: true, assignedCreators: true, deletedAt: true, deactivatedAt: true },
    }),
  ]);
  if (!activeCreatorIds.length) return { deviceIds: [], creatorIds: [], exposures: [] };
  const creatorKeyStates = await db.creatorCryptoKeyState.findMany({
    where: { agencyId, creatorId: { in: activeCreatorIds } },
    select: { creatorId: true, activeVersion: true },
  });
  if (!creatorKeyStates.length) return { deviceIds: [], creatorIds: [], exposures: [] };

  const identityByDeviceId = new Map(identities.map((row) => [String(row.deviceId || ""), row]));
  const memberByUserId = new Map(members.map((row) => [String(row.userId || ""), row]));
  const activeVersionByCreator = new Map(creatorKeyStates.map((row) => [String(row.creatorId || ""), Number(row.activeVersion || 0)]));
  const creatorIds = [...activeVersionByCreator.keys()].filter(Boolean);
  const activeVersions = Array.from(new Set([...activeVersionByCreator.values()].filter((value) => Number.isInteger(value) && value > 0)));
  if (!creatorIds.length || !activeVersions.length) return { deviceIds: [], creatorIds: [], exposures: [] };

  // A device is trusted per creator, not merely per agency. An otherwise ACTIVE
  // chatter that lost creator X access may already know X's current CDK, so the
  // old generation remains exposure debt until X is strongly rotated.
  const wraps = await db.creatorDeviceKeyWrap.findMany({
    where: {
      agencyId,
      creatorId: { in: creatorIds },
      keyVersion: { in: activeVersions },
    },
    select: { deviceId: true, creatorId: true, keyVersion: true },
  });
  const seen = new Set();
  const exposures = [];
  for (const row of wraps) {
    const deviceId = String(row.deviceId || "");
    const creatorId = String(row.creatorId || "");
    const keyVersion = Number(row.keyVersion || 0);
    if (!deviceId || !creatorId || activeVersionByCreator.get(creatorId) !== keyVersion) continue;
    const identity = identityByDeviceId.get(deviceId) || null;
    const agencyMember = identity ? (memberByUserId.get(String(identity.userId || "")) || null) : null;
    const stillTrustedForCreator = Boolean(
      identity
      && identity.status === "ACTIVE"
      && !identity.revokedAt
      && agencyMember
      && !agencyMember.deletedAt
      && !agencyMember.deactivatedAt
      && (isOwner(agencyMember) || canAccessCreator(agencyMember, creatorId))
    );
    if (stillTrustedForCreator) continue;
    const key = `${deviceId}:${creatorId}:${keyVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    exposures.push({ deviceId, creatorId, keyVersion });
  }
  exposures.sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.creatorId.localeCompare(b.creatorId) || a.keyVersion - b.keyVersion);
  return {
    deviceIds: Array.from(new Set(exposures.map((row) => row.deviceId))).sort(),
    creatorIds: Array.from(new Set(exposures.map((row) => row.creatorId))).sort(),
    exposures,
  };
}

async function revokeOwnerRootAccessForMember({ db, agencyId, userId, revokedAt = new Date() }) {
  const identities = await db.deviceCryptoIdentity.findMany({
    where: { agencyId, userId },
    select: { deviceId: true },
  });
  const deviceIds = Array.from(new Set(identities.map((row) => String(row.deviceId || "")).filter(Boolean)));
  if (!deviceIds.length) return { revokedOwnerWrapCount: 0, deviceIds: [] };
  const result = await db.agencyCryptoOwnerKeyWrap.updateMany({
    where: { agencyId, deviceId: { in: deviceIds }, revokedAt: null },
    data: { revokedAt },
  });
  return { revokedOwnerWrapCount: Number(result?.count || 0), deviceIds };
}

async function registerDeviceIdentity({ db, agencyId, userId, deviceId, publicKey }) {
  const device = await requireRegisteredDevice({ db, agencyId, userId, deviceId });
  const canonical = parseX25519PublicKey(publicKey);
  const existing = await db.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, device.id) });
  if (existing) {
    if (existing.agencyId !== agencyId) throw codedError("CRYPTO_DEVICE_AGENCY_MISMATCH", "Device crypto identity belongs to a different agency", 403);
    if (String(existing.userId || "") !== String(userId || "")) throw codedError("CRYPTO_DEVICE_USER_MISMATCH", "Device crypto identity is registered to a different agency member", 403);
    if (existing.publicKey !== canonical.publicKey || existing.fingerprint !== canonical.fingerprint) {
      throw codedError("CRYPTO_DEVICE_KEY_IMMUTABLE", "Device crypto public key is immutable; register a new device identity to rotate it", 409, { current: publicIdentity(existing) });
    }
    if (existing.status === "REVOKED") throw codedError("CRYPTO_DEVICE_REVOKED", "This device crypto identity has been revoked", 403);
    return { identity: publicIdentity(existing), idempotent: true };
  }

  // A missing identity row does not mean this logical device id is fresh. Wrap
  // history is durable evidence that an older private key already received AMK
  // or CDK material. Reusing the same id with a new public key would merge two
  // different cryptographic principals and could hide historical exposure debt.
  const [historicalOwnerWrap, historicalCreatorWrap] = await Promise.all([
    db.agencyCryptoOwnerKeyWrap.findFirst({ where: { agencyId, deviceId: device.id }, select: { id: true } }),
    db.creatorDeviceKeyWrap.findFirst({ where: { agencyId, deviceId: device.id }, select: { id: true } }),
  ]);
  if (historicalOwnerWrap || historicalCreatorWrap) {
    throw codedError(
      "CRYPTO_DEVICE_ID_REUSE_FORBIDDEN",
      "This logical device id has historical encryption-key access and cannot be rebound to a new crypto identity; retire it and sign in with a new device id",
      409,
    );
  }

  const identity = await db.deviceCryptoIdentity.create({
    data: { deviceId: device.id, agencyId, userId, publicKey: canonical.publicKey, algorithm: DEVICE_KEY_ALGORITHM, fingerprint: canonical.fingerprint, status: "PENDING" },
  });
  return { identity: publicIdentity(identity), idempotent: false };
}

async function initializeAgencyCryptoRoot({ db, agencyId, userId, member, deviceId, recoveryEnvelope, ownerWrap, recoveryProof }) {
  const recovery = normalizeRecoveryEnvelope(recoveryEnvelope);
  const wrap = normalizeWrapEnvelope(ownerWrap);
  const proofHash = recoveryProofHash(recoveryProof);
  const actorDeviceId = clean(deviceId, 180);
  if (!actorDeviceId) throw codedError("CRYPTO_DEVICE_REQUIRED", "deviceId is required", 400);
  return serializableTransaction(db, async (tx) => {
    const liveMember = await tx.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } });
    if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) throw codedError("CRYPTO_APPROVER_INACTIVE", "Agency member is no longer active", 403);
    requireOwner(liveMember);
    const existingRoot = await tx.agencyCryptoRoot.findUnique({ where: { agencyId } });
    if (existingRoot) throw codedError("CRYPTO_ROOT_ALREADY_INITIALIZED", "Agency encryption root is already initialized", 409, { current: publicRoot(existingRoot) });
    const identity = await tx.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, actorDeviceId) });
    if (!identity || identity.agencyId !== agencyId) throw codedError("CRYPTO_DEVICE_IDENTITY_REQUIRED", "Register this device crypto identity before initializing encryption", 409);
    requireIdentityUser(identity, userId);
    if (identity.status === "REVOKED" || identity.revokedAt) throw codedError("CRYPTO_DEVICE_REVOKED", "This device crypto identity has been revoked", 403);
    const root = await tx.agencyCryptoRoot.create({
      data: {
        agencyId,
        version: 1,
        status: "ACTIVE",
        recoveryCiphertext: recovery.ciphertext,
        recoveryIv: recovery.iv,
        recoveryTag: recovery.tag,
        recoveryAlgorithm: recovery.algorithm,
        recoveryFormatVersion: recovery.formatVersion,
        recoveryProofHash: proofHash,
        initializedByDeviceId: actorDeviceId,
      },
    });
    const ownerKeyWrap = await tx.agencyCryptoOwnerKeyWrap.create({
      data: { agencyId, rootVersion: 1, deviceId: actorDeviceId, ...wrap, createdByDeviceId: actorDeviceId },
    });
    await tx.deviceCryptoIdentity.update({ where: cryptoIdentityWhere(agencyId, actorDeviceId), data: { status: "ACTIVE", activatedAt: new Date(), revokedAt: null } });
    return { root: publicRoot(root), ownerWrap: publicOwnerWrap(ownerKeyWrap), initialized: true };
  }, "CRYPTO_ROOT_INITIALIZATION_CONFLICT");
}

async function getCryptoStatus({ db, agencyId, userId, member, deviceId }) {
  const actorUserId = clean(userId, 180);
  if (!actorUserId) throw codedError("CRYPTO_ACTOR_USER_REQUIRED", "Authenticated agency user is required for crypto status", 403);
  return serializableTransaction(db, async (tx) => {
    // /crypto/status is a secret-distribution boundary: ownerWraps and
    // creatorWraps are encrypted AMK/CDK material that the requesting device
    // can decrypt. Membership, creator scope, device identity, active root and
    // wrap rows therefore have to come from one authoritative snapshot.
    const liveMember = await tx.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId: actorUserId } } });
    if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
      throw codedError("CRYPTO_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
    }
    const actorIdentity = await requireCryptoIdentityForUser({ db: tx, agencyId, userId: actorUserId, deviceId });
    const identity = actorIdentity.identity;
    const root = await tx.agencyCryptoRoot.findUnique({ where: { agencyId } });
    let ownerWrap = null;
    let ownerWraps = [];
    if (root && isOwner(liveMember)) {
      ownerWraps = await tx.agencyCryptoOwnerKeyWrap.findMany({
        where: { agencyId, deviceId: actorIdentity.id, revokedAt: null },
        orderBy: { rootVersion: "desc" },
      });
      ownerWrap = ownerWraps.find((row) => Number(row.rootVersion) === Number(root.version)) || null;
    }
    const scope = await allowedCreatorScope({ agencyId, member: liveMember, db: tx });
    const wrapWhere = { agencyId, deviceId: actorIdentity.id, revokedAt: null };
    if (!scope.broad) wrapWhere.creatorId = { in: scope.creatorIds };
    const creatorWraps = await tx.creatorDeviceKeyWrap.findMany({
      where: wrapWhere,
      orderBy: [{ creatorId: "asc" }, { keyVersion: "desc" }],
    });
    return {
      root: publicRoot(root),
      identity: publicIdentity(identity),
      ownerWrap: publicOwnerWrap(ownerWrap),
      ownerWraps: ownerWraps.map(publicOwnerWrap),
      creatorWraps: creatorWraps.map(publicCreatorWrap),
    };
  }, "CRYPTO_STATUS_READ_CONFLICT");
}


async function listCryptoDevices({ db, agencyId, userId, member }) {
  return withFreshOwnerRead({
    db, agencyId, userId, member, conflictCode: "CRYPTO_DEVICE_INVENTORY_READ_CONFLICT",
    read: (tx, liveMember) => listCryptoDevicesSnapshot({ db: tx, agencyId, member: liveMember }),
  });
}

async function listCryptoDevicesSnapshot({ db, agencyId, member }) {
  const [root, identities, creatorKeyStates, members, activeCreators] = await Promise.all([
    db.agencyCryptoRoot.findUnique({ where: { agencyId } }),
    db.deviceCryptoIdentity.findMany({
      where: { agencyId },
      orderBy: [{ status: "asc" }, { registeredAt: "asc" }],
    }),
    db.creatorCryptoKeyState.findMany({
      where: { agencyId },
      select: { creatorId: true, activeVersion: true, rootVersion: true },
    }),
    db.agencyMember.findMany({
      where: { agencyId },
      select: { userId: true, role: true, roleKey: true, assignedCreators: true, deletedAt: true, deactivatedAt: true, user: { select: { id: true, email: true, name: true } } },
    }),
    db.creatorAccount.findMany({
      where: { agencyId, deletedAt: null },
      select: { id: true },
      take: 10000,
    }),
  ]);

  const memberByUserId = new Map(members.map((row) => [String(row.userId), row]));
  const revokedDeviceIds = identities.filter((row) => row.status === "REVOKED").map((row) => row.deviceId);
  const rootExposureDeviceIds = identities.filter((identity) => {
    const agencyMember = memberByUserId.get(String(identity.userId || "")) || null;
    return identity.status !== "ACTIVE"
      || Boolean(identity.revokedAt)
      || !agencyMember
      || Boolean(agencyMember.deletedAt)
      || Boolean(agencyMember.deactivatedAt)
      || !isOwner(agencyMember);
  }).map((row) => row.deviceId);
  const [activeOwnerWraps, activeCreatorWraps, exposedOwnerHistory, revokedCreatorHistory] = await Promise.all([
    db.agencyCryptoOwnerKeyWrap.findMany({
      where: { agencyId, revokedAt: null },
      select: { deviceId: true, rootVersion: true },
    }),
    db.creatorDeviceKeyWrap.findMany({
      where: { agencyId, revokedAt: null },
      select: { deviceId: true, creatorId: true, keyVersion: true },
    }),
    rootExposureDeviceIds.length ? db.agencyCryptoOwnerKeyWrap.findMany({
      where: { agencyId, deviceId: { in: rootExposureDeviceIds } },
      select: { deviceId: true, rootVersion: true },
    }) : Promise.resolve([]),
    revokedDeviceIds.length ? db.creatorDeviceKeyWrap.findMany({
      where: { agencyId, deviceId: { in: revokedDeviceIds } },
      select: { deviceId: true, creatorId: true, keyVersion: true },
    }) : Promise.resolve([]),
  ]);

  const telemetryRows = identities.length ? await db.workerDevice.findMany({
    where: { id: { in: Array.from(new Set(identities.map((row) => row.deviceId))) } },
    select: { id: true, deviceName: true, platform: true, appVersion: true, lastSeenAt: true },
  }) : [];
  const telemetryByDeviceId = new Map(telemetryRows.map((row) => [row.id, row]));

  const activeRootVersion = Number(root?.version || 0);
  const currentOwnerDevices = new Set(activeOwnerWraps.filter((row) => Number(row.rootVersion) === activeRootVersion).map((row) => row.deviceId));
  const activeCreatorIds = activeCreators.map((row) => String(row.id)).filter(Boolean);
  const activeCreatorSet = new Set(activeCreatorIds);
  const activeKeyByCreator = new Map(creatorKeyStates
    .filter((row) => activeCreatorSet.has(String(row.creatorId || "")))
    .map((row) => [row.creatorId, { activeVersion: Number(row.activeVersion), rootVersion: Number(row.rootVersion) }]));
  const currentWrapsByDevice = new Map();
  for (const row of activeCreatorWraps) {
    const active = activeKeyByCreator.get(row.creatorId);
    if (!active || Number(row.keyVersion) !== active.activeVersion) continue;
    const set = currentWrapsByDevice.get(row.deviceId) || new Set();
    set.add(row.creatorId);
    currentWrapsByDevice.set(row.deviceId, set);
  }
  const activeRootReferences = new Set([activeRootVersion, ...[...activeKeyByCreator.values()].map((row) => Number(row.rootVersion))].filter((value) => value > 0));
  const creatorIdsByDevice = new Map();
  for (const row of activeCreatorWraps) {
    if (!activeCreatorSet.has(String(row.creatorId || ""))) continue;
    const set = creatorIdsByDevice.get(row.deviceId) || new Set();
    set.add(row.creatorId);
    creatorIdsByDevice.set(row.deviceId, set);
  }
  const pendingStrongByDevice = new Map();
  for (const row of revokedCreatorHistory) {
    const active = activeKeyByCreator.get(row.creatorId);
    if (!active || Number(row.keyVersion) !== active.activeVersion) continue;
    const set = pendingStrongByDevice.get(row.deviceId) || new Set();
    set.add(row.creatorId);
    pendingStrongByDevice.set(row.deviceId, set);
  }
  const ownerRootVersionsByDevice = new Map();
  for (const row of exposedOwnerHistory) {
    const set = ownerRootVersionsByDevice.get(row.deviceId) || new Set();
    set.add(Number(row.rootVersion));
    ownerRootVersionsByDevice.set(row.deviceId, set);
  }
  const identityByDeviceId = new Map(identities.map((row) => [row.deviceId, row]));
  const accessRevocationByDevice = new Map();
  for (const row of activeCreatorWraps) {
    const active = activeKeyByCreator.get(row.creatorId);
    if (!active || Number(row.keyVersion) !== active.activeVersion) continue;
    const identity = identityByDeviceId.get(row.deviceId);
    if (!identity || identity.status !== "ACTIVE" || identity.revokedAt) continue;
    const agencyMember = memberByUserId.get(String(identity.userId || "")) || null;
    if (agencyMember && !agencyMember.deletedAt && !agencyMember.deactivatedAt && (isOwner(agencyMember) || canAccessCreator(agencyMember, row.creatorId))) continue;
    const set = accessRevocationByDevice.get(row.deviceId) || new Set();
    set.add(row.creatorId);
    accessRevocationByDevice.set(row.deviceId, set);
  }

  return identities.map((identity) => {
    const device = telemetryByDeviceId.get(identity.deviceId) || null;
    const agencyMember = memberByUserId.get(String(identity.userId || "")) || null;
    const creatorIds = [...(creatorIdsByDevice.get(identity.deviceId) || new Set())].sort();
    const pendingStrongRotationCreatorIds = identity.status === "REVOKED"
      ? [...(pendingStrongByDevice.get(identity.deviceId) || new Set())].sort()
      : [];
    const ownerRootVersions = ownerRootVersionsByDevice.get(identity.deviceId) || new Set();
    const rootRotationRequired = [...ownerRootVersions].some((version) => activeRootReferences.has(version));
    const accessRevocationCreatorIds = identity.status === "ACTIVE"
      ? [...(accessRevocationByDevice.get(identity.deviceId) || new Set())].sort()
      : [];
    const ownerRootSyncRequired = Boolean(
      root
      && identity.status === "ACTIVE"
      && agencyMember
      && !agencyMember.deletedAt
      && !agencyMember.deactivatedAt
      && isOwner(agencyMember)
      && !currentOwnerDevices.has(identity.deviceId),
    );
    let accessGrantCreatorIds = [];
    if (root && identity.status === "ACTIVE" && agencyMember && !agencyMember.deletedAt && !agencyMember.deactivatedAt && !isOwner(agencyMember)) {
      const authorizedCreatorIds = hasBroadCreatorAccess(agencyMember)
        ? activeCreatorIds
        : assignedCreatorIds(agencyMember).filter((creatorId) => activeCreatorSet.has(creatorId));
      const currentWraps = currentWrapsByDevice.get(identity.deviceId) || new Set();
      accessGrantCreatorIds = authorizedCreatorIds.filter((creatorId) => !currentWraps.has(creatorId)).sort();
    }
    return {
      ...publicIdentity(identity),
      device: device ? {
        id: device.id,
        userId: identity.userId,
        deviceName: device.deviceName || null,
        platform: device.platform || null,
        appVersion: device.appVersion || null,
        lastSeenAt: device.lastSeenAt || null,
        user: agencyMember?.user || null,
      } : null,
      memberRole: agencyMember ? String(agencyMember.roleKey || agencyMember.role || "") : null,
      memberActive: Boolean(agencyMember && !agencyMember.deletedAt && !agencyMember.deactivatedAt),
      hasActiveOwnerRoot: currentOwnerDevices.has(identity.deviceId),
      creatorWrapCount: creatorIds.length,
      creatorIds,
      pendingStrongRotationCreatorIds,
      accessRevocationCreatorIds,
      accessRotationRequired: accessRevocationCreatorIds.length > 0,
      accessGrantCreatorIds,
      accessGrantSyncRequired: accessGrantCreatorIds.length > 0,
      ownerRootSyncRequired,
      rootRotationRequired,
    };
  });
}

async function getCryptoSecurityDebt({ db, agencyId, userId, member }) {
  return withFreshOwnerRead({
    db, agencyId, userId, member, conflictCode: "CRYPTO_SECURITY_DEBT_READ_CONFLICT",
    read: (tx) => getCryptoSecurityDebtSnapshot({ db: tx, agencyId }),
  });
}

async function getCryptoSecurityDebtSnapshot({ db, agencyId }) {
  const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  const [rootExposureDebt, untrustedCreatorExposureDebt] = await Promise.all([
    root ? findRootExposureDebt({ db, agencyId, root }) : Promise.resolve({ deviceIds: [], exposures: [] }),
    findUntrustedCreatorExposureDebt({ db, agencyId }),
  ]);
  return {
    root: publicRoot(root),
    rootExposureDeviceCount: rootExposureDebt.deviceIds.length,
    rootRotationRequired: rootExposureDebt.deviceIds.length > 0,
    untrustedCreatorExposureDeviceCount: untrustedCreatorExposureDebt.deviceIds.length,
    untrustedCreatorExposureCreatorIds: untrustedCreatorExposureDebt.creatorIds,
    untrustedCreatorRotationRequired: untrustedCreatorExposureDebt.creatorIds.length > 0,
  };
}

async function getRecoveryEnvelope({ db, agencyId, userId, member }) {
  return withFreshOwnerRead({
    db, agencyId, userId, member, conflictCode: "CRYPTO_RECOVERY_ENVELOPE_READ_CONFLICT",
    read: (tx, liveMember) => getRecoveryEnvelopeSnapshot({ db: tx, agencyId, member: liveMember }),
  });
}

async function getRecoveryEnvelopeSnapshot({ db, agencyId, member }) {
  const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  if (!root) throw codedError("CRYPTO_ROOT_NOT_INITIALIZED", "Agency encryption root is not initialized", 404);
  return {
    rootVersion: root.version,
    ciphertext: root.recoveryCiphertext,
    iv: root.recoveryIv,
    tag: root.recoveryTag,
    algorithm: root.recoveryAlgorithm,
    formatVersion: root.recoveryFormatVersion,
  };
}

async function recoverOwnerDevice({ db, agencyId, userId, member, deviceId, rootVersion, ownerWrap, recoveryProof }) {
  const actorDeviceId = clean(deviceId, 180);
  if (!actorDeviceId) throw codedError("CRYPTO_DEVICE_REQUIRED", "deviceId is required", 400);
  const wrap = normalizeWrapEnvelope(ownerWrap);
  return serializableTransaction(db, async (tx) => {
    const liveMember = await tx.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } });
    if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) throw codedError("CRYPTO_APPROVER_INACTIVE", "Agency member is no longer active", 403);
    requireOwner(liveMember);
    const root = await tx.agencyCryptoRoot.findUnique({ where: { agencyId } });
    if (!root || Number(root.version) !== Number(rootVersion)) throw codedError("CRYPTO_ROOT_VERSION_CONFLICT", "Recovery envelope is stale", 409, { current: publicRoot(root) });
    verifyRecoveryProof(root, recoveryProof);
    const identity = await tx.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, actorDeviceId) });
    if (!identity || identity.agencyId !== agencyId) throw codedError("CRYPTO_DEVICE_IDENTITY_REQUIRED", "Register this device crypto identity before recovery", 409);
    requireIdentityUser(identity, userId);
    if (identity.status === "REVOKED" || identity.revokedAt) throw codedError("CRYPTO_DEVICE_REVOKED", "This device crypto identity has been revoked", 403);
    const ownerKeyWrap = await tx.agencyCryptoOwnerKeyWrap.upsert({
      where: { agencyId_rootVersion_deviceId: { agencyId, rootVersion: root.version, deviceId: actorDeviceId } },
      create: { agencyId, rootVersion: root.version, deviceId: actorDeviceId, ...wrap, createdByDeviceId: actorDeviceId },
      update: { ...wrap, createdByDeviceId: actorDeviceId, revokedAt: null },
    });
    await tx.deviceCryptoIdentity.update({ where: cryptoIdentityWhere(agencyId, actorDeviceId), data: { status: "ACTIVE", activatedAt: identity.activatedAt || new Date(), revokedAt: null } });
    return { root: publicRoot(root), ownerWrap: publicOwnerWrap(ownerKeyWrap), recovered: true };
  }, "CRYPTO_OWNER_RECOVERY_CONFLICT");
}

async function pendingDevices({ db, agencyId, userId, member }) {
  return withFreshOwnerRead({
    db, agencyId, userId, member, conflictCode: "CRYPTO_PENDING_DEVICES_READ_CONFLICT",
    read: (tx, liveMember) => pendingDevicesSnapshot({ db: tx, agencyId, member: liveMember }),
  });
}

async function pendingDevicesSnapshot({ db, agencyId, member }) {
  const rows = await db.deviceCryptoIdentity.findMany({
    where: { agencyId, status: "PENDING" },
    orderBy: { registeredAt: "asc" },
  });
  const userIds = Array.from(new Set(rows.map((row) => String(row.userId || "")).filter(Boolean)));
  const deviceIds = Array.from(new Set(rows.map((row) => String(row.deviceId || "")).filter(Boolean)));
  const [members, telemetryRows] = await Promise.all([
    userIds.length ? db.agencyMember.findMany({
      where: { agencyId, userId: { in: userIds } },
      select: { userId: true, deletedAt: true, deactivatedAt: true, user: { select: { id: true, email: true, name: true } } },
    }) : Promise.resolve([]),
    deviceIds.length ? db.workerDevice.findMany({
      where: { id: { in: deviceIds } },
      select: { id: true, deviceName: true, platform: true, appVersion: true, lastSeenAt: true },
    }) : Promise.resolve([]),
  ]);
  const memberByUserId = new Map(members.map((row) => [String(row.userId), row]));
  const telemetryByDeviceId = new Map(telemetryRows.map((row) => [String(row.id), row]));
  return rows.map((row) => {
    const agencyMember = memberByUserId.get(String(row.userId || "")) || null;
    const device = telemetryByDeviceId.get(String(row.deviceId || "")) || null;
    return {
      ...publicIdentity(row),
      device: device ? {
        id: device.id,
        userId: row.userId,
        deviceName: device.deviceName || null,
        platform: device.platform || null,
        appVersion: device.appVersion || null,
        lastSeenAt: device.lastSeenAt || null,
        user: agencyMember?.user || null,
      } : null,
      memberActive: Boolean(agencyMember && !agencyMember.deletedAt && !agencyMember.deactivatedAt),
    };
  });
}

async function targetMemberForDevice({ db, agencyId, targetDeviceId }) {
  const identity = await db.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, targetDeviceId) });
  if (!identity) throw codedError("CRYPTO_TARGET_IDENTITY_REQUIRED", "Target device has no crypto identity in this agency", 404);
  const member = await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId: identity.userId } } });
  if (!member || member.deletedAt || member.deactivatedAt) throw codedError("CRYPTO_TARGET_MEMBER_INACTIVE", "Target crypto identity member is not active in this agency", 409);
  // WorkerDevice is mutable telemetry and may have moved to another workspace or
  // been deleted/recreated. Approval authority is the durable agency-scoped
  // crypto identity plus its immutable member binding, not the telemetry row.
  return { device: { id: identity.deviceId }, member, identity };
}


async function getDeviceApprovalPlan({ db, agencyId, userId, member, targetDeviceId }) {
  return withFreshOwnerRead({
    db, agencyId, userId, member, conflictCode: "CRYPTO_DEVICE_APPROVAL_PLAN_READ_CONFLICT",
    read: (tx, liveMember) => getDeviceApprovalPlanSnapshot({ db: tx, agencyId, member: liveMember, targetDeviceId }),
  });
}

async function getDeviceApprovalPlanSnapshot({ db, agencyId, member, targetDeviceId }) {
  const { device, member: targetMember, identity } = await targetMemberForDevice({ db, agencyId, targetDeviceId });
  if (!identity || identity.status === "REVOKED") throw codedError("CRYPTO_TARGET_IDENTITY_REQUIRED", "Target device must register a non-revoked crypto identity first", 409);
  const targetIsOwner = isOwner(targetMember);
  const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  if (!root) throw codedError("CRYPTO_ROOT_NOT_INITIALIZED", "Agency encryption root is not initialized", 409);
  let creators = [];
  if (!targetIsOwner) {
    const scope = await allowedCreatorScope({ agencyId, member: targetMember, db });
    const rows = await db.creatorAccount.findMany({
      where: { agencyId, deletedAt: null, ...(scope.broad ? {} : { id: { in: scope.creatorIds } }) },
      select: { id: true, displayName: true, username: true, cryptoKeyState: { select: { activeVersion: true, rootVersion: true } } },
      orderBy: { id: "asc" },
      take: 10000,
    });
    const existingWraps = identity.status === "ACTIVE" ? await db.creatorDeviceKeyWrap.findMany({
      where: { agencyId, deviceId: device.id, revokedAt: null },
      select: { creatorId: true, keyVersion: true },
    }) : [];
    const existingByCreator = new Map();
    for (const wrap of existingWraps) {
      const current = existingByCreator.get(wrap.creatorId) || 0;
      if (Number(wrap.keyVersion) > current) existingByCreator.set(wrap.creatorId, Number(wrap.keyVersion));
    }
    creators = rows
      .map((row) => ({ creatorId: row.id, displayName: row.displayName, username: row.username, keyVersion: Number(row.cryptoKeyState?.activeVersion || 1), rootVersion: Number(row.cryptoKeyState?.rootVersion || root.version) }))
      .filter((row) => existingByCreator.get(row.creatorId) !== row.keyVersion);
  }
  return {
    targetDeviceId: device.id,
    targetUserId: identity.userId,
    targetIsOwner,
    identity: publicIdentity(identity),
    rootVersion: Number(root.version),
    creators,
  };
}

async function approveDevice({ db, agencyId, userId, member, approverDeviceId, targetDeviceId, expectedRootVersion, actorProof, ownerWrap, creatorWraps }) {
  // Envelope syntax is safe to normalize before the transaction, but every fact
  // that authorizes key distribution is re-read inside the Serializable commit.
  // Approval plans are advisory snapshots only and may be stale by commit time.
  const expectedRoot = Math.floor(Number(expectedRootVersion));
  if (!Number.isInteger(expectedRoot) || expectedRoot < 1) {
    throw codedError("CRYPTO_APPROVAL_ROOT_VERSION_REQUIRED", "Device approval must include the root generation from the approval plan", 400);
  }
  const normalizedOwnerWrap = ownerWrap ? normalizeWrapEnvelope(ownerWrap) : null;
  const requested = Array.isArray(creatorWraps) ? creatorWraps : [];
  const normalizedCreatorWraps = [];
  const seen = new Set();
  for (const item of requested) {
    const creatorId = clean(item?.creatorId, 180);
    const keyVersion = Math.floor(Number(item?.keyVersion));
    const rootVersion = Math.floor(Number(item?.rootVersion));
    if (!creatorId || !Number.isInteger(keyVersion) || keyVersion < 1 || !Number.isInteger(rootVersion) || rootVersion < 1) {
      throw codedError("CRYPTO_CREATOR_WRAP_INVALID", "Creator key wrap must include creatorId, positive keyVersion and positive rootVersion", 400);
    }
    if (seen.has(creatorId)) throw codedError("CRYPTO_CREATOR_WRAP_DUPLICATE", "Duplicate creator key wrap", 400);
    seen.add(creatorId);
    normalizedCreatorWraps.push({ creatorId, keyVersion, rootVersion, wrap: normalizeWrapEnvelope(item.envelope) });
  }

  return serializableTransaction(db, async (tx) => {
    const approverActor = await requireOwnerCryptoCommitActor({ db: tx, agencyId, userId, member, deviceId: approverDeviceId, actorProof });
    const approver = { id: approverActor.device.id };
    const root = approverActor.root;
    if (Number(root.version) !== expectedRoot) {
      throw codedError("CRYPTO_APPROVAL_ROOT_VERSION_CONFLICT", "Agency root generation changed after the approval plan was created", 409, { currentRootVersion: Number(root.version) });
    }

    const { device: targetDevice, member: targetMember, identity: targetIdentity } = await targetMemberForDevice({ db: tx, agencyId, targetDeviceId });
    if (!targetIdentity || targetIdentity.status === "REVOKED" || targetIdentity.revokedAt) {
      throw codedError("CRYPTO_TARGET_IDENTITY_REQUIRED", "Target device must register a non-revoked crypto identity first", 409);
    }

    const targetIsOwner = isOwner(targetMember);
    if (targetIsOwner) {
      if (!normalizedOwnerWrap) throw codedError("CRYPTO_OWNER_WRAP_REQUIRED", "Owner devices require an Agency Master Key wrap", 400);
      if (normalizedCreatorWraps.length) {
        throw codedError("CRYPTO_OWNER_CREATOR_WRAPS_FORBIDDEN", "Owner devices receive the Agency Master Key and must not receive redundant per-creator key wraps", 400);
      }
    } else if (normalizedOwnerWrap) {
      throw codedError("CRYPTO_OWNER_WRAP_FORBIDDEN", "Non-owner devices must never receive the Agency Master Key", 400);
    }

    // Recompute the exact current provisioning debt from fresh membership,
    // creator generations and target wraps. This makes an approval plan a CAS-like
    // intent: if role/access/key state changed, the old plan cannot partially commit.
    const expectedByCreator = new Map();
    if (!targetIsOwner) {
      const scope = await allowedCreatorScope({ agencyId, member: targetMember, db: tx });
      const creatorRows = await tx.creatorAccount.findMany({
        where: { agencyId, deletedAt: null, ...(scope.broad ? {} : { id: { in: scope.creatorIds } }) },
        select: { id: true, cryptoKeyState: { select: { activeVersion: true, rootVersion: true } } },
        orderBy: { id: "asc" },
        take: 10000,
      });
      const existingWraps = await tx.creatorDeviceKeyWrap.findMany({
        where: { agencyId, deviceId: targetDevice.id, revokedAt: null },
        select: { creatorId: true, keyVersion: true },
      });
      const existingByCreator = new Map();
      for (const wrap of existingWraps) {
        const current = existingByCreator.get(wrap.creatorId) || 0;
        if (Number(wrap.keyVersion) > current) existingByCreator.set(wrap.creatorId, Number(wrap.keyVersion));
      }
      for (const creator of creatorRows) {
        const keyVersion = Number(creator.cryptoKeyState?.activeVersion || 1);
        const creatorRootVersion = Number(creator.cryptoKeyState?.rootVersion || root.version);
        if (existingByCreator.get(creator.id) === keyVersion) continue;
        expectedByCreator.set(creator.id, { keyVersion, rootVersion: creatorRootVersion });
      }
    }

    if (!targetIsOwner) {
      const requestedIds = normalizedCreatorWraps.map((item) => item.creatorId).sort();
      const expectedIds = [...expectedByCreator.keys()].sort();
      if (requestedIds.length !== expectedIds.length || requestedIds.some((id, index) => id !== expectedIds[index])) {
        throw codedError(
          "CRYPTO_APPROVAL_PLAN_STALE",
          "Target creator access or enrollment changed after the approval plan was created; refresh the plan and retry",
          409,
          { expectedCreatorIds: expectedIds },
        );
      }
      for (const item of normalizedCreatorWraps) {
        const expected = expectedByCreator.get(item.creatorId);
        if (!expected) {
          throw codedError("CRYPTO_CREATOR_WRAP_SCOPE_FORBIDDEN", "Target member does not currently require this creator key wrap", 403, { creatorId: item.creatorId });
        }
        if (item.keyVersion !== expected.keyVersion || item.rootVersion !== expected.rootVersion) {
          throw codedError(
            "CRYPTO_CREATOR_KEY_VERSION_CONFLICT",
            "Creator key/root generation changed before device approval",
            409,
            { creatorId: item.creatorId, currentVersion: expected.keyVersion, currentRootVersion: expected.rootVersion },
          );
        }
      }
    }

    if (targetIsOwner) {
      await tx.agencyCryptoOwnerKeyWrap.upsert({
        where: { agencyId_rootVersion_deviceId: { agencyId, rootVersion: root.version, deviceId: targetDevice.id } },
        create: { agencyId, rootVersion: root.version, deviceId: targetDevice.id, ...normalizedOwnerWrap, createdByDeviceId: approver.id },
        update: { ...normalizedOwnerWrap, createdByDeviceId: approver.id, revokedAt: null },
      });
      await tx.creatorDeviceKeyWrap.updateMany({
        where: { agencyId, deviceId: targetDevice.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    for (const item of normalizedCreatorWraps) {
      const state = await tx.creatorCryptoKeyState.upsert({
        where: { agencyId_creatorId: { agencyId, creatorId: item.creatorId } },
        create: { agencyId, creatorId: item.creatorId, activeVersion: item.keyVersion, rootVersion: item.rootVersion },
        update: {},
      });
      if (Number(state.activeVersion) !== item.keyVersion || Number(state.rootVersion) !== item.rootVersion) {
        throw codedError("CRYPTO_CREATOR_KEY_VERSION_CONFLICT", "Creator key/root generation is stale", 409, { creatorId: item.creatorId, currentVersion: state.activeVersion, currentRootVersion: state.rootVersion });
      }
      await tx.creatorDeviceKeyWrap.upsert({
        where: { agencyId_creatorId_keyVersion_deviceId: { agencyId, creatorId: item.creatorId, keyVersion: item.keyVersion, deviceId: targetDevice.id } },
        create: { agencyId, creatorId: item.creatorId, keyVersion: item.keyVersion, deviceId: targetDevice.id, ...item.wrap, createdByDeviceId: approver.id },
        update: { ...item.wrap, createdByDeviceId: approver.id, revokedAt: null },
      });
    }

    await tx.deviceCryptoIdentity.update({
      where: cryptoIdentityWhere(agencyId, targetDevice.id),
      data: { status: "ACTIVE", activatedAt: targetIdentity.activatedAt || new Date(), revokedAt: null },
    });
    return { approved: true, targetDeviceId: targetDevice.id, targetIsOwner, creatorWrapCount: normalizedCreatorWraps.length, rootVersion: root.version };
  }, "CRYPTO_DEVICE_APPROVAL_WRITE_CONFLICT");
}


async function ownerCanUseRootVersion({ db, agencyId, deviceId, requiredRootVersion, activeRoot }) {
  const required = Math.floor(Number(requiredRootVersion));
  if (!Number.isInteger(required) || required < 1) return { allowed: false, mode: null };

  const directWrap = await db.agencyCryptoOwnerKeyWrap.findFirst({
    where: { agencyId, rootVersion: required, deviceId, revokedAt: null },
    select: { id: true },
  });
  if (directWrap) return { allowed: true, mode: "DIRECT" };

  const currentRootVersion = Math.floor(Number(activeRoot?.version));
  if (!activeRoot || activeRoot.status !== "ACTIVE" || !Number.isInteger(currentRootVersion) || currentRootVersion <= required) {
    return { allowed: false, mode: null };
  }

  const currentWrap = await db.agencyCryptoOwnerKeyWrap.findFirst({
    where: { agencyId, rootVersion: currentRootVersion, deviceId, revokedAt: null },
    select: { id: true },
  });
  if (!currentWrap) return { allowed: false, mode: null };

  const bridge = await db.agencyCryptoRootBridge.findFirst({
    where: { agencyId, fromVersion: required, toVersion: currentRootVersion, retiredAt: null },
    select: { id: true },
  });
  return bridge ? { allowed: true, mode: "CURRENT_WITH_BRIDGE" } : { allowed: false, mode: null };
}

async function requireLiveCryptoCreator({ db, agencyId, creatorId }) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) throw codedError("CRYPTO_CREATOR_REMOVED", "Creator encryption state is historical because the creator was removed", 409, { creatorId });
  return creator;
}

async function getCreatorKeyState({ db, agencyId, creatorId, deviceId, member, userId }) {
  const liveMember = userId ? await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } }) : member;
  if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) throw codedError("CRYPTO_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  if (!isOwner(liveMember) && !canAccessCreator(liveMember, creatorId)) throw codedError("CRYPTO_CREATOR_ACCESS_REVOKED", "This member no longer has access to the creator encryption key", 403, { creatorId });
  await requireLiveCryptoCreator({ db, agencyId, creatorId });
  const state = await db.creatorCryptoKeyState.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
  const activeVersion = Number(state?.activeVersion || 1);
  const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  const rootVersion = Number(state?.rootVersion || root?.version || 1);
  const identity = await db.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, deviceId) });
  let enrolled = false;
  if (identity) requireIdentityUser(identity, userId || liveMember?.userId);
  if (identity && identity.agencyId === agencyId && identity.status === "ACTIVE" && !identity.revokedAt) {
    if (isOwner(liveMember)) {
      if (root) {
        const access = await ownerCanUseRootVersion({ db, agencyId, deviceId, requiredRootVersion: rootVersion, activeRoot: root });
        enrolled = access.allowed;
      }
    } else if (state) {
      enrolled = Boolean(await db.creatorDeviceKeyWrap.findFirst({ where: { agencyId, creatorId, keyVersion: activeVersion, deviceId, revokedAt: null }, select: { id: true } }));
    }
  }
  return { creatorId, activeVersion, rootVersion, initialized: Boolean(state), enrolled };
}

async function assertDeviceCanUseCreatorKey({ db, agencyId, creatorId, keyVersion, deviceId, member }) {
  const version = Math.floor(Number(keyVersion));
  if (!Number.isInteger(version) || version < 1) throw codedError("CRYPTO_CREATOR_KEY_VERSION_INVALID", "Creator key version must be positive", 400);
  const liveMember = member?.userId ? await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId: member.userId } } }) : member;
  if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) throw codedError("CRYPTO_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  if (!isOwner(liveMember) && !canAccessCreator(liveMember, creatorId)) throw codedError("CRYPTO_CREATOR_ACCESS_REVOKED", "This member no longer has access to the creator encryption key", 403, { creatorId });
  await requireLiveCryptoCreator({ db, agencyId, creatorId });
  const identity = await db.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, deviceId) });
  if (!identity || identity.agencyId !== agencyId || identity.status !== "ACTIVE" || identity.revokedAt) {
    throw codedError("CRYPTO_DEVICE_NOT_ENROLLED", "This device is not enrolled for client-side creator encryption", 403);
  }
  requireIdentityUser(identity, liveMember?.userId);
  const state = await db.creatorCryptoKeyState.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
  const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  if (!state || Number(state.activeVersion) !== version) {
    throw codedError("CRYPTO_CREATOR_KEY_VERSION_CONFLICT", "Creator encryption key version is stale or not initialized", 409, { creatorId, currentVersion: state?.activeVersion || null });
  }
  if (isOwner(liveMember)) {
    if (!root) throw codedError("CRYPTO_ROOT_NOT_INITIALIZED", "Agency encryption root is not initialized", 409);
    const ownerRootAccess = await ownerCanUseRootVersion({
      db,
      agencyId,
      deviceId,
      requiredRootVersion: Number(state.rootVersion || root.version),
      activeRoot: root,
    });
    if (!ownerRootAccess.allowed) throw codedError("CRYPTO_OWNER_KEY_NOT_ENROLLED", "This owner device cannot reach the Agency Master Key generation required by this creator", 403);
    return { identity, state, owner: true, root, ownerRootAccessMode: ownerRootAccess.mode };
  }
  const creatorWrap = await db.creatorDeviceKeyWrap.findFirst({ where: { agencyId, creatorId, keyVersion: version, deviceId, revokedAt: null } });
  if (!creatorWrap) throw codedError("CRYPTO_CREATOR_KEY_NOT_ENROLLED", "This device is not enrolled for the creator encryption key", 403);
  return { identity, state, owner: false, creatorWrap };
}


async function requireOwnerCryptoActor({ db, agencyId, userId, member, deviceId }) {
  // Destructive crypto operations may run after the HTTP middleware loaded its
  // membership snapshot. Re-read membership from the same transaction/client
  // that will commit the key mutation so OWNER authority cannot race demotion,
  // deactivation or removal.
  const liveMember = userId
    ? await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } })
    : member;
  if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
    throw codedError("CRYPTO_APPROVER_INACTIVE", "Agency member is no longer active", 403);
  }
  requireOwner(liveMember);
  const actorIdentity = await requireCryptoIdentityForUser({ db, agencyId, userId, deviceId, requireActive: true });
  const identity = actorIdentity.identity;
  const root = await db.agencyCryptoRoot.findUnique({ where: { agencyId } });
  if (!root || root.status !== "ACTIVE") throw codedError("CRYPTO_ROOT_NOT_ACTIVE", "Agency encryption root is not active", 409);
  const ownerWrap = await db.agencyCryptoOwnerKeyWrap.findFirst({
    where: { agencyId, rootVersion: root.version, deviceId: actorIdentity.id, revokedAt: null },
    select: { id: true },
  });
  if (!ownerWrap) throw codedError("CRYPTO_OWNER_KEY_NOT_ENROLLED", "This owner device does not hold the active Agency Master Key", 403);
  return { device: { id: actorIdentity.id }, identity, root, member: liveMember };
}

async function requireOwnerCryptoCommitActor({ db, agencyId, userId, member, deviceId, actorProof }) {
  const actor = await requireOwnerCryptoActor({ db, agencyId, userId, member, deviceId });
  if (!clean(actorProof, 256)) {
    throw codedError("CRYPTO_ACTOR_PROOF_REQUIRED", "Destructive encryption management requires possession of the active Agency Master Key", 403);
  }
  verifyActorProof(actor.root, actorProof);
  return actor;
}

async function withFreshOwnerCryptoRead({ db, agencyId, userId, member, deviceId, read, conflictCode = "CRYPTO_OWNER_SECRET_READ_CONFLICT" }) {
  const actorUserId = clean(userId, 180);
  if (!actorUserId) throw codedError("CRYPTO_ACTOR_USER_REQUIRED", "Authenticated agency user is required for owner crypto secret reads", 403);
  return serializableTransaction(db, async (tx) => {
    const actor = await requireOwnerCryptoActor({ db: tx, agencyId, userId: actorUserId, member, deviceId });
    return read(tx, actor);
  }, conflictCode);
}

async function initializeCreatorKeyState({ db, agencyId, creatorId, userId, member, deviceId, actorProof }) {
  const id = clean(creatorId, 180);
  if (!id) throw codedError("CREATOR_ID_REQUIRED", "creatorId is required", 400);
  return serializableTransaction(db, async (tx) => {
    const actor = await requireOwnerCryptoCommitActor({ db: tx, agencyId, userId, member, deviceId, actorProof });
    const creator = await tx.creatorAccount.findFirst({
      where: { id, agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!creator) throw codedError("CREATOR_NOT_FOUND", "Creator not found", 404);

    let state = await tx.creatorCryptoKeyState.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId: id } } });
    const created = !state;
    if (!state) {
      // Native upsert keeps first-key bootstrap idempotent under concurrent
      // encryptors while Serializable fencing prevents a stale root generation
      // from being committed across a simultaneous AMK rotation. Never rewrite
      // an already initialized creator onto the current root here.
      state = await tx.creatorCryptoKeyState.upsert({
        where: { agencyId_creatorId: { agencyId, creatorId: id } },
        create: { agencyId, creatorId: id, activeVersion: 1, rootVersion: Number(actor.root.version) },
        update: {},
      });
    }

    const ownerRootAccess = await ownerCanUseRootVersion({
      db: tx,
      agencyId,
      deviceId: actor.device.id,
      requiredRootVersion: Number(state.rootVersion),
      activeRoot: actor.root,
    });
    if (!ownerRootAccess.allowed) {
      throw codedError("CRYPTO_OWNER_KEY_NOT_ENROLLED", "This owner device cannot reach the Agency Master Key generation required by this creator", 403);
    }

    return {
      created,
      state: {
        creatorId: id,
        activeVersion: Number(state.activeVersion),
        rootVersion: Number(state.rootVersion),
        initialized: true,
        enrolled: true,
      },
    };
  }, "CRYPTO_CREATOR_KEY_INITIALIZATION_CONFLICT");
}

async function activeNonOwnerDeviceIdentitiesForCreator({ db, agencyId, creatorId }) {
  const members = await db.agencyMember.findMany({
    where: { agencyId, deletedAt: null, deactivatedAt: null },
    select: { userId: true, role: true, roleKey: true, assignedCreators: true },
  });
  const eligibleUsers = new Set(
    members
      .filter((member) => !isOwner(member) && canAccessCreator(member, creatorId))
      .map((member) => String(member.userId)),
  );
  if (!eligibleUsers.size) return [];
  const identities = await db.deviceCryptoIdentity.findMany({
    where: { agencyId, status: "ACTIVE", revokedAt: null },
    orderBy: { deviceId: "asc" },
  });
  return identities
    .filter((identity) => eligibleUsers.has(String(identity.userId)))
    .map((identity) => ({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
    }));
}


async function activeOwnerDeviceIdentities({ db, agencyId }) {
  const members = await db.agencyMember.findMany({
    where: { agencyId, deletedAt: null, deactivatedAt: null },
    select: { userId: true, role: true, roleKey: true, assignedCreators: true },
  });
  const ownerUsers = new Set(members.filter((member) => isOwner(member)).map((member) => String(member.userId)));
  if (!ownerUsers.size) return [];
  const identities = await db.deviceCryptoIdentity.findMany({
    where: { agencyId, status: "ACTIVE", revokedAt: null },
    orderBy: { deviceId: "asc" },
  });
  return identities
    .filter((identity) => ownerUsers.has(String(identity.userId)))
    .map((identity) => ({ deviceId: identity.deviceId, publicKey: identity.publicKey, fingerprint: identity.fingerprint }));
}

function sessionRotationProjection(row) {
  if (!row || row.status !== "ACTIVE" || !row.encryptedPayload) return null;
  if (String(row.encryptionMode || "") !== "CLIENT_E2E_V1" || !row.keyVersion) {
    throw codedError("CRYPTO_ROTATION_REQUIRES_OPAQUE_SECRETS", "Creator session is not a valid client-side encrypted envelope", 409);
  }
  return {
    revision: Number(row.revision),
    payloadVersion: Number(row.payloadVersion || 1),
    keyVersion: Number(row.keyVersion),
    opaquePayload: {
      encryptionMode: "CLIENT_E2E_V1",
      keyVersion: Number(row.keyVersion),
      algorithm: row.algorithm,
      ciphertext: row.encryptedPayload,
      iv: row.iv,
      tag: row.tag,
    },
  };
}

function proxyRotationProjection(proxy, profile) {
  if (!proxy || !proxy.hasCredentials) return null;
  if (String(proxy.encryptionMode || "") !== "CLIENT_E2E_V1" || !proxy.keyVersion) {
    throw codedError("CRYPTO_ROTATION_REQUIRES_OPAQUE_SECRETS", "Proxy credentials are not a valid client-side encrypted envelope", 409);
  }
  const active = Boolean(profile && profile.mode === "PROXY" && profile.proxyEndpointId === proxy.id);
  return {
    proxyId: proxy.id,
    proxyVersion: Number(proxy.version),
    profileVersion: Number(profile?.version || 0),
    active,
    keyVersion: Number(proxy.keyVersion),
    usernameHint: proxy.usernameHint || null,
    opaqueCredentials: {
      encryptionMode: "CLIENT_E2E_V1",
      keyVersion: Number(proxy.keyVersion),
      algorithm: proxy.algorithm,
      ciphertext: proxy.encryptedPayload,
      iv: proxy.iv,
      tag: proxy.tag,
    },
  };
}

async function buildDeviceRevocationPlan({ db, agencyId, targetDeviceId }) {
  const target = await db.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, targetDeviceId) });
  if (!target || target.agencyId !== agencyId) throw codedError("CRYPTO_TARGET_DEVICE_NOT_FOUND", "Target crypto device was not found", 404);
  const [root, activeCreatorIds] = await Promise.all([
    db.agencyCryptoRoot.findUnique({ where: { agencyId } }),
    activeCryptoCreatorIds({ db, agencyId }),
  ]);
  const activeCreatorSet = new Set(activeCreatorIds);
  const targetOwnerWraps = await db.agencyCryptoOwnerKeyWrap.findMany({
    where: { agencyId, deviceId: targetDeviceId },
    select: { rootVersion: true, revokedAt: true },
  });
  const targetRootVersions = new Set(targetOwnerWraps.map((row) => Number(row.rootVersion)));
  const rootReferenced = targetRootVersions.size && activeCreatorIds.length ? await db.creatorCryptoKeyState.findFirst({
    where: { agencyId, creatorId: { in: activeCreatorIds }, rootVersion: { in: Array.from(targetRootVersions) } },
    select: { id: true, rootVersion: true },
  }) : null;
  const targetHadOwnerRoot = Boolean(
    targetRootVersions.size
    && (rootReferenced || (root && targetRootVersions.has(Number(root.version)))),
  );
  const wraps = await db.creatorDeviceKeyWrap.findMany({
    where: { agencyId, deviceId: targetDeviceId },
    select: { creatorId: true, keyVersion: true },
  });
  const creatorIds = Array.from(new Set(wraps.map((row) => row.creatorId).filter((creatorId) => activeCreatorSet.has(String(creatorId || "")))));
  const states = creatorIds.length ? await db.creatorCryptoKeyState.findMany({
    where: { agencyId, creatorId: { in: creatorIds } },
    select: { creatorId: true, activeVersion: true },
  }) : [];
  const activeByCreator = new Map(states.map((row) => [row.creatorId, Number(row.activeVersion)]));
  const affectedCreatorIds = Array.from(new Set(
    wraps
      .filter((row) => activeByCreator.get(row.creatorId) === Number(row.keyVersion))
      .map((row) => row.creatorId),
  )).sort();
  return {
    targetDeviceId,
    targetHadOwnerRoot,
    affectedCreatorIds,
    rootRotationRequired: targetHadOwnerRoot,
    compromisedRootVersions: Array.from(targetRootVersions).sort((a, b) => a - b),
  };
}

async function getDeviceRevocationPlan({ db, agencyId, userId, member, actorDeviceId, targetDeviceId }) {
  return withFreshOwnerCryptoRead({
    db, agencyId, userId, member, deviceId: actorDeviceId, conflictCode: "CRYPTO_DEVICE_REVOCATION_PLAN_READ_CONFLICT",
    read: async (tx) => buildDeviceRevocationPlan({ db: tx, agencyId, targetDeviceId }),
  });
}

async function getRootRotationPlan({ db, agencyId, userId, member, actorDeviceId }) {
  return withFreshOwnerCryptoRead({
    db, agencyId, userId, member, deviceId: actorDeviceId, conflictCode: "CRYPTO_ROOT_ROTATION_PLAN_READ_CONFLICT",
    read: async (tx, actor) => {
      const [devices, activeCreatorIds] = await Promise.all([
        activeOwnerDeviceIdentities({ db: tx, agencyId }),
        activeCryptoCreatorIds({ db: tx, agencyId }),
      ]);
      const pendingCreatorCount = activeCreatorIds.length ? await tx.creatorCryptoKeyState.count({
        where: { agencyId, creatorId: { in: activeCreatorIds }, rootVersion: { not: actor.root.version } },
      }) : 0;
      return {
        currentRootVersion: Number(actor.root.version),
        nextRootVersion: Number(actor.root.version) + 1,
        devices,
        pendingCreatorCount,
      };
    },
  });
}

function normalizeRootOwnerWraps(input, expectedDevices) {
  const requested = Array.isArray(input) ? input : [];
  const expected = new Map(expectedDevices.map((row) => [row.deviceId, row]));
  const seen = new Set();
  const normalized = [];
  for (const item of requested) {
    const deviceId = clean(item?.deviceId, 180);
    if (!deviceId || seen.has(deviceId) || !expected.has(deviceId)) {
      throw codedError("CRYPTO_ROOT_ROTATION_OWNER_WRAP_SCOPE_INVALID", "Root key wraps do not match the active owner-device scope", 409);
    }
    seen.add(deviceId);
    normalized.push({ deviceId, wrap: normalizeWrapEnvelope(item.envelope) });
  }
  if (seen.size !== expected.size) throw codedError("CRYPTO_ROOT_ROTATION_OWNER_WRAP_SET_INCOMPLETE", "A new root key wrap is required for every active owner device", 409);
  return normalized;
}

async function beginRootRotation({ db, agencyId, userId, member, actorDeviceId, actorProof, expectedRootVersion, recoveryEnvelope, recoveryProof, rootBridge, ownerWraps }) {
  const expected = Math.floor(Number(expectedRootVersion));
  if (!Number.isInteger(expected) || expected < 1) throw codedError("CRYPTO_ROOT_VERSION_INVALID", "expectedRootVersion must be positive", 400);
  const recovery = normalizeRecoveryEnvelope(recoveryEnvelope);
  const nextRecoveryProofHash = recoveryProofHash(recoveryProof);
  const bridge = normalizeRootBridgeEnvelope(rootBridge);
  return serializableTransaction(db, async (tx) => {
    const actor = await requireOwnerCryptoCommitActor({ db: tx, agencyId, userId, member, deviceId: actorDeviceId, actorProof });
    if (Number(actor.root.version) !== expected) throw codedError("CRYPTO_ROOT_VERSION_CONFLICT", "Agency root generation changed before rotation", 409, { currentVersion: actor.root.version });
    const activeCreatorIds = await activeCryptoCreatorIds({ db: tx, agencyId });
    const [pendingFromPreviousRotation, previousBridge] = await Promise.all([
      activeCreatorIds.length
        ? tx.creatorCryptoKeyState.count({ where: { agencyId, creatorId: { in: activeCreatorIds }, rootVersion: { not: expected } } })
        : Promise.resolve(0),
      tx.agencyCryptoRootBridge.findFirst({ where: { agencyId, toVersion: expected, retiredAt: null }, select: { id: true } }),
    ]);
    if (pendingFromPreviousRotation > 0 || previousBridge) {
      throw codedError("CRYPTO_ROOT_ROTATION_ALREADY_IN_PROGRESS", "Finish and finalize the existing Agency Master Key rotation before starting another generation", 409, { pendingCreatorCount: pendingFromPreviousRotation });
    }
    const devices = await activeOwnerDeviceIdentities({ db: tx, agencyId });
    const wraps = normalizeRootOwnerWraps(ownerWraps, devices);
    const nextRootVersion = expected + 1;
    for (const item of wraps) {
      await tx.agencyCryptoOwnerKeyWrap.upsert({
        where: { agencyId_rootVersion_deviceId: { agencyId, rootVersion: nextRootVersion, deviceId: item.deviceId } },
        create: { agencyId, rootVersion: nextRootVersion, deviceId: item.deviceId, ...item.wrap, createdByDeviceId: actor.device.id },
        update: { ...item.wrap, createdByDeviceId: actor.device.id, revokedAt: null },
      });
    }
    await tx.agencyCryptoRootBridge.upsert({
      where: { agencyId_fromVersion_toVersion: { agencyId, fromVersion: expected, toVersion: nextRootVersion } },
      create: { agencyId, fromVersion: expected, toVersion: nextRootVersion, ...bridge, createdByDeviceId: actor.device.id },
      update: { ...bridge, createdByDeviceId: actor.device.id, retiredAt: null },
    });
    const updated = await tx.agencyCryptoRoot.updateMany({
      where: { agencyId, version: expected, status: "ACTIVE" },
      data: {
        version: nextRootVersion,
        recoveryCiphertext: recovery.ciphertext,
        recoveryIv: recovery.iv,
        recoveryTag: recovery.tag,
        recoveryAlgorithm: recovery.algorithm,
        recoveryFormatVersion: recovery.formatVersion,
        recoveryProofHash: nextRecoveryProofHash,
      },
    });
    if (updated.count !== 1) throw codedError("CRYPTO_ROOT_VERSION_CONFLICT", "Agency root generation changed concurrently", 409);
    const pendingCreatorIds = activeCreatorIds.length ? (await tx.creatorCryptoKeyState.findMany({
      where: { agencyId, creatorId: { in: activeCreatorIds }, rootVersion: { not: nextRootVersion } },
      select: { creatorId: true },
      orderBy: { creatorId: "asc" },
      take: 10000,
    })).map((row) => row.creatorId) : [];
    return {
      started: true,
      previousRootVersion: expected,
      activeRootVersion: nextRootVersion,
      pendingCreatorIds,
      ownerWrapCount: wraps.length,
    };
  }, "CRYPTO_ROOT_ROTATION_WRITE_CONFLICT");
}

async function getRootRotationBridge({ db, agencyId, userId, member, actorDeviceId, fromVersion }) {
  const from = Math.floor(Number(fromVersion));
  if (!Number.isInteger(from) || from < 1) throw codedError("CRYPTO_ROOT_VERSION_INVALID", "fromVersion must be positive", 400);
  return withFreshOwnerCryptoRead({
    db, agencyId, userId, member, deviceId: actorDeviceId, conflictCode: "CRYPTO_ROOT_BRIDGE_READ_CONFLICT",
    read: async (tx, actor) => {
      const activeRootVersion = Number(actor.root.version);
      if (from >= activeRootVersion) throw codedError("CRYPTO_ROOT_BRIDGE_DIRECTION_INVALID", "Root bridge only supports recovery from the active root to an older root generation", 400);
      const row = await tx.agencyCryptoRootBridge.findUnique({
        where: { agencyId_fromVersion_toVersion: { agencyId, fromVersion: from, toVersion: activeRootVersion } },
      });
      if (!row || row.retiredAt) throw codedError("CRYPTO_ROOT_BRIDGE_NOT_AVAILABLE", "The requested previous root generation is not available for this active root rotation", 404);
      return {
        fromVersion: Number(row.fromVersion),
        toVersion: Number(row.toVersion),
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
        algorithm: row.algorithm,
      };
    },
  });
}

async function getRootRotationProgress({ db, agencyId, userId, member, actorDeviceId }) {
  return withFreshOwnerCryptoRead({
    db, agencyId, userId, member, deviceId: actorDeviceId, conflictCode: "CRYPTO_ROOT_ROTATION_PROGRESS_READ_CONFLICT",
    read: async (tx, actor) => {
      const activeCreatorIds = await activeCryptoCreatorIds({ db: tx, agencyId });
      const [states, activeBridge] = await Promise.all([
        activeCreatorIds.length ? tx.creatorCryptoKeyState.findMany({
          where: { agencyId, creatorId: { in: activeCreatorIds }, rootVersion: { not: actor.root.version } },
          select: { creatorId: true },
          orderBy: { creatorId: "asc" },
          take: 10000,
        }) : Promise.resolve([]),
        tx.agencyCryptoRootBridge.findFirst({
          where: { agencyId, toVersion: actor.root.version, retiredAt: null },
          select: { fromVersion: true, toVersion: true },
        }),
      ]);
      const pendingCreatorIds = states.map((row) => row.creatorId);
      return {
        activeRootVersion: Number(actor.root.version),
        previousRootVersion: activeBridge ? Number(activeBridge.fromVersion) : null,
        inProgress: Boolean(activeBridge),
        pendingCreatorIds,
        complete: Boolean(activeBridge) && pendingCreatorIds.length === 0,
      };
    },
  });
}

async function finalizeRootRotation({ db, agencyId, userId, member, actorDeviceId, actorProof }) {
  return serializableTransaction(db, async (tx) => {
    const actor = await requireOwnerCryptoCommitActor({ db: tx, agencyId, userId, member, deviceId: actorDeviceId, actorProof });
    const activeCreatorIds = await activeCryptoCreatorIds({ db: tx, agencyId });
    const pending = activeCreatorIds.length ? await tx.creatorCryptoKeyState.count({
      where: { agencyId, creatorId: { in: activeCreatorIds }, rootVersion: { not: actor.root.version } },
    }) : 0;
    if (pending > 0) throw codedError("CRYPTO_ROOT_ROTATION_INCOMPLETE", "Some creators still use a previous Agency Master Key generation", 409, { pendingCreatorCount: pending });
    const now = new Date();
    const retired = await tx.agencyCryptoOwnerKeyWrap.updateMany({
      where: { agencyId, rootVersion: { lt: actor.root.version }, revokedAt: null },
      data: { revokedAt: now },
    });
    const retiredBridges = await tx.agencyCryptoRootBridge.updateMany({
      where: { agencyId, toVersion: { lte: actor.root.version }, retiredAt: null },
      data: { retiredAt: now },
    });
    return { finalized: true, activeRootVersion: Number(actor.root.version), retiredOwnerWrapCount: retired.count, retiredRootBridgeCount: retiredBridges.count };
  }, "CRYPTO_ROOT_ROTATION_WRITE_CONFLICT");
}


async function getCreatorRotationPlan({ db, agencyId, userId, member, actorDeviceId, creatorId }) {
  return withFreshOwnerCryptoRead({
    db, agencyId, userId, member, deviceId: actorDeviceId, conflictCode: "CRYPTO_CREATOR_ROTATION_PLAN_READ_CONFLICT",
    read: async (tx, actor) => {
      const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, select: { id: true, displayName: true, username: true } });
      if (!creator) throw codedError("CREATOR_NOT_FOUND", "Creator not found", 404);
      const state = await tx.creatorCryptoKeyState.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
      if (!state) throw codedError("CRYPTO_CREATOR_KEY_NOT_INITIALIZED", "Creator encryption key is not initialized", 409);
      const currentKeyVersion = Number(state.activeVersion);
      const currentRootVersion = Number(state.rootVersion || actor.root.version);
      const targetRootVersion = Number(actor.root.version);
      const [session, proxy, profile, devices] = await Promise.all([
        tx.creatorSessionState.findUnique({ where: { creatorId } }),
        tx.agencyProxyEndpoint.findFirst({ where: { agencyId, ownerCreatorId: creatorId } }),
        tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } }),
        activeNonOwnerDeviceIdentitiesForCreator({ db: tx, agencyId, creatorId }),
      ]);
      const sessionProjection = sessionRotationProjection(session);
      const proxyProjection = proxyRotationProjection(proxy, profile);
      if (sessionProjection && sessionProjection.keyVersion !== currentKeyVersion) throw codedError("CRYPTO_ROTATION_STATE_INCONSISTENT", "Creator session key generation does not match the active creator key", 409);
      if (proxyProjection && proxyProjection.keyVersion !== currentKeyVersion) throw codedError("CRYPTO_ROTATION_STATE_INCONSISTENT", "Proxy credential key generation does not match the active creator key", 409);
      return { creator, currentKeyVersion, nextKeyVersion: currentKeyVersion + 1, currentRootVersion, targetRootVersion, session: sessionProjection, proxy: proxyProjection, devices };
    },
  });
}

function normalizeRotationDeviceWraps(input, { agencyId, creatorId, nextKeyVersion, expectedDevices }) {
  const requested = Array.isArray(input) ? input : [];
  const expected = new Map(expectedDevices.map((row) => [row.deviceId, row]));
  const seen = new Set();
  const normalized = [];
  for (const item of requested) {
    const deviceId = clean(item?.deviceId, 180);
    if (!deviceId || seen.has(deviceId) || !expected.has(deviceId)) {
      throw codedError("CRYPTO_ROTATION_DEVICE_WRAP_SCOPE_INVALID", "Creator key wraps do not match the active device scope", 409);
    }
    seen.add(deviceId);
    normalized.push({
      deviceId,
      wrap: normalizeWrapEnvelope(item.envelope),
      context: { agencyId, creatorId, keyVersion: nextKeyVersion },
    });
  }
  if (seen.size !== expected.size) throw codedError("CRYPTO_ROTATION_DEVICE_WRAP_SET_INCOMPLETE", "A new creator key wrap is required for every active non-owner device", 409);
  return normalized;
}

async function commitCreatorKeyRotation({
  db, agencyId, userId, member, actorDeviceId, creatorId, expectedKeyVersion, expectedCurrentRootVersion, expectedTargetRootVersion,
  session: sessionInput, proxy: proxyInput, deviceWraps, actorProof,
}) {
  const expectedVersion = Math.floor(Number(expectedKeyVersion));
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw codedError("CRYPTO_ROTATION_VERSION_INVALID", "expectedKeyVersion must be positive", 400);
  const currentRootVersion = Math.floor(Number(expectedCurrentRootVersion));
  const targetRootVersion = Math.floor(Number(expectedTargetRootVersion));
  if (!Number.isInteger(currentRootVersion) || currentRootVersion < 1 || !Number.isInteger(targetRootVersion) || targetRootVersion < 1) {
    throw codedError("CRYPTO_ROTATION_ROOT_VERSION_INVALID", "Creator rotation requires valid current and target root versions", 400);
  }
  const nextKeyVersion = expectedVersion + 1;
  return serializableTransaction(db, async (tx) => {
    const actor = await requireOwnerCryptoCommitActor({ db: tx, agencyId, userId, member, deviceId: actorDeviceId, actorProof });
    const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, select: { id: true } });
    if (!creator) throw codedError("CREATOR_NOT_FOUND", "Creator not found", 404);
    const state = await tx.creatorCryptoKeyState.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    if (!state || Number(state.activeVersion) !== expectedVersion) {
      throw codedError("CRYPTO_CREATOR_KEY_VERSION_CONFLICT", "Creator encryption key generation changed before rotation commit", 409, { creatorId, currentVersion: state?.activeVersion || null });
    }
    if (Number(state.rootVersion || 1) !== currentRootVersion || Number(actor.root.version) !== targetRootVersion) {
      throw codedError("CRYPTO_ROOT_VERSION_CONFLICT", "Agency/creator root generation changed before rotation commit", 409, { creatorId, currentVersion: state.rootVersion, targetVersion: actor.root.version });
    }

    const [session, proxy, profile, expectedDevices] = await Promise.all([
      tx.creatorSessionState.findUnique({ where: { creatorId } }),
      tx.agencyProxyEndpoint.findFirst({ where: { agencyId, ownerCreatorId: creatorId } }),
      tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } }),
      activeNonOwnerDeviceIdentitiesForCreator({ db: tx, agencyId, creatorId }),
    ]);
    const currentSession = sessionRotationProjection(session);
    const currentProxy = proxyRotationProjection(proxy, profile);
    if (currentSession && currentSession.keyVersion !== expectedVersion) throw codedError("CRYPTO_ROTATION_STATE_INCONSISTENT", "Creator session generation changed before rotation commit", 409);
    if (currentProxy && currentProxy.keyVersion !== expectedVersion) throw codedError("CRYPTO_ROTATION_STATE_INCONSISTENT", "Proxy credential generation changed before rotation commit", 409);

    let normalizedSession = null;
    if (currentSession) {
      if (!sessionInput || Number(sessionInput.expectedRevision) !== currentSession.revision) throw codedError("CRYPTO_ROTATION_SESSION_REVISION_CONFLICT", "Creator session revision changed before rotation commit", 409);
      normalizedSession = normalizeCreatorSecretEnvelope(sessionInput.opaquePayload, nextKeyVersion, "Creator session");
    } else if (sessionInput) {
      throw codedError("CRYPTO_ROTATION_SESSION_UNEXPECTED", "Creator session rotation payload was supplied but no active session secret exists", 409);
    }

    let normalizedProxy = null;
    if (currentProxy) {
      if (!proxyInput || String(proxyInput.proxyId || "") !== currentProxy.proxyId || Number(proxyInput.expectedProxyVersion) !== currentProxy.proxyVersion || Number(proxyInput.expectedProfileVersion || 0) !== currentProxy.profileVersion) {
        throw codedError("CRYPTO_ROTATION_PROXY_VERSION_CONFLICT", "Proxy/network state changed before rotation commit", 409);
      }
      normalizedProxy = normalizeCreatorSecretEnvelope(proxyInput.opaqueCredentials, nextKeyVersion, "Proxy credentials");
    } else if (proxyInput) {
      throw codedError("CRYPTO_ROTATION_PROXY_UNEXPECTED", "Proxy credential rotation payload was supplied but no proxy secret exists", 409);
    }

    const wraps = normalizeRotationDeviceWraps(deviceWraps, { agencyId, creatorId, nextKeyVersion, expectedDevices });
    for (const item of wraps) {
      await tx.creatorDeviceKeyWrap.upsert({
        where: { agencyId_creatorId_keyVersion_deviceId: { agencyId, creatorId, keyVersion: nextKeyVersion, deviceId: item.deviceId } },
        create: { agencyId, creatorId, keyVersion: nextKeyVersion, deviceId: item.deviceId, ...item.wrap, createdByDeviceId: actor.device.id },
        update: { ...item.wrap, createdByDeviceId: actor.device.id, revokedAt: null },
      });
    }

    let nextSessionRevision = currentSession?.revision || null;
    if (currentSession && normalizedSession) {
      const updated = await tx.creatorSessionState.updateMany({
        where: { id: session.id, agencyId, creatorId, revision: currentSession.revision, encryptionMode: "CLIENT_E2E_V1", keyVersion: expectedVersion, status: "ACTIVE" },
        data: { ...normalizedSession, revision: { increment: 1 } },
      });
      if (updated.count !== 1) throw codedError("CRYPTO_ROTATION_SESSION_REVISION_CONFLICT", "Creator session changed concurrently during key rotation", 409);
      nextSessionRevision = currentSession.revision + 1;
    }

    let nextProxyVersion = currentProxy?.proxyVersion || null;
    let nextProfileVersion = currentProxy?.profileVersion || null;
    if (currentProxy && normalizedProxy) {
      const updatedProxy = await tx.agencyProxyEndpoint.updateMany({
        where: { id: currentProxy.proxyId, agencyId, ownerCreatorId: creatorId, version: currentProxy.proxyVersion, encryptionMode: "CLIENT_E2E_V1", keyVersion: expectedVersion, hasCredentials: true },
        data: { ...normalizedProxy, hasCredentials: true, usernameHint: proxy.usernameHint, version: { increment: 1 } },
      });
      if (updatedProxy.count !== 1) throw codedError("CRYPTO_ROTATION_PROXY_VERSION_CONFLICT", "Proxy credentials changed concurrently during key rotation", 409);
      nextProxyVersion = currentProxy.proxyVersion + 1;
      if (currentProxy.active) {
        const updatedProfile = await tx.creatorNetworkProfile.updateMany({
          where: { id: profile.id, agencyId, creatorId, mode: "PROXY", proxyEndpointId: currentProxy.proxyId, version: currentProxy.profileVersion },
          data: { version: { increment: 1 }, updatedByUserId: userId },
        });
        if (updatedProfile.count !== 1) throw codedError("CRYPTO_ROTATION_NETWORK_VERSION_CONFLICT", "Creator network profile changed concurrently during key rotation", 409);
        nextProfileVersion = currentProxy.profileVersion + 1;
      }
    }

    const switched = await tx.creatorCryptoKeyState.updateMany({
      where: { id: state.id, agencyId, creatorId, activeVersion: expectedVersion },
      data: { activeVersion: nextKeyVersion, rootVersion: targetRootVersion },
    });
    if (switched.count !== 1) throw codedError("CRYPTO_CREATOR_KEY_VERSION_CONFLICT", "Creator encryption generation changed concurrently during rotation", 409);
    await tx.creatorDeviceKeyWrap.updateMany({
      where: { agencyId, creatorId, keyVersion: { lt: nextKeyVersion }, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return {
      rotated: true,
      creatorId,
      previousKeyVersion: expectedVersion,
      activeKeyVersion: nextKeyVersion,
      previousRootVersion: currentRootVersion,
      activeRootVersion: targetRootVersion,
      sessionRevision: nextSessionRevision,
      proxyVersion: nextProxyVersion,
      networkProfileVersion: nextProfileVersion,
      wrappedDeviceCount: wraps.length,
    };
  }, "CRYPTO_ROTATION_WRITE_CONFLICT");
}

async function retireCurrentDeviceIdentity({ db, agencyId, userId, deviceId }) {
  const id = clean(deviceId, 180);
  if (!id) throw codedError("CRYPTO_DEVICE_REQUIRED", "deviceId is required", 400);

  // The rotation plan and the destructive revoke must be one Serializable
  // decision.  Computing exposure before the transaction allows a concurrent
  // approval/grant to create a current AMK/CDK wrap that this retirement then
  // revokes without reporting the corresponding strong-rotation debt.
  return serializableTransaction(db, async (tx) => {
    // Durable crypto identity is the authority here. WorkerDevice is mutable
    // current telemetry and may presently belong to another workspace on the
    // same physical PC; it must never block retirement of this agency-scoped
    // immutable identity.
    const identity = await tx.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, id) });
    if (!identity) {
      throw codedError(
        "CRYPTO_DEVICE_IDENTITY_REQUIRED",
        "This logical device no longer has an immutable crypto identity; an owner must close any historical key exposure through strong rotation",
        409,
      );
    }
    requireIdentityUser(identity, userId);

    const [root, activeCreatorIds, creatorKeyStates, activeOwnerWraps, activeCreatorWraps] = await Promise.all([
      tx.agencyCryptoRoot.findUnique({ where: { agencyId } }),
      activeCryptoCreatorIds({ db: tx, agencyId }),
      tx.creatorCryptoKeyState.findMany({ where: { agencyId }, select: { creatorId: true, activeVersion: true } }),
      tx.agencyCryptoOwnerKeyWrap.findMany({ where: { agencyId, deviceId: id, revokedAt: null }, select: { rootVersion: true } }),
      tx.creatorDeviceKeyWrap.findMany({ where: { agencyId, deviceId: id, revokedAt: null }, select: { creatorId: true, keyVersion: true } }),
    ]);
    const activeCreatorSet = new Set(activeCreatorIds);
    const activeVersionByCreator = new Map(creatorKeyStates
      .filter((row) => activeCreatorSet.has(String(row.creatorId || "")))
      .map((row) => [String(row.creatorId), Number(row.activeVersion || 0)]));
    const affectedCreatorIds = Array.from(new Set(activeCreatorWraps
      .filter((row) => Number(row.keyVersion || 0) === Number(activeVersionByCreator.get(String(row.creatorId)) || -1))
      .map((row) => String(row.creatorId || ""))
      .filter(Boolean))).sort();
    const targetHadOwnerRoot = Boolean(root && activeOwnerWraps.some((row) => Number(row.rootVersion || 0) === Number(root.version || 0)));
    const idempotent = identity.status === "REVOKED";
    const now = new Date();

    if (!idempotent) {
      await tx.deviceCryptoIdentity.update({
        where: cryptoIdentityWhere(agencyId, id),
        data: { status: "REVOKED", revokedAt: now },
      });
    }
    await tx.agencyCryptoOwnerKeyWrap.updateMany({
      where: { agencyId, deviceId: id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.creatorDeviceKeyWrap.updateMany({
      where: { agencyId, deviceId: id, revokedAt: null },
      data: { revokedAt: now },
    });
    // The old logical device id must not be able to mint fresh access tokens
    // after local recovery rotates to a new id. Access tokens already issued
    // are still bounded by their normal short expiry, while every crypto-secret
    // endpoint is blocked immediately by the REVOKED crypto identity above.
    await tx.refreshSession.updateMany({
      where: { userId, agencyId, deviceId: id, revokedAt: null },
      data: { revokedAt: now },
    });

    return {
      retired: true,
      idempotent,
      deviceId: id,
      targetHadOwnerRoot,
      affectedCreatorIds,
      rootRotationRequired: targetHadOwnerRoot,
      creatorRotationRequired: affectedCreatorIds.length > 0,
    };
  }, "CRYPTO_SELF_RETIRE_WRITE_CONFLICT");
}

async function softRevokeDevice({ db, agencyId, userId, member, actorDeviceId, targetDeviceId, actorProof }) {
  if (actorDeviceId === targetDeviceId) throw codedError("CRYPTO_SELF_REVOKE_FORBIDDEN", "Use recovery/rotation flow before revoking the current owner device", 409);
  const now = new Date();
  return serializableTransaction(db, async (tx) => {
    await requireOwnerCryptoCommitActor({ db: tx, agencyId, userId, member, deviceId: actorDeviceId, actorProof });
    const plan = await buildDeviceRevocationPlan({ db: tx, agencyId, targetDeviceId });
    const target = await tx.deviceCryptoIdentity.findUnique({ where: cryptoIdentityWhere(agencyId, targetDeviceId) });
    if (!target || target.agencyId !== agencyId) throw codedError("CRYPTO_TARGET_DEVICE_NOT_FOUND", "Target crypto device was not found", 404);
    if (target.status !== "REVOKED" || !target.revokedAt) {
      await tx.deviceCryptoIdentity.update({ where: cryptoIdentityWhere(agencyId, targetDeviceId), data: { status: "REVOKED", revokedAt: now } });
    }
    await tx.agencyCryptoOwnerKeyWrap.updateMany({ where: { agencyId, deviceId: targetDeviceId, revokedAt: null }, data: { revokedAt: now } });
    await tx.creatorDeviceKeyWrap.updateMany({ where: { agencyId, deviceId: targetDeviceId, revokedAt: null }, data: { revokedAt: now } });
    return { revoked: true, targetDeviceId, strongRotationRequired: plan.targetHadOwnerRoot || plan.affectedCreatorIds.length > 0, ...plan };
  }, "CRYPTO_DEVICE_REVOKE_WRITE_CONFLICT");
}

module.exports = {
  DEVICE_KEY_ALGORITHM,
  WRAP_ALGORITHM,
  RECOVERY_ALGORITHM,
  parseX25519PublicKey,
  normalizeWrapEnvelope,
  normalizeRecoveryEnvelope,
  verifyActorProof,
  findRootExposureDebt,
  findUntrustedCreatorExposureDebt,
  revokeOwnerRootAccessForMember,
  registerDeviceIdentity,
  initializeAgencyCryptoRoot,
  getCryptoStatus,
  listCryptoDevices,
  getCryptoSecurityDebt,
  getRecoveryEnvelope,
  recoverOwnerDevice,
  pendingDevices,
  getDeviceApprovalPlan,
  approveDevice,
  getCreatorKeyState,
  initializeCreatorKeyState,
  assertDeviceCanUseCreatorKey,
  getDeviceRevocationPlan,
  requireOwnerCryptoCommitActor,
  getRootRotationPlan,
  beginRootRotation,
  getRootRotationBridge,
  getRootRotationProgress,
  finalizeRootRotation,
  getCreatorRotationPlan,
  commitCreatorKeyRotation,
  retireCurrentDeviceIdentity,
  softRevokeDevice,
};
