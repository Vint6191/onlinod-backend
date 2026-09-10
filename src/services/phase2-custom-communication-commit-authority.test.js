"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  repairClaimedCustomModelCommunicationWork,
} = require("./telegram-delivery-authority-service");

function claimedItem(overrides = {}) {
  return {
    id: "work_comm_1",
    agencyId: "agency_1",
    creatorId: "creator_1",
    workClass: "CUSTOM_COMMUNICATION",
    objectType: "CustomOrder",
    objectId: "order_1",
    state: "CLAIMED",
    requestedRevision: 1n,
    completedRevision: 0n,
    claimedRevision: 1n,
    claimFence: 7n,
    activeGeneration: "phase2_domain_work_v1",
    ownerToken: "owner_v1",
    leaseUntil: new Date("2030-01-01T00:10:00.000Z"),
    ...overrides,
  };
}

function fakeRoot({ workRow }) {
  let mutations = 0;
  const tx = {
    agency: {
      findUnique: async () => ({ id: "agency_1", deletedAt: null, status: "ACTIVE" }),
    },
    creatorAccount: {
      findFirst: async () => ({ id: "creator_1", agencyId: "agency_1", deletedAt: null, status: "READY" }),
    },
    customOrder: {
      findFirst: async () => ({ id: "order_1", agencyId: "agency_1", creatorId: "creator_1" }),
      updateMany: async () => { mutations += 1; return { count: 1 }; },
    },
    domainWorkItem: {
      findFirst: async () => ({ ...workRow }),
      updateMany: async () => { mutations += 1; return { count: 1 }; },
    },
    telegramDeliveryIntent: {
      findMany: async () => { mutations += 1; throw new Error("stale owner reached Telegram repair"); },
      create: async () => { mutations += 1; throw new Error("stale owner created Telegram intent"); },
      updateMany: async () => { mutations += 1; throw new Error("stale owner changed Telegram intent"); },
    },
    providerOperationalDebt: {
      deleteMany: async () => { mutations += 1; throw new Error("stale owner changed provider projection"); },
      createMany: async () => { mutations += 1; throw new Error("stale owner changed provider projection"); },
    },
  };
  const root = { $transaction: async (work) => work(tx) };
  return { root, getMutations: () => mutations };
}

test("A4 CUSTOM_COMMUNICATION: reclaimed owner is fenced before Telegram/provider mutation", async () => {
  const item = claimedItem();
  const { root, getMutations } = fakeRoot({ workRow: { ...item, ownerToken: "owner_v2", claimFence: 8n } });

  const result = await repairClaimedCustomModelCommunicationWork({
    agencyId: "agency_1",
    orderId: "order_1",
    workItem: item,
    ownerToken: "owner_v1",
    now: new Date("2029-12-31T23:59:00.000Z"),
    db: root,
  });

  assert.equal(result.lostOwnership, true);
  assert.equal(getMutations(), 0, "lost owner must not reach domain mutation before detecting the fence");
});

test("A1/A4 CUSTOM_COMMUNICATION: claimed V1 does not execute newer V2 canonical revision", async () => {
  const item = claimedItem();
  const { root, getMutations } = fakeRoot({ workRow: { ...item, requestedRevision: 2n } });

  const result = await repairClaimedCustomModelCommunicationWork({
    agencyId: "agency_1",
    orderId: "order_1",
    workItem: item,
    ownerToken: "owner_v1",
    now: new Date("2029-12-31T23:59:00.000Z"),
    db: root,
  });

  assert.equal(result.lostOwnership, false);
  assert.equal(result.superseded, true);
  assert.equal(getMutations(), 0, "V1 must leave V2 executable instead of mutating current state under the old claim");
});

test("CUSTOM_COMMUNICATION commit authority preserves Order -> DomainWork lock order and scheduler uses it", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const telegram = fs.readFileSync(path.join(__dirname, "telegram-delivery-authority-service.js"), "utf8");
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");

  const start = telegram.indexOf("async function repairClaimedCustomModelCommunicationWork");
  const end = telegram.indexOf("async function repairCurrentCustomModelCommunicationForOrder", start);
  assert.ok(start >= 0 && end > start);
  const body = telegram.slice(start, end);
  assert.ok(body.indexOf("lockClaimedCustomCommunicationOrder") < body.indexOf("lockDomainWorkClaimForCommit"));
  assert.match(body, /authority\.newerRevision/);
  assert.match(scheduler, /repairClaimedCustomModelCommunicationWork/);
  assert.doesNotMatch(scheduler.slice(scheduler.indexOf("async function maybeRepairProviderOperationalDirty"), scheduler.indexOf("async function listDependencyFanoutOrders")), /repairCurrentCustomModelCommunicationForOrder/);
});
