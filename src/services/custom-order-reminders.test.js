"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeTelegramCustomReminders,
  normalizeReminderOverride,
  nextReminderForOrder,
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
