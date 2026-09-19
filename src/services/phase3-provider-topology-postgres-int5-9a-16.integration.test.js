"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const debt = require("./provider-capacity-debt-authority-service");

test("A16 PostgreSQL: topology/control columns and one-shard check constraint are physical", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    const columns = await db.$queryRawUnsafe(`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ProviderCapacityDebtState'
        AND column_name IN (
          'topologyVersion','topologyId','topologyScope','topologyShardCount','topologyShardingAllowed',
          'controlMode','controlReason','operatorActionRequired','campaignDirectoryAdmissionBudgetCalls','campaignDirectoryGuaranteedCallsPerSweep'
        )
      ORDER BY column_name
    `);
    assert.equal(columns.length, 10);
    const checks = await db.$queryRawUnsafe(`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema()
        AND t.relname='ProviderCapacityDebtState'
        AND c.conname='ProviderCapacityDebtState_topology_v1_check'
    `);
    assert.equal(checks.length, 1);
    assert.match(String(checks[0]?.def || ""), /topologyId.*of-global/i);

    const refreshed = await debt.refreshProviderCapacityDebtSnapshot({ db, now: new Date() });
    assert.equal(refreshed.ok, true);
    const persisted = await debt.readProviderCapacityDebtSnapshot({ db });
    assert.equal(String(persisted?.topologyId || ""), "of-global");
    assert.equal(String(persisted?.topologyScope || ""), "FLEET_GLOBAL");
    assert.equal(Number(persisted?.topologyShardCount || 0), 1);
    assert.equal(Boolean(persisted?.topologyShardingAllowed), false);
    assert.ok(["NORMAL", "OVERLOAD_PROTECTED", "CONSERVATIVE"].includes(String(persisted?.controlMode || "")));
    assert.ok(Number(persisted?.campaignDirectoryAdmissionBudgetCalls || 0) >= 1);
  } finally {
    await db.$disconnect();
  }
});
