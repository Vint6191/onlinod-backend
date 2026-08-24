"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getDeviceRevocationPlan,
  getRootRotationPlan,
  getRootRotationProgress,
} = require("./client-e2e-keyring-service");

const staleOwner = {
  agencyId: "agency-1",
  userId: "owner-user",
  role: "OWNER",
  roleKey: "owner",
  assignedCreators: null,
  deletedAt: null,
  deactivatedAt: null,
};
const liveWorker = { ...staleOwner, role: "WORKER", roleKey: "chatter", assignedCreators: [] };
const ownerIdentity = {
  id: "identity-owner",
  deviceId: "owner-device",
  agencyId: "agency-1",
  userId: "owner-user",
  status: "ACTIVE",
  revokedAt: null,
  publicKey: "owner-pk",
  fingerprint: "owner-fp",
};

function outerDb() {
  const tx = {
    agencyMember: {
      findUnique: async () => ({ ...liveWorker }),
    },
  };
  const db = {
    $transaction: async (fn) => fn(tx),
    agencyMember: {
      findUnique: async () => ({ ...staleOwner }),
      findMany: async () => [{ ...staleOwner }],
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => {
        const deviceId = where?.agencyId_deviceId?.deviceId;
        if (deviceId === "owner-device") return { ...ownerIdentity };
        if (deviceId === "target-device") return {
          id: "identity-target",
          deviceId: "target-device",
          agencyId: "agency-1",
          userId: "target-user",
          status: "ACTIVE",
          revokedAt: null,
          publicKey: "target-pk",
          fingerprint: "target-fp",
        };
        return null;
      },
      findMany: async () => [{ ...ownerIdentity }],
    },
    agencyCryptoRoot: {
      findUnique: async () => ({ agencyId: "agency-1", version: 1, status: "ACTIVE" }),
    },
    agencyCryptoOwnerKeyWrap: {
      findFirst: async () => ({ id: "owner-wrap" }),
      findMany: async () => [],
    },
    creatorAccount: {
      findMany: async () => [],
    },
    creatorCryptoKeyState: {
      findFirst: async () => null,
      findMany: async () => [],
      count: async () => 0,
    },
    creatorDeviceKeyWrap: {
      findMany: async () => [],
    },
    agencyCryptoRootBridge: {
      findFirst: async () => null,
    },
  };
  return db;
}

async function expectFreshOwnerRejection(operation) {
  await assert.rejects(
    operation(outerDb()),
    (error) => error?.code === "CRYPTO_OWNER_REQUIRED" || error?.code === "CRYPTO_APPROVER_INACTIVE",
  );
}

test("device revocation plan is read from a fresh OWNER snapshot", async () => {
  await expectFreshOwnerRejection((db) => getDeviceRevocationPlan({
    db,
    agencyId: "agency-1",
    userId: "owner-user",
    member: staleOwner,
    actorDeviceId: "owner-device",
    targetDeviceId: "target-device",
  }));
});

test("root rotation plan is read from a fresh OWNER snapshot", async () => {
  await expectFreshOwnerRejection((db) => getRootRotationPlan({
    db,
    agencyId: "agency-1",
    userId: "owner-user",
    member: staleOwner,
    actorDeviceId: "owner-device",
  }));
});

test("root rotation progress is read from a fresh OWNER snapshot", async () => {
  await expectFreshOwnerRejection((db) => getRootRotationProgress({
    db,
    agencyId: "agency-1",
    userId: "owner-user",
    member: staleOwner,
    actorDeviceId: "owner-device",
  }));
});
