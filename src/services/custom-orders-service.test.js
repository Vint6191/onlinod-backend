"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildUpdateData,
  createCustomOrder,
  listCustomOrders,
  mediaIdsArray,
  normalizeCreateInput,
  paymentSnapshot,
  serializeOrder,
  updateCustomOrder,
} = require("./custom-orders-service");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

let mutationSeq = 0;
function withCreateIntent(input = {}) {
  mutationSeq += 1;
  return { clientMutationId: `00000000-0000-4000-8000-${String(mutationSeq).padStart(12, "0")}`, ...input };
}

function fakeDb(seed = {}) {
  const creators = seed.creators || [
    { id: "creator-1", agencyId: "agency-1", displayName: "Model A", username: "model_a", avatarUrl: null, telegramContact: "@model_a", telegramUserId: "1001", telegramAccountId: "tg-1", deletedAt: null, status: "READY" },
    { id: "creator-2", agencyId: "agency-1", displayName: "Model B", username: "model_b", avatarUrl: null, telegramContact: "@model_b", telegramUserId: "1002", telegramAccountId: null, deletedAt: null, status: "READY" },
  ];
  const members = {
    "member-1": {
      id: "member-1", userId: "user-1", agencyId: "agency-1", displayName: "Chatter",
      role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"], accessEpoch: 1,
      deletedAt: null, deactivatedAt: null, user: { name: "Chatter", email: "c@test" },
    },
  };
  const rows = (seed.orders || []).map(clone);
  const accounts = (seed.accounts || [{ id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: null, runtimeClaimToken: null, runtimeClaimUntil: null }]).map(clone);
  const deliveryIntents = [];
  let seq = 0;

  const include = (row) => row ? {
    ...clone(row),
    creator: clone(creators.find((x) => x.id === row.creatorId) || null),
    createdByMember: clone(members[row.createdByMemberId] || null),
  } : null;

  function matches(row, where = {}) {
    if (Array.isArray(where.OR) && where.OR.length && !where.OR.some((candidate) => matches(row, candidate))) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
    if (where.clientMutationId !== undefined && row.clientMutationId !== where.clientMutationId) return false;
    if (where.telegramTaskMessageId !== undefined && Number(row.telegramTaskMessageId) !== Number(where.telegramTaskMessageId)) return false;
    if (where.telegramReferenceMessageIds?.has !== undefined && !(Array.isArray(row.telegramReferenceMessageIds) && row.telegramReferenceMessageIds.map(Number).includes(Number(where.telegramReferenceMessageIds.has)))) return false;
    if (where.type !== undefined && String(row.type || "CONTENT") !== String(where.type)) return false;
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
    if (where.dueAt?.gte !== undefined) {
      const due = row.dueAt ? new Date(row.dueAt).getTime() : NaN;
      const floor = new Date(where.dueAt.gte).getTime();
      if (!Number.isFinite(due) || !Number.isFinite(floor) || due < floor) return false;
    }
    if (where.dueAt?.lte !== undefined) {
      const due = row.dueAt ? new Date(row.dueAt).getTime() : NaN;
      const ceiling = new Date(where.dueAt.lte).getTime();
      if (!Number.isFinite(due) || !Number.isFinite(ceiling) || due > ceiling) return false;
    }
    if (where.scheduledAt?.lt !== undefined) {
      const scheduled = row.scheduledAt ? new Date(row.scheduledAt).getTime() : NaN;
      const before = new Date(where.scheduledAt.lt).getTime();
      if (!Number.isFinite(scheduled) || !Number.isFinite(before) || scheduled >= before) return false;
    }
    if (where.scheduledAt?.gte !== undefined) {
      const scheduled = row.scheduledAt ? new Date(row.scheduledAt).getTime() : NaN;
      const floor = new Date(where.scheduledAt.gte).getTime();
      if (!Number.isFinite(scheduled) || !Number.isFinite(floor) || scheduled < floor) return false;
    }
    if (where.scheduledAt?.lte !== undefined) {
      const scheduled = row.scheduledAt ? new Date(row.scheduledAt).getTime() : NaN;
      const ceiling = new Date(where.scheduledAt.lte).getTime();
      if (!Number.isFinite(scheduled) || !Number.isFinite(ceiling) || scheduled > ceiling) return false;
    }
    return true;
  }

  return {
    _rows: rows,
    workspaceSetting: { async findUnique() { return null; } },
    agencyMember: {
      async findFirst({ where }) {
        const row = members[where.id];
        if (!row || row.id !== where.id || row.userId !== where.userId || row.agencyId !== where.agencyId || row.deletedAt || row.deactivatedAt) return null;
        return clone(row);
      },
    },
    agencyTelegramMtprotoAccount: {
      async findFirst({ where }) {
        const row = accounts.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId);
        return clone(row || null);
      },
      async findMany({ where }) { return accounts.filter((row) => row.agencyId === where.agencyId).map((row) => ({ id: row.id })); },
      async updateMany({ where, data }) {
        const row = accounts.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId
          && (where.runtimeClaimedByDeviceId === undefined || candidate.runtimeClaimedByDeviceId === where.runtimeClaimedByDeviceId)
          && (where.runtimeClaimToken === undefined || candidate.runtimeClaimToken === where.runtimeClaimToken));
        if (!row) return { count: 0 }; Object.assign(row, clone(data)); return { count: 1 };
      },
    },
    creatorAccount: {
      async findFirst({ where }) {
        return clone(creators.find((row) => row.agencyId === where.agencyId && !row.deletedAt
          && (typeof where.id !== "string" || row.id === where.id)
          && (!where.id?.in || where.id.in.includes(row.id))
          && (where.telegramUserId === undefined || String(row.telegramUserId || "") === String(where.telegramUserId))) || null);
      },
      async findMany({ where }) {
        return creators.filter((row) => row.agencyId === where.agencyId && !row.deletedAt
          && (!where.id?.in || where.id.in.includes(row.id))
          && (where.telegramContact?.not !== null || row.telegramContact !== null)).map(clone);
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
      async update({ where, data }) {
        const row = rows.find((item) => item.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, clone(data), { updatedAt: new Date("2026-08-17T20:01:00.000Z") });
        return include(row);
      },
      async findMany({ where, select, take = 10000, skip = 0 }) {
        const found = rows.filter((row) => matches(row, where)).slice(skip, skip + take);
        if (select) return found.map((row) => ({ status: row.status, dueAt: row.dueAt }));
        return found.map(include);
      },
      async count({ where }) { return rows.filter((row) => matches(row, where)).length; },
    },
    telegramDeliveryIntent: {
      async findUnique({ where }) { return clone(deliveryIntents.find((row) => row.logicalKey === where.logicalKey) || null); },
      async create({ data }) {
        const row = { id: `telegram-intent-${deliveryIntents.length + 1}`, claimRevision: 0, remoteMessageId: null, remoteSentAt: null, confirmedAt: null, commitStartedAt: null, outcomeReason: null, ...clone(data), updatedAt: new Date("2026-08-17T20:00:00.000Z") };
        deliveryIntents.push(row); return clone(row);
      },
    },
    auditLog: { async create({ data }) { return { id: `audit-${seq}`, ...clone(data) }; } },
    async $transaction(fn) { return fn(this); },
  };
}

const member = { id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"], accessEpoch: 1 };

test("media ids are stored as a stable de-duplicated space-separated list", () => {
  assert.deepEqual(mediaIdsArray("10 20,20;30"), ["10", "20", "30"]);
  assert.equal(normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "hello", mediaIds: ["10", "20", "10"], price: 12.34 })).mediaIds, "10 20");
});

test("custom order create is creator-scoped and starts pending", async () => {
  const db = fakeDb();
  const result = await createCustomOrder({
    agencyId: "agency-1",
    member,
    input: withCreateIntent({ creatorId: "creator-1", dialogId: "422411209", scenario: "5 minute custom", dueAt: "2026-08-18T20:00:00Z", price: 150, mediaIds: ["11", "12"] }),
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
  await assert.rejects(() => createCustomOrder({ agencyId: "agency-1", member, input: withCreateIntent({ creatorId: "creator-2", dialogId: "1", scenario: "x" }), db }), /do not have access/i);
});


test("custom payment amounts use integer cents and derive status/remaining instead of persisting flags", async () => {
  assert.deepEqual(paymentSnapshot(6000, 0), { paidAmountCents: 0, paidAmount: 0, remainingAmountCents: 6000, remainingAmount: 60, paymentStatus: "NOT_PAID" });
  assert.deepEqual(paymentSnapshot(6000, 4000), { paidAmountCents: 4000, paidAmount: 40, remainingAmountCents: 2000, remainingAmount: 20, paymentStatus: "PARTIALLY_PAID" });
  assert.deepEqual(paymentSnapshot(6000, 7000), { paidAmountCents: 7000, paidAmount: 70, remainingAmountCents: 0, remainingAmount: 0, paymentStatus: "PAID_IN_FULL" });

  const db = fakeDb();
  const result = await createCustomOrder({
    agencyId: "agency-1", member,
    input: withCreateIntent({ creatorId: "creator-1", dialogId: "422411209", scenario: "paid in parts", price: 60, paidAmount: 40 }),
    db,
  });
  assert.equal(result.order.priceCents, 6000);
  assert.equal(result.order.paidAmountCents, 4000);
  assert.equal(result.order.paidAmount, 40);
  assert.equal(result.order.remainingAmountCents, 2000);
  assert.equal(result.order.remainingAmount, 20);
  assert.equal(result.order.paymentStatus, "PARTIALLY_PAID");
  assert.equal("remainingAmountCents" in db._rows[0], false, "remaining amount must be derived, not stored");
  assert.equal("paymentStatus" in db._rows[0], false, "payment status must be derived, not stored");
});

test("editing total or paid amount deterministically recomputes payment state and preserves overpayment", async () => {
  const db = fakeDb({ orders: [{
    id: "order-pay", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1",
    scenario: "payment", internalNote: null, type: "CONTENT", contentKind: "VIDEO", status: "PENDING", dueAt: null, scheduledAt: null, durationMinutes: null, physicalStatus: null,
    acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 6000, paidAmountCents: 4000,
    telegramTaskMessageId: null, telegramReferenceMessageIds: [], reminderConfig: null, nextReminderAt: null, lastReminderAt: null, lastReminderKey: null, reminderClaimToken: null, reminderClaimUntil: null,
    createdAt: new Date("2026-08-21T10:00:00.000Z"), updatedAt: new Date("2026-08-21T10:00:00.000Z"),
  }] });
  const raised = await updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-pay", input: { price: 100 }, db });
  assert.equal(raised.order.paidAmount, 40);
  assert.equal(raised.order.remainingAmount, 60);
  assert.equal(raised.order.paymentStatus, "PARTIALLY_PAID");

  const overpaid = await updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-pay", input: { paidAmount: 120 }, db });
  assert.equal(overpaid.order.paidAmount, 120);
  assert.equal(overpaid.order.remainingAmount, 0);
  assert.equal(overpaid.order.paymentStatus, "PAID_IN_FULL");
});

test("paid amount can be corrected after finalization without reopening immutable production fields", async () => {
  const db = fakeDb({ orders: [{
    id: "order-final-pay", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1", scenario: "done", internalNote: null,
    type: "CONTENT", contentKind: "PHOTO", status: "COMPLETED", dueAt: null, scheduledAt: null, durationMinutes: null, physicalStatus: null, acceptedAt: null,
    completedAt: new Date("2026-08-21T10:30:00.000Z"), deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "44", priceCents: 6000, paidAmountCents: 2000,
    telegramTaskMessageId: null, telegramReferenceMessageIds: [], reminderConfig: null, nextReminderAt: null, lastReminderAt: null, lastReminderKey: null, reminderClaimToken: null, reminderClaimUntil: null,
    createdAt: new Date("2026-08-21T10:00:00.000Z"), updatedAt: new Date("2026-08-21T10:30:00.000Z"),
  }] });
  const corrected = await updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-final-pay", input: { paidAmount: 60 }, db });
  assert.equal(corrected.order.status, "COMPLETED");
  assert.equal(corrected.order.paymentStatus, "PAID_IN_FULL");
  assert.equal(corrected.order.remainingAmount, 0);
  await assert.rejects(
    () => updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-final-pay", input: { price: 80 } , db }),
    (error) => error?.code === "CUSTOM_ORDER_ALREADY_FINALIZED" && error?.status === 409,
  );
});

test("payment validation fails closed and migration backfills old rows to zero", () => {
  assert.throws(() => normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "ok", paidAmount: -1 })), (error) => error?.code === "CUSTOM_ORDER_PAID_AMOUNT_INVALID");
  assert.throws(() => normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "ok", paidAmountCents: 2_147_483_648 })), (error) => error?.code === "CUSTOM_ORDER_PAID_AMOUNT_TOO_LARGE");
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260821113000_custom_order_payment_foundation/migration.sql"), "utf8");
  assert.match(schema, /model CustomOrder[\s\S]*paidAmountCents\s+Int\s+@default\(0\)/);
  assert.doesNotMatch(schema, /paymentStatus\s+/);
  assert.doesNotMatch(schema, /remainingAmountCents\s+/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "paidAmountCents" INTEGER/);
  assert.match(migration, /WHERE "paidAmountCents" IS NULL OR "paidAmountCents" < 0/);
  assert.match(migration, /ALTER COLUMN "paidAmountCents" SET NOT NULL/);
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
  assert.deepEqual(result.counts, { pending: 1, completed: 0, missed: 0, cancelled: 0, overdue: 1, dueSoon: 0 });
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
    () => normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "x".repeat(12_001) })),
    (error) => error?.code === "CUSTOM_ORDER_SCENARIO_TOO_LONG",
  );
  assert.throws(
    () => normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "ok", internalNote: "n".repeat(4_001) })),
    (error) => error?.code === "CUSTOM_ORDER_INTERNALNOTE_TOO_LONG",
  );
  assert.throws(
    () => normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "ok", mediaIds: Array.from({ length: 201 }, (_, index) => String(index + 1)) })),
    (error) => error?.code === "CUSTOM_ORDER_MEDIA_IDS_LIMIT",
  );
  assert.throws(
    () => normalizeCreateInput(withCreateIntent({ creatorId: "c", dialogId: "42", scenario: "ok", priceCents: 2_147_483_648 })),
    (error) => error?.code === "CUSTOM_ORDER_PRICE_TOO_LARGE",
  );
});


test("V2 types keep one CustomOrder row and schedule type-specific reminders", async () => {
  const db = fakeDb();
  const call = await createCustomOrder({
    agencyId: "agency-1",
    member,
    now: new Date("2026-08-19T12:00:00.000Z"),
    input: withCreateIntent({
      creatorId: "creator-1",
      dialogId: "422411209",
      scenario: "Private call",
      type: "CALL",
      scheduledAt: "2026-08-19T15:00:00.000Z",
      durationMinutes: 45,
      reminderConfig: { enabled: true, offsetsMinutes: [135, 47, 5] },
      price: 200,
    }),
    db,
  });
  assert.equal(call.order.type, "CALL");
  assert.equal(call.order.contentKind, null);
  assert.equal(call.order.durationMinutes, 45);
  assert.equal(call.order.nextReminderAt, "2026-08-19T12:45:00.000Z", "135 minutes before 15:00 is the first future reminder");

  const physical = await createCustomOrder({
    agencyId: "agency-1",
    member,
    now: new Date("2026-08-19T12:00:00.000Z"),
    input: withCreateIntent({ creatorId: "creator-1", dialogId: "422411209", scenario: "Panties sale", type: "PHYSICAL", price: 80 }),
    db,
  });
  assert.equal(physical.order.type, "PHYSICAL");
  assert.equal(physical.order.physicalStatus, "WAITING");
  assert.equal(physical.order.nextReminderAt, null, "physical reminders are off by default");
});


test("ordinary edits preserve an already scheduled reminder while policy edits restart it safely", async () => {
  const nextAt = new Date("2026-08-19T13:00:00.000Z");
  const db = fakeDb({ orders: [{
    id: "order-timer", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1",
    scenario: "before", internalNote: null, type: "CONTENT", contentKind: "PHOTO", status: "PENDING", dueAt: null,
    scheduledAt: null, durationMinutes: null, physicalStatus: null, acceptedAt: null, completedAt: null, deliveredAt: new Date("2026-08-19T12:05:00.000Z"),
    cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 0, telegramTaskMessageId: 501, telegramReferenceMessageIds: [],
    reminderConfig: null, nextReminderAt: nextAt, lastReminderAt: null, lastReminderKey: null, reminderClaimToken: null, reminderClaimUntil: null,
    createdAt: new Date("2026-08-19T10:00:00.000Z"), updatedAt: new Date("2026-08-19T12:05:00.000Z"),
  }] });
  const edited = await updateCustomOrder({ agencyId: "agency-1", member, orderId: "order-timer", input: { scenario: "after" }, now: new Date("2026-08-19T12:20:00.000Z"), db });
  assert.equal(edited.order.nextReminderAt, nextAt.toISOString(), "scenario edit must not move the reminder clock");

  const policyEdited = await updateCustomOrder({
    agencyId: "agency-1", member, orderId: "order-timer",
    input: { reminderConfig: { enabled: true, firstAfterMinutes: 90, repeatEveryMinutes: 120 } },
    now: new Date("2026-08-19T12:30:00.000Z"), db,
  });
  assert.equal(policyEdited.order.nextReminderAt, "2026-08-19T14:00:00.000Z", "first reminder restarts from the explicit policy edit when no reminder was sent yet");
});

test("CustomOrder create retries with the same stable clientMutationId return the same order and conflicting payload is rejected", async () => {
  const db = fakeDb();
  const input = withCreateIntent({ creatorId: "creator-1", dialogId: "422", scenario: "stable create" });
  const first = await createCustomOrder({ agencyId: "agency-1", member, input, db });
  const replay = await createCustomOrder({ agencyId: "agency-1", member, input: { ...input }, db });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.order.id, first.order.id);
  await assert.rejects(
    () => createCustomOrder({ agencyId: "agency-1", member, input: { ...input, scenario: "different intent" }, db }),
    (error) => error?.code === "CUSTOM_ORDER_CLIENT_MUTATION_CONFLICT" && error?.status === 409,
  );
});

