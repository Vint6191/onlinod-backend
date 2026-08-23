"use strict";

const net = require("node:net");
const { encryptProxyCredentials, decryptProxyCredentials, normalizeProxyCredentials } = require("./proxy-credentials");

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

function endpointRuntimeFingerprint(row, credentials) {
  return JSON.stringify({
    type: row.type,
    host: row.host,
    port: row.port,
    enabled: row.enabled !== false,
    username: credentials?.username || "",
    password: credentials?.password || "",
  });
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

function normalizeCredentialMutation(type, current, mutation) {
  const mode = clean(mutation?.mode || "KEEP", 16).toUpperCase();
  if (mode === "KEEP") return current;
  if (mode === "CLEAR") return null;
  if (mode === "REPLACE") {
    const next = normalizeProxyCredentials(type, mutation?.credentials || {});
    if (!next) throw networkError("PROXY_CREDENTIALS_REPLACE_EMPTY", "REPLACE requires proxy credentials; use CLEAR to remove authentication", 400);
    return next;
  }
  throw networkError("PROXY_CREDENTIAL_MUTATION_INVALID", "Credential update mode must be KEEP, REPLACE or CLEAR", 400);
}

async function createProxyEndpoint({ db, agencyId, actorUserId, input }) {
  const type = normalizeType(input?.type);
  const credentials = normalizeProxyCredentials(type, input?.credentials || {});
  const encrypted = encryptProxyCredentials(type, credentials || {});
  const row = await db.agencyProxyEndpoint.create({
    data: {
      agencyId,
      label: normalizeLabel(input?.label),
      type,
      host: normalizeHost(input?.host),
      port: normalizePort(input?.port),
      enabled: input?.enabled !== false,
      version: 1,
      ...encrypted,
    },
  });
  return { proxy: proxyPublic(row), actorUserId };
}

async function updateProxyEndpoint({ db, agencyId, actorUserId, proxyId, expectedVersion, patch }) {
  const id = clean(proxyId, 180);
  const version = Number(expectedVersion);
  if (!id) throw networkError("PROXY_ID_REQUIRED", "Proxy endpoint is required", 400);
  if (!Number.isInteger(version) || version <= 0) throw networkError("PROXY_VERSION_INVALID", "expectedVersion must be a positive integer", 400);

  return runSerializable(db, async (tx) => {
    const current = await tx.agencyProxyEndpoint.findFirst({ where: { id, agencyId } });
    if (!current) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
    if (Number(current.version) !== version) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409, { current: proxyPublic(current) });

    const nextType = patch?.type === undefined ? current.type : normalizeType(patch.type);
    const nextCredentials = normalizeCredentialMutation(nextType, decryptProxyCredentials(current), patch?.credentials);
    const next = {
      label: patch?.label === undefined ? current.label : normalizeLabel(patch.label),
      type: nextType,
      host: patch?.host === undefined ? current.host : normalizeHost(patch.host),
      port: patch?.port === undefined ? current.port : normalizePort(patch.port),
      enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
    };
    // Changing protocol can invalidate preserved credentials even when the UI
    // did not touch them. Validate them against the new protocol before CAS.
    const validatedCredentials = normalizeProxyCredentials(next.type, nextCredentials || {});
    const encrypted = encryptProxyCredentials(next.type, validatedCredentials || {});

    const runtimeChanged = endpointRuntimeFingerprint(current, decryptProxyCredentials(current)) !== endpointRuntimeFingerprint({ ...current, ...next }, validatedCredentials);
    const metadataChanged = current.label !== next.label;
    if (!runtimeChanged && !metadataChanged) {
      const claimed = await tx.agencyProxyEndpoint.updateMany({
        where: { id, agencyId, version },
        data: { version: { increment: 0 } },
      });
      if (claimed.count !== 1) throw networkError("PROXY_VERSION_CONFLICT", "Proxy endpoint was changed on another device", 409);
      const unchanged = await tx.agencyProxyEndpoint.findUnique({ where: { id } });
      return { proxy: proxyPublic(unchanged), unchanged: true, runtimeChanged: false, actorUserId };
    }

    if (next.enabled === false && current.enabled !== false) {
      const assigned = await tx.creatorNetworkProfile.count({ where: { agencyId, proxyEndpointId: id, mode: "PROXY" } });
      if (assigned > 0) throw networkError("PROXY_STILL_ASSIGNED", "Reassign creators to another proxy or Direct before disabling this proxy", 409, { assignedCreatorCount: assigned });
    }

    const updated = await tx.agencyProxyEndpoint.updateMany({
      where: { id, agencyId, version },
      data: {
        ...next,
        version: { increment: 1 },
        ...encrypted,
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

async function deleteProxyEndpoint({ db, agencyId, proxyId, expectedVersion }) {
  const id = clean(proxyId, 180);
  const version = Number(expectedVersion);
  if (!id || !Number.isInteger(version) || version <= 0) throw networkError("PROXY_DELETE_INPUT_INVALID", "Proxy id and expectedVersion are required", 400);
  return runSerializable(db, async (tx) => {
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

async function setCreatorNetworkProfile({ db, agencyId, creatorId, actorUserId, expectedVersion, mode: modeInput, proxyEndpointId }) {
  const mode = clean(modeInput, 16).toUpperCase();
  if (!NETWORK_MODES.has(mode)) throw networkError("CREATOR_NETWORK_MODE_INVALID", "Network mode must be DIRECT or PROXY", 400);
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 0) throw networkError("CREATOR_NETWORK_VERSION_INVALID", "expectedVersion must be zero or a positive integer", 400);

  return runSerializable(db, async (tx) => {
    const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null }, select: { id: true, displayName: true, username: true, status: true } });
    if (!creator) throw networkError("CREATOR_NOT_FOUND", "Creator not found", 404);
    let proxy = null;
    const nextProxyId = mode === "PROXY" ? clean(proxyEndpointId, 180) : null;
    if (mode === "PROXY") {
      if (!nextProxyId) throw networkError("CREATOR_PROXY_REQUIRED", "Select a proxy endpoint", 400);
      proxy = await tx.agencyProxyEndpoint.findFirst({ where: { id: nextProxyId, agencyId } });
      if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
      if (proxy.enabled === false) throw networkError("PROXY_DISABLED", "This proxy endpoint is disabled", 409);

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

    const current = await tx.creatorNetworkProfile.findUnique({ where: { creatorId } });
    const currentVersion = current ? Number(current.version || 1) : 0;
    if (currentVersion !== version) throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409, { current: profilePublic(current, creator) });

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
      const raced = await tx.creatorNetworkProfile.findUnique({ where: { creatorId } });
      throw networkError("CREATOR_NETWORK_VERSION_CONFLICT", "Creator network assignment was changed on another device", 409, { current: profilePublic(raced, creator) });
    }
    const row = await tx.creatorNetworkProfile.findUnique({ where: { creatorId } });
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
      select: { proxyEndpointId: true },
      take: 10000,
    }),
  ]);
  const counts = new Map();
  for (const profile of assignedProfiles) {
    const id = profile.proxyEndpointId || null;
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return {
    proxies: proxies.map((row) => proxyPublic(row, counts.get(row.id) || 0)),
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

async function getCreatorNetworkRuntime({ db, agencyId, creatorId }) {
  const creator = await db.creatorAccount.findFirst({
    where: { id: creatorId, agencyId, deletedAt: null },
    select: {
      id: true,
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
  if (!profile || profile.mode !== "PROXY") {
    return { ...profilePublic(profile, creator), proxy: null };
  }
  const proxy = profile.proxyEndpoint;
  if (!proxy || proxy.agencyId !== agencyId) throw networkError("CREATOR_PROXY_MISSING", "Assigned proxy endpoint no longer exists", 409);
  if (proxy.enabled === false) throw networkError("CREATOR_PROXY_DISABLED", "Assigned proxy endpoint is disabled", 409);
  const credentials = decryptProxyCredentials(proxy);
  return {
    ...profilePublic(profile, creator),
    proxy: {
      id: proxy.id,
      label: proxy.label,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      version: Number(proxy.version || 1),
      username: credentials?.username || null,
      password: credentials?.password || null,
    },
  };
}

async function getProxyTestMaterial({ db, agencyId, proxyId }) {
  const proxy = await db.agencyProxyEndpoint.findFirst({ where: { id: proxyId, agencyId } });
  if (!proxy) throw networkError("PROXY_NOT_FOUND", "Proxy endpoint not found", 404);
  if (proxy.enabled === false) throw networkError("PROXY_DISABLED", "Proxy endpoint is disabled", 409);
  const credentials = decryptProxyCredentials(proxy);
  return {
    id: proxy.id,
    label: proxy.label,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    version: Number(proxy.version || 1),
    username: credentials?.username || null,
    password: credentials?.password || null,
  };
}

module.exports = {
  PROXY_TYPES,
  NETWORK_MODES,
  proxyPublic,
  profilePublic,
  createProxyEndpoint,
  updateProxyEndpoint,
  deleteProxyEndpoint,
  setCreatorNetworkProfile,
  listNetworkSettings,
  getCreatorNetworkManifest,
  getCreatorNetworkRuntime,
  getProxyTestMaterial,
};
