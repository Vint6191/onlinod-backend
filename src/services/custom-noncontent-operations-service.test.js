"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listCustomNonContentOperations } = require("./custom-noncontent-operations-service");
const { serializeOrder, buildUpdateData } = require("./custom-orders-service");

const member = { id: "manager-1", userId: "user-1", agencyId: "agency-1", role: "MANAGER", roleKey: "manager", assignedCreators: "all", permissions: { "team.analytics.view": true } };
const creator = { id: "creator-1", displayName: "Model A", username: "modela", avatarUrl: null };
const base = { agencyId: "agency-1", creatorId: "creator-1", dialogId: "42", status: "PENDING", priceCents: 6000, paidAmountCents: 2000, telegramTaskMessageId: 100, createdAt: new Date("2026-08-22T08:00:00.000Z"), updatedAt: new Date("2026-08-22T08:00:00.000Z"), creator };

function db() {
  const calls = [
    { ...base, id: "call-overdue", scenario: "Old call", type: "CALL", scheduledAt: new Date("2026-08-22T09:00:00.000Z"), durationMinutes: 30 },
    { ...base, id: "call-due", scenario: "Live call", type: "CALL", scheduledAt: new Date("2026-08-22T10:45:00.000Z"), durationMinutes: 30 },
    { ...base, id: "call-upcoming", scenario: "Next call", type: "CALL", scheduledAt: new Date("2026-08-22T12:00:00.000Z"), durationMinutes: 45 },
  ];
  const physical = [
    { ...base, id: "physical-wait", scenario: "Panties", type: "PHYSICAL", physicalStatus: "WAITING", physicalStatusChangedAt: new Date("2026-08-20T11:00:00.000Z") },
    { ...base, id: "physical-ready", scenario: "Package", type: "PHYSICAL", physicalStatus: "READY", physicalStatusChangedAt: new Date("2026-08-22T10:00:00.000Z") },
  ];
  return {
    customOrder: {
      async findMany({ where }) {
        if (where.type === "CALL") {
          if (where.scheduledAt?.gt) return calls.filter((row) => row.scheduledAt > where.scheduledAt.gt && row.scheduledAt <= where.scheduledAt.lte);
          if (where.scheduledAt?.lte) return calls.filter((row) => row.scheduledAt <= where.scheduledAt.lte);
        }
        if (where.type === "PHYSICAL") return physical;
        return [];
      },
      async count({ where }) {
        if (where.type === "CALL") {
          if (where.scheduledAt?.gt) return calls.filter((row) => row.scheduledAt > where.scheduledAt.gt && row.scheduledAt <= where.scheduledAt.lte).length;
          if (where.scheduledAt?.lte) return calls.filter((row) => row.scheduledAt <= where.scheduledAt.lte).length;
        }
        if (where.type === "PHYSICAL") return physical.filter((row) => row.physicalStatus === where.physicalStatus).length;
        return 0;
      },
    },
  };
}

test("CALL operations distinguish upcoming, due and overdue using duration", async () => {
  const result = await listCustomNonContentOperations({ agencyId: "agency-1", member, now: new Date("2026-08-22T11:00:00.000Z"), db: db() });
  assert.deepEqual(result.callSummary, { upcoming: 1, due: 1, overdue: 1, horizonHours: 24 });
  assert.deepEqual(result.calls.map((item) => item.phase), ["OVERDUE", "DUE", "UPCOMING"]);
  assert.equal(result.calls[1].callEndAt, "2026-08-22T11:15:00.000Z");
  assert.equal(result.calls[2].remainingAmountCents, 4000);
});

test("PHYSICAL operations expose exact stage age and stage counts", async () => {
  const result = await listCustomNonContentOperations({ agencyId: "agency-1", member, now: new Date("2026-08-22T11:00:00.000Z"), db: db() });
  assert.deepEqual(result.physicalSummary, { waiting: 1, ready: 1, shipped: 0 });
  assert.equal(result.physical[0].physicalStatus, "WAITING");
  assert.equal(result.physical[0].stageAgeSeconds, 48 * 3600);
});

test("CustomOrder CALL serialization does not mark an in-progress call overdue", () => {
  const row = { ...base, id: "call", scenario: "Call", type: "CALL", contentKind: null, dueAt: null, scheduledAt: new Date("2026-08-22T10:45:00.000Z"), durationMinutes: 30, physicalStatus: null, physicalStatusChangedAt: null, acceptedAt: null, completedAt: null, deliveredAt: null, fanDeliveredAt: null, deliverySentMediaIds: [], deliveryMessageIds: [], deliveryOfferedCents: 0, cancelledAt: null, cancelReason: null, mediaIds: "", telegramReferenceMessageIds: [], telegramLastModelMessageId: null, telegramLastModelMessageAt: null, reminderConfig: null, nextReminderAt: null, lastReminderAt: null, createdByMember: null };
  const item = serializeOrder(row, new Date("2026-08-22T11:00:00.000Z"));
  assert.equal(item.callPhase, "DUE");
  assert.equal(item.isOverdue, false);
  assert.equal(item.isDueSoon, true);
});

test("PHYSICAL stage changes receive their own timestamp without relying on updatedAt", () => {
  const current = { ...base, id: "physical", scenario: "Sale", type: "PHYSICAL", contentKind: null, dueAt: null, scheduledAt: null, durationMinutes: null, physicalStatus: "WAITING", physicalStatusChangedAt: new Date("2026-08-20T00:00:00.000Z"), reminderConfig: null, status: "PENDING", acceptedAt: null, cancelReason: null, mediaIds: "" };
  const now = new Date("2026-08-22T11:00:00.000Z");
  const patch = buildUpdateData(current, { physicalStatus: "READY" }, now);
  assert.equal(patch.physicalStatus, "READY");
  assert.equal(patch.physicalStatusChangedAt.toISOString(), now.toISOString());
  const paymentOnly = buildUpdateData(current, { paidAmountCents: 1000 }, now);
  assert.equal(paymentOnly.physicalStatusChangedAt, undefined);
});


test("V20.10 schema stores one dedicated PHYSICAL stage timestamp and migration backfills it conservatively", () => {
  const root = path.resolve(__dirname, "..", "..");
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260822143000_custom_noncontent_operations", "migration.sql"), "utf8");
  assert.match(schema, /physicalStatusChangedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[agencyId, type, status, physicalStatusChangedAt\]\)/);
  assert.match(migration, /ADD COLUMN "physicalStatusChangedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /COALESCE\("updatedAt", "createdAt"\)/);
  assert.doesNotMatch(schema, /callPhase\s+|physicalStageAge|callOverdueAt/);
});

test("production CALL summary stays exact without loading an unbounded 24h history", async () => {
  const client = db();
  const takes = [];
  const originalFindMany = client.customOrder.findMany;
  client.customOrder.findMany = async (args) => {
    if (args?.where?.type === "CALL") takes.push(args.take ?? null);
    return originalFindMany(args);
  };
  client.$queryRawUnsafe = async (sql, ...params) => {
    assert.match(String(sql), /durationMinutes/);
    assert.match(String(sql), /INTERVAL '1 minute'/);
    assert.equal(params[0], "agency-1");
    return [{ upcoming: 321, due: 12, overdue: 44 }];
  };
  const result = await listCustomNonContentOperations({ agencyId: "agency-1", member, limit: 100, now: new Date("2026-08-22T11:00:00.000Z"), db: client });
  assert.deepEqual(result.callSummary, { upcoming: 321, due: 12, overdue: 44, horizonHours: 24 });
  assert.ok(takes.every((value) => Number.isInteger(value) && value <= 400), `CALL detail reads must stay bounded: ${JSON.stringify(takes)}`);
});


test("A48 production CALL top-N uses one exact mixed-duration rank before LIMIT", async () => {
  const client = db();
  const now = new Date("2026-08-22T11:00:00.000Z");
  const exactRows = [
    { ...base, id: "late-short-overdue", scenario: "Short call", type: "CALL", scheduledAt: new Date("2026-08-22T10:40:00.000Z"), durationMinutes: 5 },
    { ...base, id: "early-long-due", scenario: "Long call", type: "CALL", scheduledAt: new Date("2026-08-22T10:00:00.000Z"), durationMinutes: 120 },
  ];
  const rawSql = [];
  client.$queryRawUnsafe = async (sql, ...params) => {
    const text = String(sql);
    rawSql.push(text);
    if (/COUNT\(\*\) FILTER/.test(text)) return [{ upcoming: 0, due: 1, overdue: 1 }];
    assert.match(text, /WITH overdue AS/);
    assert.match(text, /GREATEST\(1, LEAST\(1440, COALESCE\("durationMinutes", 1\)\)\)/);
    assert.ok(text.indexOf('ORDER BY "scheduledAt" +') < text.indexOf('LIMIT 2'), "overdue business rank must be applied before branch LIMIT");
    return [{ id: "late-short-overdue" }, { id: "early-long-due" }];
  };
  const originalFindMany = client.customOrder.findMany;
  client.customOrder.findMany = async (args) => {
    if (args?.where?.id?.in) {
      assert.deepEqual(args.where.id.in, ["late-short-overdue", "early-long-due"]);
      return [exactRows[1], exactRows[0]]; // DB delegate order is intentionally different.
    }
    if (args?.where?.type === "CALL") throw new Error("production CALL detail path must not use scheduledAt candidate pools");
    return originalFindMany(args);
  };

  const result = await listCustomNonContentOperations({ agencyId: "agency-1", member, limit: 2, now, db: client });
  assert.deepEqual(result.callSummary, { upcoming: 0, due: 1, overdue: 1, horizonHours: 24 });
  assert.deepEqual(result.calls.map((item) => [item.customOrderId, item.phase]), [
    ["late-short-overdue", "OVERDUE"],
    ["early-long-due", "DUE"],
  ]);
  assert.equal(rawSql.length, 2, "summary and exact top-N are separate bounded SQL reads");
});

test("A48 fresh-source migration indexes exact pending CALL end-rank", () => {
  const root = path.resolve(__dirname, "..", "..");
  const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260910144500_phase2_fresh_source_closure", "migration.sql"), "utf8");
  assert.match(migration, /CustomOrder_call_pending_end_rank_idx/);
  assert.match(migration, /GREATEST\(1, LEAST\(1440, COALESCE\("durationMinutes", 1\)\)\)/);
  assert.match(migration, /WHERE "type" = 'CALL'[\s\S]*"status" = 'PENDING'[\s\S]*"scheduledAt" IS NOT NULL/);
});
