"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const prismaPath = require.resolve("../prisma");
const projectionPath = path.resolve(__dirname, "team-response-projection-service.js");
delete require.cache[prismaPath];
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { upsertCoverageSession } = require(projectionPath);
const MAX_OPEN_COVERAGE_MS = 12 * 60 * 60 * 1000;
const COVERAGE_RECONCILE_END_REASON = "server_reconciled_next_coverage_start";

function date(value) { return new Date(value); }

function makeDb(seed = []) {
  const rows = seed.map((row) => ({ ...row }));
  const locks = [];
  let seq = 100;
  const db = {
    rows,
    locks,
    async $transaction(work) { return work(db); },
    async $executeRawUnsafe(_sql, key) { locks.push(String(key)); return 1; },
    teamCoverageSession: {
      async findMany({ where, orderBy }) {
        let out = rows.filter((row) => {
          if (where.agencyId && row.agencyId !== where.agencyId) return false;
          if (where.memberId && row.memberId !== where.memberId) return false;
          if (where.deviceId && row.deviceId !== where.deviceId) return false;
          if (where.source && row.source !== where.source) return false;
          if (where.endedAt === null && row.endedAt !== null) return false;
          if (where.coverageId?.not && row.coverageId === where.coverageId.not) return false;
          if (where.startedAt?.lte && row.startedAt > where.startedAt.lte) return false;
          return true;
        }).map((row) => ({ ...row }));
        if (Array.isArray(orderBy) && orderBy.some((item) => item.coverageId === "asc")) {
          out.sort((a, b) => String(a.coverageId).localeCompare(String(b.coverageId)));
        }
        return out;
      },
      async findUnique({ where }) {
        const key = where.agencyId_coverageId;
        const row = rows.find((item) => item.agencyId === key.agencyId && item.coverageId === key.coverageId);
        return row ? { ...row } : null;
      },
      async create({ data }) {
        const row = { id: `coverage-${++seq}`, ...data };
        rows.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = rows.find((item) => item.id === where.id);
        if (!row) throw new Error(`missing coverage row ${where.id}`);
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
  return db;
}

function coverageStart({ coverageId, at, creatorId = "creator-2" }) {
  const startedAt = date(at);
  return {
    agencyId: "agency-1",
    creatorId,
    memberId: "member-1",
    userId: "user-1",
    deviceId: "device-1",
    coverageId,
    correlationId: coverageId,
    eventKind: "COVERAGE_STARTED",
    actionSource: "MANUAL",
    lifecycle: "OBSERVED",
    startedAt,
    ts: startedAt,
    extra: { metadata: { startReason: "browser_workspace" } },
  };
}

function coverageEnd({ coverageId, startedAt, endedAt, reason = "browser_hidden" }) {
  return {
    agencyId: "agency-1",
    creatorId: "creator-1",
    memberId: "member-1",
    userId: "user-1",
    deviceId: "device-1",
    coverageId,
    correlationId: coverageId,
    eventKind: "COVERAGE_ENDED",
    actionSource: "MANUAL",
    lifecycle: "OBSERVED",
    startedAt: date(startedAt),
    endedAt: date(endedAt),
    ts: date(endedAt),
    extra: { metadata: { endReason: reason } },
  };
}

function orphan({ coverageId = "old", startedAt = "2026-09-15T00:00:00.000Z" } = {}) {
  return {
    id: `row-${coverageId}`,
    agencyId: "agency-1",
    creatorId: "creator-1",
    memberId: "member-1",
    userId: "user-1",
    deviceId: "device-1",
    coverageId,
    startedAt: date(startedAt),
    endedAt: null,
    durationSeconds: null,
    startReason: "browser_workspace",
    endReason: null,
    source: "team_v13",
  };
}

test("INT2.11A next proven START closes a prior orphan on the same member/device stream", async () => {
  const db = makeDb([orphan()]);
  const nextAt = "2026-09-15T00:05:00.000Z";
  const next = await upsertCoverageSession(coverageStart({ coverageId: "new", at: nextAt }), db);

  const old = db.rows.find((row) => row.coverageId === "old");
  assert.equal(old.endedAt.toISOString(), nextAt);
  assert.equal(old.durationSeconds, 300);
  assert.equal(old.endReason, COVERAGE_RECONCILE_END_REASON);
  assert.equal(next.coverageId, "new");
  assert.equal(next.endedAt, null);

  assert.deepEqual(db.locks, [
    "team-coverage-stream:agency-1:member-1:device-1",
    "team-coverage:agency-1:old",
    "team-coverage:agency-1:new",
  ]);
});


test("INT2.11A repeated orphan START history converges all open predecessors before the new session opens", async () => {
  const db = makeDb([
    orphan({ coverageId: "old-a", startedAt: "2026-09-15T00:00:00.000Z" }),
    orphan({ coverageId: "old-b", startedAt: "2026-09-15T00:02:00.000Z" }),
  ]);
  await upsertCoverageSession(coverageStart({ coverageId: "new", at: "2026-09-15T00:05:00.000Z" }), db);

  const oldA = db.rows.find((row) => row.coverageId === "old-a");
  const oldB = db.rows.find((row) => row.coverageId === "old-b");
  assert.equal(oldA.endedAt.toISOString(), "2026-09-15T00:05:00.000Z");
  assert.equal(oldB.endedAt.toISOString(), "2026-09-15T00:05:00.000Z");
  assert.equal(oldA.endReason, COVERAGE_RECONCILE_END_REASON);
  assert.equal(oldB.endReason, COVERAGE_RECONCILE_END_REASON);
  assert.deepEqual(db.locks, [
    "team-coverage-stream:agency-1:member-1:device-1",
    "team-coverage:agency-1:old-a",
    "team-coverage:agency-1:old-b",
    "team-coverage:agency-1:new",
  ]);
});

test("INT2.11A reconciliation never attributes an orphan beyond the existing 12h stale-open bound", async () => {
  const db = makeDb([orphan({ startedAt: "2026-09-14T00:00:00.000Z" })]);
  await upsertCoverageSession(coverageStart({ coverageId: "new", at: "2026-09-15T00:00:00.000Z" }), db);

  const old = db.rows.find((row) => row.coverageId === "old");
  assert.equal(old.endedAt.toISOString(), "2026-09-14T12:00:00.000Z");
  assert.equal(old.durationSeconds, MAX_OPEN_COVERAGE_MS / 1000);
  assert.equal(old.endReason, COVERAGE_RECONCILE_END_REASON);
});

test("INT2.11A a late ordinary END cannot extend a server-reconciled orphan through the next START", async () => {
  const db = makeDb([orphan()]);
  await upsertCoverageSession(coverageStart({ coverageId: "new", at: "2026-09-15T00:05:00.000Z" }), db);
  const ended = await upsertCoverageSession(coverageEnd({
    coverageId: "old",
    startedAt: "2026-09-15T00:00:00.000Z",
    endedAt: "2026-09-15T00:20:00.000Z",
  }), db);

  assert.equal(ended.endedAt.toISOString(), "2026-09-15T00:05:00.000Z");
  assert.equal(ended.durationSeconds, 300);
  assert.equal(ended.endReason, COVERAGE_RECONCILE_END_REASON);
});

test("INT2.11A a late ordinary END may shorten the conservative server reconciliation bound", async () => {
  const db = makeDb([orphan()]);
  await upsertCoverageSession(coverageStart({ coverageId: "new", at: "2026-09-15T00:05:00.000Z" }), db);
  const ended = await upsertCoverageSession(coverageEnd({
    coverageId: "old",
    startedAt: "2026-09-15T00:00:00.000Z",
    endedAt: "2026-09-15T00:03:00.000Z",
    reason: "late_real_end",
  }), db);

  assert.equal(ended.endedAt.toISOString(), "2026-09-15T00:03:00.000Z");
  assert.equal(ended.durationSeconds, 180);
  assert.equal(ended.endReason, "late_real_end");
});

test("INT2.11A reconciliation is stream-scoped and does not close another device or member", async () => {
  const same = orphan({ coverageId: "same" });
  const otherDevice = { ...orphan({ coverageId: "other-device" }), id: "row-other-device", deviceId: "device-2" };
  const otherMember = { ...orphan({ coverageId: "other-member" }), id: "row-other-member", memberId: "member-2" };
  const db = makeDb([same, otherDevice, otherMember]);

  await upsertCoverageSession(coverageStart({ coverageId: "new", at: "2026-09-15T00:05:00.000Z" }), db);

  assert.ok(db.rows.find((row) => row.coverageId === "same").endedAt);
  assert.equal(db.rows.find((row) => row.coverageId === "other-device").endedAt, null);
  assert.equal(db.rows.find((row) => row.coverageId === "other-member").endedAt, null);
});
