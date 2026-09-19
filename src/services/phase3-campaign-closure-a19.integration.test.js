"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("A19 PostgreSQL: Campaign FanData failed-demand recovery columns and indexes are physically installed", { skip: !enabled, timeout: 60_000 }, async () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  try {
    const columns = await db.$queryRawUnsafe(`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND table_name='CreatorFanRefreshDemand'
        AND column_name IN ('retryAttempts','nextRetryAt','lastRetryAt','quarantinedAt')
      ORDER BY column_name
    `);
    assert.deepEqual(columns.map((row) => row.columnName).sort(), ["lastRetryAt", "nextRetryAt", "quarantinedAt", "retryAttempts"]);

    const indexes = await db.$queryRawUnsafe(`
      SELECT indexname AS "indexName"
      FROM pg_indexes
      WHERE schemaname=current_schema()
        AND tablename='CreatorFanRefreshDemand'
        AND indexname IN ('CreatorFanRefreshDemand_retry_due_idx','CreatorFanRefreshDemand_quarantine_idx')
      ORDER BY indexname
    `);
    assert.deepEqual(indexes.map((row) => row.indexName).sort(), ["CreatorFanRefreshDemand_quarantine_idx", "CreatorFanRefreshDemand_retry_due_idx"]);
  } finally {
    await db.$disconnect();
  }
});
