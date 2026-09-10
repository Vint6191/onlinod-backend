"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectCreatorPhase2DestructiveScope,
  purgeAgencyPhase2ProviderLedgersForHardDelete,
  purgeAgencyPhase2CurrentWorkRootsAfterCascade,
  purgeCreatorPhase2ResidualsForHardDelete,
} = require("./phase2-destructive-delete-authority-service");

function deepClone(value) {
  return structuredClone(value);
}

function deleteByAgency(state, key, agencyId) {
  const before = state[key].length;
  state[key] = state[key].filter((row) => row.agencyId !== agencyId);
  return { count: before - state[key].length };
}

async function rollbackTransaction(state, work) {
  const snapshot = deepClone(state);
  const tx = {
    providerOperationalDebt: { deleteMany: async ({ where }) => deleteByAgency(state, "provider", where.agencyId) },
    telegramDeliveryIntent: { deleteMany: async ({ where }) => deleteByAgency(state, "intent", where.agencyId) },
    telegramInboundEvent: { deleteMany: async ({ where }) => deleteByAgency(state, "inbound", where.agencyId) },
    agency: { delete: async () => { throw Object.assign(new Error("restrictive child survived"), { code: "P2003" }); } },
  };
  try {
    return await work(tx);
  } catch (error) {
    for (const key of Object.keys(snapshot)) state[key] = snapshot[key];
    throw error;
  }
}

test("A47 Agency provider-ledger purge is rollback-safe when the later canonical cascade fails", async () => {
  const state = {
    provider: [{ id: "pod-1", agencyId: "agency-1" }, { id: "pod-2", agencyId: "agency-2" }],
    intent: [{ id: "intent-1", agencyId: "agency-1" }],
    inbound: [{ id: "inbound-1", agencyId: "agency-1" }],
  };
  const before = deepClone(state);

  await assert.rejects(
    rollbackTransaction(state, async (tx) => {
      await purgeAgencyPhase2ProviderLedgersForHardDelete({ db: tx, agencyId: "agency-1" });
      await tx.agency.delete({ where: { id: "agency-1" } });
    }),
    (error) => error?.code === "P2003",
  );

  assert.deepEqual(state, before, "failed hard delete must restore non-FK provider ledgers atomically");
});

test("A47 creator destructive scope captures order/submission/provider identities before cascade", async () => {
  const captured = {};
  const db = {
    customOrder: { findMany: async ({ where }) => { captured.orders = where; return [{ id: "order-1" }, { id: "order-2" }]; } },
    customContentSubmission: { findMany: async ({ where }) => { captured.submissions = where; return [{ id: "sub-1" }]; } },
    telegramDeliveryIntent: { findMany: async ({ where }) => { captured.intents = where; return [{ id: "intent-1" }]; } },
    telegramInboundEvent: { findMany: async ({ where }) => { captured.inbound = where; return [{ id: "inbound-1" }]; } },
    automationDelivery: { findMany: async ({ where }) => { captured.deliveries = where; return [{ id: "write-1" }]; } },
  };

  const scope = await collectCreatorPhase2DestructiveScope({ db, agencyId: "agency-1", creatorId: "creator-1" });
  assert.deepEqual(scope, {
    agencyId: "agency-1", creatorId: "creator-1",
    orderIds: ["order-1", "order-2"], submissionIds: ["sub-1"], intentIds: ["intent-1"], inboundIds: ["inbound-1"], deliveryIds: ["write-1"],
    bounded: true,
  });
  assert.deepEqual(captured.orders, { agencyId: "agency-1", creatorId: "creator-1" });
  assert.deepEqual(captured.submissions, { agencyId: "agency-1", creatorId: "creator-1" });
  assert.deepEqual(captured.intents.OR, [
    { creatorId: "creator-1" }, { customOrderId: { in: ["order-1", "order-2"] } }, { customSubmissionId: { in: ["sub-1"] } },
  ]);
  assert.deepEqual(captured.inbound.OR, [
    { creatorId: "creator-1" }, { customOrderId: { in: ["order-1", "order-2"] } }, { submissionId: { in: ["sub-1"] } },
  ]);
  assert.deepEqual(captured.deliveries.actionType, { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] });
});

test("A47 creator cleanup removes provider rows and trigger-created DomainWork/dependency orphans by exact captured identities", async () => {
  const calls = {};
  const count = (name) => async (args) => { calls[name] = args; return { count: 1 }; };
  const db = {
    telegramDeliveryIntent: { deleteMany: count("intent") },
    telegramInboundEvent: { deleteMany: count("inbound") },
    providerOperationalDebt: { deleteMany: count("provider") },
    domainWorkItem: { deleteMany: count("work") },
    phase2DependencyState: { deleteMany: count("dependency") },
  };
  const scope = {
    agencyId: "agency-1", creatorId: "creator-1",
    orderIds: ["order-1"], submissionIds: ["sub-1"], intentIds: ["intent-1"], inboundIds: ["inbound-1"], deliveryIds: ["write-1"],
  };

  const result = await purgeCreatorPhase2ResidualsForHardDelete({ db, scope });
  assert.deepEqual(result, {
    telegramDeliveryIntent: 1, telegramInboundEvent: 1, providerOperationalDebt: 1, domainWorkItem: 1, phase2DependencyState: 1,
  });
  assert.equal(calls.provider.where.agencyId, "agency-1");
  assert.ok(calls.provider.where.OR.some((term) => term.creatorId === "creator-1"));
  assert.ok(calls.provider.where.OR.some((term) => term.customOrderId?.in?.includes("order-1")));
  assert.ok(calls.provider.where.OR.some((term) => term.customSubmissionId?.in?.includes("sub-1")));
  assert.ok(calls.provider.where.OR.some((term) => term.intentId?.in?.includes("intent-1")));
  assert.ok(calls.provider.where.OR.some((term) => term.objectType === "AutomationDelivery" && term.objectId?.in?.includes("write-1")));

  assert.deepEqual(calls.work.where, { agencyId: "agency-1", creatorId: "creator-1" });
  assert.deepEqual(calls.dependency.where, {
    agencyId: "agency-1",
    dependencyKind: "CREATOR_BINDING",
    dependencyKey: "creator-1",
  });
});


test("F53-11 post-cascade current-work purge removes rows recreated by DomainWorkItem delete triggers", async () => {
  const state = {
    family: [{ id: "family-pre", agencyId: "agency-1" }],
    partition: [{ id: "partition-pre", agencyId: "agency-1" }],
    agencyHead: [{ id: "agency-head-pre", agencyId: "agency-1" }],
  };
  const del = (key) => async ({ where }) => deleteByAgency(state, key, where.agencyId);
  const tx = {
    phase2WorkFamilyState: { deleteMany: del("family") },
    domainWorkReadyPartition: { deleteMany: del("partition") },
    domainWorkReadyAgency: { deleteMany: del("agencyHead") },
  };

  // Simulate rows recreated by the DomainWorkItem AFTER DELETE trigger while the
  // Agency cascade statement is executing. Pre-cascade deletion cannot prevent it.
  state.family.push({ id: "family-trigger-recreated", agencyId: "agency-1" });
  state.partition.push({ id: "partition-trigger-recreated", agencyId: "agency-1" });
  state.agencyHead.push({ id: "agency-head-trigger-recreated", agencyId: "agency-1" });

  const result = await purgeAgencyPhase2CurrentWorkRootsAfterCascade({ db: tx, agencyId: "agency-1" });
  assert.deepEqual(result, {
    Phase2WorkFamilyState: 2,
    DomainWorkReadyPartition: 2,
    DomainWorkReadyAgency: 2,
  });
  assert.deepEqual(state, { family: [], partition: [], agencyHead: [] });
});
