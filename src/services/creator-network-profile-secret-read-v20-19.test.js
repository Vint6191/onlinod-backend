"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getCreatorNetworkRuntime, getProxyTestMaterial } = require("./creator-network-profile-service");

const staleMember = {
  id: "member-1", userId: "user-1", agencyId: "agency-1", role: "CHATTER", roleKey: "chatter",
  assignedCreators: ["creator-1"], permissions: { "creators.manage": true }, deletedAt: null, deactivatedAt: null,
};
const accessRevokedMember = { ...staleMember, assignedCreators: [] };
const managementRevokedMember = { ...staleMember, permissions: { "creators.manage": false } };

function proxy({ ownerCreatorId = "creator-1", hasCredentials = false } = {}) {
  return {
    id: "proxy-1", agencyId: "agency-1", label: "P1", type: "SOCKS5", host: "proxy.test", port: 1080,
    enabled: true, version: 7, ownerCreatorId, encryptionMode: "CLIENT_E2E_V1", keyVersion: hasCredentials ? 1 : null,
    hasCredentials, usernameHint: hasCredentials ? "alice" : null,
    encryptedPayload: hasCredentials ? Buffer.alloc(32, 0x55).toString("base64") : null,
    iv: hasCredentials ? Buffer.alloc(12, 0x11).toString("base64") : null,
    tag: hasCredentials ? Buffer.alloc(16, 0x22).toString("base64") : null,
    algorithm: hasCredentials ? "aes-256-gcm-client-e2e-v1" : null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeDb({ shared = false, managementRevoked = false, hasCredentials = false } = {}) {
  const endpoint = proxy({ ownerCreatorId: shared ? null : "creator-1", hasCredentials });
  const profile = { id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "PROXY", proxyEndpointId: "proxy-1", version: 3, updatedAt: new Date() };
  const creator = { id: "creator-1", agencyId: "agency-1", displayName: "A", username: "a", status: "READY", deletedAt: null };
  const tx = {
    agencyMember: { async findUnique() { return structuredClone(managementRevoked ? managementRevokedMember : accessRevokedMember); } },
    creatorAccount: {
      async findFirst({ where, select }) {
        if (where.id !== creator.id || where.agencyId !== creator.agencyId || creator.deletedAt !== null) return null;
        if (select?.networkProfile) return { ...structuredClone(creator), networkProfile: { ...structuredClone(profile), proxyEndpoint: structuredClone(endpoint) } };
        return structuredClone(creator);
      },
    },
    creatorNetworkProfile: { async findUnique() { return structuredClone(profile); } },
    agencyProxyEndpoint: {
      async findFirst({ where, select }) {
        if (where.id !== endpoint.id || where.agencyId !== endpoint.agencyId) return null;
        if (select) return { id: endpoint.id, ownerCreatorId: endpoint.ownerCreatorId, creatorProfile: structuredClone(profile) };
        return { ...structuredClone(endpoint), creatorProfile: structuredClone(profile) };
      },
      async findUnique({ where }) { return where.id === endpoint.id ? structuredClone(endpoint) : null; },
    },
  };
  const db = { ...tx, async $transaction(fn) { return fn(tx); } };
  return { db };
}

test("V20.22 creator runtime opaque-secret read rechecks live creator access in the Serializable snapshot", async () => {
  const { db } = makeDb({ hasCredentials: true });
  await assert.rejects(
    getCreatorNetworkRuntime({ db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-1", member: staleMember, userId: "user-1" }),
    (error) => error?.code === "PROXY_CREATOR_ACCESS_REVOKED" && error?.status === 403,
  );
});

test("V20.22 proxy test-material rechecks live creator-management authority before returning opaque material", async () => {
  const { db } = makeDb({ shared: true, managementRevoked: true });
  await assert.rejects(
    getProxyTestMaterial({ db, agencyId: "agency-1", proxyId: "proxy-1", deviceId: "device-1", member: staleMember, userId: "user-1" }),
    (error) => error?.code === "PROXY_MANAGEMENT_REVOKED" && error?.status === 403,
  );
});

test("V20.22 proxy secret routes pass authenticated userId into transactional service reads", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/network-profiles.js"), "utf8");
  assert.match(route, /getCreatorNetworkRuntime\([\s\S]*?userId:\s*req\.auth\.userId/);
  assert.match(route, /getProxyTestMaterial\([\s\S]*?userId:\s*req\.auth\.userId/);
  assert.doesNotMatch(route, /migration-material|migrate-credentials/);
});

test("V20.22 secret read contains no server-side proxy decrypt or migration path", () => {
  const source = fs.readFileSync(path.join(__dirname, "creator-network-profile-service.js"), "utf8");
  assert.doesNotMatch(source, /decryptServerProxyCredentials|migrateProxyCredentialsToOpaque|getProxyCredentialMigrationMaterial/);
  assert.match(source, /await assertDeviceCanUseCreatorKey/);
  assert.match(source, /opaqueProxyCredentialEnvelope/);
});
