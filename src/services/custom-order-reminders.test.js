"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeTelegramCustomReminders,
  normalizeReminderOverride,
  nextReminderForOrder,
  desiredReminderSchedule,
  synchronizeReminderDomainWork,
  reminderWorkObjectId,
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
  const policy = normalizeTelegramCustomReminders({ call: { enabled: true, offsetsMinutes: [47, 5] } });
  const call = nextReminderForOrder({ status: "PENDING", type: "CALL", scheduledAt: new Date("2026-08-19T15:00:00.000Z"), reminderConfig: null }, policy, now);
  assert.equal(call.at.toISOString(), "2026-08-19T14:13:00.000Z");
  assert.match(call.key, /:47$/);

  const content = nextReminderForOrder({ status: "PENDING", type: "CONTENT", createdAt: now, reminderConfig: { enabled: true, firstAfterMinutes: 47, repeatEveryMinutes: 61 } }, policy, now);
  assert.equal(content.at.toISOString(), "2026-08-19T12:47:00.000Z");
});

test("derived reminder schedule is null until canonical Telegram TASK confirmation for every Custom type", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const policy = normalizeTelegramCustomReminders({
    content: { enabled: true, firstAfterMinutes: 5, repeatEveryMinutes: 10 },
    call: { enabled: true, offsetsMinutes: [30, 5] },
    physical: { enabled: true, repeatEveryMinutes: 15 },
  });
  const rows = [
    { status:"PENDING", type:"CONTENT", createdAt:new Date(now.getTime()-3600000), telegramTaskMessageId:null },
    { status:"PENDING", type:"CALL", scheduledAt:new Date(now.getTime()+3600000), telegramTaskMessageId:null },
    { status:"PENDING", type:"PHYSICAL", createdAt:new Date(now.getTime()-3600000), physicalStatus:"WAITING", telegramTaskMessageId:null },
  ];
  for(const row of rows){
    const desired=desiredReminderSchedule(row,policy,now,{firstAnchorAt:now});
    assert.equal(desired.at,null); assert.equal(desired.key,null);
  }
  const confirmed=desiredReminderSchedule({...rows[0],telegramTaskMessageId:700},policy,now,{firstAnchorAt:now});
  assert.equal(confirmed.at.toISOString(),"2026-08-19T12:05:00.000Z");
});

test("schema stores Telegram reference message ids directly on CustomOrder with no reference media model", () => {
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const block = schema.split("model CustomOrder {")[1].split("model AuthToken")[0];
  assert.match(block, /telegramTaskMessageId\s+Int\?/);
  assert.match(block, /telegramReferenceMessageIds\s+Int\[\]/);
  assert.doesNotMatch(schema, /model\s+CustomOrderReference\b/);
  assert.doesNotMatch(block, /storageKey|mediaKind|telegramPeerId/);
});


test("current Custom reminder control plane no longer writes legacy reminder claim fields", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const customOrders = fs.readFileSync(path.join(__dirname, "custom-orders-service.js"), "utf8");
  const settings = fs.readFileSync(path.join(__dirname, "settings-service.js"), "utf8");
  assert.doesNotMatch(customOrders, /reminderClaimToken|reminderClaimUntil/);
  assert.doesNotMatch(settings, /reminderClaimToken|reminderClaimUntil/);
});



test("A22: CALL 30/5 offsets keep the due :30 identity until its window ends", () => {
  const policy = normalizeTelegramCustomReminders({ call: { enabled: true, offsetsMinutes: [30, 5] } });
  const order = { status: "PENDING", type: "CALL", scheduledAt: new Date("2026-09-10T15:00:00.000Z"), telegramTaskMessageId: 700, reminderConfig: null };
  const at1430 = desiredReminderSchedule(order, policy, new Date("2026-09-10T14:30:00.000Z"));
  assert.match(at1430.key, /:30$/);
  assert.equal(at1430.at.toISOString(), "2026-09-10T14:30:00.000Z");
  const at1431 = desiredReminderSchedule(order, policy, new Date("2026-09-10T14:31:00.000Z"));
  assert.match(at1431.key, /:30$/);
  assert.equal(at1431.at.toISOString(), "2026-09-10T14:31:00.000Z", "catch-up keeps the due identity executable inside its window");
  const at1455 = desiredReminderSchedule(order, policy, new Date("2026-09-10T14:55:00.000Z"));
  assert.match(at1455.key, /:5$/);
  assert.equal(at1455.at.toISOString(), "2026-09-10T14:55:00.000Z");
});

test("reminder schedule revision supersedes old work without losing the replacement due item", async () => {
  const rows = new Map();
  const compound = (where) => where?.agencyId_workClass_objectType_objectId || null;
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === "state" && value?.not !== undefined) return row.state !== value.not;
    if (key === "objectId" && value?.not !== undefined) return row.objectId !== value.not;
    return row[key] === value;
  });
  const model = {
    async findUnique({ where }) {
      if (where.id) return rows.get(where.id) || null;
      const key = compound(where);
      return key ? [...rows.values()].find((row) => matches(row, key)) || null : null;
    },
    async upsert({ where, create, update }) {
      const current = await model.findUnique({ where });
      const next = current ? { ...current, ...update } : { ...create };
      rows.set(next.id, next); return { ...next };
    },
    async update({ where, data }) {
      const current = rows.get(where.id); const next = { ...current, ...data };
      if (data.requestedRevision?.increment) next.requestedRevision = BigInt(current.requestedRevision || 0) + BigInt(data.requestedRevision.increment);
      rows.set(next.id, next); return { ...next };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const [id, row] of rows) {
        if (!matches(row, where)) continue;
        rows.set(id, { ...row, ...data }); count += 1;
      }
      return { count };
    },
  };
  const db = { domainWorkItem: model };
  const order = { id: "order-call", agencyId: "agency-1", creatorId: "creator-1" };
  const first = { key: "call:order-call:g1:30", at: new Date("2026-09-10T14:30:00.000Z") };
  const second = { key: "call:order-call:g1:5", at: new Date("2026-09-10T14:55:00.000Z") };

  const a = await synchronizeReminderDomainWork({ agencyId: order.agencyId, order, desired: first, db, now: new Date("2026-09-10T14:00:00.000Z") });
  assert.equal(a.published, true);
  const firstId = reminderWorkObjectId(order.id, first.key);
  assert.equal([...rows.values()].find((row) => row.objectId === firstId)?.state, "READY");

  const b = await synchronizeReminderDomainWork({ agencyId: order.agencyId, order, desired: second, db, now: new Date("2026-09-10T14:31:00.000Z") });
  assert.equal(b.published, true);
  const secondId = reminderWorkObjectId(order.id, second.key);
  const oldRow = [...rows.values()].find((row) => row.objectId === firstId);
  const newRow = [...rows.values()].find((row) => row.objectId === secondId);
  assert.equal(oldRow.state, "DONE");
  assert.equal(oldRow.terminalCause, "REMINDER_SUPERSEDED");
  assert.equal(newRow.state, "READY");
  assert.equal(newRow.parentObjectId, order.id);
  assert.equal(new Date(newRow.availableAt).toISOString(), second.at.toISOString());
});
