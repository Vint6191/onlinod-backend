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
  ids.push(cacheModule("./subscriber-directory-maintenance-signal-service", {
    SUBSCRIBER_MAINTENANCE_KIND: { RECOVERY: "RECOVERY" }, signalSubscriberDirectoryMaintenance: async () => ({}),
  }));
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
        return items.filter((row) => row.runId === where.runId && wanted.has(row.fanId)).map((row) => ({ ...row }));
      },
      async createMany({ data }) { items.push(...data.map((row, index) => ({ id: `item-${items.length + index + 1}`, ...row }))); return { count: data.length }; },
      async update({ where, data }) {
        const row = items.find(x => x.runId === where.runId_fanId.runId && x.fanId === where.runId_fanId.fanId);
        assert.ok(row); Object.assign(row, data); return { ...row };
      },
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

test("overlapping pages advance by raw rows while counting each fan once and updating its latest observation", async () => {
  const loaded = loadSubscriber(), db = memoryDb(makeRun());
  const apply = (offset, items, hasMore = true) => loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1",
    chunkResult: page({ offset, items, nextOffset: offset + items.length, hasMore, token: `token-${offset}` }) });
  try {
    await apply(0, [item("fan-1", { lastSeenIsNull: true }), item("fan-2")]);
    await apply(2, [item("fan-1", { name: "new", lastSeenIsNull: false }), item("fan-3", { lastSeenIsNull: true })]);
    const final = await apply(4, [item("fan-3", { lastSeenIsNull: true })], false);
    assert.equal(final.readyToPublish, true);
    assert.equal(db.run.nextOffset, 5); assert.equal(db.run.scannedCount, 3); assert.equal(db.run.hiddenCount, 1);
    assert.equal(db.items.length, 3); assert.equal(db.items.find(x => x.fanId === "fan-1").name, "new");
    assert.equal(db.run.fanProjectionCount, 5); assert.equal(db.run.fanProjectionStatus, "COMPLETE");
    assert.equal(db.run.summary.traversal.duplicateRows, 2);
  } finally { loaded.cleanup(); }
});

test("identical rows within one page retain provider cursor distance and project one fan", async () => {
  const loaded = loadSubscriber(), db = memoryDb(makeRun()), one = item("fan-1", { lastSeenIsNull: true });
  try {
    await loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult: page({ items: [one, one], nextOffset: 2 }) });
    assert.equal(db.run.nextOffset, 2); assert.equal(db.run.scannedCount, 1); assert.equal(db.run.hiddenCount, 1);
    assert.equal(db.pages[0].itemCount, 2); assert.equal(db.items.length, 1); assert.equal(db.run.fanProjectionCount, 1);
  } finally { loaded.cleanup(); }
});

test("conflicting same-page observations fail before consuming a token or changing a checkpoint", async () => {
  const loaded = loadSubscriber(), db = memoryDb(makeRun());
  try {
    await rejectCode(loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1",
      chunkResult: page({ items: [item("fan-1", { name: "one" }), item("fan-1", { name: "two" })], nextOffset: 2 }),
      consumeObservationToken: () => assert.fail("ambiguous page must not consume token"),
    }), "SUBSCRIBER_SCAN_CONFLICTING_FAN_IN_PAGE");
    assert.equal(db.pages.length, 0); assert.equal(db.run.nextOffset, 0);
  } finally { loaded.cleanup(); }
});

test("a provider ignoring offsets is bounded and can never publish an incomplete run as successful", async () => {
  const loaded = loadSubscriber(), db = memoryDb(makeRun());
  const apply = offset => loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1",
    chunkResult: page({ offset, items: [item("fan-1")], nextOffset: offset + 1, hasMore: true }) });
  try {
    for (let offset = 0; offset < 6; offset++) await apply(offset);
    await rejectCode(apply(6), "SUBSCRIBER_SCAN_NON_ADVANCING_SOURCE");
    assert.equal(db.run.scannedCount, 1); assert.equal(db.run.nextOffset, 6);
    assert.equal(db.run.hasMore, true); assert.equal(db.run.fanProjectionStatus, "PROJECTING");
    assert.equal(db.pages.length, 6);
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

test("V2 subscriber windows resume a legacy cursor, cross filtered empties and publish only at an explicit terminal", async () => {
  const loaded = loadSubscriber();
  const db = memoryDb(makeRun({ nextOffset: 4858, scannedCount: 3602, pageCount: 341, fanProjectionCursorOffset: 4858, fanProjectionCount: 4858 }));
  const apply = chunkResult => loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult });
  const window = (offset, items, hasMore) => ({ ...page({ offset, items, hasMore }), pagination: { contract: "of_subscribers_offset_v2", limit: 20 } });
  try {
    const first = window(4858, [item("a"), item("b")], true);
    assert.equal((await apply(first)).nextOffset, 4878);
    assert.equal((await apply(window(4878, [], true))).nextOffset, 4898);
    assert.equal(db.run.hasMore, true); assert.equal(db.run.scannedCount, 3604);
    assert.equal((await apply(first)).duplicate, true);
    assert.equal(db.run.nextOffset, 4898); assert.equal(db.run.pageCount, 343);
    assert.equal((await apply(window(4898, [item("b"), item("c")], false))).readyToPublish, true);
    assert.equal(db.run.nextOffset, 4900); assert.equal(db.run.scannedCount, 3605);
    assert.equal(db.run.fanProjectionStatus, "COMPLETE"); assert.equal(db.run.fanProjectionCount, 4862);
    assert.equal(db.run.summary.traversal.filteredPositions, 38);
    assert.equal(db.run.summary.traversal.providerRows, 4862);
    assert.equal(db.run.pageLimit, 20);
  } finally { loaded.cleanup(); }
});

test("V2 subscriber contract rejects unknown semantics, contradictory cursor and an endless empty source", async () => {
  const loaded = loadSubscriber();
  try {
    const apply = (db, chunkResult) => loaded.service.applySubscriberScanChunk({ db, job: makeJob(), chunkResult });
    await rejectCode(apply(memoryDb(makeRun()), { ...page(), hasMore: undefined }), "SUBSCRIBER_SCAN_HAS_MORE_INVALID");
    await rejectCode(apply(memoryDb(makeRun()), { ...page(), pagination: { contract: "future", limit: 20 } }), "SUBSCRIBER_SCAN_PAGINATION_INVALID");
    await rejectCode(apply(memoryDb(makeRun()), { ...page({ nextOffset: 1 }), pagination: { contract: "of_subscribers_offset_v2", limit: 20 } }), "SUBSCRIBER_SCAN_NEXT_OFFSET_MISMATCH");
    const db = memoryDb(makeRun({ summary: { traversal: { consecutiveEmptyPages: 50 } } }));
    await rejectCode(apply(db, { ...page({ items: [] }), pagination: { contract: "of_subscribers_offset_v2", limit: 20 } }), "SUBSCRIBER_SCAN_EMPTY_WINDOW_LIMIT");
    assert.equal(db.run.hasMore, true); assert.equal(db.pages.length, 0);
  } finally { loaded.cleanup(); }
});


test("V2 filtered windows bind observation tokens to distinct fans while replay and empty windows consume no chronology", async () => {
  const loaded = loadSubscriber();
  const db = memoryDb(makeRun());
  const tokens = [];
  const consumeObservationToken = async input => {
    assert.equal(input.job.id, "job-1");
    assert.equal(input.deviceId, "device-1");
    assert.equal(input.leaseRevision, 7);
    assert.equal(input.purpose, "subscriber_directory_page");
    assert.equal(tokens.some(token => token.token === input.token), false, "a lost-ACK replay must precede one-time token consumption");
    tokens.push(input);
    return { observedAt: new Date("2044-01-01T00:00:00.000Z") };
  };
  const apply = chunkResult => loaded.service.applySubscriberScanChunk({ db, job: makeJob(), deviceId: "device-1", chunkResult, consumeObservationToken });
  try {
    const first = { ...page({ items: [item("fan-1"), item("fan-1")] }), pagination: { contract: "of_subscribers_offset_v2", limit: 20 } };
    assert.equal((await apply(first)).nextOffset, 20);
    assert.deepEqual(tokens[0].subjects, ["fan-1"]);
    assert.equal(db.run.scannedCount, 1);
    assert.equal(db.run.fanProjectionCount, 1);
    assert.equal((await apply(first)).duplicate, true);
    const empty = { ...page({ offset: 20, items: [] }), pagination: { contract: "of_subscribers_offset_v2", limit: 20 } };
    delete empty.observationToken;
    assert.equal((await apply(empty)).nextOffset, 40);
    assert.equal(db.run.hasMore, true);
    assert.equal(db.run.fanProjectionCursorOffset, 40);
    assert.equal(tokens.length, 1);
    assert.equal(db.run.summary.traversal.filteredPositions, 38);
    assert.equal((await apply({ ...empty, offset: 40, hasMore: false })).readyToPublish, true);
    assert.equal(db.run.fanProjectionStatus, "COMPLETE");
    assert.equal(tokens.length, 1);
  } finally { loaded.cleanup(); }
});
