"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getCreatorNetworkRuntime,
  getProxyCredentialMigrationMaterial,
  getProxyTestMaterial,
} = require("./creator-network-profile-service");
const { serverEncryptedProxyCredentials } = require("./proxy-credentials");

const staleMember = {
  id: "member-1", userId: "user-1", agencyId: "agency-1", role: "CHATTER", roleKey: "chatter",
  assignedCreators: ["creator-1"], permissions: { "creators.manage": true }, deletedAt: null, deactivatedAt: null,
};
const accessRevokedMember = { ...staleMember, assignedCreators: [] };
const managementRevokedMember = { ...staleMember, permissions: { "creators.manage": false } };

function legacyProxy({ ownerCreatorId = "creator-1" } = {}) {
  return {
    id: "proxy-1", agencyId: "agency-1", label: "P1", type: "SOCKS5", host: "proxy.test", port: 1080,
    enabled: true, version: 7, ownerCreatorId, createdAt: new Date(), updatedAt: new Date(),
    ...serverEncryptedProxyCredentials("SOCKS5", { username: "alice", password: "secret" }),
  };
}

function makeDb({ shared = false, managementRevoked = false } = {}) {
  const proxy = legacyProxy({ ownerCreatorId: shared ? null : "creator-1" });
  const profile = { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "PROXY", proxyEndpointId: "proxy-1", version: 3, updatedAt: new Date() };
  const creator = { id: "creator-1", agencyId: "agency-1", displayName: "A", username: "a", status: "READY", deletedAt: null };
  const tx = {
    agencyMember: { async findUnique() { return structuredClone(managementRevoked ? managementRevokedMember : accessRevokedMember); } },
    creatorAccount: {
      async findFirst({ where, select }) {
        if (where.id !== creator.id || where.agencyId !== creator.agencyId || creator.deletedAt !== null) return null;
        if (select?.networkProfile) return { ...structuredClone(creator), networkProfile: { ...structuredClone(profile), proxyEndpoint: structuredClone(proxy) } };
        return structuredClone(creator);
      },
    },
    creatorNetworkProfile: {
      async findUnique() { return structuredClone(profile); },
    },
    agencyProxyEndpoint: {
      async findFirst({ where, select }) {
        if (where.id !== proxy.id || where.agencyId !== proxy.agencyId) return null;
        if (select) return { id: proxy.id, ownerCreatorId: proxy.ownerCreatorId, creatorProfile: structuredClone(profile) };
        return { ...structuredClone(proxy), creatorProfile: structuredClone(profile) };
      },
      async findUnique({ where }) { return where.id === proxy.id ? structuredClone(proxy) : null; },
    },
    agencyCryptoRoot: { async findUnique() { return { agencyId: "agency-1", version: 1, status: "ACTIVE", enforceOpaqueSecrets: false }; } },
  };
  const db = { ...tx, async $transaction(fn) { return fn(tx); } };
  return { db };
}

test("V20.19 creator runtime secret read rechecks live creator access in the Serializable snapshot", async () => {
  const { db } = makeDb();
  await assert.rejects(
    getCreatorNetworkRuntime({ db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-1", member: staleMember, userId: "user-1" }),
    (error) => error?.code === "PROXY_CREATOR_ACCESS_REVOKED" && error?.status === 403,
  );
});

test("V20.19 proxy migration material rechecks live creator access before legacy decrypt", async () => {
  const { db } = makeDb();
  await assert.rejects(
    getProxyCredentialMigrationMaterial({ db, agencyId: "agency-1", creatorId: "creator-1", proxyId: "proxy-1", member: staleMember, userId: "user-1" }),
    (error) => error?.code === "PROXY_CREATOR_ACCESS_REVOKED" && error?.status === 403,
  );
});

test("V20.19 proxy test-material rechecks live creator-management authority before legacy decrypt", async () => {
  const { db } = makeDb({ shared: true, managementRevoked: true });
  await assert.rejects(
    getProxyTestMaterial({ db, agencyId: "agency-1", proxyId: "proxy-1", deviceId: "device-1", member: staleMember, userId: "user-1" }),
    (error) => error?.code === "PROXY_MANAGEMENT_REVOKED" && error?.status === 403,
  );
});

test("V20.19 proxy secret routes pass authenticated userId into transactional service reads", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/network-profiles.js"), "utf8");
  assert.match(route, /getCreatorNetworkRuntime\([\s\S]*?userId:\s*req\.auth\.userId/);
  assert.match(route, /getProxyCredentialMigrationMaterial\([\s\S]*?userId:\s*req\.auth\.userId/);
  assert.match(route, /getProxyTestMaterial\([\s\S]*?userId:\s*req\.auth\.userId/);
});

test("V20.19 proxy opaque migration authorizes current CDK access before decrypting legacy credentials", () => {
  const source = fs.readFileSync(path.join(__dirname, "creator-network-profile-service.js"), "utf8");
  const start = source.indexOf("async function migrateProxyCredentialsToOpaque");
  const block = source.slice(start, source.indexOf("module.exports", start));
  const authorize = block.indexOf("await assertDeviceCanUseCreatorKey");
  const decrypt = block.indexOf("decryptServerProxyCredentials(proxy)");
  assert.ok(authorize >= 0 && decrypt >= 0 && authorize < decrypt, "fresh CDK/device authorization must precede legacy proxy decrypt");
});
