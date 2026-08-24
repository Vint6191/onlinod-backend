"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getRecoveryEnvelope,
  pendingDevices,
  getDeviceApprovalPlan,
} = require("./client-e2e-keyring-service");

const staleOwner = { agencyId: "agency-1", userId: "owner-user", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null };
const liveWorker = { ...staleOwner, role: "WORKER", roleKey: "chatter", assignedCreators: ["creator-1"] };

function txDb(extra = {}) {
  const db = {
    $transaction: async (fn) => fn(db),
    agencyMember: {
      findUnique: async ({ where }) => {
        const key = where?.agencyId_userId || {};
        if (key.agencyId === "agency-1" && key.userId === "owner-user") return { ...liveWorker };
        if (key.agencyId === "agency-1" && key.userId === "target-user") return { agencyId: "agency-1", userId: "target-user", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null };
        return null;
      },
      findMany: async () => [],
    },
    ...extra,
  };
  return db;
}

test("recovery envelope rechecks live OWNER authority instead of trusting stale request membership", async () => {
  const db = txDb({
    agencyCryptoRoot: {
      findUnique: async () => ({
        agencyId: "agency-1", version: 1, status: "ACTIVE",
        recoveryCiphertext: "cipher", recoveryIv: "iv", recoveryTag: "tag",
        recoveryAlgorithm: "aes-256-gcm-recovery-v1", recoveryFormatVersion: 1,
      }),
    },
  });
  await assert.rejects(
    getRecoveryEnvelope({ db, agencyId: "agency-1", userId: "owner-user", member: staleOwner }),
    (error) => error?.code === "CRYPTO_APPROVER_INACTIVE" || error?.code === "CRYPTO_OWNER_REQUIRED",
  );
});

test("pending crypto device inventory rechecks live OWNER authority", async () => {
  const db = txDb({
    deviceCryptoIdentity: { findMany: async () => [] },
    workerDevice: { findMany: async () => [] },
  });
  await assert.rejects(
    pendingDevices({ db, agencyId: "agency-1", userId: "owner-user", member: staleOwner }),
    (error) => error?.code === "CRYPTO_APPROVER_INACTIVE" || error?.code === "CRYPTO_OWNER_REQUIRED",
  );
});

test("device approval plan rechecks live OWNER authority before provisioning metadata is returned", async () => {
  const db = txDb({
    deviceCryptoIdentity: {
      findUnique: async () => ({ deviceId: "target-device", agencyId: "agency-1", userId: "target-user", status: "PENDING", revokedAt: null, publicKey: "pk", fingerprint: "fp" }),
    },
    agencyCryptoRoot: { findUnique: async () => ({ agencyId: "agency-1", version: 1, status: "ACTIVE" }) },
  });
  await assert.rejects(
    getDeviceApprovalPlan({ db, agencyId: "agency-1", userId: "owner-user", member: staleOwner, targetDeviceId: "target-device" }),
    (error) => error?.code === "CRYPTO_APPROVER_INACTIVE" || error?.code === "CRYPTO_OWNER_REQUIRED",
  );
});
