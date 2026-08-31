"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  isCreatorSessionTargetActiveStatus,
  assertCreatorSessionTargetActive,
  normalizeOpaquePayload,
  publicState,
  requireRegisteredDevice,
  getCreatorSession,
  writeCreatorSession,
  revokeCreatorSession,
} = require("./creator-session-broker-service");

function clone(value) { return value == null ? value : structuredClone(value); }

function opaquePayload(keyVersion = 1, byte = 0x7a) {
  return {
    encryptionMode: "CLIENT_E2E_V1",
    keyVersion,
    algorithm: "aes-256-gcm-client-e2e-v1",
    ciphertext: Buffer.alloc(48, byte).toString("base64"),
    iv: Buffer.alloc(12, 0x11).toString("base64"),
    tag: Buffer.alloc(16, 0x22).toString("base64"),
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function makeDb() {
  let state = null;
  const creator = {
    id: "creator-1", agencyId: "agency-1", remoteId: "of-42", status: "READY", deletedAt: null,
    connectionState: "CONNECTED", connectionGeneration: 1, connectionStartedAt: null, connectedSessionRevision: 1,
  };
  const liveMember = {
    agencyId: "agency-1", userId: "user-1", role: "WORKER", roleKey: "worker",
    assignedCreators: ["creator-1"], deletedAt: null, deactivatedAt: null,
  };
  const devices = [{ id: "device-1", agencyId: "agency-1", userId: "user-1", lastSeenAt: new Date("2026-08-22T20:00:00.000Z") }];

  const tx = {
    creatorAccount: {
      findFirst: async ({ where }) => (
        where.id === creator.id && where.agencyId === creator.agencyId && creator.deletedAt === null ? clone(creator) : null
      ),
      updateMany: async ({ where, data }) => {
        if (where.id !== creator.id || where.agencyId !== creator.agencyId || creator.deletedAt !== null) return { count: 0 };
        Object.assign(creator, clone(data));
        return { count: 1 };
      },
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
      findUnique: async ({ where }) => where.agencyId === "agency-1" ? { agencyId: "agency-1", version: 1, status: "ACTIVE" } : null,
    },
    deviceCryptoIdentity: {
      findUnique: async ({ where }) => {
        const key = where.agencyId_deviceId || where;
        return key.deviceId === "device-1" && (!key.agencyId || key.agencyId === "agency-1")
          ? { deviceId: "device-1", id: "device-1", agencyId: "agency-1", userId: "user-1", status: "ACTIVE", revokedAt: null }
          : null;
      },
    },
    creatorCryptoKeyState: {
      findUnique: async ({ where }) => where.agencyId_creatorId?.agencyId === "agency-1" && where.agencyId_creatorId?.creatorId === "creator-1"
        ? { agencyId: "agency-1", creatorId: "creator-1", activeVersion: 1, rootVersion: 1 }
        : null,
    },
    creatorDeviceKeyWrap: {
      findFirst: async ({ where }) => where.agencyId === "agency-1" && where.creatorId === "creator-1" && Number(where.keyVersion) === 1 && where.deviceId === "device-1" && where.revokedAt === null
        ? { id: "cw-1" }
        : null,
    },
    creatorSessionState: {
      findUnique: async ({ where }) => (where.creatorId === creator.id ? clone(state) : null),
      create: async ({ data }) => {
        if (state) { const error = new Error("unique"); error.code = "P2002"; throw error; }
        state = { id: "css-1", ...clone(data), createdAt: new Date("2026-08-22T20:00:00.000Z"), updatedAt: new Date("2026-08-22T20:00:00.000Z") };
        return clone(state);
      },
      updateMany: async ({ where, data }) => {
        if (!state || state.creatorId !== where.creatorId || state.agencyId !== where.agencyId) return { count: 0 };
        if (where.revision !== undefined && state.revision !== where.revision) return { count: 0 };
        if (where.status !== undefined) {
          if (where.status && typeof where.status === "object" && Array.isArray(where.status.in)) {
            if (!where.status.in.includes(state.status)) return { count: 0 };
          } else if (state.status !== where.status) return { count: 0 };
        }
        if (where.encryptionMode !== undefined && state.encryptionMode !== where.encryptionMode) return { count: 0 };
        const next = clone(data);
        if (next.revision && typeof next.revision === "object" && next.revision.increment) next.revision = state.revision + Number(next.revision.increment);
        state = { ...state, ...next, updatedAt: new Date("2026-08-22T20:00:01.000Z") };
        return { count: 1 };
      },
    },
  };
  tx.$executeRawUnsafe = async () => 1;
  tx.$transaction = async (fn) => fn(tx);
  return { db: tx, creator, liveMember, devices, getState: () => clone(state), setState: (next) => { state = clone(next); } };
}

function writeArgs(ctx, overrides = {}) {
  return {
    db: ctx.db,
    agencyId: "agency-1",
    creatorId: "creator-1",
    actorUserId: "user-1",
    actorMember: clone(ctx.liveMember),
    deviceId: "device-1",
    baseRevision: 0,
    requestId: "request-0001",
    platformUserId: "of-42",
    opaquePayload: opaquePayload(1),
    credentialHash: HASH_A,
    coherenceHash: HASH_B,
    portableReady: true,
    ...overrides,
  };
}

test("creator session target is active only while DRAFT/READY", () => {
  assert.equal(isCreatorSessionTargetActiveStatus("DRAFT"), true);
  assert.equal(isCreatorSessionTargetActiveStatus("READY"), true);
  for (const status of ["DISABLED", "AUTH_FAILED", "NOT_CREATOR", "", null]) {
    assert.equal(isCreatorSessionTargetActiveStatus(status), false, String(status));
    assert.throws(() => assertCreatorSessionTargetActive({ status }), (error) => error?.code === "CREATOR_SESSION_CREATOR_INACTIVE" && error?.status === 409);
  }
});

test("write path rejects a disabled creator even for a direct service caller", async () => {
  const ctx = makeDb();
  ctx.creator.status = "DISABLED";
  await assert.rejects(writeCreatorSession(writeArgs(ctx)), (error) => error?.code === "CREATOR_SESSION_CREATOR_INACTIVE" && error?.status === 409);
});

test("server refuses plaintext creator-session writes after the V20.22 cutover", async () => {
  const ctx = makeDb();
  const input = writeArgs(ctx);
  delete input.opaquePayload;
  input.payload = { cookies: [{ name: "sess", value: "secret" }] };
  await assert.rejects(writeCreatorSession(input), (error) => error?.code === "CREATOR_SESSION_E2E_REQUIRED" && error?.status === 400);
  assert.equal(ctx.getState(), null);
});

test("opaque envelope validates mode, key version, AEAD algorithm, IV and tag", () => {
  assert.equal(normalizeOpaquePayload(opaquePayload()).encryptionMode, "CLIENT_E2E_V1");
  assert.throws(() => normalizeOpaquePayload({ ...opaquePayload(), encryptionMode: "SERVER_V1" }), (e) => e?.code === "CREATOR_SESSION_E2E_MODE_INVALID");
  assert.throws(() => normalizeOpaquePayload({ ...opaquePayload(), keyVersion: 0 }), (e) => e?.code === "CREATOR_SESSION_E2E_KEY_VERSION_INVALID");
  assert.throws(() => normalizeOpaquePayload({ ...opaquePayload(), algorithm: "aes-256-gcm" }), (e) => e?.code === "CREATOR_SESSION_E2E_ALGORITHM_INVALID");
  assert.throws(() => normalizeOpaquePayload({ ...opaquePayload(), iv: Buffer.alloc(8).toString("base64") }), (e) => e?.code === "CREATOR_SESSION_E2E_IV_INVALID");
  assert.throws(() => normalizeOpaquePayload({ ...opaquePayload(), tag: Buffer.alloc(8).toString("base64") }), (e) => e?.code === "CREATOR_SESSION_E2E_TAG_INVALID");
});

test("registered device must belong to the authenticated user and agency", async () => {
  const ctx = makeDb();
  assert.equal((await requireRegisteredDevice({ db: ctx.db, agencyId: "agency-1", userId: "user-1", deviceId: "device-1" })).id, "device-1");
  await assert.rejects(requireRegisteredDevice({ db: ctx.db, agencyId: "agency-1", userId: "other", deviceId: "device-1" }), (e) => e?.code === "CREATOR_SESSION_DEVICE_NOT_REGISTERED");
});

test("initial opaque write creates revision 1 and exact retry is idempotent", async () => {
  const ctx = makeDb();
  const first = await writeCreatorSession(writeArgs(ctx));
  assert.equal(first.state.revision, 1);
  assert.equal(first.state.encryptionMode, "CLIENT_E2E_V1");
  assert.equal(first.state.portableReady, true);
  assert.equal(first.idempotent, false);
  const retry = await writeCreatorSession(writeArgs(ctx));
  assert.equal(retry.state.revision, 1);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.unchanged, true);
});

test("unchanged opaque evidence does not churn canonical revision", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  const same = await writeCreatorSession(writeArgs(ctx, { baseRevision: 1, requestId: "request-0002" }));
  assert.equal(same.state.revision, 1);
  assert.equal(same.unchanged, true);
});

test("changed opaque evidence advances revision and stale base is rejected", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  const changed = await writeCreatorSession(writeArgs(ctx, { baseRevision: 1, requestId: "request-0002", opaquePayload: opaquePayload(1, 0x55), coherenceHash: HASH_C }));
  assert.equal(changed.state.revision, 2);
  assert.equal(changed.unchanged, false);
  await assert.rejects(
    writeCreatorSession(writeArgs(ctx, { baseRevision: 1, requestId: "request-0003", coherenceHash: "d".repeat(64) })),
    (e) => e?.code === "CREATOR_SESSION_REVISION_CONFLICT" && e?.current?.revision === 2,
  );
});


test("capturedAt rejects materially stale evidence and returns the current canonical for reconcile", async () => {
  const ctx = makeDb();
  const canonicalAt = "2026-08-24T20:00:00.000Z";
  await writeCreatorSession(writeArgs(ctx, { capturedAt: canonicalAt }));
  await assert.rejects(
    writeCreatorSession(writeArgs(ctx, {
      baseRevision: 1,
      requestId: "request-stale-capture",
      capturedAt: "2026-08-24T19:54:59.000Z",
      coherenceHash: HASH_C,
      opaquePayload: opaquePayload(1, 0x55),
    })),
    (e) => e?.code === "CREATOR_SESSION_CAPTURED_AT_STALE" && e?.status === 409 && e?.current?.revision === 1,
  );
  assert.equal(ctx.getState().revision, 1);
  assert.equal(new Date(ctx.getState().capturedAt).toISOString(), canonicalAt);
});

test("capturedAt tolerates bounded device clock skew without moving canonical time backwards", async () => {
  const ctx = makeDb();
  const canonicalAt = "2026-08-24T20:00:00.000Z";
  await writeCreatorSession(writeArgs(ctx, { capturedAt: canonicalAt }));
  const changed = await writeCreatorSession(writeArgs(ctx, {
    baseRevision: 1,
    requestId: "request-skewed-capture",
    capturedAt: "2026-08-24T19:56:00.000Z",
    coherenceHash: HASH_C,
    opaquePayload: opaquePayload(1, 0x55),
  }));
  assert.equal(changed.state.revision, 2);
  assert.equal(new Date(ctx.getState().capturedAt).toISOString(), canonicalAt);
});

test("capturedAt rejects evidence too far in the future before it can poison the freshness watermark", async () => {
  const ctx = makeDb();
  const tooFarFuture = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  await assert.rejects(
    writeCreatorSession(writeArgs(ctx, { capturedAt: tooFarFuture })),
    (e) => e?.code === "CREATOR_SESSION_CAPTURED_AT_FUTURE" && e?.status === 409,
  );
  assert.equal(ctx.getState(), null);
});

test("exact request retry remains idempotent even after capturedAt freshness advances", async () => {
  const ctx = makeDb();
  const oldAt = "2026-08-24T20:00:00.000Z";
  await writeCreatorSession(writeArgs(ctx, { capturedAt: oldAt }));
  const retry = await writeCreatorSession(writeArgs(ctx, { capturedAt: "2026-08-24T00:00:00.000Z" }));
  assert.equal(retry.idempotent, true);
  assert.equal(retry.state.revision, 1);
});

test("request id cannot be reused for different canonical evidence", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  await assert.rejects(
    writeCreatorSession(writeArgs(ctx, { baseRevision: 1, coherenceHash: HASH_C })),
    (e) => e?.code === "CREATOR_SESSION_REQUEST_ID_REUSED" && e?.status === 409,
  );
});

test("server rejects a snapshot proven for a different OnlyFans identity", async () => {
  const ctx = makeDb();
  await assert.rejects(writeCreatorSession(writeArgs(ctx, { platformUserId: "of-999" })), (e) => e?.code === "CREATOR_SESSION_IDENTITY_MISMATCH");
});

test("portableReady is an explicit E2E proof bit; backend does not inspect ciphertext", async () => {
  const ctx = makeDb();
  const result = await writeCreatorSession(writeArgs(ctx, { portableReady: false }));
  assert.equal(result.state.portableReady, false);
  assert.equal(ctx.getState().portableReady, false);
  assert.equal(ctx.getState().encryptedPayload, opaquePayload().ciphertext);
});

test("secret read returns opaque envelope only after live membership and CDK recheck", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  const state = await getCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: clone(ctx.liveMember), userId: "user-1" });
  assert.equal(state.payload, null);
  assert.equal(state.opaquePayload.encryptionMode, "CLIENT_E2E_V1");
  assert.equal(state.opaquePayload.ciphertext, opaquePayload().ciphertext);
});

test("secret read rechecks live creator assignment inside the Serializable transaction", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  const staleRouteMember = clone(ctx.liveMember);
  ctx.liveMember.assignedCreators = [];
  await assert.rejects(
    getCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: staleRouteMember, userId: "user-1" }),
    (e) => e?.code === "CREATOR_SESSION_ACCESS_REVOKED" && e?.status === 403,
  );
});

test("secret read rechecks creator deletion inside the Serializable transaction", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  ctx.creator.deletedAt = new Date("2026-08-24T15:10:00Z");
  await assert.rejects(
    getCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: clone(ctx.liveMember), userId: "user-1" }),
    (e) => e?.code === "CREATOR_NOT_FOUND" && e?.status === 404,
  );
});

test("legacy canonical envelopes fail closed instead of being decrypted or migrated", async () => {
  const ctx = makeDb();
  ctx.setState({
    id: "legacy-1", agencyId: "agency-1", creatorId: "creator-1", revision: 7, status: "ACTIVE", payloadVersion: 1,
    portableReady: false, encryptionMode: "SERVER_V1", keyVersion: null, encryptedPayload: "legacy-ciphertext", iv: "iv", tag: "tag", algorithm: "aes-256-gcm",
    platformUserId: "of-42", credentialHash: HASH_A, coherenceHash: HASH_B, capturedAt: new Date(), capturedByDeviceId: "device-1", sourceRequestId: "legacy", revokedAt: null, updatedAt: new Date(),
  });
  await assert.rejects(
    getCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", includePayload: true, deviceId: "device-1", member: clone(ctx.liveMember), userId: "user-1" }),
    (e) => e?.code === "CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED" && e?.status === 409,
  );
  await assert.rejects(
    writeCreatorSession(writeArgs(ctx, { baseRevision: 7, requestId: "request-after-legacy" })),
    (e) => e?.code === "CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED" && e?.status === 409,
  );
});

test("revoke retry is idempotent and revoke crypto-shreds the opaque envelope", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  const first = await revokeCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1", baseRevision: 1, requestId: "request-revoke", reason: "verified logout" });
  assert.equal(first.state.revision, 2);
  assert.equal(first.state.status, "REVOKED");
  assert.equal(ctx.getState().encryptedPayload, null);
  assert.equal(ctx.getState().keyVersion, null);
  assert.equal(ctx.getState().portableReady, false);
  const retry = await revokeCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1", baseRevision: 1, requestId: "request-revoke", reason: "verified logout" });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.state.revision, 2);
});

test("generic write cannot resurrect a revoked canonical session", async () => {
  const ctx = makeDb();
  await writeCreatorSession(writeArgs(ctx));
  await revokeCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: "creator-1", actorUserId: "user-1", deviceId: "device-1", baseRevision: 1, requestId: "request-revoke", reason: "logout" });
  await assert.rejects(writeCreatorSession(writeArgs(ctx, { baseRevision: 2, requestId: "request-resurrect", coherenceHash: HASH_C })), (e) => ["CREATOR_SESSION_CONNECTION_NOT_WRITABLE", "CREATOR_SESSION_REVOKED"].includes(e?.code) && e?.status === 409);
  assert.equal(ctx.getState().encryptedPayload, null);
});

test("initial write cannot resurrect credentials after creator soft-delete races transaction", async () => {
  const ctx = makeDb();
  const originalTransaction = ctx.db.$transaction.bind(ctx.db);
  ctx.db.$transaction = async (fn, options) => {
    ctx.creator.deletedAt = new Date("2026-08-24T13:30:00.000Z");
    ctx.creator.status = "DISABLED";
    return originalTransaction(fn, options);
  };
  await assert.rejects(writeCreatorSession(writeArgs(ctx)), (e) => ["CREATOR_NOT_FOUND", "CREATOR_SESSION_CREATOR_INACTIVE"].includes(e?.code));
  assert.equal(ctx.getState(), null);
});

test("creator session secret reads use a Serializable transaction", () => {
  const source = fs.readFileSync(path.join(__dirname, "creator-session-broker-service.js"), "utf8");
  const start = source.indexOf("async function getCreatorSession");
  const end = source.indexOf("function sessionConflict", start);
  assert.match(source.slice(start, end), /runSessionReadSerializable/);
});
