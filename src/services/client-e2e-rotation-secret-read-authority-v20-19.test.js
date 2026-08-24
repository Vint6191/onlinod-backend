"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getRootRotationBridge, getCreatorRotationPlan } = require("./client-e2e-keyring-service");

const owner = { agencyId: "agency-1", userId: "owner-user", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null };
const worker = { ...owner, role: "WORKER", roleKey: "chatter", assignedCreators: ["creator-1"] };

function makeView(member, marker) {
  return {
    agencyMember: {
      findUnique: async () => ({ ...member }),
      findMany: async () => [
        { ...member },
        { agencyId: "agency-1", userId: "worker-user", role: "WORKER", roleKey: "chatter", assignedCreators: ["creator-1"], deletedAt: null, deactivatedAt: null },
      ],
    },
    deviceCryptoIdentity: {
      findUnique: async () => ({ deviceId: "owner-device", agencyId: "agency-1", userId: "owner-user", status: "ACTIVE", revokedAt: null, publicKey: "pk", fingerprint: "fp" }),
      findMany: async () => [{ deviceId: "worker-device", agencyId: "agency-1", userId: "worker-user", status: "ACTIVE", revokedAt: null, publicKey: "worker-pk", fingerprint: "worker-fp" }],
    },
    agencyCryptoRoot: { findUnique: async () => ({ agencyId: "agency-1", version: 2, status: "ACTIVE", recoveryProofHash: "proof" }) },
    agencyCryptoOwnerKeyWrap: { findFirst: async () => ({ id: "owner-wrap", agencyId: "agency-1", rootVersion: 2, deviceId: "owner-device", revokedAt: null }) },
    agencyCryptoRootBridge: {
      findUnique: async () => ({ agencyId: "agency-1", fromVersion: 1, toVersion: 2, retiredAt: null, ciphertext: `${marker}-bridge`, iv: "iv", tag: "tag", algorithm: "aes-256-gcm-root-bridge-v1" }),
    },
    creatorAccount: { findFirst: async () => ({ id: "creator-1", displayName: "Creator", username: "creator" }) },
    creatorCryptoKeyState: { findUnique: async () => ({ agencyId: "agency-1", creatorId: "creator-1", activeVersion: 1, rootVersion: 1 }) },
    creatorSessionState: { findUnique: async () => ({ id: "session-1", agencyId: "agency-1", creatorId: "creator-1", status: "ACTIVE", revision: 7, payloadVersion: 1, encryptionMode: "CLIENT_E2E_V1", keyVersion: 1, encryptedPayload: `${marker}-session`, iv: "iv", tag: "tag", algorithm: "aes-256-gcm-client-e2e-v1" }) },
    agencyProxyEndpoint: { findFirst: async () => ({ id: "proxy-1", agencyId: "agency-1", ownerCreatorId: "creator-1", version: 4, hasCredentials: true, encryptionMode: "CLIENT_E2E_V1", keyVersion: 1, encryptedPayload: `${marker}-proxy`, iv: "iv", tag: "tag", algorithm: "aes-256-gcm-client-e2e-v1", usernameHint: "u***" }) },
    creatorNetworkProfile: { findUnique: async () => ({ id: "profile-1", agencyId: "agency-1", creatorId: "creator-1", mode: "PROXY", proxyEndpointId: "proxy-1", version: 3 }) },
  };
}

function raceDb() {
  const outer = makeView(owner, "outer");
  const tx = makeView(worker, "tx");
  outer.$transaction = async (fn) => fn(tx);
  return outer;
}

test("root rotation bridge must not be returned from a stale OWNER snapshot after live demotion", async () => {
  const db = raceDb();
  await assert.rejects(
    () => getRootRotationBridge({ db, agencyId: "agency-1", userId: "owner-user", member: owner, actorDeviceId: "owner-device", fromVersion: 1 }),
    (error) => error?.code === "CRYPTO_OWNER_REQUIRED" && error?.status === 403,
  );
});

test("creator rotation secret plan must not be returned from a stale OWNER snapshot after live demotion", async () => {
  const db = raceDb();
  await assert.rejects(
    () => getCreatorRotationPlan({ db, agencyId: "agency-1", userId: "owner-user", member: owner, actorDeviceId: "owner-device", creatorId: "creator-1" }),
    (error) => error?.code === "CRYPTO_OWNER_REQUIRED" && error?.status === 403,
  );
});
