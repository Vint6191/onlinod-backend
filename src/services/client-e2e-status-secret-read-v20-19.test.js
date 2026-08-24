"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getCryptoStatus } = require("./client-e2e-keyring-service");

const owner = { agencyId: "agency-1", userId: "user-1", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null };
const workerWithCreator = { agencyId: "agency-1", userId: "user-1", role: "WORKER", roleKey: "chatter", assignedCreators: ["creator-1"], deletedAt: null, deactivatedAt: null };
const workerNoCreator = { ...workerWithCreator, assignedCreators: [] };
const inactiveOwner = { ...owner, deactivatedAt: new Date("2026-08-24T12:00:00Z") };

function view(member, options = {}) {
  const identity = options.identity || { deviceId: "device-1", agencyId: "agency-1", userId: "user-1", status: "ACTIVE", revokedAt: null, publicKey: "pk", fingerprint: "fp", algorithm: "x25519" };
  const rootVersion = Number(options.rootVersion || 1);
  const ownerCiphertext = options.ownerCiphertext || `wrapped-amk-v${rootVersion}`;
  const creatorKeyVersion = Number(options.creatorKeyVersion || 1);
  const creatorCiphertext = options.creatorCiphertext || `wrapped-cdk-v${creatorKeyVersion}`;
  return {
    agencyMember: { findUnique: async () => ({ ...member }) },
    deviceCryptoIdentity: { findUnique: async () => ({ ...identity }) },
    agencyCryptoRoot: { findUnique: async () => ({ agencyId: "agency-1", version: rootVersion, status: "ACTIVE", enforceOpaqueSecrets: true }) },
    agencyCryptoOwnerKeyWrap: {
      findFirst: async ({ where }) => where?.deviceId === "device-1" ? { id: `ow-${rootVersion}`, agencyId: "agency-1", rootVersion, deviceId: "device-1", revokedAt: null, ciphertext: ownerCiphertext } : null,
      findMany: async ({ where }) => where?.deviceId === "device-1" ? [{ id: `ow-${rootVersion}`, agencyId: "agency-1", rootVersion, deviceId: "device-1", revokedAt: null, ciphertext: ownerCiphertext }] : [],
    },
    creatorAccount: {
      findMany: async ({ where }) => {
        const requested = Array.isArray(where?.id?.in) ? where.id.in.map(String) : [];
        return requested.includes("creator-1") && options.creatorDeleted !== true ? [{ id: "creator-1" }] : [];
      },
    },
    creatorDeviceKeyWrap: {
      findMany: async ({ where }) => {
        const allowed = where?.creatorId?.in;
        if (Array.isArray(allowed) && !allowed.includes("creator-1")) return [];
        return [{ id: `cw-${creatorKeyVersion}`, agencyId: "agency-1", creatorId: "creator-1", keyVersion: creatorKeyVersion, deviceId: "device-1", revokedAt: null, ciphertext: creatorCiphertext }];
      },
    },
  };
}

function raceDb(staleMember, liveMember, outerOptions = {}, txOptions = {}) {
  const outer = view(staleMember, outerOptions);
  const tx = view(liveMember, txOptions);
  outer.$transaction = async (fn) => fn(tx);
  return outer;
}

test("crypto status must not return an AMK wrap from a stale OWNER snapshot after live demotion", async () => {
  const db = raceDb(owner, workerWithCreator);
  const status = await getCryptoStatus({ db, agencyId: "agency-1", userId: "user-1", member: owner, deviceId: "device-1" });
  assert.equal(status.ownerWrap, null);
  assert.deepEqual(status.ownerWraps, []);
});

test("crypto status must not return a CDK wrap after creator access is removed in the authoritative snapshot", async () => {
  const db = raceDb(workerWithCreator, workerNoCreator);
  const status = await getCryptoStatus({ db, agencyId: "agency-1", userId: "user-1", member: workerWithCreator, deviceId: "device-1" });
  assert.deepEqual(status.creatorWraps, []);
});

test("crypto status rejects a member deactivated after route authorization", async () => {
  const db = raceDb(owner, inactiveOwner);
  await assert.rejects(
    () => getCryptoStatus({ db, agencyId: "agency-1", userId: "user-1", member: owner, deviceId: "device-1" }),
    (error) => error?.code === "CRYPTO_MEMBER_INACTIVE" && error?.status === 403,
  );
});

test("crypto status rejects a device revoked after route authorization", async () => {
  const revokedIdentity = { deviceId: "device-1", agencyId: "agency-1", userId: "user-1", status: "REVOKED", revokedAt: new Date("2026-08-24T12:00:00Z"), publicKey: "pk", fingerprint: "fp", algorithm: "x25519" };
  const db = raceDb(owner, owner, {}, { identity: revokedIdentity });
  await assert.rejects(
    () => getCryptoStatus({ db, agencyId: "agency-1", userId: "user-1", member: owner, deviceId: "device-1" }),
    (error) => error?.code === "CRYPTO_DEVICE_REVOKED" && error?.status === 403,
  );
});

test("crypto status returns root and AMK wrap from the same serializable snapshot", async () => {
  const db = raceDb(owner, owner,
    { rootVersion: 2, ownerCiphertext: "outer-v2" },
    { rootVersion: 1, ownerCiphertext: "tx-v1" },
  );
  const status = await getCryptoStatus({ db, agencyId: "agency-1", userId: "user-1", member: owner, deviceId: "device-1" });
  assert.equal(status.root.version, 1);
  assert.equal(status.ownerWrap.rootVersion, 1);
  assert.equal(status.ownerWrap.ciphertext, "tx-v1");
});

test("crypto status returns creator wraps from the same serializable authority snapshot", async () => {
  const db = raceDb(workerWithCreator, workerWithCreator,
    { creatorKeyVersion: 2, creatorCiphertext: "outer-cdk-v2" },
    { creatorKeyVersion: 1, creatorCiphertext: "tx-cdk-v1" },
  );
  const status = await getCryptoStatus({ db, agencyId: "agency-1", userId: "user-1", member: workerWithCreator, deviceId: "device-1" });
  assert.equal(status.creatorWraps.length, 1);
  assert.equal(status.creatorWraps[0].keyVersion, 1);
  assert.equal(status.creatorWraps[0].ciphertext, "tx-cdk-v1");
});
