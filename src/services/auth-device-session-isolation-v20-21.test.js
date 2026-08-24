"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadAuthService(prisma) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return prisma;
    if (request === "jsonwebtoken") return { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 900 }) };
    if (request === "../utils/crypto") return {
      randomToken: () => "next-token",
      randomCode: () => "123456",
      sha256: (value) => `hash:${value}`,
      addMinutes: (m) => new Date(Date.now() + m * 60_000),
      addDays: (d) => new Date(Date.now() + d * 86_400_000),
    };
    if (request === "../utils/tokens") return {
      signAccessToken: ({ deviceId }) => `access:${deviceId || "legacy"}`,
      refreshTokenDays: () => 30,
    };
    if (request === "../utils/device-binding") return {
      resolveRefreshDeviceBinding: (stored, supplied) => ({ ok: true, deviceId: supplied || stored || null }),
    };
    if (request === "./email-service") return { verificationEmail: async () => ({ ok: true }), passwordResetEmail: async () => ({ ok: true }) };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./auth-service")];
    return require("./auth-service");
  } finally {
    Module._load = original;
  }
}

test("normal refresh-token logout revokes the whole logical device, not another device", async () => {
  const calls = [];
  const prisma = {
    refreshSession: {
      findUnique: async () => ({ id: "s-a1", userId: "user-1", deviceId: "device-a", revokedAt: null }),
      updateMany: async ({ where, data }) => { calls.push({ where, data }); return { count: 2 }; },
    },
  };
  const auth = loadAuthService(prisma);
  await auth.revokeRefreshToken("token-a");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, { userId: "user-1", deviceId: "device-a", revokedAt: null });
  assert.equal(calls[0].where.deviceId, "device-a");
});

test("reuse of a revoked device-bound refresh token is contained to that device", async () => {
  const updates = [];
  const prisma = {
    refreshSession: {
      findUnique: async () => ({
        id: "s-a1", userId: "user-1", agencyId: "agency-1", deviceId: "device-a",
        revokedAt: new Date("2026-08-24T10:00:00Z"), expiresAt: new Date("2026-09-24T10:00:00Z"),
        user: { id: "user-1", disabledAt: null },
      }),
      updateMany: async ({ where, data }) => { updates.push({ where, data }); return { count: 1 }; },
    },
  };
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({ refreshToken: "old-token", req: { headers: {}, ip: "127.0.0.1" }, deviceId: "device-a", client: "desktop" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REFRESH_REUSED");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { userId: "user-1", revokedAt: null, deviceId: "device-a" });
  assert.ok(!("OR" in updates[0].where), "reuse containment must never widen to other devices");
});

test("legacy unbound refresh-token reuse retains account-wide fallback", async () => {
  const updates = [];
  const prisma = {
    refreshSession: {
      findUnique: async () => ({
        id: "legacy", userId: "user-1", agencyId: "agency-1", deviceId: null,
        revokedAt: new Date("2026-08-24T10:00:00Z"), expiresAt: new Date("2026-09-24T10:00:00Z"),
        user: { id: "user-1", disabledAt: null },
      }),
      updateMany: async ({ where, data }) => { updates.push({ where, data }); return { count: 3 }; },
    },
  };
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({ refreshToken: "old-legacy", req: { headers: {}, ip: "127.0.0.1" } });
  assert.equal(result.code, "REFRESH_REUSED");
  assert.deepEqual(updates[0].where, { userId: "user-1", revokedAt: null });
});
