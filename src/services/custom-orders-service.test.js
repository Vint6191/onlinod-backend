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
  recordTelegramDelivery,
  prepareTelegramTask,
  prepareManualReminder,
  recordTelegramInboundReply,
  armTelegramCustomUpload,
  recordTelegramCustomSubmission,
  prepareTelegramStatusNotification,
} = require("./custom-orders-service");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeDb(seed = {}) {
  const creators = seed.creators || [
    { id: "creator-1", agencyId: "agency-1", displayName: "Model A", username: "model_a", avatarUrl: null, telegramContact: "@model_a", telegramUserId: "1001", telegramAccountId: "tg-1", deletedAt: null, status: "READY" },
    { id: "creator-2", agencyId: "agency-1", displayName: "Model B", username: "model_b", avatarUrl: null, telegramContact: "@model_b", telegramUserId: "1002", telegramAccountId: null, deletedAt: null, status: "READY" },
  ];
  const members = {
    "member-1": { id: "member-1", displayName: "Chatter", roleKey: "chatter", user: { name: "Chatter", email: "c@test" } },
  };
  const rows = (seed.orders || []).map(clone);
  const accounts = (seed.accounts || [{ id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: null, runtimeClaimToken: null, runtimeClaimUntil: null }]).map(clone);
  let seq = 0;

  const include = (row) => row ? {
    ...clone(row),
    creator: clone(creators.find((x) => x.id === row.creatorId) || null),
    createdByMember: clone(members[row.createdByMemberId] || null),
  } : null;

  function matches(row, where = {}) {
    if (Array.isArray(where.OR) && where.OR.length && !where.OR.some((candidate) => matches(row, candidate))) return false;
    if (where.id !== undefined) {
      if (typeof where.id === "string" && row.id !== where.id) return false;
      if (where.id?.not !== undefined && row.id === where.id.not) return false;
      if (where.id?.in && !where.id.in.includes(row.id)) return false;
    }
    if (where.agencyId !== undefined && row.agencyId !== where.agencyId) return false;
    if (where.telegramTaskMessageId !== undefined && Number(row.telegramTaskMessageId) !== Number(where.telegramTaskMessageId)) return false;
    if (where.telegramTaskTransport !== undefined && String(row.telegramTaskTransport || "USER") !== String(where.telegramTaskTransport)) return false;
    if (where.telegramReferenceMessageIds?.has !== undefined && !(Array.isArray(row.telegramReferenceMessageIds) && row.telegramReferenceMessageIds.map(Number).includes(Number(where.telegramReferenceMessageIds.has)))) return false;
    if (where.telegramUploadKey !== undefined && String(row.telegramUploadKey || "") !== String(where.telegramUploadKey || "")) return false;
    if (where.telegramUploadArmedAt?.not === null && row.telegramUploadArmedAt == null) return false;
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
    agencyTelegramMtprotoAccount: {
      async findFirst({ where }) {
        const row = accounts.find((candidate) => candidate.id === where.id && candidate.agencyId === where.agencyId
          && (where.runtimeClaimedByDeviceId === undefined || candidate.runtimeClaimedByDeviceId === where.runtimeClaimedByDeviceId)
          && (where.runtimeClaimToken === undefined || candidate.runtimeClaimToken === where.runtimeClaimToken));
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


test("V2 types keep one CustomOrder row and schedule type-specific reminders", async () => {
  const db = fakeDb();
  const call = await createCustomOrder({
    agencyId: "agency-1",
    member,
    now: new Date("2026-08-19T12:00:00.000Z"),
    input: {
      creatorId: "creator-1",
      dialogId: "422411209",
      scenario: "Private call",
      type: "CALL",
      scheduledAt: "2026-08-19T15:00:00.000Z",
      durationMinutes: 45,
      reminderConfig: { enabled: true, offsetsMinutes: [135, 47, 5] },
      price: 200,
    },
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
    input: { creatorId: "creator-1", dialogId: "422411209", scenario: "Panties sale", type: "PHYSICAL", price: 80 },
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

test("manual remind-now cannot become the first Telegram message for a custom", async () => {
  const db = fakeDb();
  const created = await createCustomOrder({ agencyId: "agency-1", member, input: { creatorId: "creator-1", dialogId: "422", scenario: "unsent" }, db });
  await assert.rejects(
    () => prepareManualReminder({ agencyId: "agency-1", member, orderId: created.order.id, db }),
    (error) => error?.code === "CUSTOM_ORDER_TELEGRAM_TASK_REQUIRED" && error?.status === 409,
  );
});

test("Telegram references persist only task/message ids on the custom and merge idempotently", async () => {
  const db = fakeDb();
  const created = await createCustomOrder({
    agencyId: "agency-1",
    member,
    now: new Date("2026-08-19T12:00:00.000Z"),
    input: { creatorId: "creator-1", dialogId: "422411209", scenario: "Photo custom", type: "CONTENT", contentKind: "PHOTO" },
    db,
  });
  const prepared = await prepareTelegramTask({ agencyId: "agency-1", member, orderId: created.order.id, db });
  assert.equal(prepared.delivery.accountId, "tg-1");
  assert.equal(prepared.delivery.creatorId, "creator-1");
  assert.match(prepared.delivery.text, /Новый кастом/);

  const first = await recordTelegramDelivery({ agencyId: "agency-1", member, orderId: created.order.id, taskMessageId: 501, referenceMessageIds: [502, 503], now: new Date("2026-08-19T12:05:00.000Z"), db });
  assert.equal(first.order.telegramTaskMessageId, "501");
  assert.deepEqual(first.order.telegramReferenceMessageIds, ["502", "503"]);
  assert.equal(first.order.nextReminderAt, "2026-08-19T12:35:00.000Z", "content reminder clock begins at actual Telegram task delivery");

  const second = await recordTelegramDelivery({ agencyId: "agency-1", member, orderId: created.order.id, taskMessageId: 501, referenceMessageIds: [503, 504], db });
  assert.deepEqual(second.order.telegramReferenceMessageIds, ["502", "503", "504"]);
  await assert.rejects(
    () => recordTelegramDelivery({ agencyId: "agency-1", member, orderId: created.order.id, taskMessageId: 999, referenceMessageIds: [], db }),
    (error) => error?.code === "CUSTOM_ORDER_TELEGRAM_TASK_MESSAGE_CONFLICT" && error?.status === 409,
  );
});


test("model upload is stored only as server-side Telegram ids and blocks chatter completion until Content Team review", async () => {
  const now = new Date("2026-08-19T20:00:00.000Z");
  const db = fakeDb({
    accounts: [{
      id: "tg-1", agencyId: "agency-1",
      runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "lease-1",
      runtimeClaimUntil: new Date("2026-08-19T20:10:00.000Z"),
    }],
  });
  const created = await createCustomOrder({
    agencyId: "agency-1", member, now,
    input: { creatorId: "creator-1", dialogId: "422", scenario: "Model submission review", type: "CONTENT", contentKind: "VIDEO", price: 123 },
    db,
  });
  assert.equal(created.order.telegramSubmissionCount, 0);
  assert.equal("telegramSubmissionMessageIds" in created.order, false, "raw model media ids are never exposed through the normal custom serializer");
  assert.ok(db._rows[0].telegramUploadKey, "content custom gets an opaque upload key");

  const armed = await armTelegramCustomUpload({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1",
    senderTelegramUserId: "1001", uploadKey: db._rows[0].telegramUploadKey, controlMessageId: "750", now, db,
  });
  assert.equal(armed.matched, true);
  assert.equal(armed.order.telegramUploadState, "WAITING");

  const first = await recordTelegramCustomSubmission({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1",
    senderTelegramUserId: "1001", messageIds: ["801", "802"], sentAt: "2026-08-19T20:01:00.000Z", now, db,
  });
  assert.equal(first.matched, true);
  assert.equal(first.submissionCount, 2);
  assert.equal(first.order.status, "PENDING", "model upload is a submission, not chatter approval");
  assert.equal(first.order.telegramSubmissionCount, 2);
  assert.equal("telegramSubmissionMessageIds" in first.order, false);
  assert.deepEqual(db._rows[0].telegramSubmissionMessageIds, [801, 802], "only Telegram ids are retained server-side");

  await armTelegramCustomUpload({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1",
    senderTelegramUserId: "1001", uploadKey: db._rows[0].telegramUploadKey, controlMessageId: "750", now: new Date("2026-08-19T20:02:00.000Z"), db,
  });
  const second = await recordTelegramCustomSubmission({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1",
    senderTelegramUserId: "1001", messageIds: ["802", "803", "804"], sentAt: "2026-08-19T20:03:00.000Z", now: new Date("2026-08-19T20:03:00.000Z"), db,
  });
  assert.equal(second.submissionCount, 4, "add-more appends and de-duplicates Telegram message ids");

  await assert.rejects(
    () => updateCustomOrder({ agencyId: "agency-1", member, orderId: created.order.id, input: { creatorId: "creator-1", status: "COMPLETED" }, now, db }),
    (error) => error?.code === "CUSTOM_ORDER_CONTENT_REVIEW_REQUIRED" && error?.status === 409,
  );
  await assert.rejects(
    () => updateCustomOrder({ agencyId: "agency-1", member, orderId: created.order.id, input: { creatorId: "creator-1", type: "PHYSICAL" }, now, db }),
    (error) => error?.code === "CUSTOM_ORDER_CONTENT_REVIEW_REQUIRED" && error?.status === 409,
    "chatter cannot bypass the review placeholder by changing the custom type",
  );
});

test("cancel notification identifies the custom, replies to its task and never exposes model price", async () => {
  const db = fakeDb({ orders: [{
    id: "order-cancel", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1",
    scenario: "Blue room video", internalNote: null, type: "CONTENT", contentKind: "VIDEO", status: "CANCELLED",
    dueAt: null, scheduledAt: null, durationMinutes: null, physicalStatus: null,
    acceptedAt: null, completedAt: null, deliveredAt: new Date("2026-08-19T19:00:00.000Z"),
    cancelledAt: new Date("2026-08-19T20:00:00.000Z"), cancelReason: "fan cancelled", mediaIds: "", priceCents: 99900,
    telegramTaskMessageId: 700, telegramTaskTransport: "BOT", telegramBotControlMessageId: 701,
    telegramReferenceMessageIds: [], telegramSubmissionMessageIds: [], telegramUploadArmedAt: null,
    reminderConfig: null, nextReminderAt: null, lastReminderAt: null, lastReminderKey: null, reminderClaimToken: null, reminderClaimUntil: null,
    createdAt: new Date("2026-08-19T18:00:00.000Z"), updatedAt: new Date("2026-08-19T20:00:00.000Z"),
  }] });
  const prepared = await prepareTelegramStatusNotification({ agencyId: "agency-1", member, orderId: "order-cancel", db });
  assert.equal(prepared.delivery.replyToMessageId, "700");
  assert.equal(prepared.delivery.botControlMessageId, "701");
  assert.equal(prepared.delivery.transport, "BOT");
  assert.match(prepared.delivery.text, /Blue room video/);
  assert.match(prepared.delivery.text, /fan cancelled/);
  assert.doesNotMatch(prepared.delivery.text, /999|цена|price/i);
});

test("leased chatter runtime records only creator-bound Telegram replies and dedupes by message id", async () => {
  const now = new Date("2026-08-19T14:00:00.000Z");
  const db = fakeDb({
    accounts: [{ id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "lease-1", runtimeClaimUntil: new Date("2026-08-19T14:05:00.000Z") }],
    orders: [{
      id: "order-inbound", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1",
      scenario: "content custom", internalNote: null, status: "PENDING", type: "CONTENT", contentKind: "VIDEO", physicalStatus: null,
      dueAt: new Date("2026-08-20T12:00:00.000Z"), scheduledAt: null, durationMinutes: null, reminderConfig: null,
      telegramTaskMessageId: 700, telegramTaskTransport: "USER", telegramReferenceMessageIds: [701], telegramLastModelMessageId: null, telegramLastModelMessageAt: null,
      nextReminderAt: null, reminderClaimToken: null, reminderClaimUntil: null, lastReminderAt: null, lastReminderKey: null,
      acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 5000,
      createdAt: new Date("2026-08-19T13:00:00.000Z"), updatedAt: new Date("2026-08-19T13:00:00.000Z"),
    }],
  });

  const first = await recordTelegramInboundReply({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1", transport: "USER",
    senderTelegramUserId: "1001", messageId: "900", replyToMessageId: "700", sentAt: "2026-08-19T13:59:50.000Z", now, db,
  });
  assert.equal(first.matched, true);
  assert.equal(first.deduped, false);
  assert.equal(first.order.telegramLastModelMessageId, "900");
  assert.equal(first.order.telegramLastModelMessageAt, "2026-08-19T13:59:50.000Z");

  const duplicate = await recordTelegramInboundReply({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1", transport: "USER",
    senderTelegramUserId: "1001", messageId: "900", replyToMessageId: "700", sentAt: "2026-08-19T13:59:50.000Z", now, db,
  });
  assert.equal(duplicate.deduped, true);

  const referenceReply = await recordTelegramInboundReply({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1", transport: "USER",
    senderTelegramUserId: "1001", messageId: "901", replyToMessageId: "701", sentAt: "2026-08-19T14:00:00.000Z", now, db,
  });
  assert.equal(referenceReply.matched, true, "replying to a reference document remains linked to the same custom");
  assert.equal(referenceReply.order.telegramLastModelMessageId, "901");

  const foreignSender = await recordTelegramInboundReply({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1", transport: "USER",
    senderTelegramUserId: "1002", messageId: "902", replyToMessageId: "700", sentAt: now.toISOString(), now, db,
  });
  assert.deepEqual(foreignSender, { ok: true, matched: false, reason: "CREATOR_NOT_FOUND" });
});


test("Telegram inbound reply matching is transport-scoped even when USER and BOT message ids collide", async () => {
  const now = new Date("2026-08-19T14:00:00.000Z");
  const common = {
    agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1",
    scenario: "collision", internalNote: null, status: "PENDING", type: "CONTENT", contentKind: "VIDEO", physicalStatus: null,
    dueAt: null, scheduledAt: null, durationMinutes: null, reminderConfig: null,
    telegramTaskMessageId: 700, telegramReferenceMessageIds: [701], telegramLastModelMessageId: null, telegramLastModelMessageAt: null,
    nextReminderAt: null, reminderClaimToken: null, reminderClaimUntil: null, lastReminderAt: null, lastReminderKey: null,
    acceptedAt: null, completedAt: null, deliveredAt: null, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 0,
    createdAt: new Date("2026-08-19T13:00:00.000Z"), updatedAt: new Date("2026-08-19T13:00:00.000Z"),
  };
  const db = fakeDb({
    accounts: [{ id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "lease-1", runtimeClaimUntil: new Date("2026-08-19T14:05:00.000Z") }],
    orders: [
      { ...common, id: "order-user", telegramTaskTransport: "USER" },
      { ...common, id: "order-bot", telegramTaskTransport: "BOT", createdAt: new Date("2026-08-19T13:01:00.000Z") },
    ],
  });

  const result = await recordTelegramInboundReply({
    agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-1", claimToken: "lease-1", transport: "BOT",
    senderTelegramUserId: "1001", messageId: "990", replyToMessageId: "700", sentAt: now.toISOString(), now, db,
  });
  assert.equal(result.matched, true);
  assert.equal(result.order.id, "order-bot");
  assert.equal(db._rows.find((row) => row.id === "order-user").telegramLastModelMessageId, null);
  assert.equal(db._rows.find((row) => row.id === "order-bot").telegramLastModelMessageId, 990);
});

test("Telegram task transport becomes immutable after the first recorded delivery", async () => {
  const now = new Date("2026-08-19T14:00:00.000Z");
  const db = fakeDb({ orders: [{
    id: "order-transport", agencyId: "agency-1", creatorId: "creator-1", dialogId: "422", createdByMemberId: "member-1",
    scenario: "transport", internalNote: null, status: "PENDING", type: "CONTENT", contentKind: "PHOTO",
    dueAt: null, scheduledAt: null, durationMinutes: null, physicalStatus: null, reminderConfig: null,
    telegramTaskMessageId: 700, telegramTaskTransport: "USER", telegramReferenceMessageIds: [],
    nextReminderAt: null, reminderClaimToken: null, reminderClaimUntil: null, lastReminderAt: null, lastReminderKey: null,
    acceptedAt: null, completedAt: null, deliveredAt: now, cancelledAt: null, cancelReason: null, mediaIds: "", priceCents: 0,
    createdAt: now, updatedAt: now,
  }] });
  await assert.rejects(
    () => recordTelegramDelivery({ agencyId: "agency-1", member, orderId: "order-transport", taskMessageId: "700", referenceMessageIds: [], transport: "BOT", db }),
    (error) => error?.code === "CUSTOM_ORDER_TELEGRAM_TRANSPORT_CONFLICT" && error?.status === 409,
  );
  const same = await recordTelegramDelivery({ agencyId: "agency-1", member, orderId: "order-transport", taskMessageId: "700", referenceMessageIds: ["701"], transport: "USER", db });
  assert.equal(same.order.telegramTaskTransport, "USER");
  assert.deepEqual(same.order.telegramReferenceMessageIds, ["701"]);
});

test("Telegram inbound replies require the live account runtime lease", async () => {
  const now = new Date("2026-08-19T14:00:00.000Z");
  const db = fakeDb({
    accounts: [{ id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-a", runtimeClaimToken: "lease-a", runtimeClaimUntil: new Date("2026-08-19T14:05:00.000Z") }],
  });
  await assert.rejects(
    () => recordTelegramInboundReply({ agencyId: "agency-1", member, accountId: "tg-1", deviceId: "device-b", claimToken: "lease-b", senderTelegramUserId: "1001", messageId: "999", replyToMessageId: "700", now, db }),
    (error) => error?.code === "TELEGRAM_EXECUTION_LEASE_INVALID" && error?.status === 409,
  );
});
