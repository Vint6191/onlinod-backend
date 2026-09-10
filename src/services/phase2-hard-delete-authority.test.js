"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectCreatorPhase2DestructiveScope,
  purgeAgencyPhase2ProviderLedgersForHardDelete,
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

  assert.ok(calls.work.where.OR.some((term) => term.creatorId === "creator-1"));
  assert.ok(calls.work.where.OR.some((term) => term.objectType === "CustomOrder" && term.objectId?.in?.includes("order-1")));
  assert.ok(calls.work.where.OR.some((term) => term.objectType === "CustomContentSubmission" && term.objectId?.in?.includes("sub-1")));
  assert.ok(calls.work.where.OR.some((term) => term.objectType === "TelegramDeliveryIntent" && term.objectId?.in?.includes("intent-1")));
  assert.ok(calls.work.where.OR.some((term) => term.objectType === "TelegramInboundEvent" && term.objectId?.in?.includes("inbound-1")));
  assert.ok(calls.work.where.OR.some((term) => term.objectType === "AutomationDelivery" && term.objectId?.in?.includes("write-1")));
  assert.ok(calls.work.where.OR.some((term) => term.dependencyKind === "REMINDER_OUTCOME" && term.dependencyKey?.in?.includes("order-1")));

  assert.deepEqual(calls.dependency.where.OR, [
    { dependencyKind: "CREATOR_BINDING", dependencyKey: "creator-1" },
    { dependencyKind: "REMINDER_OUTCOME", dependencyKey: { in: ["order-1"] } },
  ]);
});
