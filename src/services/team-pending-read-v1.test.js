"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { listTeamPendingDialogs, summarizePendingRows, summarizePendingWhere, repairStaleLegacyBootstrapPending } = require("./team-pending-read-service");

function makeDb() {
  const rows = [
    {
      id: "p-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", fanId: "fan-1", status: "PENDING",
      firstIncomingAt: new Date("2026-08-12T09:00:00.000Z"), lastIncomingAt: new Date("2026-08-12T09:02:00.000Z"), incomingCount: 3,
      firstIncomingMessageId: "m-1", lastIncomingMessageId: "m-3", firstSeenAt: new Date("2026-08-12T09:03:00.000Z"),
      firstSeenMemberId: "member-a", lastSeenAt: new Date("2026-08-12T09:04:00.000Z"), lastSeenMemberId: "member-a",
      ownerMemberId: "member-a", ownerAssignedAt: new Date("2026-08-12T09:04:00.000Z"), ownerReason: "DIALOG_SEEN", derivationVersion: "team_pending_v1",
    },
    {
      id: "p-2", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-2", fanId: "fan-2", status: "PENDING",
      firstIncomingAt: new Date("2026-08-12T08:00:00.000Z"), lastIncomingAt: new Date("2026-08-12T08:00:00.000Z"), incomingCount: 1,
      ownerMemberId: null, derivationVersion: "team_pending_v1",
    },
    {
      id: "p-3", agencyId: "agency-1", creatorId: "creator-2", dialogId: "fan-3", fanId: "fan-3", status: "PENDING",
      firstIncomingAt: new Date("2026-08-12T08:30:00.000Z"), lastIncomingAt: new Date("2026-08-12T08:30:00.000Z"), incomingCount: 2,
      ownerMemberId: "member-b", derivationVersion: "team_pending_v1",
    },
  ];
  return {
    teamPendingDialogState: {
      async findMany({ where, orderBy, take }) {
        let out = rows.filter((row) => {
          if (where.agencyId && row.agencyId !== where.agencyId) return false;
          if (where.status && row.status !== where.status) return false;
          if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
          if (Object.prototype.hasOwnProperty.call(where, "ownerMemberId")) {
            if (where.ownerMemberId === null && row.ownerMemberId !== null) return false;
            if (typeof where.ownerMemberId === "string" && row.ownerMemberId !== where.ownerMemberId) return false;
          }
          return true;
        });
        out.sort((a, b) => new Date(a.firstIncomingAt) - new Date(b.firstIncomingAt));
        return out.slice(0, take || out.length);
      },
    },
    agencyMember: {
      async findMany({ where }) {
        const members = [
          { id: "member-a", agencyId: "agency-1", displayName: "Marina", deletedAt: null, user: { name: "Marina" } },
          { id: "member-b", agencyId: "agency-1", displayName: "Nikita", deletedAt: null, user: { name: "Nikita" } },
        ];
        return members.filter((m) => m.agencyId === where.agencyId && where.id.in.includes(m.id));
      },
    },
    creatorAccount: {
      async findMany() { return [{ id: "creator-1", displayName: "Vilgelmina", username: "vilgelmina", avatarUrl: "https://img/creator.jpg" }]; },
    },
    creatorFan: {
      async findMany() { return [{ creatorId: "creator-1", onlyFansUserId: "fan-1", username: "andrew", displayName: "Andrew" }]; },
    },
    followBackCandidate: {
      async findMany() { return [{ creatorId: "creator-1", fanId: "fan-1", username: "andrew", displayName: "Andrew", avatarUrl: "https://img/fan.jpg", updatedAt: new Date("2026-08-12T09:30:00.000Z") }]; },
    },
  };
}

test("pending read model is current-queue, creator-scoped and exposes evidence without message text", async () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const payload = await listTeamPendingDialogs({ agencyId: "agency-1", allowedCreatorIds: ["creator-1"], limit: 100, now, db: makeDb() });
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.summary.pendingDialogs, 2);
  assert.equal(payload.summary.pendingIncomingMessages, 4);
  assert.equal(payload.summary.unassignedDialogs, 1);
  assert.equal(payload.summary.seenDialogs, 1);
  assert.equal(payload.summary.olderThan15m, 2);
  assert.equal(payload.summary.olderThan60m, 2);
  assert.equal(payload.summary.oldestPendingSeconds, 2 * 60 * 60);
  const first = payload.rows.find((row) => row.id === "p-1");
  assert.equal(first.ownerMemberName, "Marina");
  assert.equal(first.creatorDisplayName, "Vilgelmina");
  assert.equal(first.creatorUsername, "vilgelmina");
  assert.equal(first.fanDisplayName, "Andrew");
  assert.equal(first.fanUsername, "andrew");
  assert.equal(first.fanAvatarUrl, "https://img/fan.jpg");
  assert.equal(Object.prototype.hasOwnProperty.call(payload.rows[0], "text"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.rows[0], "messageText"), false);
});

test("member pending filter attributes only explicitly owned rows; unassigned stays team-level", async () => {
  const payload = await listTeamPendingDialogs({ agencyId: "agency-1", allowedCreatorIds: ["creator-1"], memberId: "member-a", now: new Date("2026-08-12T10:00:00.000Z"), db: makeDb() });
  assert.deepEqual(payload.rows.map((row) => row.id), ["p-1"]);
  assert.equal(payload.summary.pendingDialogs, 1);
  assert.equal(payload.summary.unassignedDialogs, 0);
});

test("summary counts pending dialogs separately from raw incoming message volume", () => {
  const rows = [
    { firstIncomingAt: new Date("2026-08-12T09:50:00.000Z"), incomingCount: 5, ownerMemberId: null },
    { firstIncomingAt: new Date("2026-08-12T09:00:00.000Z"), incomingCount: 2, ownerMemberId: "member-a" },
  ];
  const summary = summarizePendingRows(rows, { now: new Date("2026-08-12T10:00:00.000Z") });
  assert.equal(summary.pendingDialogs, 2);
  assert.equal(summary.pendingIncomingMessages, 7);
  assert.equal(summary.unassignedDialogs, 1);
});


test("indexed pending summary is independent of diagnostic row limit", async () => {
  const calls = [];
  const db = { teamPendingDialogState: {
    async count({ where }) {
      calls.push(["count", where]);
      if (where.ownerMemberId === null) return 2;
      if (where.ownerMemberId?.not === null) return 3;
      if (where.firstIncomingAt?.lte && new Date(where.firstIncomingAt).getTime() <= new Date("2026-08-12T09:00:00.000Z").getTime()) return 1;
      if (where.firstIncomingAt?.lte) return 4;
      return 5;
    },
    async aggregate() {
      return { _sum: { incomingCount: 11 }, _min: { firstIncomingAt: new Date("2026-08-12T08:00:00.000Z") } };
    },
  } };
  const summary = await summarizePendingWhere({ where: { agencyId: "agency-1", status: "PENDING" }, now: new Date("2026-08-12T10:00:00.000Z"), db, fallbackRows: [{ incomingCount: 1 }] });
  assert.equal(summary.pendingDialogs, 5);
  assert.equal(summary.pendingIncomingMessages, 11);
  assert.equal(summary.unassignedDialogs, 2);
  assert.equal(summary.seenDialogs, 3);
  assert.equal(summary.oldestPendingSeconds, 2 * 60 * 60);
  assert.ok(calls.length >= 5);
});

test("indexed member pending summary never widens owner scope", async () => {
  const rows = [
    { agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", ownerMemberId: "member-a", incomingCount: 2, firstIncomingAt: new Date("2026-08-12T09:30:00.000Z") },
    { agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", ownerMemberId: "member-b", incomingCount: 9, firstIncomingAt: new Date("2026-08-12T08:30:00.000Z") },
    { agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", ownerMemberId: null, incomingCount: 7, firstIncomingAt: new Date("2026-08-12T07:30:00.000Z") },
  ];
  const matches = (row, where) => {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
    if (Object.prototype.hasOwnProperty.call(where, "ownerMemberId")) {
      if (where.ownerMemberId === null && row.ownerMemberId !== null) return false;
      if (typeof where.ownerMemberId === "string" && row.ownerMemberId !== where.ownerMemberId) return false;
      if (where.ownerMemberId?.not === null && row.ownerMemberId === null) return false;
    }
    if (where.firstIncomingAt?.lte && row.firstIncomingAt > where.firstIncomingAt.lte) return false;
    return true;
  };
  const db = { teamPendingDialogState: {
    async count({ where }) { return rows.filter((row) => matches(row, where)).length; },
    async aggregate({ where }) {
      const scoped = rows.filter((row) => matches(row, where));
      return {
        _sum: { incomingCount: scoped.reduce((sum, row) => sum + row.incomingCount, 0) },
        _min: { firstIncomingAt: scoped.length ? new Date(Math.min(...scoped.map((row) => row.firstIncomingAt.getTime()))) : null },
      };
    },
  } };
  const summary = await summarizePendingWhere({
    where: { agencyId: "agency-1", status: "PENDING", creatorId: { in: ["creator-1"] }, ownerMemberId: "member-a" },
    now: new Date("2026-08-12T10:00:00.000Z"),
    db,
  });
  assert.equal(summary.pendingDialogs, 1);
  assert.equal(summary.pendingIncomingMessages, 2);
  assert.equal(summary.unassignedDialogs, 0);
  assert.equal(summary.seenDialogs, 1);
  assert.equal(summary.oldestPendingSeconds, 30 * 60);
});


test("legacy bootstrap repair clears only ancient pending whose latest incoming is still the legacy bootstrap event", async () => {
  const pending = [
    { id: "old-bootstrap", agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", lastIncomingAt: new Date("2026-01-01T00:00:00Z"), lastIncomingEventId: "event-old" },
    { id: "old-live", agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", lastIncomingAt: new Date("2026-01-01T00:00:00Z"), lastIncomingEventId: "event-live" },
    { id: "recent-bootstrap", agencyId: "agency-1", creatorId: "creator-1", status: "PENDING", lastIncomingAt: new Date("2026-08-10T00:00:00Z"), lastIncomingEventId: "event-recent" },
  ];
  let cleared = [];
  const db = {
    teamPendingDialogState: {
      async findMany({ where }) {
        return pending.filter((row) => row.status === "PENDING" && row.lastIncomingAt <= where.lastIncomingAt.lte);
      },
      async updateMany({ where }) { cleared = where.id.in.slice(); return { count: cleared.length }; },
    },
    teamActivityEvent: {
      async findMany() {
        return [
          { id: "event-old", ts: new Date("2026-01-01T00:00:00Z"), extra: { sourceDetail: "crm_pending_bootstrap_v1" } },
          { id: "event-live", ts: new Date("2026-01-01T00:00:00Z"), extra: { sourceDetail: "creator_runtime_ws" } },
          { id: "event-recent", ts: new Date("2026-08-10T00:00:00Z"), extra: { sourceDetail: "crm_pending_bootstrap_v1" } },
        ];
      },
    },
  };
  const result = await repairStaleLegacyBootstrapPending({ agencyId: "agency-1", allowedCreatorIds: ["creator-1"], now: new Date("2026-08-12T10:00:00Z"), db });
  assert.equal(result.cleared, 1);
  assert.deepEqual(cleared, ["old-bootstrap"]);
});
