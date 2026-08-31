"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createCreatorDraft,
  beginCreatorConnection,
  completeCreatorConnection,
  observeCreatorPlatformProfile,
} = require("./creator-enrollment-authority-service");
const { revokeCreatorSession } = require("./creator-session-broker-service");

function clone(value) { return value == null ? value : structuredClone(value); }
function norm(value) { return String(value || "").trim().replace(/^@+/, "").toLowerCase(); }
function p2002() { return Object.assign(new Error("unique"), { code: "P2002" }); }

function makeDb() {
  const creators = new Map();
  const sessions = new Map();
  const member = {
    id: "member-1", agencyId: "agency-1", userId: "user-1", role: "WORKER", roleKey: "worker",
    assignedCreators: [], permissions: { "creators.manage": true }, deletedAt: null, deactivatedAt: null,
  };
  let serial = Promise.resolve();
  let seq = 0;

  function activeCreatorsExcept(id = null) {
    return [...creators.values()].filter((row) => row.deletedAt == null && row.id !== id);
  }
  function candidateUsername(row) {
    return norm(row.platformUsername || row.enrollmentExpectedUsername || row.username);
  }
  function assertUnique(next, excludeId = null) {
    for (const row of activeCreatorsExcept(excludeId)) {
      if (next.remoteId && row.remoteId && String(next.remoteId) === String(row.remoteId)) throw p2002();
      const username = candidateUsername(next);
      if (username && username === candidateUsername(row)) throw p2002();
    }
  }
  function matches(row, where = {}) {
    if (where.id && typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.not && row.id === where.id.not) return false;
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (Object.prototype.hasOwnProperty.call(where, "deletedAt") && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.remoteId && String(row.remoteId || "") !== String(where.remoteId)) return false;
    if (Array.isArray(where.OR)) {
      const yes = where.OR.some((clause) => {
        if (clause.remoteId) return String(row.remoteId || "") === String(clause.remoteId);
        for (const key of ["platformUsername", "enrollmentExpectedUsername", "username"]) {
          if (clause[key]?.equals !== undefined) return norm(row[key]) === norm(clause[key].equals);
        }
        return false;
      });
      if (!yes) return false;
    }
    return true;
  }
  function applyData(row, data) {
    const next = { ...row };
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) next[key] = Number(next[key] || 0) + Number(value.increment);
      else next[key] = clone(value);
    }
    return next;
  }

  const tx = {
    $executeRawUnsafe: async () => 1,
    agencyMember: {
      findUnique: async ({ where }) => {
        const key = where.agencyId_userId || {};
        return key.agencyId === member.agencyId && key.userId === member.userId ? clone(member) : null;
      },
    },
    creatorAccount: {
      findFirst: async ({ where }) => clone([...creators.values()].find((row) => matches(row, where)) || null),
      create: async ({ data }) => {
        const row = { id: `creator-${++seq}`, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
        assertUnique(row);
        creators.set(row.id, row);
        if (!member.assignedCreators.includes(row.id)) member.assignedCreators.push(row.id);
        return clone(row);
      },
      update: async ({ where, data }) => {
        const row = creators.get(where.id);
        if (!row) throw new Error("missing creator");
        const next = applyData(row, data);
        assertUnique(next, row.id);
        creators.set(row.id, next);
        return clone(next);
      },
      updateMany: async ({ where, data }) => {
        const row = [...creators.values()].find((item) => matches(item, where));
        if (!row) return { count: 0 };
        const next = applyData(row, data);
        assertUnique(next, row.id);
        creators.set(row.id, next);
        return { count: 1 };
      },
    },
    creatorSessionState: {
      findUnique: async ({ where }) => clone(sessions.get(where.creatorId) || null),
      updateMany: async ({ where, data }) => {
        const row = sessions.get(where.creatorId);
        if (!row || row.agencyId !== where.agencyId) return { count: 0 };
        if (where.revision !== undefined && Number(row.revision) !== Number(where.revision)) return { count: 0 };
        if (where.status !== undefined) {
          const allowed = where.status?.in;
          if (Array.isArray(allowed) ? !allowed.includes(row.status) : row.status !== where.status) return { count: 0 };
        }
        const next = applyData(row, data);
        sessions.set(row.creatorId, next);
        return { count: 1 };
      },
    },
  };
  tx.$transaction = (work) => {
    const run = serial.catch(() => undefined).then(() => work(tx));
    serial = run.catch(() => undefined);
    return run;
  };

  return {
    db: tx, creators, sessions, member,
    creator(id) { return clone(creators.get(id)); },
    setAssignments(ids) { member.assignedCreators = [...ids]; },
    publishCanonical(creatorId, remoteId, username, { revision = 7 } = {}) {
      const creator = creators.get(creatorId);
      const startedAt = new Date(creator.connectionStartedAt || Date.now());
      sessions.set(creatorId, {
        id: `session-${creatorId}`, agencyId: creator.agencyId, creatorId, revision, status: "ACTIVE",
        connectionGeneration: Number(creator.connectionGeneration), payloadVersion: 1, portableReady: true,
        encryptionMode: "CLIENT_E2E_V1", keyVersion: 1, encryptedPayload: "cipher", iv: "iv", tag: "tag", algorithm: "aes-256-gcm-client-e2e-v1",
        platformUserId: String(remoteId), credentialHash: "a".repeat(64), coherenceHash: "b".repeat(64),
        capturedAt: new Date(startedAt.getTime() + 1000), capturedByUserId: "user-1", capturedByDeviceId: "device-1",
        sourceRequestId: `proof:${username}`, revokedAt: null, revokeReason: null,
      });
    },
  };
}

async function draft(ctx, username) {
  return createCreatorDraft({ db: ctx.db, agencyId: "agency-1", displayName: username, username });
}
async function begin(ctx, creatorId) {
  return beginCreatorConnection({ db: ctx.db, agencyId: "agency-1", creatorId, userId: "user-1", deviceId: "device-1" });
}
async function complete(ctx, creator, remoteId, username) {
  const current = ctx.creator(creator.id);
  return completeCreatorConnection({
    db: ctx.db, agencyId: "agency-1", creatorId: creator.id, userId: "user-1",
    connectionGeneration: current.connectionGeneration, remoteId, username,
    platformDisplayName: username, avatarUrl: `https://img/${username}.jpg`,
  });
}

test("two simultaneous CREATE of the same normalized username leave exactly one active DRAFT", async () => {
  const ctx = makeDb();
  const results = await Promise.allSettled([draft(ctx, "Alice"), draft(ctx, "@alice")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected.reason?.code, "CREATOR_ALREADY_EXISTS");
  assert.equal([...ctx.creators.values()].filter((row) => row.deletedAt == null).length, 1);
});

test("two creators completing concurrently for the same immutable remoteId produce exactly one owner", async () => {
  const ctx = makeDb();
  const a = await draft(ctx, "alice");
  const b = await draft(ctx, "bella");
  await begin(ctx, a.id); await begin(ctx, b.id);
  ctx.publishCanonical(a.id, "123", "alice");
  ctx.publishCanonical(b.id, "123", "bella");
  const results = await Promise.allSettled([complete(ctx, a, "123", "alice"), complete(ctx, b, "123", "bella")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected.reason?.code, "CREATOR_ALREADY_EXISTS");
  assert.equal([...ctx.creators.values()].filter((row) => row.remoteId === "123" && row.connectionState === "CONNECTED").length, 1);
});

test("revoke wins before connection commit: old canonical proof cannot make creator READY", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "123", "alice");
  await revokeCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: creator.id, actorUserId: "user-1", deviceId: "device-1", baseRevision: 7, requestId: "revoke-before", reason: "test" });
  await assert.rejects(complete(ctx, creator, "123", "alice"), (error) => error?.code === "CREATOR_CONNECTION_STATE_CONFLICT");
  assert.equal(ctx.creator(creator.id).status, "DRAFT");
  assert.equal(ctx.creator(creator.id).connectionState, "ENROLLMENT_REQUIRED");
});

test("connection commit wins then revoke: business creator remains READY but connection becomes RECONNECT_REQUIRED", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "123", "alice");
  await complete(ctx, creator, "123", "alice");
  const revision = ctx.sessions.get(creator.id).revision;
  await revokeCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: creator.id, actorUserId: "user-1", deviceId: "device-1", baseRevision: revision, requestId: "revoke-after", reason: "test" });
  assert.equal(ctx.creator(creator.id).status, "READY");
  assert.equal(ctx.creator(creator.id).connectionState, "RECONNECT_REQUIRED");
  assert.equal(ctx.sessions.get(creator.id).status, "REVOKED");
});

test("creator access revoked after request admission but before commit rejects READY transition", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "123", "alice");
  ctx.setAssignments([]);
  await assert.rejects(complete(ctx, creator, "123", "alice"), (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403);
  assert.equal(ctx.creator(creator.id).status, "DRAFT");
});

test("first enrollment keeps provisional username as wrong-account fence", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "999", "bob");
  await assert.rejects(complete(ctx, creator, "999", "bob"), (error) => error?.code === "CREATOR_IDENTITY_MISMATCH");
  assert.equal(ctx.creator(creator.id).remoteId, null);
});

test("explicit reconnect preserves creatorId and requires the same immutable remoteId", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "123", "alice");
  await complete(ctx, creator, "123", "alice");
  await revokeCreatorSession({ db: ctx.db, agencyId: "agency-1", creatorId: creator.id, actorUserId: "user-1", deviceId: "device-1", baseRevision: 7, requestId: "revoke", reason: "test" });
  const reconnect = await begin(ctx, creator.id);
  assert.equal(reconnect.mode, "RECONNECT");
  assert.equal(ctx.sessions.get(creator.id).status, "REINITIALIZING");
  assert.equal(ctx.sessions.get(creator.id).encryptedPayload, null);
  assert.equal(ctx.sessions.get(creator.id).connectionGeneration, reconnect.connectionGeneration);
  ctx.publishCanonical(creator.id, "999", "other", { revision: 9 });
  await assert.rejects(complete(ctx, creator, "999", "other"), (error) => error?.code === "CREATOR_IDENTITY_MISMATCH");

  ctx.publishCanonical(creator.id, "123", "alice_new", { revision: 10 });
  const done = await complete(ctx, creator, "123", "alice_new");
  assert.equal(done.creator.id, creator.id);
  assert.equal(done.creator.remoteId, "123");
  assert.equal(done.creator.platformUsername, "alice_new");
  assert.equal(done.creator.connectionState, "CONNECTED");
});


test("connected platform username is mutable profile state while immutable remoteId remains authority", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "123", "alice");
  await complete(ctx, creator, "123", "alice");

  const changed = await observeCreatorPlatformProfile({
    db: ctx.db,
    agencyId: "agency-1",
    creatorId: creator.id,
    userId: "user-1",
    remoteId: "123",
    username: "alice_new",
    platformDisplayName: "Alice New",
    avatarUrl: "https://img/alice-new.jpg",
  });
  assert.equal(changed.creator.id, creator.id);
  assert.equal(changed.creator.remoteId, "123");
  assert.equal(changed.creator.username, "alice_new");
  assert.equal(changed.creator.platformUsername, "alice_new");
  assert.equal(changed.creator.connectionState, "CONNECTED");
  assert.equal(ctx.sessions.get(creator.id).status, "ACTIVE");

  await assert.rejects(
    observeCreatorPlatformProfile({
      db: ctx.db,
      agencyId: "agency-1",
      creatorId: creator.id,
      userId: "user-1",
      remoteId: "999",
      username: "other",
    }),
    (error) => error?.code === "CREATOR_PROFILE_IDENTITY_MISMATCH",
  );
  assert.equal(ctx.creator(creator.id).remoteId, "123");
  assert.equal(ctx.creator(creator.id).platformUsername, "alice_new");
});

test("reconnect generation is an explicit crypto-shredded boundary before fresh canonical publication", async () => {
  const ctx = makeDb();
  const creator = await draft(ctx, "alice");
  await begin(ctx, creator.id);
  ctx.publishCanonical(creator.id, "123", "alice");
  await complete(ctx, creator, "123", "alice");
  await revokeCreatorSession({
    db: ctx.db,
    agencyId: "agency-1",
    creatorId: creator.id,
    actorUserId: "user-1",
    deviceId: "device-1",
    baseRevision: 7,
    requestId: "revoke-boundary",
    reason: "test",
  });
  const before = clone(ctx.sessions.get(creator.id));
  assert.equal(before.status, "REVOKED");
  const reconnect = await begin(ctx, creator.id);
  const boundary = ctx.sessions.get(creator.id);
  assert.equal(reconnect.mode, "RECONNECT");
  assert.equal(boundary.status, "REINITIALIZING");
  assert.equal(boundary.connectionGeneration, reconnect.connectionGeneration);
  assert.equal(boundary.encryptedPayload, null);
  assert.equal(boundary.platformUserId, null);
  assert.equal(boundary.credentialHash, null);
  assert.equal(boundary.coherenceHash, null);
  assert.ok(boundary.revision > before.revision);
  assert.equal(ctx.creator(creator.id).status, "READY");
  assert.equal(ctx.creator(creator.id).connectionState, "RECONNECTING");
});
