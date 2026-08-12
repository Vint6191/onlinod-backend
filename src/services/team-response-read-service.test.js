"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const calls = [];
function model(name, rows) {
  return {
    async findMany(args) {
      calls.push({ name, args });
      return rows;
    },
  };
}

const member = { id: "member-a", displayName: "Marina", roleKey: "chatter", user: { name: "Marina" } };
const prismaMock = {
  teamResponseCase: model("response", [{
    id: "r1", creatorId: "creator-1", memberId: "member-a", member, dialogId: "fan-1", fanId: "fan-1",
    replyMessageId: "reply-1", firstIncomingMessageId: "incoming-1", incomingCount: 2,
    incomingAt: new Date("2026-08-12T09:00:00Z"), lastIncomingAt: new Date("2026-08-12T09:00:20Z"), replyAt: new Date("2026-08-12T09:02:00Z"),
    seenAt: new Date("2026-08-12T09:01:00Z"), coverageId: "cov-1", coverageStartedAt: new Date("2026-08-12T08:55:00Z"),
    handoffFromMemberId: null, classification: "FRESH", wallClockSeconds: 120, coverageResponseSeconds: 120, seenResponseSeconds: 60,
    slaEligible: true, sla5Pass: true, sla15Pass: true, derivationVersion: "team_response_v1",
  }]),
  teamDialogSession: model("dialog", [{
    id: "d1", creatorId: "creator-1", memberId: "member-a", member, dialogId: "fan-1", fanId: "fan-1", sessionId: "s1", coverageId: "cov-1",
    startedAt: new Date("2026-08-12T09:00:00Z"), endedAt: new Date("2026-08-12T09:10:00Z"), wallSeconds: 600, activeSeconds: 180,
    seenAt: new Date("2026-08-12T09:01:00Z"), activityEvents: 6, endReason: "dialog_switched", source: "team_v13",
  }]),
  teamCoverageSession: model("coverage", [{
    id: "c1", creatorId: "creator-1", memberId: "member-a", member, deviceId: "device-a", coverageId: "cov-1",
    startedAt: new Date("2026-08-12T08:55:00Z"), endedAt: new Date("2026-08-12T10:00:00Z"), durationSeconds: 3900,
    startReason: "browser_show", endReason: "browser_hide", source: "team_v13",
  }]),
};
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaMock };
const readService = require("./team-response-read-service");

test("response diagnostics expose derivation evidence but no message text", async () => {
  const payload = await readService.listTeamResponseCases({ agencyId: "agency-1", rangeKey: "7d", allowedCreatorIds: ["creator-1"], memberId: "member-a", classification: "fresh", limit: 20 });
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].classification, "FRESH");
  assert.equal(payload.rows[0].memberName, "Marina");
  assert.equal(payload.rows[0].wallClockSeconds, 120);
  assert.equal(payload.rows[0].seenResponseSeconds, 60);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.rows[0], "text"), false);
  const call = calls.find((item) => item.name === "response");
  assert.deepEqual(call.args.where.creatorId, { in: ["creator-1"] });
  assert.equal(call.args.where.classification, "FRESH");
  assert.equal(call.args.where.memberId, "member-a");
  assert.equal(call.args.take, 20);
});

test("dialog and coverage diagnostics keep active time separate from visibility coverage", async () => {
  const dialog = await readService.listTeamDialogSessions({ agencyId: "agency-1", allowedCreatorIds: ["creator-1"] });
  assert.equal(dialog.rows[0].wallSeconds, 600);
  assert.equal(dialog.rows[0].activeSeconds, 180);
  const coverage = await readService.listTeamCoverageSessions({ agencyId: "agency-1", allowedCreatorIds: ["creator-1"] });
  assert.equal(coverage.rows[0].durationSeconds, 3900);
  assert.equal(coverage.rows[0].coverageId, "cov-1");
});

test("empty diagnostic creator scope is fail-closed", async () => {
  calls.length = 0;
  await readService.listTeamResponseCases({ agencyId: "agency-1", allowedCreatorIds: [] });
  const call = calls.find((item) => item.name === "response");
  assert.deepEqual(call.args.where.creatorId, { in: ["__none__"] });
});
