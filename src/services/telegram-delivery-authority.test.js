"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CLAIM_MS,
  planTelegramDeliveryIntent,
  listTelegramDeliveryWork,
  claimTelegramDeliveryIntent,
  beginTelegramDeliveryIntent,
  confirmTelegramDeliveryIntent,
  markTelegramDeliveryUnknown,
  markTelegramDeliveryProvenNotSent,
  reconcileTelegramDeliveryIntent,
  getTelegramOrderContext,
  assertTelegramDeliveryMaterialAccess,
} = require("./telegram-delivery-authority-service");

function clone(v) { return v == null ? v : structuredClone(v); }
function scalar(value) { return value instanceof Date ? value.getTime() : value; }
function matches(row, where = {}) {
  for (const [key, expected] of Object.entries(where || {})) {
    if (key === "OR") { if (!expected.some((part) => matches(row, part))) return false; continue; }
    if (key === "agency") continue;
    const actual = row[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if ("in" in expected && !expected.in.map(String).includes(String(actual))) return false;
      if ("not" in expected) {
        if (expected.not === null ? actual === null : String(actual) === String(expected.not)) return false;
      }
      if ("lt" in expected && !(scalar(actual) < scalar(expected.lt))) return false;
      if ("lte" in expected && !(scalar(actual) <= scalar(expected.lte))) return false;
      if ("gt" in expected && !(scalar(actual) > scalar(expected.gt))) return false;
      if ("gte" in expected && !(scalar(actual) >= scalar(expected.gte))) return false;
      continue;
    }
    if (expected === null) { if (actual !== null) return false; continue; }
    if (actual instanceof Date || expected instanceof Date) { if (scalar(actual) !== scalar(expected)) return false; continue; }
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function dbFixture({ beforeCustomOrderUpdateMany = null } = {}) {
  const now = new Date("2026-09-04T15:00:00.000Z");
  const member = { id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OWNER", roleKey: "owner", assignedCreators: "all", accessEpoch: 7, deletedAt: null, deactivatedAt: null };
  const creators = [{ id: "creator-1", agencyId: "agency-1", displayName: "Model", username: "model", status: "READY", deletedAt: null, telegramContact: "@model", telegramUserId: "1001", telegramAccountId: "tg-1" }];
  const accounts = [
    { id: "tg-1", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "runtime-1", runtimeClaimUntil: new Date(now.getTime() + 60_000), runtimeLeaseUserId: member.userId, runtimeLeaseMemberId: member.id, runtimeLeaseAccessEpoch: member.accessEpoch, runtimeLeaseCreatorId: "creator-1" },
    { id: "tg-2", agencyId: "agency-1", runtimeClaimedByDeviceId: "device-2", runtimeClaimToken: "runtime-2", runtimeClaimUntil: new Date(now.getTime() + 60_000), runtimeLeaseUserId: member.userId, runtimeLeaseMemberId: member.id, runtimeLeaseAccessEpoch: member.accessEpoch, runtimeLeaseCreatorId: "creator-1" },
  ];
  const orders = [{ id: "order-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", scenario: "custom", type: "CONTENT", status: "PENDING", telegramTaskMessageId: null, telegramReferenceMessageIds: [], deliveredAt: null, lastReminderAt: null, lastReminderKey: null, nextReminderAt: null, reminderConfig: null, createdAt: new Date(now.getTime() - 60_000), updatedAt: new Date(now.getTime() - 60_000), creator: creators[0] }];
  const intents = [];
  const inboundEvents = [];
  let seq = 0;
  const db = {
    _member: member, _creators: creators, _accounts: accounts, _orders: orders, _intents: intents, _inboundEvents: inboundEvents, _workspaceSettingValue: null,
    agencyMember: { async findFirst({ where }) { return matches(member, where) ? clone(member) : null; } },
    creatorAccount: {
      async findFirst({ where }) { return clone(creators.find((r) => matches(r, where)) || null); },
      async findMany({ where }) { return creators.filter((r) => matches(r, where)).map(clone); },
    },
    agencyTelegramMtprotoAccount: {
      async findFirst({ where }) { return clone(accounts.find((r) => matches(r, where)) || null); },
      async findMany({ where }) { return accounts.filter((r) => matches(r, where)).map((r) => ({ id: r.id })); },
      async updateMany({ where, data }) { const r = accounts.find((x) => matches(x, where)); if (!r) return { count: 0 }; Object.assign(r, clone(data)); return { count: 1 }; },
    },
    workspaceSetting: { async findUnique() { return db._workspaceSettingValue == null ? null : { value: clone(db._workspaceSettingValue) }; } },
    customOrder: {
      async findFirst({ where }) { return clone(orders.find((r) => matches(r, where)) || null); },
      async findMany({ where, take = 100 }) { return orders.filter((r) => matches(r, where)).slice(0, take).map(clone); },
      async update({ where, data }) { const r = orders.find((x) => matches(x, where)); if (!r) throw new Error("order missing"); Object.assign(r, clone(data), { updatedAt: new Date() }); return clone(r); },
      async updateMany({ where, data }) {
        if (typeof beforeCustomOrderUpdateMany === "function") await beforeCustomOrderUpdateMany({ where: clone(where), data: clone(data), orders });
        const r = orders.find((x) => matches(x, where));
        if (!r) return { count: 0 };
        Object.assign(r, clone(data), { updatedAt: new Date(new Date(r.updatedAt).getTime() + 1) });
        return { count: 1 };
      },
    },
    telegramDeliveryIntent: {
      async findUnique({ where }) { return clone(intents.find((r) => matches(r, where)) || null); },
      async findFirst({ where }) { return clone(intents.find((r) => matches(r, where)) || null); },
      async findMany({ where, take = 100 }) { return intents.filter((r) => matches(r, where)).slice(0, take).map(clone); },
      async create({ data }) { const r = { id: `intent-${++seq}`, claimRevision: 0, claimUntil: null, claimTokenHash: null, deviceId: null, userId: null, memberId: null, accessEpoch: null, commitStartedAt: null, remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, confirmedAt: null, outcomeReason: null, createdAt: new Date(now.getTime() + seq), updatedAt: new Date(now.getTime() + seq), ...clone(data) }; intents.push(r); return clone(r); },
      async updateMany({ where, data }) { let count = 0; for (const r of intents) if (matches(r, where)) { Object.assign(r, clone(data), { updatedAt: new Date() }); count += 1; } return { count }; },
    },
    telegramInboundEvent: {
      async findFirst({ where }) { return clone(inboundEvents.find((r) => matches(r, where)) || null); },
      async findMany({ where, take = 100 }) {
        return inboundEvents
          .filter((r) => matches(r, where))
          .sort((a, b) => scalar(a.sentAt) - scalar(b.sentAt) || Number(a.messageId) - Number(b.messageId))
          .slice(0, take)
          .map(clone);
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of inboundEvents) if (matches(r, where)) { Object.assign(r, clone(data), { updatedAt: new Date() }); count += 1; }
        return { count };
      },
    },
    auditLog: { async create({ data }) { return { id: `audit-${Date.now()}`, ...clone(data) }; } },
    async $transaction(fn) { return fn(this); },
  };
  return { db, member, now, orders, intents, inboundEvents, accounts, creators };
}

function seedConfirmedTaskThread(fx, { accountId = "tg-1", messageId = 501, telegramUserId = "1001" } = {}) {
  fx.orders[0].telegramTaskMessageId = Number(messageId);
  const at = new Date(fx.now.getTime() - 1_000);
  fx.intents.push({
    id: `confirmed-task-${messageId}`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId, kind: "TASK",
    logicalKey: "custom-telegram:agency-1:order-1:TASK:one", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "task-proof", payload: { text: "task", replyToDeliveryId: null, replyToMessageId: null }, state: "CONFIRMED",
    deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: at,
    remoteMessageId: Number(messageId), remoteRecipientTelegramUserId: String(telegramUserId), remoteSentAt: at, outcomeReason: null, confirmedAt: at, createdAt: at, updatedAt: at,
  });
}

async function taskToCommitting(fx) {
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
  assert.equal(begun.begun, true);
  return { planned, claimed, begun };
}

test("TASK precommit payload refresh keeps one logical intent and invalidates an already-issued stale claim", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  fx.orders[0].scenario = "edited before Telegram commit";
  const refreshed = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.intent.id, planned.intent.id);
  assert.equal(refreshed.intent.state, "PLANNED");
  assert.equal(refreshed.intent.claimRevision, claimed.intent.claimRevision + 1);
  assert.match(refreshed.intent.payload.text, /edited before Telegram commit/);
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 2_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CLAIM_STALE",
  );
  const reClaimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() + 3_000), db: fx.db });
  assert.equal(reClaimed.claimed, true);
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: reClaimed.claimToken, now: new Date(fx.now.getTime() + 4_000), db: fx.db });
  assert.equal(begun.begun, true);
  assert.match(begun.intent.payload.text, /edited before Telegram commit/);
  assert.equal(fx.intents.length, 1);
});

test("Telegram account reassignment before COMMITTING invalidates the stale claim and refreshes the same logical intent", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);

  fx.creators[0].telegramAccountId = "tg-2";
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 1_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED",
  );
  assert.equal(fx.intents[0].state, "PLANNED");
  assert.equal(fx.intents[0].claimTokenHash, null);

  const refreshed = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: new Date(fx.now.getTime() + 2_000), db: fx.db });
  assert.equal(refreshed.intent.id, planned.intent.id);
  assert.equal(refreshed.intent.accountId, "tg-2");
  assert.equal(fx.intents.length, 1);

  const reClaimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-2", runtimeClaimToken: "runtime-2", now: new Date(fx.now.getTime() + 3_000), db: fx.db });
  assert.equal(reClaimed.claimed, true);
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-2", runtimeClaimToken: "runtime-2", claimToken: reClaimed.claimToken, now: new Date(fx.now.getTime() + 4_000), db: fx.db });
  assert.equal(begun.begun, true);
  assert.equal(begun.intent.accountId, "tg-2");
});


test("stale TASK begin self-refreshes the same logical intent so background execution does not loop forever", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  fx.orders[0].scenario = "fresh scenario before commit";
  fx.orders[0].updatedAt = new Date(fx.now.getTime() + 500);

  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 1_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED",
  );
  assert.equal(fx.intents.length, 1);
  assert.equal(fx.intents[0].id, planned.intent.id);
  assert.equal(fx.intents[0].state, "PLANNED");
  assert.match(fx.intents[0].payload.text, /fresh scenario before commit/);

  const reClaimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() + 2_000), db: fx.db });
  assert.equal(reClaimed.claimed, true);
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: reClaimed.claimToken, now: new Date(fx.now.getTime() + 3_000), db: fx.db });
  assert.equal(begun.begun, true);
  assert.match(begun.intent.payload.text, /fresh scenario before commit/);
});

test("work listing refreshes a reassigned Telegram account before Desktop needs an execution context", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  assert.equal(planned.intent.accountId, "tg-1");
  fx.creators[0].telegramAccountId = "tg-2";

  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].id, planned.intent.id);
  assert.equal(work.items[0].accountId, "tg-2");
  assert.equal(work.items[0].state, "PLANNED");
  assert.equal(fx.intents.length, 1);
});

test("MANUAL_REMINDER response-loss retry keeps one clientIntentId even when time-derived text changes precommit", async () => {
  const fx = dbFixture();
  fx.orders[0].type = "CALL";
  fx.orders[0].scheduledAt = new Date(fx.now.getTime() + 31 * 60_000);
  seedConfirmedTaskThread(fx);
  const clientIntentId = "11111111-1111-4111-8111-111111111111";
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId, now: fx.now, db: fx.db });
  assert.match(first.intent.payload.text, /31/);

  // Simulate the first HTTP response being lost: the client only knows the same durable UUID and retries later.
  const retry = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId, now: new Date(fx.now.getTime() + 2 * 60_000), db: fx.db });
  assert.equal(retry.intent.id, first.intent.id);
  assert.equal(retry.created, false);
  assert.equal(retry.intent.state, "PLANNED");
  assert.match(retry.intent.payload.text, /29/);
  assert.equal(fx.intents.length, 2);
});

test("REFERENCE precommit refresh never permits a clientIntentId to change its durable file proof", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx);
  const clientIntentId = "22222222-2222-4222-8222-222222222222";
  const reference = { ordinal: 0, name: "a.jpg", size: 10, sha256: "a".repeat(64) };
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId, reference, now: fx.now, db: fx.db });
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId, reference: { ...reference, sha256: "b".repeat(64) }, now: new Date(fx.now.getTime() + 1_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_INTENT_CONFLICT",
  );
  assert.equal(fx.intents.length, 2);
  const referenceIntent = fx.intents.find((row) => row.kind === "REFERENCE");
  assert.equal(referenceIntent.id, first.intent.id);
  assert.equal(referenceIntent.payload.reference.sha256, "a".repeat(64));
});

test("confirmed TASK pins follow-up account and provider recipient after creator account reassignment", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { accountId: "tg-1", messageId: 501, telegramUserId: "1001" });
  fx.creators[0].telegramAccountId = "tg-2";
  const clientIntentId = "33333333-3333-4333-8333-333333333333";
  const planned = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId,
    reference: { ordinal: 0, name: "pinned.jpg", size: 12, sha256: "c".repeat(64) }, now: fx.now, db: fx.db,
  });
  assert.equal(planned.intent.accountId, "tg-1");
  assert.equal(planned.intent.payload.replyToMessageId, "501");
  assert.equal(planned.intent.payload.recipientTelegramUserId, "1001");

  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(begun.begun, true);
  const material = await assertTelegramDeliveryMaterialAccess({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, creatorId: "creator-1", accountId: "tg-1", deviceId: "device-1", deliveryClaimToken: claimed.claimToken, db: fx.db });
  assert.equal(material.recipientTelegramUserId, "1001");

  fx.intents.find((row) => row.id === planned.intent.id).state = "CONFIRMED";
  fx.intents.find((row) => row.id === planned.intent.id).remoteMessageId = 601;
  fx.intents.find((row) => row.id === planned.intent.id).remoteRecipientTelegramUserId = "1001";
  const context = await getTelegramOrderContext({ agencyId: "agency-1", member: fx.member, orderId: "order-1", db: fx.db });
  assert.equal(context.accountId, "tg-1");
  assert.equal(context.telegramUserId, "1001");
  assert.deepEqual(context.telegramReferenceMessageIds, ["601"]);
});

test("TASK already COMMITTING is immutable even if the CustomOrder changes afterwards", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  const originalFingerprint = flow.begun.intent.payloadFingerprint;
  fx.orders[0].scenario = "edited after commit permit";
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: new Date(fx.now.getTime() + 1_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_INTENT_CONFLICT",
  );
  assert.equal(fx.intents[0].state, "COMMITTING");
  assert.equal(fx.intents[0].payloadFingerprint, originalFingerprint);
});

test("TASK commit requires a provider-resolved recipient identity", async () => {
  const fx = dbFixture();
  fx.creators[0].telegramUserId = null;
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_TASK_RECIPIENT_UNPROVEN",
  );
  assert.equal(fx.intents[0].state, "PLANNED");
  assert.equal(fx.intents[0].commitStartedAt, null);
});

test("TASK recipient is immutable after COMMITTING even when creator contact changes", async () => {
  const fx = dbFixture();
  const { begun, claimed } = await taskToCommitting(fx);
  assert.equal(begun.intent.payload.recipientTelegramUserId, "1001");
  assert.equal(begun.intent.payload.recipientTelegramContact, "@model");
  fx.creators[0].telegramContact = "@different_model";
  fx.creators[0].telegramUserId = null;
  const material = await assertTelegramDeliveryMaterialAccess({
    agencyId: "agency-1", member: fx.member, intentId: begun.intent.id, creatorId: "creator-1", accountId: "tg-1",
    deviceId: "device-1", deliveryClaimToken: claimed.claimToken, db: fx.db,
  });
  assert.equal(material.recipientTelegramUserId, "1001");
  assert.equal(fx.intents[0].state, "COMMITTING");
});

test("provider receipt is canonical: confirmation replay cannot create a second TASK and carries recipient identity", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  const first = await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, remoteMessageId: "501", remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now.toISOString(), now: fx.now, db: fx.db });
  assert.equal(first.intent.state, "CONFIRMED"); assert.equal(first.intent.remoteRecipientTelegramUserId, "900001");
  assert.equal(fx.orders[0].telegramTaskMessageId, 501);
  const replay = await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, remoteMessageId: "501", remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now.toISOString(), now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(replay.idempotent, true); assert.equal(fx.intents.length, 1);
  const plannedAgain = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  assert.equal(plannedAgain.created, false); assert.equal(plannedAgain.intent.id, flow.planned.intent.id);
});

test("external outcome UNKNOWN is fail-closed and cannot be claimed for blind retry", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  const unknown = await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "HELPER_EXITED_AFTER_DISPATCH", now: fx.now, db: fx.db });
  assert.equal(unknown.intent.state, "RECONCILE_REQUIRED");
  const second = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(second.claimed, false); assert.equal(second.intent.state, "RECONCILE_REQUIRED");
});

test("stale COMMITTING becomes RECONCILE_REQUIRED, but a durable provider receipt can still settle the same claim", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  fx.intents[0].commitStartedAt = new Date(fx.now.getTime() - CLAIM_MS - 1);
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, now: fx.now, db: fx.db });
  assert.equal(listed.items[0].state, "RECONCILE_REQUIRED");
  const settled = await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, remoteMessageId: 502, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });
  assert.equal(settled.intent.state, "CONFIRMED"); assert.equal(fx.orders[0].telegramTaskMessageId, 502);
});

test("PROVEN_NOT_SENT is the only automatic path back to retryable PLANNED", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  const noEffect = await markTelegramDeliveryProvenNotSent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "provider rejected before send", db: fx.db });
  assert.equal(noEffect.intent.state, "PLANNED");
  const second = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(second.claimed, true); assert.equal(second.intent.claimRevision, 2);
});

test("access revocation before COMMITTING blocks send, but revocation after COMMITTING cannot erase a provider receipt", async () => {
  const before = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: before.member, orderId: "order-1", kind: "TASK", now: before.now, db: before.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: before.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: before.now, db: before.db });
  before.member.accessEpoch += 1;
  await assert.rejects(() => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: before.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: before.now, db: before.db }), (e) => e?.code === "EXECUTION_ACCESS_EPOCH_STALE" || e?.code === "TELEGRAM_EXECUTION_LEASE_INVALID");
  // Actor/runtime/access loss before COMMITTING is precommit failure, not cancellation of
  // the business intent. Another currently-authorized runtime may safely claim the same row.
  assert.equal(before.intents[0].state, "PLANNED");
  assert.match(String(before.intents[0].outcomeReason || ""), /^FAILED_PRECOMMIT:/);

  const after = dbFixture(); const flow = await taskToCommitting(after);
  after.member.assignedCreators = [];
  // Settlement deliberately does not re-run current creator access after commit permit.
  const settled = await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: after.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, remoteMessageId: 503, remoteRecipientTelegramUserId: "900001", now: after.now, db: after.db });
  assert.equal(settled.intent.state, "CONFIRMED");
});



test("manual reconciliation can confirm an unresolved provider receipt and preserves recipient identity", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "operator must inspect provider", now: fx.now, db: fx.db });
  const reconciled = await reconcileTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, resolution: "CONFIRMED",
    remoteMessageId: "504", remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now.toISOString(), reason: "verified in Telegram", now: fx.now, db: fx.db,
  });
  assert.equal(reconciled.intent.state, "CONFIRMED");
  assert.equal(reconciled.intent.remoteMessageId, "504");
  assert.equal(reconciled.intent.remoteRecipientTelegramUserId, "900001");
  assert.equal(fx.orders[0].telegramTaskMessageId, 504);
});



test("TASK settling after order cancellation durably plans a CANCELLATION instead of losing the model notification", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  // Cancellation happens after the external commit permit. The in-flight TASK must settle,
  // but future work is controlled by the now-cancelled business state.
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "No longer needed";
  const settled = await confirmTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken,
    remoteMessageId: 505, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db,
  });
  assert.equal(settled.intent.state, "CONFIRMED");
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.ok(cancellation);
  assert.equal(cancellation.state, "PLANNED");
  assert.equal(cancellation.payload.replyToMessageId, "505");
});

test("concurrent cancellation between TASK projection read and write cannot lose the durable CANCELLATION", async () => {
  let cancelled = false;
  const fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ data, orders }) => {
      if (cancelled || data.telegramTaskMessageId == null) return;
      cancelled = true;
      const order = orders[0];
      assert.equal(order.telegramTaskMessageId, null, "the cancelling manager observes no task receipt yet");
      order.status = "CANCELLED";
      order.cancelReason = "manager cancelled in the receipt race";
      order.nextReminderAt = null;
      order.updatedAt = new Date(new Date(order.updatedAt).getTime() + 1000);
      // This intentionally does not plan a cancellation: the manager side saw taskMessageId=null.
    },
  });
  const flow = await taskToCommitting(fx);
  const settled = await confirmTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken,
    remoteMessageId: 506, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db,
  });
  assert.equal(settled.intent.state, "CONFIRMED");
  assert.equal(fx.orders[0].status, "CANCELLED");
  assert.equal(fx.orders[0].telegramTaskMessageId, 506);
  assert.equal(fx.orders[0].nextReminderAt, null, "stale TASK projection must not resurrect reminders on a cancelled order");
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.ok(cancellation, "fresh post-receipt projection must heal the cancellation race");
  assert.equal(cancellation.state, "PLANNED");
  assert.equal(cancellation.payload.replyToMessageId, "506");
});


test("later reference cannot obtain a physical claim while an earlier reference is unresolved", async () => {
  const fx = dbFixture();
  // Establish the task projection first.
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 600, remoteRecipientTelegramUserId: "900001", now: fx.now, db: fx.db });
  const r0 = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "11111111-1111-4111-8111-111111111111", reference: { ordinal: 0, name: "a.jpg", size: 1, sha256: "a".repeat(64) }, now: fx.now, db: fx.db });
  const r1 = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-222222222222", reference: { ordinal: 1, name: "b.jpg", size: 1, sha256: "b".repeat(64) }, now: fx.now, db: fx.db });
  const c0 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r0.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(c0.claimed, true);
  const b0 = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r0.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c0.claimToken, now: fx.now, db: fx.db }); assert.equal(b0.begun, true);
  await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: r0.intent.id, deviceId: "device-1", claimToken: c0.claimToken, reason: "ack lost", db: fx.db });
  const blocked = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(blocked.claimed, false); assert.equal(blocked.busy, true);
});


test("inbound observed before provider receipt is re-correlated after late CONFIRMED settlement", async () => {
  const fx = dbFixture();
  const flow = await taskToCommitting(fx);
  const sentAt = new Date(fx.now.getTime() + 1_000);
  fx.inboundEvents.push({
    id: "inbound-orphan-1",
    agencyId: "agency-1",
    accountId: "tg-1",
    creatorId: null,
    customOrderId: null,
    submissionId: null,
    senderTelegramUserId: "900001",
    messageId: 801,
    replyToMessageId: 506,
    groupedId: null,
    text: "received",
    hasMedia: false,
    mediaKind: null,
    sentAt,
    observedAt: sentAt,
    createdAt: sentAt,
    updatedAt: sentAt,
  });

  const settled = await confirmTelegramDeliveryIntent({
    agencyId: "agency-1",
    member: fx.member,
    intentId: flow.planned.intent.id,
    deviceId: "device-1",
    claimToken: flow.claimed.claimToken,
    remoteMessageId: 506,
    remoteRecipientTelegramUserId: "900001",
    remoteSentAt: fx.now,
    now: new Date(fx.now.getTime() + 2_000),
    db: fx.db,
  });

  assert.equal(settled.intent.state, "CONFIRMED");
  assert.equal(fx.inboundEvents[0].creatorId, "creator-1");
  assert.equal(fx.inboundEvents[0].customOrderId, "order-1");
  assert.equal(fx.orders[0].telegramLastModelMessageId, 801);
  assert.equal(new Date(fx.orders[0].telegramLastModelMessageAt).getTime(), sentAt.getTime());
});


test("older reminder receipt settling later cannot regress reminder freshness or schedule", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 700, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });

  const r1 = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "33333333-3333-4333-8333-333333333333", now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  const r2 = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "44444444-4444-4444-8444-444444444444", now: new Date(fx.now.getTime() + 2_000), db: fx.db });
  const c1 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const c2 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c1.claimToken, now: fx.now, db: fx.db });
  await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c2.claimToken, now: fx.now, db: fx.db });

  const newerAt = new Date(fx.now.getTime() + 120_000);
  const olderAt = new Date(fx.now.getTime() + 60_000);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", claimToken: c2.claimToken, remoteMessageId: 702, remoteRecipientTelegramUserId: "900001", remoteSentAt: newerAt, now: new Date(fx.now.getTime() + 121_000), db: fx.db });
  const nextAfterNewer = fx.orders[0].nextReminderAt ? new Date(fx.orders[0].nextReminderAt).getTime() : null;
  assert.equal(new Date(fx.orders[0].lastReminderAt).getTime(), newerAt.getTime());

  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", claimToken: c1.claimToken, remoteMessageId: 701, remoteRecipientTelegramUserId: "900001", remoteSentAt: olderAt, now: new Date(fx.now.getTime() + 180_000), db: fx.db });
  assert.equal(new Date(fx.orders[0].lastReminderAt).getTime(), newerAt.getTime());
  assert.equal(fx.orders[0].nextReminderAt ? new Date(fx.orders[0].nextReminderAt).getTime() : null, nextAfterNewer);
});

test("derived inbound repair failure cannot downgrade a durable Telegram provider receipt", async () => {
  const fx = dbFixture();
  const flow = await taskToCommitting(fx);
  fx.db.telegramInboundEvent.findMany = async () => {
    throw Object.assign(new Error("inbound projection unavailable"), { code: "TEST_INBOUND_REPAIR_FAILURE" });
  };

  const settled = await confirmTelegramDeliveryIntent({
    agencyId: "agency-1",
    member: fx.member,
    intentId: flow.planned.intent.id,
    deviceId: "device-1",
    claimToken: flow.claimed.claimToken,
    remoteMessageId: 990,
    remoteRecipientTelegramUserId: "900001",
    remoteSentAt: fx.now,
    now: new Date(fx.now.getTime() + 1_000),
    db: fx.db,
  });

  assert.equal(settled.intent.state, "CONFIRMED");
  assert.equal(Number(settled.intent.remoteMessageId), 990);
  const canonical = fx.intents.find((row) => row.id === flow.planned.intent.id);
  assert.equal(canonical.state, "CONFIRMED");
  assert.equal(Number(canonical.remoteMessageId), 990);
});


test("AUTO_REMINDER provider outcome left COMMITTING after ack loss becomes reconcile-only after lease expiry, never retryable", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 719, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });
  fx.orders[0].createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.orders[0].nextReminderAt = new Date(fx.now);
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const reminder = listed.items.find((row) => row.kind === "AUTO_REMINDER");
  assert.ok(reminder);
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
  assert.equal(begun.begun, true);
  // Provider may have accepted the reminder, but the confirmation/failure receipt is lost. Do not call confirm/unknown/fail.
  const later = new Date(fx.now.getTime() + CLAIM_MS + 1);
  const recovery = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: later, db: fx.db });
  assert.equal(recovery.items.find((row) => row.id === reminder.id)?.state, "RECONCILE_REQUIRED");
  // A fresh current runtime appears after the old lease expired. Intent state, not stale runtime ownership,
  // must still be the fence that prevents a second physical reminder send.
  fx.accounts[0].runtimeClaimedByDeviceId = "device-2";
  fx.accounts[0].runtimeClaimToken = "runtime-2";
  fx.accounts[0].runtimeClaimUntil = new Date(later.getTime() + 60_000);
  const retryClaim = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-2", runtimeClaimToken: "runtime-2", now: later, db: fx.db });
  assert.equal(retryClaim.claimed, false);
  assert.equal(retryClaim.intent.state, "RECONCILE_REQUIRED");
});

test("AUTO_REMINDER settings changed before COMMITTING cancel only the obsolete planned intent", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 720, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });
  fx.orders[0].createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.orders[0].nextReminderAt = new Date(fx.now);
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const reminder = listed.items.find((row) => row.kind === "AUTO_REMINDER");
  assert.ok(reminder);
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  fx.db._workspaceSettingValue = { content: { enabled: false } };
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CONTROL_CHANGED",
  );
  const canonical = fx.intents.find((row) => row.id === reminder.id);
  assert.equal(canonical.state, "CANCELLED");
});

test("AUTO_REMINDER settings changed after COMMITTING cannot erase the in-flight provider outcome", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 721, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });
  fx.orders[0].createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.orders[0].nextReminderAt = new Date(fx.now);
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const reminder = listed.items.find((row) => row.kind === "AUTO_REMINDER");
  assert.ok(reminder);
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
  assert.equal(begun.begun, true);
  fx.db._workspaceSettingValue = { content: { enabled: false } };
  const settled = await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", claimToken: claimed.claimToken, remoteMessageId: 722, remoteRecipientTelegramUserId: "900001", remoteSentAt: new Date(fx.now.getTime() + 1_000), now: new Date(fx.now.getTime() + 2_000), db: fx.db });
  assert.equal(settled.intent.state, "CONFIRMED");
  assert.equal(Number(settled.intent.remoteMessageId), 722);
});

test("Custom cancellation before TASK COMMITTING prevents the Telegram provider send", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "fan cancelled before send";
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CONTROL_CHANGED",
  );
  assert.equal(fx.intents[0].state, "CANCELLED");
  assert.equal(fx.orders[0].telegramTaskMessageId, null);
});

test("runtime takeover cannot reclaim an unresolved COMMITTING delivery for blind resend", async () => {
  const fx = dbFixture();
  const flow = await taskToCommitting(fx);
  fx.accounts[0].runtimeClaimedByDeviceId = "device-2";
  fx.accounts[0].runtimeClaimToken = "runtime-2";
  fx.accounts[0].runtimeClaimUntil = new Date(fx.now.getTime() + CLAIM_MS * 3);
  fx.intents[0].commitStartedAt = new Date(fx.now.getTime() - CLAIM_MS - 1);
  const later = new Date(fx.now.getTime() + CLAIM_MS + 1);
  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: later, db: fx.db });
  assert.equal(work.items.find((row) => row.id === flow.planned.intent.id)?.state, "RECONCILE_REQUIRED");
  const takeover = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-2", runtimeClaimToken: "runtime-2", now: later, db: fx.db });
  assert.equal(takeover.claimed, false);
  assert.equal(takeover.intent.state, "RECONCILE_REQUIRED");
});
