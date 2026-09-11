"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { setMemberStatus } = require("./team-administration-service");
const { updateCreatorTelegramContact } = require("./creator-telegram-contact-authority-service");
const { setCreatorTelegramUserId } = require("./creator-telegram-identity");

const admittedTeamActor = {
  id: "member-manager", userId: "user-manager", agencyId: "agency-1",
  role: "MANAGER", roleKey: "manager", assignedCreators: "all", accessEpoch: 7,
  permissions: { "workspace.manage_members": true, "creators.manage": true },
};

function baseDb({ livePermissions }) {
  const agency = { id: "agency-1", deletedAt: null, status: "ACTIVE" };
  const actor = { ...admittedTeamActor, permissions: livePermissions, deletedAt: null, deactivatedAt: null };
  const target = { id: "member-target", userId: "user-target", agencyId: "agency-1", role: "OPERATOR", roleKey: "chatter", assignedCreators: [], accessEpoch: 2, deletedAt: null, deactivatedAt: null };
  const creator = { id: "creator-1", agencyId: "agency-1", deletedAt: null, status: "READY", telegramContact: "@old", telegramUserId: null, telegramAccountId: null };
  let mutations = 0;
  const db = {
    agency: { async findUnique({ where }) { return where.id === agency.id ? { ...agency } : null; } },
    agencyMember: {
      async findFirst({ where }) {
        if (where.id === actor.id) return { ...actor };
        if (where.id === target.id) return { ...target };
        return null;
      },
      async update() { mutations += 1; return { ...target }; },
    },
    creatorAccount: {
      async findFirst({ where, select }) {
        if (where.id !== creator.id || where.agencyId !== creator.agencyId) return null;
        if (!select) return { ...creator };
        const out = {}; for (const [key, enabled] of Object.entries(select)) if (enabled) out[key] = creator[key]; return out;
      },
      async findMany({ where }) {
        const ids = Array.isArray(where?.id?.in) ? where.id.in.map(String) : [];
        return ids.includes(creator.id) && where.agencyId === creator.agencyId ? [{ id: creator.id }] : [];
      },
      async update() { mutations += 1; return { ...creator }; },
      async updateMany() { mutations += 1; return { count: 1 }; },
    },
    refreshSession: { async updateMany() { mutations += 1; return { count: 0 }; } },
    async $transaction(work) { return work(db); },
    _mutations() { return mutations; },
  };
  return db;
}

test("A39 member status commit rejects workspace.manage_members revoked after route admission", async () => {
  const db = baseDb({ livePermissions: { "workspace.manage_members": false, "creators.manage": true } });
  await assert.rejects(
    () => setMemberStatus({ agencyId: "agency-1", memberId: "member-target", status: "active", actorMember: admittedTeamActor, actorUserId: admittedTeamActor.userId, db }),
    (error) => error?.code === "MANAGEMENT_PERMISSION_REVOKED" && error?.status === 403,
  );
  assert.equal(db._mutations(), 0);
});

test("A40 creator Telegram contact commit rejects creators.manage revoked after route admission", async () => {
  const db = baseDb({ livePermissions: { "workspace.manage_members": true, "creators.manage": false } });
  await assert.rejects(
    () => updateCreatorTelegramContact({ agencyId: "agency-1", actorMember: admittedTeamActor, actorUserId: admittedTeamActor.userId, creatorId: "creator-1", telegramContact: "@new", telegramAccountId: null, db }),
    (error) => error?.code === "MANAGEMENT_PERMISSION_REVOKED" && error?.status === 403,
  );
  assert.equal(db._mutations(), 0);
});

test("A40 creator Telegram identity commit keeps contact CAS behind current creators.manage authority", async () => {
  const db = baseDb({ livePermissions: { "workspace.manage_members": true, "creators.manage": false } });
  await assert.rejects(
    () => setCreatorTelegramUserId({ agencyId: "agency-1", actorMember: admittedTeamActor, creatorId: "creator-1", telegramUserId: "123456", expectedTelegramContact: "@old", db }),
    (error) => error?.code === "MANAGEMENT_PERMISSION_REVOKED" && error?.status === 403,
  );
  assert.equal(db._mutations(), 0);
});
