"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateCreatorTelegramContact } = require("./creator-telegram-contact-authority-service");

function clone(value) { return value == null ? value : structuredClone(value); }

function fakeDb({ lifecycleState = "ACTIVE", accountExists = true } = {}) {
  let account = accountExists ? {
    id: "tg-1", agencyId: "agency-1", apiId: 12345, lifecycleState,
    retirementRequestedAt: lifecycleState === "RETIRING" ? new Date("2026-09-05T12:00:00.000Z") : null,
    retirementDrainCompletedAt: lifecycleState === "RETIRING" ? new Date("2026-09-05T12:00:01.000Z") : null,
    runtimeClaimedByDeviceId: null, runtimeClaimUntil: null,
    runtimeClaimGeneration: 0, runtimeDrainedGeneration: 0,
  } : null;
  const creator = {
    id: "creator-1", agencyId: "agency-1", deletedAt: null,
    telegramContact: "@old", telegramUserId: "900001", telegramAccountId: null,
  };
  const audits = [];
  let tail = Promise.resolve();

  const db = {
    agencyTelegramMtprotoAccount: {
      async findFirst({ where, select = null }) {
        if (!account || where.id !== account.id || where.agencyId !== account.agencyId) return null;
        if (where.lifecycleState !== undefined && String(account.lifecycleState || "ACTIVE") !== String(where.lifecycleState)) return null;
        if (Array.isArray(where.OR)) {
          const ok = where.OR.some((entry) => entry.lifecycleState === account.lifecycleState || (entry.lifecycleState === null && account.lifecycleState == null));
          if (!ok) return null;
        }
        if (!select) return clone(account);
        const out = {};
        for (const [key, enabled] of Object.entries(select)) if (enabled) out[key] = clone(account[key]);
        return out;
      },
      async updateMany({ where, data }) {
        if (!account || where.id !== account.id || where.agencyId !== account.agencyId) return { count: 0 };
        if (where.lifecycleState !== undefined && String(account.lifecycleState || "ACTIVE") !== String(where.lifecycleState)) return { count: 0 };
        if (Array.isArray(where.OR)) {
          const ok = where.OR.some((entry) => entry.lifecycleState === account.lifecycleState || (entry.lifecycleState === null && account.lifecycleState == null));
          if (!ok) return { count: 0 };
        }
        if (where.runtimeClaimGeneration !== undefined && Number(account.runtimeClaimGeneration || 0) !== Number(where.runtimeClaimGeneration)) return { count: 0 };
        if (where.runtimeDrainedGeneration !== undefined && Number(account.runtimeDrainedGeneration || 0) !== Number(where.runtimeDrainedGeneration)) return { count: 0 };
        Object.assign(account, clone(data));
        return { count: 1 };
      },
      async delete({ where }) {
        assert.equal(where.id, account?.id);
        account = null;
        return {};
      },
    },
    creatorAccount: {
      async findFirst({ where, select = null }) {
        if (where.id !== creator.id || where.agencyId !== creator.agencyId || creator.deletedAt) return null;
        if (!select) return clone(creator);
        const out = {};
        for (const [key, enabled] of Object.entries(select)) if (enabled) out[key] = clone(creator[key]);
        return out;
      },
      async update({ where, data }) {
        assert.equal(where.id, creator.id);
        Object.assign(creator, clone(data));
        return clone(creator);
      },
      async updateMany({ where, data }) {
        if (where.agencyId !== creator.agencyId || creator.telegramAccountId !== where.telegramAccountId) return { count: 0 };
        Object.assign(creator, clone(data));
        return { count: 1 };
      },
    },
    telegramDeliveryIntent: { findFirst: async () => null, findMany: async () => [] },
    customContentSubmission: { findMany: async () => [] },
    telegramInboundEvent: { findFirst: async () => null },
    auditLog: { async create({ data }) { audits.push(clone(data)); return { id: `audit-${audits.length}`, ...clone(data) }; } },
    async $transaction(work) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      const accountSnapshot = clone(account);
      const creatorSnapshot = clone(creator);
      const auditLength = audits.length;
      try { return await work(db); }
      catch (error) {
        account = clone(accountSnapshot);
        Object.assign(creator, clone(creatorSnapshot));
        audits.splice(auditLength);
        throw error;
      } finally { release(); }
    },
    _state: () => ({ account: clone(account), creator: clone(creator), audits: clone(audits) }),
  };
  return db;
}

const owner = { id: "owner-1", userId: "user-owner", agencyId: "agency-1", role: "OWNER", roleKey: "owner" };

test("F41 creator Telegram assignment rejects RETIRING account without writing a stale current reference", async () => {
  const db = fakeDb({ lifecycleState: "RETIRING" });
  await assert.rejects(
    () => updateCreatorTelegramContact({ agencyId: "agency-1", actorUserId: owner.userId, creatorId: "creator-1", telegramContact: "@new", telegramAccountId: "tg-1", db }),
    (error) => error?.code === "CREATOR_TELEGRAM_ACCOUNT_RETIRING" && error?.status === 409,
  );
  assert.equal(db._state().creator.telegramAccountId, null);
  assert.equal(db._state().creator.telegramContact, "@old");
});

test("F41 creator Telegram assignment cannot resurrect a deleted account after retirement wins", async () => {
  const db = fakeDb();
  // Simulate the already-tested retirement authority winning first: current assignments are cleared and the account row is deleted.
  const stateBefore = db._state();
  assert.ok(stateBefore.account);
  await db.creatorAccount.updateMany({ where: { agencyId: "agency-1", telegramAccountId: "tg-1" }, data: { telegramAccountId: null } });
  await db.agencyTelegramMtprotoAccount.delete({ where: { id: "tg-1" } });
  assert.equal(db._state().account, null);
  await assert.rejects(
    () => updateCreatorTelegramContact({ agencyId: "agency-1", actorUserId: owner.userId, creatorId: "creator-1", telegramContact: "@new", telegramAccountId: "tg-1", db }),
    (error) => error?.code === "CREATOR_TELEGRAM_ACCOUNT_INVALID" && error?.status === 404,
  );
  assert.equal(db._state().creator.telegramAccountId, null);
});

test("F41 creator assignment wins ACTIVE account row first and later explicit removal deterministically unassigns it", async () => {
  const db = fakeDb();
  const assigned = await updateCreatorTelegramContact({ agencyId: "agency-1", actorUserId: owner.userId, creatorId: "creator-1", telegramContact: "@new", telegramAccountId: "tg-1", db });
  assert.equal(assigned.telegramAccountId, "tg-1");
  assert.equal(db._state().creator.telegramAccountId, "tg-1");

  // The later explicit removal authority unassigns current references before deleting the account.
  await db.creatorAccount.updateMany({ where: { agencyId: "agency-1", telegramAccountId: "tg-1" }, data: { telegramAccountId: null } });
  await db.agencyTelegramMtprotoAccount.delete({ where: { id: "tg-1" } });
  assert.equal(db._state().account, null);
  assert.equal(db._state().creator.telegramAccountId, null, "explicit removal remains the deterministic later operation");
});

test("F41 retirement transaction winning first blocks a concurrently started creator assignment", async () => {
  const db = fakeDb();
  let retiringResolve;
  const retiring = new Promise((resolve) => { retiringResolve = resolve; });
  let allowRetireResolve;
  const allowRetire = new Promise((resolve) => { allowRetireResolve = resolve; });

  const retirement = db.$transaction(async (tx) => {
    const locked = await tx.agencyTelegramMtprotoAccount.updateMany({
      where: { id: "tg-1", agencyId: "agency-1", OR: [{ lifecycleState: "ACTIVE" }, { lifecycleState: null }] },
      data: { lifecycleState: "RETIRING" },
    });
    assert.equal(locked.count, 1);
    retiringResolve();
    await allowRetire;
  });
  await retiring;

  const assignment = updateCreatorTelegramContact({
    agencyId: "agency-1", actorUserId: owner.userId, creatorId: "creator-1",
    telegramContact: "@new", telegramAccountId: "tg-1", db,
  });
  allowRetireResolve();
  await retirement;
  await assert.rejects(assignment, (error) => error?.code === "CREATOR_TELEGRAM_ACCOUNT_RETIRING");
  assert.equal(db._state().creator.telegramAccountId, null);
  assert.equal(db._state().creator.telegramContact, "@old");
});
