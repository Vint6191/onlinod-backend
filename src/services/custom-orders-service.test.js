"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildUpdateData,
  createCustomOrder,
  listCustomOrders,
  mediaIdsArray,
  normalizeCreateInput,
  serializeOrder,
  updateCustomOrder,
} = require("./custom-orders-service");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeDb(seed = {}) {
  const creators = seed.creators || [
    { id: "creator-1", agencyId: "agency-1", displayName: "Model A", username: "model_a", avatarUrl: null, deletedAt: null, status: "READY" },
    { id: "creator-2", agencyId: "agency-1", displayName: "Model B", username: "model_b", avatarUrl: null, deletedAt: null, status: "READY" },
  ];
  const members = {
    "member-1": { id: "member-1", displayName: "Chatter", roleKey: "chatter", user: { name: "Chatter", email: "c@test" } },
  };
  const rows = (seed.orders || []).map(clone);
  let seq = 0;

  const include = (row) => row ? {
    ...clone(row),
    creator: clone(creators.find((x) => x.id === row.creatorId) || null),
    createdByMember: clone(members[row.createdByMemberId] || null),
  } : null;

  function matches(row, where = {}) {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
    if (where.creatorId) {
      if (typeof where.creatorId === "string" && row.creatorId !== where.creatorId) return false;
      if (where.creatorId.in && !where.creatorId.in.includes(row.creatorId)) return false;
    }
    if (where.dialogId !== undefined && row.dialogId !== where.dialogId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.dueAt?.lt !== undefined) {
      const due = row.dueAt ? new Date(row.dueAt).getTime() : NaN;
      const before = new Date(where.dueAt.lt).getTime();
      if (!Number.isFinite(due) || !Number.isFinite(before) || due >= before) return false;
    }
    return true;
  }

  return {
    _rows: rows,
    creatorAccount: {
      async findFirst({ where }) {
        return clone(creators.find((row) => row.id === where.id && row.agencyId === where.agencyId && !row.deletedAt) || null);
      },
      async findMany({ where }) {
        return creators.filter((row) => row.agencyId === where.agencyId && !row.deletedAt && (!where.id?.in || where.id.in.includes(row.id))).map(clone);
      },
    },
    customOrder: {
      async create({ data }) {
        const now = new Date("2026-08-17T20:00:00.000Z");
        const row = { id: `order-${++seq}`, ...clone(data), createdAt: now, updatedAt: now, acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null };
        rows.push(row);
        return include(row);
      },
      async findFirst({ where }) { return include(rows.find((row) => matches(row, where)) || null); },
      async updateMany({ where, data }) {
        const row = rows.find((item) => matches(item, where)
          && (where.updatedAt === undefined || new Date(item.updatedAt).getTime() === new Date(where.updatedAt).getTime()));
        if (!row) return { count: 0 };
        Object.assign(row, clone(data), { updatedAt: new Date("2026-08-17T20:01:00.000Z") });
        return { count: 1 };
      },
      async findMany({ where, select, take = 10000, skip = 0 }) {
        const found = rows.filter((row) => matches(row, where)).slice(skip, skip + take);
        if (select) return found.map((row) => ({ status: row.status, dueAt: row.dueAt }));
        return found.map(include);
      },
      async count({ where }) { return rows.filter((row) => matches(row, where)).length; },
    },
    auditLog: { async create({ data }) { return { id: `audit-${seq}`, ...clone(data) }; } },
  };
}

const member = { id: "member-1", userId: "user-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"] };

test("media ids are stored as a stable de-duplicated space-separated list", () => {
  assert.deepEqual(mediaIdsArray("10 20,20;30"), ["10", "20", "30"]);
  assert.equal(normalizeCreateInput({ creatorId: "c", dialogId: "42", scenario: "hello", mediaIds: ["10", "20", "10"], price: 12.34 }).mediaIds, "10 20");
});

test("custom order create is creator-scoped and starts pending", async () => {
  const db = fakeDb();
  const result = await createCustomOrder({
    agencyId: "agency-1",
    member,
    input: { creatorId: "creator-1", dialogId: "422411209", scenario: "5 minute custom", dueAt: "2026-08-18T20:00:00Z", price: 150, mediaIds: ["11", "12"] },
    db,
  });
  assert.equal(result.ok, true);
  assert.equal(result.order.status, "PENDING");
  assert.equal(result.order.priceCents, 15000);
  assert.deepEqual(result.order.mediaIds, ["11", "12"]);
  assert.equal(result.order.createdBy.name, "Chatter");
  assert.equal("agencyId" in result.order, false);
  assert.equal("creatorId" in result.order, false);
  assert.equal("createdByMemberId" in result.order, false);
  await assert.rejects(() => createCustomOrder({ agencyId: "agency-1", member, input: { creatorId: "creator-2", dialogId: "1", scenario: "x" }, db }), /do not have access/i);
});

test("completed/cancelled transitions own their timestamps and cancellation requires reason", () => {
  const now = new Date("2026-08-17T21:00:00Z");
  const base = { status: "PENDING", completedAt: null, cancelledAt: null, cancelReason: null, priceCents: 0 };
  const completed = buildUpdateData(base, { status: "COMPLETED", completedAt: "2000-01-01T00:00:00Z", mediaIds: ["100", "101"] }, now);
  assert.equal(completed.completedAt.toISOString(), now.toISOString(), "client cannot forge completedAt");
  assert.equal(completed.cancelledAt, null);
  assert.equal(completed.mediaIds, "100 101");
  assert.throws(() => buildUpdateData(base, { status: "CANCELLED" }, now), /cancelReason is required/);
  const cancelled = buildUpdateData(base, { status: "CANCELLED", cancelReason: "fan changed mind", cancelledAt: "2000-01-01T00:00:00Z" }, now);
  assert.equal(cancelled.cancelledAt.toISOString(), now.toISOString(), "client cannot forge cancelledAt");
  assert.equal(cancelled.cancelReason, "fan changed mind");
});

test("list applies member creator scope and reports pending/overdue counters", async () => {
  const db = fakeDb({ orders: [
    { id: "a", agencyId: "agency-1", creatorId: "creator-1", dialogId: "1", createdByMemberId: "member-1", scenario: "A", internalNote: null, status: "PENDING", dueAt: new Date("2026-08-17T19:00:00Z"), acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 1000, createdAt: new Date("2026-08-17T18:00:00Z"), updatedAt: new Date("2026-08-17T18:00:00Z") },
    { id: "b", agencyId: "agency-1", creatorId: "creator-2", dialogId: "2", createdByMemberId: "member-1", scenario: "B", internalNote: null, status: "PENDING", dueAt: new Date("2026-08-18T19:00:00Z"), acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 2000, createdAt: new Date("2026-08-17T18:00:00Z"), updatedAt: new Date("2026-08-17T18:00:00Z") },
  ] });
  const result = await listCustomOrders({ agencyId: "agency-1", member, pendingOnly: true, now: new Date("2026-08-17T20:00:00Z"), db });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].creator.name, "Model A");
  assert.deepEqual(result.counts, { pending: 1, completed: 0, cancelled: 0, overdue: 1 });
});

test("update preserves journal row and serializes completed state", async () => {
  const db = fakeDb({ orders: [
    { id: "order-x", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1", scenario: "old", internalNote: null, status: "PENDING", dueAt: null, acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 0, createdAt: new Date("2026-08-17T18:00:00Z"), updatedAt: new Date("2026-08-17T18:00:00Z") },
  ] });
  const result = await updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-x", input: { status: "COMPLETED", scenario: "done", mediaIds: "44 45" }, now: new Date("2026-08-17T22:00:00Z"), db });
  assert.equal(result.order.status, "COMPLETED");
  assert.equal(result.order.scenario, "done");
  assert.deepEqual(result.order.mediaIds, ["44", "45"]);
  assert.equal(result.order.completedAt, "2026-08-17T22:00:00.000Z");
  assert.equal(serializeOrder(db._rows[0], new Date("2026-08-17T23:00:00Z")).status, "COMPLETED");
});


test("terminal custom orders are immutable and duplicate finalization is idempotent", async () => {
  const db = fakeDb({ orders: [
    { id: "order-done", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1", scenario: "done", internalNote: null, status: "COMPLETED", dueAt: null, acceptedAt: null, completedAt: new Date("2026-08-17T21:00:00Z"), deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "44", priceCents: 1000, createdAt: new Date("2026-08-17T18:00:00Z"), updatedAt: new Date("2026-08-17T21:00:00Z") },
  ] });
  const retry = await updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-done", input: { creatorId: "creator-1", status: "COMPLETED", mediaIds: ["44"] }, db });
  assert.equal(retry.order.status, "COMPLETED");
  await assert.rejects(
    () => updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-done", input: { creatorId: "creator-1", status: "CANCELLED", cancelReason: "late" }, db }),
    (error) => error?.code === "CUSTOM_ORDER_ALREADY_FINALIZED" && error?.status === 409,
  );
  await assert.rejects(
    () => updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-done", input: { creatorId: "creator-1", scenario: "rewrite history" }, db }),
    (error) => error?.code === "CUSTOM_ORDER_ALREADY_FINALIZED",
  );
});

test("business-critical text and media limits reject instead of silently truncating", () => {
  assert.throws(
    () => normalizeCreateInput({ creatorId: "c", dialogId: "42", scenario: "x".repeat(12_001) }),
    (error) => error?.code === "CUSTOM_ORDER_SCENARIO_TOO_LONG",
  );
  assert.throws(
    () => normalizeCreateInput({ creatorId: "c", dialogId: "42", scenario: "ok", internalNote: "n".repeat(4_001) }),
    (error) => error?.code === "CUSTOM_ORDER_INTERNALNOTE_TOO_LONG",
  );
  assert.throws(
    () => normalizeCreateInput({ creatorId: "c", dialogId: "42", scenario: "ok", mediaIds: Array.from({ length: 201 }, (_, index) => String(index + 1)) }),
    (error) => error?.code === "CUSTOM_ORDER_MEDIA_IDS_LIMIT",
  );
  assert.throws(
    () => normalizeCreateInput({ creatorId: "c", dialogId: "42", scenario: "ok", priceCents: 2_147_483_648 }),
    (error) => error?.code === "CUSTOM_ORDER_PRICE_TOO_LARGE",
  );
});
