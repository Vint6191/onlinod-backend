"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function chainSchema() {
  const chain = {};
  for (const name of ["email", "min", "max", "optional", "nullable", "boolean"]) chain[name] = () => chain;
  return chain;
}

function loadAuthRouter({ refreshImpl = async () => ({ ok: false }), loginImpl = async () => ({}) } = {}) {
  const routes = [];
  const router = {
    stack: routes,
    get(path, ...handlers) { routes.push({ route: { path, methods: { get: true }, stack: handlers.map((handle) => ({ handle })) } }); return router; },
    post(path, ...handlers) { routes.push({ route: { path, methods: { post: true }, stack: handlers.map((handle) => ({ handle })) } }); return router; },
  };
  const z = {
    string: chainSchema,
    boolean: chainSchema,
    object: () => ({ parse: (value) => value || {}, safeParse: (value) => ({ success: true, data: value || {} }) }),
  };
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "express") return { Router: () => router };
    if (request === "bcryptjs") return { compare: async () => true, hash: async (v) => `hash:${v}` };
    if (request === "zod") return { z };
    if (request === "../prisma") return {
      user: { findUnique: async () => ({ id: "user-1", passwordHash: "pw", disabledAt: null, emailVerifiedAt: new Date() }) },
      authToken: { findUnique: async () => null },
      $transaction: async (fn) => fn({}),
    };
    if (request === "../middleware/auth") return { authRequired: (_req, _res, next) => next?.() };
    if (request === "../utils/crypto") return { sha256: (v) => `hash:${v}` };
    if (request === "../services/auth-service") return {
      publicUser: (u) => u,
      getPrimaryMembership: async () => membership(),
      issueEmailVerification: async () => ({}),
      issuePasswordReset: async () => ({}),
      issueLoginTokens: loginImpl,
      verifyEmailByToken: async () => ({ ok: false }),
      verifyEmailByCode: async () => ({ ok: false }),
      refreshAccessToken: refreshImpl,
      revokeRefreshToken: async () => ({ ok: true }),
    };
    if (request === "../services/team-access-control") return {
      resolveEffectivePermissions: async () => ({ chats: true }), validateAssignedCreators: async () => [],
    };
    if (request === "../services/team-administration-service") return {
      cleanFunctions: (v) => v, ensureRoleExists: async () => ({}), lockTeamRoleLifecycle: async () => {}, materializeInvitationMemberWithinTransaction: async () => ({}),
    };
    if (request === "../services/audit-service") return { audit: async () => {} };
    if (request === "../services/desktop-control-events") return { publishDesktopControlEvent: () => {} };
    if (request === "../services/team-control-plane-authority-service") return {
      lockTeamControlPlaneTopology: async () => {}, lockLiveTeamControlPlaneCreators: async () => {},
    };
    if (request === "../services/phase2-release-compatibility-authority-service") return { assertTeamControlPlaneWriteAdmission: async () => {} };
    if (request === "../services/authorization-session-authority-service") return { acquireAuthorizationUserLock: async () => {} };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./auth")];
    require("./auth");
  } finally {
    Module._load = original;
  }
  return routes;
}

function handlerFor(routes, method, path) {
  const layer = routes.find((item) => item.route?.path === path && item.route?.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} is missing`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function membership() {
  return { id: "member-1", agencyId: "agency-1", accessEpoch: 7, role: "CHATTER", agency: { id: "agency-1" } };
}

test("INT59.4D HTTP rolling: legacy Desktop refresh stays NULL-lineage and succeeds", async () => {
  let seen = null;
  const routes = loadAuthRouter({ refreshImpl: async (args) => {
    seen = args;
    return {
      ok: true, accessToken: "a", refreshToken: "r2", accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: new Date(),
      authorizationSessionId: null, user: { id: "user-1" }, membership: membership(),
    };
  } });
  const handler = handlerFor(routes, "post", "/refresh");
  const req = { body: { refreshToken: "legacy-refresh-token-xxxxxxxx", deviceId: "device-a", client: "desktop" }, headers: {}, ip: "127.0.0.1" };
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.authorizationScopeIncarnation, null);
  assert.equal(res.body.authorizationSessionId, null);
});

test("INT59.4D HTTP rolling: upgraded Desktop incarnation reaches service and is echoed as server lineage", async () => {
  let seen = null;
  const routes = loadAuthRouter({ refreshImpl: async (args) => {
    seen = args;
    return {
      ok: true, accessToken: "a", refreshToken: "r2", accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: new Date(),
      authorizationSessionId: args.authorizationScopeIncarnation, user: { id: "user-1" }, membership: membership(),
    };
  } });
  const handler = handlerFor(routes, "post", "/refresh");
  const req = { body: { refreshToken: "legacy-refresh-token-xxxxxxxx", deviceId: "device-a", client: "desktop", authorizationScopeIncarnation: "desktop-scope-A" }, headers: {}, ip: "127.0.0.1" };
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.authorizationScopeIncarnation, "desktop-scope-A");
  assert.equal(res.body.authorizationSessionId, "desktop-scope-A");
});

test("INT59.4D HTTP rolling: generation mismatch and commit-time expiry stay fail-closed 401s", async () => {
  for (const code of ["AUTHORIZATION_SESSION_MISMATCH", "AUTHORIZATION_GENERATION_CHANGED", "REFRESH_INVALID"]) {
    const routes = loadAuthRouter({ refreshImpl: async () => ({ ok: false, code, error: code }) });
    const handler = handlerFor(routes, "post", "/refresh");
    const res = responseRecorder();
    await handler({ body: { refreshToken: "refresh-token-xxxxxxxxxxxx", deviceId: "device-a", authorizationScopeIncarnation: "scope-A" }, headers: {} }, res);
    assert.equal(res.statusCode, 401, code);
    assert.equal(res.body.code, code);
  }
});


test("INT59.4E HTTP rolling: fresh login forwards Desktop incarnation while legacy login forwards null", async () => {
  const seen = [];
  const routes = loadAuthRouter({ loginImpl: async (args) => {
    seen.push(args);
    return {
      accessToken: "access", refreshToken: "refresh", accessTokenExpiresAt: new Date(), refreshTokenExpiresAt: new Date(),
      authorizationSessionId: args.authorizationScopeIncarnation || null, user: { id: "user-1" },
    };
  } });
  const handler = handlerFor(routes, "post", "/login");

  const modern = responseRecorder();
  await handler({ body: { email: "u@example.com", password: "pw", deviceId: "device-a", client: "desktop", authorizationScopeIncarnation: "desktop-login-scope-A" }, headers: {}, ip: "127.0.0.1" }, modern);
  assert.equal(modern.statusCode, 200);
  assert.equal(seen[0].authorizationScopeIncarnation, "desktop-login-scope-A");
  assert.equal(modern.body.authorizationSessionId, "desktop-login-scope-A");

  const legacy = responseRecorder();
  await handler({ body: { email: "u@example.com", password: "pw", deviceId: "device-a", client: "legacy-desktop" }, headers: {}, ip: "127.0.0.1" }, legacy);
  assert.equal(legacy.statusCode, 200);
  assert.equal(seen[1].authorizationScopeIncarnation, null);
  assert.equal(legacy.body.authorizationSessionId, null);
});
