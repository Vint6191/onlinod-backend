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
    $transaction: async (work) => work(prisma),
    $executeRawUnsafe: async () => 1,
    refreshSession: {
      findUnique: async () => ({ id: "s-a1", userId: "user-1", agencyId: "agency-1", deviceId: "device-a", revokedAt: null }),
      updateMany: async ({ where, data }) => { calls.push({ where, data }); return { count: 2 }; },
    },
  };
  const auth = loadAuthService(prisma);
  await auth.revokeRefreshToken("token-a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.userId, "user-1");
  assert.equal(calls[0].where.deviceId, "device-a");
  assert.equal(calls[0].where.revokedAt, null);
  assert.ok(calls[0].where.expiresAt?.gt instanceof Date, "device logout must only revoke still-live refresh rows");
});

test("reuse of a revoked device-bound refresh token is contained to that device", async () => {
  const updates = [];
  const prisma = {
    $transaction: async (work) => work(prisma),
    $executeRawUnsafe: async () => 1,
    refreshSession: {
      findUnique: async () => ({
        id: "s-a1", userId: "user-1", agencyId: "agency-1", deviceId: "device-a",
        revokedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() + 86400000),
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
  assert.equal(updates[0].where.userId, "user-1");
  assert.equal(updates[0].where.revokedAt, null);
  assert.equal(updates[0].where.deviceId, "device-a");
  assert.ok(updates[0].where.expiresAt?.gt instanceof Date, "reuse containment must ignore already-expired history");
  assert.ok(!("OR" in updates[0].where), "reuse containment must never widen to other devices");
});

test("legacy unbound refresh-token reuse retains account-wide fallback", async () => {
  const updates = [];
  const prisma = {
    $transaction: async (work) => work(prisma),
    $executeRawUnsafe: async () => 1,
    refreshSession: {
      findUnique: async () => ({
        id: "legacy", userId: "user-1", agencyId: "agency-1", deviceId: null,
        revokedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() + 86400000),
        user: { id: "user-1", disabledAt: null },
      }),
      updateMany: async ({ where, data }) => { updates.push({ where, data }); return { count: 3 }; },
    },
  };
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({ refreshToken: "old-legacy", req: { headers: {}, ip: "127.0.0.1" } });
  assert.equal(result.code, "REFRESH_REUSED");
  assert.equal(updates[0].where.userId, "user-1");
  assert.equal(updates[0].where.revokedAt, null);
  assert.ok(updates[0].where.expiresAt?.gt instanceof Date, "legacy fallback must still only revoke live account sessions");
  assert.equal(updates[0].where.deviceId, undefined);
});


test("retired support refresh cannot rotate or revoke the real customer's direct sessions", async () => {
  let writes=0;
  const now=new Date();
  const prisma={
    refreshSession:{findUnique:async()=>({id:"legacy",userId:"u",agencyId:"a",expiresAt:new Date(now.getTime()+60000),revokedAt:now,impersonatedByAdminId:"support",user:{id:"u"}}),updateMany:async()=>{writes++;}},
    $transaction:async()=>{writes++;},
  };
  const auth=loadAuthService(prisma);
  const result=await auth.refreshAccessToken({refreshToken:"old-support",req:{headers:{}}});
  assert.equal(result.code,"LEGACY_IMPERSONATION_RETIRED");assert.equal(writes,0);
});
