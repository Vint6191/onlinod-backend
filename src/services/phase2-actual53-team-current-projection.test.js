"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { applyTeamPendingProjection } = require("./team-pending-projection-service");
const { pendingProjectionAuthorityWhere } = require("./team-pending-read-service");

function copy(row) { return row ? { ...row } : row; }

function incrementalDb(initial) {
  let state = copy(initial);
  let historyRead = false;
  const db = {
    teamPendingDialogState: {
      async findUnique() { return copy(state); },
      async update({ data }) { state = { ...state, ...data }; return copy(state); },
      async upsert({ create, update }) { state = state ? { ...state, ...update } : { id: "pending-new", ...create }; return copy(state); },
    },
    teamSentMessageLedger: { async findFirst() { return null; } },
    teamActivityEvent: {
      async findFirst() { return null; },
      async findMany() { historyRead = true; throw new Error("normal in-order projection must not read unanswered history"); },
      async update() { return {}; },
    },
  };
  return { db, state: () => copy(state), historyRead: () => historyRead };
}

function baseState() {
  return {
    id: "pending-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", fanId: "fan-1",
    status: "PENDING", episodeKey: "msg-1", firstIncomingEventId: "event-a", lastIncomingEventId: "event-a",
    firstIncomingMessageId: "msg-1", lastIncomingMessageId: "msg-1",
    firstIncomingAt: new Date("2026-09-10T10:00:00.000Z"), lastIncomingAt: new Date("2026-09-10T10:00:00.000Z"),
    incomingCount: 999999, ownerMemberId: null, derivationVersion: "team_pending_v2", projectionState: "FULL",
    projectionRevision: 7n, lastAppliedEventAt: new Date("2026-09-10T10:00:00.000Z"), lastAppliedEventId: "event-a",
  };
}

test("F53-04 normal in-order incoming updates compact current state without replaying unanswered history", async () => {
  const fixture = incrementalDb(baseState());
  const result = await applyTeamPendingProjection({
    id: "event-b", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", fanId: "fan-1",
    eventKind: "FAN_MESSAGE_RECEIVED", messageId: "msg-2", ts: new Date("2026-09-10T10:01:00.000Z"),
  }, fixture.db);
  assert.equal(result.incremental, true);
  assert.equal(fixture.state().incomingCount, 1000000);
  assert.equal(fixture.state().lastAppliedEventId, "event-b");
  assert.equal(fixture.historyRead(), false);
});

test("F53-05 same timestamp uses stable canonical event id as total-order tiebreak", async () => {
  const fixture = incrementalDb(baseState());
  const result = await applyTeamPendingProjection({
    id: "event-b", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", fanId: "fan-1",
    eventKind: "FAN_MESSAGE_RECEIVED", messageId: "msg-2", ts: new Date("2026-09-10T10:00:00.000Z"),
  }, fixture.db);
  assert.equal(result.incremental, true);
  assert.equal(fixture.state().lastAppliedEventId, "event-b");
  assert.equal(fixture.state().incomingCount, 1000000);
});

test("F53-08 pending generation selection never fails open to legacy physical rows", async () => {
  const where = await pendingProjectionAuthorityWhere({ agencyId: "agency-1", db: {} });
  assert.equal(where.derivationVersion, "team_pending_v2");
  assert.deepEqual(where.projectionState.in, ["FULL", "INCOMPLETE_HISTORY"]);
});

function orderingFixture() {
  let state = null;
  const events = [];
  function dateCmp(v, cond) {
    const t = new Date(v).getTime();
    if (cond?.gt && !(t > new Date(cond.gt).getTime())) return false;
    if (cond?.gte && !(t >= new Date(cond.gte).getTime())) return false;
    if (cond?.lt && !(t < new Date(cond.lt).getTime())) return false;
    if (cond?.lte && !(t <= new Date(cond.lte).getTime())) return false;
    return true;
  }
  function matches(row, where = {}) {
    for (const key of ["agencyId", "creatorId", "dialogId", "eventKind"]) if (where[key] !== undefined && row[key] !== where[key]) return false;
    if (where.memberId?.not !== undefined && row.memberId === where.memberId.not) return false;
    if (where.ts instanceof Date && new Date(row.ts).getTime() !== where.ts.getTime()) return false;
    if (where.ts && !(where.ts instanceof Date) && !dateCmp(row.ts, where.ts)) return false;
    if (where.id?.gt && !(String(row.id) > String(where.id.gt))) return false;
    if (Array.isArray(where.OR) && !where.OR.some((x) => matches(row, x))) return false;
    if (Array.isArray(where.AND) && !where.AND.every((x) => matches(row, x))) return false;
    return true;
  }
  const db = {
    teamSentMessageLedger: { async findFirst() { return null; } },
    teamActivityEvent: {
      async findFirst({ where, orderBy }) {
        const rows = events.filter((row) => matches(row, where)).sort((a,b) => new Date(a.ts)-new Date(b.ts) || String(a.id).localeCompare(String(b.id)));
        if (Array.isArray(orderBy) && orderBy[0]?.ts === "desc") rows.reverse();
        return rows[0] || null;
      },
      async findMany({ where, orderBy, take }) {
        const rows = events.filter((row) => matches(row, where)).sort((a,b) => new Date(a.ts)-new Date(b.ts) || String(a.id).localeCompare(String(b.id)));
        if (Array.isArray(orderBy) && orderBy[0]?.ts === "desc") rows.reverse();
        return rows.slice(0, take || rows.length);
      },
    },
    teamPendingDialogState: {
      async findUnique() { return state ? { ...state } : null; },
      async update({ data }) { state = { ...state, ...data }; return { ...state }; },
      async upsert({ create, update }) { state = state ? { ...state, ...update } : { id: "pending-1", ...create }; return { ...state }; },
    },
  };
  return { db, events, state: () => state ? { ...state } : null };
}

test("F55-03 pending ownership is replay-deterministic when same-time seen is canonically before incoming", async () => {
  const at = new Date("2026-09-11T10:00:00.000Z");
  const seen = { id: "event-a", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", eventKind: "DIALOG_SEEN", memberId: "member-1", ts: at };
  const incomingRow = { id: "event-m", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", fanId: "fan-1", eventKind: "FAN_MESSAGE_RECEIVED", messageId: "msg-m", ts: at };

  const before = orderingFixture();
  before.events.push(seen); await applyTeamPendingProjection(seen, before.db);
  before.events.push(incomingRow); await applyTeamPendingProjection(incomingRow, before.db);

  const after = orderingFixture();
  after.events.push(incomingRow); await applyTeamPendingProjection(incomingRow, after.db);
  after.events.push(seen); await applyTeamPendingProjection(seen, after.db);

  assert.equal(before.state()?.ownerMemberId || null, null);
  assert.equal(after.state()?.ownerMemberId || null, null);
  assert.equal(before.state()?.firstSeenMemberId || null, null);
  assert.equal(after.state()?.firstSeenMemberId || null, null);
});
