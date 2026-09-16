"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeSfsSettings, normalizeSfsTarget, targetEligibility } = require("./sfs-rules");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}
function restore(id) { delete require.cache[id]; }
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }

function memoryDb() {
  const rows = [];
  return {
    rows,
    $executeRawUnsafe: async () => 1,
    sfsTargetCandidate: {
      async findFirst({ where }) {
        const row = rows.find((item) => Object.entries(where || {}).every(([key, value]) => item[key] === value));
        return row ? { ...row } : null;
      },
      async create({ data }) {
        const row = { id: `candidate-${rows.length + 1}`, usedForever: false, generation: 0, metadata: {}, ...data };
        rows.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const index = rows.findIndex((item) => item.id === where.id);
        if (index < 0) throw new Error("candidate missing");
        rows[index] = { ...rows[index], ...data };
        return { ...rows[index] };
      },
    },
  };
}

function loadSfs(db) {
  const ids = [];
  ids.push(cacheModule("../prisma", db));
  ids.push(cacheModule("./automation-control-service", {
    requireCreator: async () => ({ id: "creator-1" }),
    assertAutomationEnabled: async () => ({ modules: { sfs: { settings: {} } }, workspace: { settings: {} }, effective: { sfsEnabled: true } }),
    getAutomationControlSnapshot: async () => ({ modules: { sfs: { settings: {} } }, workspace: { settings: {} }, effective: { sfsEnabled: true } }),
    normalizeSfsSettings,
  }));
  ids.push(cacheModule("./job-planning-repository", {
    ensurePlannedJob: async () => ({ job: null, created: false }),
    createPlannedJobIfAbsent: async () => ({ job: null, created: false }),
  }));
  ids.push(cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() }));
  const service = fresh("./sfs-service");
  return { service, cleanup() { restore(require.resolve("./sfs-service")); for (const id of ids) restore(id); } };
}

function chunk({ id, username, observedAt = "2099-01-01T00:00:00.000Z", price = undefined, followed = undefined } = {}) {
  const target = { id, username, name: username };
  if (price !== undefined) target.subscribePriceCents = price;
  if (followed !== undefined) target.creatorFollowing = followed;
  return {
    kind: "sfs_target_profile",
    observedAt,
    target,
    fanObservation: {
      onlyFansUserId: "nested-spoof-id",
      identity: { username, source: "USER_PROFILE", observedAt },
      relationship: {
        ...(price !== undefined ? { subscribePriceCents: price } : {}),
        ...(followed !== undefined ? { creatorFollowsFan: followed } : {}),
        source: "USER_PROFILE",
        observedAt,
      },
    },
  };
}

test("INT4.3A SFS normalization preserves UNKNOWN price/follow instead of FREE/not-following", () => {
  const normalized = normalizeSfsTarget({ id: "fan-1", username: "Alice" });
  assert.equal(normalized.subscribePriceCents, null);
  assert.equal(normalized.creatorFollowing, null);

  const settings = normalizeSfsSettings({ freeTargetsOnly: true, commentsEnabled: true });
  const now = new Date("2026-09-16T18:00:00.000Z");
  const fresh = { discoveryObservedAt: now, state: "CANDIDATE", isWantComments: true };
  assert.equal(targetEligibility({ ...fresh, subscribePriceCents: null, creatorFollowing: false }, settings, now), "price_unknown");
  assert.equal(targetEligibility({ ...fresh, subscribePriceCents: 0, creatorFollowing: null }, settings, now), "following_unknown");
  assert.equal(targetEligibility({ ...fresh, subscribePriceCents: 0, creatorFollowing: false, isWantComments: null }, settings, now), "comments_unknown");
  assert.equal(targetEligibility({ ...fresh, subscribePriceCents: 0, creatorFollowing: false }, settings, now), "eligible");

  const stale = new Date(now.getTime() - 13 * 60 * 60_000);
  assert.equal(targetEligibility({ ...fresh, discoveryObservedAt: stale, subscribePriceCents: 0, creatorFollowing: false }, settings, now), "target_profile_stale");
});

test("INT4.3A SFS identity follows opaque targetUserId across username rename and isolates recycled usernames", async () => {
  const db = memoryDb();
  const loaded = loadSfs(db);
  const projections = [];
  const projectFanObservations = async (_tx, input) => { projections.push(input); return { ok: true, projected: 1 }; };
  try {
    const first = await loaded.service.applySfsDiscoveryChunk({
      db,
      job: { id: "job-1", agencyId: "agency-1", creatorId: "creator-1", createdAt: new Date("2026-09-16T10:00:00.000Z") },
      deviceId: "device-1",
      chunkResult: chunk({ id: "123", username: "alice", price: 0, followed: false }),
      projectFanObservations,
    });
    const renamed = await loaded.service.applySfsDiscoveryChunk({
      db,
      job: { id: "job-2", agencyId: "agency-1", creatorId: "creator-1", createdAt: new Date("2026-09-16T10:05:00.000Z") },
      deviceId: "device-1",
      chunkResult: chunk({ id: "123", username: "alice2", price: 0, followed: false }),
      projectFanObservations,
    });
    assert.equal(renamed.candidateId, first.candidateId);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].targetUserId, "123");
    assert.equal(db.rows[0].username, "alice2");

    const recycled = await loaded.service.applySfsDiscoveryChunk({
      db,
      job: { id: "job-3", agencyId: "agency-1", creatorId: "creator-1", createdAt: new Date("2026-09-16T10:10:00.000Z") },
      deviceId: "device-2",
      chunkResult: chunk({ id: "999", username: "alice2", price: 0, followed: false }),
      projectFanObservations,
    });
    assert.notEqual(recycled.candidateId, first.candidateId);
    assert.equal(db.rows.length, 2);
    assert.deepEqual(db.rows.map((row) => row.targetUserId).sort(), ["123", "999"]);

    assert.equal(projections.length, 3);
    assert.equal(projections[0].items[0].onlyFansUserId, "123", "nested fan id must not override the resolved opaque target id");
    assert.deepEqual(projections[0].allowedSources, ["USER_PROFILE"]);
    assert.equal(projections[0].observedAtPolicy, "TRUSTED_INPUT");
    assert.equal(projections[0].sourceJobId, "job-1");
    assert.equal(projections[0].sourceDeviceId, "device-1");
    assert.equal(new Date(projections[0].items[0].relationship.observedAt).toISOString(), "2026-09-16T10:00:00.000Z");
  } finally {
    loaded.cleanup();
  }
});

test("INT4.3A migration merges username-era duplicates before enforcing opaque target uniqueness", () => {
  const schema = fs.readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.resolve(__dirname, "../../prisma/migrations/20260916190000_phase3_sfs_opaque_target_identity/migration.sql"), "utf8");
  assert.match(schema, /model SfsTargetCandidate[\s\S]*subscribePriceCents\s+Int\?/);
  assert.doesNotMatch(schema, /@@unique\(\[creatorId, username\]\)/);
  assert.match(schema, /@@index\(\[creatorId, username\]\)/);
  assert.match(migration, /SfsTargetCandidate_creatorId_targetUserId_key/);
  assert.match(migration, /AutomationDelivery[\s\S]*candidateId/);
  assert.match(migration, /JobInstance[\s\S]*candidateId/);
  assert.match(migration, /UNFOLLOW_DUE[\s\S]*RECOVERY_REQUIRED/);
  assert.match(migration, /DROP NOT NULL/);
  assert.match(migration, /legacyRelationshipProjectionInvalidatedAt/);
  assert.match(migration, /"subscribePriceCents" = NULL[\s\S]*"creatorFollowing" = NULL/);
});

test("INT4.3A discovery lock and lookup are target-id based, never username authority", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "sfs-service.js"), "utf8");
  const start = source.indexOf("async function applySfsDiscoveryChunk");
  const end = source.indexOf("async function applySfsDiscoveryCompletion", start);
  const block = source.slice(start, end);
  assert.match(block, /p14:sfs-target:[^`]*\$\{target\.targetUserId\}/);
  assert.match(block, /findFirst\([\s\S]*targetUserId: target\.targetUserId/);
  assert.doesNotMatch(block, /creatorId_username/);
});
