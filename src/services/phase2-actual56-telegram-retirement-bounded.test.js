"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { processTelegramAccountRetirementFanout } = require("./telegram-account-retirement-fanout-service");

function fakeDb(creatorCount = 125) {
  const account = { id: "tg-1", agencyId: "agency-1", lifecycleState: "RETIRING" };
  const creators = Array.from({ length: creatorCount }, (_, i) => ({
    id: `creator-${String(i + 1).padStart(3, "0")}`,
    agencyId: "agency-1",
    telegramAccountId: "tg-1",
  }));
  const stats = { updateBatches: [], accountDeletes: 0 };

  return {
    stats,
    creators,
    account,
    agencyTelegramMtprotoAccount: {
      async findFirst({ where }) {
        if (!account.id) return null;
        if (where.id !== account.id || where.agencyId !== account.agencyId) return null;
        return { ...account };
      },
      async deleteMany({ where }) {
        if (account.id && where.id === account.id && where.agencyId === account.agencyId && where.lifecycleState === account.lifecycleState) {
          account.id = null;
          stats.accountDeletes += 1;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    creatorAccount: {
      async findMany({ where, take }) {
        return creators
          .filter((row) => row.agencyId === where.agencyId && row.telegramAccountId === where.telegramAccountId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take)
          .map(({ id }) => ({ id }));
      },
      async updateMany({ where, data }) {
        const wanted = new Set(where.id.in);
        let count = 0;
        for (const row of creators) {
          if (row.agencyId === where.agencyId && wanted.has(row.id) && row.telegramAccountId === where.telegramAccountId) {
            row.telegramAccountId = data.telegramAccountId;
            count += 1;
          }
        }
        stats.updateBatches.push(count);
        return { count };
      },
      async findFirst({ where }) {
        const row = creators.find((entry) => entry.agencyId === where.agencyId && entry.telegramAccountId === where.telegramAccountId);
        return row ? { id: row.id } : null;
      },
    },
  };
}

const item = { agencyId: "agency-1", objectId: "tg-1", objectType: "TelegramAccountRetirement" };

test("Telegram account retirement detaches creators in bounded restartable batches before final delete", async () => {
  const db = fakeDb(125);

  const first = await processTelegramAccountRetirementFanout({ db, item, batchSize: 50 });
  assert.equal(first.complete, false);
  assert.equal(first.detached, 50);
  assert.equal(db.creators.filter((row) => row.telegramAccountId === "tg-1").length, 75);
  assert.equal(db.stats.accountDeletes, 0);

  // Simulate a crash/restart: progressCursor is intentionally not supplied back.
  // Durable CreatorAccount bindings are the progress authority.
  const second = await processTelegramAccountRetirementFanout({ db, item, batchSize: 50 });
  assert.equal(second.complete, false);
  assert.equal(second.detached, 50);
  assert.equal(db.creators.filter((row) => row.telegramAccountId === "tg-1").length, 25);
  assert.equal(db.stats.accountDeletes, 0);

  const third = await processTelegramAccountRetirementFanout({ db, item, batchSize: 50 });
  assert.equal(third.complete, false);
  assert.equal(third.detached, 25);
  assert.equal(db.creators.filter((row) => row.telegramAccountId === "tg-1").length, 0);
  assert.equal(db.stats.accountDeletes, 0);

  const fourth = await processTelegramAccountRetirementFanout({ db, item, batchSize: 50 });
  assert.equal(fourth.complete, true);
  assert.equal(db.stats.accountDeletes, 1);
  assert.deepEqual(db.stats.updateBatches, [50, 50, 25]);

  // Retry after delete is idempotent/obsolete rather than recreating work.
  const retry = await processTelegramAccountRetirementFanout({ db, item, batchSize: 50 });
  assert.equal(retry.complete, true);
  assert.equal(retry.obsolete, true);
  assert.equal(db.stats.accountDeletes, 1);
});

test("Telegram account retirement refuses non-RETIRING account", async () => {
  const db = fakeDb(1);
  db.account.lifecycleState = "ACTIVE";
  await assert.rejects(
    () => processTelegramAccountRetirementFanout({ db, item }),
    (err) => err && err.code === "TELEGRAM_ACCOUNT_RETIREMENT_STATE_INVALID",
  );
  assert.equal(db.creators[0].telegramAccountId, "tg-1");
  assert.equal(db.stats.accountDeletes, 0);
});
