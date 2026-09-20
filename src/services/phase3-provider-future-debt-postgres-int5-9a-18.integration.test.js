"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const debt = require("./provider-capacity-debt-authority-service");
const { withPhase3PostgresFixtureAuthority } = require("../../scripts/audit/phase3-postgres-proof-fixture-authority");

test("A18 PostgreSQL: durable background job debt projects typed partial future-debt coverage", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    const columns = await db.$queryRawUnsafe(`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name='ProviderCapacityDebtState'
        AND column_name IN (
          'backgroundOtherPendingJobs','backgroundOtherOldestScheduledAt','backgroundOtherPendingJobClasses',
          'backgroundOtherCallCardinalityKnown','futureDebtCoverageStatus','futureDebtCoverageReason'
        )
    `);
    assert.equal(columns.length, 6);

    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const creator = { id: `a18-creator-${nonce}`, agencyId: `a18-agency-${nonce}` };
    await withPhase3PostgresFixtureAuthority(db, async (tx) => {
      await tx.agency.create({ data: { id: creator.agencyId, name: `A18 ${creator.agencyId}` } });
      await tx.creatorAccount.create({ data: { id: creator.id, agencyId: creator.agencyId, displayName: `A18 ${creator.id}` } });
    });
    const idempotencyKey = `a18-pg-${nonce}`;
    const job = await db.jobInstance.create({ data: {
      jobKey: "traffic_sources_scan", scope: "creator", creatorId: creator.id, agencyId: creator.agencyId,
      idempotencyKey, status: "SCHEDULED", priority: 10, params: {},
    }});
    try {
      const refreshed = await debt.refreshProviderCapacityDebtSnapshot({ db, now: new Date() });
      assert.equal(refreshed.ok, true);
      const persisted = await debt.readProviderCapacityDebtSnapshot({ db });
      assert.ok(Number(persisted.backgroundOtherPendingJobs) >= 1);
      assert.equal(Boolean(persisted.backgroundOtherCallCardinalityKnown), false);
      assert.equal(String(persisted.futureDebtCoverageStatus), "PARTIAL");
      assert.match(String(persisted.futureDebtCoverageReason || ""), /BACKGROUND_OTHER_CALL_CARDINALITY_UNKNOWN/);
      assert.equal(String(persisted.status), "UNKNOWN");
    } finally {
      await db.jobInstance.delete({ where: { id: job.id } }).catch(() => {});
      await withPhase3PostgresFixtureAuthority(db, (tx) => tx.agency.deleteMany({ where: { id: creator.agencyId } })).catch(() => {});
    }
  } finally {
    await db.$disconnect();
  }
});
