"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { registerDeviceIdentity, pendingDevices } = require("./client-e2e-keyring-service");

function publicKey() {
  const pair = crypto.generateKeyPairSync("x25519");
  return Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64");
}

test("V20.19 DeviceCryptoIdentity is agency-scoped instead of globally keyed by physical device id", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260823210000_client_e2e_device_identity_agency_scope/migration.sql"), "utf8");
  const model = schema.slice(schema.indexOf("model DeviceCryptoIdentity"), schema.indexOf("model AgencyCryptoRoot"));
  assert.match(model, /deviceId\s+String\s*\n/);
  assert.doesNotMatch(model, /deviceId\s+String\s+@id/);
  assert.match(model, /userId\s+String/);
  assert.match(model, /@@id\(\[agencyId, deviceId\]\)/);
  assert.match(model, /@@index\(\[agencyId, userId\]\)/);
  assert.doesNotMatch(schema, /cryptoIdentities\s+DeviceCryptoIdentity\[\]/, "crypto identity lifecycle must not be owned by mutable WorkerDevice");
  assert.match(migration, /DROP CONSTRAINT "DeviceCryptoIdentity_pkey"/);
  assert.match(migration, /PRIMARY KEY \("agencyId", "deviceId"\)/);
  const userScopeMigration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260823211500_client_e2e_identity_registered_user/migration.sql"), "utf8");
  assert.match(userScopeMigration, /ADD COLUMN "userId" TEXT/);
  assert.doesNotMatch(userScopeMigration, /SET "userId" = device\."userId"/, "mutable WorkerDevice ownership must never be guessed during migration");
  assert.match(userScopeMigration, /UPDATE "AgencyCryptoOwnerKeyWrap"[\s\S]*"revokedAt"/);
  assert.match(userScopeMigration, /UPDATE "CreatorDeviceKeyWrap"[\s\S]*"revokedAt"/);
  assert.match(userScopeMigration, /DELETE FROM "DeviceCryptoIdentity"[\s\S]*"userId" IS NULL/);
  assert.match(userScopeMigration, /ALTER COLUMN "userId" SET NOT NULL/);
  const detachMigration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260823213000_client_e2e_detach_mutable_worker_device_fks/migration.sql"), "utf8");
  assert.match(detachMigration, /DROP CONSTRAINT IF EXISTS "DeviceCryptoIdentity_deviceId_fkey"/);
  assert.match(detachMigration, /DROP CONSTRAINT IF EXISTS "AgencyCryptoOwnerKeyWrap_deviceId_fkey"/);
  assert.match(detachMigration, /DROP CONSTRAINT IF EXISTS "CreatorDeviceKeyWrap_deviceId_fkey"/);
  assert.doesNotMatch(model, /device\s+WorkerDevice\s+@relation/);
  const ownerWrapModel = schema.slice(schema.indexOf("model AgencyCryptoOwnerKeyWrap"), schema.indexOf("model AgencyCryptoRootBridge"));
  const creatorWrapModel = schema.slice(schema.indexOf("model CreatorDeviceKeyWrap"), schema.indexOf("model WorkerDevice"));
  assert.doesNotMatch(ownerWrapModel, /device\s+WorkerDevice\s+@relation\("AgencyCryptoOwnerWrapDevice"/, "owner wraps must survive mutable WorkerDevice deletion");
  assert.doesNotMatch(creatorWrapModel, /device\s+WorkerDevice\s+@relation\("CreatorCryptoWrapDevice"/, "creator wraps must survive mutable WorkerDevice deletion");
});

test("the same physical device can pin the same X25519 identity independently in two agencies", async () => {
  const device = { id: "pc-1", agencyId: "agency-a", userId: "user-1" };
  const identities = new Map();
  const key = publicKey();
  const db = {
    workerDevice: {
      findFirst: async ({ where }) => (
        where.id === device.id && where.agencyId === device.agencyId && where.userId === device.userId ? { ...device } : null
      ),
    },
    agencyCryptoOwnerKeyWrap: { findFirst: async () => null },
    creatorDeviceKeyWrap: { findFirst: async () => null },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => {
        const composite = where.agencyId_deviceId;
        return identities.get(`${composite.agencyId}:${composite.deviceId}`) || null;
      },
      create: async ({ data }) => {
        const row = { ...data, registeredAt: new Date(), activatedAt: null, revokedAt: null, updatedAt: new Date() };
        identities.set(`${data.agencyId}:${data.deviceId}`, row);
        return row;
      },
    },
  };

  const first = await registerDeviceIdentity({ db, agencyId: "agency-a", userId: "user-1", deviceId: "pc-1", publicKey: key });
  assert.equal(first.idempotent, false);
  device.agencyId = "agency-b"; // mirrors the existing heartbeat behavior when active agency changes.
  const second = await registerDeviceIdentity({ db, agencyId: "agency-b", userId: "user-1", deviceId: "pc-1", publicKey: key });
  assert.equal(second.idempotent, false);
  assert.equal(identities.size, 2);
  assert.equal(identities.get("agency-a:pc-1").fingerprint, identities.get("agency-b:pc-1").fingerprint);

  const repeat = await registerDeviceIdentity({ db, agencyId: "agency-b", userId: "user-1", deviceId: "pc-1", publicKey: key });
  assert.equal(repeat.idempotent, true);
});


test("an agency-scoped device identity cannot silently move to another member on the same physical device", async () => {
  const device = { id: "pc-1", agencyId: "agency-a", userId: "user-1" };
  const identities = new Map();
  const key = publicKey();
  const db = {
    workerDevice: { findFirst: async ({ where }) => where.id === device.id && where.agencyId === device.agencyId && where.userId === device.userId ? { ...device } : null },
    agencyCryptoOwnerKeyWrap: { findFirst: async () => null },
    creatorDeviceKeyWrap: { findFirst: async () => null },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => identities.get(`${where.agencyId_deviceId.agencyId}:${where.agencyId_deviceId.deviceId}`) || null,
      create: async ({ data }) => { const row = { ...data, registeredAt: new Date(), activatedAt: null, revokedAt: null, updatedAt: new Date() }; identities.set(`${data.agencyId}:${data.deviceId}`, row); return row; },
    },
  };
  await registerDeviceIdentity({ db, agencyId: "agency-a", userId: "user-1", deviceId: "pc-1", publicKey: key });
  device.userId = "user-2";
  await assert.rejects(
    registerDeviceIdentity({ db, agencyId: "agency-a", userId: "user-2", deviceId: "pc-1", publicKey: key }),
    (error) => error?.code === "CRYPTO_DEVICE_USER_MISMATCH",
  );
});


test("pending device inventory binds user display to immutable agency crypto identity, not mutable WorkerDevice telemetry", async () => {
  const identity = {
    deviceId: "pc-1",
    agencyId: "agency-a",
    userId: "agency-a-user",
    publicKey: publicKey(),
    fingerprint: "fp-pending",
    algorithm: "x25519",
    status: "PENDING",
    registeredAt: new Date("2026-08-23T20:00:00.000Z"),
    activatedAt: null,
    revokedAt: null,
    updatedAt: new Date("2026-08-23T20:00:00.000Z"),
    device: { id: "pc-1", deviceName: "OFFICE-PC", platform: "win32", appVersion: "20.19", lastSeenAt: new Date("2026-08-23T20:01:00.000Z"), userId: "agency-b-user" },
  };
  const db = {
    $transaction: async (fn) => fn(db),
    deviceCryptoIdentity: { findMany: async () => [structuredClone(identity)] },
    workerDevice: { findMany: async () => [{ id: "pc-1", deviceName: "OFFICE-PC", platform: "win32", appVersion: "20.19", lastSeenAt: new Date("2026-08-23T20:01:00.000Z") }] },
    agencyMember: {
      findUnique: async ({ where }) => {
        const key = where?.agencyId_userId || {};
        return key.agencyId === "agency-a" && key.userId === "agency-a-user"
          ? { agencyId: "agency-a", userId: "agency-a-user", role: "OWNER", roleKey: "owner", assignedCreators: null, deletedAt: null, deactivatedAt: null }
          : null;
      },
      findMany: async () => [{
        userId: "agency-a-user",
        deletedAt: null,
        deactivatedAt: null,
        user: { id: "agency-a-user", email: "a@example.test", name: "Agency A User" },
      }],
    },
  };
  const rows = await pendingDevices({ db, agencyId: "agency-a", userId: "agency-a-user", member: { role: "OWNER", roleKey: "owner" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device.userId, "agency-a-user");
  assert.equal(rows[0].device.user.id, "agency-a-user");
  assert.equal(rows[0].device.deviceName, "OFFICE-PC");
  assert.equal(rows[0].memberActive, true);
});
