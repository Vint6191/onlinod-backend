"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CLAIM_MS,
  planTelegramDeliveryIntent,
  planRevisionRequestIntentForReviewedSubmission,
  planCancellationIntentForCommittedOrder,
  listTelegramDeliveryWork,
  claimTelegramDeliveryIntent,
  beginTelegramDeliveryIntent,
  confirmTelegramDeliveryIntent,
  repairConfirmedTelegramDeliveryProjections,
  repairCustomModelCommunicationConvergence,
  ensureInitialTaskIntents,
  repairPrecommitProviderBlockedIntents,
  markTelegramDeliveryUnknown,
  markTelegramDeliveryProvenNotSent,
  failTelegramDeliveryPrecommit,
  listTelegramDeliveryReconciliationQueue,
  listTelegramConfirmedProjectionBlockedQueue,
  retryTelegramConfirmedProjection,
  listTelegramDeliveryPrecommitBlockedQueue,
  listTelegramReminderPlanningBlockedQueue,
  reconcileTelegramDeliveryIntent,
  replaceTelegramReferencePrecommit,
  cancelTelegramReferencePrecommit,
  getTelegramOrderContext,
  assertTelegramDeliveryMaterialAccess,
} = require("./telegram-delivery-authority-service");
const { updateCustomOrder } = require("./custom-orders-service");

function clone(v) { return v == null ? v : structuredClone(v); }
function scalar(value) { return value instanceof Date ? value.getTime() : value; }
function matches(row, where = {}) {
  for (const [key, expected] of Object.entries(where || {})) {
    if (key === "OR") { if (!expected.some((part) => matches(row, part))) return false; continue; }
    if (key === "NOT") { if (matches(row, expected)) return false; continue; }
    if (key === "agency") continue;
    const actual = row[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if ("in" in expected && !expected.in.map(String).includes(String(actual))) return false;
      if ("not" in expected) {
        if (expected.not === null ? actual == null : String(actual) === String(expected.not)) return false;
      }
      if ("lt" in expected && !(scalar(actual) < scalar(expected.lt))) return false;
      if ("lte" in expected && !(scalar(actual) <= scalar(expected.lte))) return false;
      if ("gt" in expected && !(scalar(actual) > scalar(expected.gt))) return false;
      if ("gte" in expected && !(scalar(actual) >= scalar(expected.gte))) return false;
      if ("startsWith" in expected && !String(actual || "").startsWith(String(expected.startsWith))) return false;
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
    { id: "tg-1", agencyId: "agency-1", lifecycleState: "ACTIVE", runtimeClaimedByDeviceId: "device-1", runtimeClaimToken: "runtime-1", runtimeClaimUntil: new Date(now.getTime() + 60_000), runtimeLeaseUserId: member.userId, runtimeLeaseMemberId: member.id, runtimeLeaseAccessEpoch: member.accessEpoch, runtimeLeaseCreatorId: "creator-1" },
    { id: "tg-2", agencyId: "agency-1", lifecycleState: "ACTIVE", runtimeClaimedByDeviceId: "device-2", runtimeClaimToken: "runtime-2", runtimeClaimUntil: new Date(now.getTime() + 60_000), runtimeLeaseUserId: member.userId, runtimeLeaseMemberId: member.id, runtimeLeaseAccessEpoch: member.accessEpoch, runtimeLeaseCreatorId: "creator-1" },
  ];
  const orders = [{ id: "order-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "dialog-1", scenario: "custom", type: "CONTENT", status: "PENDING", telegramTaskMessageId: null, telegramReferenceMessageIds: [], deliveredAt: null, lastReminderAt: null, lastReminderKey: null, nextReminderAt: null, reminderConfig: null, createdAt: new Date(now.getTime() - 60_000), updatedAt: new Date(now.getTime() - 60_000), creator: creators[0] }];
  const intents = [];
  const inboundEvents = [];
  const submissions = [];
  const audits = [];
  let seq = 0;
  const db = {
    _member: member, _creators: creators, _accounts: accounts, _orders: orders, _intents: intents, _inboundEvents: inboundEvents, _submissions: submissions, _audits: audits, _workspaceSettingValue: null,
    // Production Custom/TASK commit fencing uses a PostgreSQL advisory xact lock.
    // This in-memory fixture executes transactions serially, so model the lock as
    // a successful no-op instead of weakening the production fence for tests.
    async $executeRawUnsafe() { return 1; },
    agency: {
      async findFirst({ where }) { return where.id === "agency-1" ? { id: "agency-1", deletedAt: null, status: "ACTIVE" } : null; },
      async findUnique({ where }) { return where.id === "agency-1" ? { id: "agency-1", deletedAt: null, status: "ACTIVE" } : null; },
    },
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
    customContentSubmission: {
      async findFirst({ where, orderBy = [] }) {
        const rows = submissions.filter((r) => matches(r, where));
        const order = Array.isArray(orderBy) ? orderBy : [orderBy];
        rows.sort((a,b)=>{ for (const part of order) { const [key,dir]=Object.entries(part||{})[0]||[]; if(!key) continue; const av=scalar(a[key]); const bv=scalar(b[key]); if(av==null&&bv!=null)return dir==="desc"?1:-1; if(av!=null&&bv==null)return dir==="desc"?-1:1; if(av<bv)return dir==="desc"?1:-1; if(av>bv)return dir==="desc"?-1:1; } return 0; });
        return clone(rows[0] || null);
      },
      async findMany({ where, take = 100, orderBy = [] }) {
        const rows = submissions.filter((r) => matches(r, where));
        return rows.slice(0, take).map(clone);
      },
    },
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
      async findMany({ where, take = 100, orderBy = [], cursor = null, skip = 0 }) {
        const rows = intents.filter((r) => matches(r, where));
        const order = Array.isArray(orderBy) ? orderBy : [orderBy];
        rows.sort((a,b)=>{ for (const part of order) { const [key,dir]=Object.entries(part||{})[0]||[]; if(!key) continue; const av=scalar(a[key]); const bv=scalar(b[key]); if(av==null&&bv!=null)return dir==="desc"?1:-1; if(av!=null&&bv==null)return dir==="desc"?-1:1; if(av<bv)return dir==="desc"?1:-1; if(av>bv)return dir==="desc"?-1:1; } return 0; });
        const start = cursor?.id ? Math.max(0, rows.findIndex((r)=>String(r.id)===String(cursor.id)) + (skip || 0)) : 0;
        return rows.slice(start, start + take).map(clone);
      },
      async create({ data }) { const r = { id: `intent-${++seq}`, claimRevision: 0, claimUntil: null, claimTokenHash: null, deviceId: null, userId: null, memberId: null, accessEpoch: null, commitStartedAt: null, remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, confirmedAt: null, outcomeReason: null, providerBindingRepairAttempts: 0, providerBindingRetryAt: null, createdAt: new Date(now.getTime() + seq), updatedAt: new Date(now.getTime() + seq), ...clone(data) }; intents.push(r); return clone(r); },
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
    auditLog: { async create({ data }) { const row={ id: `audit-${audits.length+1}`, ...clone(data) }; audits.push(row); return clone(row); } },
    async $transaction(fn) { return fn(this); },
  };
  return { db, member, now, orders, intents, inboundEvents, submissions, accounts, creators };
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

function seedRevisionDecision(fx, { comment = "Redo ending", reviewedAt = null } = {}) {
  const at = reviewedAt || new Date(fx.now.getTime() - 500);
  const row = {
    id: "submission-v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "REVISION_REQUESTED", reviewComment: comment, reviewedAt: at,
    receivedAt: new Date(fx.now.getTime() - 20_000), createdAt: new Date(fx.now.getTime() - 20_000), updatedAt: at,
  };
  fx.submissions.push(row);
  return row;
}

async function revisionToClaimed(fx) {
  seedConfirmedTaskThread(fx, { messageId: 501, telegramUserId: "1001" });
  const submission = seedRevisionDecision(fx);
  const row = await planRevisionRequestIntentForReviewedSubmission({ agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: row.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  return { row, claimed, submission };
}


test("F46 revision commit fence rejects a manager decision changed after claim", async () => {
  const fx = dbFixture();
  const flow = await revisionToClaimed(fx);
  fx.submissions[0].reviewComment = "Different instruction";
  fx.submissions[0].reviewedAt = new Date(fx.now.getTime() + 1000);
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: flow.claimed.claimToken, now: new Date(fx.now.getTime() + 2000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CONTROL_CHANGED" || error?.code === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED",
  );
  assert.notEqual(fx.intents.find((row) => row.id === flow.row.id)?.state, "COMMITTING");
});

test("F46 cancellation before revision COMMITTING cancels precommit work instead of sending stale instruction", async () => {
  const fx = dbFixture();
  const flow = await revisionToClaimed(fx);
  fx.orders[0].status = "CANCELLED";
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, now: new Date(fx.now.getTime() + 1000), db: fx.db });
  assert.equal(listed.items.some((row) => row.id === flow.row.id), false);
  assert.equal(fx.intents.find((row) => row.id === flow.row.id)?.state, "CANCELLED");
});

test("F46 cancellation after revision COMMITTING cannot erase an exact provider receipt and follows the settled revision", async () => {
  const fx = dbFixture();
  const flow = await revisionToClaimed(fx);
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: flow.claimed.claimToken, now: fx.now, db: fx.db });
  assert.equal(begun.begun, true);
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "manager cancelled while revision outcome was settling";
  const beforeSettlement = await planCancellationIntentForCommittedOrder({ agencyId: "agency-1", member: fx.member, order: fx.orders[0], now: fx.now, db: fx.db });
  assert.equal(beforeSettlement, null, "unresolved revision outcome must fence cancellation provider binding");
  assert.equal(fx.intents.some((row) => row.kind === "CANCELLATION"), false);

  const settled = await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, remoteMessageId: 777, remoteRecipientTelegramUserId: "1001", remoteSentAt: new Date(fx.now.getTime() + 1000), now: new Date(fx.now.getTime() + 2000), db: fx.db });
  assert.equal(settled.intent.state, "CONFIRMED");
  assert.equal(settled.intent.remoteMessageId, "777");
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.ok(cancellation, "late confirmed revision must converge the cancellation follow-up");
  assert.equal(cancellation.state, "PLANNED");
  assert.equal(cancellation.payload.replyToMessageId, "777", "cancellation must reply to the strongest confirmed revision instruction, not the older TASK");
});

test("historical no-TASK Custom cancellation follows a confirmed revision delivered through the pinned source thread", async () => {
  const fx = dbFixture();
  const submission = seedRevisionDecision(fx, { comment: "Redo historical clip" });
  submission.telegramSourceAccountId = "tg-1";
  submission.telegramSourceUserId = "2002";
  submission.telegramMessageIds = [7101, 7102];

  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db,
  });
  assert.equal(revision.payload.replyToMessageId, "7102");
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", claimToken: claimed.claimToken, remoteMessageId: 7103, remoteRecipientTelegramUserId: "2002", remoteSentAt: fx.now, now: fx.now, db: fx.db });

  assert.equal(fx.orders[0].telegramTaskMessageId, null, "historical recovery intentionally has no TASK projection");
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "historical Custom cancelled";
  const cancellation = await planCancellationIntentForCommittedOrder({ agencyId: "agency-1", member: fx.member, order: fx.orders[0], now: new Date(fx.now.getTime() + 1000), db: fx.db });
  assert.ok(cancellation);
  assert.equal(cancellation.kind, "CANCELLATION");
  assert.equal(cancellation.accountId, "tg-1");
  assert.equal(cancellation.payload.replyToMessageId, "7103");
  assert.equal(cancellation.payload.recipientTelegramUserId, "2002");
});

test("PROVEN_NOT_SENT revision after order cancellation converges cancellation back to the confirmed TASK thread", async () => {
  const fx = dbFixture();
  const flow = await revisionToClaimed(fx);
  await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: flow.claimed.claimToken, now: fx.now, db: fx.db });
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "cancel while revision transport is unresolved";
  const blocked = await planCancellationIntentForCommittedOrder({ agencyId: "agency-1", member: fx.member, order: fx.orders[0], now: fx.now, db: fx.db });
  assert.equal(blocked, null);

  const noEffect = await markTelegramDeliveryProvenNotSent({
    agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", claimToken: flow.claimed.claimToken,
    reason: "transport proved Telegram send was never invoked", db: fx.db,
  });
  assert.equal(noEffect.intent.state, "PLANNED");
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.ok(cancellation);
  assert.equal(cancellation.payload.replyToMessageId, "501", "proven-no-effect revision must fall back to the older confirmed TASK thread");
});

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

test("historical FAILED_PRECOMMIT work remains discoverable and refreshes to the current Telegram account", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  fx.intents[0].state = "FAILED_PRECOMMIT";
  fx.intents[0].outcomeReason = "LEGACY_PRECOMMIT_FAILURE";
  fx.creators[0].telegramAccountId = "tg-2";

  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].id, planned.intent.id);
  assert.equal(work.items[0].accountId, "tg-2");
  assert.equal(work.items[0].state, "PLANNED");
  assert.match(String(work.items[0].outcomeReason || ""), /^PRECOMMIT_TASK_REFRESH$/);
  assert.equal(fx.intents.length, 1, "historical retry must refresh the canonical row rather than create a second intent");
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

test("REFERENCE slot has one canonical identity across different clientIntentIds and conflicting proof is bounded", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx);
  const firstClientIntentId = "22222222-2222-4222-8222-222222222222";
  const secondClientIntentId = "22222222-2222-4222-8222-333333333333";
  const reference = { ordinal: 0, name: "a.jpg", size: 10, sha256: "a".repeat(64) };
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: firstClientIntentId, reference, now: fx.now, db: fx.db });
  const replay = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: secondClientIntentId, reference, now: new Date(fx.now.getTime() + 500), db: fx.db });
  assert.equal(replay.intent.id, first.intent.id, "same business slot + same proof must resolve to the same canonical intent");
  assert.equal(fx.intents.filter((row) => row.kind === "REFERENCE").length, 1);
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: secondClientIntentId, reference: { ...reference, sha256: "b".repeat(64) }, now: new Date(fx.now.getTime() + 1_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_REFERENCE_SLOT_CONFLICT" && error?.status === 409,
  );
  assert.equal(fx.intents.filter((row) => row.kind === "REFERENCE").length, 1, "conflict must terminate without recursive P2002 creation");
});

test("REFERENCE replay resolves a legacy client-keyed logicalKey through the canonical ordinal slot without data migration", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx);
  const reference = { ordinal: 0, name: "legacy.jpg", size: 10, sha256: "e".repeat(64) };
  const firstClientIntentId = "22222222-2222-4222-8222-aaaaaaaaaaaa";
  const secondClientIntentId = "22222222-2222-4222-8222-bbbbbbbbbbbb";
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: firstClientIntentId, reference, now: fx.now, db: fx.db });

  // Simulate a row written by the pre-closure generation where REFERENCE logicalKey was
  // client-UUID based. The DB slot (order + kind + ordinal) is still the canonical business
  // identity, so current code must recover it without requiring a risky data rewrite.
  first.intent.logicalKey = `telegram:order-1:REFERENCE:${firstClientIntentId}`;

  const replay = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: secondClientIntentId, reference, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(replay.intent.id, first.intent.id);
  assert.equal(fx.intents.filter((row) => row.kind === "REFERENCE").length, 1);
});

test("REFERENCE concurrent same-slot planning resolves a real P2002 race once and never recurses", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx);
  const reference = { ordinal: 0, name: "race.jpg", size: 10, sha256: "d".repeat(64) };
  const originalCreate = fx.db.telegramDeliveryIntent.create.bind(fx.db.telegramDeliveryIntent);
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let createCalls = 0;
  fx.db.telegramDeliveryIntent.create = async ({ data }) => {
    createCalls += 1;
    arrivals += 1;
    if (arrivals === 2) release();
    await gate;
    const duplicateSlot = fx.intents.some((row) => row.customOrderId === data.customOrderId && row.kind === "REFERENCE" && Number(row.referenceOrdinal) === Number(data.referenceOrdinal));
    if (duplicateSlot) { const error = new Error("unique slot race"); error.code = "P2002"; throw error; }
    return originalCreate({ data });
  };

  const [a, b] = await Promise.all([
    planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-888888888888", reference, now: fx.now, db: fx.db }),
    planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-999999999999", reference, now: fx.now, db: fx.db }),
  ]);
  assert.equal(a.intent.id, b.intent.id);
  assert.equal(fx.intents.filter((row) => row.kind === "REFERENCE").length, 1);
  assert.equal(createCalls, 2, "both callers must reach create so the test exercises P2002 recovery");
});

test("REFERENCE missing-artifact recovery can explicitly replace the same precommit slot", async () => {
  const fx = dbFixture(); seedConfirmedTaskThread(fx);
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-444444444444", reference: { ordinal: 0, name: "lost.jpg", size: 10, sha256: "a".repeat(64) }, now: fx.now, db: fx.db });
  const replaced = await replaceTelegramReferencePrecommit({ agencyId: "agency-1", member: fx.member, intentId: first.intent.id, clientIntentId: "22222222-2222-4222-8222-555555555555", reference: { name: "replacement.jpg", size: 11, sha256: "c".repeat(64) }, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(replaced.intent.id, first.intent.id);
  assert.equal(replaced.intent.referenceOrdinal, 0);
  assert.equal(replaced.intent.clientIntentId, "22222222-2222-4222-8222-555555555555");
  assert.equal(replaced.intent.payload.reference.sha256, "c".repeat(64));
  assert.equal(replaced.intent.state, "PLANNED");
});

test("REFERENCE precommit skip is terminal-resolved and does not permanently block the next ordinal", async () => {
  const fx = dbFixture(); seedConfirmedTaskThread(fx);
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-666666666666", reference: { ordinal: 0, name: "lost.jpg", size: 10, sha256: "a".repeat(64) }, now: fx.now, db: fx.db });
  const second = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-777777777777", reference: { ordinal: 1, name: "next.jpg", size: 12, sha256: "b".repeat(64) }, now: fx.now, db: fx.db });
  const cancelled = await cancelTelegramReferencePrecommit({ agencyId: "agency-1", member: fx.member, intentId: first.intent.id, reason: "artifact missing", now: fx.now, db: fx.db });
  assert.equal(cancelled.intent.state, "CANCELLED");
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: second.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true, "CANCELLED predecessor is resolved and must not fence later references");
});


test("REFERENCE precommit replacement rejects a stale management actor and preserves the durable artifact", async () => {
  const fx = dbFixture(); seedConfirmedTaskThread(fx);
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-121212121212", reference: { ordinal: 0, name: "original.jpg", size: 10, sha256: "a".repeat(64) }, now: fx.now, db: fx.db });
  const actorSnapshot = clone(fx.member);
  fx.db._member.accessEpoch += 1;
  fx.db._member.assignedCreators = [];
  await assert.rejects(
    () => replaceTelegramReferencePrecommit({ agencyId: "agency-1", member: actorSnapshot, intentId: first.intent.id, clientIntentId: "22222222-2222-4222-8222-131313131313", reference: { name: "replacement.jpg", size: 12, sha256: "b".repeat(64) }, now: new Date(fx.now.getTime() + 1000), db: fx.db }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
  const durable = fx.intents.find((row) => row.id === first.intent.id);
  assert.equal(durable.payload.reference.name, "original.jpg");
  assert.equal(durable.clientIntentId, "22222222-2222-4222-8222-121212121212");
  assert.equal(durable.state, "PLANNED");
});

test("REFERENCE precommit cancellation rejects a stale management actor and preserves the planned slot", async () => {
  const fx = dbFixture(); seedConfirmedTaskThread(fx);
  const first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE", clientIntentId: "22222222-2222-4222-8222-141414141414", reference: { ordinal: 0, name: "keep.jpg", size: 10, sha256: "c".repeat(64) }, now: fx.now, db: fx.db });
  const actorSnapshot = clone(fx.member);
  fx.db._member.accessEpoch += 1;
  fx.db._member.assignedCreators = [];
  await assert.rejects(
    () => cancelTelegramReferencePrecommit({ agencyId: "agency-1", member: actorSnapshot, intentId: first.intent.id, reason: "stale skip", now: new Date(fx.now.getTime() + 1000), db: fx.db }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
  const durable = fx.intents.find((row) => row.id === first.intent.id);
  assert.equal(durable.state, "PLANNED");
  assert.notEqual(String(durable.outcomeReason || ""), "REFERENCE_SKIPPED:stale skip");
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

test("Telegram order context scans beyond 200 references for exact history authorization and precommit recovery", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { accountId: "tg-1", messageId: 501, telegramUserId: "1001" });
  const base = fx.now.getTime() - 20_000;
  for (let index = 0; index < 205; index += 1) {
    fx.intents.push({
      id: `confirmed-reference-${String(index).padStart(4, "0")}`,
      agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "REFERENCE",
      logicalKey: `custom-telegram:agency-1:order-1:REFERENCE:slot:${index}`, clientIntentId: null, referenceOrdinal: index,
      payloadFingerprint: `reference-proof-${index}`, payload: { reference: { name: `ref-${index}.jpg`, size: index + 1, sha256: "a".repeat(64) }, replyToMessageId: "501", recipientTelegramUserId: "1001" }, state: "CONFIRMED",
      deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null,
      commitStartedAt: new Date(base + index), remoteMessageId: 10_000 + index, remoteRecipientTelegramUserId: "1001", remoteSentAt: new Date(base + index),
      confirmationAuthority: "PROVIDER_RECEIPT", outcomeReason: null, confirmedAt: new Date(base + index), createdAt: new Date(base + index), updatedAt: new Date(base + index),
    });
  }
  fx.intents.push({
    id: "zzzz-recoverable-reference-0205", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "REFERENCE",
    logicalKey: "custom-telegram:agency-1:order-1:REFERENCE:slot:205", clientIntentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", referenceOrdinal: 205,
    payloadFingerprint: "recoverable-proof", payload: { reference: { name: "recoverable.jpg", size: 9, sha256: "b".repeat(64) }, replyToMessageId: "501", recipientTelegramUserId: "1001" },
    state: "FAILED_PRECOMMIT", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimRevision: 2, claimUntil: null, commitStartedAt: null,
    remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, confirmationAuthority: null, outcomeReason: "FAILED_PRECOMMIT:REFERENCE_ARTIFACT_UNAVAILABLE",
    confirmedAt: null, createdAt: new Date(base + 205), updatedAt: new Date(base + 205),
  });

  const context = await getTelegramOrderContext({ agencyId: "agency-1", member: fx.member, orderId: "order-1", db: fx.db });
  assert.equal(context.telegramReferenceMessageIds.length, 205);
  assert.equal(context.telegramReferenceMessageIds[0], "10000");
  assert.equal(context.telegramReferenceMessageIds.at(-1), String(10_204));
  assert.equal(context.recoverableReferenceIntents.length, 1);
  assert.equal(context.recoverableReferenceIntents[0].id, "zzzz-recoverable-reference-0205");
});

test("TASK commit permit atomically fences a business edit that passed pre-check while the task was only CLAIMED", async () => {
  let planned; let claimed; let beginOnce = false; let fx;
  fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ data }) => {
      if (beginOnce || data.scenario === undefined) return;
      beginOnce = true;
      const begun = await beginTelegramDeliveryIntent({
        agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 1_000), db: fx.db,
      });
      assert.equal(begun.begun, true);
      assert.equal(fx.intents[0].state, "COMMITTING");
    },
  });
  planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);

  await assert.rejects(
    () => updateCustomOrder({ agencyId: "agency-1", member: fx.member, orderId: "order-1", input: { scenario: "must lose the commit race" }, now: new Date(fx.now.getTime() + 2_000), db: fx.db }),
    (error) => error?.code === "CUSTOM_ORDER_CONFLICT" && error?.status === 409,
  );
  assert.equal(fx.orders[0].scenario, "custom", "the stale business write must not cross the external commit boundary");
  assert.equal(fx.intents[0].state, "COMMITTING");
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
  assert.equal(fx.intents[0].state, "FAILED_PRECOMMIT");
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
  assert.equal(listed.items.some((row) => row.id === flow.planned.intent.id), false, "unknown-outcome work belongs only to the manager reconciliation queue");
  const reconcile = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, db: fx.db });
  assert.equal(reconcile.items.find((row) => row.id === flow.planned.intent.id)?.state, "RECONCILE_REQUIRED");
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


test("machine PROVEN_NOT_SENT terminalizes a historical orphan instead of resurrecting PLANNED work", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  fx.orders.splice(0, fx.orders.length);
  const noEffect = await markTelegramDeliveryProvenNotSent({
    agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1",
    claimToken: flow.claimed.claimToken, reason: "provider proved no external effect", db: fx.db,
  });
  assert.equal(noEffect.intent.state, "CANCELLED");
  assert.match(String(noEffect.intent.outcomeReason || ""), /^PROVEN_NOT_SENT_ORPHAN:/);
  assert.equal(fx.intents[0].commitStartedAt, null);
  assert.equal(fx.intents[0].claimTokenHash, null);
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, now: fx.now, db: fx.db });
  assert.equal(listed.items.some((row) => row.id === flow.planned.intent.id), false);
});

test("machine precommit failure terminalizes a claimed historical orphan instead of producing retry poison", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  fx.orders.splice(0, fx.orders.length);
  const failed = await failTelegramDeliveryPrecommit({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1",
    claimToken: claimed.claimToken, reason: "transport unavailable before dispatch", db: fx.db,
  });
  assert.equal(failed.orphanCustomOrder, true);
  assert.equal(failed.intent.state, "CANCELLED");
  assert.equal(failed.intent.outcomeReason, "LEGACY_ORPHAN_CUSTOM_ORDER_PRECOMMIT");
  assert.equal(fx.intents[0].claimTokenHash, null);
  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, now: fx.now, db: fx.db });
  assert.equal(listed.items.some((row) => row.id === planned.intent.id), false);
});


test("claimed intent can be collapsed by the same holder when Desktop proves provider send was never invoked", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const noEffect = await markTelegramDeliveryProvenNotSent({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1",
    claimToken: claimed.claimToken, reason: "begin response unavailable before provider send", db: fx.db,
  });
  assert.equal(noEffect.intent.state, "PLANNED");
  assert.match(String(noEffect.intent.outcomeReason || ""), /^PROVEN_NOT_SENT:/);
  assert.equal(fx.intents[0].claimTokenHash, null);
  assert.equal(fx.intents[0].commitStartedAt, null);
});



test("preclaim Desktop failure is durable FAILED_PRECOMMIT without requiring claim ownership", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const failed = await failTelegramDeliveryPrecommit({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1",
    reason: "PRECOMMIT_LOCAL:CUSTOM_REFERENCE_ARTIFACT_MISSING", now: fx.now, db: fx.db,
  });
  assert.equal(failed.ignored, false);
  assert.equal(failed.intent.state, "FAILED_PRECOMMIT");
  assert.equal(failed.intent.commitStartedAt, null);
  assert.match(String(failed.intent.outcomeReason || ""), /^FAILED_PRECOMMIT:PRECOMMIT_LOCAL:/);

  // A concurrent claim wins through the state/revision CAS; an unowned report may never cancel it.
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  const ignored = await failTelegramDeliveryPrecommit({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-2",
    reason: "PRECOMMIT_LOCAL:RUNTIME_UNAVAILABLE", now: fx.now, db: fx.db,
  });
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.intent.state, "CLAIMED");
});

test("machine precommit execution failure is durable FAILED_PRECOMMIT and visible to operators", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const failed = await failTelegramDeliveryPrecommit({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1",
    claimToken: claimed.claimToken, reason: "CUSTOM_REFERENCE_ARTIFACT_MISSING", db: fx.db,
  });
  assert.equal(failed.orphanCustomOrder, false);
  assert.equal(failed.intent.state, "FAILED_PRECOMMIT");
  assert.equal(failed.intent.outcomeReason, "FAILED_PRECOMMIT:CUSTOM_REFERENCE_ARTIFACT_MISSING");
  const queue = await listTelegramDeliveryPrecommitBlockedQueue({ agencyId: "agency-1", member: fx.member, db: fx.db });
  const visible = queue.items.find((row) => row.id === planned.intent.id);
  assert.equal(visible?.state, "FAILED_PRECOMMIT");
  assert.equal(visible?.blockedCode, "CUSTOM_REFERENCE_ARTIFACT_MISSING");
  assert.equal(visible?.externalEffectStarted, false);
});

test("access revocation before COMMITTING blocks send, but revocation after COMMITTING cannot erase a provider receipt", async () => {
  const before = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: before.member, orderId: "order-1", kind: "TASK", now: before.now, db: before.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: before.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: before.now, db: before.db });
  before.member.accessEpoch += 1;
  await assert.rejects(() => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: before.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: before.now, db: before.db }), (e) => e?.code === "EXECUTION_ACCESS_EPOCH_STALE" || e?.code === "TELEGRAM_EXECUTION_LEASE_INVALID");
  // Actor/runtime/access loss before COMMITTING is durable operational failure, not cancellation
  // of the business intent. Another currently-authorized runtime may safely claim the same row.
  assert.equal(before.intents[0].state, "FAILED_PRECOMMIT");
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





test("RECONCILE_REQUIRED appears in the manager queue and manual resolution requires an explicit reason", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "provider outcome unknown", now: fx.now, db: fx.db });
  const queue = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 20, db: fx.db });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].id, flow.planned.intent.id);
  assert.equal(queue.items[0].state, "RECONCILE_REQUIRED");
  assert.equal(queue.items[0].customOrder?.customOrderId, "order-1");
  assert.equal(queue.items[0].creator?.id, "creator-1");
  assert.equal(queue.canResolve, true);
  await assert.rejects(
    () => reconcileTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, resolution: "CONFIRMED", remoteMessageId: 504, remoteRecipientTelegramUserId: "900001", reason: "", now: fx.now, db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_RECONCILE_REASON_REQUIRED",
  );
});

test("broad manager can resolve an outbound RECONCILE_REQUIRED after the historical creator is soft-deleted", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "provider outcome unknown", now: fx.now, db: fx.db });
  fx.creators[0].deletedAt = new Date(fx.now);
  const queue = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 20, db: fx.db });
  assert.equal(queue.items.length, 1, "historical exception must remain visible to a broad manager after creator deletion");
  const resolved = await reconcileTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, resolution: "PROVEN_NOT_SENT", reason: "verified no Telegram message exists", now: fx.now, db: fx.db });
  assert.equal(resolved.intent.state, "PLANNED");
  assert.match(String(resolved.intent.outcomeReason || ""), /^PROVEN_NOT_SENT:/);
  assert.ok(fx.db._audits.some((row) => row.action === "custom_order.telegram_delivery_manual_reconcile_not_sent"));
});

test("manual reconciliation audit failure rolls back the reconciliation decision and provider projection", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "provider outcome unknown", now: fx.now, db: fx.db });
  const originalTransaction = fx.db.$transaction.bind(fx.db);
  fx.db.$transaction = async (fn) => {
    const intentsSnapshot = clone(fx.intents);
    const ordersSnapshot = clone(fx.orders);
    const auditsSnapshot = clone(fx.db._audits);
    try { return await originalTransaction(fn); }
    catch (error) {
      fx.intents.splice(0, fx.intents.length, ...intentsSnapshot);
      fx.orders.splice(0, fx.orders.length, ...ordersSnapshot);
      fx.db._audits.splice(0, fx.db._audits.length, ...auditsSnapshot);
      throw error;
    }
  };
  fx.db.auditLog.create = async () => { throw new Error("audit storage unavailable"); };
  await assert.rejects(
    () => reconcileTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, resolution: "CONFIRMED", remoteMessageId: 504, remoteRecipientTelegramUserId: "900001", reason: "verified manually", now: fx.now, db: fx.db }),
    /audit storage unavailable/,
  );
  assert.equal(fx.intents.find((row) => row.id === flow.planned.intent.id)?.state, "RECONCILE_REQUIRED");
  assert.equal(fx.orders[0].telegramTaskMessageId, null, "required audit failure must roll back the manual provider projection too");
});

test("manual reconciliation cannot create duplicate canonical outgoing account/message receipt identity", async () => {
  const fx = dbFixture(); const flow = await taskToCommitting(fx);
  await markTelegramDeliveryUnknown({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1", claimToken: flow.claimed.claimToken, reason: "provider outcome unknown", now: fx.now, db: fx.db });
  fx.intents.push({
    id: "other-confirmed", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-other", accountId: "tg-1", kind: "TASK", logicalKey: "other", payloadFingerprint: "other", payload: {},
    state: "CONFIRMED", claimRevision: 1, remoteMessageId: 777, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, confirmedAt: fx.now, confirmationAuthority: "PROVIDER_RECEIPT", createdAt: fx.now, updatedAt: fx.now,
  });
  await assert.rejects(
    () => reconcileTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, resolution: "CONFIRMED", remoteMessageId: 777, remoteRecipientTelegramUserId: "900001", reason: "verified manually", now: fx.now, db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_REMOTE_MESSAGE_CONFLICT" && error?.status === 409,
  );
  assert.equal(fx.intents.find((row) => row.id === flow.planned.intent.id)?.state, "RECONCILE_REQUIRED");
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
    projectionState: "PENDING",
    projectionReason: "CREATOR_UNRESOLVED",
    projectionAttempts: 1,
    projectedAt: null,
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


test("two distinct claimed reminders racing begin cannot both cross the provider commit boundary", async () => {
  let fx; let first; let second; let firstClaim; let secondClaim; let injected = false;
  fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ data }) => {
      if (injected || data.updatedAt === undefined) return;
      const firstRow = fx.intents.find((row) => row.id === first?.intent?.id);
      if (!firstRow || firstRow.state !== "CLAIMED") return;
      injected = true;
      const secondBegin = await beginTelegramDeliveryIntent({
        agencyId: "agency-1", member: fx.member, intentId: second.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: secondClaim.claimToken, now: new Date(fx.now.getTime() + 2_000), db: fx.db,
      });
      assert.equal(secondBegin.begun, true);
    },
  });
  seedConfirmedTaskThread(fx);
  fx.orders[0].telegramTaskMessageId = 501;
  first = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now: fx.now, db: fx.db });
  second = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", now: new Date(fx.now.getTime() + 1), db: fx.db });
  firstClaim = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: first.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  secondClaim = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: second.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(firstClaim.claimed, true);
  assert.equal(secondClaim.claimed, true);

  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: first.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: firstClaim.claimToken, now: new Date(fx.now.getTime() + 2_000), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED" && error?.status === 409,
  );
  assert.equal(fx.intents.filter((row) => row.kind === "MANUAL_REMINDER" && row.state === "COMMITTING").length, 1);
  assert.equal(fx.intents.find((row) => row.id === second.intent.id).state, "COMMITTING");
  assert.equal(fx.intents.find((row) => row.id === first.intent.id).state, "FAILED_PRECOMMIT", "the losing claim remains retryable but is durably visible as failed precommit work");
});

test("unresolved reminder outcome fences every later reminder commit until settlement", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 700, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });

  // Both can be durably planned before either provider effect starts. The physical lane still serializes at begin().
  const r1 = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "33333333-3333-4333-8333-333333333333", now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  const r2 = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "44444444-4444-4444-8444-444444444444", now: new Date(fx.now.getTime() + 2_000), db: fx.db });
  const c1 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const c2 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c1.claimToken, now: fx.now, db: fx.db });
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c2.claimToken, now: fx.now, db: fx.db }),
    (error) => error?.code === "CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED" && error?.status === 409,
  );
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "55555555-5555-4555-8555-555555555555", now: new Date(fx.now.getTime() + 3_000), db: fx.db }),
    (error) => error?.code === "CUSTOM_ORDER_REMINDER_OUTCOME_UNRESOLVED",
  );

  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", claimToken: c1.claimToken, remoteMessageId: 701, remoteRecipientTelegramUserId: "900001", remoteSentAt: new Date(fx.now.getTime() + 10_000), now: new Date(fx.now.getTime() + 11_000), db: fx.db });
  // The fenced begin deliberately invalidates its precommit claim, so the next attempt must
  // re-claim after the previous provider outcome becomes authoritative.
  const c2AfterSettlement = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() + 12_000), db: fx.db });
  assert.equal(c2AfterSettlement.claimed, true);
  const begun2 = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r2.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c2AfterSettlement.claimToken, now: new Date(fx.now.getTime() + 13_000), db: fx.db });
  assert.equal(begun2.begun, true, "next reminder may commit only after the previous outcome is settled");
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
  const confirmedTask = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  confirmedTask.remoteSentAt = new Date(fx.now.getTime() - 31 * 60_000);
  confirmedTask.confirmedAt = confirmedTask.remoteSentAt;
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
  assert.equal(recovery.items.some((row) => row.id === reminder.id), false, "reconciliation debt must not consume executable work capacity");
  const reconcile = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 25, db: fx.db });
  assert.equal(reconcile.items.find((row) => row.id === reminder.id)?.state, "RECONCILE_REQUIRED");
  // A fresh current runtime appears after the old lease expired. Intent state, not stale runtime ownership,
  // must still be the fence that prevents a second physical reminder send.
  fx.accounts[0].runtimeClaimedByDeviceId = "device-2";
  fx.accounts[0].runtimeClaimToken = "runtime-2";
  fx.accounts[0].runtimeClaimUntil = new Date(later.getTime() + 60_000);
  const retryClaim = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-2", runtimeClaimToken: "runtime-2", now: later, db: fx.db });
  assert.equal(retryClaim.claimed, false);
  assert.equal(retryClaim.intent.state, "RECONCILE_REQUIRED");
});

test("stale claimed reminder cannot COMMIT after reassignment gives the order a model response", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id,
    deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 723,
    remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db,
  });
  const confirmedTask = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  confirmedTask.remoteSentAt = new Date(fx.now.getTime() - 31 * 60_000);
  confirmedTask.confirmedAt = confirmedTask.remoteSentAt;
  fx.orders[0].createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.orders[0].nextReminderAt = new Date(fx.now);

  const listed = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const reminder = listed.items.find((row) => row.kind === "AUTO_REMINDER");
  assert.ok(reminder, "the old obligation must have produced a due reminder before reassignment");
  const claimed = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: reminder.id,
    deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db,
  });
  assert.equal(claimed.claimed, true);

  // Equivalent canonical state after A→B reassignment: this order now owns a model response.
  // A stale already-claimed reminder from the previous no-response obligation must not cross
  // the provider COMMITTING boundary even if a worker still holds its old claim token.
  fx.submissions.push({
    id: "reassigned-response", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW", reviewedAt: null,
    receivedAt: new Date(fx.now.getTime() - 500), createdAt: new Date(fx.now.getTime() - 500), updatedAt: new Date(fx.now.getTime() - 500),
  });
  fx.orders[0].nextReminderAt = null;
  fx.orders[0].updatedAt = new Date(fx.orders[0].updatedAt.getTime() + 10);

  await assert.rejects(
    () => beginTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: reminder.id,
      deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken,
      now: new Date(fx.now.getTime() + 20), db: fx.db,
    }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CONTROL_CHANGED",
  );
  const durable = fx.intents.find((row) => row.id === reminder.id);
  assert.equal(durable.commitStartedAt, null, "stale reminder must never receive provider commit authority");
  assert.notEqual(durable.state, "COMMITTING");
});

test("AUTO_REMINDER settings changed before COMMITTING cancel only the obsolete planned intent", async () => {
  const fx = dbFixture();
  const task = await taskToCommitting(fx);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: task.planned.intent.id, deviceId: "device-1", claimToken: task.claimed.claimToken, remoteMessageId: 720, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });
  const confirmedTask = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  confirmedTask.remoteSentAt = new Date(fx.now.getTime() - 31 * 60_000);
  confirmedTask.confirmedAt = confirmedTask.remoteSentAt;
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
  const confirmedTask = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  confirmedTask.remoteSentAt = new Date(fx.now.getTime() - 31 * 60_000);
  confirmedTask.confirmedAt = confirmedTask.remoteSentAt;
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
  assert.equal(work.items.some((row) => row.id === flow.planned.intent.id), false);
  const reconcile = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 25, db: fx.db });
  assert.equal(reconcile.items.find((row) => row.id === flow.planned.intent.id)?.state, "RECONCILE_REQUIRED");
  const takeover = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-2", runtimeClaimToken: "runtime-2", now: later, db: fx.db });
  assert.equal(takeover.claimed, false);
  assert.equal(takeover.intent.state, "RECONCILE_REQUIRED");
});

async function manualReminderToCommittingForScheduleRace(fx, clientIntentId) {
  seedConfirmedTaskThread(fx, { messageId: 880 });
  const planned = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER",
    clientIntentId, now: fx.now, db: fx.db,
  });
  const claimed = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1",
    runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db,
  });
  assert.equal(claimed.claimed, true);
  const begun = await beginTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1",
    runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db,
  });
  assert.equal(begun.begun, true);
  return { planned, claimed, begun };
}

function installWorkspaceRaceAfterScheduleSnapshot(fx, mutateAfterOldRead) {
  const original = fx.db.workspaceSetting.findUnique.bind(fx.db.workspaceSetting);
  let injected = false;
  fx.db.workspaceSetting.findUnique = async (...args) => {
    const before = await original(...args);
    if (!injected) {
      injected = true;
      mutateAfterOldRead();
    }
    return before;
  };
  return () => { fx.db.workspaceSetting.findUnique = original; };
}

test("late confirmed reminder cannot erase schedule when workspace reminders are enabled concurrently", async () => {
  const fx = dbFixture();
  const flow = await manualReminderToCommittingForScheduleRace(fx, "66666666-6666-4666-8666-666666666666");
  const effectAt = new Date(fx.now.getTime() + 10_000);
  fx.db._workspaceSettingValue = { content: { enabled: false, firstAfterMinutes: 30, repeatEveryMinutes: 60 } };
  fx.orders[0].nextReminderAt = new Date(effectAt.getTime() + 60 * 60_000);

  const restore = installWorkspaceRaceAfterScheduleSnapshot(fx, () => {
    fx.db._workspaceSettingValue = { content: { enabled: true, firstAfterMinutes: 30, repeatEveryMinutes: 30 } };
    fx.orders[0].nextReminderAt = new Date(effectAt.getTime() + 30 * 60_000);
    fx.orders[0].updatedAt = new Date(new Date(fx.orders[0].updatedAt).getTime() + 100);
  });
  try {
    await confirmTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1",
      claimToken: flow.claimed.claimToken, remoteMessageId: 881, remoteRecipientTelegramUserId: "1001",
      remoteSentAt: effectAt, now: new Date(effectAt.getTime() + 1_000), db: fx.db,
    });
  } finally { restore(); }

  assert.equal(new Date(fx.orders[0].lastReminderAt).toISOString(), effectAt.toISOString());
  assert.equal(new Date(fx.orders[0].nextReminderAt).toISOString(), new Date(effectAt.getTime() + 30 * 60_000).toISOString());
});

test("late confirmed reminder recomputes from current shortened workspace repeat interval after CAS loss", async () => {
  const fx = dbFixture();
  const flow = await manualReminderToCommittingForScheduleRace(fx, "77777777-7777-4777-8777-777777777777");
  const effectAt = new Date(fx.now.getTime() + 20_000);
  fx.db._workspaceSettingValue = { content: { enabled: true, firstAfterMinutes: 30, repeatEveryMinutes: 60 } };
  fx.orders[0].nextReminderAt = new Date(effectAt.getTime() + 60 * 60_000);

  const restore = installWorkspaceRaceAfterScheduleSnapshot(fx, () => {
    fx.db._workspaceSettingValue = { content: { enabled: true, firstAfterMinutes: 30, repeatEveryMinutes: 5 } };
    fx.orders[0].nextReminderAt = new Date(effectAt.getTime() + 5 * 60_000);
    fx.orders[0].updatedAt = new Date(new Date(fx.orders[0].updatedAt).getTime() + 100);
  });
  try {
    await confirmTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1",
      claimToken: flow.claimed.claimToken, remoteMessageId: 882, remoteRecipientTelegramUserId: "1001",
      remoteSentAt: effectAt, now: new Date(effectAt.getTime() + 1_000), db: fx.db,
    });
  } finally { restore(); }

  assert.equal(new Date(fx.orders[0].nextReminderAt).toISOString(), new Date(effectAt.getTime() + 5 * 60_000).toISOString());
});

test("late confirmed reminder cannot stale-overwrite concurrent per-order reminderConfig", async () => {
  const fx = dbFixture();
  const flow = await manualReminderToCommittingForScheduleRace(fx, "88888888-8888-4888-8888-888888888888");
  const effectAt = new Date(fx.now.getTime() + 30_000);
  fx.db._workspaceSettingValue = { content: { enabled: true, firstAfterMinutes: 30, repeatEveryMinutes: 60 } };
  fx.orders[0].nextReminderAt = new Date(effectAt.getTime() + 60 * 60_000);

  const restore = installWorkspaceRaceAfterScheduleSnapshot(fx, () => {
    fx.orders[0].reminderConfig = { enabled: true, firstAfterMinutes: 30, repeatEveryMinutes: 7 };
    fx.orders[0].nextReminderAt = new Date(effectAt.getTime() + 7 * 60_000);
    fx.orders[0].updatedAt = new Date(new Date(fx.orders[0].updatedAt).getTime() + 100);
  });
  try {
    await confirmTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: flow.planned.intent.id, deviceId: "device-1",
      claimToken: flow.claimed.claimToken, remoteMessageId: 883, remoteRecipientTelegramUserId: "1001",
      remoteSentAt: effectAt, now: new Date(effectAt.getTime() + 1_000), db: fx.db,
    });
  } finally { restore(); }

  assert.equal(fx.orders[0].reminderConfig.repeatEveryMinutes, 7);
  assert.equal(new Date(fx.orders[0].nextReminderAt).toISOString(), new Date(effectAt.getTime() + 7 * 60_000).toISOString());
});

test("RECONCILE_REQUIRED management queue has lossless cursor continuation beyond the first 100 unknown outcomes", async () => {
  const fx = dbFixture();
  for (let i = 1; i <= 125; i += 1) {
    fx.intents.push({
      id: `reconcile-page-${String(i).padStart(3, "0")}`,
      agencyId: "agency-1",
      creatorId: "creator-1",
      customOrderId: "order-1",
      accountId: "tg-1",
      kind: "AUTO_REMINDER",
      logicalKey: `reconcile-page:${i}`,
      clientIntentId: null,
      referenceOrdinal: null,
      payloadFingerprint: `fp-${i}`,
      payload: { text: `message ${i}` },
      state: "RECONCILE_REQUIRED",
      deviceId: "device-1",
      userId: "user-1",
      memberId: "member-1",
      accessEpoch: 7,
      claimTokenHash: null,
      claimRevision: 1,
      claimUntil: null,
      commitStartedAt: new Date(fx.now.getTime() + i),
      remoteMessageId: null,
      remoteRecipientTelegramUserId: null,
      remoteSentAt: null,
      confirmedAt: null,
      outcomeReason: "TEST_UNKNOWN",
      createdAt: new Date(fx.now.getTime() + i),
      updatedAt: new Date(fx.now.getTime() + i),
    });
  }
  const first = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 100, db: fx.db });
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, "reconcile-page-100");

  const second = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 100, cursor: first.nextCursor, db: fx.db });
  assert.equal(second.items.length, 25);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((row) => row.id),
    Array.from({ length: 125 }, (_, index) => `reconcile-page-${String(index + 1).padStart(3, "0")}`),
  );
});



test("two distinct CONFIRMED REFERENCE receipts preserve both provider message ids in the derived CustomOrder projection", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 810, telegramUserId: "1001" });

  const r0 = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE",
    clientIntentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    reference: { ordinal: 0, name: "a.jpg", size: 10, sha256: "a".repeat(64) }, now: fx.now, db: fx.db,
  });
  const r1 = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE",
    clientIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    reference: { ordinal: 1, name: "b.jpg", size: 11, sha256: "b".repeat(64) }, now: fx.now, db: fx.db,
  });

  const c0 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r0.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const b0 = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r0.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c0.claimToken, now: fx.now, db: fx.db });
  assert.equal(b0.begun, true);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r0.intent.id, deviceId: "device-1", claimToken: c0.claimToken, remoteMessageId: 820, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db });

  const c1 = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  const b1 = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: c1.claimToken, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(b1.begun, true);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: r1.intent.id, deviceId: "device-1", claimToken: c1.claimToken, remoteMessageId: 821, remoteRecipientTelegramUserId: "900001", remoteSentAt: new Date(fx.now.getTime() + 1_000), now: new Date(fx.now.getTime() + 1_000), db: fx.db });

  assert.deepEqual([...fx.orders[0].telegramReferenceMessageIds].sort((a, b) => a - b), [820, 821]);
  assert.equal(fx.intents.find((row) => row.id === r0.intent.id).state, "CONFIRMED");
  assert.equal(fx.intents.find((row) => row.id === r1.intent.id).state, "CONFIRMED");
});


test("confirmed projection failure is durable operator work and retry repairs derived state without downgrading provider truth", async () => {
  let failReferenceProjection = true;
  const fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ data }) => {
      if (failReferenceProjection && Array.isArray(data.telegramReferenceMessageIds)) {
        throw Object.assign(new Error("reference projection unavailable"), { code: "TEST_REFERENCE_PROJECTION_FAILURE" });
      }
    },
  });
  seedConfirmedTaskThread(fx, { messageId: 810, telegramUserId: "1001" });
  fx.orders[0].deliveredAt = new Date(fx.now.getTime() - 1_000);
  const planned = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE",
    clientIntentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
    reference: { ordinal: 0, name: "blocked.jpg", size: 12, sha256: "e".repeat(64) }, now: fx.now, db: fx.db,
  });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  const begun = await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
  assert.equal(begun.begun, true);

  await assert.rejects(
    () => confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", claimToken: claimed.claimToken, remoteMessageId: 824, remoteRecipientTelegramUserId: "900001", remoteSentAt: fx.now, now: fx.now, db: fx.db }),
    (error) => error?.code === "TEST_REFERENCE_PROJECTION_FAILURE",
  );
  const canonical = fx.intents.find((row) => row.id === planned.intent.id);
  assert.equal(canonical.state, "CONFIRMED", "derived projection failure must never roll back provider truth");
  assert.equal(canonical.remoteMessageId, 824);
  assert.equal(canonical.projectionBlockedCode, "TEST_REFERENCE_PROJECTION_FAILURE");
  assert.ok(canonical.projectionBlockedAt);
  assert.equal(canonical.projectionAttempts, 1);
  assert.deepEqual(fx.orders[0].telegramReferenceMessageIds, []);

  const queue = await listTelegramConfirmedProjectionBlockedQueue({ agencyId: "agency-1", member: fx.member, limit: 10, db: fx.db });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].id, planned.intent.id);
  assert.equal(queue.items[0].state, "CONFIRMED");
  assert.equal(queue.items[0].remoteMessageId, "824");
  assert.equal(queue.items[0].projectionBlockedCode, "TEST_REFERENCE_PROJECTION_FAILURE");
  assert.equal(queue.items[0].externalEffectConfirmed, true);

  failReferenceProjection = false;
  const retry = await retryTelegramConfirmedProjection({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(retry.ok, true);
  assert.equal(retry.projectionBlocked, false);
  assert.deepEqual(fx.orders[0].telegramReferenceMessageIds, [824]);
  assert.equal(canonical.state, "CONFIRMED");
  assert.equal(canonical.projectionBlockedCode, null);
  assert.equal(canonical.projectionBlockedAt, null);
  assert.equal(canonical.projectionAttempts, 0);
});

test("confirmed projection repair isolates one broken receipt and continues later canonical receipts", async () => {
  let failNextReferenceProjection = true;
  const fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ data }) => {
      if (failNextReferenceProjection && Array.isArray(data.telegramReferenceMessageIds)) {
        failNextReferenceProjection = false;
        throw Object.assign(new Error("one historical projection is poisoned"), { code: "TEST_ONE_PROJECTION_POISONED" });
      }
    },
  });
  fx.orders[0].telegramReferenceMessageIds = [];
  const at1 = new Date(fx.now.getTime() - 2_000);
  const at2 = new Date(fx.now.getTime() - 1_000);
  fx.intents.push(
    {
      id: "intent-reference-a-poisoned", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "account-1",
      kind: "REFERENCE", logicalKey: "custom-telegram:agency-1:order-1:REFERENCE:poisoned", clientIntentId: null, referenceOrdinal: 0,
      payloadFingerprint: "poisoned", payload: {}, state: "CONFIRMED", deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7,
      claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: at1,
      remoteMessageId: 825, remoteRecipientTelegramUserId: "900001", remoteSentAt: at1, outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", confirmedAt: at1, createdAt: at1, updatedAt: at1,
    },
    {
      id: "intent-reference-b-healthy", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "account-1",
      kind: "REFERENCE", logicalKey: "custom-telegram:agency-1:order-1:REFERENCE:healthy", clientIntentId: null, referenceOrdinal: 1,
      payloadFingerprint: "healthy", payload: {}, state: "CONFIRMED", deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7,
      claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: at2,
      remoteMessageId: 826, remoteRecipientTelegramUserId: "900001", remoteSentAt: at2, outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", confirmedAt: at2, createdAt: at2, updatedAt: at2,
    },
  );

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, false);
  assert.equal(repaired.failed, 1);
  assert.equal(repaired.repaired, 1, "a poisoned receipt must not head-block later confirmed projection debt");
  assert.deepEqual(fx.orders[0].telegramReferenceMessageIds, [826]);
  const poisoned = fx.intents.find((row) => row.id === "intent-reference-a-poisoned");
  const healthy = fx.intents.find((row) => row.id === "intent-reference-b-healthy");
  assert.equal(poisoned.state, "CONFIRMED");
  assert.equal(poisoned.projectionBlockedCode, "TEST_ONE_PROJECTION_POISONED");
  assert.equal(healthy.state, "CONFIRMED");
  assert.equal(healthy.projectionBlockedAt == null, true);
});

test("server repair projects historical CONFIRMED REFERENCE debt without requiring Desktop replay", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 811, telegramUserId: "1001" });
  fx.orders[0].deliveredAt = new Date(fx.now.getTime() - 1_000);
  const at = new Date(fx.now.getTime() + 1_000);
  fx.intents.push({
    id: "confirmed-reference-822", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "REFERENCE",
    logicalKey: "custom-telegram:agency-1:order-1:REFERENCE:0", clientIntentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3", referenceOrdinal: 0,
    payloadFingerprint: "reference-proof", payload: { text: null, replyToDeliveryId: null, replyToMessageId: "811", reference: { ordinal: 0 } }, state: "CONFIRMED",
    deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: at,
    remoteMessageId: 822, remoteRecipientTelegramUserId: "900001", remoteSentAt: at, outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", confirmedAt: at, createdAt: at, updatedAt: at,
  });
  fx.orders[0].telegramReferenceMessageIds = [];

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.scanned, 1);
  assert.equal(repaired.repaired, 1);
  assert.deepEqual(fx.orders[0].telegramReferenceMessageIds, [822]);
});


test("confirmed projection refuses cross-creator business-target corruption and preserves provider truth as blocked debt", async () => {
  const fx = dbFixture();
  fx.orders[0].creatorId = "creator-2";
  const at = new Date(fx.now.getTime() - 30_000);
  fx.intents.push({
    id: "confirmed-cross-creator-corrupt", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "REFERENCE",
    logicalKey: "corrupt-target", payloadFingerprint: "corrupt-target", payload: {}, state: "CONFIRMED",
    deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: at,
    remoteMessageId: 899, remoteRecipientTelegramUserId: "900001", remoteSentAt: at, confirmedAt: at, confirmationAuthority: "PROVIDER_RECEIPT", outcomeReason: null,
    projectionBlockedCode: "TELEGRAM_CONFIRMED_PROJECTION_PENDING", projectionBlockedAt: at, projectionLastAttemptAt: null, projectionAttempts: 0,
    createdAt: at, updatedAt: at,
  });

  const result = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: fx.now, db: fx.db });
  assert.equal(result.failed >= 1, true);
  assert.equal(fx.orders[0].telegramReferenceMessageIds.length, 0, "corrupt receipt must never mutate another creator's CustomOrder");
  const canonical = fx.intents.find((row) => row.id === "confirmed-cross-creator-corrupt");
  assert.equal(canonical.state, "CONFIRMED", "provider truth stays immutable");
  assert.equal(canonical.projectionBlockedCode, "TELEGRAM_DELIVERY_BUSINESS_TARGET_CONFLICT");
  assert.ok(canonical.projectionBlockedAt);
});

test("server repair retries marked CONFIRMED projection debt even when partial business fields already look projected", async () => {
  const fx = dbFixture();
  const sentAt = new Date(fx.now.getTime() - 120_000);
  fx.orders[0].lastReminderAt = sentAt;
  fx.orders[0].nextReminderAt = null;
  fx.intents.push({
    id: "confirmed-reminder-partial-projection", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "MANUAL_REMINDER",
    logicalKey: "partial-reminder", payloadFingerprint: "partial-reminder", payload: { reminderKey: "partial" }, state: "CONFIRMED",
    deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: sentAt,
    remoteMessageId: 824, remoteRecipientTelegramUserId: "900001", remoteSentAt: sentAt, confirmedAt: sentAt, confirmationAuthority: "PROVIDER_RECEIPT", outcomeReason: null,
    projectionBlockedCode: "TELEGRAM_CONFIRMED_PROJECTION_PENDING", projectionBlockedAt: new Date(sentAt.getTime() + 1), projectionLastAttemptAt: null, projectionAttempts: 0,
    createdAt: sentAt, updatedAt: sentAt,
  });

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: fx.now, db: fx.db });
  assert.equal(repaired.scanned >= 1, true);
  assert.equal(repaired.repaired >= 1, true);
  const row = fx.intents.find((intent) => intent.id === "confirmed-reminder-partial-projection");
  assert.equal(row.projectionBlockedAt, null, "marked debt must clear after full replay even when lastReminderAt was already projected");
  assert.equal(row.projectionBlockedCode, null, "marked debt must run the full projection path and clear its pending/block marker");
});

test("server repair heals legacy unmarked TASK reminder schedule debt from current policy without replaying provider truth", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 825, telegramUserId: "1001" });
  const task = fx.intents.find((row) => row.id === "confirmed-task-825");
  fx.orders[0].deliveredAt = new Date(task.remoteSentAt);
  fx.orders[0].nextReminderAt = null;

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: fx.now, db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.reminderScheduleRepaired, 1);
  assert.ok(fx.orders[0].nextReminderAt, "confirmed TASK thread with enabled current policy must recover its derived reminder schedule");
  assert.equal(new Date(fx.orders[0].nextReminderAt).getTime() > fx.now.getTime(), true);
  assert.equal(task.state, "CONFIRMED", "schedule repair must not rewrite canonical provider truth");
});

test("server reminder schedule repair obeys current disabled policy instead of replaying historical receipt timing", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 826, telegramUserId: "1001" });
  const task = fx.intents.find((row) => row.id === "confirmed-task-826");
  fx.orders[0].deliveredAt = new Date(task.remoteSentAt);
  fx.orders[0].nextReminderAt = new Date(fx.now.getTime() + 60_000);
  fx.db._workspaceSettingValue = { content: { enabled: false } };

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: fx.now, db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.reminderScheduleRepaired, 1);
  assert.equal(fx.orders[0].nextReminderAt, null, "current disabled policy is the schedule authority");
  assert.equal(task.state, "CONFIRMED");
});

test("server repair projects historical CONFIRMED reminder provider facts without requiring the original Desktop", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 812, telegramUserId: "1001" });
  fx.orders[0].deliveredAt = new Date(fx.now.getTime() - 5_000);
  fx.orders[0].lastReminderAt = null;
  const sentAt = new Date(fx.now.getTime() + 2_000);
  fx.intents.push({
    id: "confirmed-reminder-823", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "MANUAL_REMINDER",
    logicalKey: "custom-telegram:agency-1:order-1:MANUAL_REMINDER:repair", clientIntentId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4", referenceOrdinal: null,
    payloadFingerprint: "reminder-proof", payload: { text: "reminder", replyToDeliveryId: null, replyToMessageId: "812", recipientTelegramUserId: "900001", reminderKey: "manual:repair" }, state: "CONFIRMED",
    deviceId: "device-1", userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: "confirmed", claimRevision: 1, claimUntil: null, commitStartedAt: sentAt,
    remoteMessageId: 823, remoteRecipientTelegramUserId: "900001", remoteSentAt: sentAt, outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", confirmedAt: sentAt, createdAt: sentAt, updatedAt: sentAt,
  });

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.scanned, 1);
  assert.equal(repaired.repaired, 1);
  assert.equal(new Date(fx.orders[0].lastReminderAt).getTime(), sentAt.getTime());
  assert.equal(fx.orders[0].lastReminderKey, "manual:repair");
});


test("server repair projects a CONFIRMED TASK even after the CustomOrder became terminal", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 814, telegramUserId: "1001" });
  fx.orders[0].status = "COMPLETED";
  fx.orders[0].telegramTaskMessageId = null;
  fx.orders[0].deliveredAt = null;

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.scanned, 1);
  assert.equal(repaired.repaired, 1);
  assert.equal(fx.orders[0].telegramTaskMessageId, 814);
  assert.ok(fx.orders[0].deliveredAt);
  assert.equal(fx.orders[0].status, "COMPLETED", "repair must project the provider fact without reopening terminal business state");
});

test("server repair projects a historical CONFIRMED TASK without requiring Desktop to repeat confirm", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 811, telegramUserId: "1001" });
  fx.orders[0].telegramTaskMessageId = null;
  fx.orders[0].deliveredAt = null;

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.scanned, 1);
  assert.equal(repaired.repaired, 1);
  assert.equal(fx.orders[0].telegramTaskMessageId, 811);
  assert.ok(fx.orders[0].deliveredAt);
});

test("explicit legacy-retirement cancellation waiver is terminal control truth and repair never fabricates a Telegram send", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 813, telegramUserId: "1001" });
  fx.orders[0].deliveredAt = new Date(fx.now.getTime() - 1_000);
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelledAt = new Date(fx.now.getTime() - 500);
  fx.orders[0].cancelReason = "historical creator retirement";
  fx.orders[0].telegramCancellationWaivedAt = new Date(fx.now.getTime() - 250);
  fx.orders[0].telegramCancellationWaiverReason = "LEGACY_CREATOR_RETIRED_BEFORE_PIPELINE_AUTHORITY";

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.scanned, 0, "waived terminal follow-up is not projection debt");
  assert.equal(repaired.repaired, 0);
  assert.equal(fx.intents.filter((row) => row.kind === "CANCELLATION").length, 0, "repair must not invent a physical cancellation after an explicit waiver");
});

test("historical CANCELLED cancellation tombstone is reactivated under lifecycle fences instead of blocking confirmed TASK convergence forever", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 812, telegramUserId: "1001" });
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelledAt = new Date(fx.now.getTime() - 500);
  fx.orders[0].cancelReason = "manager cancelled";

  const initial = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "CANCELLATION", now: fx.now, db: fx.db });
  assert.equal(initial.intent.state, "PLANNED");
  const canonical = fx.intents.find((row) => row.id === initial.intent.id);
  canonical.state = "CANCELLED";
  canonical.outcomeReason = "PRECOMMIT_BUSINESS_STATE_CHANGED";
  canonical.claimRevision = 4;
  canonical.commitStartedAt = null;

  const repaired = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.scanned, 1);
  assert.equal(repaired.repaired, 1);
  assert.equal(fx.intents.length, 2, "repair must reuse TASK + one canonical CANCELLATION row, not create a duplicate");
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.equal(cancellation.id, initial.intent.id);
  assert.equal(cancellation.state, "PLANNED");
  assert.equal(cancellation.claimRevision, 5);
  assert.equal(cancellation.outcomeReason, "CANCELLATION_REACTIVATED_FOR_TERMINAL_ORDER");
});

test("historical orphan precommit intent is terminalized and cannot head-of-line poison healthy work", async () => {
  const fx = dbFixture();
  fx.intents.push({
    id: "intent-orphan-oldest", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "deleted-order", accountId: "tg-1", kind: "TASK",
    logicalKey: "custom-telegram:agency-1:deleted-order:TASK:one", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "orphan-fp", payload: { text: "orphan" }, state: "PLANNED",
    deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimRevision: 0, claimUntil: null, commitStartedAt: null,
    remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, outcomeReason: null, confirmationAuthority: null, confirmedAt: null,
    createdAt: new Date(fx.now.getTime() - 10_000), updatedAt: new Date(fx.now.getTime() - 10_000),
  });
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  assert.equal(planned.intent.state, "PLANNED");

  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 1, now: new Date(fx.now.getTime() + 1_000), db: fx.db });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].id, planned.intent.id, "healthy later work must remain reachable behind a historical orphan");
  const orphan = fx.intents.find((row) => row.id === "intent-orphan-oldest");
  assert.equal(orphan.state, "CANCELLED");
  assert.equal(orphan.outcomeReason, "LEGACY_ORPHAN_CUSTOM_ORDER_PRECOMMIT");
  assert.equal(orphan.claimRevision, 1);
});

test("manual PROVEN_NOT_SENT reconciliation terminalizes orphan unknown-outcome instead of recreating poisoned PLANNED work", async () => {
  const fx = dbFixture();
  fx.intents.push({
    id: "intent-orphan-reconcile", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "deleted-order", accountId: "tg-1", kind: "AUTO_REMINDER",
    logicalKey: "orphan-reconcile", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "orphan-reconcile-fp", payload: { text: "unknown" }, state: "RECONCILE_REQUIRED",
    deviceId: null, userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: null, claimRevision: 3, claimUntil: null,
    commitStartedAt: new Date(fx.now.getTime() - 5_000), remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null,
    outcomeReason: "COMMIT_PROCESS_LOST", confirmationAuthority: null, confirmedAt: null,
    createdAt: new Date(fx.now.getTime() - 6_000), updatedAt: new Date(fx.now.getTime() - 5_000),
  });

  const result = await reconcileTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: "intent-orphan-reconcile", resolution: "PROVEN_NOT_SENT",
    reason: "checked provider history; no message exists", now: fx.now, db: fx.db,
  });
  assert.equal(result.intent.state, "CANCELLED");
  assert.match(result.intent.outcomeReason, /^PROVEN_NOT_SENT_ORPHAN:/);
  assert.equal(result.intent.claimRevision, 4);
  assert.equal(fx.db._audits.at(-1)?.metadata?.orphanCustomOrder, true);
});

test("manual CONFIRMED reconciliation preserves orphan provider proof without fabricating a deleted CustomOrder", async () => {
  const fx = dbFixture();
  fx.intents.push({
    id: "intent-orphan-confirm", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "deleted-order", accountId: "tg-1", kind: "TASK",
    logicalKey: "orphan-confirm", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "orphan-confirm-fp", payload: { text: "unknown" }, state: "RECONCILE_REQUIRED",
    deviceId: null, userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: null, claimRevision: 2, claimUntil: null,
    commitStartedAt: new Date(fx.now.getTime() - 5_000), remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null,
    outcomeReason: "COMMIT_PROCESS_LOST", confirmationAuthority: null, confirmedAt: null,
    createdAt: new Date(fx.now.getTime() - 6_000), updatedAt: new Date(fx.now.getTime() - 5_000),
  });

  const result = await reconcileTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: "intent-orphan-confirm", resolution: "CONFIRMED",
    remoteMessageId: "9911", remoteRecipientTelegramUserId: "1001", remoteSentAt: fx.now.toISOString(),
    reason: "provider message verified manually", now: fx.now, db: fx.db,
  });
  assert.equal(result.intent.state, "CONFIRMED");
  assert.equal(result.intent.remoteMessageId, "9911");
  assert.equal(fx.orders.some((row) => row.id === "deleted-order"), false, "reconciliation must preserve proof, not recreate deleted business state");
});


test("provider-blocked precommit work is backoff-repaired instead of rewritten on every worker poll", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { accountId: "tg-1", messageId: 501, telegramUserId: "1001" });
  const submission = seedRevisionDecision(fx);
  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db,
  });
  fx.accounts.find((row) => row.id === "tg-1").lifecycleState = "RETIRING";

  const first = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  assert.equal(first.items.some((row) => row.id === revision.id), false);
  const blocked = fx.intents.find((row) => row.id === revision.id);
  assert.match(String(blocked.outcomeReason), /^PRECOMMIT_PROVIDER_UNAVAILABLE:/);
  // The fixture's generic updateMany uses wall-clock time, while this test deliberately
  // drives the authority with a deterministic `now`. Normalize only this row so the
  // backoff assertion tests authority semantics rather than host clock drift.
  blocked.updatedAt = new Date(fx.now);
  const firstBlockedAt = new Date(blocked.updatedAt).getTime();
  assert.equal(blocked.providerBindingRepairAttempts, 1);
  assert.equal(new Date(blocked.providerBindingRetryAt).getTime(), fx.now.getTime() + 60_000);

  const immediate = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(immediate.items.some((row) => row.id === revision.id), false);
  assert.equal(new Date(blocked.updatedAt).getTime(), firstBlockedAt, "blocked row must not be rewritten on every poll");

  fx.accounts.find((row) => row.id === "tg-1").lifecycleState = "ACTIVE";
  const later = new Date(fx.now.getTime() + 61_000);
  const repair = await repairPrecommitProviderBlockedIntents({ agencyId: "agency-1", member: fx.member, limit: 25, now: later, db: fx.db });
  assert.equal(repair.recovered, 1);
  const recoveredIntent = fx.intents.find((row) => row.id === revision.id);
  assert.equal(recoveredIntent.providerBindingRepairAttempts, 0);
  assert.equal(recoveredIntent.providerBindingRetryAt, null);
  assert.equal(String(recoveredIntent.outcomeReason || "").startsWith("PRECOMMIT_PROVIDER_UNAVAILABLE:"), false, "repaired work must leave the provider-blocked lane; an ordinary precommit refresh reason is still executable");
  const recovered = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: later, db: fx.db });
  assert.equal(recovered.items.some((row) => row.id === revision.id), true);
});

test("permanently provider-blocked work uses durable exponential retry scheduling instead of rotating write amplification", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { accountId: "tg-1", messageId: 501, telegramUserId: "1001" });
  const submission = seedRevisionDecision(fx);
  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db,
  });
  fx.accounts.find((row) => row.id === "tg-1").lifecycleState = "RETIRING";

  await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const blocked = fx.intents.find((row) => row.id === revision.id);
  assert.equal(blocked.providerBindingRepairAttempts, 1);
  assert.equal(new Date(blocked.providerBindingRetryAt).getTime(), fx.now.getTime() + 60_000);

  const secondAt = new Date(fx.now.getTime() + 61_000);
  const second = await repairPrecommitProviderBlockedIntents({ agencyId: "agency-1", member: fx.member, limit: 25, now: secondAt, db: fx.db });
  assert.equal(second.attempted, 1);
  assert.equal(second.stillBlocked, 1);
  assert.equal(blocked.providerBindingRepairAttempts, 2);
  assert.equal(new Date(blocked.providerBindingRetryAt).getTime(), secondAt.getTime() + 120_000);

  const tooEarly = await repairPrecommitProviderBlockedIntents({ agencyId: "agency-1", member: fx.member, limit: 25, now: new Date(fx.now.getTime() + 120_000), db: fx.db });
  assert.equal(tooEarly.attempted, 0, "durable retryAt must keep a permanent blocker out of every worker poll");
  assert.equal(blocked.providerBindingRepairAttempts, 2);

  const thirdAt = new Date(secondAt.getTime() + 121_000);
  const third = await repairPrecommitProviderBlockedIntents({ agencyId: "agency-1", member: fx.member, limit: 25, now: thirdAt, db: fx.db });
  assert.equal(third.attempted, 1);
  assert.equal(third.stillBlocked, 1);
  assert.equal(blocked.providerBindingRepairAttempts, 3);
  assert.equal(new Date(blocked.providerBindingRetryAt).getTime(), thirdAt.getTime() + 240_000);
});

test("model communication convergence cannot bypass durable provider-binding retryAt", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { accountId: "tg-1", messageId: 501, telegramUserId: "1001" });
  const submission = seedRevisionDecision(fx);
  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db,
  });
  fx.accounts.find((row) => row.id === "tg-1").lifecycleState = "RETIRING";
  await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const blocked = fx.intents.find((row) => row.id === revision.id);
  assert.equal(blocked.providerBindingRepairAttempts, 1);
  const firstRetryAt = new Date(blocked.providerBindingRetryAt).getTime();
  const firstUpdatedAt = new Date(blocked.updatedAt).getTime();

  const early = await repairCustomModelCommunicationConvergence({ agencyId: "agency-1", now: new Date(fx.now.getTime() + 5_000), db: fx.db });
  assert.equal(early.providerBindingRepairAttempted, 0);
  assert.equal(blocked.providerBindingRepairAttempts, 1);
  assert.equal(new Date(blocked.providerBindingRetryAt).getTime(), firstRetryAt);
  assert.equal(new Date(blocked.updatedAt).getTime(), firstUpdatedAt, "generic convergence must not rewrite a not-yet-due blocked intent");

  const dueAt = new Date(fx.now.getTime() + 61_000);
  const due = await repairCustomModelCommunicationConvergence({ agencyId: "agency-1", now: dueAt, db: fx.db });
  assert.equal(due.providerBindingRepairAttempted, 1);
  assert.equal(due.providerBindingRepairStillBlocked, 1);
  assert.equal(blocked.providerBindingRepairAttempts, 2);
  assert.equal(new Date(blocked.providerBindingRetryAt).getTime(), dueAt.getTime() + 120_000);
});

test("explicit claim-by-id immediately re-evaluates a provider-blocked precommit intent after capability repair", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { accountId: "tg-1", messageId: 501, telegramUserId: "1001" });
  const submission = seedRevisionDecision(fx);
  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db,
  });
  fx.accounts.find((row) => row.id === "tg-1").lifecycleState = "RETIRING";
  const hidden = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  assert.equal(hidden.items.some((row) => row.id === revision.id), false);
  assert.match(String(fx.intents.find((row) => row.id === revision.id).outcomeReason), /^PRECOMMIT_PROVIDER_UNAVAILABLE:/);

  fx.accounts.find((row) => row.id === "tg-1").lifecycleState = "ACTIVE";
  const claimed = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
    now: new Date(fx.now.getTime() + 5_000), db: fx.db,
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.intent.state, "CLAIMED");
  assert.equal(String(claimed.intent.outcomeReason || "").startsWith("PRECOMMIT_PROVIDER_UNAVAILABLE:"), false);
});

test("PRECOMMIT_PROVIDER_UNAVAILABLE is visible in a dedicated operator queue without pretending the external outcome is unknown", async () => {
  const fx = dbFixture();
  fx.intents.push({
    id: "intent-provider-blocked", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "TASK",
    logicalKey: "provider-blocked", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "blocked-fp", payload: { text: "task" }, state: "PLANNED",
    deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimRevision: 2, claimUntil: null, commitStartedAt: null,
    remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null,
    outcomeReason: "PRECOMMIT_PROVIDER_UNAVAILABLE:CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED", confirmationAuthority: null, confirmedAt: null,
    createdAt: new Date(fx.now.getTime() - 5000), updatedAt: new Date(fx.now.getTime() - 1000),
  });
  const queue = await listTelegramDeliveryPrecommitBlockedQueue({ agencyId: "agency-1", member: fx.member, limit: 20, db: fx.db });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].id, "intent-provider-blocked");
  assert.equal(queue.items[0].state, "PLANNED");
  assert.equal(queue.items[0].externalEffectStarted, false);
  assert.equal(queue.items[0].blockedCode, "CUSTOM_ORDER_TELEGRAM_CONTACT_REQUIRED");
  assert.equal(queue.items[0].customOrder.customOrderId, "order-1");
  assert.equal(queue.items[0].creator.id, "creator-1");

  const reconcile = await listTelegramDeliveryReconciliationQueue({ agencyId: "agency-1", member: fx.member, limit: 20, db: fx.db });
  assert.equal(reconcile.items.some((row) => row.id === "intent-provider-blocked"), false, "precommit no-effect work must not be mislabeled as unknown outcome reconciliation");
});


test("RECONCILE_REQUIRED backlog never consumes executable Telegram work limit", async () => {
  const fx = dbFixture();
  for (let i = 1; i <= 75; i += 1) {
    fx.intents.push({
      id: `unknown-${String(i).padStart(3, "0")}`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "AUTO_REMINDER",
      logicalKey: `unknown:${i}`, clientIntentId: null, referenceOrdinal: null, payloadFingerprint: `unknown-fp-${i}`, payload: { text: "unknown" },
      state: "RECONCILE_REQUIRED", deviceId: null, userId: "user-1", memberId: "member-1", accessEpoch: 7, claimTokenHash: null, claimRevision: 1, claimUntil: null,
      commitStartedAt: new Date(fx.now.getTime() - 100000 + i), remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null,
      outcomeReason: "COMMIT_PROCESS_LOST", confirmationAuthority: null, confirmedAt: null,
      createdAt: new Date(fx.now.getTime() - 100000 + i), updatedAt: new Date(fx.now.getTime() - 100000 + i),
    });
  }
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 1, now: fx.now, db: fx.db });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].id, planned.intent.id, "healthy precommit work must bypass any reconciliation backlog");
});

test("historical due reminder with missing pinned account cannot poison executable work discovery", async () => {
  const fx = dbFixture();
  const poisonCreator = fx.creators[0];
  poisonCreator.telegramAccountId = null;
  const poisonOrder = fx.orders[0];
  poisonOrder.telegramTaskMessageId = 8001;
  poisonOrder.createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  poisonOrder.nextReminderAt = new Date(fx.now.getTime() - 2_000);
  fx.intents.push({
    id: "task-poison-reminder", agencyId: "agency-1", creatorId: poisonCreator.id, customOrderId: poisonOrder.id,
    accountId: "tg-missing", kind: "TASK", logicalKey: "custom-telegram:agency-1:order-1:TASK:one",
    clientIntentId: null, referenceOrdinal: null, payloadFingerprint: "task-poison", payload: { text: "task" },
    state: "CONFIRMED", deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null,
    claimRevision: 1, claimUntil: null, commitStartedAt: new Date(fx.now.getTime() - 60_000), remoteMessageId: 8001,
    remoteRecipientTelegramUserId: "1001", remoteSentAt: new Date(fx.now.getTime() - 60_000), confirmedAt: new Date(fx.now.getTime() - 59_000),
    outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", createdAt: new Date(fx.now.getTime() - 60_000), updatedAt: new Date(fx.now.getTime() - 59_000),
  });

  const healthyCreator = { id: "creator-2", agencyId: "agency-1", displayName: "Healthy", username: "healthy", status: "READY", deletedAt: null, telegramContact: "@healthy", telegramUserId: "2002", telegramAccountId: "tg-2" };
  fx.creators.push(healthyCreator);
  const healthyOrder = {
    id: "order-2", agencyId: "agency-1", creatorId: "creator-2", dialogId: "dialog-2", scenario: "healthy task", type: "CONTENT", status: "PENDING",
    telegramTaskMessageId: null, telegramReferenceMessageIds: [], deliveredAt: null, lastReminderAt: null, lastReminderKey: null, nextReminderAt: null,
    reminderConfig: null, createdAt: new Date(fx.now.getTime() - 30_000), updatedAt: new Date(fx.now.getTime() - 30_000), creator: healthyCreator,
  };
  fx.orders.push(healthyOrder);
  const healthyPlan = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-2", kind: "TASK", now: fx.now, db: fx.db });
  assert.equal(healthyPlan.intent.state, "PLANNED");

  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 1, now: fx.now, db: fx.db });
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].id, healthyPlan.intent.id, "healthy executable work must remain reachable behind an impossible historical reminder");
  assert.equal(fx.intents.some((row) => row.kind === "AUTO_REMINDER" && row.customOrderId === poisonOrder.id), false, "missing account cannot fabricate a reminder intent");
});

test("historical impossible reminder planning is operator-visible without fabricating a delivery intent", async () => {
  const fx = dbFixture();
  fx.orders[0].telegramTaskMessageId = 8101;
  fx.orders[0].createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.orders[0].nextReminderAt = new Date(fx.now.getTime() - 1_000);
  fx.intents.push({
    id: "task-reminder-blocked", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-missing", kind: "TASK",
    logicalKey: "custom-telegram:agency-1:order-1:TASK:one", clientIntentId: null, referenceOrdinal: null, payloadFingerprint: "task-blocked", payload: { text: "task" },
    state: "CONFIRMED", claimRevision: 1, claimUntil: null, claimTokenHash: null, deviceId: null, userId: null, memberId: null, accessEpoch: null,
    commitStartedAt: new Date(fx.now.getTime() - 31 * 60_000), remoteMessageId: 8101, remoteRecipientTelegramUserId: "1001", remoteSentAt: new Date(fx.now.getTime() - 31 * 60_000),
    confirmedAt: new Date(fx.now.getTime() - 31 * 60_000 + 1_000), outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", createdAt: new Date(fx.now.getTime() - 31 * 60_000), updatedAt: new Date(fx.now.getTime() - 31 * 60_000 + 1_000),
  });
  fx.accounts.splice(0, fx.accounts.length, ...fx.accounts.filter((row) => row.id !== "tg-missing"));

  const queue = await listTelegramReminderPlanningBlockedQueue({ agencyId: "agency-1", member: fx.member, limit: 20, now: fx.now, db: fx.db });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].customOrderId, "order-1");
  assert.equal(queue.items[0].kind, "AUTO_REMINDER");
  assert.equal(queue.items[0].accountId, "tg-missing");
  assert.equal(queue.items[0].blockedCode, "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED");
  assert.equal(queue.items[0].externalEffectStarted, false);
  assert.equal(fx.intents.some((row) => row.kind === "AUTO_REMINDER"), false, "visibility is derived and must not invent provider work");
});

test("unexpected confirmed TASK thread lookup failures are surfaced instead of hiding due reminder work", async () => {
  const fx = dbFixture();
  fx.orders[0].telegramTaskMessageId = 8201;
  fx.orders[0].createdAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.orders[0].nextReminderAt = new Date(fx.now.getTime() - 1_000);
  const originalFindFirst = fx.db.telegramDeliveryIntent.findFirst;
  fx.db.telegramDeliveryIntent.findFirst = async (args) => {
    if (args?.where?.kind === "TASK") {
      const error = new Error("SIMULATED_TASK_THREAD_DB_FAILURE");
      error.code = "SIMULATED_TASK_THREAD_DB_FAILURE";
      throw error;
    }
    return originalFindFirst(args);
  };
  await assert.rejects(
    () => listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 10, now: fx.now, db: fx.db }),
    /SIMULATED_TASK_THREAD_DB_FAILURE/,
  );
});

test("model response makes CONTENT reminder schedule non-executable and MANUAL_REMINDER is rejected while manager owns the next decision", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 8301, telegramUserId: "1001" });
  const task = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  task.remoteSentAt = new Date(fx.now.getTime() - 90 * 60_000);
  task.confirmedAt = task.remoteSentAt;
  fx.orders[0].deliveredAt = task.remoteSentAt;
  fx.orders[0].nextReminderAt = new Date(fx.now.getTime() - 1_000);
  fx.submissions.push({
    id: "response-v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
    receivedAt: new Date(fx.now.getTime() - 5_000), createdAt: new Date(fx.now.getTime() - 5_000), updatedAt: new Date(fx.now.getTime() - 5_000),
  });

  await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: fx.now, db: fx.db });
  assert.equal(fx.orders[0].nextReminderAt, null, "response receipt must clear stale CONTENT reminder schedule");
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", now: fx.now, db: fx.db }),
    (error) => error?.code === "CUSTOM_MODEL_OBLIGATION_NOT_WAITING_RESPONSE",
  );
});

test("confirmed REVISION_REQUEST starts a fresh reminder cycle and both manual/auto reminders reply to the revision provider message", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 8401, telegramUserId: "1001" });
  const submission = seedRevisionDecision(fx, { reviewedAt: new Date(fx.now.getTime() - 40 * 60_000) });
  fx.orders[0].nextReminderAt = null;
  fx.orders[0].lastReminderAt = new Date(fx.now.getTime() - 2 * 60 * 60_000);
  fx.orders[0].lastReminderKey = "CONTENT:legacy-task-cycle";

  const revision = await planRevisionRequestIntentForReviewedSubmission({ agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
  const revisionSentAt = new Date(fx.now.getTime() - 31 * 60_000);
  await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", claimToken: claimed.claimToken, remoteMessageId: 8402, remoteRecipientTelegramUserId: "1001", remoteSentAt: revisionSentAt, now: fx.now, db: fx.db });

  assert.ok(fx.orders[0].nextReminderAt, "revision provider receipt must arm the new obligation cycle");
  assert.equal(new Date(fx.orders[0].nextReminderAt).getTime() <= fx.now.getTime(), true, "31-minute-old revision is due under default 30-minute policy");

  const manual = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER", clientIntentId: "ffffffff-ffff-4fff-8fff-ffffffffffff", now: fx.now, db: fx.db });
  assert.equal(manual.intent.payload.replyToMessageId, "8402");
  assert.equal(manual.intent.payload.replyToDeliveryId, revision.id);
  assert.match(manual.intent.payload.reminderKey, new RegExp(`^CONTENT:REVISION_REQUEST:${revision.id}:MANUAL:`));

  // Keep the manual reminder precommit but do not begin it; automatic planning still uses the same
  // obligation identity. Remove the manual row from the in-memory fixture so this assertion isolates
  // provider binding rather than the unrelated manual/auto unresolved policy.
  fx.intents.splice(fx.intents.findIndex((row) => row.id === manual.intent.id), 1);
  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const auto = work.items.find((row) => row.kind === "AUTO_REMINDER");
  assert.ok(auto);
  assert.equal(auto.payload.replyToMessageId, "8402");
  assert.equal(auto.payload.replyToDeliveryId, revision.id);
  assert.match(auto.payload.reminderKey, new RegExp(`^CONTENT:REVISION_REQUEST:${revision.id}:`));
});

test("model response commit racing a claimed AUTO_REMINDER wins the shared CustomOrder revision fence before COMMITTING", async () => {
  let armResponseRace = false;
  let fx;
  fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ data, orders }) => {
      if (!armResponseRace || !data?.updatedAt) return;
      armResponseRace = false;
      // Forced interleaving: begin() already derived a live obligation from the old order revision,
      // then the canonical response transaction wins the same CustomOrder.updatedAt lane before
      // begin() can CAS its provider-commit permit.
      fx.submissions.push({
        id: "response-race-v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
        pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
        receivedAt: new Date(fx.now.getTime() + 1), createdAt: new Date(fx.now.getTime() + 1), updatedAt: new Date(fx.now.getTime() + 1),
      });
      orders[0].updatedAt = new Date(new Date(orders[0].updatedAt).getTime() + 5000);
    },
  });

  seedConfirmedTaskThread(fx, { messageId: 8501, telegramUserId: "1001" });
  const task = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  task.remoteSentAt = new Date(fx.now.getTime() - 31 * 60_000);
  task.confirmedAt = task.remoteSentAt;
  fx.orders[0].deliveredAt = task.remoteSentAt;
  fx.orders[0].nextReminderAt = new Date(fx.now.getTime() - 1000);

  const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
  const auto = work.items.find((row) => row.kind === "AUTO_REMINDER");
  assert.ok(auto, "due initial model obligation must materialize one AUTO_REMINDER");
  const claimed = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: auto.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db,
  });
  assert.equal(claimed.claimed, true);

  armResponseRace = true;
  await assert.rejects(
    () => beginTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: auto.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
      claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 2000), db: fx.db,
    }),
    (error) => error?.code === "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED",
  );

  const stored = fx.intents.find((row) => row.id === auto.id);
  assert.equal(stored.state, "CANCELLED", "refresh after the lost CAS must observe the response and terminalize stale reminder work");
  assert.equal(stored.commitStartedAt, null, "provider effect must never start after the response won the causal boundary");
});

test("initial REFERENCE planning is forbidden after the model response already satisfied the TASK obligation", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 901, telegramUserId: "1001" });
  fx.submissions.push({
    id: "response-v1-ref-stop", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
    receivedAt: new Date(fx.now.getTime() - 100), createdAt: new Date(fx.now.getTime() - 100), updatedAt: new Date(fx.now.getTime() - 100),
  });
  await assert.rejects(
    () => planTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE",
      clientIntentId: "91919191-9191-4191-8191-919191919191",
      reference: { ordinal: 0, name: "late.jpg", size: 1, sha256: "9".repeat(64) }, now: fx.now, db: fx.db,
    }),
    (error) => error?.code === "CUSTOM_MODEL_INITIAL_OBLIGATION_NOT_WAITING_RESPONSE",
  );
  assert.equal(fx.intents.filter((row) => row.kind === "REFERENCE").length, 0);
});

test("a claimed initial REFERENCE cannot begin after V1 satisfies the model obligation", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 902, telegramUserId: "1001" });
  const planned = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "REFERENCE",
    clientIntentId: "92929292-9292-4292-8292-929292929292",
    reference: { ordinal: 0, name: "before.jpg", size: 1, sha256: "8".repeat(64) }, now: fx.now, db: fx.db,
  });
  const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
  assert.equal(claimed.claimed, true);
  fx.submissions.push({
    id: "response-v1-after-ref-claim", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
    receivedAt: new Date(fx.now.getTime() + 10), createdAt: new Date(fx.now.getTime() + 10), updatedAt: new Date(fx.now.getTime() + 10),
  });
  await assert.rejects(
    () => beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 20), db: fx.db }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CONTROL_CHANGED",
  );
  const row = fx.intents.find((candidate) => candidate.id === planned.intent.id);
  assert.equal(row.state, "CANCELLED");
  assert.equal(row.commitStartedAt, null);
});


test("model communication backfill cancels stale precommit reminders/references and clears a satisfied CONTENT schedule", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 901, telegramUserId: "1001" });
  fx.orders[0].deliveredAt = new Date(fx.now.getTime() - 10_000);
  fx.orders[0].nextReminderAt = new Date(fx.now.getTime() + 60_000);
  fx.submissions.push({
    id: "response-v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
    receivedAt: new Date(fx.now.getTime() - 5_000), createdAt: new Date(fx.now.getTime() - 5_000), updatedAt: new Date(fx.now.getTime() - 5_000),
  });
  fx.intents.push({
    id: "legacy-auto-reminder", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "AUTO_REMINDER",
    logicalKey: "legacy-auto", state: "PLANNED", claimRevision: 0, commitStartedAt: null, payload: { reminderKey: "legacy-cycle" }, createdAt: new Date(fx.now.getTime() - 4_000), updatedAt: new Date(fx.now.getTime() - 4_000),
  });
  fx.intents.push({
    id: "legacy-reference", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "REFERENCE",
    logicalKey: "legacy-reference", clientIntentId: "legacy-ref-client", referenceOrdinal: 2, state: "CLAIMED", claimRevision: 3, commitStartedAt: null,
    payload: { reference: { ordinal: 2, name: "old.jpg", size: 10, sha256: "a".repeat(64) } }, createdAt: new Date(fx.now.getTime() - 3_000), updatedAt: new Date(fx.now.getTime() - 3_000),
  });

  const result = await repairCustomModelCommunicationConvergence({ agencyId: "agency-1", now: fx.now, db: fx.db });

  assert.equal(result.ok, true);
  assert.equal(result.precommitScanned, 2);
  assert.equal(result.precommitCancelled, 2);
  assert.equal(fx.intents.find((row) => row.id === "legacy-auto-reminder").state, "CANCELLED");
  assert.equal(fx.intents.find((row) => row.id === "legacy-reference").state, "CANCELLED");
  assert.equal(fx.orders[0].nextReminderAt, null, "accepted response must clear historical reminder schedule without Desktop polling");
});

test("model communication backfill reconstructs revision reminder schedule from CONFIRMED revision receipt even without TASK", async () => {
  const fx = dbFixture();
  const submission = seedRevisionDecision(fx, { comment: "Redo ending" });
  const sentAt = new Date(fx.now.getTime() - 30_000);
  fx.intents.push({
    id: "historical-revision-confirmed", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", customSubmissionId: submission.id,
    accountId: "tg-1", kind: "REVISION_REQUEST", logicalKey: `custom-telegram:agency-1:order-1:REVISION_REQUEST:submission:${submission.id}`,
    state: "CONFIRMED", claimRevision: 1, commitStartedAt: sentAt, remoteMessageId: 9901, remoteRecipientTelegramUserId: "1001", remoteSentAt: sentAt, confirmedAt: sentAt,
    payload: { reviewComment: "Redo ending" }, createdAt: sentAt, updatedAt: sentAt,
  });
  assert.equal(fx.orders[0].telegramTaskMessageId, null);
  assert.equal(fx.orders[0].nextReminderAt, null);

  const result = await repairCustomModelCommunicationConvergence({ agencyId: "agency-1", now: fx.now, db: fx.db });

  assert.equal(result.ok, true);
  assert.equal(result.revisionIntentsPlanned, 0, "existing provider receipt must never be duplicated");
  assert.ok(result.reminderScheduleScanned >= 1);
  assert.ok(fx.orders[0].nextReminderAt instanceof Date, "confirmed revision must recreate its model-obligation reminder schedule");
  assert.ok(fx.orders[0].nextReminderAt.getTime() >= sentAt.getTime());
});


test("initial TASK convergence reactivates the same proven-no-effect logical row after response reassignment debt", async () => {
  const fx = dbFixture();
  const cancelledAt = new Date(fx.now.getTime() - 30_000);
  fx.intents.push({
    id: "task-superseded-before-response-moved", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "TASK",
    logicalKey: "custom-telegram:agency-1:order-1:TASK:one", clientIntentId: null, referenceOrdinal: null,
    payloadFingerprint: "old-task-payload", payload: { text: "old task" }, state: "CANCELLED",
    deviceId: null, userId: null, memberId: null, accessEpoch: null, claimTokenHash: null, claimRevision: 4, claimUntil: null, commitStartedAt: null,
    remoteMessageId: null, remoteRecipientTelegramUserId: null, remoteSentAt: null, confirmationAuthority: null, confirmedAt: null,
    outcomeReason: "HUMAN_RESPONSE_SUPERSEDED:MANUAL_SUBMISSION_ASSIGNMENT", createdAt: cancelledAt, updatedAt: cancelledAt,
  });

  const report = await ensureInitialTaskIntents({ agencyId: "agency-1", member: null, limit: 10, now: fx.now, db: fx.db });
  assert.equal(report.failed, 0);
  assert.equal(report.reactivated, 1);
  assert.equal(report.planned, 0);
  assert.equal(fx.intents.length, 1, "exact TASK logical identity must be reused, not duplicated");
  const task = fx.intents[0];
  assert.equal(task.id, "task-superseded-before-response-moved");
  assert.equal(task.state, "PLANNED");
  assert.equal(task.claimRevision, 5);
  assert.equal(task.commitStartedAt, null);
  assert.equal(task.remoteMessageId, null);
  assert.equal(task.outcomeReason, "TASK_REACTIVATED_FOR_CURRENT_MODEL_OBLIGATION");
  assert.match(String(task.payload?.text || ""), /custom/i);
});

test("initial TASK convergence materializes missing create-time instruction after Telegram binding becomes available", async () => {
  const fx = dbFixture();
  assert.equal(fx.intents.length, 0);
  const report = await ensureInitialTaskIntents({ agencyId: "agency-1", member: null, limit: 10, now: fx.now, db: fx.db });
  assert.equal(report.failed, 0);
  assert.equal(report.planned, 1);
  assert.equal(report.reactivated, 0);
  assert.equal(fx.intents.length, 1);
  assert.equal(fx.intents[0].kind, "TASK");
  assert.equal(fx.intents[0].state, "PLANNED");
  assert.equal(fx.intents[0].logicalKey, "custom-telegram:agency-1:order-1:TASK:one");
});

test("initial TASK convergence never rewrites COMMITTING or UNKNOWN provider outcomes", async () => {
  for (const state of ["COMMITTING", "RECONCILE_REQUIRED"]) {
    const fx = dbFixture();
    const at = new Date(fx.now.getTime() - 20_000);
    fx.intents.push({
      id: `task-${state.toLowerCase()}`, agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "TASK",
      logicalKey: "custom-telegram:agency-1:order-1:TASK:one", payloadFingerprint: "task", payload: { text: "task" }, state,
      claimRevision: 2, commitStartedAt: state === "COMMITTING" ? at : at, remoteMessageId: null, remoteSentAt: null, confirmedAt: null,
      createdAt: at, updatedAt: at,
    });
    const report = await ensureInitialTaskIntents({ agencyId: "agency-1", member: null, limit: 10, now: fx.now, db: fx.db });
    assert.equal(report.planned, 0, state);
    assert.equal(report.reactivated, 0, state);
    assert.equal(fx.intents[0].state, state);
    assert.equal(fx.intents[0].claimRevision, 2);
  }
});

test("initial TASK convergence does not resurrect an instruction while a canonical response is assigned", async () => {
  const fx = dbFixture();
  const at = new Date(fx.now.getTime() - 30_000);
  fx.intents.push({
    id: "task-cancelled-response-present", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "TASK",
    logicalKey: "custom-telegram:agency-1:order-1:TASK:one", payloadFingerprint: "task", payload: { text: "task" }, state: "CANCELLED",
    claimRevision: 2, commitStartedAt: null, remoteMessageId: null, remoteSentAt: null, confirmedAt: null, confirmationAuthority: null,
    outcomeReason: "HUMAN_RESPONSE_SUPERSEDED:MANUAL_RESPONSE", createdAt: at, updatedAt: at,
  });
  fx.submissions.push({
    id: "response-v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
    receivedAt: new Date(fx.now.getTime() - 10_000), createdAt: new Date(fx.now.getTime() - 10_000), updatedAt: new Date(fx.now.getTime() - 10_000),
  });
  const report = await ensureInitialTaskIntents({ agencyId: "agency-1", member: null, limit: 10, now: fx.now, db: fx.db });
  assert.equal(report.planned, 0);
  assert.equal(report.reactivated, 0);
  assert.equal(fx.intents[0].state, "CANCELLED");
});

test("initial TASK convergence loses safely when a concurrent human response advances the shared order fence", async () => {
  let fx;
  let injected = false;
  fx = dbFixture({
    beforeCustomOrderUpdateMany: async ({ where, orders }) => {
      if (injected || String(where?.id || "") !== "order-1" || where?.updatedAt === undefined) return;
      injected = true;
      fx.submissions.push({
        id: "response-race-winner", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
        pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
        receivedAt: fx.now, createdAt: fx.now, updatedAt: fx.now,
      });
      const row = orders.find((candidate) => candidate.id === "order-1");
      row.updatedAt = new Date(new Date(row.updatedAt).getTime() + 1);
    },
  });
  const cancelledAt = new Date(fx.now.getTime() - 30_000);
  fx.intents.push({
    id: "task-race-cancelled", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "TASK",
    logicalKey: "custom-telegram:agency-1:order-1:TASK:one", payloadFingerprint: "old", payload: { text: "old" }, state: "CANCELLED",
    claimRevision: 2, commitStartedAt: null, remoteMessageId: null, remoteSentAt: null, confirmedAt: null, confirmationAuthority: null,
    outcomeReason: "HUMAN_RESPONSE_SUPERSEDED:MANUAL_RESPONSE", createdAt: cancelledAt, updatedAt: cancelledAt,
  });

  const report = await ensureInitialTaskIntents({ agencyId: "agency-1", member: null, limit: 10, now: fx.now, db: fx.db });
  assert.equal(report.failed, 0);
  assert.equal(report.raced, 1);
  assert.equal(report.reactivated, 0);
  assert.equal(fx.intents[0].state, "CANCELLED");
  assert.equal(fx.submissions.length, 1);
});

test("explicit TASK planning is rejected after a canonical model response already satisfied the initial obligation", async () => {
  const fx = dbFixture();
  fx.submissions.push({
    id: "historical-v1-no-task", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW",
    receivedAt: new Date(fx.now.getTime() - 5_000), createdAt: new Date(fx.now.getTime() - 5_000), updatedAt: new Date(fx.now.getTime() - 5_000),
  });
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db }),
    (error) => error?.code === "CUSTOM_MODEL_INITIAL_INSTRUCTION_NOT_REQUIRED",
  );
  assert.equal(fx.intents.length, 0, "a stale initial instruction must not be created after V1 exists");
});

test("legacy precommit TASK created after response is cancelled by current-obligation refresh before claim", async () => {
  const fx = dbFixture();
  const at = new Date(fx.now.getTime() - 20_000);
  fx.submissions.push({
    id: "response-before-legacy-task", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW", receivedAt: at, createdAt: at, updatedAt: at,
  });
  fx.intents.push({
    id: "legacy-stale-task", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", accountId: "tg-1", kind: "TASK",
    logicalKey: "custom-telegram:agency-1:order-1:TASK:one", payloadFingerprint: "legacy", payload: { text: "stale" }, state: "PLANNED",
    claimRevision: 0, commitStartedAt: null, remoteMessageId: null, remoteSentAt: null, confirmedAt: null, createdAt: at, updatedAt: at,
  });
  const claim = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: "legacy-stale-task", deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db,
  });
  assert.equal(claim.claimed, false);
  assert.equal(fx.intents[0].state, "CANCELLED");
  assert.equal(fx.intents[0].commitStartedAt, null);
  assert.equal(fx.intents[0].outcomeReason, "INITIAL_MODEL_OBLIGATION_SATISFIED");
});

test("claimed TASK cannot cross begin after a response satisfies the initial obligation", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const claimed = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db,
  });
  assert.equal(claimed.claimed, true);
  const responseAt = new Date(fx.now.getTime() + 500);
  fx.submissions.push({
    id: "response-after-claim", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW", receivedAt: responseAt, createdAt: responseAt, updatedAt: responseAt,
  });
  await assert.rejects(
    () => beginTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
      claimToken: claimed.claimToken, now: new Date(fx.now.getTime() + 1_000), db: fx.db,
    }),
    (error) => error?.code === "TELEGRAM_DELIVERY_CONTROL_CHANGED",
  );
  assert.notEqual(fx.intents[0].state, "COMMITTING");
  assert.equal(fx.intents[0].commitStartedAt, null);
});

test("stale MANUAL_REMINDER from initial TASK cycle is cancelled instead of rebinding onto a later confirmed revision cycle", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 8501, telegramUserId: "1001" });
  const task = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  task.remoteSentAt = new Date(fx.now.getTime() - 60 * 60_000);
  task.confirmedAt = task.remoteSentAt;

  const staleManual = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER",
    clientIntentId: "12121212-1212-4212-8212-121212121212", now: new Date(fx.now.getTime() - 30_000), db: fx.db,
  });
  assert.match(staleManual.intent.payload.reminderKey, new RegExp(`^CONTENT:TASK:${task.id}:MANUAL:`));

  const submission = seedRevisionDecision(fx, { reviewedAt: new Date(fx.now.getTime() - 20_000) });
  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: new Date(fx.now.getTime() - 15_000), db: fx.db,
  });
  const revisionClaim = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() - 14_000), db: fx.db,
  });
  await beginTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
    claimToken: revisionClaim.claimToken, now: new Date(fx.now.getTime() - 13_000), db: fx.db,
  });
  await confirmTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", claimToken: revisionClaim.claimToken,
    remoteMessageId: 8502, remoteRecipientTelegramUserId: "1001", remoteSentAt: new Date(fx.now.getTime() - 12_000), now: new Date(fx.now.getTime() - 11_000), db: fx.db,
  });

  const claimed = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: staleManual.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db,
  });
  assert.equal(claimed.claimed, false);
  const row = fx.intents.find((intent) => intent.id === staleManual.intent.id);
  assert.equal(row.state, "CANCELLED");
  assert.equal(row.commitStartedAt, null);
  assert.match(String(row.outcomeReason || ""), /MODEL_OBLIGATION_CYCLE_CHANGED|MODEL_OBLIGATION_SATISFIED/);
  assert.match(String(row.payload?.reminderKey || ""), new RegExp(`^CONTENT:TASK:${task.id}:MANUAL:`), "stale manual reminder must never be rebound to revision identity");
});

test("claimed MANUAL_REMINDER cannot cross begin after the Custom obligation advances to a confirmed revision cycle", async () => {
  const fx = dbFixture();
  seedConfirmedTaskThread(fx, { messageId: 8601, telegramUserId: "1001" });
  const task = fx.intents.find((row) => row.kind === "TASK" && row.state === "CONFIRMED");
  task.remoteSentAt = new Date(fx.now.getTime() - 60 * 60_000);
  task.confirmedAt = task.remoteSentAt;

  const manual = await planTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "MANUAL_REMINDER",
    clientIntentId: "34343434-3434-4434-8434-343434343434", now: new Date(fx.now.getTime() - 30_000), db: fx.db,
  });
  const manualClaim = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: manual.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() - 29_000), db: fx.db,
  });
  assert.equal(manualClaim.claimed, true);

  const submission = seedRevisionDecision(fx, { reviewedAt: new Date(fx.now.getTime() - 20_000) });
  const revision = await planRevisionRequestIntentForReviewedSubmission({
    agencyId: "agency-1", member: fx.member, submission, order: fx.orders[0], revisionNumber: 1, now: new Date(fx.now.getTime() - 15_000), db: fx.db,
  });
  const revisionClaim = await claimTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: new Date(fx.now.getTime() - 14_000), db: fx.db,
  });
  await beginTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
    claimToken: revisionClaim.claimToken, now: new Date(fx.now.getTime() - 13_000), db: fx.db,
  });
  await confirmTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: revision.id, deviceId: "device-1", claimToken: revisionClaim.claimToken,
    remoteMessageId: 8602, remoteRecipientTelegramUserId: "1001", remoteSentAt: new Date(fx.now.getTime() - 12_000), now: new Date(fx.now.getTime() - 11_000), db: fx.db,
  });

  await assert.rejects(
    () => beginTelegramDeliveryIntent({
      agencyId: "agency-1", member: fx.member, intentId: manual.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
      claimToken: manualClaim.claimToken, now: fx.now, db: fx.db,
    }),
    (error) => ["TELEGRAM_DELIVERY_CONTROL_CHANGED", "TELEGRAM_DELIVERY_PRECOMMIT_REFRESH_REQUIRED"].includes(error?.code),
  );
  const row = fx.intents.find((intent) => intent.id === manual.intent.id);
  assert.equal(row.state, "CANCELLED");
  assert.equal(row.commitStartedAt, null);
  assert.equal(row.outcomeReason, "MODEL_OBLIGATION_CYCLE_CHANGED");
  assert.match(String(row.payload?.reminderKey || ""), new RegExp(`^CONTENT:TASK:${task.id}:MANUAL:`));
});

test("server projection repair converges cancellation from a historical CONFIRMED revision even when TASK never existed", async () => {
  const fx = dbFixture();
  const submission = seedRevisionDecision(fx, { comment: "Historical redo" });
  submission.telegramSourceAccountId = "tg-1";
  submission.telegramSourceUserId = "2002";
  submission.telegramMessageIds = [9101];
  const sentAt = new Date(fx.now.getTime() - 20_000);
  fx.intents.push({
    id: "revision-confirmed-before-restart", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", customSubmissionId: submission.id,
    accountId: "tg-1", kind: "REVISION_REQUEST", logicalKey: `custom-telegram:agency-1:order-1:REVISION_REQUEST:submission:${submission.id}`,
    state: "CONFIRMED", claimRevision: 2, commitStartedAt: sentAt,
    remoteMessageId: 9102, remoteRecipientTelegramUserId: "2002", remoteSentAt: sentAt, confirmedAt: sentAt,
    payload: { reviewComment: "Historical redo" }, createdAt: sentAt, updatedAt: sentAt,
  });
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "cancelled before process restart";
  assert.equal(fx.orders[0].telegramTaskMessageId, null);
  assert.equal(fx.intents.some((row) => row.kind === "CANCELLATION"), false);

  const report = await repairConfirmedTelegramDeliveryProjections({ agencyId: "agency-1", now: fx.now, db: fx.db });
  assert.equal(report.ok, true);
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.ok(cancellation, "server repair must heal the crash window after revision confirmation");
  assert.equal(cancellation.payload.replyToMessageId, "9102");
  assert.equal(cancellation.payload.recipientTelegramUserId, "2002");
});

test("manual PROVEN_NOT_SENT reconciliation after cancellation falls back from unknown revision to the confirmed TASK", async () => {
  const fx = dbFixture();
  const flow = await revisionToClaimed(fx);
  await beginTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", runtimeClaimToken: "runtime-1",
    claimToken: flow.claimed.claimToken, now: fx.now, db: fx.db,
  });
  await markTelegramDeliveryUnknown({
    agencyId: "agency-1", member: fx.member, intentId: flow.row.id, deviceId: "device-1", claimToken: flow.claimed.claimToken,
    reason: "provider response lost", now: fx.now, db: fx.db,
  });
  fx.orders[0].status = "CANCELLED";
  fx.orders[0].cancelReason = "cancelled while revision outcome unknown";
  assert.equal(await planCancellationIntentForCommittedOrder({ agencyId: "agency-1", member: fx.member, order: fx.orders[0], now: fx.now, db: fx.db }), null);

  const reconciled = await reconcileTelegramDeliveryIntent({
    agencyId: "agency-1", member: fx.member, intentId: flow.row.id, resolution: "PROVEN_NOT_SENT",
    reason: "Telegram history proves revision message does not exist", now: new Date(fx.now.getTime() + 1000), db: fx.db,
  });
  assert.equal(reconciled.intent.state, "PLANNED");
  const cancellation = fx.intents.find((row) => row.kind === "CANCELLATION");
  assert.ok(cancellation);
  assert.equal(cancellation.payload.replyToMessageId, "501");
});

test("historical no-TASK confirmed revision reminder blockage is operator-visible", async () => {
  const fx = dbFixture();
  const order = fx.orders[0];
  order.telegramTaskMessageId = null;
  order.createdAt = new Date(fx.now.getTime() - 40 * 60_000);
  order.nextReminderAt = new Date(fx.now.getTime() - 1_000);
  const submission = seedRevisionDecision(fx, { reviewedAt: new Date(fx.now.getTime() - 35 * 60_000) });
  const sentAt = new Date(fx.now.getTime() - 31 * 60_000);
  fx.intents.push({
    id: "revision-reminder-blocked", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "order-1", customSubmissionId: submission.id,
    accountId: "tg-missing", kind: "REVISION_REQUEST", logicalKey: "custom-telegram:agency-1:order-1:REVISION_REQUEST:submission:submission-v1",
    clientIntentId: null, referenceOrdinal: null, payloadFingerprint: "revision-blocked", payload: { text: "redo" },
    state: "CONFIRMED", claimRevision: 1, claimUntil: null, claimTokenHash: null, deviceId: null, userId: null, memberId: null, accessEpoch: null,
    commitStartedAt: sentAt, remoteMessageId: 9101, remoteRecipientTelegramUserId: "1001", remoteSentAt: sentAt,
    confirmedAt: new Date(sentAt.getTime() + 1000), outcomeReason: null, confirmationAuthority: "PROVIDER_RECEIPT", createdAt: sentAt, updatedAt: new Date(sentAt.getTime() + 1000),
  });
  fx.accounts.splice(0, fx.accounts.length, ...fx.accounts.filter((row) => row.id !== "tg-missing"));

  const queue = await listTelegramReminderPlanningBlockedQueue({ agencyId: "agency-1", member: fx.member, limit: 20, now: fx.now, db: fx.db });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].customOrderId, "order-1");
  assert.equal(queue.items[0].accountId, "tg-missing");
  assert.equal(queue.items[0].blockedCode, "CUSTOM_ORDER_TELEGRAM_ACCOUNT_REQUIRED");
  assert.equal(fx.intents.some((row) => row.kind === "AUTO_REMINDER"), false, "blocked read model must not invent reminder work");
});

test("AUTO_REMINDER planning horizon counts eligible new work, not stale exact CONFIRMED intents awaiting projection repair", async () => {
  const fx = dbFixture();
  const oldSentAt = new Date(fx.now.getTime() - 31 * 60_000);

  async function seedDueOrderWithTask(orderId) {
    if (orderId !== "order-1") {
      fx.orders.push({
        ...clone(fx.orders[0]), id: orderId, dialogId: `dialog-${orderId}`,
        telegramTaskMessageId: null, deliveredAt: null, lastReminderAt: null, lastReminderKey: null,
        nextReminderAt: null, createdAt: new Date(fx.now.getTime() - 60_000), updatedAt: new Date(fx.now.getTime() - 60_000),
      });
    }
    const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId, kind: "TASK", now: fx.now, db: fx.db });
    const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
    await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
    await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: planned.intent.id, deviceId: "device-1", claimToken: claimed.claimToken, remoteMessageId: Number(orderId.replace(/\D/g, "")) + 9100, remoteRecipientTelegramUserId: "1001", remoteSentAt: oldSentAt, now: fx.now, db: fx.db });
    const task = fx.intents.find((row) => row.id === planned.intent.id);
    task.remoteSentAt = oldSentAt;
    task.confirmedAt = oldSentAt;
    const order = fx.orders.find((row) => row.id === orderId);
    order.deliveredAt = oldSentAt;
    order.nextReminderAt = new Date(fx.now);
    return order;
  }

  async function createConfirmedReminderThenLoseProjection(order) {
    const work = await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 25, now: fx.now, db: fx.db });
    const reminder = work.items.find((row) => row.kind === "AUTO_REMINDER" && row.customOrderId === order.id);
    assert.ok(reminder, `AUTO_REMINDER must first materialize for ${order.id}`);
    const claimed = await claimTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", now: fx.now, db: fx.db });
    await beginTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", runtimeClaimToken: "runtime-1", claimToken: claimed.claimToken, now: fx.now, db: fx.db });
    await confirmTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, intentId: reminder.id, deviceId: "device-1", claimToken: claimed.claimToken, remoteMessageId: Number(order.id.replace(/\D/g, "")) + 9200, remoteRecipientTelegramUserId: "1001", remoteSentAt: fx.now, now: fx.now, db: fx.db });
    // Crash-window model: provider receipt is durable, but CustomOrder reminder projection was lost.
    order.lastReminderAt = null;
    order.lastReminderKey = null;
    order.nextReminderAt = new Date(fx.now);
    return reminder.id;
  }

  const order1 = await seedDueOrderWithTask("order-1");
  await createConfirmedReminderThenLoseProjection(order1);
  const order2 = await seedDueOrderWithTask("order-2");
  await createConfirmedReminderThenLoseProjection(order2);
  const order3 = await seedDueOrderWithTask("order-3");

  const before = fx.intents.filter((row) => row.kind === "AUTO_REMINDER" && row.customOrderId === "order-3").length;
  assert.equal(before, 0);

  await listTelegramDeliveryWork({ agencyId: "agency-1", member: fx.member, limit: 2, now: fx.now, db: fx.db });

  const after = fx.intents.filter((row) => row.kind === "AUTO_REMINDER" && row.customOrderId === "order-3");
  assert.equal(after.length, 1, "stale exact CONFIRMED reminders must not consume the planning horizon before a later eligible order");
});

test("direct human Telegram planning rejects a stale management actor before creating durable work", async () => {
  const fx = dbFixture();
  const actorSnapshot = clone(fx.member);
  fx.db._member.accessEpoch += 1;
  fx.db._member.assignedCreators = [];
  await assert.rejects(
    () => planTelegramDeliveryIntent({ agencyId: "agency-1", member: actorSnapshot, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
  assert.equal(fx.intents.length, 0, "stale human planning must not create a TelegramDeliveryIntent");
});

test("manual Telegram reconciliation rejects a stale management actor and preserves unresolved provider truth", async () => {
  const fx = dbFixture();
  const planned = await planTelegramDeliveryIntent({ agencyId: "agency-1", member: fx.member, orderId: "order-1", kind: "TASK", now: fx.now, db: fx.db });
  const row = fx.intents.find((intent) => intent.id === planned.intent.id);
  assert.ok(row);
  row.state = "RECONCILE_REQUIRED";
  row.commitStartedAt = new Date(fx.now.getTime() - 30_000);
  row.claimRevision = 3;
  const actorSnapshot = clone(fx.member);
  fx.db._member.accessEpoch += 1;
  fx.db._member.assignedCreators = [];
  await assert.rejects(
    () => reconcileTelegramDeliveryIntent({
      agencyId: "agency-1", member: actorSnapshot, intentId: row.id,
      resolution: "PROVEN_NOT_SENT", reason: "stale operator decision", now: fx.now, db: fx.db,
    }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
  assert.equal(row.state, "RECONCILE_REQUIRED");
  assert.equal(row.outcomeReason ?? null, null);
});
