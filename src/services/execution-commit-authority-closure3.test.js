"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}

function fresh(request) {
  const id = require.resolve(request);
  delete require.cache[id];
  return require(request);
}

function restore(id) {
  delete require.cache[id];
}

const EXPECTED_JOB_CATALOG = [
  "fetch_earnings",
  "fetch_campaigns",
  "traffic_sources_scan",
  "fan_data_point_refresh",
  "catchup_notifications_scan",
  "financial_transactions_scan",
  "dialog_intelligence_scan",
  "vault_unsorted_scan",
  "subscriber_directory_scan",
  "likes_content_discovery",
  "sfs_target_discovery",
  "sfs_target_scan",
];

test("Closure3 backend JOB_CATALOG is exactly the 12 executable Desktop job generation", () => {
  const { JOB_CATALOG } = require("./job-catalog");
  assert.deepEqual(Object.keys(JOB_CATALOG), EXPECTED_JOB_CATALOG);
  assert.equal(Object.hasOwn(JOB_CATALOG, "refresh_online_presence"), false);
});

test("Closure3 retires legacy Presence execution/control surface but retains Presence schema facts", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const results = fs.readFileSync(path.resolve(__dirname, "job-result-service.js"), "utf8");
  const schema = fs.readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.resolve(__dirname, "../../prisma/migrations/20260831160000_execution_commit_authority_closure3/migration.sql"), "utf8");

  assert.doesNotMatch(server, /routes\/presence|presenceRoutes|startPresenceScheduler|services\/presence-scheduler|\/api\/presence/);
  assert.doesNotMatch(results, /refresh_online_presence|applyPresenceJobResult|presence-service/);
  for (const rel of ["../routes/presence.js", "presence-scheduler.js", "presence-service.js"]) {
    assert.equal(fs.existsSync(path.resolve(__dirname, rel)), false, `${rel} must be removed`);
  }
  assert.match(schema, /model CreatorPresenceSnapshot\s*\{/);
  assert.match(schema, /model CreatorPresenceUser\s*\{/);
  assert.match(migration, /LEGACY_PRESENCE_ORCHESTRATION_RETIRED/);
  assert.match(migration, /"jobKey" = 'refresh_online_presence'/);
});

test("Closure3 JobPlanningRepository is fail-closed for any producer key outside JOB_CATALOG", async () => {
  const prismaId = cacheModule("../prisma", {});
  const controlId = cacheModule("./desktop-control-events", { publishDesktopControlEvent: () => null });
  try {
    const planning = fresh("./job-planning-repository");
    let touched = false;
    const db = { jobInstance: { create: async () => { touched = true; throw new Error("must not touch DB"); } } };
    await assert.rejects(
      () => planning.createPlannedJob({ db, jobKey: "refresh_online_presence", creatorId: "c1", agencyId: "a1" }),
      (error) => error?.code === "JOB_PLANNING_UNKNOWN_JOB_KEY" && error?.message === "JOB_PLANNING_UNKNOWN_JOB_KEY",
    );
    await assert.rejects(
      () => planning.ensurePlannedJob({ db: { jobInstance: { findUnique: async () => { touched = true; return null; } } }, jobKey: "refresh_online_presence", creatorId: "c1", agencyId: "a1", idempotencyKey: "legacy-presence" }),
      (error) => error?.code === "JOB_PLANNING_UNKNOWN_JOB_KEY",
    );
    assert.equal(touched, false);
    const data = planning.scheduledCreateData({ jobKey: "sfs_target_discovery", creatorId: "c1", agencyId: "a1" });
    assert.equal(data.jobKey, "sfs_target_discovery");
  } finally {
    restore(require.resolve("./job-planning-repository"));
    restore(prismaId);
    restore(controlId);
  }
});

function candidateDb() {
  let row = null;
  return {
    get row() { return row; },
    $queryRawUnsafe: async () => { throw new Error("void deserialization"); },
    $executeRawUnsafe: async () => 1,
    sfsTargetCandidate: {
      async findUnique({ where }) {
        const key = where.creatorId_username;
        if (!row || row.creatorId !== key.creatorId || row.username !== key.username) return null;
        return { ...row };
      },
      async upsert({ create, update }) {
        if (!row) row = { id: "candidate-1", usedForever: false, generation: 0, ...create };
        else row = { ...row, ...update };
        return { ...row };
      },
    },
  };
}

function loadSfsForDiscovery(db, ensurePlannedJob = async () => ({ job: { id: "planned" } })) {
  const ids = [];
  ids.push(cacheModule("../prisma", db));
  ids.push(cacheModule("./automation-control-service", {
    requireCreator: async () => ({ id: "creator-1" }),
    assertAutomationEnabled: async () => ({ modules: { sfs: { settings: { huntingEnabled: true, discoveryFreshnessHours: 12 } } } }),
    getAutomationControlSnapshot: async () => ({ modules: { sfs: { settings: { automatic: false } } } }),
    normalizeSfsSettings: (value) => ({ huntingEnabled: true, automatic: false, discoveryFreshnessHours: 12, wallScanPosts: 40, dailyLimit: 20, maxAttempts: 3, ...value }),
  }));
  ids.push(cacheModule("./job-planning-repository", { ensurePlannedJob, createPlannedJobIfAbsent: async () => ({ job: null, created: false }) }));
  ids.push(cacheModule("./automation-pacing-service", { nextAutomationWriteSlot: async () => new Date() }));
  const service = fresh("./sfs-service");
  return { service, cleanup() { restore(require.resolve("./sfs-service")); for (const id of ids) restore(id); } };
}

function sfsChunk(observedAt, suffix) {
  return {
    kind: "sfs_target_profile",
    observedAt,
    target: {
      id: "target-1",
      username: "target_one",
      name: `Name ${suffix}`,
      avatar: `https://cdn.example/${suffix}.jpg`,
      subscribePrice: suffix === "T2" ? 2 : 1,
      isWantComments: suffix === "T2",
      subscribedBy: suffix === "T2",
    },
    sourcePostIds: [`post-${suffix}`],
    profileHash: `hash-${suffix}`,
  };
}

test("Closure3 SFS discovery observation authority keeps T2 current when delayed T1 arrives last", async () => {
  const db = candidateDb();
  const loaded = loadSfsForDiscovery(db);
  try {
    const { applySfsDiscoveryChunk } = loaded.service;
    const t1 = "2026-08-31T10:00:00.000Z";
    const t2 = "2026-08-31T10:05:00.000Z";
    const newer = await applySfsDiscoveryChunk({ db, job: { id: "job-B", agencyId: "a1", creatorId: "c1" }, chunkResult: sfsChunk(t2, "T2") });
    assert.equal(newer.applied, 1);
    const stale = await applySfsDiscoveryChunk({ db, job: { id: "job-A", agencyId: "a1", creatorId: "c1" }, chunkResult: sfsChunk(t1, "T1") });
    assert.equal(stale.sideEffect, "STALE_NOOP");
    assert.equal(db.row.displayName, "Name T2");
    assert.equal(db.row.avatarUrl, "https://cdn.example/T2.jpg");
    assert.equal(db.row.subscribePriceCents, 200);
    assert.equal(db.row.creatorFollowing, true);
    assert.deepEqual(db.row.sourcePostIds, ["post-T2"]);
    assert.equal(db.row.discoverySourceJobId, "job-B");
    assert.equal(new Date(db.row.discoveryObservedAt).toISOString(), t2);
  } finally {
    loaded.cleanup();
  }
});

test("Closure3 forced SFS discovery may overlap a RUNNING older job without sacrificing freshness authority", async () => {
  const jobs = new Map();
  let seq = 0;
  const ensurePlannedJob = async (input) => {
    let job = jobs.get(input.idempotencyKey);
    if (!job) {
      job = { id: `job-${++seq}`, status: "SCHEDULED", idempotencyKey: input.idempotencyKey, params: input.params };
      jobs.set(input.idempotencyKey, job);
    }
    return { job };
  };
  const db = candidateDb();
  const loaded = loadSfsForDiscovery(db, ensurePlannedJob);
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    const first = await loaded.service.scheduleSfsDiscovery({ db, agencyId: "a1", creatorId: "c1", force: true });
    first.job.status = "RUNNING";
    Date.now = () => 2_000;
    const second = await loaded.service.scheduleSfsDiscovery({ db, agencyId: "a1", creatorId: "c1", force: true });
    assert.notEqual(first.job.id, second.job.id);
    assert.notEqual(first.job.idempotencyKey, second.job.idempotencyKey);
    assert.equal(first.job.status, "RUNNING");
    assert.equal(second.job.status, "SCHEDULED");
  } finally {
    Date.now = originalNow;
    loaded.cleanup();
  }
});
