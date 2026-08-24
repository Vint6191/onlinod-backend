"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadSettingsService() {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "bcryptjs") return { compare: async () => true, hash: async () => "hash" };
    if (request === "../prisma") return {};
    if (request === "./auth-service") return { publicUser: (u) => u, issuePasswordReset: async () => ({ emailResult: { ok: true, skipped: false } }) };
    if (request === "./audit-service") return { audit: async () => null };
    if (request === "./team-access-control") return { canUsePermission: async () => true, isOwner: () => true };
    if (request === "./billing-nowpayments-service") return { publicProviderConfig: () => ({}), recentOrders: async () => [] };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./settings-service")];
    return require("./settings-service");
  } finally {
    Module._load = original;
  }
}

function session(id, userId, deviceId, lastUsedAt, overrides = {}) {
  return {
    id, userId, agencyId: overrides.agencyId || "agency-1", deviceId,
    client: "desktop", userAgent: `UA-${deviceId || "legacy"}`,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    lastUsedAt: new Date(lastUsedAt), expiresAt: new Date("2026-09-20T00:00:00Z"),
    rememberDevice: false, revokedAt: null, ...overrides,
  };
}

function mutableDb(rows, workerDevices = []) {
  const cryptoWrites = [];
  const userWrites = [];
  const matches = (row, where) => {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.revokedAt === null && row.revokedAt !== null) return false;
    if (where.deviceId !== undefined && typeof where.deviceId === "string" && row.deviceId !== where.deviceId) return false;
    if (Array.isArray(where.OR)) {
      const ok = where.OR.some((part) => {
        if (part.deviceId === null) return row.deviceId === null;
        if (part.deviceId && typeof part.deviceId === "object" && part.deviceId.not !== undefined) return row.deviceId !== part.deviceId.not;
        return false;
      });
      if (!ok) return false;
    }
    return true;
  };
  const db = {
    user: {
      findUnique: async () => ({ id: "user-1", email: "owner@example.com", passwordHash: "old-hash" }),
      update: async ({ where, data }) => { userWrites.push({ where, data }); return { id: where.id, email: "owner@example.com", ...data }; },
    },
    workerDevice: { findMany: async ({ where }) => workerDevices.filter((row) => row.userId === where.userId) },
    refreshSession: {
      findMany: async ({ where }) => rows.filter((row) => matches(row, where)),
      findFirst: async ({ where }) => rows.find((row) => matches(row, where)) || null,
      update: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const selected = rows.filter((row) => matches(row, where));
        for (const row of selected) Object.assign(row, data);
        return { count: selected.length };
      },
    },
    // Sentinel models: account logout must never touch crypto/worker/creator state.
    deviceCryptoIdentity: { updateMany: async () => { cryptoWrites.push("identity"); } },
    agencyCryptoOwnerKeyWrap: { updateMany: async () => { cryptoWrites.push("amk"); } },
    creatorDeviceKeyWrap: { updateMany: async () => { cryptoWrites.push("cdk"); } },
    deviceCreatorBinding: { updateMany: async () => { cryptoWrites.push("binding"); } },
    _cryptoWrites: cryptoWrites,
    _userWrites: userWrites,
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

test("account read model groups refresh rows into logical devices", async () => {
  const service = loadSettingsService();
  const rows = [
    session("a1", "user-1", "device-a", "2026-08-24T10:00:00Z"),
    session("a2", "user-1", "device-a", "2026-08-24T11:00:00Z", { rememberDevice: true }),
    session("b1", "user-1", "device-b", "2026-08-23T11:00:00Z"),
    session("legacy", "user-1", null, "2026-08-22T11:00:00Z"),
  ];
  const db = mutableDb(rows, [{ id: "device-a", userId: "user-1", deviceName: "Office PC", platform: "win32", appVersion: "20.21", lastSeenAt: new Date("2026-08-24T12:00:00Z") }]);
  const result = await service.getAccountSettings({ userId: "user-1", currentDeviceId: "device-a", db });
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices[0].deviceId, "device-a");
  assert.equal(result.devices[0].deviceName, "Office PC");
  assert.equal(result.devices[0].activeSessionCount, 2);
  assert.equal(result.devices[0].isThisDevice, true);
  assert.equal(result.sessions.length, 4, "legacy rows remain available only to old clients");
});

test("selected device logout is scoped to exact user + device and never touches crypto or other workers", async () => {
  const service = loadSettingsService();
  const rows = [
    session("a1", "user-1", "device-a", "2026-08-24T10:00:00Z"),
    session("a2", "user-1", "device-a", "2026-08-24T11:00:00Z", { agencyId: "agency-2" }),
    session("b1", "user-1", "device-b", "2026-08-24T11:00:00Z"),
    session("other-user", "user-2", "device-a", "2026-08-24T11:00:00Z"),
  ];
  const db = mutableDb(rows);
  const result = await service.logoutAccountDevice({ agencyId: "agency-1", userId: "user-1", targetDeviceId: "device-a", currentDeviceId: "device-b", db });
  assert.equal(result.revokedSessionCount, 2);
  assert.equal(result.currentDeviceLoggedOut, false);
  assert.ok(rows[0].revokedAt instanceof Date);
  assert.ok(rows[1].revokedAt instanceof Date, "same logical device is logged out across account sessions");
  assert.equal(rows[2].revokedAt, null, "same user's other device remains signed in");
  assert.equal(rows[3].revokedAt, null, "another worker is never touched");
  assert.deepEqual(db._cryptoWrites, [], "ordinary logout must not revoke crypto identity/AMK/CDK/bindings");
});

test("logout other devices preserves current device and contains legacy unbound sessions", async () => {
  const service = loadSettingsService();
  const rows = [
    session("current", "user-1", "device-a", "2026-08-24T10:00:00Z"),
    session("other-1", "user-1", "device-b", "2026-08-24T10:00:00Z"),
    session("other-2", "user-1", "device-b", "2026-08-24T10:01:00Z"),
    session("legacy", "user-1", null, "2026-08-24T10:02:00Z"),
    session("worker", "user-2", "device-c", "2026-08-24T10:03:00Z"),
  ];
  const db = mutableDb(rows);
  const result = await service.logoutOtherAccountDevices({ agencyId: "agency-1", userId: "user-1", currentDeviceId: "device-a", db });
  assert.equal(result.revokedSessionCount, 3);
  assert.equal(result.loggedOutDeviceCount, 1);
  assert.equal(rows[0].revokedAt, null);
  assert.ok(rows[1].revokedAt instanceof Date);
  assert.ok(rows[2].revokedAt instanceof Date);
  assert.ok(rows[3].revokedAt instanceof Date);
  assert.equal(rows[4].revokedAt, null);
  assert.deepEqual(db._cryptoWrites, []);
});


test("password change logs out only this user's other devices and preserves current device", async () => {
  const service = loadSettingsService();
  const rows = [
    session("current", "user-1", "device-a", "2026-08-24T10:00:00Z"),
    session("other", "user-1", "device-b", "2026-08-24T10:01:00Z"),
    session("legacy", "user-1", null, "2026-08-24T10:02:00Z"),
    session("worker-a", "user-2", "device-c", "2026-08-24T10:03:00Z"),
  ];
  const db = mutableDb(rows);
  const result = await service.changeAccountPassword({
    agencyId: "agency-1",
    userId: "user-1",
    currentPassword: "old-password",
    newPassword: "new-password-123",
    currentDeviceId: "device-a",
    db,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(rows[0].revokedAt, null, "current device remains signed in");
  assert.ok(rows[1].revokedAt instanceof Date, "other device is logged out");
  assert.ok(rows[2].revokedAt instanceof Date, "legacy unbound session is contained");
  assert.equal(rows[3].revokedAt, null, "another worker is never affected");
  assert.equal(db._userWrites.length, 1);
  assert.equal(db._userWrites[0].where.id, "user-1");
  assert.deepEqual(db._cryptoWrites, [], "password change must not rotate or revoke agency crypto state");
});

test("legacy session revoke delegates to whole logical device semantics", async () => {
  const service = loadSettingsService();
  const rows = [
    session("target", "user-1", "device-a", "2026-08-24T10:00:00Z"),
    session("same-device", "user-1", "device-a", "2026-08-24T10:01:00Z"),
    session("other", "user-1", "device-b", "2026-08-24T10:02:00Z"),
  ];
  const db = mutableDb(rows);
  const result = await service.revokeAccountSession({ agencyId: "agency-1", userId: "user-1", sessionId: "target", currentDeviceId: "device-b", db });
  assert.equal(result.currentDeviceRevoked, false);
  assert.ok(rows[0].revokedAt instanceof Date);
  assert.ok(rows[1].revokedAt instanceof Date);
  assert.equal(rows[2].revokedAt, null);
});
