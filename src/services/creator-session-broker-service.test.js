"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizePayload,
  assertNoDuplicateCookies,
  isCreatorSessionTargetActiveStatus,
  assertCreatorSessionTargetActive,
  hashesForPayload,
  publicState,
  requireRegisteredDevice,
  getCreatorSession,
  migrateCreatorSessionToOpaque,
  writeCreatorSession,
  revokeCreatorSession,
} = require("./creator-session-broker-service");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function makeDb() {
  let state = null;
  const creator = { id: "creator-1", agencyId: "agency-1", remoteId: "of-42", status: "READY", deletedAt: null };
  const root = { agencyId: "agency-1", version: 1, status: "ACTIVE", enforceOpaqueSecrets: false };
  const liveMember = { agencyId: "agency-1", userId: "user-1", role: "WORKER", roleKey: "worker", assignedCreators: ["creator-1"], deletedAt: null, deactivatedAt: null };
  const devices = [
    { id: "device-1", agencyId: "agency-1", userId: "user-1", lastSeenAt: new Date("2026-08-22T20:00:00.000Z") },
  ];

  const tx = {
    creatorAccount: {
      findFirst: async ({ where }) => (
        where.id === creator.id && where.agencyId === creator.agencyId && creator.deletedAt === null ? clone(creator) : null
      ),
    },
    agencyMember: {
      findUnique: async ({ where }) => {
        const key = where.agencyId_userId || {};
        return key.agencyId === liveMember.agencyId && key.userId === liveMember.userId ? clone(liveMember) : null;
      },
    },
    workerDevice: {
      findFirst: async ({ where }) => clone(devices.find((item) => item.id === where.id && item.agencyId === where.agencyId && item.userId === where.userId) || null),
    },
    agencyCryptoRoot: {
      findUnique: async ({ where }) => where.agencyId === "agency-1" ? clone(root) : null,
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => { const key = where.agencyId_deviceId || where; return key.deviceId === "device-1" && (!key.agencyId || key.agencyId === "agency-1") ? { deviceId: "device-1", agencyId: "agency-1", status: "ACTIVE", revokedAt: null } : null; },
    },
    creatorCryptoKeyState: {
      findUnique: async ({ where }) => where.agencyId_creatorId?.agencyId === "agency-1" && where.agencyId_creatorId?.creatorId === "creator-1" ? { agencyId: "agency-1", creatorId: "creator-1", activeVersion: 1, rootVersion: 1 } : null,
    },
    agencyCryptoOwnerKeyWrap: {
      findFirst: async ({ where }) => where.agencyId === "agency-1" && where.rootVersion === 1 && where.deviceId === "device-1" && where.revokedAt === null ? { id: "ow-1" } : null,
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
  return { db: tx, creator, root, liveMember, devices, getState: () => clone(state) };
}

function opaquePayload(keyVersion = 1) {
  return {
    encryptionMode: "CLIENT_E2E_V1", keyVersion, algorithm: "aes-256-gcm-client-e2e-v1",
    ciphertext: Buffer.alloc(48, 0x7a).toString("base64"), iv: Buffer.alloc(12, 0x11).toString("base64"), tag: Buffer.alloc(16, 0x22).toString("base64"),
  };
}

const ownerMember = { role: "OWNER", roleKey: "owner", assignedCreators: null };

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



test("creator session target is active only while DRAFT/READY, with DRAFT reserved for broker-first connect", () => {
  assert.equal(isCreatorSessionTargetActiveStatus("DRAFT"), true);
  assert.equal(isCreatorSessionTargetActiveStatus("READY"), true);
  for (const status of ["DISABLED", "AUTH_FAILED", "NOT_CREATOR", "", null]) {
    assert.equal(isCreatorSessionTargetActiveStatus(status), false, String(status));
    assert.throws(
      () => assertCreatorSessionTargetActive({ status }),
      (error) => error?.code === "CREATOR_SESSION_CREATOR_INACTIVE" && error?.status === 409,
    );
  }
});

test("write path rejects a disabled creator even when direct service callers bypass the route", async () => {
  const { db, creator } = makeDb();
  creator.status = "DISABLED";
  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 0, requestId: "request-disabled", platformUserId: "of-42", payload: payload(),
    }),
    (error) => error?.code === "CREATOR_SESSION_CREATOR_INACTIVE" && error?.status === 409,
  );
});

test("canonical broker payload rejects duplicate cookie identities instead of creating an unhydratable envelope", async () => {
  const duplicate = [payload().cookies[0], { ...payload().cookies[0] }];
  assert.throws(
    () => assertNoDuplicateCookies(duplicate),
    (error) => error?.code === "CREATOR_SESSION_DUPLICATE_COOKIE" && error?.status === 400,
  );

  const { db } = makeDb();
  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 0, requestId: "request-duplicate-cookie", platformUserId: "of-42",
      payload: { ...payload(), cookies: [...payload().cookies, { ...payload().cookies[0] }] },
    }),
    (error) => error?.code === "CREATOR_SESSION_DUPLICATE_COOKIE" && error?.status === 400,
  );
});

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

test("session payload normalization canonicalizes cookie path and persistence semantics for Chromium hydration", () => {
  const normalized = normalizePayload({
    ...payload(),
    cookies: [
      { name: "sess", value: "A", domain: ".onlyfans.com", hostOnly: false, path: "api", secure: true, httpOnly: true, session: false, expirationDate: null },
      { name: "auth_id", value: "42", domain: "onlyfans.com", hostOnly: true, path: "/", secure: true, httpOnly: false, session: true, expirationDate: 1900000000 },
      { name: "persist", value: "P", domain: ".onlyfans.com", hostOnly: false, path: "nested/path", secure: true, httpOnly: false, session: false, expirationDate: 1900000000 },
    ],
  });
  const sess = normalized.cookies.find((cookie) => cookie.name === "sess");
  const auth = normalized.cookies.find((cookie) => cookie.name === "auth_id");
  const persistent = normalized.cookies.find((cookie) => cookie.name === "persist");
  assert.equal(sess.path, "/api");
  assert.equal(sess.session, true, "missing expiry must materialize as a session cookie");
  assert.equal(sess.expirationDate, null);
  assert.equal(auth.session, true);
  assert.equal(auth.expirationDate, null, "session cookie must not carry meaningless expiry metadata");
  assert.equal(persistent.path, "/nested/path");
  assert.equal(persistent.session, false);
  assert.equal(persistent.expirationDate, 1900000000);
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


test("revoke retry is idempotent even when the client repeats the original baseRevision", async () => {
  const { db } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-before-revoke", platformUserId: "of-42", payload: payload(),
  });
  const first = await revokeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 1, requestId: "request-revoke-idempotent", reason: "verified logout",
  });
  assert.equal(first.state.revision, 2);
  assert.equal(first.idempotent, false);

  const retry = await revokeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 1, requestId: "request-revoke-idempotent", reason: "verified logout",
  });
  assert.equal(retry.state.revision, 2);
  assert.equal(retry.state.status, "REVOKED");
  assert.equal(retry.idempotent, true);
  assert.equal(retry.unchanged, true);
});

test("revoke increments revision, deletes ciphertext fields, and generic write cannot resurrect it", async () => {
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

  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
      baseRevision: 2, requestId: "request-0003", platformUserId: "of-42", payload: payload({ sess: "sess-new" }),
    }),
    (error) => error?.code === "CREATOR_SESSION_REVOKED" && error?.status === 409 && error?.current?.status === "REVOKED",
  );
  assert.equal(getState().revision, 2);
  assert.equal(getState().status, "REVOKED");
  assert.equal(getState().encryptedPayload, null);
});

test("V20.19 SERVER_V1 session migrates to opaque representation without canonical revision churn", async () => {
  const { db, getState } = makeDb();
  const clear = payload();
  const hashes = hashesForPayload(clear);
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1",
    baseRevision: 0, requestId: "migration-source-1", platformUserId: "of-42", payload: clear,
  });
  const before = await getCreatorSession({ db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: ownerMember });
  assert.equal(before.revision, 1);
  assert.equal(before.encryptionMode, "SERVER_V1");
  assert.deepEqual(before.payload, hashes.payload);

  const migrated = await migrateCreatorSessionToOpaque({
    db, agencyId: "agency-1", creatorId: "creator-1", deviceId: "device-1", member: ownerMember, expectedRevision: 1, platformUserId: "of-42",
    credentialHash: hashes.credentialHash, coherenceHash: hashes.coherenceHash, opaquePayload: opaquePayload(1),
  });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.state.revision, 1, "representation migration must not rotate canonical session revision");
  const stored = getState();
  assert.equal(stored.revision, 1);
  assert.equal(stored.encryptionMode, "CLIENT_E2E_V1");
  assert.equal(stored.keyVersion, 1);

  const after = await getCreatorSession({ db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: ownerMember });
  assert.equal(after.payload, null);
  assert.equal(after.opaquePayload.encryptionMode, "CLIENT_E2E_V1");
  assert.equal(after.opaquePayload.ciphertext, opaquePayload(1).ciphertext);
});

test("V20.19 opaque enforcement blocks legacy session decrypt and legacy writes", async () => {
  const { db, root } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1",
    baseRevision: 0, requestId: "legacy-before-enforce", platformUserId: "of-42", payload: payload(),
  });
  root.enforceOpaqueSecrets = true;
  await assert.rejects(
    getCreatorSession({ db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: ownerMember }),
    (error) => error?.code === "CREATOR_SESSION_LEGACY_DECRYPT_DISABLED",
  );
  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", actorMember: ownerMember, deviceId: "device-1",
      baseRevision: 1, requestId: "legacy-after-enforce", platformUserId: "of-42", payload: payload({ sess: "new" }),
    }),
    (error) => error?.code === "CREATOR_SESSION_LEGACY_WRITE_DISABLED",
  );
});

test("shadow-session normalization drops Cloudflare, analytics and CDN noise before hashing", () => {
  const normalized = normalizePayload({
    ...payload(),
    cookies: [
      ...payload().cookies,
      { name: "__cf_bm", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "__cflb", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "cf_clearance", value: "noise", domain: ".onlyfans.com", path: "/" },
      { name: "cf_chl_2", value: "noise", domain: ".onlyfans.com", path: "/" },
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


test("V20.19 initial session write cannot resurrect credentials after creator soft-delete races the transaction", async () => {
  const { db, creator, getState } = makeDb();
  const originalTransaction = db.$transaction.bind(db);
  db.$transaction = async (fn, options) => {
    creator.deletedAt = new Date("2026-08-24T13:30:00.000Z");
    creator.status = "DISABLED";
    return originalTransaction(fn, options);
  };

  await assert.rejects(
    writeCreatorSession({
      db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", actorMember: ownerMember,
      deviceId: "device-1", baseRevision: 0, requestId: "request-delete-race", platformUserId: "of-42", payload: payload(),
    }),
    (error) => ["CREATOR_NOT_FOUND", "CREATOR_SESSION_CREATOR_INACTIVE"].includes(error?.code),
  );
  assert.equal(getState(), null, "no canonical session row may be created after creator deletion commits");
});


test("legacy session payload read rechecks live creator assignment inside the secret-read transaction", async () => {
  const { db, liveMember } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-read-access-race", platformUserId: "of-42", payload: payload(),
  });
  const staleRouteMember = clone(liveMember);
  liveMember.assignedCreators = [];
  await assert.rejects(
    getCreatorSession({ db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: staleRouteMember, userId: "user-1" }),
    (error) => error?.code === "CREATOR_SESSION_ACCESS_REVOKED" && error?.status === 403,
  );
});

test("legacy session payload read rechecks creator deletion inside the secret-read transaction", async () => {
  const { db, creator, liveMember } = makeDb();
  await writeCreatorSession({
    db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1",
    baseRevision: 0, requestId: "request-read-delete-race", platformUserId: "of-42", payload: payload(),
  });
  creator.deletedAt = new Date("2026-08-24T15:10:00Z");
  await assert.rejects(
    getCreatorSession({ db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: clone(liveMember), userId: "user-1" }),
    (error) => error?.code === "CREATOR_NOT_FOUND" && error?.status === 404,
  );
});

test("creator session secret reads use a Serializable transaction rather than an unfenced row read", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "creator-session-broker-service.js"), "utf8");
  const start = source.indexOf("async function getCreatorSession");
  const end = source.indexOf("async function migrateCreatorSessionToOpaque", start);
  const block = source.slice(start, end);
  assert.match(block, /runSessionReadSerializable/);
});
