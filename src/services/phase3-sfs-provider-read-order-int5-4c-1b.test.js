"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeSfsSettings } = require("./sfs-rules");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}
function restore(id) { delete require.cache[id]; }
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }

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

function currentJob({ id, createdAt }) {
  return {
    id,
    agencyId: "agency-1",
    creatorId: "creator-1",
    deviceId: "device-1",
    leaseRevision: 7,
    createdAt: new Date(createdAt),
    params: { observationTokenVersion: 1 },
  };
}

function chunk({ token, username }) {
  return {
    kind: "sfs_target_profile",
    observationToken: token,
    observedAt: "2099-01-01T00:00:00.000Z",
    target: {
      id: "fan-1",
      username,
      name: username,
      subscribePriceCents: 0,
      creatorFollowing: false,
      isWantComments: true,
    },
    fanObservation: {
      identity: { username, source: "USER_PROFILE", observedAt: "2099-01-01T00:00:00.000Z" },
      relationship: { creatorFollowsFan: false, source: "USER_PROFILE", observedAt: "2099-01-01T00:00:00.000Z" },
    },
  };
}

test("INT5.4C-1B SFS discovery orders canonical facts by post-read server token, not job creation", async () => {
  const db = memoryDb();
  const loaded = loadSfs(db);
  const projectionInputs = [];
  const tokenTimes = new Map([
    ["token-j2", new Date("2026-09-17T00:00:01.000Z")],
    ["token-j1", new Date("2026-09-17T00:00:02.000Z")],
  ]);
  const consumeObservationToken = async (input) => {
    assert.equal(input.purpose, "sfs_target_discovery");
    assert.deepEqual(input.subjects, ["fan-1"]);
    assert.equal(input.deviceId, "device-1");
    assert.equal(input.leaseRevision, 7);
    const observedAt = tokenTimes.get(input.token);
    if (!observedAt) throw new Error("unexpected token");
    return { observedAt };
  };
  const projectFanObservations = async (_tx, input) => {
    projectionInputs.push(input);
    return { ok: true, projected: 1 };
  };

  try {
  // Newer-created J2 reads first.
  await loaded.service.applySfsDiscoveryChunk({
    db,
    job: currentJob({ id: "job-j2", createdAt: "2026-09-17T00:00:20.000Z" }),
    deviceId: "device-1",
    chunkResult: chunk({ token: "token-j2", username: "read-first" }),
    consumeObservationToken,
    projectFanObservations,
  });
  // Older-created J1 physically reads later and must win.
  await loaded.service.applySfsDiscoveryChunk({
    db,
    job: currentJob({ id: "job-j1", createdAt: "2026-09-17T00:00:10.000Z" }),
    deviceId: "device-1",
    chunkResult: chunk({ token: "token-j1", username: "read-later" }),
    consumeObservationToken,
    projectFanObservations,
  });

  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].username, "read-later");
  assert.equal(new Date(db.rows[0].discoveryObservedAt).toISOString(), "2026-09-17T00:00:02.000Z");
  assert.equal(db.rows[0].metadata.observationTimeBasis, "SERVER_PROVIDER_READ_TOKEN");
  assert.equal(projectionInputs.length, 2);
  assert.equal(new Date(projectionInputs[1].items[0].identity.observedAt).toISOString(), "2026-09-17T00:00:02.000Z");
  assert.equal(new Date(projectionInputs[1].items[0].relationship.observedAt).toISOString(), "2026-09-17T00:00:02.000Z");
  } finally {
    loaded.cleanup();
  }
});

test("INT5.4C-1B current SFS discovery fails closed when the observation token is missing", async () => {
  const db = memoryDb();
  const loaded = loadSfs(db);
  const payload = chunk({ token: "unused", username: "alice" });
  delete payload.observationToken;
  try {
  await assert.rejects(() => loaded.service.applySfsDiscoveryChunk({
    db,
    job: currentJob({ id: "job-current", createdAt: "2026-09-17T00:00:00.000Z" }),
    deviceId: "device-1",
    chunkResult: payload,
    consumeObservationToken: async () => { throw new Error("must not be reached"); },
    projectFanObservations: async () => ({ ok: true }),
  }), /SFS_DISCOVERY_OBSERVATION_TOKEN_REQUIRED/);
  } finally {
    loaded.cleanup();
  }
});

test("INT5.4C-1B new SFS discovery jobs opt into token chronology while legacy in-flight jobs retain rollout fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "sfs-service.js"), "utf8");
  assert.match(source, /wallScanPosts: settings\.wallScanPosts, observationTokenVersion: 1/);
  assert.match(source, /observationTokenVersion >= 1/);
  assert.match(source, /purpose: SFS_DISCOVERY_JOB_KEY/);
  assert.match(source, /subjects: \[target\.targetUserId\]/);
  assert.match(source, /SERVER_PROVIDER_READ_TOKEN/);
  assert.match(source, /jobs created before the token cutover/);
});
