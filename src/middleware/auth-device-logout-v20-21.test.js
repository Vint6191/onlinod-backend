"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadAuthMiddleware({ membership, decoded }) {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../prisma") return { agencyMember: { findFirst: async () => membership } };
    if (request === "../utils/tokens") return { verifyAccessToken: () => decoded };
    if (request === "../utils/device-binding") return { requireBoundAccessDevice: () => ({}) };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./auth")];
    return require("./auth");
  } finally {
    Module._load = original;
  }
}

function responseRecorder() {
  const state = { status: 200, body: null };
  return {
    state,
    res: {
      status(code) { state.status = code; return this; },
      json(body) { state.body = body; return this; },
    },
  };
}

const decoded = { userId: "user-1", agencyId: "agency-1", deviceId: "device-a", iat: Math.floor(Date.now() / 1000) };

function membership(refreshSessions) {
  return {
    id: "member-1", userId: "user-1", agencyId: "agency-1", role: "CHATTER", permissions: {},
    user: { id: "user-1", emailVerifiedAt: new Date(), disabledAt: null, sessionsRevokedAt: null, refreshSessions },
    agency: { id: "agency-1" },
  };
}

test("device-bound access JWT is rejected immediately after that device loses refresh lineage", async () => {
  const auth = loadAuthMiddleware({ membership: membership([]), decoded });
  const { state, res } = responseRecorder();
  let nextCalled = false;
  await auth.authRequired({ headers: { authorization: "Bearer token" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.code, "SESSION_REVOKED");
});

test("same access JWT remains valid while its own device has an active refresh lineage", async () => {
  const auth = loadAuthMiddleware({ membership: membership([{ id: "refresh-a" }]), decoded });
  const { state, res } = responseRecorder();
  let nextCalled = false;
  const req = { headers: { authorization: "Bearer token" } };
  await auth.authRequired(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(state.status, 200);
  assert.equal(req.auth.deviceId, "device-a");
  assert.equal("refreshSessions" in req.auth.user, false, "refresh lineage is internal auth state, not exposed downstream");
});
