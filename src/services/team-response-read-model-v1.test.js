"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function listModel(rows) {
  return {
    async findMany(args = {}) {
      const cursorId = args.cursor?.id || null;
      let start = 0;
      if (cursorId) {
        const idx = rows.findIndex((row) => row.id === cursorId);
        start = idx >= 0 ? idx + Number(args.skip || 0) : 0;
      }
      return rows.slice(start, start + Number(args.take || rows.length));
    },
  };
}

function makePrisma() {
  const member = {
    id: "member-a",
    agencyId: "agency-1",
    userId: "user-a",
    role: "OPERATOR",
    roleKey: "chatter",
    displayName: "Marina",
    assignedCreators: ["creator-1"],
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    user: { id: "user-a", email: "marina@example.test", name: "Marina" },
    teamFunctions: [{ functionKey: "CHATTER" }],
  };
  const activity = [{
    id: "event-1",
    agencyId: "agency-1",
    memberId: "member-a",
    creatorId: "creator-1",
    accountId: "creator-1",
    fanId: "fan-1",
    dialogId: "fan-1",
    messageId: "reply-1",
    eventKind: "MESSAGE_SEND_CONFIRMED",
    actionSource: "MANUAL",
    lifecycle: "CONFIRMED",
    source: "electron_team_v13",
    ts: new Date("2026-08-12T09:02:00.000Z"),
    extra: { telemetryVersion: "team_v13_provenance" },
  }];
  const responses = [
    {
      id: "response-1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "fan-1",
      replyMessageId: "reply-1", incomingCount: 1, classification: "FRESH", wallClockSeconds: 120,
      coverageResponseSeconds: 120, seenResponseSeconds: 90, slaEligible: true, sla5Pass: true, sla15Pass: true,
      replyAt: new Date("2026-08-12T09:02:00.000Z"),
    },
    {
      id: "response-2", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "fan-2",
      replyMessageId: "reply-2", incomingCount: 2, classification: "BACKLOG", wallClockSeconds: 6 * 60 * 60,
      coverageResponseSeconds: 120, seenResponseSeconds: 60, slaEligible: false, sla5Pass: null, sla15Pass: null,
      replyAt: new Date("2026-08-12T10:02:00.000Z"),
    },
  ];
  const sessions = [{
    id: "dialog-session-1", agencyId: "agency-1", memberId: "member-a", creatorId: "creator-1", dialogId: "fan-1", fanId: "fan-1",
    startedAt: new Date("2026-08-12T09:00:00.000Z"), activeSeconds: 180, wallSeconds: 600,
  }];
  return {
    agencyMember: listModel([member]),
    teamActivityEvent: listModel(activity),
    teamPpvPurchaseLedger: listModel([]),
    teamResponseCase: listModel(responses),
    teamDialogSession: listModel(sessions),
    teamProjectionCoverage: {
      async findUnique() {
        return {
          agencyId: "agency-1",
          responseCoverageFrom: new Date("2026-08-01T00:00:00.000Z"),
          dialogCoverageFrom: new Date("2026-08-01T00:00:00.000Z"),
        };
      },
    },
  };
}

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: makePrisma() };
const analytics = require("./team-analytics-service");

test("Team read model uses projected fresh/backlog response semantics and active dialog time", async () => {
  const payload = await analytics.buildTeamMembers({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  assert.equal(payload.members.length, 1);
  const m = payload.members[0].metrics;
  assert.equal(m.messagesSent, 1);
  assert.equal(m.incomingMessages, 3);
  assert.equal(m.freshReplies, 1);
  assert.equal(m.backlogReplies, 1);
  assert.equal(m.handoffReplies, 0);
  assert.equal(m.avgResponseSeconds, 120, "fresh SLA average must exclude backlog wall clock");
  assert.equal(m.medianResponseSeconds, 120);
  assert.equal(m.slaReply5mPct, 100);
  assert.equal(m.slaReply15mPct, 100);
  assert.equal(m.coverageResponseAvgSeconds, 120);
  assert.equal(m.seenResponseMedianSeconds, 75);
  assert.equal(m.dialogDwellSeconds, 180, "active dwell must use projected activeSeconds, not wallSeconds");
  assert.equal(m.revenueAttributedCents, null);
  assert.equal(m.dollarsPerMessageCents, null);
  assert.equal(payload.moneyVisible, false);
  assert.equal(payload.projection.responseSource, "team_response_case_v1");
  assert.equal(payload.projection.dialogSessionSource, "team_dialog_session_v1");
});

test("Team overview keeps fresh SLA weighted by response samples and redacts money independently", async () => {
  const payload = await analytics.buildTeamOverview({ agencyId: "agency-1", rangeKey: "7d", includeMoney: false });
  assert.equal(payload.overview.manualMessages, 1);
  assert.equal(payload.overview.avgResponseSeconds, 120);
  assert.equal(payload.overview.slaReply15mPct, 100);
  assert.equal(payload.overview.revenueAttributedCents, null);
  assert.equal(payload.overview.dollarsPerMessageCents, null);
  assert.equal(payload.moneyVisible, false);
});
