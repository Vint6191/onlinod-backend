"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setCreatorNetworkProfile } = require("./creator-network-profile-service");
const ownerActor = { userId: "owner-1", agencyId: "agency-1", role: "OWNER", roleKey: "owner", assignedCreators: "all", permissions: {}, deletedAt: null, deactivatedAt: null };

function makeDb() {
  const creators = new Map([
    ["creator-a", { id: "creator-a", agencyId: "agency-1", displayName: "A", username: "a", status: "ACTIVE", deletedAt: null }],
    ["creator-b", { id: "creator-b", agencyId: "agency-1", displayName: "B", username: "b", status: "ACTIVE", deletedAt: null }],
  ]);
  const proxies = new Map([
    ["proxy-1", { id: "proxy-1", agencyId: "agency-1", label: "Proxy 1", type: "SOCKS5", host: "127.0.0.1", port: 1080, enabled: true, version: 1, ownerCreatorId: null, encryptionMode: "SERVER_V1" }],
  ]);
  const profiles = new Map();

  const tx = {
    agencyMember: { async findUnique() { return { ...ownerActor, userId: "admin", agencyId: "agency-1" }; } },
    creatorAccount: {
      async findFirst({ where }) {
        const row = creators.get(where.id);
        return row && row.agencyId === where.agencyId && row.deletedAt === null ? { ...row } : null;
      },
    },
    agencyProxyEndpoint: {
      async findFirst({ where }) {
        for (const row of proxies.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (Object.hasOwn(where, "ownerCreatorId") && row.ownerCreatorId !== where.ownerCreatorId) continue;
          if (where.NOT?.id && row.id === where.NOT.id) continue;
          return { ...row };
        }
        return null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of proxies.values()) {
          if (where.id && row.id !== where.id) continue;
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (Object.hasOwn(where, "ownerCreatorId") && row.ownerCreatorId !== where.ownerCreatorId) continue;
          Object.assign(row, structuredClone(data));
          count += 1;
        }
        return { count };
      },
    },
    creatorNetworkProfile: {
      async findUnique({ where }) {
        const key = where.agencyId_creatorId;
        if (!key) return null;
        const row = profiles.get(key.creatorId);
        return row && row.agencyId === key.agencyId ? { ...row } : null;
      },
      async findFirst({ where }) {
        for (const row of profiles.values()) {
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (where.proxyEndpointId && row.proxyEndpointId !== where.proxyEndpointId) continue;
          if (where.mode && row.mode !== where.mode) continue;
          if (where.NOT?.creatorId && row.creatorId === where.NOT.creatorId) continue;
          return where.select ? { creatorId: row.creatorId } : { ...row };
        }
        return null;
      },
      async create({ data }) {
        if (profiles.has(data.creatorId)) {
          const error = new Error("unique creator"); error.code = "P2002"; throw error;
        }
        if (data.proxyEndpointId) {
          for (const row of profiles.values()) {
            if (row.proxyEndpointId === data.proxyEndpointId) {
              const error = new Error("unique proxy"); error.code = "P2002"; throw error;
            }
          }
        }
        const row = { id: `profile-${data.creatorId}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        profiles.set(data.creatorId, row);
        return { ...row };
      },
      async updateMany({ where, data }) {
        const row = profiles.get(where.creatorId);
        if (!row || row.agencyId !== where.agencyId || row.version !== where.version) return { count: 0 };
        if (data.proxyEndpointId) {
          for (const other of profiles.values()) {
            if (other.creatorId !== row.creatorId && other.proxyEndpointId === data.proxyEndpointId) {
              const error = new Error("unique proxy"); error.code = "P2002"; throw error;
            }
          }
        }
        row.mode = data.mode;
        row.proxyEndpointId = data.proxyEndpointId;
        row.updatedByUserId = data.updatedByUserId;
        row.version += Number(data.version?.increment || 0);
        row.updatedAt = new Date();
        return { count: 1 };
      },
    },
  };

  return {
    db: { async $transaction(fn) { return fn(tx); } },
    profiles,
  };
}

test("V20.19 dedicated ownership: one endpoint cannot belong to two creators", async () => {
  const { db } = makeDb();
  const first = await setCreatorNetworkProfile({
    db, agencyId: "agency-1", creatorId: "creator-a", actorUserId: "admin", expectedVersion: 0,
    mode: "PROXY", proxyEndpointId: "proxy-1",
  });
  assert.equal(first.profile.proxyEndpointId, "proxy-1");

  await assert.rejects(
    setCreatorNetworkProfile({
      db, agencyId: "agency-1", creatorId: "creator-b", actorUserId: "admin", expectedVersion: 0,
      mode: "PROXY", proxyEndpointId: "proxy-1",
    }),
    (error) => error?.code === "PROXY_OWNED_BY_ANOTHER_CREATOR" && error?.status === 409,
  );
});

test("V20.19 dedicated ownership: Direct mode keeps the creator-owned proxy reserved", async () => {
  const { db } = makeDb();
  const a1 = await setCreatorNetworkProfile({ db, agencyId: "agency-1", actorMember: ownerActor, creatorId: "creator-a", expectedVersion: 0, mode: "PROXY", proxyEndpointId: "proxy-1" });
  const a2 = await setCreatorNetworkProfile({ db, agencyId: "agency-1", actorMember: ownerActor, creatorId: "creator-a", expectedVersion: a1.profile.version, mode: "DIRECT", proxyEndpointId: null });
  assert.equal(a2.profile.mode, "DIRECT");
  await assert.rejects(
    setCreatorNetworkProfile({ db, agencyId: "agency-1", actorMember: ownerActor, creatorId: "creator-b", expectedVersion: 0, mode: "PROXY", proxyEndpointId: "proxy-1" }),
    (error) => error?.code === "PROXY_OWNED_BY_ANOTHER_CREATOR" && error?.status === 409,
  );
});

test("V20.18 dedicated proxy is enforced by Prisma schema and migration", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260823140000_creator_network_profiles/migration.sql"), "utf8");
  const relationFixMigration = fs.readFileSync(path.join(root, "prisma/migrations/20260823174500_creator_network_profile_composite_relation_keys/migration.sql"), "utf8");
  assert.match(schema, /@@unique\(\[agencyId, creatorId\], map: "CreatorNetworkProfile_agencyId_creatorId_key"\)/);
  assert.match(schema, /@@unique\(\[agencyId, proxyEndpointId\], map: "CreatorNetworkProfile_agencyId_proxyEndpointId_key"\)/);
  assert.match(schema, /creatorProfile\s+CreatorNetworkProfile\?/);
  assert.match(schema, /@@unique\(\[agencyId, id\]\)/);
  assert.match(schema, /fields:\s*\[agencyId, proxyEndpointId\][\s\S]*references:\s*\[agencyId, id\]/);
  assert.match(relationFixMigration, /CREATE UNIQUE INDEX "CreatorNetworkProfile_agencyId_proxyEndpointId_key"\s+ON "CreatorNetworkProfile"\("agencyId", "proxyEndpointId"\);/);
  assert.match(migration, /FOREIGN KEY \(\"agencyId\", \"proxyEndpointId\"\) REFERENCES \"AgencyProxyEndpoint\"\(\"agencyId\", \"id\"\)/);
});
