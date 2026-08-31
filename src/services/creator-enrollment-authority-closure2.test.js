"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  observeCreatorPlatformProfile,
  revokeCreatorConnection,
} = require("./creator-enrollment-authority-service");
const { requireBoundAccessDevice } = require("../utils/device-binding");

function clone(value) { return value == null ? value : structuredClone(value); }
function norm(value) { return String(value || "").trim().replace(/^@+/, "").toLowerCase(); }

function makeConnectedDb() {
  const creator = {
    id: "creator-1",
    agencyId: "agency-1",
    displayName: "Alice",
    username: "alice",
    enrollmentExpectedUsername: null,
    platformUsername: "alice",
    platformDisplayName: "Alice",
    platformAvatarUrl: "https://img/old.jpg",
    platformProfileObservedAt: new Date("2026-08-31T10:00:00.000Z"),
    platformProfileSourceDeviceId: "device-a",
    platformProfileConnectionGeneration: 1,
    avatarUrl: "https://img/old.jpg",
    remoteId: "123",
    status: "READY",
    connectionState: "CONNECTED",
    connectionGeneration: 1,
    connectionStartedAt: null,
    connectedSessionRevision: 7,
    deletedAt: null,
  };
  const session = {
    id: "session-1", agencyId: "agency-1", creatorId: "creator-1",
    revision: 7, status: "ACTIVE", connectionGeneration: 1,
    payloadVersion: 1, portableReady: true, encryptionMode: "CLIENT_E2E_V1",
    keyVersion: 1, encryptedPayload: "cipher", iv: "iv", tag: "tag",
    algorithm: "aes-256-gcm-client-e2e-v1", platformUserId: "123",
    credentialHash: "a".repeat(64), coherenceHash: "b".repeat(64),
    capturedAt: new Date("2026-08-31T09:59:59.000Z"), capturedByUserId: "user-1",
    capturedByDeviceId: "device-a", sourceRequestId: "proof-1", revokedAt: null, revokeReason: null,
  };
  const member = {
    id: "member-1", agencyId: "agency-1", userId: "user-1", role: "WORKER", roleKey: "worker",
    assignedCreators: ["creator-1"], permissions: { "creators.manage": true },
    deletedAt: null, deactivatedAt: null,
  };
  let serial = Promise.resolve();

  function matchesCreator(row, where = {}) {
    if (where.id && typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.not && row.id === where.id.not) return false;
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (Object.prototype.hasOwnProperty.call(where, "deletedAt") && where.deletedAt === null && row.deletedAt !== null) return false;
    if (Array.isArray(where.OR)) {
      return where.OR.some((clause) => {
        if (clause.remoteId) return String(row.remoteId || "") === String(clause.remoteId);
        for (const key of ["platformUsername", "enrollmentExpectedUsername", "username"]) {
          if (clause[key]?.equals !== undefined) return norm(row[key]) === norm(clause[key].equals);
        }
        return false;
      });
    }
    return true;
  }
  function applyData(row, data) {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) {
        row[key] = Number(row[key] || 0) + Number(value.increment);
      } else {
        row[key] = clone(value);
      }
    }
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
      findFirst: async ({ where }) => matchesCreator(creator, where) ? clone(creator) : null,
      update: async ({ where, data }) => {
        if (where.id !== creator.id) throw new Error("missing creator");
        applyData(creator, data);
        return clone(creator);
      },
      updateMany: async ({ where, data }) => {
        if (!matchesCreator(creator, where)) return { count: 0 };
        applyData(creator, data);
        return { count: 1 };
      },
    },
    creatorSessionState: {
      findUnique: async ({ where }) => where.creatorId === session.creatorId ? clone(session) : null,
      updateMany: async ({ where, data }) => {
        if (where.creatorId !== session.creatorId || where.agencyId !== session.agencyId) return { count: 0 };
        if (where.revision !== undefined && Number(where.revision) !== Number(session.revision)) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(session.status)) return { count: 0 };
        if (typeof where.status === "string" && where.status !== session.status) return { count: 0 };
        applyData(session, data);
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
    db: tx, creator, session, member,
    creatorSnapshot: () => clone(creator),
    sessionSnapshot: () => clone(session),
  };
}

function profileInput(overrides = {}) {
  return {
    agencyId: "agency-1", creatorId: "creator-1", userId: "user-1",
    sourceDeviceId: "device-b", connectionGeneration: 1,
    observedAt: "2026-08-31T10:02:00.000Z",
    remoteId: "123", username: "alice_new", platformDisplayName: "Alice New",
    avatarUrl: "https://img/new.jpg",
    ...overrides,
  };
}

function revokeInput(overrides = {}) {
  return {
    agencyId: "agency-1", creatorId: "creator-1", userId: "user-1",
    deviceId: "device-a", baseRevision: 7, requestId: "revoke-request-1", reason: "test",
    ...overrides,
  };
}

test("assigned chatter with creator access cannot perform destructive global revoke", async () => {
  const ctx = makeConnectedDb();
  ctx.member.permissions["creators.manage"] = false;
  await assert.rejects(
    revokeCreatorConnection({ db: ctx.db, ...revokeInput() }),
    (error) => error?.code === "CREATOR_MANAGEMENT_FORBIDDEN" && error?.status === 403,
  );
  assert.equal(ctx.session.status, "ACTIVE");
  assert.equal(ctx.creator.connectionState, "CONNECTED");
  assert.equal(ctx.session.encryptedPayload, "cipher");
});

test("live manager authority can revoke canonical and project RECONNECT_REQUIRED", async () => {
  const ctx = makeConnectedDb();
  const result = await revokeCreatorConnection({ db: ctx.db, ...revokeInput() });
  assert.equal(result.state.status, "REVOKED");
  assert.equal(ctx.session.status, "REVOKED");
  assert.equal(ctx.session.encryptedPayload, null);
  assert.equal(ctx.creator.connectionState, "RECONNECT_REQUIRED");
});

test("management permission lost after admission but before destructive mutation prevents revoke", async () => {
  const ctx = makeConnectedDb();
  await assert.rejects(
    revokeCreatorConnection({
      db: ctx.db,
      ...revokeInput(),
      beforeRevoke: async () => { ctx.member.permissions["creators.manage"] = false; },
    }),
    (error) => error?.code === "CREATOR_MANAGEMENT_FORBIDDEN" && error?.status === 403,
  );
  assert.equal(ctx.session.status, "ACTIVE");
  assert.equal(ctx.creator.connectionState, "CONNECTED");
});

test("member deactivation after admission but before destructive mutation prevents revoke", async () => {
  const ctx = makeConnectedDb();
  await assert.rejects(
    revokeCreatorConnection({
      db: ctx.db,
      ...revokeInput(),
      beforeRevoke: async () => { ctx.member.deactivatedAt = new Date(); },
    }),
    (error) => error?.code === "CREATOR_CONNECTION_MEMBER_INACTIVE" && error?.status === 403,
  );
  assert.equal(ctx.session.status, "ACTIVE");
  assert.equal(ctx.creator.connectionState, "CONNECTED");
});

test("newer T2 platform observation stays current when delayed T1 arrives last", async () => {
  const ctx = makeConnectedDb();
  const t2 = await observeCreatorPlatformProfile({ db: ctx.db, ...profileInput() });
  assert.equal(t2.unchanged, false);
  const delayedT1 = await observeCreatorPlatformProfile({
    db: ctx.db,
    ...profileInput({
      sourceDeviceId: "device-a",
      observedAt: "2026-08-31T10:01:00.000Z",
      username: "alice_old",
      platformDisplayName: "Alice Old",
      avatarUrl: "https://img/older.jpg",
    }),
  });
  assert.equal(delayedT1.staleNoop, true);
  assert.equal(ctx.creator.platformUsername, "alice_new");
  assert.equal(ctx.creator.platformDisplayName, "Alice New");
  assert.equal(ctx.creator.platformAvatarUrl, "https://img/new.jpg");
  assert.equal(new Date(ctx.creator.platformProfileObservedAt).toISOString(), "2026-08-31T10:02:00.000Z");
  assert.equal(ctx.creator.platformProfileSourceDeviceId, "device-b");
});

test("profile observation clock cannot poison freshness with evidence too far in the future", async () => {
  const ctx = makeConnectedDb();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await assert.rejects(
    observeCreatorPlatformProfile({ db: ctx.db, ...profileInput({ observedAt: future }) }),
    (error) => error?.code === "CREATOR_PROFILE_OBSERVED_AT_FUTURE" && error?.status === 409,
  );
  assert.equal(ctx.creator.platformUsername, "alice");
});

test("old connection generation observation after reconnect cannot mutate current profile", async () => {
  const ctx = makeConnectedDb();
  ctx.creator.connectionGeneration = 2;
  ctx.creator.platformProfileConnectionGeneration = 2;
  ctx.creator.platformProfileObservedAt = new Date("2026-08-31T11:00:00.000Z");
  ctx.creator.platformProfileSourceDeviceId = "device-b";
  ctx.creator.platformUsername = "alice_generation_2";
  const result = await observeCreatorPlatformProfile({
    db: ctx.db,
    ...profileInput({
      connectionGeneration: 1,
      observedAt: "2026-08-31T12:00:00.000Z",
      username: "stale_generation_1",
    }),
  });
  assert.equal(result.staleNoop, true);
  assert.equal(result.reason, "STALE_CONNECTION_GENERATION");
  assert.equal(ctx.creator.platformUsername, "alice_generation_2");
});

test("platform profile observation with a different immutable remoteId is rejected", async () => {
  const ctx = makeConnectedDb();
  await assert.rejects(
    observeCreatorPlatformProfile({ db: ctx.db, ...profileInput({ remoteId: "999" }) }),
    (error) => error?.code === "CREATOR_PROFILE_IDENTITY_MISMATCH" && error?.status === 409,
  );
  assert.equal(ctx.creator.remoteId, "123");
  assert.equal(ctx.creator.platformUsername, "alice");
});

test("creator access revoked before platform profile commit prevents current projection mutation", async () => {
  const ctx = makeConnectedDb();
  await assert.rejects(
    observeCreatorPlatformProfile({
      db: ctx.db,
      ...profileInput(),
      beforeCommit: async () => { ctx.member.assignedCreators = []; },
    }),
    (error) => error?.code === "CREATOR_ACCESS_FORBIDDEN" && error?.status === 403,
  );
  assert.equal(ctx.creator.platformUsername, "alice");
  assert.equal(ctx.creator.platformAvatarUrl, "https://img/old.jpg");
});

test("equal observation timestamps use sourceDeviceId as deterministic tie-breaker", async () => {
  const ctx = makeConnectedDb();
  ctx.creator.platformProfileObservedAt = new Date("2026-08-31T10:02:00.000Z");
  ctx.creator.platformProfileSourceDeviceId = "device-b";
  ctx.creator.platformUsername = "winner_b";

  const lower = await observeCreatorPlatformProfile({
    db: ctx.db,
    ...profileInput({ sourceDeviceId: "device-a", username: "loser_a" }),
  });
  assert.equal(lower.staleNoop, true);
  assert.equal(ctx.creator.platformUsername, "winner_b");

  const higher = await observeCreatorPlatformProfile({
    db: ctx.db,
    ...profileInput({ sourceDeviceId: "device-z", username: "winner_z" }),
  });
  assert.equal(higher.unchanged, false);
  assert.equal(ctx.creator.platformUsername, "winner_z");
  assert.equal(ctx.creator.platformProfileSourceDeviceId, "device-z");
});

test("device-bound profile provenance rejects a mismatched supplied source device", () => {
  assert.throws(
    () => requireBoundAccessDevice(
      "device-a",
      "device-b",
      { requiredCode: "CREATOR_PROFILE_DEVICE_BOUND_TOKEN_REQUIRED", mismatchCode: "CREATOR_PROFILE_AUTH_DEVICE_MISMATCH" },
    ),
    (error) => error?.code === "CREATOR_PROFILE_AUTH_DEVICE_MISMATCH" && error?.status === 403,
  );
});

test("Closure2 schema stores explicit profile observation provenance without fabricating a migration clock", () => {
  const root = path.join(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma/migrations/20260831210000_creator_enrollment_authority_closure2/migration.sql"), "utf8");
  assert.match(schema, /platformProfileObservedAt\s+DateTime\?/);
  assert.match(schema, /platformProfileSourceDeviceId\s+String\?/);
  assert.match(schema, /platformProfileConnectionGeneration\s+Int\?/);
  assert.match(migration, /ADD COLUMN "platformProfileObservedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "platformProfileSourceDeviceId" TEXT/);
  assert.match(migration, /ADD COLUMN "platformProfileConnectionGeneration" INTEGER/);
  assert.doesNotMatch(migration, /UPDATE[\s\S]*platformProfileObservedAt/i);
});

test("public revoke and profile routes are wired to live authority and device-bound provenance", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/creator-sessions.js"), "utf8");
  const creators = fs.readFileSync(path.join(__dirname, "../routes/creators.js"), "utf8");
  assert.match(routes, /router\.post\("\/:creatorId\/revoke", creatorManagementRequired/);
  assert.match(routes, /revokeCreatorConnection/);
  const revokeBlock = routes.slice(routes.indexOf('router.post("/:creatorId/revoke"'), routes.indexOf('router.post("/:creatorId/revoke"') + 2500);
  assert.doesNotMatch(revokeBlock, /revokeCreatorSession\s*\(/);
  assert.match(creators, /deviceId:\s*z\.string\(\).*max\(180\)/s);
  assert.match(creators, /connectionGeneration:\s*z\.number\(\)\.int\(\)\.positive\(\)/);
  assert.match(creators, /observedAt:\s*z\.string\(\)\.datetime\(\)/);
  assert.match(creators, /requireAuthDevice\(req, input\.deviceId/);
  assert.match(creators, /sourceDeviceId,/);
});
