"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  setCreatorNetworkProfile,
  listNetworkSettings,
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
    ["proxy-1", { id: "proxy-1", agencyId: "agency-1", label: "P1", type: "SOCKS5", host: "proxy.test", port: 1080, enabled: true, version: 1, hasCredentials: false, usernameHint: null, createdAt: new Date("2026-08-23T16:00:00.000Z"), updatedAt: new Date("2026-08-23T16:00:00.000Z") }],
    ["proxy-2", { id: "proxy-2", agencyId: "agency-1", label: "P2", type: "HTTP", host: "proxy2.test", port: 8080, enabled: true, version: 1, hasCredentials: false, usernameHint: null, createdAt: new Date("2026-08-23T16:00:00.000Z"), updatedAt: new Date("2026-08-23T16:00:00.000Z") }],
  ]);
  const profiles = new Map();
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
        const row = proxies.get(where.id);
        return row && row.agencyId === where.agencyId ? clone(row) : null;
      },
      findMany: async ({ where }) => [...proxies.values()].filter((row) => row.agencyId === where.agencyId).map(clone),
    },
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
      findMany: async ({ where }) => [...profiles.values()].filter((row) => matchesProfile(row, where)).map((row) => ({ proxyEndpointId: row.proxyEndpointId })),
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
  return { db, creators, proxies, profiles };
}

async function assign(db, creatorId, expectedVersion, proxyEndpointId) {
  return setCreatorNetworkProfile({
    db,
    agencyId: "agency-1",
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

test("V20.18 a proxy assigned to creator A cannot be assigned to creator B", async () => {
  const { db } = makeDb();
  const first = await assign(db, "creator-1", 0, "proxy-1");
  assert.equal(first.profile.proxyEndpointId, "proxy-1");
  await assert.rejects(
    assign(db, "creator-2", 0, "proxy-1"),
    (error) => error?.code === "PROXY_ALREADY_ASSIGNED" && error?.status === 409,
  );
});

test("V20.18 Direct explicitly releases the dedicated endpoint for another creator", async () => {
  const { db } = makeDb();
  const first = await assign(db, "creator-1", 0, "proxy-1");
  const direct = await assign(db, "creator-1", first.profile.version, null);
  assert.equal(direct.profile.mode, "DIRECT");
  assert.equal(direct.profile.proxyEndpointId, null);
  const second = await assign(db, "creator-2", 0, "proxy-1");
  assert.equal(second.profile.proxyEndpointId, "proxy-1");
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
  const { db, profiles } = makeDb();
  profiles.set("creator-2", {
    id: "profile-hidden", agencyId: "agency-1", creatorId: "creator-2", mode: "PROXY", proxyEndpointId: "proxy-1", version: 1,
    updatedByUserId: "user-2", createdAt: new Date(), updatedAt: new Date(),
  });
  const state = await listNetworkSettings({ db, agencyId: "agency-1", creatorIds: ["creator-1"] });
  assert.equal(state.creators.length, 1);
  assert.equal(state.creators[0].creatorId, "creator-1");
  assert.equal(state.proxies.find((proxy) => proxy.id === "proxy-1").assignedCreatorCount, 1);
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
