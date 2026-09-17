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
function restore(id) { delete require.cache[id]; }
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }

function loadSubscriber() {
  const ids = [];
  ids.push(cacheModule("../prisma", {}));
  ids.push(cacheModule("./follow-back-service", { refreshFollowBackProjection: async () => ({}) }));
  ids.push(cacheModule("./follow-automation-service", { refreshFollowAutomationProjection: async () => ({}) }));
  ids.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({}) }));
  ids.push(cacheModule("./fan-data-authority-service", {
    projectSubscriberDirectoryRun: async () => ({ projected: 0 }),
    readFanCurrent: async () => null,
  }));
  ids.push(cacheModule("./job-planning-repository", {
    createPlannedJob: async () => ({}), publishPlannedJobAvailable() {},
  }));
  const service = fresh("./subscriber-directory-service");
  return { service, cleanup() { restore(require.resolve("./subscriber-directory-service")); for (const id of ids) restore(id); } };
}

function memoryDb(runs) {
  const pages = [];
  const items = [];
  return {
    pages, items,
    subscriberScanRun: {
      async findUnique({ where }) { return runs.get(where.id) || null; },
      async update({ where, data }) {
        const current = runs.get(where.id);
        const next = { ...current, ...data };
        if (data.scannedCount?.increment) next.scannedCount = (current.scannedCount || 0) + data.scannedCount.increment;
        if (data.pageCount?.increment) next.pageCount = (current.pageCount || 0) + data.pageCount.increment;
        if (data.hiddenCount?.increment) next.hiddenCount = (current.hiddenCount || 0) + data.hiddenCount.increment;
        runs.set(where.id, next);
        return next;
      },
    },
    subscriberScanPage: {
      async findUnique({ where }) { return pages.find((row) => row.runId === where.runId_offset.runId && row.offset === where.runId_offset.offset) || null; },
      async create({ data }) { const row = { id: `page-${pages.length + 1}`, ...data }; pages.push(row); return row; },
    },
    subscriberScanItem: {
      async createMany({ data }) { items.push(...data.map((row) => ({ ...row }))); return { count: data.length }; },
    },
  };
}

function run(id, createdAt) {
  return {
    id, agencyId: "agency-1", creatorId: "creator-1", status: "QUEUED",
    createdAt: new Date(createdAt), startedAt: null, scannedCount: 0, pageCount: 0, hiddenCount: 0,
  };
}
function job(id, runId, createdAt, tokenVersion = 1) {
  return {
    id, jobKey: "subscriber_directory_scan", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-1", leaseRevision: 9, createdAt: new Date(createdAt),
    params: { scanRunId: runId, observationTokenVersion: tokenVersion },
  };
}
function chunk(runId, fanId, token, offset = 0) {
  return {
    kind: "subscriber_directory_page", scanRunId: runId, offset, nextOffset: offset + 1,
    hasMore: true, observedAt: "2099-01-01T00:00:00.000Z", observationToken: token,
    items: [{ fanId, username: fanId, creatorFollowsFan: false }],
  };
}

test("INT5.4C-1C Subscriber Directory stores post-read token chronology instead of run creation time", async () => {
  const runs = new Map([
    ["run-j2", run("run-j2", "2026-09-17T00:00:20.000Z")],
    ["run-j1", run("run-j1", "2026-09-17T00:00:10.000Z")],
  ]);
  const db = memoryDb(runs);
  const loaded = loadSubscriber();
  const tokenTimes = new Map([
    ["token-j2", new Date("2026-09-17T00:00:01.000Z")],
    ["token-j1", new Date("2026-09-17T00:00:02.000Z")],
  ]);
  const consumeObservationToken = async (input) => {
    assert.equal(input.purpose, "subscriber_directory_page");
    assert.equal(input.deviceId, "device-1");
    assert.equal(input.leaseRevision, 9);
    const observedAt = tokenTimes.get(input.token);
    if (!observedAt) throw new Error("unexpected token");
    return { observedAt };
  };
  try {
    await loaded.service.applySubscriberScanChunk({
      db, job: job("job-j2", "run-j2", "2026-09-17T00:00:20.000Z"), deviceId: "device-1",
      chunkResult: chunk("run-j2", "fan-j2", "token-j2"), consumeObservationToken,
    });
    await loaded.service.applySubscriberScanChunk({
      db, job: job("job-j1", "run-j1", "2026-09-17T00:00:10.000Z"), deviceId: "device-1",
      chunkResult: chunk("run-j1", "fan-j1", "token-j1"), consumeObservationToken,
    });
    assert.equal(db.items.length, 2);
    assert.equal(new Date(db.items[0].observedAt).toISOString(), "2026-09-17T00:00:01.000Z");
    assert.equal(new Date(db.items[1].observedAt).toISOString(), "2026-09-17T00:00:02.000Z");
    assert.equal(db.items[1].metadata.fanDataObservationTimeBasis, "SERVER_PROVIDER_READ_TOKEN");
    assert.equal(db.items[1].metadata.producerObservedAt, "2099-01-01T00:00:00.000Z");
  } finally { loaded.cleanup(); }
});

test("INT5.4C-1C current Subscriber Directory page fails closed without a token", async () => {
  const runs = new Map([["run-current", run("run-current", "2026-09-17T00:00:00.000Z")]]);
  const db = memoryDb(runs);
  const loaded = loadSubscriber();
  const payload = chunk("run-current", "fan-1", "unused");
  delete payload.observationToken;
  try {
    await assert.rejects(() => loaded.service.applySubscriberScanChunk({
      db, job: job("job-current", "run-current", "2026-09-17T00:00:00.000Z"), deviceId: "device-1",
      chunkResult: payload,
      consumeObservationToken: async () => { throw new Error("must not be reached"); },
    }), /SUBSCRIBER_SCAN_OBSERVATION_TOKEN_REQUIRED/);
  } finally { loaded.cleanup(); }
});


test("INT5.4C-1C committed page replay returns idempotently without consuming the one-time token again", async () => {
  const runs = new Map([["run-replay", run("run-replay", "2026-09-17T00:00:00.000Z")]]);
  const db = memoryDb(runs);
  db.pages.push({ runId: "run-replay", offset: 0, nextOffset: 1, hasMore: true });
  const loaded = loadSubscriber();
  try {
    const result = await loaded.service.applySubscriberScanChunk({
      db, job: job("job-replay", "run-replay", "2026-09-17T00:00:00.000Z"), deviceId: "device-1",
      chunkResult: chunk("run-replay", "fan-1", "already-consumed"),
      consumeObservationToken: async () => { throw new Error("token must not be consumed on committed replay"); },
    });
    assert.equal(result.duplicate, true);
    assert.equal(result.nextOffset, 1);
    assert.equal(db.items.length, 0);
  } finally { loaded.cleanup(); }
});
test("INT5.4C-1C subscriber scheduling opts into token chronology and publication preserves per-item observedAt", () => {
  const subscriber = fs.readFileSync(path.join(__dirname, "subscriber-directory-service.js"), "utf8");
  const authority = fs.readFileSync(path.join(__dirname, "fan-data-authority-service.js"), "utf8");
  assert.match(subscriber, /observationTokenVersion:\s*1/);
  assert.match(subscriber, /purpose:\s*"subscriber_directory_page"/);
  assert.match(subscriber, /SERVER_PROVIDER_READ_TOKEN/);
  assert.match(subscriber, /jobs created before the token cutover|created before the token cutover|before the token cutover/);
  assert.match(authority, /observedAt:\s*item\.observedAt/);
});
test("INT5.4C-1C Subscriber Directory also has a physical one-active-run creator fence", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260714190000_subscriber_directory_hidden_online_v1", "migration.sql"), "utf8");
  const subscriber = fs.readFileSync(path.join(__dirname, "subscriber-directory-service.js"), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX "SubscriberScanRun_one_active_creator_key"/);
  assert.match(migration, /WHERE "status" IN \('QUEUED', 'RUNNING'\)/);
  assert.match(subscriber, /error\?\.code !== "P2002"/);
  assert.match(subscriber, /reason:\s*"concurrent_scan_won"/);
});

