"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeTelegramCustomReminders,
  normalizeReminderOverride,
  nextReminderForOrder,
  claimDueReminders,
  acknowledgeReminder,
  releaseReminderClaim,
} = require("./custom-order-reminders");

const root = path.join(__dirname, "..", "..");

const CURRENT_MEMBER = Object.freeze({
  id: "member-1", userId: "user-1", agencyId: "agency-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: ["creator-1"], accessEpoch: 1,
});

test("reminder policies accept arbitrary user minute values and keep physical off by default", () => {
  const policy = normalizeTelegramCustomReminders({
    content: { firstAfterMinutes: 47, repeatEveryMinutes: 135 },
    call: { offsetsMinutes: [135, 47, 5] },
  });
  assert.equal(policy.content.firstAfterMinutes, 47);
  assert.equal(policy.content.repeatEveryMinutes, 135);
  assert.deepEqual(policy.call.offsetsMinutes, [135, 47, 5]);
  assert.equal(policy.physical.enabled, false);

  const override = normalizeReminderOverride("CALL", { offsetsMinutes: "121, 47, 5" });
  assert.deepEqual(override.offsetsMinutes, [121, 47, 5]);
});

test("call reminders are relative to scheduledAt while content repeats from delivery/creation seed", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const policy = normalizeTelegramCustomReminders({ call: { offsetsMinutes: [47, 5] } });
  const call = nextReminderForOrder({ status: "PENDING", type: "CALL", scheduledAt: new Date("2026-08-19T15:00:00.000Z"), reminderConfig: null }, policy, now);
  assert.equal(call.at.toISOString(), "2026-08-19T14:13:00.000Z");
  assert.match(call.key, /:47$/);

  const content = nextReminderForOrder({ status: "PENDING", type: "CONTENT", createdAt: now, reminderConfig: { enabled: true, firstAfterMinutes: 47, repeatEveryMinutes: 61 } }, policy, now);
  assert.equal(content.at.toISOString(), "2026-08-19T12:47:00.000Z");
});

test("assigned chatter desktops can claim due Telegram reminders for their creator scope", async () => {
  const dueAt = new Date("2026-08-19T11:59:00.000Z");
  const now = new Date("2026-08-19T12:00:00.000Z");
  const creator = { id: "creator-1", telegramContact: "@model_a", telegramAccountId: "tg-1", displayName: "Model A" };
  const db = {
    creatorAccount: {
      async findMany() { return [{ id: "creator-1", telegramContact: "@model_a", telegramAccountId: "tg-1" }]; },
      async findFirst({ where }) { return where.id === "creator-1" && where.agencyId === "agency-1" ? { id: "creator-1", agencyId: "agency-1", status: "READY", deletedAt: null } : null; },
    },
    agencyMember: {
      async findFirst({ where }) { return where.id === CURRENT_MEMBER.id && where.userId === CURRENT_MEMBER.userId && where.agencyId === CURRENT_MEMBER.agencyId ? { ...CURRENT_MEMBER, deletedAt: null, deactivatedAt: null } : null; },
    },
    agencyTelegramMtprotoAccount: {
      async findFirst({ where }) {
        if (where.id !== "tg-1" || where.agencyId !== "agency-1") return null;
        if (where.runtimeClaimedByDeviceId !== undefined) {
          const actorOk = where.runtimeLeaseUserId === CURRENT_MEMBER.userId
            && where.runtimeLeaseMemberId === CURRENT_MEMBER.id
            && where.runtimeLeaseAccessEpoch === CURRENT_MEMBER.accessEpoch;
          return where.runtimeClaimedByDeviceId === "dev-chatter-1" && where.runtimeClaimUntil?.gt === now && actorOk ? { id: "tg-1" } : null;
        }
        return { id: "tg-1" };
      },
      async findMany() { return [{ id: "tg-1" }]; },
    },
    workspaceSetting: { async findUnique() { return null; } },
    customOrder: {
      async findMany({ where }) {
        assert.deepEqual(where.creatorId, { in: ["creator-1"] });
        return [{
          id: "order-1", agencyId: "agency-1", creatorId: "creator-1", creator, status: "PENDING", type: "CONTENT",
          scenario: "shoot this", priceCents: 1000, createdAt: new Date("2026-08-19T10:00:00.000Z"),
          telegramTaskMessageId: 501, nextReminderAt: dueAt, reminderClaimUntil: null, reminderConfig: null, lastReminderKey: null,
        }];
      },
      async updateMany({ where, data }) {
        assert.equal(where.id, "order-1");
        assert.equal(where.nextReminderAt, dueAt);
        assert.ok(data.reminderClaimToken);
        assert.ok(data.reminderClaimUntil > now);
        return { count: 1 };
      },
    },
  };
  const result = await claimDueReminders({
    agencyId: "agency-1",
    member: CURRENT_MEMBER,
    deviceId: "dev-chatter-1", now, db,
  });
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].creatorId, "creator-1");
  assert.equal(result.deliveries[0].accountId, "tg-1");
  assert.equal(result.deliveries[0].replyToMessageId, "501");
});

test("automatic reminders are routed through the current Telegram account runtime owner", async () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const creator = { id: "creator-1", telegramContact: "@model_a", telegramAccountId: "tg-1", displayName: "Model A" };
  const db = {
    creatorAccount: { async findMany() { return [{ id: "creator-1" }]; } },
    agencyTelegramMtprotoAccount: {
      async findMany() { return [{ id: "tg-1" }]; },
      async findFirst({ where }) {
        if (!where.runtimeClaimedByDeviceId) return { id: "tg-1" };
        return where.runtimeClaimedByDeviceId === "device-runtime-owner" ? { id: "tg-1" } : null;
      },
    },
    workspaceSetting: { async findUnique() { return null; } },
    customOrder: {
      async findMany() { return [{ id: "order-1", agencyId: "agency-1", creatorId: "creator-1", creator, status: "PENDING", type: "CONTENT", scenario: "x", priceCents: 0, createdAt: now, telegramTaskMessageId: 500, nextReminderAt: now, reminderClaimUntil: null }]; },
      async updateMany() { throw new Error("non-runtime owner must not reach custom reminder claim mutation"); },
    },
  };
  const result = await claimDueReminders({ agencyId: "agency-1", member: CURRENT_MEMBER, deviceId: "device-not-owner", now, db });
  assert.deepEqual(result.deliveries, []);
});

test("schema stores Telegram reference message ids directly on CustomOrder with no reference media model", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const block = schema.split("model CustomOrder {")[1].split("model AuthToken")[0];
  assert.match(block, /telegramTaskMessageId\s+Int\?/);
  assert.match(block, /telegramReferenceMessageIds\s+Int\[\]/);
  assert.doesNotMatch(schema, /model\s+CustomOrderReference\b/);
  assert.doesNotMatch(block, /storageKey|mediaKind|telegramPeerId/);
});

test("Audit16 reminder ack/fail reject a claim after the member accessEpoch changes", async () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const dueAt = new Date("2026-08-19T11:59:00.000Z");
  const liveMember = { ...CURRENT_MEMBER, deletedAt: null, deactivatedAt: null };
  const creator = {
    id: "creator-1", agencyId: "agency-1", telegramContact: "@model_a", telegramAccountId: "tg-1",
    displayName: "Model A", status: "READY", deletedAt: null,
  };
  const order = {
    id: "order-1", agencyId: "agency-1", creatorId: "creator-1", creator,
    status: "PENDING", type: "CONTENT", scenario: "shoot this", priceCents: 1000,
    createdAt: new Date("2026-08-19T10:00:00.000Z"), telegramTaskMessageId: 501,
    nextReminderAt: dueAt, reminderClaimUntil: null, reminderClaimToken: null,
    reminderClaimedByDeviceId: null, reminderLeaseUserId: null, reminderLeaseMemberId: null,
    reminderLeaseAccessEpoch: null, reminderConfig: null, lastReminderKey: null,
  };
  const db = {
    _member: liveMember,
    creatorAccount: {
      async findMany() { return [{ id: creator.id, telegramContact: creator.telegramContact, telegramAccountId: creator.telegramAccountId }]; },
      async findFirst({ where }) { return where.id === creator.id && where.agencyId === creator.agencyId ? { ...creator } : null; },
    },
    agencyMember: {
      async findFirst({ where }) {
        return where.id === liveMember.id && where.userId === liveMember.userId && where.agencyId === liveMember.agencyId
          ? { ...liveMember }
          : null;
      },
    },
    agencyTelegramMtprotoAccount: {
      async findMany() { return [{ id: "tg-1" }]; },
      async findFirst({ where }) {
        if (where.id !== "tg-1" || where.agencyId !== "agency-1") return null;
        if (where.runtimeClaimedByDeviceId !== undefined) {
          const valid = where.runtimeClaimedByDeviceId === "device-a"
            && where.runtimeLeaseUserId === CURRENT_MEMBER.userId
            && where.runtimeLeaseMemberId === CURRENT_MEMBER.id
            && where.runtimeLeaseAccessEpoch === CURRENT_MEMBER.accessEpoch
            && where.runtimeClaimUntil?.gt === now;
          return valid ? { id: "tg-1" } : null;
        }
        return { id: "tg-1" };
      },
    },
    workspaceSetting: { async findUnique() { return null; } },
    customOrder: {
      async findMany({ where }) {
        if (where.creatorId?.in && !where.creatorId.in.includes(order.creatorId)) return [];
        return [{ ...order, creator: { ...creator } }];
      },
      async findFirst({ where }) { return where.id === order.id && where.agencyId === order.agencyId ? { ...order, creator: { ...creator } } : null; },
      async updateMany({ where, data }) {
        if (where.id !== order.id || where.agencyId !== order.agencyId) return { count: 0 };
        Object.assign(order, data);
        return { count: 1 };
      },
      async update({ where, data }) {
        if (where.id !== order.id) throw new Error("unexpected order");
        Object.assign(order, data);
        return { ...order };
      },
    },
  };

  const claim = await claimDueReminders({ agencyId: "agency-1", member: CURRENT_MEMBER, deviceId: "device-a", now, db });
  assert.equal(claim.deliveries.length, 1);
  const token = claim.deliveries[0].claimToken;
  assert.ok(token);
  assert.equal(order.reminderLeaseAccessEpoch, CURRENT_MEMBER.accessEpoch);

  liveMember.accessEpoch = CURRENT_MEMBER.accessEpoch + 1;
  await assert.rejects(
    () => acknowledgeReminder({ agencyId: "agency-1", member: CURRENT_MEMBER, deviceId: "device-a", orderId: order.id, claimToken: token, messageId: "9001", now: new Date(now.getTime() + 1_000), db }),
    (error) => error?.code === "EXECUTION_ACCESS_EPOCH_STALE" && error?.status === 409,
  );
  await assert.rejects(
    () => releaseReminderClaim({ agencyId: "agency-1", member: CURRENT_MEMBER, deviceId: "device-a", orderId: order.id, claimToken: token, now: new Date(now.getTime() + 2_000), db }),
    (error) => error?.code === "EXECUTION_ACCESS_EPOCH_STALE" && error?.status === 409,
  );
  assert.equal(order.reminderClaimToken, token, "stale actor must not clear or advance the durable reminder claim");
});

