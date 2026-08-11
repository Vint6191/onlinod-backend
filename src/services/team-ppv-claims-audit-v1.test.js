"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
const servicePath = require.resolve("./team-ppv-ledger-service");

function loadService() {
  const state = {
    queryCount: 0,
    purchaseWrites: [],
    jobWrites: [],
    auditRows: [],
    activityRows: [],
    transactions: 0,
  };
  const job = {
    id: "job-1",
    agencyId: "agency-1",
    accountId: "creator-1",
    creatorId: "creator-1",
    creatorRef: "creator",
    purchaseId: "purchase-1",
    messageId: "message-1",
    amountCents: 5000,
    currency: "USD",
    purchasedAt: new Date("2026-08-11T20:00:00.000Z"),
    status: "conflict",
    result: { candidates: [] },
  };
  const purchase = { purchaseId: "purchase-1", status: "conflict" };
  const tx = {
    async $queryRaw() {
      state.queryCount += 1;
      return state.queryCount % 2 === 1 ? [job] : [purchase];
    },
    teamPpvPurchaseLedger: {
      async upsert(args) { state.purchaseWrites.push(args); return args.update || args.create; },
    },
    teamPpvResolveJob: {
      async update(args) { state.jobWrites.push(args); return { ...job, ...args.data }; },
    },
    teamPpvClaimAudit: {
      async create({ data }) {
        const row = { id: `audit-${state.auditRows.length + 1}`, createdAt: new Date(), ...data };
        state.auditRows.push(row);
        return row;
      },
    },
    agencyMember: {
      async findFirst({ where }) {
        if (where.id === "outside-agency-member") return null;
        return { id: where.id, userId: `user-${where.id}`, displayName: where.id };
      },
      async findMany() { return []; },
    },
    teamActivityEvent: {
      async findFirst() { return null; },
      async create({ data }) { state.activityRows.push(data); return { id: `event-${state.activityRows.length}`, ...data }; },
    },
  };
  const prisma = {
    async $transaction(fn) { state.transactions += 1; return fn(tx); },
  };
  delete require.cache[servicePath];
  delete require.cache[prismaPath];
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma };
  const service = require(servicePath);
  return { service, state };
}

test("PPV manager decisions require a real actor and reason before any DB write", async () => {
  const { service, state } = loadService();
  const noActor = await service.resolvePpvConflict({
    agencyId: "agency-1", jobId: "job-1", memberId: "chatter-1", action: "assign", reason: "Reviewed evidence",
  });
  assert.equal(noActor.code, "RESOLUTION_ACTOR_REQUIRED");

  const noReason = await service.resolvePpvConflict({
    agencyId: "agency-1", jobId: "job-1", memberId: "chatter-1", actorMemberId: "manager-1", action: "assign", reason: "x",
  });
  assert.equal(noReason.code, "RESOLUTION_REASON_REQUIRED");
  assert.equal(state.transactions, 0);
});

test("PPV assign rejects a selected member that is not active in the same agency", async () => {
  const { service, state } = loadService();
  const result = await service.resolvePpvConflict({
    agencyId: "agency-1",
    jobId: "job-1",
    memberId: "outside-agency-member",
    actorMemberId: "manager-1",
    action: "assign",
    reason: "Reviewed evidence",
  });

  assert.equal(result.code, "RESOLUTION_MEMBER_INVALID");
  assert.equal(state.purchaseWrites.length, 0);
  assert.equal(state.jobWrites.length, 0);
  assert.equal(state.auditRows.length, 0);
});

test("PPV assign keeps selected chatter separate from manager actor in immutable audit", async () => {
  const { service, state } = loadService();
  const result = await service.resolvePpvConflict({
    agencyId: "agency-1",
    jobId: "job-1",
    memberId: "chatter-1",
    actorMemberId: "manager-1",
    action: "assign",
    reason: "Reviewed exact sent-message evidence",
    deviceId: "device-1",
  });

  assert.equal(result.action, "assign");
  assert.equal(state.purchaseWrites[0].update.status, "attributed");
  assert.equal(state.purchaseWrites[0].update.attributedMemberId, "chatter-1");
  assert.equal(state.jobWrites[0].data.resolvedByMemberId, "chatter-1");
  assert.equal(state.auditRows.length, 1);
  assert.equal(state.auditRows[0].actorMemberId, "manager-1");
  assert.equal(state.auditRows[0].selectedMemberId, "chatter-1");
  assert.equal(state.auditRows[0].reason, "Reviewed exact sent-message evidence");
  assert.equal(state.auditRows[0].evidence.jobStatusBefore, "conflict");
});

test("PPV creator_revenue closes chatter attribution without inventing an owner", async () => {
  const { service, state } = loadService();
  const result = await service.resolvePpvConflict({
    agencyId: "agency-1",
    jobId: "job-1",
    actorMemberId: "manager-1",
    action: "creator_revenue",
    reason: "No defensible chatter attribution",
    deviceId: "device-1",
  });

  assert.equal(result.action, "creator_revenue");
  assert.equal(state.purchaseWrites[0].update.status, "creator_revenue");
  assert.equal(state.purchaseWrites[0].update.attributedMemberId, null);
  assert.equal(state.auditRows[0].actorMemberId, "manager-1");
  assert.equal(state.auditRows[0].selectedMemberId, null);
  assert.equal(state.activityRows.length, 0, "creator revenue must not emit chatter revenue activity");
});
