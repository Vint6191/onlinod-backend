"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDesktopSecretDelta } = require("./desktop-secret-delta-service");

function sessionState() {
  return {
    agencyId: "agency-1", creatorId: "creator-a", revision: 16, status: "ACTIVE", payloadVersion: 1, portableReady: true,
    encryptionMode: "CLIENT_E2E_V1", keyVersion: 2, encryptedPayload: "cipher-session", iv: "iv-session", tag: "tag-session",
    algorithm: "aes-256-gcm-client-e2e-v1", platformUserId: "100", credentialHash: "c".repeat(64), coherenceHash: "d".repeat(64),
    capturedAt: new Date("2026-08-27T10:00:00Z"), capturedByDeviceId: "device-1", sourceRequestId: "req-session", revokedAt: null, updatedAt: new Date("2026-08-27T10:00:00Z"),
  };
}

function proxy() {
  return {
    id: "proxy-b", agencyId: "agency-1", ownerCreatorId: "creator-b", label: "B", type: "SOCKS5", host: "127.0.0.2", port: 1080,
    enabled: true, version: 7, hasCredentials: true, usernameHint: "u***", encryptionMode: "CLIENT_E2E_V1", keyVersion: 2,
    encryptedPayload: "cipher-proxy", iv: "iv-proxy", tag: "tag-proxy", algorithm: "aes-256-gcm-client-e2e-v1",
  };
}

function fakeDb() {
  const counts = new Map();
  const hit = (name) => counts.set(name, (counts.get(name) || 0) + 1);
  const member = { id: "member-1", agencyId: "agency-1", userId: "user-1", role: "OWNER", roleKey: "owner", deletedAt: null, deactivatedAt: null };
  const rows = [
    {
      id: "creator-a", agencyId: "agency-1", displayName: "A", username: "a", remoteId: "100", status: "READY",
      sessionState: sessionState(), cryptoKeyState: { activeVersion: 2, rootVersion: 1 },
      networkProfile: { creatorId: "creator-a", mode: "DIRECT", proxyEndpointId: null, version: 3, updatedAt: new Date(), proxyEndpoint: null },
    },
    {
      id: "creator-b", agencyId: "agency-1", displayName: "B", username: "b", remoteId: "200", status: "READY",
      sessionState: null, cryptoKeyState: { activeVersion: 2, rootVersion: 1 },
      networkProfile: { creatorId: "creator-b", mode: "PROXY", proxyEndpointId: "proxy-b", version: 9, updatedAt: new Date(), proxyEndpoint: proxy() },
    },
  ];
  const tx = {
    agencyMember: { findUnique: async () => { hit("member"); return member; } },
    creatorAccount: { findMany: async () => { hit("creators"); return rows; } },
    deviceCryptoIdentity: { findUnique: async () => { hit("identity"); return { agencyId: "agency-1", deviceId: "device-1", userId: "user-1", status: "ACTIVE", revokedAt: null }; } },
    agencyCryptoRoot: { findUnique: async () => { hit("root"); return { agencyId: "agency-1", version: 1, status: "ACTIVE" }; } },
    agencyCryptoOwnerKeyWrap: { findMany: async () => { hit("ownerWraps"); return [{ rootVersion: 1 }]; } },
    agencyCryptoRootBridge: { findMany: async () => { hit("bridges"); return []; } },
    creatorDeviceKeyWrap: { findMany: async () => { hit("creatorWraps"); return []; } },
  };
  const db = { $transaction: async (work) => work(tx) };
  return { db, counts };
}

test("F batch secret delta reads multiple creator components with fixed query fanout", async () => {
  const { db, counts } = fakeDb();
  const result = await buildDesktopSecretDelta({
    db, agencyId: "agency-1", userId: "user-1", deviceId: "device-1", member: { userId: "user-1" },
    requests: [
      { creatorId: "creator-a", session: true, network: false },
      { creatorId: "creator-b", session: false, network: true },
    ],
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].session.revision, 16);
  assert.equal(result.items[0].session.opaquePayload.ciphertext, "cipher-session");
  assert.equal(result.items[1].network.mode, "PROXY");
  assert.equal(result.items[1].network.proxy.opaqueCredentials.ciphertext, "cipher-proxy");
  assert.equal(result.items[1].network.proxy.username, null);
  assert.equal(result.items[1].network.proxy.password, null);
  assert.deepEqual(Object.fromEntries(counts), { member: 1, creators: 1, identity: 1, root: 1, ownerWraps: 1 });
});

test("F duplicate creator requests are merged before database work", async () => {
  const { db } = fakeDb();
  const result = await buildDesktopSecretDelta({
    db, agencyId: "agency-1", userId: "user-1", deviceId: "device-1", member: { userId: "user-1" },
    requests: [
      { creatorId: "creator-a", session: true },
      { creatorId: "creator-a", network: true },
    ],
  });
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].session);
  assert.equal(result.items[0].network.mode, "DIRECT");
});
