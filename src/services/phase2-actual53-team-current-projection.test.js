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
