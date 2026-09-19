"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const debt = require("./provider-capacity-debt-authority-service");

test("A17 PostgreSQL: physical start counters project actual provider categories without an extra usage ledger", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    const columns = await db.$queryRawUnsafe(`
      SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND (
          (table_name='OfProviderRequestGateState' AND column_name IN (
            'activePriority','activeCategory','usageWindowStartedAt','usageTotalStarts',
            'usageCampaignDirectoryStarts','usageCampaignFrontierStarts','usageFanDataStarts',
            'usageBackgroundOtherStarts','usageUnclassifiedStarts'
          ))
          OR
          (table_name='ProviderCapacityDebtState' AND column_name IN (
            'actualUsageWindowStartedAt','actualUsageTotalStarts','actualUsageCampaignDirectoryStarts',
            'actualUsageCampaignFrontierStarts','actualUsageFanDataStarts','actualUsageBackgroundOtherStarts',
            'actualUsageUnclassifiedStarts','actualUsageAccountingComplete'
          ))
        )
    `);
    assert.equal(columns.length, 17);

    await db.$queryRawUnsafe(`
      INSERT INTO "OfProviderRequestGateState" ("id","revision","createdAt","updatedAt")
      VALUES ('of-global',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING
    `);
    await db.$queryRawUnsafe(`
      UPDATE "OfProviderRequestGateState"
      SET "usageWindowStartedAt"=clock_timestamp(),
          "usageTotalStarts"=9,
          "usageCriticalWriteStarts"=1,
          "usageInteractiveStarts"=1,
          "usageRealtimeStarts"=1,
          "usageNormalStarts"=1,
          "usageCampaignDirectoryStarts"=1,
          "usageCampaignFrontierStarts"=1,
          "usageFanDataStarts"=1,
          "usageBackgroundOtherStarts"=2,
          "usageUnclassifiedStarts"=0
      WHERE "id"='of-global'
    `);
    const refreshed = await debt.refreshProviderCapacityDebtSnapshot({ db, now: new Date() });
    assert.equal(refreshed.ok, true);
    const persisted = await debt.readProviderCapacityDebtSnapshot({ db });
    assert.equal(BigInt(persisted.actualUsageTotalStarts), 9n);
    assert.equal(BigInt(persisted.actualUsageBackgroundOtherStarts), 2n);
    assert.equal(Boolean(persisted.actualUsageAccountingComplete), true);
  } finally {
    await db.$disconnect();
  }
});
