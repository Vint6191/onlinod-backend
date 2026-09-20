"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function cacheModule(request, exports) {
  const id = require.resolve(request);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return id;
}
function restore(id) { delete require.cache[id]; }
function fresh(request) { const id = require.resolve(request); delete require.cache[id]; return require(request); }

function loadSubscriber({ projected = null } = {}) {
  const ids = [];
  ids.push(cacheModule("../prisma", {}));
  ids.push(cacheModule("./follow-back-service", {
    projectFollowBackProjectionChunk: async () => ({}), staleFollowBackProjectionFans: async () => ({}), ensureAutomaticFollowBack: async () => ({}),
  }));
  ids.push(cacheModule("./follow-automation-service", {
    projectFollowAutomationProjectionChunk: async () => ({}), staleFollowAutomationProjectionFans: async () => ({}), ensureAutomaticFollowAutomation: async () => ({}),
  }));
  ids.push(cacheModule("./bump-service", { ensureAutomaticBumps: async () => ({}) }));
  ids.push(cacheModule("./fan-data-authority-service", {
    projectSubscriberDirectoryItems: async (_db, { items }) => ({ projected: projected == null ? items.length : projected }),
    readFanCurrent: async () => [],
  }));
  ids.push(cacheModule("./job-planning-repository", { createPlannedJob: async () => ({}), publishPlannedJobAvailable() {} }));
  ids.push(cacheModule("./fan-observation-token-service", { consumeFanObservationToken: async () => ({ observedAt: new Date("2044-01-01T00:00:00.000Z") }) }));
  ids.push(cacheModule("./db-time-authority-service", { dbAuthorityNow: async () => new Date("2044-01-01T00:00:01.000Z") }));
  const service = fresh("./subscriber-directory-service");
  return { service, cleanup() { restore(require.resolve("./subscriber-directory-service")); for (const id of ids) restore(id); } };
}

function makeRun(overrides = {}) {
  return {
    id: "run-1", agencyId: "agency-1", creatorId: "creator-1", status: "RUNNING",
    nextOffset: 0, scannedCount: 0, pageCount: 0, hiddenCount: 0, hasMore: true,
    fanProjectionStatus: "PROJECTING", fanProjectionCursorOffset: 0, fanProjectionCount: 0,
    createdAt: new Date("2044-01-01T00:00:00.000Z"), startedAt: new Date("2044-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
function makeJob() {
  return {
    id: "job-1", jobKey: "subscriber_directory_scan", agencyId: "agency-1", creatorId: "creator-1",
    deviceId: "device-1", leaseRevision: 7, createdAt: new Date("2044-01-01T00:00:00.000Z"),
    params: { scanRunId: "run-1", observationTokenVersion: 1, scanEveryDays: 7 },
  };
}
function item(fanId = "fan-1", extra = {}) { return { fanId, username: fanId, creatorFollowsFan: false, ...extra }; }
function page({ offset = 0, items = [item()], hasMore = true, nextOffset = undefined, token = "token-1" } = {}) {
  const out = { kind: "subscriber_directory_page", scanRunId: "run-1", offset, hasMore, items, observationToken: token };
  if (nextOffset !== undefined) out.nextOffset = nextOffset;
  return out;
}
function hashJson(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function memoryDb(initialRun, { beforeUpdateMany = null } = {}) {
  let run = { ...initialRun };
  const pages = [];
  const items = [];
  const applyData = (data) => {
    const next = { ...run };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && Number.isFinite(value.increment)) next[key] = Number(next[key] || 0) + value.increment;
      else next[key] = value;
    }
    run = next;
  };
  const db = {
    pages, items,
    get run() { return run; },
    async $queryRawUnsafe(sql, runId) {
      if (/SubscriberScanRun/.test(sql) && /FOR UPDATE/.test(sql) && runId === run.id) return [{ ...run }];
      return [];
    },
    subscriberScanRun: {
      async findUnique({ where }) { return where.id === run.id ? { ...run } : null; },
      async update({ where, data }) { assert.equal(where.id, run.id); applyData(data); return { ...run }; },
      async updateMany({ where, data }) {
        if (beforeUpdateMany) await beforeUpdateMany({ where, data, run, setRun(next) { run = { ...run, ...next }; } });
        const allowed = Array.isArray(where.status?.in) ? where.status.in.includes(run.status) : true;
        if (where.id !== run.id || Number(where.nextOffset) !== Number(run.nextOffset) || !allowed) return { count: 0 };
        applyData(data);
        return { count: 1 };
      },
    },
    subscriberScanPage: {
      async findUnique({ where }) {
        return pages.find((row) => row.runId === where.runId_offset.runId && row.offset === where.runId_offset.offset) || null;
      },
      async create({ data }) {
        if (pages.some((row) => row.runId === data.runId && row.offset === data.offset)) throw Object.assign(new Error("unique page"), { code: "P2002" });
        const row = { id: `page-${pages.length + 1}`, ...data }; pages.push(row); return row;
      },
    },
    subscriberScanItem: {
      async findMany({ where }) {
        const wanted = new Set(where.fanId?.in || []);
        return items.filter((row) => row.runId === where.runId && wanted.has(row.fanId)).map((row) => ({ fanId: row.fanId, pageOffset: row.pageOffset }));
      },
      async createMany({ data }) { items.push(...data.map((row, index) => ({ id: `item-${items.length + index + 1}`, ...row }))); return { count: data.length }; },
    },
  };
  return db;
}

async function rejectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("final Subscriber source gate rejects gap, rewind, invalid offset, oversize and stalled cursor before publication", async () => {
  const loaded = loadSubscriber();
  try {
    await rejectCode(loaded.service.applySubscriberScanChunk({ db: memoryDb(makeRun()), job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 100 }) }), "SUBSCRIBER_SCAN_GAP");
    await rejectCode(loaded.service.applySubscriberScanChunk({ db: memoryDb(makeRun({ nextOffset: 100 })), job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 0 }) }), "SUBSCRIBER_SCAN_REWIND");
    await rejectCode(loaded.service.applySubscriberScanChunk({ db: memoryDb(makeRun()), job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: -1 }) }), "SUBSCRIBER_SCAN_OFFSET_INVALID");
    await rejectCode(loaded.service.applySubscriberScanChunk({ db: memoryDb(makeRun()), job: makeJob(), deviceId: "device-1", chunkResult: page({ items: Array.from({ length: 101 }, (_, i) => item(`fan-${i}`)), nextOffset: 101 }) }), "SUBSCRIBER_SCAN_PAGE_TOO_LARGE");
    await rejectCode(loaded.service.applySubscriberScanChunk({ db: memoryDb(makeRun()), job: makeJob(), deviceId: "device-1", chunkResult: page({ items: [], hasMore: true, nextOffset: 0 }) }), "SUBSCRIBER_SCAN_STALLED_CURSOR");
  } finally { loaded.cleanup(); }
});

test("final Subscriber continuation is server-derived and fails closed on ambiguous compacted provider pages", async () => {
  const loaded = loadSubscriber();
  try {
    await rejectCode(loaded.service.applySubscriberScanChunk({ db: memoryDb(makeRun()), job: makeJob(), deviceId: "device-1", chunkResult: page({ items: [item("a"), item("b")], nextOffset: 99 }) }), "SUBSCRIBER_SCAN_NEXT_OFFSET_MISMATCH");
    const db = memoryDb(makeRun());
    const result = await loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ items: [item("a"), item("b")], nextOffset: undefined }) });
    assert.equal(result.nextOffset, 2);
    assert.equal(db.run.nextOffset, 2);
    assert.equal(db.run.scannedCount, 2);

    // Frozen Desktop computes nextOffset from raw rows before compaction. If
    // those two representations ever diverge, Backend cannot prove the skipped
    // cursor distance from the compact payload, so the page must fail closed.
    await rejectCode(loaded.service.applySubscriberScanChunk({
      db: memoryDb(makeRun()), job: makeJob(), deviceId: "device-1",
      chunkResult: page({ items: [item("a"), item("b")], nextOffset: 3 }),
    }), "SUBSCRIBER_SCAN_NEXT_OFFSET_MISMATCH");
  } finally { loaded.cleanup(); }
});

test("final Subscriber replay is bound to the exact committed provider payload and continuation", async () => {
  const loaded = loadSubscriber();
  const originalItems = [item("fan-1", { name: "original" })];
  const db = memoryDb(makeRun({ nextOffset: 1, fanProjectionCursorOffset: 1, fanProjectionCount: 1 }));
  db.pages.push({ runId: "run-1", offset: 0, nextOffset: 1, hasMore: true, contentHash: hashJson(originalItems) });
  try {
    const replay = await loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 0, items: originalItems, nextOffset: 1 }) });
    assert.equal(replay.duplicate, true);
    await rejectCode(loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 0, items: [item("fan-1", { name: "changed" })], nextOffset: 1 }) }), "SUBSCRIBER_SCAN_REPLAY_CONFLICT");
    await rejectCode(loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 0, items: originalItems, nextOffset: 1, hasMore: false }) }), "SUBSCRIBER_SCAN_REPLAY_CONFLICT");
  } finally { loaded.cleanup(); }
});

test("final Subscriber rejects the same fan appearing on a later provider page", async () => {
  const loaded = loadSubscriber();
  const db = memoryDb(makeRun());
  try {
    await loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 0, items: [item("fan-1")], nextOffset: 1, hasMore: true }) });
    await rejectCode(loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 1, items: [item("fan-1")], nextOffset: 2, hasMore: false, token: "token-2" }) }), "SUBSCRIBER_SCAN_DUPLICATE_FAN_ACROSS_PAGES");
  } finally { loaded.cleanup(); }
});

test("final Subscriber progress CAS fails closed if durable cursor changes before commit", async () => {
  let flipped = false;
  const db = memoryDb(makeRun(), {
    beforeUpdateMany: async ({ setRun }) => { if (!flipped) { flipped = true; setRun({ nextOffset: 77 }); } },
  });
  const loaded = loadSubscriber();
  try {
    await rejectCode(loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ offset: 0, items: [item("fan-1")], nextOffset: 1 }) }), "SUBSCRIBER_SCAN_CURSOR_CONFLICT");
  } finally { loaded.cleanup(); }
});
