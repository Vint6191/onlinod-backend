"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function cleanup(prisma, key) {
  try { await prisma.maintenanceLaneState.deleteMany({ where: { key } }); } catch (_) {}
}

test("Phase2 PostgreSQL maintenance ownership: live lease excludes another replica and expired lease is recoverable", { skip: !enabled }, async () => {
  const prisma = require("../prisma");
  const { claimMaintenanceLane, finishMaintenanceLane } = require("./maintenance-work-authority");
  const key = token("phase2_pg_maintenance");
  const generation = "phase2_pg_v1";
  try {
    const first = await claimMaintenanceLane({
      db: prisma, key, generation, ownerToken: "replica-a", leaseMs: 120_000,
    });
    assert.equal(first.acquired, true);

    const blocked = await claimMaintenanceLane({
      db: prisma, key, generation, ownerToken: "replica-b", leaseMs: 120_000,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, "lease_held");

    // Simulate process death without waiting for the production minimum lease duration.
    await prisma.$executeRawUnsafe(
      `UPDATE "MaintenanceLaneState"
          SET "leaseUntil" = clock_timestamp() - interval '1 second'
        WHERE "key" = $1 AND "generation" = $2 AND "ownerToken" = 'replica-a'`,
      key, generation,
    );

    const recovered = await claimMaintenanceLane({
      db: prisma, key, generation, ownerToken: "replica-b", leaseMs: 120_000,
    });
    assert.equal(recovered.acquired, true);
    assert.equal(recovered.ownerToken, "replica-b");

    const nextRunAt = new Date(Date.now() + 120_000);
    const finished = await finishMaintenanceLane({
      db: prisma, key, generation, ownerToken: "replica-b",
      complete: false, nextRunAt, outcome: "PG_INTEGRATION_BATCH_COMPLETE",
    });
    assert.equal(finished, true);

    const early = await claimMaintenanceLane({
      db: prisma, key, generation, ownerToken: "replica-c", leaseMs: 120_000,
    });
    assert.equal(early.acquired, false);
    assert.equal(early.reason, "not_due");
  } finally {
    await cleanup(prisma, key);
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
});
