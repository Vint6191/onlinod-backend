"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { transactionClient } = require("../../test/helpers/prisma-transaction-client");
const { registerDeviceIdentity } = require("./client-e2e-keyring-service");
const key = () => crypto.generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");

function fixture() {
  const state = { devices: new Map(), identities: new Map(), active: true, history: false, failIdentity: false, commits: 0 };
  const db = {
    async $transaction(work, options) {
      assert.equal(options.isolationLevel, "Serializable");
      const before = structuredClone(state);
      try { const result = await work(transactionClient(db)); state.commits++; return result; }
      catch (error) { Object.assign(state, before); throw error; }
    },
    agencyMember: { findFirst: async ({ where }) => {
      assert.deepEqual(where.user, { is: { disabledAt: null } });
      assert.deepEqual(where.agency, { is: { deletedAt: null } });
      assert.equal(where.deletedAt, null); assert.equal(where.deactivatedAt, null);
      return state.active ? { id: "member", agencyId: "agency", userId: "user", role: "WORKER" } : null;
    } },
    workerDevice: {
      findUnique: async ({ where }) => structuredClone(state.devices.get(where.id) || null),
      create: async ({ data }) => { assert.equal(state.devices.has(data.id), false); state.devices.set(data.id, structuredClone(data)); return data; },
      update: async ({ where, data }) => Object.assign(state.devices.get(where.id), data),
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => structuredClone(state.identities.get(where.agencyId_deviceId.deviceId) || null),
      create: async ({ data }) => {
        if (state.failIdentity) throw Object.assign(new Error("identity conflict"), { code: "P2002" });
        const identity = { ...data, registeredAt: new Date(), updatedAt: new Date(), revokedAt: null, activatedAt: null };
        state.identities.set(data.deviceId, identity); return structuredClone(identity);
      },
    },
    agencyCryptoOwnerKeyWrap: { findFirst: async () => state.history ? { id: "old-wrap" } : null },
    creatorDeviceKeyWrap: { findFirst: async () => null },
  };
  const input = { db, agencyId: "agency", userId: "user", deviceId: "pc", publicKey: key() };
  return { state, db, input, enroll: patch => registerDeviceIdentity({ ...input, ...patch }) };
}

test("a first device registers atomically before any worker heartbeat and gains no key approval or liveness", async () => {
  const f = fixture(), result = await f.enroll();
  assert.equal(result.idempotent, false); assert.equal(result.identity.status, "PENDING");
  assert.deepEqual(f.state.devices.get("pc"), { id: "pc", agencyId: "agency", userId: "user" });
  assert.equal(f.state.commits, 1); assert.equal(f.state.identities.size, 1);
});
test("registration replay leaves worker heartbeat telemetry and creator bindings untouched", async () => {
  const f = fixture(); await f.enroll();
  const device = { id: "pc", agencyId: "agency", userId: "user", deviceName: "PC", platform: "win32", lastSeenAt: new Date(1234), creatorBindings: [{ creatorId: "creator", sessionReadReady: true }] };
  f.state.devices.set("pc", structuredClone(device));
  const before = structuredClone(f.state.identities); assert.equal((await f.enroll()).idempotent, true);
  assert.deepEqual(f.state.devices.get("pc"), device); assert.deepEqual(f.state.identities, before);
});
test("an inactive member cannot create either device record", async () => {
  const f = fixture(); f.state.active = false;
  await assert.rejects(f.enroll(), { code: "CRYPTO_MEMBER_INACTIVE" });
  assert.equal(f.state.devices.size + f.state.identities.size, 0);
});
test("a device owned by another user cannot be taken over during enrollment", async () => {
  const f = fixture(), device = { id: "pc", agencyId: "other", userId: "other" }; f.state.devices.set("pc", device);
  await assert.rejects(f.enroll(), { code: "CRYPTO_DEVICE_USER_MISMATCH" });
  assert.deepEqual(f.state.devices.get("pc"), device); assert.equal(f.state.identities.size, 0);
});
test("a pinned public key cannot be replaced by a later enrollment", async () => {
  const f = fixture(); await f.enroll(); const before = structuredClone(f.state);
  await assert.rejects(f.enroll({ publicKey: key() }), { code: "CRYPTO_DEVICE_KEY_IMMUTABLE" });
  assert.deepEqual(f.state, before);
});
test("revocation is enforced even if status still says ACTIVE and the worker row is missing", async () => {
  const f = fixture(); await f.enroll(); Object.assign(f.state.identities.get("pc"), { status: "ACTIVE", revokedAt: new Date() }); f.state.devices.clear();
  await assert.rejects(f.enroll(), { code: "CRYPTO_DEVICE_REVOKED" }); assert.equal(f.state.devices.size, 0);
});
test("historical wraps prevent rebinding an orphan device identity", async () => {
  const f = fixture(); f.state.history = true;
  await assert.rejects(f.enroll(), { code: "CRYPTO_DEVICE_ID_REUSE_FORBIDDEN" });
  assert.equal(f.state.devices.size + f.state.identities.size, 0);
});
test("a failed key insert rolls back the newly registered worker device", async () => {
  const f = fixture(); f.state.failIdentity = true;
  await assert.rejects(f.enroll(), { code: "P2002" });
  assert.equal(f.state.devices.size + f.state.identities.size, 0); assert.equal(f.state.commits, 0);
});
