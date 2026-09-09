"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { attachManagementAuthority, phase2ManagerActor } = require("./phase2-test-authority-fixtures");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-tip-ledger-service");

function loadService({ targetState = "deactivated" } = {}) {
  let row = {
    id: "tip-1",
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    eventHash: "tip-hash-1",
    amountCents: 2500,
    currency: "USD",
    receivedAt: new Date(),
    status: "conflict",
    attributedMemberId: null,
    attributedUserId: null,
    attributedShiftKey: null,
    resolvedSource: "creator_tip_conflict",
    financialStatus: "done",
    candidates: [],
    weakCandidates: [],
    result: {},
    history: [],
  };
  const tx = {
    async $transaction(fn) { return fn(tx); },
    agencyMember: {
      async findFirst({ where }) {
        if (where.id === "target-1") {
          if (targetState === "removed") return null;
          return {
            id: "target-1",
            userId: "user-target-1",
            agencyId: "agency-1",
            deletedAt: null,
            deactivatedAt: targetState === "deactivated" ? new Date("2026-09-01T00:00:00.000Z") : null,
            role: "OPERATOR",
            roleKey: "chatter",
          };
        }
        return null;
      },
      async findMany() { return []; },
    },
    teamTipLedger: {
      async findFirst() { return { ...row }; },
      async update({ data }) { row = { ...row, ...data }; return { ...row }; },
    },
    teamActivityEvent: { async create() { return {}; } },
  };
  attachManagementAuthority(tx, { actor: phase2ManagerActor({ id: "manager-1", userId: "user-manager-1", creatorIds: ["creator-1"] }) });
  const prisma = { async $transaction(fn) { return fn(tx); }, agencyMember: tx.agencyMember };
  delete require.cache[servicePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  return { service: require(servicePath), getRow: () => ({ ...row }) };
}

test("Tip historical adjudication allows a deactivated but non-removed agency member", async () => {
  const { service, getRow } = loadService({ targetState: "deactivated" });
  const result = await service.applyTipOverride({
    agencyId: "agency-1",
    byUserId: "user-manager-1",
    byMemberId: "manager-1",
    actorMember: phase2ManagerActor({ id: "manager-1", userId: "user-manager-1", creatorIds: ["creator-1"] }),
    eventHash: "tip-hash-1",
    action: "manager_override",
    targetMemberId: "target-1",
    reason: "Historical work belongs to this former worker",
    senior: true,
    allowedCreatorIds: ["creator-1"],
  });
  assert.equal(result.ok, true);
  assert.equal(getRow().attributedMemberId, "target-1");
  assert.equal(getRow().attributedUserId, "user-target-1");
});

test("Tip historical adjudication rejects a removed member with the shared target code", async () => {
  const { service, getRow } = loadService({ targetState: "removed" });
  const result = await service.applyTipOverride({
    agencyId: "agency-1",
    byUserId: "user-manager-1",
    byMemberId: "manager-1",
    actorMember: phase2ManagerActor({ id: "manager-1", userId: "user-manager-1", creatorIds: ["creator-1"] }),
    eventHash: "tip-hash-1",
    action: "manager_override",
    targetMemberId: "target-1",
    reason: "Attempting historical reassignment",
    senior: true,
    allowedCreatorIds: ["creator-1"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "HISTORICAL_ATTRIBUTION_TARGET_INVALID");
  assert.equal(getRow().attributedMemberId, null);
});
