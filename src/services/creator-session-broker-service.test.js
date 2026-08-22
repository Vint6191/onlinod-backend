"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizePayload,
  hashesForPayload,
  publicState,
  requireRegisteredDevice,
  writeCreatorSession,
  revokeCreatorSession,
} = require("./creator-session-broker-service");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function makeDb() {
  let state = null;
  const creator = { id: "creator-1", agencyId: "agency-1", remoteId: "of-42", status: "READY", deletedAt: null };
  const devices = [
    { id: "device-1", agencyId: "agency-1", userId: "user-1", lastSeenAt: new Date("2026-08-22T20:00:00.000Z") },
  ];

  const tx = {
    creatorAccount: {
      findFirst: async ({ where }) => (
        where.id === creator.id && where.agencyId === creator.agencyId && creator.deletedAt === null ? clone(creator) : null
      ),
    },
    workerDevice: {
      findFirst: async ({ where }) => clone(devices.find((item) => item.id === where.id && item.agencyId === where.agencyId && item.userId === where.userId) || null),
    },
    creatorSessionState: {
      findUnique: async ({ where }) => (where.creatorId === creator.id ? clone(state) : null),
      create: async ({ data }) => {
        if (state) {
          const error = new Error("unique");
          error.code = "P2002";
          throw error;
        }
        state = {
          id: "css-1",
          ...clone(data),
          createdAt: new Date("2026-08-22T20:00:00.000Z"),
          updatedAt: new Date("2026-08-22T20:00:00.000Z"),
        };
        return clone(state);
      },
      updateMany: async ({ where, data }) => {
        if (!state || state.creatorId !== where.creatorId || state.agencyId !== where.agencyId) return { count: 0 };
        if (where.revision !== undefined && state.revision !== where.revision) return { count: 0 };
        if (where.status !== undefined && state.status !== where.status) return { count: 0 };
        const next = clone(data);
        if (next.revision && typeof next.revision === "object" && next.revision.increment) {
          next.revision = state.revision + Number(next.revision.increment);
        }
        state = { ...state, ...next, updatedAt: new Date("2026-08-22T20:00:01.000Z") };
        return { count: 1 };
      },
    },
  };

  tx.$transaction = async (fn) => fn(tx);
  return { db: tx, creator, devices, getState: () => clone(state) };
}

function payload({ sess = "sess-A", bcTokenSha = "bc-A", expiry = 1_900_000_000 } = {}) {
  return {
    cookies: [
      {
        name: "sess",
        value: sess,
        domain: ".onlyfans.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expirationDate: expiry,
        session: false,
      },
      {
        name: "auth_id",
        value: "42",
        domain: "onlyfans.com",
        hostOnly: true,
        path: "/",
        secure: true,
        httpOnly: false,
        session: true,
      },
    ],
    storage: { bcTokenSha, ignored: "must-not-survive" },
    userAgent: "UA/1",
    ignoredTopLevel: "must-not-survive",
  };
}

test("session payload normalization is an OnlyFans whitelist, not a browser-profile dump", () => {
  const normalized = normalizePayload({
    ...payload(),
    cookies: [
      ...payload().cookies,
      { name: "other", value: "x", domain: ".example.com", path: "/" },
    ],
  });
  assert.equal(normalized.cookies.length, 2);
  assert.equal(normalized.cookies.find((cookie) => cookie.name === "sess").hostOnly, false);
  assert.equal(normalized.cookies.find((cookie) => cookie.name === "auth_id").hostOnly, true);
  assert.deepEqual(normalized.storage, { bcTokenSha: "bc-A" });
  assert.equal(normalized.userAgent, "UA/1");
  assert.equal(Object.hasOwn(normalized, "ignoredTopLevel"), false);
  assert.equal(Object.hasOwn(normalized.storage, "ignored"), false);
});

test("session payload normalization rejects lookalike domains instead of substring matching", () => {
  const normalized = normalizePayload({
    ...payload(),
    cookies: [
      ...payload().cookies,
      { name: "sess", value: "evil", domain: ".evilonlyfans.com", path: "/" },
      { name: "sess", value: "evil", domain: ".onlyfans.com.evil.test", path: "/" },
      { name: "sess", value: "ok", domain: ".api.onlyfans.com", path: "/" },
    ],
  });
  assert.equal(normalized.cookies.some((cookie) => cookie.domain === ".evilonlyfans.com"), false);
  assert.equal(normalized.cookies.some((cookie) => cookie.domain === ".onlyfans.com.evil.test"), false);
  assert.equal(normalized.cookies.some((cookie) => cookie.domain === ".api.onlyfans.com"), true);
});

test("server refuses to canonicalize a cookie jar without a strong OnlyFans auth cookie", async () => {
  const { db } = makeDb();
  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 0, requestId: "request-weak-cookie", platformUserId: "of-42",
      payload: {
        cookies: [{ name: "fp", value: "x", domain: ".onlyfans.com", hostOnly: false, path: "/", secure: true, httpOnly: false, session: true }],
        storage: { bcTokenSha: "bc-A" },
        userAgent: "UA/1",
      },
    }),
    (error) => error?.code === "CREATOR_SESSION_STRONG_AUTH_COOKIE_REQUIRED" && error?.status === 400,
  );
});

test("credential hash ignores cookie expiry metadata while coherence hash detects it", () => {
  const a = hashesForPayload(payload({ expiry: 1_900_000_000 }));
  const b = hashesForPayload(payload({ expiry: 1_950_000_000 }));
  assert.equal(a.credentialHash, b.credentialHash);
  assert.notEqual(a.coherenceHash, b.coherenceHash);
});

test("registered device must belong to the authenticated user and agency", async () => {
  const { db } = makeDb();
  const device = await requireRegisteredDevice({ db, agencyId: "agency-1", userId: "user-1", deviceId: "device-1" });
  assert.equal(device.id, "device-1");
  await assert.rejects(
    requireRegisteredDevice({ db, agencyId: "agency-1", userId: "user-2", deviceId: "device-1" }),
    (error) => error?.code === "CREATOR_SESSION_DEVICE_NOT_REGISTERED" && error?.status === 403,
  );
});

test("initial write creates revision 1 and exact retry is idempotent", async () => {
  const { db } = makeDb();
  const first = await writeCreatorSession({
    db,
    agencyId: "agency-1",
    creatorId: "creator-1",
    actorUserId: "user-1",
    deviceId: "device-1",
    baseRevision: 0,
    requestId: "request-0001",
    capturedAt: "2026-08-22T20:01:00.000Z",
    platformUserId: "of-42",
    payload: payload(),
  });
  assert.equal(first.state.revision, 1);
  assert.equal(first.state.status, "ACTIVE");
  assert.equal(first.idempotent, false);
  assert.equal(first.unchanged, false);

  const retry = await writeCreatorSession({
    db,
    agencyId: "agency-1",
    creatorId: "creator-1",
    actorUserId: "user-1",
    deviceId: "device-1",
    baseRevision: 0,
    requestId: "request-0001",
    capturedAt: "2026-08-22T20:01:00.000Z",
    platformUserId: "of-42",
    payload: payload(),
  });
  assert.equal(retry.state.revision, 1);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.unchanged, true);
});

test("unchanged envelope does not churn canonical revision", async () => {
  const { db } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-0001", platformUserId: "of-42", payload: payload(),
  });
  const unchanged = await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 1, requestId: "request-0002", platformUserId: "of-42", payload: payload(),
  });
  assert.equal(unchanged.state.revision, 1);
  assert.equal(unchanged.unchanged, true);
});

test("changed envelope advances revision and stale base is rejected with current state", async () => {
  const { db } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-0001", platformUserId: "of-42", payload: payload(),
  });
  const second = await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 1, requestId: "request-0002", platformUserId: "of-42", payload: payload({ sess: "sess-B" }),
  });
  assert.equal(second.state.revision, 2);

  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 1, requestId: "request-0003", platformUserId: "of-42", payload: payload({ sess: "sess-C" }),
    }),
    (error) => error?.code === "CREATOR_SESSION_REVISION_CONFLICT" && error?.current?.revision === 2,
  );
});

test("request id cannot be reused for different session data", async () => {
  const { db } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-0001", platformUserId: "of-42", payload: payload(),
  });
  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 1, requestId: "request-0001", platformUserId: "of-42", payload: payload({ sess: "other" }),
    }),
    (error) => error?.code === "CREATOR_SESSION_REQUEST_ID_REUSED",
  );
});

test("server rejects a snapshot proven for a different OnlyFans identity", async () => {
  const { db } = makeDb();
  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 0, requestId: "request-0001", platformUserId: "of-999", payload: payload(),
    }),
    (error) => error?.code === "CREATOR_SESSION_IDENTITY_MISMATCH",
  );
});

test("revoke increments revision, deletes ciphertext fields, and later verified write can reactivate", async () => {
  const { db, getState } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-0001", platformUserId: "of-42", payload: payload(),
  });
  const revoked = await revokeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 1, requestId: "request-revoke-1", reason: "verified logout",
  });
  assert.equal(revoked.state.revision, 2);
  assert.equal(revoked.state.status, "REVOKED");
  assert.equal(getState().encryptedPayload, null);
  assert.equal(publicState(getState(), { includePayload: true }).payload, null);

  const reactivated = await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 2, requestId: "request-0003", platformUserId: "of-42", payload: payload({ sess: "sess-new" }),
  });
  assert.equal(reactivated.state.revision, 3);
  assert.equal(reactivated.state.status, "ACTIVE");
});

test("shadow-session normalization drops Cloudflare, analytics and CDN noise before hashing", () => {
  const normalized = normalizePayload({
    ...payload(),
    cookies: [
      ...payload().cookies,
      { name: "__cf_bm", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "_cfuvid", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "_ga", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "_ga_XYZ", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "_gat_1", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "_fbp", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "CloudFront-Key-Pair-Id", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "lang", value: "en", domain: ".onlyfans.com", path: "/" },
    ],
  });
  assert.deepEqual(normalized.cookies.map((cookie) => cookie.name).sort(), ["auth_id", "sess"]);
});
