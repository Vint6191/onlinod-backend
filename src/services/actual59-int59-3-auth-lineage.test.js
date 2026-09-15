"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadAuthService(prisma, signed = []) {
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
      signAccessToken: (payload) => { signed.push(payload); return "access-token"; },
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

function liveSession(overrides = {}) {
  return {
    id: "legacy-refresh", userId: "user-1", agencyId: "agency-1", deviceId: "device-a",
    tokenHash: "hash:old-token", authorizationSessionId: null, revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000), rememberDevice: true,
    userAgent: "ua", ipAddress: "127.0.0.1", client: "desktop", impersonatedByAdminId: null,
    user: { id: "user-1", disabledAt: null }, ...overrides,
  };
}

function prismaFor(session, { collision = null, authorityRow = undefined, lockedSession = undefined } = {}) {
  const calls = [];
  const refreshSession = {
    findUnique: async () => session,
    findFirst: async (args) => { calls.push(["findFirst", args]); return collision; },
    create: async (args) => { calls.push(["create", args]); return { id: "replacement" }; },
    updateMany: async (args) => { calls.push(["updateMany", args]); return { count: 1 }; },
  };
  const raw = async (sql, ...params) => {
    const text = String(sql);
    calls.push(["raw", { sql: text, params }]);
    if (/FROM "AgencyMember" m/i.test(text) && /FOR SHARE OF m,u,a/i.test(text)) {
      if (authorityRow === null) return [];
      return [authorityRow || { memberId: "member-1", accessEpoch: 1, memberDeletedAt: null, memberDeactivatedAt: null, userDisabledAt: null, passwordHash: "pw-hash", agencyDeletedAt: null }];
    }
    if (/FROM "RefreshSession" r/i.test(text) && /FOR UPDATE/i.test(text)) {
      if (lockedSession === null) return [];
      const row = lockedSession === undefined ? session : lockedSession;
      return [{
        id: row.id, userId: row.userId, agencyId: row.agencyId, deviceId: row.deviceId,
        authorizationSessionId: row.authorizationSessionId || null, expiresAt: row.expiresAt,
        revokedAt: row.revokedAt || null, expired: row.expired === true,
      }];
    }
    return [];
  };
  const exec = async (sql, ...params) => { calls.push(["exec", { sql: String(sql), params }]); return 1; };
  const user = { update: async ({ where, data }) => ({ id: where.id, passwordHash: "pw-hash", ...data }) };
  const prisma = {
    refreshSession,
    user,
    agencyMember: { findFirst: async () => ({ id: "member-1", accessEpoch: 1, role: "CHATTER", agency: { id: "agency-1" } }) },
    $transaction: async (fn) => fn({ refreshSession, user, $queryRawUnsafe: raw, $executeRawUnsafe: exec }),
  };
  return { prisma, calls };
}

test("legacy refresh adopts the durable Desktop incarnation and preserves it in the replacement token", async () => {
  const { prisma, calls } = prismaFor(liveSession());
  const signed = [];
  const auth = loadAuthService(prisma, signed);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", client: "desktop",
    authorizationScopeIncarnation: "desktop-scope-A", req: { headers: {}, ip: "127.0.0.1" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.authorizationSessionId, "desktop-scope-A");
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.data.authorizationSessionId, "desktop-scope-A");
  const update = calls.find(([kind]) => kind === "updateMany")[1];
  assert.equal(update.data.authorizationSessionId, "desktop-scope-A");
  assert.equal(signed[0].authorizationSessionId, "desktop-scope-A");
  assert.ok(calls.findIndex(([kind]) => kind === "create") < calls.findIndex(([kind]) => kind === "updateMany"), "replacement must exist before old token revoke so refresh rotation does not end the lineage");
});

test("a lineaged refresh cannot be rebound to a different Desktop incarnation", async () => {
  const { prisma, calls } = prismaFor(liveSession({ authorizationSessionId: "scope-A" }));
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({ refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "scope-B", req: { headers: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTHORIZATION_SESSION_MISMATCH");
  assert.equal(calls.length, 0);
});

test("legacy adoption rejects an incarnation that was already used by another refresh lineage", async () => {
  const { prisma, calls } = prismaFor(liveSession(), { collision: { id: "other-session" } });
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({ refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "used-scope", req: { headers: {} } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTHORIZATION_SESSION_COLLISION");
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});

test("backend-first rolling keeps a legacy Desktop refresh chain NULL-lineage until the Desktop supplies its durable incarnation", async () => {
  const { prisma, calls } = prismaFor(liveSession());
  const signed = [];
  const auth = loadAuthService(prisma, signed);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", client: "desktop",
    req: { headers: {}, ip: "127.0.0.1" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.authorizationSessionId, null);
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.data.authorizationSessionId, null);
  const currentRevoke = calls.filter(([kind]) => kind === "updateMany")[0][1];
  assert.equal("authorizationSessionId" in currentRevoke.data, false,
    "legacy refresh without a Desktop incarnation must not secretly bind a random server lineage");
  assert.equal(signed[0].authorizationSessionId, null);
  assert.equal(calls.some(([kind]) => kind === "findFirst"), false,
    "a legacy-only rotation does not need lineage collision lookup");
});

test("legacy adoption revokes every other active NULL-lineage chain on the same user agency and device", async () => {
  const { prisma, calls } = prismaFor(liveSession());
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", client: "desktop",
    authorizationScopeIncarnation: "desktop-scope-A", req: { headers: {}, ip: "127.0.0.1" },
  });
  assert.equal(result.ok, true);
  const updates = calls.filter(([kind]) => kind === "updateMany").map(([, args]) => args);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1].where, {
    userId: "user-1",
    agencyId: "agency-1",
    deviceId: "device-a",
    revokedAt: null,
    authorizationSessionId: null,
    id: { not: "replacement" },
  });
  assert.ok(updates[1].data.revokedAt instanceof Date);
});


test("lineaged refresh rotation preserves the same authorizationSessionId across replacement tokens", async () => {
  const { prisma, calls } = prismaFor(liveSession({ authorizationSessionId: "scope-A" }));
  const signed = [];
  const auth = loadAuthService(prisma, signed);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "scope-A", req: { headers: {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.authorizationSessionId, "scope-A");
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.data.authorizationSessionId, "scope-A");
  assert.equal(signed[0].authorizationSessionId, "scope-A");
  assert.equal(calls.filter(([kind]) => kind === "findFirst").length, 0, "ordinary rotation must not re-run legacy adoption collision semantics");
});

test("refresh source session is revalidated under FOR UPDATE before replacement publication", async () => {
  const { prisma, calls } = prismaFor(liveSession({ authorizationSessionId: "scope-A" }));
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "scope-A", req: { headers: {} },
  });
  assert.equal(result.ok, true);
  const sourceFenceIndex = calls.findIndex(([kind, args]) => kind === "raw" && /FROM "RefreshSession" r/i.test(args.sql) && /FOR UPDATE/i.test(args.sql));
  const createIndex = calls.findIndex(([kind]) => kind === "create");
  assert.ok(sourceFenceIndex >= 0 && sourceFenceIndex < createIndex, "exact source refresh row must be commit-fenced before replacement create");
});

test("refresh that expires while waiting for authorization locks cannot publish a replacement", async () => {
  const expiredAtCommit = liveSession({ authorizationSessionId: "scope-A", expired: true });
  const { prisma, calls } = prismaFor(liveSession({ authorizationSessionId: "scope-A" }), { lockedSession: expiredAtCommit });
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "scope-A", req: { headers: {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REFRESH_INVALID");
  assert.equal(calls.some(([kind]) => kind === "create"), false, "expired source token must never publish a replacement");
});

test("refresh source revoked while waiting is classified as reuse and publishes no replacement", async () => {
  const revokedAtCommit = liveSession({ authorizationSessionId: "scope-A", revokedAt: new Date() });
  const { prisma, calls } = prismaFor(liveSession({ authorizationSessionId: "scope-A" }), { lockedSession: revokedAtCommit });
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "scope-A", req: { headers: {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REFRESH_REUSED");
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});


test("lineage-aware device login publishes the Desktop incarnation only after USER/DEVICE/authority/LINEAGE fences", async () => {
  const { prisma, calls } = prismaFor(liveSession());
  const auth = loadAuthService(prisma);
  const result = await auth.issueLoginTokens({
    user: { id: "user-1", passwordHash: "pw-hash" },
    membership: { id: "member-1", agencyId: "agency-1", accessEpoch: 1, role: "CHATTER" },
    req: { headers: {}, ip: "127.0.0.1" },
    rememberDevice: true,
    deviceId: "device-a",
    client: "desktop",
    authorizationScopeIncarnation: "desktop-login-scope-A",
  });
  assert.equal(result.authorizationSessionId, "desktop-login-scope-A");
  const userLockIndex = calls.findIndex(([kind, args]) => kind === "exec" && args.params[0] === "authorization-user:user-1");
  const deviceLockIndex = calls.findIndex(([kind, args]) => kind === "exec" && args.params[0] === "authorization-device:user-1:agency-1:device-a");
  const authorityIndex = calls.findIndex(([kind, args]) => kind === "raw" && /FOR SHARE OF m,u,a/i.test(args.sql));
  const lineageLockIndex = calls.findIndex(([kind, args]) => kind === "exec" && args.params[0] === "authorization-lineage:desktop-login-scope-A");
  const collisionIndex = calls.findIndex(([kind]) => kind === "findFirst");
  const createIndex = calls.findIndex(([kind]) => kind === "create");
  assert.ok(userLockIndex >= 0 && userLockIndex < deviceLockIndex, "user lock must be outermost");
  assert.ok(deviceLockIndex < authorityIndex && authorityIndex < lineageLockIndex, "device/current authority must precede global lineage publication");
  assert.ok(lineageLockIndex < collisionIndex && collisionIndex < createIndex, "lineage collision proof must precede login publication");
});

test("backend-first rolling fresh login from a legacy Desktop remains NULL-lineage until upgraded refresh adoption", async () => {
  const { prisma, calls } = prismaFor(liveSession());
  const signed = [];
  const auth = loadAuthService(prisma, signed);
  const result = await auth.issueLoginTokens({
    user: { id: "user-1", passwordHash: "pw-hash" },
    membership: { id: "member-1", agencyId: "agency-1", accessEpoch: 1, role: "CHATTER" },
    req: { headers: {}, ip: "127.0.0.1" }, deviceId: "device-a", client: "legacy-desktop",
  });
  assert.equal(result.authorizationSessionId, null);
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.data.authorizationSessionId, null);
  assert.equal(signed[0].authorizationSessionId, null);
  assert.equal(calls.some(([kind]) => kind === "findFirst"), false, "legacy login must not invent or collision-check a hidden lineage");
});

test("lineage-aware fresh login rejects historical incarnation reuse before creating a refresh session", async () => {
  const { prisma, calls } = prismaFor(liveSession(), { collision: { id: "historical-session" } });
  const auth = loadAuthService(prisma);
  await assert.rejects(() => auth.issueLoginTokens({
    user: { id: "user-1", passwordHash: "pw-hash" },
    membership: { id: "member-1", agencyId: "agency-1", accessEpoch: 1, role: "CHATTER" },
    req: { headers: {}, ip: "127.0.0.1" }, deviceId: "device-a", client: "desktop",
    authorizationScopeIncarnation: "used-desktop-scope",
  }), (error) => error?.code === "AUTHORIZATION_SESSION_COLLISION");
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});

test("legacy adoption serializes both the device replacement and the globally unique Desktop incarnation before collision check", async () => {
  const { prisma, calls } = prismaFor(liveSession());
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", client: "desktop",
    authorizationScopeIncarnation: "desktop-scope-A", req: { headers: {}, ip: "127.0.0.1" },
  });
  assert.equal(result.ok, true);
  const locks = calls.filter(([kind]) => kind === "exec").map(([, args]) => args.params[0]);
  assert.deepEqual(locks.slice(0, 3), [
    "authorization-user:user-1",
    "authorization-device:user-1:agency-1:device-a",
    "authorization-lineage:desktop-scope-A",
  ]);
  const lineageLockIndex = calls.findIndex(([kind, args]) => kind === "exec" && args.params[0] === "authorization-lineage:desktop-scope-A");
  const collisionIndex = calls.findIndex(([kind]) => kind === "findFirst");
  assert.ok(lineageLockIndex >= 0 && lineageLockIndex < collisionIndex, "lineage lock must precede the historical collision lookup");
});


test("login publication fails closed when accessEpoch changed after the credential read", async () => {
  const { prisma, calls } = prismaFor(liveSession(), { authorityRow: {
    memberId: "member-1", accessEpoch: 2, memberDeletedAt: null, memberDeactivatedAt: null,
    userDisabledAt: null, passwordHash: "pw-hash", agencyDeletedAt: null,
  } });
  const auth = loadAuthService(prisma);
  await assert.rejects(() => auth.issueLoginTokens({
    user: { id: "user-1", passwordHash: "pw-hash" },
    membership: { id: "member-1", agencyId: "agency-1", accessEpoch: 1, role: "CHATTER" },
    req: { headers: {}, ip: "127.0.0.1" }, deviceId: "device-a", client: "desktop",
  }), (error) => error?.code === "AUTHORIZATION_GENERATION_CHANGED");
  assert.equal(calls.some(([kind]) => kind === "create"), false, "stale membership generation must never publish a refresh lineage");
});

test("login publication fails closed when the password generation changed after password verification", async () => {
  const { prisma, calls } = prismaFor(liveSession(), { authorityRow: {
    memberId: "member-1", accessEpoch: 1, memberDeletedAt: null, memberDeactivatedAt: null,
    userDisabledAt: null, passwordHash: "new-password-hash", agencyDeletedAt: null,
  } });
  const auth = loadAuthService(prisma);
  await assert.rejects(() => auth.issueLoginTokens({
    user: { id: "user-1", passwordHash: "old-password-hash" },
    membership: { id: "member-1", agencyId: "agency-1", accessEpoch: 1, role: "CHATTER" },
    req: { headers: {}, ip: "127.0.0.1" }, deviceId: "device-a", client: "desktop",
  }), (error) => error?.code === "CREDENTIAL_GENERATION_CHANGED");
  assert.equal(calls.some(([kind]) => kind === "create"), false);
});

test("refresh rotation revalidates current membership generation inside the publication transaction", async () => {
  const { prisma, calls } = prismaFor(liveSession({ authorizationSessionId: "scope-A" }), { authorityRow: {
    memberId: "member-1", accessEpoch: 2, memberDeletedAt: null, memberDeactivatedAt: null,
    userDisabledAt: null, passwordHash: "pw-hash", agencyDeletedAt: null,
  } });
  const auth = loadAuthService(prisma);
  const result = await auth.refreshAccessToken({
    refreshToken: "old-token", deviceId: "device-a", authorizationScopeIncarnation: "scope-A", req: { headers: {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUTHORIZATION_GENERATION_CHANGED");
  assert.equal(calls.some(([kind]) => kind === "create"), false, "refresh must not mint a replacement under a stale member generation");
});
