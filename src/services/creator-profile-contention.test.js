"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { observeCreatorPlatformProfile } = require(process.env.PROFILE_CONTENTION_SOURCE || "./creator-enrollment-authority-service");

const clone = value => structuredClone(value);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function conflict() { return Object.assign(new Error("write conflict"), { code: "P2034" }); }

// Concurrent transaction fixture, not a global Promise queue. This deliberately
// models only the creator row lock modes involved here; the SQL proof separately
// exercises real Prisma, current migrations, constraints and rollback.
function fixture({ failure = null, afterRollback = null } = {}) {
  const creators = new Map(["a", "b"].map(id => [id, {
    id, agencyId: "agency", username: id, platformUsername: id, remoteId: id,
    platformDisplayName: id, platformAvatarUrl: null, avatarUrl: null, avatarRevision: 0,
    connectionGeneration: 1, connectionState: "CONNECTED", status: "READY", deletedAt: null,
    platformProfileConnectionGeneration: 1, platformProfileObservedAt: new Date("2026-01-01"),
    platformProfileSourceDeviceId: "old-device",
  }]));
  const member = { id: "member", userId: "user", agencyId: "agency", role: "OWNER", roleKey: "owner",
    assignedCreators: "all", permissions: {}, accessEpoch: 1, deletedAt: null, deactivatedAt: null };
  const user = { disabledAt: null };
  const locks = new Map(), queries = [], options = [], rollback = [], writes = [];
  let sequence = 0;
  async function lock(id, tx, mode) {
    while (locks.has(id) && locks.get(id).tx !== tx) await locks.get(id).released.promise;
    if (!locks.has(id)) locks.set(id, { tx, mode, released: deferred() });
  }
  const db = {
    async $transaction(work, config) {
      const txId = ++sequence, local = new Map(); options.push(config);
      const tx = {
        async $executeRawUnsafe(sql, ...params) { queries.push({ txId, sql, params }); return 1; },
        async $queryRawUnsafe(sql, ...params) {
          queries.push({ txId, sql, params });
          if (sql.includes('FROM "CreatorAccount"')) {
            const mode = sql.includes("FOR NO KEY UPDATE") ? "NO_KEY_UPDATE" : "UPDATE";
            await lock(params[0], txId, mode);
            return creators.has(params[0]) ? [{ id: params[0] }] : [];
          }
          if (sql.includes('FROM "Agency"')) return [{ id: "agency", deletedAt: null }];
          if (sql.includes('FROM "User"')) return user.disabledAt ? [] : [{ id: "user" }];
          if (sql.includes('FROM "AgencyMember"')) return [{ id: "member" }];
          return [];
        },
        agencyMember: {
          async findUnique() { return clone(member); },
          async findFirst() { return member.deletedAt || member.deactivatedAt || user.disabledAt ? null : clone(member); },
        },
        creatorAccount: {
          async findFirst({ where }) {
            if (typeof where.id === "string") {
              const row = local.get(where.id) || creators.get(where.id);
              return row && !row.deletedAt ? clone(row) : null;
            }
            const match = [...creators.values()].find(row => row.id !== where.id?.not && !row.deletedAt
              && where.OR?.some(clause => Object.entries(clause).some(([key, condition]) =>
                typeof condition?.equals === "string" && String(row[key]).toLowerCase() === condition.equals)));
            return match ? { id: match.id } : null;
          },
          async update({ where, data }) {
            const row = clone(local.get(where.id) || creators.get(where.id));
            for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? (row[key] || 0) + value.increment : clone(value);
            local.set(row.id, row); writes.push({ txId, id: row.id });
            if (failure) await failure({ txId, row, config });
            return clone(row);
          },
        },
      };
      try {
        const result = await work(tx);
        for (const [id, row] of local) creators.set(id, row);
        return result;
      } catch (error) {
        rollback.push(txId);
        if (afterRollback) await afterRollback({ txId, creators, member, error });
        throw error;
      } finally {
        for (const [id, item] of locks) if (item.tx === txId) { locks.delete(id); item.released.resolve(); }
      }
    },
  };
  return { db, creators, member, user, queries, options, rollback, writes,
    assertDependentWriteAllowed(id) {
      // The actual lifecycle trigger uses KEY SHARE NOWAIT. It must coexist
      // with the profile lock, but still fail against a retirement FOR UPDATE.
      assert.notEqual(locks.get(id)?.mode, "UPDATE", "profile incorrectly blocks the dependent writer's KEY SHARE fence");
    },
  };
}
function input(f, extra = {}) {
  return { db: f.db, agencyId: "agency", creatorId: "a", userId: "user", actorMember: clone(f.member),
    sourceDeviceId: "device-a", connectionGeneration: 1, observedAt: "2026-01-02T00:00:00Z",
    remoteId: "a", username: "a", platformDisplayName: "Updated", avatarUrl: "https://example.test/avatar.png", ...extra };
}

test("profile has a dedicated ReadCommitted root and does not enter the session advisory lane", async () => {
  const f = fixture();
  await observeCreatorPlatformProfile(input(f));
  assert.equal(f.options[0].isolationLevel, "ReadCommitted");
  assert(!f.queries.some(q => q.params.some(p => typeof p === "string" && p.startsWith("creator_connection:"))));
  assert(f.queries.some(q => q.sql.includes("FOR NO KEY UPDATE")));
});

test("a held profile permits same-creator dependent writes and another creator's profile", { timeout: 3000 }, async () => {
  const f = fixture(), reached = deferred(), release = deferred();
  const pending = observeCreatorPlatformProfile(input(f, { beforeCommit: async () => { reached.resolve(); await release.promise; } }));
  try {
    await reached.promise;
    f.assertDependentWriteAllowed("a");
    const b = await observeCreatorPlatformProfile(input(f, { creatorId: "b", remoteId: "b", username: "b" }));
    assert.equal(b.creator.platformDisplayName, "Updated");
    assert.equal(f.creators.get("a").platformDisplayName, "a", "A is still uncommitted while B finishes");
  } finally { release.resolve(); await pending; }
});

test("two devices observing the same creator serialize and a delayed older observation cannot overwrite", { timeout: 3000 }, async () => {
  const f = fixture(), reached = deferred(), release = deferred();
  const newest = observeCreatorPlatformProfile(input(f, { observedAt: "2026-01-03T00:00:00Z", beforeCommit: async () => { reached.resolve(); await release.promise; } }));
  await reached.promise;
  let settled = false;
  const old = observeCreatorPlatformProfile(input(f, { sourceDeviceId: "device-b", platformDisplayName: "Old" })).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve(); await newest;
  assert.equal((await old).reason, "STALE_PROFILE_OBSERVATION");
  assert.equal(f.creators.get("a").platformDisplayName, "Updated");
  assert.equal(f.creators.get("a").avatarRevision, 1);
});

test("a rolled-back write retries the whole authority check and increments the avatar once", async () => {
  const f = fixture({ failure: ({ txId }) => { if (txId === 1) throw conflict(); } });
  const result = await observeCreatorPlatformProfile(input(f));
  assert.deepEqual(f.rollback, [1]);
  assert.equal(f.options.length, 2);
  assert.equal(result.creator.avatarRevision, 1);
  assert.equal(f.creators.get("a").avatarRevision, 1);
  assert.equal(f.queries.filter(q => q.sql.includes('FROM "User"')).length, 4);
});

test("authority revoked after rollback is re-read; no successful response or partial write", async () => {
  const f = fixture({ failure: () => { throw conflict(); }, afterRollback: ({ member }) => { member.deactivatedAt = new Date(); } });
  await assert.rejects(observeCreatorPlatformProfile(input(f)), { code: "CREATOR_CONNECTION_MEMBER_INACTIVE" });
  assert.equal(f.options.length, 2);
  assert.equal(f.creators.get("a").avatarRevision, 0);
  assert.equal(f.creators.get("a").platformDisplayName, "a");
});

test("retry exhaustion is a controlled conflict, never a successful profile update", async () => {
  const f = fixture({ failure: () => { throw conflict(); } });
  await assert.rejects(observeCreatorPlatformProfile(input(f)), { code: "CREATOR_CONNECTION_CONCURRENT_CHANGE", status: 409 });
  assert.equal(f.options.length, 3);
  assert.equal(f.creators.get("a").avatarRevision, 0);
});

test("profile lock timeout is a retryable busy response after rollback, not a generic server failure", async () => {
  const cause = Object.assign(new Error("private query"), { code: "P2010", meta: { code: "55P03" } });
  const f = fixture({ failure: () => { throw cause; } });
  await assert.rejects(observeCreatorPlatformProfile(input(f)), error => {
    assert.equal(error.code, "CREATOR_PROFILE_BUSY"); assert.equal(error.status, 503);
    assert.equal(error.retryable, true); assert.equal(error.retryAfterMs, 1000); assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /private query/); return true;
  });
  assert.equal(f.options.length, 1); assert.equal(f.creators.get("a").avatarRevision, 0);
});

test("a username unique violation is a business conflict and is never replayed", async () => {
  const f = fixture({ failure: () => { throw Object.assign(new Error("unique"), { code: "P2002" }); } });
  await assert.rejects(observeCreatorPlatformProfile(input(f)), { code: "CREATOR_ALREADY_EXISTS", status: 409 });
  assert.equal(f.options.length, 1);
  assert.equal(f.creators.get("a").avatarRevision, 0);
});

test("exact observation replay is idempotent; a reused timestamp/device with changed payload fails", async () => {
  const f = fixture();
  await observeCreatorPlatformProfile(input(f));
  assert.equal((await observeCreatorPlatformProfile(input(f))).reason, "DUPLICATE_PROFILE_OBSERVATION");
  await assert.rejects(observeCreatorPlatformProfile(input(f, { platformDisplayName: "Different" })), { code: "CREATOR_PROFILE_OBSERVATION_CONFLICT" });
  assert.equal(f.creators.get("a").avatarRevision, 1);
});

test("reconnect generation, identity and actor revocation remain fenced", async () => {
  const f = fixture();
  f.creators.get("a").connectionGeneration = 2;
  assert.equal((await observeCreatorPlatformProfile(input(f))).reason, "STALE_CONNECTION_GENERATION");
  await assert.rejects(observeCreatorPlatformProfile(input(f, { connectionGeneration: 3 })), { code: "CREATOR_PROFILE_GENERATION_MISMATCH" });
  await assert.rejects(observeCreatorPlatformProfile(input(f, { remoteId: "different" })), { code: "CREATOR_PROFILE_IDENTITY_MISMATCH" });
  f.user.disabledAt = new Date();
  await assert.rejects(observeCreatorPlatformProfile(input(f)), { code: "CREATOR_CONNECTION_MEMBER_INACTIVE" });
  assert.equal(f.writes.length, 0);
});
