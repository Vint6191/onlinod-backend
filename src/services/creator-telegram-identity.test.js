"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTelegramUserId, setCreatorTelegramUserId } = require("./creator-telegram-identity");


const fs = require("node:fs");
const path = require("node:path");

test("Creator Telegram identity has an additive backend column and agency lookup index", () => {
  const root = path.join(__dirname, "..", "..");
  const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(root, "prisma", "migrations", "20260819000500_creator_telegram_user_identity", "migration.sql"), "utf8");
  const creatorBlock = schema.split("model CreatorAccount {")[1].split("model CustomOrder {")[0];
  const subscriptionBlock = schema.split("model AgencySubscription {")[1].split("model CreatorBillingProfile {")[0];
  assert.match(creatorBlock, /telegramUserId\s+String\?/);
  assert.match(creatorBlock, /@@index\(\[agencyId, telegramUserId\]\)/);
  assert.doesNotMatch(subscriptionBlock, /telegramUserId/);
  assert.equal((schema.match(/@@index\(\[agencyId, telegramUserId\]\)/g) || []).length, 1);
  assert.match(migration, /ADD COLUMN "telegramUserId" TEXT/);
  assert.match(migration, /CreatorAccount_agencyId_telegramUserId_idx/);
  assert.doesNotMatch(migration, /DROP|DELETE|TRUNCATE/i);
});

test("Telegram user id normalization preserves 64-bit ids as strings", () => {
  assert.equal(normalizeTelegramUserId(" 1234567890123456789 "), "1234567890123456789");
  assert.throws(() => normalizeTelegramUserId("12.5"), /positive integer string/);
  assert.throws(() => normalizeTelegramUserId("9223372036854775808"), /64-bit range/);
});

test("resolved Telegram user id is stored only for creators with a Telegram contact", async () => {
  const updates = [];
  const db = {
    creatorAccount: {
      findFirst: async ({ where }) => where.id === "creator_1" ? { id: "creator_1", telegramContact: "@model" } : null,
      update: async ({ where, data }) => { updates.push({ where, data }); return { id: where.id, ...data }; },
    },
  };
  const result = await setCreatorTelegramUserId({ agencyId: "agency_1", creatorId: "creator_1", telegramUserId: "999999999999999999", db });
  assert.equal(result.telegramUserId, "999999999999999999");
  assert.deepEqual(updates[0], { where: { id: "creator_1" }, data: { telegramUserId: "999999999999999999" } });
});

test("resolved Telegram user id is rejected when the model contact is absent", async () => {
  const db = {
    creatorAccount: {
      findFirst: async () => ({ id: "creator_1", telegramContact: null }),
      update: async () => assert.fail("must not update"),
    },
  };
  await assert.rejects(
    () => setCreatorTelegramUserId({ agencyId: "agency_1", creatorId: "creator_1", telegramUserId: "123", db }),
    (error) => error?.code === "CREATOR_TELEGRAM_CONTACT_REQUIRED",
  );
});
