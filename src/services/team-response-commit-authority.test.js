"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const service = require("./team-response-projection-service");

function date(value) { return new Date(value); }
function matchesDate(value, cond = {}) {
  const t = new Date(value).getTime();
  if (cond.lt && !(t < new Date(cond.lt).getTime())) return false;
  if (cond.lte && !(t <= new Date(cond.lte).getTime())) return false;
  if (cond.gt && !(t > new Date(cond.gt).getTime())) return false;
  if (cond.gte && !(t >= new Date(cond.gte).getTime())) return false;
  return true;
}

class Mutex {
  constructor() { this.locked = false; this.waiters = []; }
  acquire() {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => this.waiters.push(resolve)).then(() => () => this.release());
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

function makeTransactionalRaceDb() {
  const ledgers = [{
    id: "r2", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a",
    dialogId: "dialog-1", fanId: "dialog-1", messageId: "reply-r2",
    sentAt: date("2026-08-12T10:20:00.000Z"), source: "manual",
  }];
  const events = [
    { id: "i1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", fanId: "dialog-1", messageId: "incoming-i1", eventKind: "FAN_MESSAGE_RECEIVED", ts: date("2026-08-12T10:01:00.000Z") },
    { id: "i2", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", fanId: "dialog-1", messageId: "incoming-i2", eventKind: "FAN_MESSAGE_RECEIVED", ts: date("2026-08-12T10:15:00.000Z") },
  ];
  const responseCases = [];
  const mutexes = new Map();
  const acquiredKeys = [];

  let firstCoverageReachedResolve;
  const firstCoverageReached = new Promise((resolve) => { firstCoverageReachedResolve = resolve; });
  let releaseFirstCoverageResolve;
  const releaseFirstCoverage = new Promise((resolve) => { releaseFirstCoverageResolve = resolve; });
  let coverageCalls = 0;

  function ledgerMatches(row, where) {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && row.creatorId !== where.creatorId) return false;
    if (where.accountId && row.accountId !== where.accountId) return false;
    if (where.dialogId && row.dialogId !== where.dialogId) return false;
    if (where.messageId && row.messageId !== where.messageId) return false;
    if (where.source?.in && !where.source.in.includes(row.source)) return false;
    if (where.sentAt instanceof Date) {
      if (new Date(row.sentAt).getTime() !== where.sentAt.getTime()) return false;
    } else if (where.sentAt && !matchesDate(row.sentAt, where.sentAt)) return false;
    if (where.telemetryEventId === null && row.telemetryEventId != null) return false;
    if (where.telemetryEventId?.lt && !(String(row.telemetryEventId || "") < String(where.telemetryEventId.lt))) return false;
    if (where.NOT?.messageId && row.messageId === where.NOT.messageId) return false;
    return true;
  }
  function eventMatches(row, where) {
    for (const key of ["agencyId", "creatorId", "dialogId", "memberId", "eventKind"]) {
      if (where[key] !== undefined && row[key] !== where[key]) return false;
    }
    if (where.ts && !matchesDate(row.ts, where.ts)) return false;
    return true;
  }

  const storage = {
    teamSentMessageLedger: {
      async findFirst({ where, orderBy }) {
        const rows = ledgers.filter((row) => ledgerMatches(row, where));
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt) || String(a.id).localeCompare(String(b.id)));
        const direction = Array.isArray(orderBy) ? orderBy[0]?.sentAt : orderBy?.sentAt;
        if (direction === "desc") rows.reverse();
        return rows[0] || null;
      },
      async findMany({ where, orderBy }) {
        const rows = ledgers.filter((row) => ledgerMatches(row, where));
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt) || String(a.telemetryEventId || "").localeCompare(String(b.telemetryEventId || "")) || String(a.id).localeCompare(String(b.id)));
        const direction = Array.isArray(orderBy) ? orderBy[0]?.sentAt : orderBy?.sentAt;
        if (direction === "desc") rows.reverse();
        return rows;
      },
    },
    teamActivityEvent: {
      async findMany({ where, orderBy }) {
        const rows = events.filter((row) => eventMatches(row, where));
        rows.sort((a, b) => new Date(a.ts) - new Date(b.ts) || String(a.id).localeCompare(String(b.id)));
        if (orderBy?.ts === "desc") rows.reverse();
        return rows;
      },
      async findFirst({ where, orderBy }) {
        const rows = events.filter((row) => eventMatches(row, where));
        rows.sort((a, b) => new Date(a.ts) - new Date(b.ts) || String(a.id).localeCompare(String(b.id)));
        if (orderBy?.ts === "desc") rows.reverse();
        return rows[0] || null;
      },
    },
    teamCoverageSession: {
      async findFirst() {
        coverageCalls += 1;
        if (coverageCalls === 1) {
          firstCoverageReachedResolve();
          await releaseFirstCoverage;
        }
        return null;
      },
    },
    teamResponseCase: {
      async findUnique({ where }) {
        const key = where.agencyId_creatorId_replyMessageId;
        return responseCases.find((row) => row.agencyId === key.agencyId && row.creatorId === key.creatorId && row.replyMessageId === key.replyMessageId) || null;
      },
      async upsert({ where, create, update }) {
        const key = where.agencyId_creatorId_replyMessageId;
        let row = responseCases.find((item) => item.agencyId === key.agencyId && item.creatorId === key.creatorId && item.replyMessageId === key.replyMessageId);
        if (!row) {
          row = { id: "response-1", ...create };
          responseCases.push(row);
        } else Object.assign(row, update);
        return { ...row };
      },
    },
  };

  const db = {
    ...storage,
    async $transaction(work) {
      const releases = [];
      const tx = {
        ...storage,
        async $executeRawUnsafe(_sql, key) {
          const normalized = String(key);
          let mutex = mutexes.get(normalized);
          if (!mutex) { mutex = new Mutex(); mutexes.set(normalized, mutex); }
          const release = await mutex.acquire();
          releases.push(release);
          acquiredKeys.push(normalized);
          return 1;
        },
      };
      try { return await work(tx); }
      finally { for (const release of releases.reverse()) release(); }
    },
  };

  return {
    db, ledgers, responseCases, acquiredKeys, firstCoverageReached,
    releaseFirstCoverage: () => releaseFirstCoverageResolve(),
  };
}

test("per-dialog response commit fence prevents an older derive from overwriting a newer successor repair", async () => {
  const fx = makeTransactionalRaceDb();
  const r2 = fx.ledgers[0];

  const older = service.deriveResponseCaseForReply(r2, fx.db);
  await fx.firstCoverageReached;

  // Late R1 becomes canonical only after the older derive already captured the old
  // incoming episode [I1,I2]. The newer derive must wait for the same dialog fence,
  // then re-read current facts and leave R2 with only I2.
  fx.ledgers.push({
    id: "r1", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a",
    dialogId: "dialog-1", fanId: "dialog-1", messageId: "reply-r1",
    sentAt: date("2026-08-12T10:10:00.000Z"), source: "manual",
  });
  const newerPromise = service.deriveResponseCaseForReply(r2, fx.db);

  // Give the second transaction a chance to reach the advisory lock. It cannot run
  // its read phase until the first transaction releases the per-dialog authority.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.acquiredKeys.length, 1);

  fx.releaseFirstCoverage();
  const olderResult = await older;
  const newerResult = await newerPromise;

  assert.equal(olderResult.incomingCount, 2);
  assert.equal(newerResult.incomingCount, 1);
  assert.equal(fx.responseCases.length, 1);
  assert.equal(fx.responseCases[0].incomingCount, 1);
  assert.deepEqual(fx.acquiredKeys, [
    "team-response:agency-1:creator-1:dialog-1",
    "team-response:agency-1:creator-1:dialog-1",
  ]);
});

test("stale historical NEEDS_REPAIR page cannot downgrade a response case that is already FULL", async () => {
  const current = {
    id: "response-current", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a",
    dialogId: "dialog-1", replyMessageId: "reply-1", projectionState: "FULL", projectionRevision: 7n,
  };
  const stalePageRow = { ...current, projectionState: "NEEDS_REPAIR", projectionRevision: 3n };
  let updates = 0;
  let ledgerReads = 0;
  const db = {
    teamResponseCase: {
      async findUnique() { return { ...current }; },
      async update() { updates += 1; throw new Error("stale historical repair must not write"); },
    },
    teamSentMessageLedger: {
      async findFirst() { ledgerReads += 1; throw new Error("current FULL state must be checked before historical evidence"); },
    },
  };

  const result = await service.repairHistoricalResponseCase({ row: stalePageRow, agencyId: "agency-1", db });
  assert.equal(result.skippedCurrent, true);
  assert.equal(result.projectionState, "FULL");
  assert.equal(updates, 0);
  assert.equal(ledgerReads, 0);
});

function makeCoverageRaceDb() {
  const row = {
    id: "coverage-row", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a",
    coverageId: "coverage-1", startedAt: date("2026-08-12T09:00:00.000Z"), endedAt: null,
    durationSeconds: null, startReason: "SHIFT", endReason: null,
  };
  const mutex = new Mutex();
  const acquiredKeys = [];
  let firstUpdateReachedResolve;
  const firstUpdateReached = new Promise((resolve) => { firstUpdateReachedResolve = resolve; });
  let releaseFirstUpdateResolve;
  const releaseFirstUpdate = new Promise((resolve) => { releaseFirstUpdateResolve = resolve; });
  let updates = 0;
  let reads = 0;

  const storage = {
    teamCoverageSession: {
      async findUnique() { reads += 1; return { ...row }; },
      async create({ data }) { Object.assign(row, data); return { ...row }; },
      async update({ data }) {
        updates += 1;
        if (updates === 1) {
          firstUpdateReachedResolve();
          await releaseFirstUpdate;
        }
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
  const db = {
    ...storage,
    async $transaction(work) {
      const releases = [];
      const tx = {
        ...storage,
        async $executeRawUnsafe(_sql, key) {
          const release = await mutex.acquire();
          releases.push(release);
          acquiredKeys.push(String(key));
          return 1;
        },
      };
      try { return await work(tx); }
      finally { for (const release of releases.reverse()) release(); }
    },
  };
  return {
    db, row, acquiredKeys, getReads: () => reads, firstUpdateReached,
    releaseFirstUpdate: () => releaseFirstUpdateResolve(),
  };
}

test("coverage identity fence prevents a late START merge from erasing a concurrent END", async () => {
  const fx = makeCoverageRaceDb();
  const started = {
    agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "coverage-1",
    eventKind: "COVERAGE_STARTED", ts: date("2026-08-12T09:00:00.000Z"), startedAt: date("2026-08-12T09:00:00.000Z"),
  };
  const ended = {
    agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "coverage-1",
    eventKind: "COVERAGE_ENDED", ts: date("2026-08-12T10:00:00.000Z"), startedAt: date("2026-08-12T09:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z"),
  };

  const oldStart = service.upsertCoverageSession(started, fx.db);
  await fx.firstUpdateReached;
  const readsBeforeEnd = fx.getReads();
  const currentEnd = service.upsertCoverageSession(ended, fx.db);
  await new Promise((resolve) => setImmediate(resolve));

  // END must still be waiting on the stable coverage lock; without the fence it can
  // read/update while START is paused and then be overwritten by START's stale merge.
  assert.equal(fx.getReads(), readsBeforeEnd);
  assert.equal(fx.acquiredKeys.length, 1);

  fx.releaseFirstUpdate();
  await oldStart;
  const endResult = await currentEnd;

  assert.equal(endResult.endedAt.toISOString(), "2026-08-12T10:00:00.000Z");
  assert.equal(fx.row.endedAt.toISOString(), "2026-08-12T10:00:00.000Z");
  assert.equal(fx.row.durationSeconds, 3600);
  assert.deepEqual(fx.acquiredKeys, [
    "team-coverage:agency-1:coverage-1",
    "team-coverage:agency-1:coverage-1",
  ]);
});
