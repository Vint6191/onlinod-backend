"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const credit = require("./provider-request-credit-authority-service");
const capacityDebt = require("./provider-capacity-debt-authority-service");

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function forceActivationReady(db) {
  await db.$executeRawUnsafe(`DELETE FROM "OfProviderRequestGateWaiter"`);
  await db.$executeRawUnsafe(`
    UPDATE "OfProviderRequestGateState"
    SET "activePermitId"=NULL,"activeOwnerInstanceId"=NULL,"activeAgencyId"=NULL,"activeCreatorId"=NULL,
        "activeDeviceId"=NULL,"activeCapability"=NULL,"activeIntervalMs"=NULL,"activeGrantedAt"=NULL,"activeExpiresAt"=NULL,
        "nextAllowedAt"=NULL,"fairnessActivationState"='DRAINING',"fairnessDrainStartedAt"=NULL,
        "fairnessActivatedAt"=NULL,"fairnessActivationConfirmedAt"=NULL,"legacyPermitLastSeenAt"=NULL,
        "fairnessGeneration"=$2,"updatedAt"=CURRENT_TIMESTAMP
    WHERE "id"=$1
  `, credit.PROVIDER_GATE_STATE_ID, credit.PROVIDER_GATE_FAIRNESS_GENERATION);
  await credit.beginProviderGateFairnessDrain(db);
  await db.$executeRawUnsafe(`
    UPDATE "OfProviderRequestGateState"
    SET "fairnessDrainStartedAt"=clock_timestamp() - INTERVAL '60 seconds',
        "legacyPermitLastSeenAt"=clock_timestamp() - INTERVAL '60 seconds'
    WHERE "id"=$1
  `, credit.PROVIDER_GATE_STATE_ID);
  const result = await credit.activateProviderGateFairnessAfterDrain(db);
  assert.ok(result.activated || result.alreadyActive);
}

test("A15 PostgreSQL: current migrations expose capacity debt table and physical A14 fairness fence", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    const rows = await db.$queryRawUnsafe(`
      SELECT
        to_regclass('"ProviderCapacityDebtState"')::text AS "capacityTable",
        EXISTS (
          SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relname='OfProviderRequestGateState' AND t.tgname='onlinod_provider_gate_waiter_registration' AND NOT t.tgisinternal
        ) AS "fairnessTrigger"
    `);
    assert.equal(rows[0]?.capacityTable, '"ProviderCapacityDebtState"');
    assert.equal(rows[0]?.fairnessTrigger, true);

    const debt = await capacityDebt.refreshProviderCapacityDebtSnapshot({ db, now: new Date() });
    assert.equal(debt.ok, true);
    const persisted = await capacityDebt.readProviderCapacityDebtSnapshot({ db });
    assert.equal(persisted?.id, capacityDebt.PROVIDER_CAPACITY_STATE_ID);
    assert.ok(["HEALTHY", "PRESSURED", "OVERLOADED"].includes(String(persisted?.status)));
  } finally {
    await db.$disconnect();
  }
});

test("A15 PostgreSQL: ACTIVE fairness orders waiters across two independent Prisma clients", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db1 = new PrismaClient();
  const db2 = new PrismaClient();
  const common = { agencyId: token("agency"), creatorId: token("creator"), deviceId: token("device"), capability: "api" };
  const w1 = token("waiter_p1");
  const w2 = token("waiter_p2");
  try {
    await forceActivationReady(db1);
    await credit.registerDurableProviderWaiter({ db: db1, waiterId: w1, ownerInstanceId: "replica-p1", ...common, priority: "critical_write", category: "default", operation: "a15.pg.p1" });
    await credit.registerDurableProviderWaiter({ db: db2, waiterId: w2, ownerInstanceId: "replica-p2", ...common, deviceId: `${common.deviceId}-2`, priority: "critical_write", category: "default", operation: "a15.pg.p2" });

    const secondFirst = await credit.tryAcquireDurableProviderPermit({ db: db2, waiterId: w2, permitId: w2, ownerInstanceId: "replica-p2", ...common, deviceId: `${common.deviceId}-2`, intervalMs: 700 });
    assert.equal(secondFirst.granted, false);
    assert.equal(secondFirst.reason, "not_turn");
    assert.equal(secondFirst.selectedWaiterId, w1);

    const first = await credit.tryAcquireDurableProviderPermit({ db: db1, waiterId: w1, permitId: w1, ownerInstanceId: "replica-p1", ...common, intervalMs: 700 });
    assert.equal(first.granted, true);
    await credit.cancelDurableProviderPermit({ db: db1, permitId: w1, ...common });
    await credit.cancelDurableProviderWaiter({ db: db2, waiterId: w2, ownerInstanceId: "replica-p2" });
  } finally {
    try { await db1.$executeRawUnsafe(`DELETE FROM "OfProviderRequestGateWaiter" WHERE "waiterId" IN ($1,$2)`, w1, w2); } catch (_) {}
    await db1.$disconnect();
    await db2.$disconnect();
  }
});
