"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const service = require("./team-pending-projection-service");

function d(value) { return new Date(value); }

function matchDate(value, cond = {}) {
  const t = new Date(value).getTime();
  if (cond.gt && !(t > new Date(cond.gt).getTime())) return false;
  if (cond.gte && !(t >= new Date(cond.gte).getTime())) return false;
  if (cond.lt && !(t < new Date(cond.lt).getTime())) return false;
  if (cond.lte && !(t <= new Date(cond.lte).getTime())) return false;
  return true;
}

function makeDb({ events = [], ledgers = [] } = {}) {
  const activity = events.map((row, i) => ({ id: row.id || `event-${i + 1}`, pendingProjectionVersion: row.pendingProjectionVersion ?? null, ...row }));
  const states = [];

  function eventMatches(row, where = {}) {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && row.creatorId !== where.creatorId) return false;
    if (where.dialogId && row.dialogId !== where.dialogId) return false;
    if (typeof where.eventKind === "string" && row.eventKind !== where.eventKind) return false;
    if (where.eventKind?.in && !where.eventKind.in.includes(row.eventKind)) return false;
    if (where.memberId?.not === null && row.memberId == null) return false;
    if (where.ts && !matchDate(row.ts, where.ts)) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (Array.isArray(where.OR)) {
      const ok = where.OR.some((branch) => {
        if (Object.prototype.hasOwnProperty.call(branch, "pendingProjectionVersion") && branch.pendingProjectionVersion === null) return row.pendingProjectionVersion == null;
        if (branch.pendingProjectionVersion?.not) return row.pendingProjectionVersion !== branch.pendingProjectionVersion.not;
        return false;
      });
      if (!ok) return false;
    }
    return true;
  }

  function ledgerMatches(row, where = {}) {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && row.creatorId !== where.creatorId) return false;
    if (where.dialogId && row.dialogId !== where.dialogId) return false;
    if (where.source?.in && !where.source.in.includes(row.source)) return false;
    return true;
  }

  const db = {
    teamSentMessageLedger: {
      async findFirst({ where, orderBy }) {
        const rows = ledgers.filter((row) => ledgerMatches(row, where)).slice();
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
        if (orderBy?.sentAt === "desc") rows.reverse();
        return rows[0] || null;
      },
    },
    teamActivityEvent: {
      async findMany({ where = {}, orderBy, take }) {
        let rows = activity.filter((row) => eventMatches(row, where)).slice();
        rows.sort((a, b) => {
          const time = new Date(a.ts || 0) - new Date(b.ts || 0);
          return time || String(a.id).localeCompare(String(b.id));
        });
        if (Array.isArray(orderBy) && orderBy[0]?.ts === "desc") rows.reverse();
        if (!Array.isArray(orderBy) && orderBy?.ts === "desc") rows.reverse();
        return rows.slice(0, take || rows.length);
      },
      async update({ where, data }) {
        const row = activity.find((item) => item.id === where.id);
        if (!row) throw new Error(`missing event ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of activity) {
          if (!eventMatches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
    teamPendingDialogState: {
      async findUnique({ where }) {
        const key = where.agencyId_creatorId_dialogId;
        return states.find((row) => row.agencyId === key.agencyId && row.creatorId === key.creatorId && row.dialogId === key.dialogId) || null;
      },
      async upsert({ where, create, update }) {
        const key = where.agencyId_creatorId_dialogId;
        let row = states.find((item) => item.agencyId === key.agencyId && item.creatorId === key.creatorId && item.dialogId === key.dialogId);
        if (!row) {
          row = { id: `pending-${states.length + 1}`, ...create };
          states.push(row);
        } else Object.assign(row, update);
        return row;
      },
      async update({ where, data }) {
        const row = states.find((item) => item.id === where.id);
        if (!row) throw new Error(`missing pending ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { db, activity, states, ledgers };
}

function incoming(id, at, messageId = id) {
  return {
    id,
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "fan-1",
    fanId: "fan-1",
    memberId: null,
    eventKind: "FAN_MESSAGE_RECEIVED",
    messageId,
    localId: `${id}-local`,
    ts: d(at),
  };
}

function seen(id, at, memberId) {
  return {
    id,
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "fan-1",
    fanId: "fan-1",
    memberId,
    eventKind: "DIALOG_SEEN",
    localId: `${id}-local`,
    ts: d(at),
  };
}

function manualReply(id, at, memberId = "member-a") {
  return {
    id,
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "fan-1",
    fanId: "fan-1",
    memberId,
    eventKind: "MESSAGE_SEND_CONFIRMED",
    actionSource: "MANUAL",
    lifecycle: "CONFIRMED",
    messageId: id,
    localId: `${id}-local`,
    ts: d(at),
  };
}

test("fan incoming opens an unassigned pending dialog; trusted seen assigns current owner", async () => {
  const first = incoming("in-1", "2026-08-12T09:00:00.000Z", "of-in-1");
  const view = seen("seen-1", "2026-08-12T09:01:00.000Z", "member-a");
  const fx = makeDb({ events: [first, view] });

  await service.applyTeamPendingProjection(first, fx.db);
  assert.equal(fx.states.length, 1);
  assert.equal(fx.states[0].status, "PENDING");
  assert.equal(fx.states[0].ownerMemberId, "member-a", "reconciliation can see already durable trusted seen evidence");
  assert.equal(fx.states[0].incomingCount, 1);
  assert.equal(fx.states[0].firstIncomingMessageId, "of-in-1");
  assert.equal(fx.activity[0].pendingProjectionVersion, "team_pending_v1");
});

test("same OF incoming observed on two devices counts once by canonical messageId", async () => {
  const one = incoming("in-a", "2026-08-12T09:00:00.000Z", "of-same-message");
  const two = { ...incoming("in-b", "2026-08-12T09:00:00.100Z", "of-same-message"), localId: "other-device-local" };
  const fx = makeDb({ events: [one, two] });
  await service.applyTeamPendingProjection(one, fx.db);
  assert.equal(fx.states[0].incomingCount, 1);
  assert.equal(fx.states[0].firstIncomingMessageId, "of-same-message");
  assert.equal(fx.states[0].lastIncomingMessageId, "of-same-message");
});

test("latest trusted seen owns current queue while first-seen evidence survives handoff", async () => {
  const rows = [
    incoming("in-1", "2026-08-12T09:00:00.000Z", "of-in-1"),
    seen("seen-a", "2026-08-12T09:01:00.000Z", "member-a"),
    seen("seen-b", "2026-08-12T09:03:00.000Z", "member-b"),
  ];
  const fx = makeDb({ events: rows });
  await service.applyTeamPendingProjection(rows[2], fx.db);
  const state = fx.states[0];
  assert.equal(state.status, "PENDING");
  assert.equal(state.firstSeenMemberId, "member-a");
  assert.equal(state.lastSeenMemberId, "member-b");
  assert.equal(state.ownerMemberId, "member-b");
  assert.equal(state.ownerReason, "DIALOG_SEEN_HANDOFF");
});

test("only confirmed manual reply clears pending; automation send cannot clear it", async () => {
  const inc = incoming("in-1", "2026-08-12T09:00:00.000Z", "of-in-1");
  const auto = { ...manualReply("auto-1", "2026-08-12T09:01:00.000Z", null), actionSource: "AUTOMATION", memberId: null };
  const fx = makeDb({ events: [inc, auto] });
  await service.applyTeamPendingProjection(inc, fx.db);
  await service.applyTeamPendingProjection(auto, fx.db);
  assert.equal(fx.states[0].status, "PENDING");

  const reply = manualReply("reply-1", "2026-08-12T09:02:00.000Z", "member-a");
  fx.activity.push(reply);
  fx.ledgers.push({
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", fanId: "fan-1",
    memberId: "member-a", messageId: "reply-1", source: "manual", sentAt: reply.ts,
  });
  await service.applyTeamPendingProjection(reply, fx.db);
  assert.equal(fx.states[0].status, "CLEAR");
  assert.equal(fx.states[0].replyMessageId, "reply-1");
  assert.equal(fx.states[0].repliedByMemberId, "member-a");
});

test("late-arriving incoming telemetry cannot reopen an episode that a durable manual reply already answered", async () => {
  const inc = incoming("in-late", "2026-08-12T09:00:00.000Z", "of-in-late");
  const fx = makeDb({
    events: [inc],
    ledgers: [{ agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", memberId: "member-a", messageId: "reply-1", source: "manual", sentAt: d("2026-08-12T09:02:00.000Z") }],
  });
  await service.applyTeamPendingProjection(inc, fx.db);
  assert.equal(fx.states.length, 0, "latest manual reply is the durable episode boundary");
  assert.equal(fx.activity[0].pendingProjectionVersion, "team_pending_v1");
});

test("historical backfill groups raw events by dialog and marks durable progress", async () => {
  const rows = [
    incoming("in-1", "2026-08-12T09:00:00.000Z", "of-in-1"),
    incoming("in-2", "2026-08-12T09:00:30.000Z", "of-in-2"),
    seen("seen-1", "2026-08-12T09:01:00.000Z", "member-a"),
  ];
  const fx = makeDb({ events: rows });
  const result = await service.backfillTeamPendingProjectionBatch({ db: fx.db, limit: 100 });
  assert.equal(result.selected, 3);
  assert.equal(result.dialogs, 1);
  assert.equal(result.projected, 3);
  assert.equal(fx.states.length, 1);
  assert.equal(fx.states[0].incomingCount, 2);
  assert.equal(fx.states[0].ownerMemberId, "member-a");
  assert.ok(fx.activity.every((row) => row.pendingProjectionVersion === "team_pending_v1"));

  const second = await service.backfillTeamPendingProjectionBatch({ db: fx.db, limit: 100 });
  assert.equal(second.selected, 0, "projection cursor is stored on raw facts; no endless rescan");
});

test("rolling deploy before pending migration keeps raw event unprojected for later DB backfill", async () => {
  let marked = 0;
  const db = {
    teamActivityEvent: { async update() { marked += 1; } },
    // Intentionally no TeamPendingDialogState / TeamSentMessageLedger yet.
  };
  const result = await service.applyTeamPendingProjection({
    id: "raw-before-migration",
    agencyId: "agency-1",
    creatorId: "creator-1",
    dialogId: "fan-1",
    fanId: "fan-1",
    eventKind: "FAN_MESSAGE_RECEIVED",
    ts: new Date("2026-08-12T09:00:00.000Z"),
  }, db);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "pending_projection_models_unavailable");
  assert.equal(marked, 0, "raw row must remain eligible for later backfill");
});
