"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTelegramUserId, setCreatorTelegramUserId } = require("./creator-telegram-identity");

const fs = require("node:fs");
const path = require("node:path");

const owner = { id: "owner-1", userId: "user-owner", agencyId: "agency_1", role: "OWNER", roleKey: "owner", permissions: { "creators.manage": true }, assignedCreators: "all", accessEpoch: 1 };

function identityDb({ contact = "@model", updateCount = 1 } = {}) {
  const creator = { id: "creator_1", agencyId: "agency_1", deletedAt: null, status: "READY", telegramContact: contact, telegramUserId: null };
  const updates = [];
  const db = {
    agency: { async findUnique({ where }) { return where.id === "agency_1" ? { id: "agency_1", deletedAt: null, status: "ACTIVE" } : null; } },
    agencyMember: { async findFirst({ where }) { return (!where.id || where.id === owner.id) && (!where.userId || where.userId === owner.userId) ? { ...owner, deletedAt: null, deactivatedAt: null } : null; } },
    creatorAccount: {
      async updateMany({ where, data }) {
        updates.push({ where, data });
        if (updateCount !== 1 || where.id !== creator.id || where.agencyId !== creator.agencyId || where.telegramContact !== creator.telegramContact) return { count: 0 };
        Object.assign(creator, data);
        return { count: 1 };
      },
      async findFirst({ where, select }) {
        if (where.id !== creator.id || where.agencyId !== creator.agencyId) return null;
        if (select) { const out = {}; for (const [k,v] of Object.entries(select)) if (v) out[k] = creator[k]; return out; }
        return { ...creator };
      },
    },
    async $transaction(work) { return work(db); },
    _updates: updates,
  };
  return db;
}

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

test("resolved Telegram user id is atomically bound only while the resolved contact still matches", async () => {
  const db = identityDb();
  const result = await setCreatorTelegramUserId({
    agencyId: "agency_1",
    actorMember: owner,
    creatorId: "creator_1",
    telegramUserId: "999999999999999999",
    expectedTelegramContact: "@model",
    db,
  });
  assert.equal(result.telegramUserId, "999999999999999999");
  assert.deepEqual(db._updates[0], {
    where: { id: "creator_1", agencyId: "agency_1", deletedAt: null, telegramContact: "@model" },
    data: { telegramUserId: "999999999999999999" },
  });
});

test("resolved Telegram identity is rejected if the model contact changed during resolution", async () => {
  const db = identityDb({ contact: "@new_model", updateCount: 0 });
  await assert.rejects(
    () => setCreatorTelegramUserId({
      agencyId: "agency_1",
      actorMember: owner,
      creatorId: "creator_1",
      telegramUserId: "123",
      expectedTelegramContact: "@old_model",
      db,
    }),
    (error) => error?.code === "CREATOR_TELEGRAM_CONTACT_CHANGED" && error?.status === 409,
  );
});

test("creator API exposes a scoped contact-bound Telegram identity persistence route for Desktop resolution", () => {
  const root = path.join(__dirname, "..", "..");
  const route = fs.readFileSync(path.join(root, "src", "routes", "creators.js"), "utf8");
  assert.match(route, /router\.patch\("\/:id\/telegram-identity", creatorManagementRequired, creatorAccessRequired/);
  assert.match(route, /telegramContact: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(160\)/);
  assert.match(route, /expectedTelegramContact: input\.telegramContact/);
  assert.match(route, /creator\.telegram_identity\.resolved/);
  assert.doesNotMatch(route, /telegram-identity[\s\S]{0,1800}(apiHash|session)/);
});
