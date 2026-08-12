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

function makeDb({ ledgers = [], events = [], coverages = [] } = {}) {
  const responseCases = [];
  const dialogSessions = [];
  const coverageRows = coverages.map((row, index) => ({ id: row.id || `coverage-${index + 1}`, ...row }));

  function ledgerMatches(row, where) {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && row.creatorId !== where.creatorId) return false;
    if (where.dialogId && row.dialogId !== where.dialogId) return false;
    if (where.memberId && row.memberId !== where.memberId) return false;
    if (where.messageId && row.messageId !== where.messageId) return false;
    if (where.source?.in && !where.source.in.includes(row.source)) return false;
    if (where.sentAt && !matchesDate(row.sentAt, where.sentAt)) return false;
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

  function coverageMatches(row, where) {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && row.creatorId !== where.creatorId) return false;
    if (typeof where.memberId === "string" && row.memberId !== where.memberId) return false;
    if (where.memberId?.not && row.memberId === where.memberId.not) return false;
    if (where.startedAt && !matchesDate(row.startedAt, where.startedAt)) return false;
    if (Array.isArray(where.OR)) {
      const ok = where.OR.some((branch) => {
        if (Object.prototype.hasOwnProperty.call(branch, "endedAt") && branch.endedAt === null) return row.endedAt == null;
        if (branch.endedAt) return row.endedAt != null && matchesDate(row.endedAt, branch.endedAt);
        return false;
      });
      if (!ok) return false;
    }
    return true;
  }

  const db = {
    teamSentMessageLedger: {
      async findFirst({ where, orderBy }) {
        const rows = ledgers.filter((row) => ledgerMatches(row, where));
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
        if (orderBy?.sentAt === "desc") rows.reverse();
        return rows[0] || null;
      },
      async findMany({ where, orderBy, take }) {
        const rows = ledgers.filter((row) => ledgerMatches(row, where));
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
        if (orderBy?.sentAt === "desc") rows.reverse();
        return rows.slice(0, take || rows.length);
      },
    },
    teamActivityEvent: {
      async findMany({ where, orderBy }) {
        const rows = events.filter((row) => eventMatches(row, where));
        rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
        if (orderBy?.ts === "desc") rows.reverse();
        return rows;
      },
      async findFirst({ where, orderBy }) {
        const rows = events.filter((row) => eventMatches(row, where));
        rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
        if (orderBy?.ts === "desc") rows.reverse();
        return rows[0] || null;
      },
    },
    teamCoverageSession: {
      async findFirst({ where, orderBy }) {
        const rows = coverageRows.filter((row) => coverageMatches(row, where));
        rows.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
        if (orderBy?.startedAt === "desc") rows.reverse();
        return rows[0] || null;
      },
      async findUnique({ where }) {
        const key = where.agencyId_coverageId;
        return coverageRows.find((row) => row.agencyId === key.agencyId && row.coverageId === key.coverageId) || null;
      },
      async create({ data }) {
        const row = { id: `coverage-${coverageRows.length + 1}`, ...data };
        coverageRows.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = coverageRows.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    teamResponseCase: {
      async upsert({ where, create, update }) {
        const key = where.agencyId_replyMessageId;
        let row = responseCases.find((item) => item.agencyId === key.agencyId && item.replyMessageId === key.replyMessageId);
        if (!row) {
          row = { id: `response-${responseCases.length + 1}`, ...create };
          responseCases.push(row);
        } else Object.assign(row, update);
        return row;
      },
      async deleteMany({ where }) {
        const before = responseCases.length;
        for (let i = responseCases.length - 1; i >= 0; i -= 1) {
          if (responseCases[i].agencyId === where.agencyId && responseCases[i].replyMessageId === where.replyMessageId) responseCases.splice(i, 1);
        }
        return { count: before - responseCases.length };
      },
    },
    teamDialogSession: {
      async upsert({ where, create, update }) {
        const key = where.agencyId_sessionId;
        let row = dialogSessions.find((item) => item.agencyId === key.agencyId && item.sessionId === key.sessionId);
        if (!row) {
          row = { id: `dialog-${dialogSessions.length + 1}`, ...create };
          dialogSessions.push(row);
        } else Object.assign(row, update);
        return row;
      },
    },
  };
  return { db, responseCases, dialogSessions, coverageRows };
}

function reply(overrides = {}) {
  return {
    agencyId: "agency-1",
    creatorId: "creator-1",
    memberId: "member-a",
    dialogId: "fan-1",
    fanId: "fan-1",
    messageId: "reply-1",
    sentAt: date("2026-08-12T09:02:00.000Z"),
    source: "manual",
    ...overrides,
  };
}

function incoming(at = "2026-08-12T09:00:00.000Z", overrides = {}) {
  return {
    agencyId: "agency-1",
    creatorId: "creator-1",
    memberId: null,
    dialogId: "fan-1",
    fanId: "fan-1",
    messageId: "incoming-1",
    eventKind: "FAN_MESSAGE_RECEIVED",
    ts: date(at),
    ...overrides,
  };
}

test("fresh response is SLA-eligible only when responder coverage already existed at incoming", async () => {
  const r = reply();
  const { db, responseCases } = makeDb({
    ledgers: [r],
    events: [incoming(), {
      agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", dialogId: "fan-1",
      eventKind: "DIALOG_SEEN", ts: date("2026-08-12T09:00:30.000Z"),
    }],
    coverages: [{
      agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a",
      startedAt: date("2026-08-12T08:55:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z"),
    }],
  });

  const result = await service.deriveResponseCaseForReply(r, db);
  assert.equal(responseCases.length, 1);
  assert.equal(result.classification, "FRESH");
  assert.equal(result.wallClockSeconds, 120);
  assert.equal(result.coverageResponseSeconds, 120);
  assert.equal(result.seenResponseSeconds, 90);
  assert.equal(result.slaEligible, true);
  assert.equal(result.sla5Pass, true);
  assert.equal(result.sla15Pass, true);
});

test("overnight incoming becomes backlog and starts effective coverage clock only when responder begins coverage", async () => {
  const r = reply({ sentAt: date("2026-08-12T09:02:00.000Z") });
  const { db } = makeDb({
    ledgers: [r],
    events: [incoming("2026-08-12T03:00:00.000Z"), {
      agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", dialogId: "fan-1",
      eventKind: "DIALOG_SEEN", ts: date("2026-08-12T09:01:00.000Z"),
    }],
    coverages: [{
      agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a",
      startedAt: date("2026-08-12T09:00:00.000Z"), endedAt: date("2026-08-12T12:00:00.000Z"),
    }],
  });

  const result = await service.deriveResponseCaseForReply(r, db);
  assert.equal(result.classification, "BACKLOG");
  assert.equal(result.wallClockSeconds, 6 * 60 * 60 + 2 * 60);
  assert.equal(result.coverageResponseSeconds, 120);
  assert.equal(result.seenResponseSeconds, 60);
  assert.equal(result.slaEligible, false);
  assert.equal(result.sla5Pass, null);
  assert.equal(result.sla15Pass, null);
});

test("another member covering creator at incoming produces explicit HANDOFF evidence", async () => {
  const r = reply();
  const { db } = makeDb({
    ledgers: [r],
    events: [incoming()],
    coverages: [
      { agencyId: "agency-1", creatorId: "creator-1", memberId: "member-b", coverageId: "cov-b", startedAt: date("2026-08-12T08:50:00.000Z"), endedAt: date("2026-08-12T09:01:00.000Z") },
      { agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a", startedAt: date("2026-08-12T09:01:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") },
    ],
  });
  const result = await service.deriveResponseCaseForReply(r, db);
  assert.equal(result.classification, "HANDOFF");
  assert.equal(result.handoffFromMemberId, "member-b");
  assert.equal(result.coverageResponseSeconds, 60);
  assert.equal(result.slaEligible, false);
});

test("multiple fan messages after previous manual reply form one response episode", async () => {
  const previous = reply({ messageId: "reply-prev", sentAt: date("2026-08-12T08:59:00.000Z") });
  const current = reply();
  const { db } = makeDb({
    ledgers: [previous, current],
    events: [
      incoming("2026-08-12T09:00:00.000Z", { messageId: "incoming-1" }),
      incoming("2026-08-12T09:00:20.000Z", { messageId: "incoming-2" }),
      incoming("2026-08-12T09:01:00.000Z", { messageId: "incoming-3" }),
    ],
    coverages: [{ agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a", startedAt: date("2026-08-12T08:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") }],
  });
  const result = await service.deriveResponseCaseForReply(current, db);
  assert.equal(result.incomingCount, 3);
  assert.equal(result.firstIncomingMessageId, "incoming-1");
  assert.equal(result.lastIncomingAt.toISOString(), "2026-08-12T09:01:00.000Z");
});

test("dialog projection stores active dwell separately from wall-clock dwell", async () => {
  const { db, dialogSessions } = makeDb();
  await service.upsertDialogSession({
    agencyId: "agency-1",
    creatorId: "creator-1",
    memberId: "member-a",
    userId: "user-a",
    deviceId: "device-a",
    eventKind: "DIALOG_SESSION",
    dialogId: "fan-1",
    fanId: "fan-1",
    correlationId: "session-1",
    coverageId: "cov-a",
    startedAt: date("2026-08-12T09:00:00.000Z"),
    endedAt: date("2026-08-12T09:10:00.000Z"),
    durationSeconds: 180,
    ts: date("2026-08-12T09:10:00.000Z"),
    extra: { metadata: { wallSeconds: 600, activeSeconds: 180, activityEvents: 8, seenAt: "2026-08-12T09:00:20.000Z", endReason: "dialog_switched" } },
  }, db);
  assert.equal(dialogSessions.length, 1);
  assert.equal(dialogSessions[0].wallSeconds, 600);
  assert.equal(dialogSessions[0].activeSeconds, 180);
  assert.equal(dialogSessions[0].activityEvents, 8);
  assert.equal(dialogSessions[0].endReason, "dialog_switched");
});


test("stale orphan open coverage cannot make a later reply fresh or handoff forever", async () => {
  const r = reply({ sentAt: date("2026-08-12T09:02:00.000Z") });
  const { db } = makeDb({
    ledgers: [r],
    events: [incoming("2026-08-12T09:00:00.000Z")],
    coverages: [{
      agencyId: "agency-1", creatorId: "creator-1", memberId: "member-b", coverageId: "stale-open",
      startedAt: date("2026-08-11T18:00:00.000Z"), endedAt: null,
    }],
  });

  const result = await service.deriveResponseCaseForReply(r, db);
  assert.equal(result.classification, "UNKNOWN");
  assert.equal(result.handoffFromMemberId, null);
  assert.equal(result.coverageResponseSeconds, null);
  assert.equal(result.slaEligible, false);
});
