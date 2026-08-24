"use strict";

const net = require("node:net");
const {
  normalizeProxyCredentials,
  serverEncryptedProxyCredentials,
  clearedProxyCredentials,
  normalizeOpaqueProxyCredentials,
  decryptServerProxyCredentials,
  opaqueProxyCredentialEnvelope,
  proxyCredentialHash,
  usernameHint,
} = require("./proxy-credentials");
const { assertDeviceCanUseCreatorKey } = require("./client-e2e-keyring-service");
const { canAccessCreator } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");

const PROXY_TYPES = new Set(["HTTP", "HTTPS", "SOCKS4", "SOCKS4A", "SOCKS5"]);
const NETWORK_MODES = new Set(["DIRECT", "PROXY"]);

function clean(value, max = 4096) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function networkError(code, message, status = 400, extra = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (extra && typeof extra === "object") Object.assign(error, extra);
  return error;
}

function normalizeType(value) {
  const type = clean(value, 32).toUpperCase();
  if (!PROXY_TYPES.has(type)) throw networkError("PROXY_TYPE_INVALID", "Unsupported proxy type", 400);
  return type;
}

function normalizeHost(value) {
  let host = clean(value, 512);
  if (!host) throw networkError("PROXY_HOST_REQUIRED", "Proxy host is required", 400);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (/\s/.test(host) || /[/?#@]/.test(host)) throw networkError("PROXY_HOST_INVALID", "Proxy host must be a hostname or IP address without URL syntax", 400);
  if (net.isIP(host)) return host;
  if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes("..")) {
    throw networkError("PROXY_HOST_INVALID", "Proxy host is invalid", 400);
  }
  return host.toLowerCase();
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw networkError("PROXY_PORT_INVALID", "Proxy port must be between 1 and 65535", 400);
  return port;
}

function normalizeLabel(value) {
  const label = clean(value, 120);
  if (!label) throw networkError("PROXY_LABEL_REQUIRED", "Proxy label is required", 400);
  return label;
}

function proxyPublic(row, assignedCreatorCount = null) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    host: row.host,
    port: row.port,
    enabled: row.enabled !== false,
    version: Number(row.version || 1),
    hasCredentials: row.hasCredentials === true,
    usernameHint: row.usernameHint || null,
    encryptionMode: String(row.encryptionMode || "SERVER_V1"),
    keyVersion: row.keyVersion == null ? null : Number(row.keyVersion),
    assignedCreatorCount: assignedCreatorCount == null ? undefined : Number(assignedCreatorCount || 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function profilePublic(row, creator = null) {
  const mode = row ? String(row.mode || "DIRECT") : "DIRECT";
  return {
    creatorId: row?.creatorId || creator?.id || null,
    creator: creator ? {
      id: creator.id,
      displayName: creator.displayName || null,
      username: creator.username || null,
      status: creator.status || null,
    } : undefined,
    mode: NETWORK_MODES.has(mode) ? mode : "DIRECT",
    proxyEndpointId: row?.proxyEndpointId || null,
    version: row ? Number(row.version || 1) : 0,
    updatedAt: row?.updatedAt || null,
  };
}

function endpointRuntimeFingerprint(row) {
  return JSON.stringify({
    type: row.type,
    host: row.host,
    port: row.port,
    enabled: row.enabled !== false,
  });
}

async function cryptoRootPolicy(db, agencyId) {
  return db.agencyCryptoRoot.findUnique({
    where: { agencyId },
    select: { version: true, enforceOpaqueSecrets: true, status: true },
  });
}

function assertLegacySecretAllowed(root) {
  if (root?.enforceOpaqueSecrets) {
    throw networkError(
      "CRYPTO_OPAQUE_SECRET_REQUIRED",
      "This agency requires client-side encrypted proxy credentials",
      409,
    );
  }
}

async function credentialReplacement({ db, agencyId, proxy, assignedCreatorId, nextType, mutation, actorMember, deviceId }) {
  const mode = clean(mutation?.mode || "KEEP", 16).toUpperCase();
  if (mode === "KEEP") {
    if (proxy.type !== nextType && proxy.hasCredentials) {
      if (String(proxy.encryptionMode || "SERVER_V1") === "CLIENT_E2E_V1") {
        throw networkError(
          "PROXY_CREDENTIALS_REVALIDATION_REQUIRED",
          "Changing proxy protocol requires REPLACE or CLEAR for client-side encrypted credentials",
          409,
        );
      }
      const root = await cryptoRootPolicy(db, agencyId);
      assertLegacySecretAllowed(root);
      const legacy = decryptServerProxyCredentials(proxy);
      const normalized = normalizeProxyCredentials(nextType, legacy || {});
      return { storage: serverEncryptedProxyCredentials(nextType, normalized || {}), changed: false };
    }
    return { storage: null, changed: false };
  }
  if (mode === "CLEAR") {
    return { storage: clearedProxyCredentials(), changed: proxy.hasCredentials === true };
  }
  if (mode !== "REPLACE") {
    throw networkError("PROXY_CREDENTIAL_MUTATION_INVALID", "Credential update mode must be KEEP, REPLACE or CLEAR", 400);
  }

  if (mutation?.opaqueCredentials) {
    if (!assignedCreatorId) {
      throw networkError("PROXY_CREATOR_REQUIRED_FOR_E2E", "Assign this proxy to a creator before storing client-side encrypted credentials", 409);
    }
    const opaque = normalizeOpaqueProxyCredentials({
      ...mutation.opaqueCredentials,
      usernameHint: mutation.usernameHint ?? null,
    });
    if (!deviceId || !actorMember) throw networkError("CRYPTO_DEVICE_CONTEXT_REQUIRED", "A registered crypto device is required", 403);
    await assertDeviceCanUseCreatorKey({
      db,
      agencyId,
      creatorId: assignedCreatorId,
      keyVersion: opaque.keyVersion,
      deviceId,
      member: actorMember,
    });
    return { storage: opaque, changed: true };
  }

  const root = await cryptoRootPolicy(db, agencyId);
  assertLegacySecretAllowed(root);
  const next = normalizeProxyCredentials(nextType, mutation?.credentials || {});
  if (!next) throw networkError("PROXY_CREDENTIALS_REPLACE_EMPTY", "REPLACE requires proxy credentials; use CLEAR to remove authentication", 400);
  return { storage: serverEncryptedProxyCredentials(nextType, next), changed: true };
}

async function runSerializable(db, work, conflictCode, conflictMessage) {
  const options = { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(work, options);
    } catch (error) {
      if (error?.code !== "P2034") throw error;
      if (attempt >= 2) throw networkError(conflictCode, conflictMessage, 409);
    }
  }
  throw networkError(conflictCode, conflictMessage, 409);
}

async function runProxySecretReadSerializable(db, work) {
  return runSerializable(
    db,
    work,
    "PROXY_SECRET_READ_CONFLICT",
    "Proxy credential authorization changed concurrently; refresh and retry",
  );
}

async function requireLiveProxySecretReader({ db, agencyId, userId = null, member = null, creatorId = null, requireManagement = false }) {
  const liveMember = userId
    ? await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } })
    : member;
  if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
    throw networkError("PROXY_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  }
  if (requireManagement && !(await canUsePermission({ member: liveMember, key: "creators.manage", db }))) {
    throw networkError("PROXY_MANAGEMENT_REVOKED", "Creator-management permission was revoked before proxy secret material could be read", 403);
  }
  let creator = null;
  if (creatorId) {
    creator = await db.creatorAccount.findFirst({
      where: { id: creatorId, agencyId, deletedAt: null },
      select: { id: true, agencyId: true, displayName: true, username: true, status: true },
    });
    if (!creator) throw networkError("CREATOR_NOT_FOUND", "Creator not found", 404);
    if (!canAccessCreator(liveMember, creatorId)) {
      throw networkError("PROXY_CREATOR_ACCESS_REVOKED", "Creator access was revoked before proxy secret material could be read", 403);
    }
  }
  return { member: liveMember, creator };
}

async function requireLiveProxyManagementWriter({ db, agencyId, userId = null, member = null, creatorId = null }) {
  const liveMember = userId
    ? await db.agencyMember.findUnique({ where: { agencyId_userId: { agencyId, userId } } })
    : member;
  if (!liveMember || liveMember.deletedAt || liveMember.deactivatedAt) {
    throw networkError("PROXY_MEMBER_INACTIVE", "Agency membership is no longer active", 403);
  }
  if (!(await canUsePermission({ member: liveMember, key: "creators.manage", db }))) {
    throw networkError("PROXY_MANAGEMENT_REVOKED", "Creator-management permission was revoked before the proxy/network mutation could commit", 403);
  }
  let creator = null;
  if (creatorId) {
    creator = await db.creatorAccount.findFirst({
      where: { id: creatorId, agencyId, deletedAt: null },
      select: { id: true, agencyId: true, displayName: true, username: true, status: true },
    });
    if (!creator) throw networkError("CREATOR_NOT_FOUND", "Creator not found", 404);
    if (!canAccessCreator(liveMember, creatorId)) {
      throw networkError("PROXY_CREATOR_ACCESS_REVOKED", "Creator access was revoked before the proxy/network mutation could commit", 403);
    }
  }
  return { member: liveMember, creator };
}

async function createProxyEndpoint({ db, agencyId, actorUserId, actorMember = null, input }) {
  const type = normalizeType(input?.type);
  const credentials = normalizeProxyCredentials(type, input?.credentials || {});
  return runSerializable(db, async (tx) => {
    await requireLiveProxyManagementWriter({ db: tx, agencyId, userId: actorUserId, member: actorMember });
    if (credentials) assertLegacySecretAllowed(await cryptoRootPolicy(tx, agencyId));
    const storage = credentials ? serverEncryptedProxyCredentials(type, credentials) : clearedProxyCredentials();
    const row = await tx.agencyProxyEndpoint.create({
      data: {
        agencyId,
        label: normalizeLabel(input?.label),
        type,
        host: normalizeHost(input?.host),
        port: normalizePort(input?.port),
        enabled: input?.enabled !== false,
        version: 1,
        ...storage,
      },
    });
    return { proxy: proxyPublic(row), actorUserId };
  }, "PROXY_CREATE_CONFLICT", "Proxy creation conflicted with opaque-secret enforcement");
}

async function createProxyForCreator({ db, agencyId, creatorId, actorUserId, actorMember, deviceId, expectedNetworkVersion, input }) {
  const version = Number(expectedNetworkVersion);
  if (!Number.isInteger(version) || version < 0) throw networkError("CREATOR_NETWORK_VERSION_INVALID", "expectedNetworkVersion must be zero or a positive integer", 400);
  const type = normalizeType(input?.type);
  return runSerializable(db, async (tx) => {
    const authority = await requireLiveProxyManagementWriter({ db: tx, agencyId, userId: actorUserId, member: actorMember, creatorId });
    const creator = authority.creator;
    const current = await tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    const currentVersion = current ? Number(current.version || 1) : 0;
    if (currentVersion !== version) throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409, { current: profilePublic(current, creator) });
    if (current?.mode === "PROXY" && current.proxyEndpointId) throw networkError("CREATOR_ALREADY_HAS_PROXY", "This creator already has a proxy endpoint; edit or remove that endpoint instead", 409);
    const ownedEndpoint = await tx.agencyProxyEndpoint.findFirst({ where: { agencyId, ownerCreatorId: creatorId }, select: { id: true } });
    if (ownedEndpoint) throw networkError("CREATOR_PROXY_ENDPOINT_EXISTS", "This creator already owns a dedicated proxy endpoint; edit or delete it instead of creating another", 409, { proxyEndpointId: ownedEndpoint.id });

    let storage = clearedProxyCredentials();
    if (input?.opaqueCredentials) {
      const opaque = normalizeOpaqueProxyCredentials({ ...input.opaqueCredentials, usernameHint: input.usernameHint ?? null });
      await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: opaque.keyVersion, deviceId, member: actorMember });
      storage = opaque;
    } else {
      const credentials = normalizeProxyCredentials(type, input?.credentials || {});
      if (credentials) assertLegacySecretAllowed(await cryptoRootPolicy(tx, agencyId));
      storage = credentials ? serverEncryptedProxyCredentials(type, credentials) : clearedProxyCredentials();
    }

    const proxy = await tx.agencyProxyEndpoint.create({
      data: {
        agencyId,
        ownerCreatorId: creatorId,
        label: normalizeLabel(input?.label),
        type,
        host: normalizeHost(input?.host),
        port: normalizePort(input?.port),
        enabled: input?.enabled !== false,
        version: 1,
        ...storage,
      },
    });
    let profile;
    if (!current) {
      profile = await tx.creatorNetworkProfile.create({
        data: { agencyId, creatorId, mode: "PROXY", proxyEndpointId: proxy.id, version: 1, updatedByUserId: actorUserId || null },
      });
    } else {
      const updated = await tx.creatorNetworkProfile.updateMany({
        where: { agencyId, creatorId, version },
        data: { mode: "PROXY", proxyEndpointId: proxy.id, version: { increment: 1 }, updatedByUserId: actorUserId || null },
      });
      if (updated.count !== 1) throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409);
      profile = await tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    }
    return { proxy: proxyPublic(proxy), profile: profilePublic(profile, creator), actorUserId };
  }, "CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed concurrently");
}

async function requireLiveProxyCreator({ db, agencyId, creatorId }) {
  const id = clean(creatorId, 180);
  if (!id) return null;
  const creator = await db.creatorAccount.findFirst({
    where: { id, agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) throw networkError("PROXY_CREATOR_REMOVED", "The creator encryption domain for this proxy was removed", 409, { creatorId: id });
  return creator;
}

async function updateProxyEndpoint({ db, agencyId, actorUserId, actorMember = null, deviceId = null, proxyId, expectedVersion, patch }) {
  const id = clean(proxyId, 180);
  const version = Number(expectedVersion);
  if (!id) throw networkError("PROXY_ID_REQUIRED", "Proxy endpoint is required", 400);
  if (!Number.isInteger(version) || version <= 0) throw networkError("PROXY_VERSION_INVALID", "expectedVersion must be a positive integer", 400);

  return runSerializable(db, async (tx) => {
    await requireLiveProxyManagementWriter({ db: tx, agencyId, userId: actorUserId, member: actorMember });
    const current = await tx.agencyProxyEndpoint.findFirst({ where: { id, agencyId } });
    if (!current) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
    if (Number(current.version) !== version) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409, { current: proxyPublic(current) });
    const assigned = await tx.creatorNetworkProfile.findFirst({ where: { agencyId, proxyEndpointId: id, mode: "PROXY" }, select: { creatorId: true } });
    const secretOwnerCreatorId = current.ownerCreatorId || assigned?.creatorId || null;
    if (secretOwnerCreatorId) await requireLiveProxyCreator({ db: tx, agencyId, creatorId: secretOwnerCreatorId });

    const nextType = patch?.type === undefined ? current.type : normalizeType(patch.type);
    const next = {
      label: patch?.label === undefined ? current.label : normalizeLabel(patch.label),
      type: nextType,
      host: patch?.host === undefined ? current.host : normalizeHost(patch.host),
      port: patch?.port === undefined ? current.port : normalizePort(patch.port),
      enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
    };
    const credentialChange = await credentialReplacement({
      db: tx,
      agencyId,
      proxy: current,
      assignedCreatorId: secretOwnerCreatorId,
      nextType,
      mutation: patch?.credentials,
      actorMember,
      deviceId,
    });

    const routeChanged = endpointRuntimeFingerprint(current) !== endpointRuntimeFingerprint({ ...current, ...next });
    const runtimeChanged = routeChanged || credentialChange.changed;
    const metadataChanged = current.label !== next.label;
    if (!runtimeChanged && !metadataChanged) {
      const claimed = await tx.agencyProxyEndpoint.updateMany({ where: { id, agencyId, version }, data: { version: { increment: 0 } } });
      if (claimed.count !== 1) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409);
      const unchanged = await tx.agencyProxyEndpoint.findUnique({ where: { id } });
      return { proxy: proxyPublic(unchanged), unchanged: true, runtimeChanged: false, actorUserId };
    }

    if (next.enabled === false && current.enabled !== false) {
      const assignedCount = await tx.creatorNetworkProfile.count({ where: { agencyId, proxyEndpointId: id, mode: "PROXY" } });
      if (assignedCount > 0) throw networkError("PROXY_STILL_ASSIGNED", "Reassign creators to another proxy or Direct before disabling this proxy", 409, { assignedCreatorCount: assignedCount });
    }

    const updated = await tx.agencyProxyEndpoint.updateMany({
      where: { id, agencyId, version },
      data: {
        ...next,
        version: { increment: 1 },
        ...(credentialChange.storage || {}),
      },
    });
    if (updated.count !== 1) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409);

    if (runtimeChanged) {
      await tx.creatorNetworkProfile.updateMany({
        where: { agencyId, proxyEndpointId: id, mode: "PROXY" },
        data: { version: { increment: 1 }, updatedByUserId: actorUserId || null },
      });
    }
    const row = await tx.agencyProxyEndpoint.findUnique({ where: { id } });
    return { proxy: proxyPublic(row), unchanged: false, runtimeChanged, actorUserId };
  }, "PROXY_VERSION_CONFLICT", "Proxy endpoint was changed concurrently");
}

async function deleteProxyEndpoint({ db, agencyId, actorUserId = null, actorMember = null, proxyId, expectedVersion }) {
  const id = clean(proxyId, 180);
  const version = Number(expectedVersion);
  if (!id || !Number.isInteger(version) || version <= 0) throw networkError("PROXY_DELETE_INPUT_INVALID", "Proxy id and expectedVersion are required", 400);
  return runSerializable(db, async (tx) => {
    await requireLiveProxyManagementWriter({ db: tx, agencyId, userId: actorUserId, member: actorMember });
    const current = await tx.agencyProxyEndpoint.findFirst({ where: { id, agencyId } });
    if (!current) return { deleted: false, alreadyDeleted: true };
    if (Number(current.version) !== version) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409, { current: proxyPublic(current) });
    const assigned = await tx.creatorNetworkProfile.count({ where: { agencyId, proxyEndpointId: id, mode: "PROXY" } });
    if (assigned > 0) throw networkError("PROXY_STILL_ASSIGNED", "Reassign creators to another proxy or Direct before deleting this proxy", 409, { assignedCreatorCount: assigned });
    const removed = await tx.agencyProxyEndpoint.deleteMany({ where: { id, agencyId, version } });
    if (removed.count !== 1) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409);
    return { deleted: true, alreadyDeleted: false };
  }, "PROXY_VERSION_CONFLICT", "Proxy endpoint was changed concurrently");
}

async function setCreatorNetworkProfile({ db, agencyId, creatorId, actorUserId, actorMember = null, expectedVersion, mode: modeInput, proxyEndpointId }) {
  const mode = clean(modeInput, 16).toUpperCase();
  if (!NETWORK_MODES.has(mode)) throw networkError("CREATOR_NETWORK_MODE_INVALID", "Network mode must be DIRECT or PROXY", 400);
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 0) throw networkError("CREATOR_NETWORK_VERSION_INVALID", "expectedVersion must be zero or a positive integer", 400);

  return runSerializable(db, async (tx) => {
    const authority = await requireLiveProxyManagementWriter({ db: tx, agencyId, userId: actorUserId, member: actorMember, creatorId });
    const creator = authority.creator;
    let proxy = null;
    const nextProxyId = mode === "PROXY" ? clean(proxyEndpointId, 180) : null;
    if (mode === "PROXY") {
      if (!nextProxyId) throw networkError("CREATOR_PROXY_REQUIRED", "Select a proxy endpoint", 400);
      proxy = await tx.agencyProxyEndpoint.findFirst({ where: { id: nextProxyId, agencyId } });
      if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
      if (proxy.enabled === false) throw networkError("PROXY_DISABLED", "This proxy endpoint is disabled", 409);
      if (proxy.ownerCreatorId && proxy.ownerCreatorId !== creatorId) {
        throw networkError("PROXY_OWNED_BY_ANOTHER_CREATOR", "This dedicated proxy belongs to another creator and cannot be reassigned", 409);
      }
      if (!proxy.ownerCreatorId && String(proxy.encryptionMode || "SERVER_V1") === "CLIENT_E2E_V1") {
        throw networkError("PROXY_E2E_OWNER_MISSING", "Client-side encrypted proxy credentials have no creator owner", 409);
      }
      const creatorOwnedProxy = await tx.agencyProxyEndpoint.findFirst({ where: { agencyId, ownerCreatorId: creatorId, NOT: { id: nextProxyId } }, select: { id: true } });
      if (creatorOwnedProxy) {
        throw networkError("CREATOR_PROXY_ENDPOINT_EXISTS", "This creator already owns another dedicated proxy endpoint", 409, { proxyEndpointId: creatorOwnedProxy.id });
      }

      const existingOwner = await tx.creatorNetworkProfile.findFirst({
        where: {
          agencyId,
          proxyEndpointId: nextProxyId,
          mode: "PROXY",
          NOT: { creatorId },
        },
        select: { creatorId: true },
      });
      if (existingOwner) {
        throw networkError(
          "PROXY_ALREADY_ASSIGNED",
          "This proxy endpoint is already assigned to another creator",
          409,
          { proxyEndpointId: nextProxyId },
        );
      }
    }

    const current = await tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    const currentVersion = current ? Number(current.version || 1) : 0;
    if (currentVersion !== version) throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409, { current: profilePublic(current, creator) });

    if (proxy && !proxy.ownerCreatorId) {
      const claimedOwner = await tx.agencyProxyEndpoint.updateMany({ where: { id: proxy.id, agencyId, ownerCreatorId: null }, data: { ownerCreatorId: creatorId } });
      if (claimedOwner.count !== 1) throw networkError("PROXY_OWNER_CLAIM_CONFLICT", "Proxy ownership changed concurrently", 409);
    }

    if (!current) {
      try {
        const created = await tx.creatorNetworkProfile.create({
          data: {
            agencyId,
            creatorId,
            mode,
            proxyEndpointId: nextProxyId,
            version: 1,
            updatedByUserId: actorUserId || null,
          },
        });
        return { profile: profilePublic(created, creator), unchanged: false };
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const target = Array.isArray(error?.meta?.target) ? error.meta.target.join(",") : String(error?.meta?.target || "");
        if (target.includes("proxyEndpointId")) {
          throw networkError("PROXY_ALREADY_ASSIGNED", "This proxy endpoint was assigned to another creator concurrently", 409);
        }
        throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409);
      }
    }

    const same = current.mode === mode && (current.proxyEndpointId || null) === nextProxyId;
    let updated;
    try {
      updated = await tx.creatorNetworkProfile.updateMany({
        where: { creatorId, agencyId, version },
        data: same
          ? { mode, proxyEndpointId: nextProxyId, updatedByUserId: actorUserId || null, version: { increment: 0 } }
          : { mode, proxyEndpointId: nextProxyId, updatedByUserId: actorUserId || null, version: { increment: 1 } },
      });
    } catch (error) {
      if (error?.code === "P2002" && nextProxyId) {
        throw networkError("PROXY_ALREADY_ASSIGNED", "This proxy endpoint was assigned to another creator concurrently", 409);
      }
      throw error;
    }
    if (updated.count !== 1) {
      const raced = await tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
      throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409, { current: profilePublic(raced, creator) });
    }
    const row = await tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    return { profile: profilePublic(row, creator), unchanged: same };
  }, "CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed concurrently");
}

async function listNetworkSettings({ db, agencyId, creatorIds = null }) {
  const creatorWhere = {
    agencyId,
    deletedAt: null,
    ...(Array.isArray(creatorIds) ? { id: { in: creatorIds.length ? creatorIds : ["__none__"] } } : {}),
  };
  const [proxies, creators, assignedProfiles] = await Promise.all([
    db.agencyProxyEndpoint.findMany({ where: { agencyId }, orderBy: [{ label: "asc" }, { createdAt: "asc" }] }),
    db.creatorAccount.findMany({
      where: creatorWhere,
      select: {
        id: true,
        displayName: true,
        username: true,
        status: true,
        networkProfile: { select: { mode: true, proxyEndpointId: true, version: true, updatedAt: true } },
      },
      orderBy: { displayName: "asc" },
      take: 10000,
    }),
    db.creatorNetworkProfile.findMany({
      where: { agencyId, mode: "PROXY", proxyEndpointId: { not: null } },
      select: { proxyEndpointId: true, creatorId: true },
      take: 10000,
    }),
  ]);
  const visibleCreators = new Set(creators.map((row) => row.id));
  const assignmentByProxy = new Map();
  for (const profile of assignedProfiles) {
    const id = profile.proxyEndpointId || null;
    if (id) assignmentByProxy.set(id, profile.creatorId || null);
  }
  return {
    proxies: proxies.map((row) => {
      const assignedCreatorId = assignmentByProxy.get(row.id) || null;
      return {
        ...proxyPublic(row, assignedCreatorId ? 1 : 0),
        assignedCreatorId: assignedCreatorId && visibleCreators.has(assignedCreatorId) ? assignedCreatorId : null,
        ownerCreatorId: row.ownerCreatorId && visibleCreators.has(row.ownerCreatorId) ? row.ownerCreatorId : null,
        ownerCreatorVisible: Boolean(row.ownerCreatorId && visibleCreators.has(row.ownerCreatorId)),
      };
    }),
    creators: creators.map((creator) => profilePublic(creator.networkProfile, creator)),
  };
}

async function getCreatorNetworkManifest({ db, agencyId, creatorId }) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: {
      id: true,
      networkProfile: { select: { mode: true, proxyEndpointId: true, version: true, updatedAt: true } },
    },
  });
  if (!creator) throw networkError("CREATOR_NOT_FOUND", "Creator not found", 404);
  return profilePublic(creator.networkProfile, creator);
}

async function proxyRuntimeCredentials({ db, agencyId, creatorId, proxy, deviceId, member }) {
  if (!proxy.hasCredentials) {
    return { encryptionMode: String(proxy.encryptionMode || "SERVER_V1"), keyVersion: proxy.keyVersion == null ? null : Number(proxy.keyVersion), username: null, password: null, opaqueCredentials: null };
  }
  const mode = String(proxy.encryptionMode || "SERVER_V1");
  if (mode === "CLIENT_E2E_V1") {
    const envelope = opaqueProxyCredentialEnvelope(proxy);
    await assertDeviceCanUseCreatorKey({ db, agencyId, creatorId, keyVersion: envelope.keyVersion, deviceId, member });
    return { encryptionMode: mode, keyVersion: envelope.keyVersion, username: null, password: null, opaqueCredentials: envelope };
  }
  const root = await cryptoRootPolicy(db, agencyId);
  if (root?.enforceOpaqueSecrets) {
    throw networkError("CRYPTO_LEGACY_PROXY_SECRET_BLOCKED", "Legacy server-decryptable proxy credentials are blocked after opaque-secret enforcement", 409);
  }
  const credentials = decryptServerProxyCredentials(proxy);
  return { encryptionMode: "SERVER_V1", keyVersion: null, username: credentials?.username || null, password: credentials?.password || null, opaqueCredentials: null };
}

async function getCreatorNetworkRuntime({ db, agencyId, creatorId, deviceId, member, userId = null }) {
  return runProxySecretReadSerializable(db, async (tx) => {
    const live = await requireLiveProxySecretReader({ db: tx, agencyId, userId, member, creatorId });
    const creator = await tx.creatorAccount.findFirst({
      where: { id: creatorId, agencyId, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        username: true,
        status: true,
        networkProfile: {
          select: {
            mode: true,
            proxyEndpointId: true,
            version: true,
            updatedAt: true,
            proxyEndpoint: true,
          },
        },
      },
    });
    if (!creator) throw networkError("CREATOR_NOT_FOUND", "Creator not found", 404);
    const profile = creator.networkProfile;
    if (!profile || profile.mode !== "PROXY") return { ...profilePublic(profile, creator), proxy: null };
    const proxy = profile.proxyEndpoint;
    if (!proxy || proxy.agencyId !== agencyId) throw networkError("CREATOR_PROXY_MISSING", "Assigned proxy endpoint no longer exists", 409);
    if (proxy.ownerCreatorId && proxy.ownerCreatorId !== creatorId) throw networkError("CREATOR_PROXY_OWNER_MISMATCH", "Assigned proxy belongs to another creator encryption domain", 409);
    if (proxy.enabled === false) throw networkError("CREATOR_PROXY_DISABLED", "Assigned proxy endpoint is disabled", 409);
    const secret = await proxyRuntimeCredentials({ db: tx, agencyId, creatorId, proxy, deviceId, member: live.member });
    return {
      ...profilePublic(profile, creator),
      proxy: {
        id: proxy.id,
        label: proxy.label,
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        version: Number(proxy.version || 1),
        hasCredentials: proxy.hasCredentials === true,
        usernameHint: proxy.usernameHint || null,
        ...secret,
      },
    };
  });
}

async function getProxyCredentialContext({ db, agencyId, proxyId }) {
  const proxy = await db.agencyProxyEndpoint.findFirst({
    where: { id: proxyId, agencyId },
    select: {
      id: true,
      version: true,
      encryptionMode: true,
      keyVersion: true,
      hasCredentials: true,
      ownerCreatorId: true,
      creatorProfile: { select: { creatorId: true, mode: true } },
    },
  });
  if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
  const creatorId = proxy.ownerCreatorId || (proxy.creatorProfile?.mode === "PROXY" ? proxy.creatorProfile.creatorId : null);
  return {
    proxyId: proxy.id,
    proxyVersion: Number(proxy.version || 1),
    creatorId,
    hasCredentials: proxy.hasCredentials === true,
    encryptionMode: String(proxy.encryptionMode || "SERVER_V1"),
    keyVersion: proxy.keyVersion == null ? null : Number(proxy.keyVersion),
  };
}

async function getProxyCredentialMigrationMaterial({ db, agencyId, creatorId, proxyId, member = null, userId = null }) {
  const id = clean(proxyId, 180);
  if (!id) throw networkError("PROXY_MIGRATION_INPUT_INVALID", "proxyId is required", 400);
  return runProxySecretReadSerializable(db, async (tx) => {
    await requireLiveProxySecretReader({ db: tx, agencyId, userId, member, creatorId, requireManagement: true });
    const [proxy, profile] = await Promise.all([
      tx.agencyProxyEndpoint.findFirst({ where: { id, agencyId } }),
      tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } }),
    ]);
    if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
    const activelyAssigned = Boolean(profile && profile.mode === "PROXY" && profile.proxyEndpointId === id);
    if (proxy.ownerCreatorId && proxy.ownerCreatorId !== creatorId) {
      throw networkError("PROXY_CREATOR_BINDING_CHANGED", "Proxy owner changed before credential migration", 409);
    }
    if (!proxy.ownerCreatorId && !activelyAssigned) {
      throw networkError("PROXY_CRYPTO_OWNER_REQUIRED", "Legacy proxy credentials are not owned or currently assigned to this creator", 409);
    }

    const mode = String(proxy.encryptionMode || "SERVER_V1");
    let username = null;
    let password = null;
    if (proxy.hasCredentials && mode === "SERVER_V1") {
      const root = await cryptoRootPolicy(tx, agencyId);
      if (root?.enforceOpaqueSecrets) {
        throw networkError("CRYPTO_LEGACY_PROXY_SECRET_BLOCKED", "Legacy server-decryptable proxy credentials are blocked after opaque-secret enforcement", 409);
      }
      const credentials = decryptServerProxyCredentials(proxy);
      username = credentials?.username || null;
      password = credentials?.password || null;
    }
    return {
      id: proxy.id,
      creatorId,
      ownerCreatorId: proxy.ownerCreatorId || null,
      activelyAssigned,
      label: proxy.label,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      version: Number(proxy.version || 1),
      hasCredentials: proxy.hasCredentials === true,
      usernameHint: proxy.usernameHint || null,
      encryptionMode: mode,
      keyVersion: proxy.keyVersion == null ? null : Number(proxy.keyVersion),
      username,
      password,
    };
  });
}

async function getProxyTestMaterial({ db, agencyId, proxyId, deviceId, member, userId = null }) {
  return runProxySecretReadSerializable(db, async (tx) => {
    const live = await requireLiveProxySecretReader({ db: tx, agencyId, userId, member, requireManagement: true });
    const meta = await tx.agencyProxyEndpoint.findFirst({
      where: { id: proxyId, agencyId },
      select: {
        id: true,
        ownerCreatorId: true,
        creatorProfile: { select: { creatorId: true, mode: true } },
      },
    });
    if (!meta) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
    const creatorId = meta.ownerCreatorId || (meta.creatorProfile?.mode === "PROXY" ? meta.creatorProfile.creatorId : null);
    if (creatorId) {
      await requireLiveProxySecretReader({ db: tx, agencyId, member: live.member, creatorId });
    }
    const proxy = await tx.agencyProxyEndpoint.findFirst({
      where: { id: proxyId, agencyId },
      include: { creatorProfile: { select: { creatorId: true, mode: true } } },
    });
    if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
    if (proxy.enabled === false) throw networkError("PROXY_DISABLED", "Proxy endpoint is disabled", 409);
    const currentCreatorId = proxy.ownerCreatorId || (proxy.creatorProfile?.mode === "PROXY" ? proxy.creatorProfile.creatorId : null);
    if (currentCreatorId !== creatorId) throw networkError("PROXY_CREATOR_BINDING_CHANGED", "Proxy creator binding changed during secret read", 409);
    let secret = { encryptionMode: String(proxy.encryptionMode || "SERVER_V1"), keyVersion: null, username: null, password: null, opaqueCredentials: null };
    if (proxy.hasCredentials) {
      if (!creatorId && String(proxy.encryptionMode || "SERVER_V1") === "CLIENT_E2E_V1") {
        throw networkError("PROXY_E2E_OWNER_MISSING", "Client-side encrypted proxy credentials are not bound to a creator", 409);
      }
      if (creatorId) secret = await proxyRuntimeCredentials({ db: tx, agencyId, creatorId, proxy, deviceId, member: live.member });
      else {
        const root = await cryptoRootPolicy(tx, agencyId);
        if (root?.enforceOpaqueSecrets) throw networkError("CRYPTO_LEGACY_PROXY_SECRET_BLOCKED", "Unassigned legacy proxy credentials must be cleared or assigned before opaque enforcement", 409);
        const credentials = decryptServerProxyCredentials(proxy);
        secret = { encryptionMode: "SERVER_V1", keyVersion: null, username: credentials?.username || null, password: credentials?.password || null, opaqueCredentials: null };
      }
    }
    return {
      id: proxy.id,
      creatorId,
      label: proxy.label,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      version: Number(proxy.version || 1),
      hasCredentials: proxy.hasCredentials === true,
      usernameHint: proxy.usernameHint || null,
      ...secret,
    };
  });
}

async function migrateProxyCredentialsToOpaque({ db, agencyId, creatorId, proxyId, expectedVersion, deviceId, member, opaqueCredentials, legacyCredentialHash, suppliedUsernameHint }) {
  const id = clean(proxyId, 180);
  const version = Number(expectedVersion);
  if (!id || !Number.isInteger(version) || version <= 0) throw networkError("PROXY_MIGRATION_INPUT_INVALID", "proxyId and expectedVersion are required", 400);
  const opaque = normalizeOpaqueProxyCredentials({ ...opaqueCredentials, usernameHint: suppliedUsernameHint ?? null });
  return runSerializable(db, async (tx) => {
    await requireLiveProxyCreator({ db: tx, agencyId, creatorId });
    const proxy = await tx.agencyProxyEndpoint.findFirst({ where: { id, agencyId } });
    if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
    const profile = await tx.creatorNetworkProfile.findUnique({ where: { agencyId_creatorId: { agencyId, creatorId } } });
    const activelyAssigned = Boolean(profile && profile.mode === "PROXY" && profile.proxyEndpointId === id);
    if (proxy.ownerCreatorId && proxy.ownerCreatorId !== creatorId) throw networkError("PROXY_CREATOR_BINDING_CHANGED", "Proxy owner changed before credential migration", 409);
    if (!proxy.ownerCreatorId && !activelyAssigned) {
      throw networkError("PROXY_CRYPTO_OWNER_REQUIRED", "Legacy proxy credentials are not owned or currently assigned to this creator", 409);
    }
    if (!proxy.ownerCreatorId) {
      const claimed = await tx.agencyProxyEndpoint.updateMany({ where: { id, agencyId, ownerCreatorId: null }, data: { ownerCreatorId: creatorId } });
      if (claimed.count !== 1) throw networkError("PROXY_OWNER_CLAIM_CONFLICT", "Proxy ownership changed before credential migration", 409);
    }
    if (Number(proxy.version) !== version) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint changed before credential migration", 409, { current: proxyPublic(proxy) });
    if (!proxy.hasCredentials) return { migrated: false, alreadyClear: true, proxy: proxyPublic(proxy) };
    if (String(proxy.encryptionMode || "SERVER_V1") === "CLIENT_E2E_V1") return { migrated: false, alreadyOpaque: true, proxy: proxyPublic(proxy) };
    assertLegacySecretAllowed(await cryptoRootPolicy(tx, agencyId));
    // Authorize the exact live device/member/CDK before touching legacy plaintext.
    // A request that lost creator access after HTTP middleware must not trigger
    // server-side decryption even if the later migration would be rejected.
    await assertDeviceCanUseCreatorKey({ db: tx, agencyId, creatorId, keyVersion: opaque.keyVersion, deviceId, member });
    const legacy = decryptServerProxyCredentials(proxy);
    if (proxyCredentialHash(legacy) !== clean(legacyCredentialHash, 128).toLowerCase()) {
      throw networkError("PROXY_CREDENTIAL_MIGRATION_HASH_MISMATCH", "Proxy credentials changed before migration", 409);
    }
    const expectedHint = usernameHint(legacy?.username || null);
    const receivedHint = suppliedUsernameHint == null ? null : clean(suppliedUsernameHint, 512) || null;
    if (expectedHint !== receivedHint) throw networkError("PROXY_CREDENTIAL_MIGRATION_HINT_MISMATCH", "Proxy credential identity changed before migration", 409);
    const updated = await tx.agencyProxyEndpoint.updateMany({
      where: { id, agencyId, version, encryptionMode: "SERVER_V1" },
      data: opaque,
    });
    if (updated.count !== 1) throw networkError("PROXY_CREDENTIAL_MIGRATION_CONFLICT", "Proxy credential representation changed concurrently", 409);
    const row = await tx.agencyProxyEndpoint.findUnique({ where: { id } });
    return { migrated: true, alreadyOpaque: false, proxy: proxyPublic(row) };
  }, "PROXY_CREDENTIAL_MIGRATION_CONFLICT", "Proxy credential migration conflicted with another writer");
}

module.exports = {
  PROXY_TYPES,
  NETWORK_MODES,
  proxyPublic,
  profilePublic,
  createProxyEndpoint,
  createProxyForCreator,
  updateProxyEndpoint,
  deleteProxyEndpoint,
  setCreatorNetworkProfile,
  listNetworkSettings,
  getCreatorNetworkManifest,
  getCreatorNetworkRuntime,
  getProxyCredentialContext,
  getProxyCredentialMigrationMaterial,
  getProxyTestMaterial,
  migrateProxyCredentialsToOpaque,
};
