"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  setCreatorNetworkProfile,
  updateProxyEndpoint,
  listNetworkSettings,
  getProxyTestMaterial,
} = require("./creator-network-profile-service");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matchesProfile(row, where = {}) {
  if (!row) return false;
  if (where.creatorId !== undefined && row.creatorId !== where.creatorId) return false;
  if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
  if (where.mode !== undefined && row.mode !== where.mode) return false;
  if (where.proxyEndpointId !== undefined) {
    if (where.proxyEndpointId && typeof where.proxyEndpointId === "object" && Object.hasOwn(where.proxyEndpointId, "not")) {
      if (row.proxyEndpointId === where.proxyEndpointId.not) return false;
    } else if (row.proxyEndpointId !== where.proxyEndpointId) return false;
  }
  const notCreator = where.NOT?.creatorId;
  if (notCreator !== undefined && row.creatorId === notCreator) return false;
  if (where.version !== undefined && Number(row.version) !== Number(where.version)) return false;
  return true;
}

function applyData(row, data) {
  const next = { ...row };
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === "object" && Object.hasOwn(value, "increment")) {
      next[key] = Number(next[key] || 0) + Number(value.increment || 0);
    } else {
      next[key] = clone(value);
    }
  }
  next.updatedAt = new Date("2026-08-23T16:00:01.000Z");
  return next;
}

function uniqueProxyViolation() {
  const error = new Error("Unique constraint failed on proxyEndpointId");
  error.code = "P2002";
  error.meta = { target: ["proxyEndpointId"] };
  return error;
}

function uniqueCreatorViolation() {
  const error = new Error("Unique constraint failed on creatorId");
  error.code = "P2002";
  error.meta = { target: ["creatorId"] };
  return error;
}

function makeDb({ hideProxyOwnerDuringPrecheck = false } = {}) {
  const creators = new Map([
    ["creator-1", { id: "creator-1", agencyId: "agency-1", displayName: "Alpha", username: "alpha", status: "READY", deletedAt: null }],
    ["creator-2", { id: "creator-2", agencyId: "agency-1", displayName: "Beta", username: "beta", status: "READY", deletedAt: null }],
    ["creator-3", { id: "creator-3", agencyId: "agency-2", displayName: "Other", username: "other", status: "READY", deletedAt: null }],
  ]);
  const proxies = new Map([
    ["proxy-1", { id: "proxy-1", agencyId: "agency-1", label: "P1", type: "SOCKS5", host: "proxy.test", port: 1080, enabled: true, version: 1, ownerCreatorId: null, encryptionMode: "CLIENT_E2E_V1", hasCredentials: false, usernameHint: null, createdAt: new Date("2026-08-23T16:00:00.000Z"), updatedAt: new Date("2026-08-23T16:00:00.000Z") }],
    ["proxy-2", { id: "proxy-2", agencyId: "agency-1", label: "P2", type: "HTTP", host: "proxy2.test", port: 8080, enabled: true, version: 1, ownerCreatorId: null, encryptionMode: "CLIENT_E2E_V1", hasCredentials: false, usernameHint: null, createdAt: new Date("2026-08-23T16:00:00.000Z"), updatedAt: new Date("2026-08-23T16:00:00.000Z") }],
  ]);
  const profiles = new Map();
  const root = { agencyId: "agency-1", version: 1, status: "ACTIVE", enforceOpaqueSecrets: false };
  let nextId = 1;
  let suppressOwner = hideProxyOwnerDuringPrecheck;

  function profileForCreator(id) {
    return profiles.get(id) || null;
  }
  function assertUniqueProxy(nextRow, ignoreCreatorId = null) {
    if (!nextRow.proxyEndpointId) return;
    for (const row of profiles.values()) {
      if (row.creatorId === ignoreCreatorId) continue;
      if (row.mode === "PROXY" && row.proxyEndpointId === nextRow.proxyEndpointId) throw uniqueProxyViolation();
    }
  }

  const db = {
    creatorAccount: {
      findFirst: async ({ where }) => {
        const row = creators.get(where.id);
        if (!row || row.agencyId !== where.agencyId || row.deletedAt !== null) return null;
        if (where.id?.in && !where.id.in.includes(row.id)) return null;
        return clone(row);
      },
      findMany: async ({ where }) => {
        let rows = [...creators.values()].filter((row) => row.agencyId === where.agencyId && row.deletedAt === null);
        if (where.id?.in) rows = rows.filter((row) => where.id.in.includes(row.id));
        return rows.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          username: row.username,
          status: row.status,
          networkProfile: clone(profileForCreator(row.id)),
        }));
      },
    },
    agencyProxyEndpoint: {
      findFirst: async ({ where }) => {
        for (const row of proxies.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (Object.hasOwn(where, "ownerCreatorId") && row.ownerCreatorId !== where.ownerCreatorId) continue;
          if (where.NOT?.id && row.id === where.NOT.id) continue;
          return clone(row);
        }
        return null;
      },
      findMany: async ({ where }) => [...proxies.values()].filter((row) => row.agencyId === where.agencyId).map(clone),
      findUnique: async ({ where }) => clone(proxies.get(where.id) || null),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of [...proxies.values()]) {
          if (where.id && row.id !== where.id) continue;
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (where.version !== undefined && Number(row.version) !== Number(where.version)) continue;
          if (where.encryptionMode !== undefined && row.encryptionMode !== where.encryptionMode) continue;
          if (Object.hasOwn(where, "ownerCreatorId") && row.ownerCreatorId !== where.ownerCreatorId) continue;
          proxies.set(row.id, applyData(row, data));
          count += 1;
        }
        return { count };
      },
    },
    agencyCryptoRoot: { findUnique: async ({ where }) => where.agencyId === "agency-1" ? clone(root) : null },
    agencyMember: { findUnique: async () => ({ ...ownerMember, userId: "user-1", agencyId: "agency-1", deletedAt: null, deactivatedAt: null }) },
    deviceCryptoIdentity: { findUnique: async ({ where }) => { const key = where.agencyId_deviceId || where; return key.deviceId === "device-1" && (!key.agencyId || key.agencyId === "agency-1") ? { deviceId: "device-1", agencyId: "agency-1", status: "ACTIVE", revokedAt: null } : null; } },
    creatorCryptoKeyState: { findUnique: async ({ where }) => where.agencyId_creatorId?.agencyId === "agency-1" && where.agencyId_creatorId?.creatorId === "creator-1" ? { agencyId: "agency-1", creatorId: "creator-1", activeVersion: 1, rootVersion: 1 } : null },
    agencyCryptoOwnerKeyWrap: { findFirst: async ({ where }) => where.agencyId === "agency-1" && where.rootVersion === 1 && where.deviceId === "device-1" && where.revokedAt === null ? { id: "ow-1" } : null },
    creatorNetworkProfile: {
      findFirst: async ({ where }) => {
        if (suppressOwner && where.proxyEndpointId) {
          suppressOwner = false;
          return null;
        }
        for (const row of profiles.values()) if (matchesProfile(row, where)) return clone(row);
        return null;
      },
      findUnique: async ({ where }) => {
        const key = where.agencyId_creatorId;
        if (!key) return null;
        const row = profiles.get(key.creatorId) || null;
        return row && row.agencyId === key.agencyId ? clone(row) : null;
      },
      findMany: async ({ where }) => [...profiles.values()].filter((row) => matchesProfile(row, where)).map((row) => ({ proxyEndpointId: row.proxyEndpointId, creatorId: row.creatorId })),
      create: async ({ data }) => {
        if (profiles.has(data.creatorId)) throw uniqueCreatorViolation();
        assertUniqueProxy(data);
        const row = {
          id: `profile-${nextId++}`,
          ...clone(data),
          createdAt: new Date("2026-08-23T16:00:00.000Z"),
          updatedAt: new Date("2026-08-23T16:00:00.000Z"),
        };
        profiles.set(row.creatorId, row);
        return clone(row);
      },
      updateMany: async ({ where, data }) => {
        const current = profiles.get(where.creatorId);
        if (!current || !matchesProfile(current, where)) return { count: 0 };
        const next = applyData(current, data);
        assertUniqueProxy(next, current.creatorId);
        profiles.set(current.creatorId, next);
        return { count: 1 };
      },
      count: async ({ where }) => [...profiles.values()].filter((row) => matchesProfile(row, where)).length,
    },
  };
  db.$transaction = async (fn) => fn(db);
  return { db, creators, proxies, profiles, root };
}

function opaqueCredentials(keyVersion = 1) {
  return {
    encryptionMode: "CLIENT_E2E_V1", keyVersion, algorithm: "aes-256-gcm-client-e2e-v1",
    ciphertext: Buffer.alloc(64, 0x71).toString("base64"), iv: Buffer.alloc(12, 0x31).toString("base64"), tag: Buffer.alloc(16, 0x41).toString("base64"),
  };
}

const ownerMember = { role: "OWNER", roleKey: "owner", assignedCreators: null };

async function assign(db, creatorId, expectedVersion, proxyEndpointId) {
  return setCreatorNetworkProfile({
    db,
    agencyId: "agency-1",
    actorMember: ownerMember,
    creatorId,
    actorUserId: "user-1",
    expectedVersion,
    mode: proxyEndpointId ? "PROXY" : "DIRECT",
    proxyEndpointId,
  });
}

test("V20.18 schema and migration enforce one non-null proxy endpoint per creator assignment", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260823140000_creator_network_profiles/migration.sql"), "utf8");
  const relationFixMigration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260823174500_creator_network_profile_composite_relation_keys/migration.sql"), "utf8");
  assert.match(schema, /@@unique\(\[agencyId, creatorId\], map: "CreatorNetworkProfile_agencyId_creatorId_key"\)/);
  assert.match(schema, /@@unique\(\[agencyId, proxyEndpointId\], map: "CreatorNetworkProfile_agencyId_proxyEndpointId_key"\)/);
  assert.match(schema, /fields:\s*\[agencyId, proxyEndpointId\][\s\S]*references:\s*\[agencyId, id\]/);
  assert.match(relationFixMigration, /CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_proxyEndpointId_key"\s+ON "CreatorNetworkProfile"\("agencyId", "proxyEndpointId"\)/);
  assert.match(relationFixMigration, /CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_creatorId_key"\s+ON "CreatorNetworkProfile"\("agencyId", "creatorId"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "AgencyProxyEndpoint_agencyId_id_key" ON "AgencyProxyEndpoint"\("agencyId", "id"\)/);
  assert.match(migration, /FOREIGN KEY \(\"agencyId\", \"proxyEndpointId\"\) REFERENCES \"AgencyProxyEndpoint\"\(\"agencyId\", \"id\"\)/);
  assert.doesNotMatch(migration, /CREATE INDEX "CreatorNetworkProfile_proxyEndpointId_idx"/);
  assert.match(relationFixMigration, /DROP INDEX "CreatorNetworkProfile_creatorId_key"/);
  assert.match(relationFixMigration, /DROP INDEX "CreatorNetworkProfile_proxyEndpointId_key"/);
  const createCreatorComposite = relationFixMigration.indexOf('CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_creatorId_key"');
  const createProxyComposite = relationFixMigration.indexOf('CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_proxyEndpointId_key"');
  const dropCreatorScalar = relationFixMigration.indexOf('DROP INDEX "CreatorNetworkProfile_creatorId_key"');
  const dropProxyScalar = relationFixMigration.indexOf('DROP INDEX "CreatorNetworkProfile_proxyEndpointId_key"');
  assert.ok(createCreatorComposite >= 0 && createCreatorComposite < dropCreatorScalar, "creator composite uniqueness must exist before scalar unique is retired");
  assert.ok(createProxyComposite >= 0 && createProxyComposite < dropProxyScalar, "proxy composite uniqueness must exist before scalar unique is retired");
});

test("V20.19 a dedicated proxy owned by creator A cannot be assigned to creator B", async () => {
  const { db } = makeDb();
  const first = await assign(db, "creator-1", 0, "proxy-1");
  assert.equal(first.profile.proxyEndpointId, "proxy-1");
  await assert.rejects(
    assign(db, "creator-2", 0, "proxy-1"),
    (error) => error?.code === "PROXY_OWNED_BY_ANOTHER_CREATOR" && error?.status === 409,
  );
});

test("V20.19 Direct keeps the dedicated endpoint cryptographically owned by the same creator", async () => {
  const { db } = makeDb();
  const first = await assign(db, "creator-1", 0, "proxy-1");
  const direct = await assign(db, "creator-1", first.profile.version, null);
  assert.equal(direct.profile.mode, "DIRECT");
  assert.equal(direct.profile.proxyEndpointId, null);
  await assert.rejects(
    assign(db, "creator-2", 0, "proxy-1"),
    (error) => error?.code === "PROXY_OWNED_BY_ANOTHER_CREATOR" && error?.status === 409,
  );
});

test("V20.18 same creator reselecting its own proxy is CAS-linearizable no-op without version churn", async () => {
  const { db } = makeDb();
  const first = await assign(db, "creator-1", 0, "proxy-1");
  const again = await assign(db, "creator-1", first.profile.version, "proxy-1");
  assert.equal(again.unchanged, true);
  assert.equal(again.profile.version, first.profile.version);
});

test("V20.18 database unique-race maps to PROXY_ALREADY_ASSIGNED without querying an aborted transaction", async () => {
  const { db, profiles } = makeDb({ hideProxyOwnerDuringPrecheck: true });
  profiles.set("creator-2", {
    id: "profile-existing", agencyId: "agency-1", creatorId: "creator-2", mode: "PROXY", proxyEndpointId: "proxy-1", version: 1,
    updatedByUserId: "user-2", createdAt: new Date(), updatedAt: new Date(),
  });
  await assert.rejects(
    assign(db, "creator-1", 0, "proxy-1"),
    (error) => error?.code === "PROXY_ALREADY_ASSIGNED" && error?.status === 409,
  );
});

test("V20.18 settings marks a proxy assigned even when its owner is outside the visible creator scope", async () => {
  const { db, profiles, proxies } = makeDb();
  proxies.get("proxy-1").ownerCreatorId = "creator-2";
  profiles.set("creator-2", {
    id: "profile-hidden", agencyId: "agency-1", creatorId: "creator-2", mode: "PROXY", proxyEndpointId: "proxy-1", version: 1,
    updatedByUserId: "user-2", createdAt: new Date(), updatedAt: new Date(),
  });
  const state = await listNetworkSettings({ db, agencyId: "agency-1", creatorIds: ["creator-1"] });
  assert.equal(state.creators.length, 1);
  assert.equal(state.creators[0].creatorId, "creator-1");
  assert.equal(state.proxies.find((proxy) => proxy.id === "proxy-1").assignedCreatorCount, 1);
});

test("V20.19 E2E credential replacement uses dedicated crypto owner even while creator is DIRECT", async () => {
  const { db, proxies, profiles } = makeDb();
  Object.assign(proxies.get("proxy-1"), { ownerCreatorId: "creator-1", version: 7 });
  profiles.set("creator-1", { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "DIRECT", proxyEndpointId: null, version: 8, updatedAt: new Date(), createdAt: new Date() });
  const result = await updateProxyEndpoint({
    db, agencyId: "agency-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1", proxyId: "proxy-1", expectedVersion: 7,
    patch: { credentials: { mode: "REPLACE", opaqueCredentials: opaqueCredentials(1), usernameHint: "a***e" } },
  });
  assert.equal(result.proxy.encryptionMode, "CLIENT_E2E_V1");
  assert.equal(proxies.get("proxy-1").version, 8, "real credential replacement advances proxy version");
  assert.equal(profiles.get("creator-1").version, 8, "DIRECT network profile must not churn when its idle dedicated proxy credentials are edited");
  assert.equal(profiles.get("creator-1").mode, "DIRECT");
});

test("V20.22 legacy proxy credentials fail closed instead of being server-decrypted", async () => {
  const { db, proxies, profiles } = makeDb();
  Object.assign(proxies.get("proxy-1"), {
    ownerCreatorId: "creator-1", version: 7, encryptionMode: "SERVER_V1", hasCredentials: true, keyVersion: null,
    encryptedPayload: "legacy-ciphertext", iv: "legacy-iv", tag: "legacy-tag", algorithm: "aes-256-gcm", usernameHint: "alice",
  });
  profiles.set("creator-1", { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "PROXY", proxyEndpointId: "proxy-1", version: 5, updatedAt: new Date(), createdAt: new Date() });
  await assert.rejects(
    getProxyTestMaterial({ db, agencyId: "agency-1", proxyId: "proxy-1", deviceId: "device-1", member: ownerMember }),
    (error) => error?.code === "PROXY_LEGACY_CREDENTIALS_UNSUPPORTED" && error?.status === 409,
  );
});

test("V20.22 credential REPLACE requires a CLIENT_E2E_V1 opaque envelope", async () => {
  const { db, proxies } = makeDb();
  Object.assign(proxies.get("proxy-1"), { ownerCreatorId: "creator-1", version: 7 });
  await assert.rejects(
    updateProxyEndpoint({
      db, agencyId: "agency-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1", proxyId: "proxy-1", expectedVersion: 7,
      patch: { credentials: { mode: "REPLACE" } },
    }),
    (error) => error?.code === "PROXY_E2E_CREDENTIALS_REQUIRED" && error?.status === 400,
  );
});

test("V20.22 CLEAR can crypto-shred retained legacy proxy credentials without decrypting them", async () => {
  const { db, proxies } = makeDb();
  Object.assign(proxies.get("proxy-1"), {
    ownerCreatorId: "creator-1", version: 4, encryptionMode: "SERVER_V1", hasCredentials: true, keyVersion: null,
    encryptedPayload: "legacy-ciphertext", iv: "legacy-iv", tag: "legacy-tag", algorithm: "aes-256-gcm", usernameHint: "orphan",
  });
  const result = await updateProxyEndpoint({
    db, agencyId: "agency-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1", proxyId: "proxy-1", expectedVersion: 4,
    patch: { credentials: { mode: "CLEAR" } },
  });
  assert.equal(result.proxy.hasCredentials, false);
  assert.equal(proxies.get("proxy-1").encryptionMode, "CLIENT_E2E_V1");
  assert.equal(proxies.get("proxy-1").encryptedPayload, null);
});

test("V20.22 unowned authenticated proxy is rejected because no creator CDK can own it", async () => {
  const { db, proxies } = makeDb();
  Object.assign(proxies.get("proxy-1"), {
    ownerCreatorId: null, version: 4, encryptionMode: "CLIENT_E2E_V1", keyVersion: 1, hasCredentials: true,
    encryptedPayload: opaqueCredentials(1).ciphertext, iv: opaqueCredentials(1).iv, tag: opaqueCredentials(1).tag, algorithm: opaqueCredentials(1).algorithm,
  });
  await assert.rejects(
    getProxyTestMaterial({ db, agencyId: "agency-1", proxyId: "proxy-1", deviceId: "device-1", member: ownerMember }),
    (error) => error?.code === "PROXY_E2E_OWNER_MISSING" && error?.status === 409,
  );
});

test("V20.18 Serializable P2034 is retried before surfacing creator assignment conflict", async () => {
  const base = makeDb();
  const originalTransaction = base.db.$transaction.bind(base.db);
  let attempts = 0;
  base.db.$transaction = async (fn, options) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("write conflict");
      error.code = "P2034";
      throw error;
    }
    return originalTransaction(fn, options);
  };
  const result = await assign(base.db, "creator-1", 0, "proxy-1");
  assert.equal(result.profile.proxyEndpointId, "proxy-1");
  assert.equal(attempts, 2);
});

test("V20.18 repeated Serializable P2034 becomes controlled 409 instead of backend 500", async () => {
  const base = makeDb();
  let attempts = 0;
  base.db.$transaction = async () => {
    attempts += 1;
    const error = new Error("write conflict");
    error.code = "P2034";
    throw error;
  };
  await assert.rejects(
    assign(base.db, "creator-1", 0, "proxy-1"),
    (error) => error?.code === "CREATOR_NETWORK_VERSION_CONFLICT" && error?.status === 409,
  );
  assert.equal(attempts, 3);
});


test("V20.19 deleted creator cannot have its dedicated proxy edited back into live secret state", async () => {
  const { db, creators, proxies } = makeDb();
  Object.assign(proxies.get("proxy-1"), { ownerCreatorId: "creator-1", version: 12, enabled: false });
  creators.get("creator-1").deletedAt = new Date("2026-08-24T13:31:00.000Z");
  creators.get("creator-1").status = "DISABLED";

  await assert.rejects(
    updateProxyEndpoint({
      db, agencyId: "agency-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1",
      proxyId: "proxy-1", expectedVersion: 12, patch: { enabled: true, label: "resurrected" },
    }),
    (error) => error?.code === "PROXY_CREATOR_REMOVED" && error?.status === 409,
  );
  assert.equal(proxies.get("proxy-1").enabled, false);
  assert.equal(proxies.get("proxy-1").version, 12);
});

test("V20.22 deleted creator cannot replace retained dedicated proxy credentials with a fresh opaque secret", async () => {
  const { db, creators, proxies, profiles } = makeDb();
  Object.assign(proxies.get("proxy-1"), { ownerCreatorId: "creator-1", version: 13 });
  profiles.set("creator-1", { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "DIRECT", proxyEndpointId: null, version: 3, updatedAt: new Date(), createdAt: new Date() });
  creators.get("creator-1").deletedAt = new Date("2026-08-24T13:32:00.000Z");
  creators.get("creator-1").status = "DISABLED";
  await assert.rejects(
    updateProxyEndpoint({
      db, agencyId: "agency-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1",
      proxyId: "proxy-1", expectedVersion: 13, patch: { credentials: { mode: "REPLACE", opaqueCredentials: opaqueCredentials(1), usernameHint: "removed" } },
    }),
    (error) => error?.code === "PROXY_CREATOR_REMOVED" && error?.status === 409,
  );
  assert.equal(proxies.get("proxy-1").version, 13);
  assert.equal(proxies.get("proxy-1").hasCredentials, false);
});

