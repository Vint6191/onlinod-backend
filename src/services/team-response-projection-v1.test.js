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
    if (where.accountId && row.accountId !== where.accountId) return false;
    if (where.dialogId && row.dialogId !== where.dialogId) return false;
    if (where.memberId && row.memberId !== where.memberId) return false;
    if (where.messageId && row.messageId !== where.messageId) return false;
    if (Object.prototype.hasOwnProperty.call(where, "telemetryEventId")) {
      if (where.telemetryEventId === null && row.telemetryEventId != null) return false;
      if (where.telemetryEventId && typeof where.telemetryEventId === "object") {
        const id = String(row.telemetryEventId || "");
        if (where.telemetryEventId.gt && !(id > String(where.telemetryEventId.gt))) return false;
        if (where.telemetryEventId.lt && !(id < String(where.telemetryEventId.lt))) return false;
      }
    }
    if (where.id) {
      const id = String(row.id || row.messageId || "");
      if (where.id.gt && !(id > String(where.id.gt))) return false;
      if (where.id.gte && !(id >= String(where.id.gte))) return false;
      if (where.id.lt && !(id < String(where.id.lt))) return false;
      if (where.id.lte && !(id <= String(where.id.lte))) return false;
    }
    if (where.source?.in && !where.source.in.includes(row.source)) return false;
    if (where.sentAt instanceof Date) {
      if (new Date(row.sentAt).getTime() !== where.sentAt.getTime()) return false;
    } else if (where.sentAt && !matchesDate(row.sentAt, where.sentAt)) return false;
    if (where.NOT?.messageId && row.messageId === where.NOT.messageId) return false;
    if (Array.isArray(where.OR) && !where.OR.some((branch) => ledgerMatches(row, branch))) return false;
    return true;
  }

  function eventMatches(row, where = {}) {
    for (const key of ["agencyId", "creatorId", "dialogId", "memberId", "eventKind"]) {
      if (where[key] !== undefined && row[key] !== where[key]) return false;
    }
    if (where.id && typeof where.id === "object") {
      const id = String(row.id || "");
      if (where.id.gt && !(id > String(where.id.gt))) return false;
      if (where.id.lt && !(id < String(where.id.lt))) return false;
    }
    if (where.ts instanceof Date) {
      if (new Date(row.ts).getTime() !== where.ts.getTime()) return false;
    } else if (where.ts && !matchesDate(row.ts, where.ts)) return false;
    if (Array.isArray(where.OR) && !where.OR.some((branch) => eventMatches(row, branch))) return false;
    if (Array.isArray(where.AND) && !where.AND.every((branch) => eventMatches(row, branch))) return false;
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
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt) || String(a.id || a.messageId).localeCompare(String(b.id || b.messageId)));
        const direction = Array.isArray(orderBy) ? orderBy[0]?.sentAt : orderBy?.sentAt;
        if (direction === "desc") rows.reverse();
        return rows[0] || null;
      },
      async findMany({ where, orderBy, take }) {
        const rows = ledgers.filter((row) => ledgerMatches(row, where));
        rows.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt) || String(a.id || a.messageId).localeCompare(String(b.id || b.messageId)));
        const direction = Array.isArray(orderBy) ? orderBy[0]?.sentAt : orderBy?.sentAt;
        if (direction === "desc") rows.reverse();
        return rows.slice(0, take || rows.length);
      },
    },
    teamActivityEvent: {
      async findMany({ where, orderBy, take }) {
        const rows = events.filter((row) => eventMatches(row, where));
        rows.sort((a, b) => new Date(a.ts) - new Date(b.ts) || String(a.id || "").localeCompare(String(b.id || "")));
        if (orderBy?.ts === "desc" || (Array.isArray(orderBy) && orderBy[0]?.ts === "desc")) rows.reverse();
        return rows.slice(0, take || rows.length);
      },
      async findFirst({ where, orderBy }) {
        const rows = events.filter((row) => eventMatches(row, where));
        rows.sort((a, b) => new Date(a.ts) - new Date(b.ts) || String(a.id || "").localeCompare(String(b.id || "")));
        if (orderBy?.ts === "desc" || (Array.isArray(orderBy) && orderBy[0]?.ts === "desc")) rows.reverse();
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
      async findMany({ where = {}, orderBy, take }) {
        let rows = responseCases.filter((item) => {
          if (where.agencyId && item.agencyId !== where.agencyId) return false;
          if (where.projectionState && item.projectionState !== where.projectionState) return false;
          if (where.id?.gt && !(String(item.id) > String(where.id.gt))) return false;
          return true;
        });
        rows = rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (orderBy?.id === "desc") rows.reverse();
        return rows.slice(0, take || rows.length);
      },
      async findUnique({ where }) {
        const key = where.agencyId_creatorId_replyMessageId;
        if (!key) return null;
        return responseCases.find((item) => item.agencyId === key.agencyId && item.creatorId === key.creatorId && item.replyMessageId === key.replyMessageId) || null;
      },
      async update({ where, data }) {
        const row = responseCases.find((item) => item.id === where.id);
        if (!row) throw new Error(`missing response case ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      async upsert({ where, create, update }) {
        const key = where.agencyId_creatorId_replyMessageId;
        let row = responseCases.find((item) => item.agencyId === key.agencyId && item.creatorId === key.creatorId && item.replyMessageId === key.replyMessageId);
        if (!row) {
          row = { id: `response-${responseCases.length + 1}`, ...create };
          responseCases.push(row);
        } else Object.assign(row, update);
        return row;
      },
      async deleteMany({ where }) {
        const before = responseCases.length;
        for (let i = responseCases.length - 1; i >= 0; i -= 1) {
          const row = responseCases[i];
          if (row.agencyId === where.agencyId && (!where.creatorId || row.creatorId === where.creatorId) && row.replyMessageId === where.replyMessageId) responseCases.splice(i, 1);
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
    id: "ledger-default",
    agencyId: "agency-1",
    creatorId: "creator-1",
    memberId: "member-a",
    dialogId: "fan-1",
    fanId: "fan-1",
    messageId: "reply-1",
    sentAt: date("2026-08-12T09:02:00.000Z"),
    source: "manual",
    telemetryEventId: "event-reply-default",
    ...overrides,
  };
}

function incoming(at = "2026-08-12T09:00:00.000Z", overrides = {}) {
  return {
    id: "event-incoming-default",
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

test("F54-03 incoming and manual reply at the same timestamp use one canonical telemetry-id order", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const r = reply({ id: "ledger-r", sentAt: date(at), telemetryEventId: "event-b" });
  const before = incoming(at, { id: "event-a", messageId: "incoming-before" });
  const after = incoming(at, { id: "event-z", messageId: "incoming-after" });

  for (const physicalOrder of [[before, after], [after, before]]) {
    const { db, responseCases } = makeDb({ ledgers: [r], events: physicalOrder });
    const result = await service.deriveResponseCaseForReply(r, db);
    assert.equal(result?.projectionState, "FULL");
    assert.equal(result?.incomingCount, 1);
    assert.equal(result?.firstIncomingMessageId, "incoming-before");
    assert.equal(responseCases.length, 1);
  }
});

test("F54-03 historical equal-time reply without telemetry identity is explicit INCOMPLETE_HISTORY", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const r = reply({ id: "legacy-ledger", sentAt: date(at), telemetryEventId: null });
  const { db } = makeDb({ ledgers: [r], events: [incoming(at, { id: "event-a", messageId: "incoming-ambiguous" })] });
  const result = await service.deriveResponseCaseForReply(r, db);
  assert.equal(result?.projectionState, "INCOMPLETE_HISTORY");
  assert.equal(result?.repairReason, "CROSS_FAMILY_ORDER_UNPROVEN");
  assert.equal(result?.slaEligible, false);
});

test("F54-03 mixed historical/modern same-time replies keep ledger order and do not skip an ambiguous previous boundary", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const previous = reply({ id: "ledger-a", messageId: "reply-prev", sentAt: date(at), telemetryEventId: null });
  const current = reply({ id: "ledger-z", messageId: "reply-current", sentAt: date(at), telemetryEventId: "event-z" });
  const event = incoming(at, { id: "event-m", messageId: "incoming-between" });
  const { db } = makeDb({ ledgers: [previous, current], events: [event] });
  const result = await service.deriveResponseCaseForReply(current, db);
  assert.equal(result?.projectionState, "INCOMPLETE_HISTORY");
  assert.equal(result?.repairReason, "CROSS_FAMILY_ORDER_UNPROVEN");
  assert.equal(result?.slaEligible, false);
});

test("INT5 F55-03 incomparable same-time historical/modern replies cannot both own a strictly earlier incoming episode", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const historical = reply({ id: "ledger-h", messageId: "reply-h", sentAt: date(at), telemetryEventId: null });
  const modern = reply({ id: "ledger-m", messageId: "reply-m", sentAt: date(at), telemetryEventId: "event-z" });
  const event = incoming("2026-08-12T08:59:59.000Z", { id: "event-in", messageId: "incoming-before-cluster" });

  for (const current of [modern, historical]) {
    const { db, responseCases } = makeDb({ ledgers: [historical, modern], events: [event] });
    const result = await service.deriveResponseCaseForReply(current, db);
    assert.equal(result?.projectionState, "INCOMPLETE_HISTORY");
    assert.equal(result?.repairReason, "CROSS_FAMILY_ORDER_UNPROVEN");
    assert.equal(responseCases.length, 2, "both competing same-time reply cases must be fenced incomplete");
    assert.deepEqual(new Set(responseCases.map((row) => row.projectionState)), new Set(["INCOMPLETE_HISTORY"]));
  }
});

test("INT5 F55-03 one historical reply makes the whole 3-way same-time reply cluster incomplete", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const modernA = reply({ id: "ledger-a", messageId: "reply-a", sentAt: date(at), telemetryEventId: "event-a" });
  const historical = reply({ id: "ledger-h", messageId: "reply-h", sentAt: date(at), telemetryEventId: null });
  const modernZ = reply({ id: "ledger-z", messageId: "reply-z", sentAt: date(at), telemetryEventId: "event-z" });
  const event = incoming("2026-08-12T08:59:59.000Z", { id: "event-in", messageId: "incoming-before-cluster" });
  const { db, responseCases } = makeDb({ ledgers: [modernZ, historical, modernA], events: [event] });
  const result = await service.deriveResponseCaseForReply(historical, db);
  assert.equal(result?.projectionState, "INCOMPLETE_HISTORY");
  assert.equal(responseCases.length, 3);
  assert.deepEqual(new Set(responseCases.map((row) => row.replyMessageId)), new Set(["reply-a", "reply-h", "reply-z"]));
  assert.ok(responseCases.every((row) => row.projectionState === "INCOMPLETE_HISTORY"));
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

test("same OF incoming observed by multiple devices counts once in a response episode", async () => {
  const current = reply();
  const { db } = makeDb({
    ledgers: [current],
    events: [
      incoming("2026-08-12T09:00:00.000Z", { id: "event-device-a", messageId: "incoming-shared", deviceId: "device-a" }),
      incoming("2026-08-12T09:00:01.000Z", { id: "event-device-b", messageId: "incoming-shared", deviceId: "device-b" }),
    ],
    coverages: [{ agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a", startedAt: date("2026-08-12T08:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") }],
  });
  const result = await service.deriveResponseCaseForReply(current, db);
  assert.equal(result.incomingCount, 1);
  assert.equal(result.firstIncomingMessageId, "incoming-shared");
});


test("late manual reply recomputes the already-materialized successor response case", async () => {
  const r1 = reply({ id: "ledger-r1", messageId: "reply-r1", sentAt: date("2026-08-12T09:10:00.000Z") });
  const r2 = reply({ id: "ledger-r2", messageId: "reply-r2", sentAt: date("2026-08-12T09:20:00.000Z") });
  const i1 = incoming("2026-08-12T09:01:00.000Z", { id: "incoming-1", messageId: "incoming-1" });
  const i2 = incoming("2026-08-12T09:15:00.000Z", { id: "incoming-2", messageId: "incoming-2" });
  const fx = makeDb({
    ledgers: [r1, r2],
    events: [i1, i2],
    coverages: [{ agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a", startedAt: date("2026-08-12T08:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") }],
  });

  // Simulate R2 having arrived/materialized before the late R1 event is applied.
  await service.deriveResponseCaseForReply(r2, fx.db);
  assert.equal(fx.responseCases.find((row) => row.replyMessageId === "reply-r2").incomingCount, 1, "current facts already include R1 as the previous boundary");

  // Recreate the stale pre-R1 materialization that production used to leave behind.
  const stale = fx.responseCases.find((row) => row.replyMessageId === "reply-r2");
  stale.incomingCount = 2;
  stale.firstIncomingMessageId = "incoming-1";
  stale.projectionRevision = 1n;

  await service.applyTeamResponseProjection({
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", memberId: "member-a",
    eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "MANUAL", lifecycle: "CONFIRMED",
    messageId: "reply-r1", ts: r1.sentAt,
  }, fx.db);

  const repaired = fx.responseCases.find((row) => row.replyMessageId === "reply-r2");
  assert.equal(repaired.incomingCount, 1);
  assert.equal(repaired.firstIncomingMessageId, "incoming-2");
  assert.ok(BigInt(repaired.projectionRevision) > 1n);
});

test("coverage changes invalidate response cases for other members in the affected creator interval", async () => {
  const r = reply({ id: "ledger-b", memberId: "member-b", messageId: "reply-b", sentAt: date("2026-08-12T09:20:00.000Z") });
  const fx = makeDb({ ledgers: [r], events: [incoming("2026-08-12T09:05:00.000Z")] });
  const before = await service.deriveResponseCaseForReply(r, fx.db);
  assert.equal(before.classification, "UNKNOWN");

  await service.applyTeamResponseProjection({
    agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", eventKind: "COVERAGE_ENDED",
    coverageId: "coverage-a", startedAt: date("2026-08-12T09:00:00.000Z"), endedAt: date("2026-08-12T09:10:00.000Z"),
    ts: date("2026-08-12T09:10:00.000Z"),
  }, fx.db);

  const after = fx.responseCases.find((row) => row.creatorId === "creator-1" && row.replyMessageId === "reply-b");
  assert.equal(after.classification, "HANDOFF");
  assert.equal(after.handoffFromMemberId, "member-a");
});

test("response identity isolates equal message ids across creator scopes", async () => {
  const ra = reply({ id: "ledger-a", creatorId: "creator-a", dialogId: "fan-a", fanId: "fan-a", messageId: "same-reply", sentAt: date("2026-08-12T09:10:00.000Z") });
  const rb = reply({ id: "ledger-b", creatorId: "creator-b", dialogId: "fan-b", fanId: "fan-b", messageId: "same-reply", sentAt: date("2026-08-12T09:11:00.000Z") });
  const fx = makeDb({
    ledgers: [ra, rb],
    events: [
      incoming("2026-08-12T09:00:00.000Z", { creatorId: "creator-a", dialogId: "fan-a", fanId: "fan-a", messageId: "incoming-a" }),
      incoming("2026-08-12T09:01:00.000Z", { creatorId: "creator-b", dialogId: "fan-b", fanId: "fan-b", messageId: "incoming-b" }),
    ],
    coverages: [
      { agencyId: "agency-1", creatorId: "creator-a", memberId: "member-a", coverageId: "cov-a", startedAt: date("2026-08-12T08:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") },
      { agencyId: "agency-1", creatorId: "creator-b", memberId: "member-a", coverageId: "cov-b", startedAt: date("2026-08-12T08:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") },
    ],
  });
  await service.deriveResponseCaseForReply(ra, fx.db);
  await service.deriveResponseCaseForReply(rb, fx.db);
  assert.equal(fx.responseCases.length, 2);
  assert.deepEqual(new Set(fx.responseCases.map((row) => row.creatorId)), new Set(["creator-a", "creator-b"]));
});


test("bounded response v1 to v2 repair preserves old case as INCOMPLETE_HISTORY when reply evidence is gone", async () => {
  const fx = makeDb();
  fx.responseCases.push({
    id: "response-old-1", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a",
    dialogId: "fan-1", replyMessageId: "old-reply", incomingAt: date("2026-01-01T00:00:00.000Z"),
    lastIncomingAt: date("2026-01-01T00:00:00.000Z"), replyAt: date("2026-01-01T00:01:00.000Z"),
    incomingCount: 1, classification: "FRESH", derivationVersion: "team_response_v1",
    projectionRevision: 4n, projectionState: "NEEDS_REPAIR", repairReason: "LEGACY_V1_REPAIR_REQUIRED",
  });

  const result = await service.backfillTeamResponseRangeBatch({ db: fx.db, agencyId: "agency-1", limit: 100 });
  assert.equal(result.selected, 1);
  assert.equal(result.repaired, 0);
  assert.equal(result.unresolved, 1);
  assert.equal(result.complete, true);
  assert.equal(fx.responseCases.length, 1, "missing old raw evidence must not delete the historical case");
  assert.equal(fx.responseCases[0].derivationVersion, "team_response_v2");
  assert.equal(fx.responseCases[0].projectionState, "INCOMPLETE_HISTORY");
  assert.equal(fx.responseCases[0].repairReason, "REPLY_LEDGER_EVIDENCE_MISSING");
  assert.equal(fx.responseCases[0].classification, "FRESH", "known historical result is preserved rather than invented");
});

test("bounded response range repair derives FULL v2 when exact reply and incoming evidence remain", async () => {
  const r = reply({ id: "ledger-old", messageId: "old-reply" });
  const fx = makeDb({
    ledgers: [r],
    events: [incoming("2026-08-12T09:00:00.000Z", { messageId: "old-incoming" })],
    coverages: [{ agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", coverageId: "cov-a", startedAt: date("2026-08-12T08:00:00.000Z"), endedAt: date("2026-08-12T10:00:00.000Z") }],
  });
  fx.responseCases.push({
    id: "response-old-2", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", dialogId: "fan-1",
    replyMessageId: "old-reply", incomingAt: date("2026-08-12T09:00:00.000Z"), lastIncomingAt: date("2026-08-12T09:00:00.000Z"),
    replyAt: r.sentAt, incomingCount: 99, classification: "UNKNOWN", derivationVersion: "team_response_v1",
    projectionRevision: 2n, projectionState: "NEEDS_REPAIR", repairReason: "LEGACY_V1_REPAIR_REQUIRED",
  });

  const result = await service.backfillTeamResponseRangeBatch({ db: fx.db, agencyId: "agency-1", limit: 100 });
  assert.equal(result.repaired, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(fx.responseCases[0].projectionState, "FULL");
  assert.equal(fx.responseCases[0].repairReason, null);
  assert.equal(fx.responseCases[0].incomingCount, 1);
  assert.equal(fx.responseCases[0].classification, "FRESH");
});


test("F55-03 modern reply family uses telemetry identity, not ledger identity, for same-time chronology", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const earlierByTelemetry = reply({ id: "ledger-z", messageId: "reply-r2", sentAt: date(at), telemetryEventId: "event-a" });
  const laterByTelemetry = reply({ id: "ledger-a", messageId: "reply-r1", sentAt: date(at), telemetryEventId: "event-z" });
  const event = incoming(at, { id: "event-m", messageId: "incoming-middle" });

  for (const ledgers of [[laterByTelemetry, earlierByTelemetry], [earlierByTelemetry, laterByTelemetry]]) {
    const fx = makeDb({ ledgers, events: [event] });
    const result = await service.deriveResponseCaseForReply(laterByTelemetry, fx.db);
    assert.equal(result?.projectionState, "FULL");
    assert.equal(result?.incomingCount, 1);
    assert.equal(result?.firstIncomingMessageId, "incoming-middle");
  }
});

test("F55-03 same-time DIALOG_SEEN before incoming by event id is not response seen evidence", async () => {
  const at = "2026-08-12T09:00:00.000Z";
  const r = reply({ id: "ledger-r", sentAt: date("2026-08-12T09:01:00.000Z"), telemetryEventId: "event-z" });
  const fx = makeDb({
    ledgers: [r],
    events: [
      incoming(at, { id: "event-m", messageId: "incoming-m" }),
      { id: "event-a", agencyId: "agency-1", creatorId: "creator-1", memberId: "member-a", dialogId: "fan-1", eventKind: "DIALOG_SEEN", ts: date(at) },
    ],
  });
  const result = await service.deriveResponseCaseForReply(r, fx.db);
  assert.equal(result?.classification, "UNKNOWN");
  assert.equal(result?.seenResponseSeconds, null);
});
