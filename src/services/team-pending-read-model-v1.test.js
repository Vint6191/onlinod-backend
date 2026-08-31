"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function listModel(rows) {
  return {
    async findMany(args = {}) {
      const where = args.where || {};
      let filtered = rows.filter((row) => {
        if (where.agencyId && row.agencyId !== where.agencyId) return false;
        if (where.status && row.status !== where.status) return false;
        if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
        return true;
      });
      const cursorId = args.cursor?.id || null;
      let start = 0;
      if (cursorId) {
        const idx = filtered.findIndex((row) => row.id === cursorId);
        start = idx >= 0 ? idx + Number(args.skip || 0) : 0;
      }
      return filtered.slice(start, start + Number(args.take || filtered.length));
    },
  };
}

const now = Date.now();
const minute = 60 * 1000;
const member = {
  id: "member-a", agencyId: "agency-1", userId: "user-a", role: "OPERATOR", roleKey: "chatter", displayName: "Marina",
  assignedCreators: ["creator-1"], createdAt: new Date(now - 10 * minute), user: { id: "user-a", email: "m@test", name: "Marina" },
  teamFunctions: [{ functionKey: "CHATTER" }],
};
const pending = [
  {
    id: "pending-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", fanId: "fan-1", status: "PENDING",
    firstIncomingAt: new Date(now - 20 * minute), lastIncomingAt: new Date(now - 19 * minute), incomingCount: 3,
    ownerMemberId: "member-a", derivationVersion: "team_pending_v1",
  },
  {
    id: "pending-2", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-2", fanId: "fan-2", status: "PENDING",
    firstIncomingAt: new Date(now - 70 * minute), lastIncomingAt: new Date(now - 70 * minute), incomingCount: 1,
    ownerMemberId: null, derivationVersion: "team_pending_v1",
  },
];
const sessions = [{
  id: "dialog-1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "fan-x", fanId: "fan-x",
  startedAt: new Date(now - 5 * minute), activeSeconds: 120, wallSeconds: 300,
}];
const activity = [{
  id: "event-1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", accountId: "creator-1", dialogId: "fan-x", fanId: "fan-x",
  messageId: "reply-1", eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED", source: "electron_team_v13",
  ts: new Date(now - 4 * minute), extra: { telemetryVersion: "team_v13_provenance" },
}];

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = {
  id: prismaPath, filename: prismaPath, loaded: true,
  exports: {
    agencyMember: listModel([member]),
    teamActivityEvent: listModel(activity),
    teamPpvPurchaseLedger: listModel([]),
    teamResponseCase: listModel([]),
    teamDialogSession: listModel(sessions),
    teamPendingDialogState: listModel(pending),
    teamProjectionCoverage: {
      async findUnique() {
        return { agencyId: "agency-1", responseCoverageFrom: new Date(now - 24 * 60 * minute), dialogCoverageFrom: new Date(now - 24 * 60 * minute) };
      },
    },
  },
};
const analytics = require("./team-analytics-service");

test("member unanswered counts only trusted-owned pending dialogs while overview keeps unassigned queue visible", async () => {
  const members = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  assert.equal(members.projection.unansweredSource, "team_pending_dialog_v1");
  assert.equal(members.pendingSummary.pendingDialogs, 2);
  assert.equal(members.pendingSummary.pendingIncomingMessages, 4);
  assert.equal(members.pendingSummary.unassignedDialogs, 1);
  assert.equal(members.members[0].metrics.unansweredIncomingCount, 1);
  assert.equal(members.members[0].metrics.unansweredIncomingMessages, 3);
  assert.equal(members.members[0].metrics.unansweredOlderThan15m, 1);

  const overview = await analytics.buildTeamOverview({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  assert.equal(overview.overview.unansweredIncomingCount, 2, "team queue includes the unassigned fan dialog");
  assert.equal(overview.overview.unansweredIncomingMessages, 4);
  assert.equal(overview.overview.unassignedUnansweredCount, 1);
  assert.equal(overview.overview.unansweredOlderThan15m, 2);
  assert.equal(overview.overview.unansweredOlderThan60m, 1);
  assert.equal(overview.overview.dialogDwellSeconds, 120, "overview dwell must stay numeric, never undefined/NaN");
  assert.equal(overview.overview.dialogSessionsCount, 1);
});
