"use strict";

const { canAccessCreator } = require("../middleware/automation-permissions");
const { isOwner } = require("./team-access-control");
const { assertCreatorSessionTargetActive, publicState } = require("./creator-session-broker-service");
const { profilePublic } = require("./creator-network-profile-service");
const { opaqueProxyCredentialEnvelope } = require("./proxy-credentials");

function codedError(code, message, status = 409, extra = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (extra && typeof extra === "object") Object.assign(error, extra);
  return error;
}

function clean(value, max = 180) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeRequests(input) {
  const merged = new Map();
  for (const raw of Array.isArray(input) ? input : []) {
    const creatorId = clean(raw?.creatorId);
    if (!creatorId) continue;
    const current = merged.get(creatorId) || { creatorId, session: false, network: false };
    current.session = current.session || raw?.session === true;
    current.network = current.network || raw?.network === true;
    if (current.session || current.network) merged.set(creatorId, current);
  }
  return Array.from(merged.values());
}

async function serializableRead(db, work) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      last = error;
      if (String(error?.code || "") !== "P2034" || attempt >= 2) throw error;
    }
  }
  throw last;
}

function assertIdentity(identity, { agencyId, userId }) {
  if (!identity || identity.agencyId !== agencyId || identity.status !== "ACTIVE" || identity.revokedAt) {
    throw codedError("DESKTOP_SECRET_DEVICE_NOT_ENROLLED", "This device is not enrolled for client-side creator encryption", 403);
  }
  if (String(identity.userId || "") !== String(userId || "")) {
    throw codedError("DESKTOP_SECRET_DEVICE_USER_MISMATCH", "Device crypto identity belongs to another user", 403);
  }
}

function requiredKey(row, request) {
  const required = [];
  if (request.session && row.sessionState?.status === "ACTIVE") {
    if (String(row.sessionState.encryptionMode || "") !== "CLIENT_E2E_V1") {
      throw codedError("CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED", "Legacy creator session envelopes are not supported", 409);
    }
    const version = Number(row.sessionState.keyVersion);
    if (!Number.isInteger(version) || version < 1) throw codedError("CREATOR_SESSION_CORRUPT", "Active creator session is missing keyVersion", 500);
    required.push(version);
  }
  if (request.network && String(row.networkProfile?.mode || "DIRECT") === "PROXY") {
    const proxy = row.networkProfile?.proxyEndpoint || null;
    if (!proxy || proxy.agencyId !== row.agencyId) throw codedError("CREATOR_PROXY_MISSING", "Assigned proxy endpoint no longer exists", 409);
    if (proxy.ownerCreatorId && proxy.ownerCreatorId !== row.id) throw codedError("CREATOR_PROXY_OWNER_MISMATCH", "Assigned proxy belongs to another creator encryption domain", 409);
    if (proxy.enabled === false) throw codedError("CREATOR_PROXY_DISABLED", "Assigned proxy endpoint is disabled", 409);
    if (proxy.hasCredentials) {
      if (!proxy.ownerCreatorId || proxy.ownerCreatorId !== row.id) throw codedError("PROXY_E2E_OWNER_MISSING", "Client-side encrypted proxy credentials are not bound to this creator", 409);
      const envelope = opaqueProxyCredentialEnvelope(proxy);
      required.push(Number(envelope.keyVersion));
    }
  }
  return Array.from(new Set(required));
}

function networkRuntime(row) {
  const profile = profilePublic(row.networkProfile, row);
  if (profile.mode !== "PROXY") return { ...profile, proxy: null };
  const proxy = row.networkProfile?.proxyEndpoint || null;
  if (!proxy || proxy.agencyId !== row.agencyId) throw codedError("CREATOR_PROXY_MISSING", "Assigned proxy endpoint no longer exists", 409);
  if (proxy.ownerCreatorId && proxy.ownerCreatorId !== row.id) throw codedError("CREATOR_PROXY_OWNER_MISMATCH", "Assigned proxy belongs to another creator encryption domain", 409);
  if (proxy.enabled === false) throw codedError("CREATOR_PROXY_DISABLED", "Assigned proxy endpoint is disabled", 409);
  const opaqueCredentials = proxy.hasCredentials ? opaqueProxyCredentialEnvelope(proxy) : null;
  return {
    ...profile,
    proxy: {
      id: proxy.id,
      label: proxy.label,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      version: Number(proxy.version || 1),
      hasCredentials: proxy.hasCredentials === true,
      usernameHint: proxy.usernameHint || null,
      encryptionMode: "CLIENT_E2E_V1",
      keyVersion: opaqueCredentials?.keyVersion ?? null,
      username: null,
      password: null,
      opaqueCredentials,
    },
  };
}

async function assertBatchKeyAccess({ tx, agencyId, userId, deviceId, member, rows, requestsById }) {
  const requirements = [];
  for (const row of rows) {
    const request = requestsById.get(row.id);
    if (!request) continue;
    for (const keyVersion of requiredKey(row, request)) {
      const state = row.cryptoKeyState || null;
      if (!state || Number(state.activeVersion) !== keyVersion) {
        throw codedError("CRYPTO_CREATOR_KEY_VERSION_CONFLICT", "Creator encryption key version is stale or not initialized", 409, { creatorId: row.id, currentVersion: state?.activeVersion || null });
      }
      requirements.push({ creatorId: row.id, keyVersion, rootVersion: Number(state.rootVersion || 1) });
    }
  }
  if (!requirements.length) return;

  const identity = await tx.deviceCryptoIdentity.findUnique({ where: { agencyId_deviceId: { agencyId, deviceId } } });
  assertIdentity(identity, { agencyId, userId });

  if (!isOwner(member)) {
    const creatorIds = Array.from(new Set(requirements.map((x) => x.creatorId)));
    const wraps = await tx.creatorDeviceKeyWrap.findMany({
      where: { agencyId, deviceId, revokedAt: null, creatorId: { in: creatorIds } },
      select: { creatorId: true, keyVersion: true },
    });
    const allowed = new Set(wraps.map((row) => `${row.creatorId}|${Number(row.keyVersion)}`));
    for (const required of requirements) {
      if (!allowed.has(`${required.creatorId}|${required.keyVersion}`)) {
        throw codedError("CRYPTO_CREATOR_KEY_NOT_ENROLLED", "This device is not enrolled for the creator encryption key", 403, { creatorId: required.creatorId });
      }
    }
    return;
  }

  const root = await tx.agencyCryptoRoot.findUnique({ where: { agencyId } });
  if (!root || root.status !== "ACTIVE") throw codedError("CRYPTO_ROOT_NOT_INITIALIZED", "Agency encryption root is not initialized", 409);
  const currentRootVersion = Number(root.version);
  const requiredVersions = Array.from(new Set(requirements.map((x) => x.rootVersion)));
  const wrapVersions = Array.from(new Set([...requiredVersions, currentRootVersion]));
  const wraps = await tx.agencyCryptoOwnerKeyWrap.findMany({
    where: { agencyId, deviceId, revokedAt: null, rootVersion: { in: wrapVersions } },
    select: { rootVersion: true },
  });
  const direct = new Set(wraps.map((row) => Number(row.rootVersion)));
  const bridgeFrom = requiredVersions.filter((version) => version < currentRootVersion && !direct.has(version));
  const bridges = bridgeFrom.length
    ? await tx.agencyCryptoRootBridge.findMany({
      where: { agencyId, fromVersion: { in: bridgeFrom }, toVersion: currentRootVersion, retiredAt: null },
      select: { fromVersion: true },
    })
    : [];
  const bridged = new Set(bridges.map((row) => Number(row.fromVersion)));
  const hasCurrent = direct.has(currentRootVersion);
  for (const required of requirements) {
    const rootVersion = required.rootVersion;
    const allowed = direct.has(rootVersion) || (hasCurrent && rootVersion < currentRootVersion && bridged.has(rootVersion));
    if (!allowed) {
      throw codedError("CRYPTO_OWNER_KEY_NOT_ENROLLED", "This owner device cannot reach the Agency Master Key generation required by this creator", 403, { creatorId: required.creatorId });
    }
  }
}

async function buildDesktopSecretDelta({ db, agencyId, userId, member, deviceId, requests }) {
  const normalized = normalizeRequests(requests);
  if (!normalized.length) return { ok: true, items: [] };
  return serializableRead(db, async (tx) => {
    const liveMember = await tx.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } });
    if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
      throw codedError("DESKTOP_SECRET_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
    }
    const ids = normalized.map((x) => x.creatorId);
    const rows = await tx.creatorAccount.findMany({
      where: { agencyId, deletedAt: null, id: { in: ids } },
      select: {
        id: true, agencyId: true, displayName: true, username: true, remoteId: true, status: true,
        sessionState: true,
        cryptoKeyState: { select: { activeVersion: true, rootVersion: true } },
        networkProfile: {
          select: {
            creatorId: true, mode: true, proxyEndpointId: true, version: true, updatedAt: true,
            proxyEndpoint: true,
          },
        },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const request of normalized) {
      const row = byId.get(request.creatorId);
      if (!row) throw codedError("CREATOR_NOT_FOUND", "Creator not found", 404, { creatorId: request.creatorId });
      if (!canAccessCreator(liveMember, request.creatorId)) {
        throw codedError("DESKTOP_SECRET_CREATOR_ACCESS_REVOKED", "Creator access was revoked before secret delta could be read", 403, { creatorId: request.creatorId });
      }
      if (request.session && row.sessionState?.status === "ACTIVE") assertCreatorSessionTargetActive(row);
    }
    const requestsById = new Map(normalized.map((x) => [x.creatorId, x]));
    await assertBatchKeyAccess({ tx, agencyId, userId, deviceId, member: liveMember, rows, requestsById });
    return {
      ok: true,
      items: normalized.map((request) => {
        const row = byId.get(request.creatorId);
        return {
          creatorId: request.creatorId,
          ...(request.session ? { session: publicState(row.sessionState, { includePayload: true }) } : {}),
          ...(request.network ? { network: networkRuntime(row) } : {}),
        };
      }),
    };
  });
}

module.exports = { normalizeRequests, buildDesktopSecretDelta };
