"use strict";

const prisma = require("../../src/prisma");

const REQUIRED_PUBLICATION_COLUMNS = Object.freeze([
  "publicationStatus",
  "publicationCursorId",
  "publicationPreviousRunId",
  "publicationAddedCount",
  "publicationChangedCount",
  "publicationDisappearedCount",
  "publicationStartedAt",
  "publicationCompletedAt",
  "publicationJobReconciledAt",
  "publicationLastError",
]);

const REQUIRED_INDEXES = Object.freeze([
  "SubscriberScanRun_publication_recovery_idx",
  "SubscriberScanRun_publication_job_reconcile_idx",
  "CreatorFanRefreshDemand_promoter_ready_idx",
  "CreatorFanRefreshDemand_recovery_order_idx",
  "CreatorFanRefreshDemand_canonical_heal_idx",
  "CampaignFanRefreshPromotionSignal_claim_due_idx",
]);

function missingFrom(actual, required) {
  const present = new Set((actual || []).map(String));
  return required.filter((value) => !present.has(value));
}

async function inspect(db = prisma) {
  const columnRows = await db.$queryRawUnsafe(`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'SubscriberScanRun'
    ORDER BY ordinal_position ASC
  `);

  const indexRows = await db.$queryRawUnsafe(`
    SELECT indexname AS "indexName", tablename AS "tableName"
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = ANY($1::text[])
    ORDER BY indexname ASC
  `, [...REQUIRED_INDEXES]);

  const historyRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count"
    FROM "SubscriberScanRun"
    WHERE "status" IN ('PUBLISHED', 'SUPERSEDED')
      AND "publicationStatus" <> 'COMPLETE'
  `);

  const columns = columnRows.map((row) => row.columnName);
  const indexes = indexRows.map((row) => row.indexName);
  const missingColumns = missingFrom(columns, REQUIRED_PUBLICATION_COLUMNS);
  const missingIndexes = missingFrom(indexes, REQUIRED_INDEXES);
  const historicalRowsNotComplete = Number(historyRows?.[0]?.count || 0);

  return {
    columns,
    indexes,
    missingColumns,
    missingIndexes,
    historicalRowsNotComplete,
    valid: missingColumns.length === 0 && missingIndexes.length === 0 && historicalRowsNotComplete === 0,
  };
}

async function main({ db = prisma } = {}) {
  const state = await inspect(db);
  console.log(JSON.stringify({
    ok: state.valid,
    phase: "PHASE3_SUBSCRIBER_PUBLICATION_FORWARD_REPAIR_POSTFLIGHT",
    requiredPublicationColumns: REQUIRED_PUBLICATION_COLUMNS,
    requiredIndexes: REQUIRED_INDEXES,
    missingColumns: state.missingColumns,
    missingIndexes: state.missingIndexes,
    historicalRowsNotComplete: state.historicalRowsNotComplete,
  }, null, 2));

  if (!state.valid) {
    const error = new Error(
      `Phase 3 Subscriber publication forward-repair postflight failed: `
      + `missingColumns=${state.missingColumns.join(",") || "none"} `
      + `missingIndexes=${state.missingIndexes.join(",") || "none"} `
      + `historicalRowsNotComplete=${state.historicalRowsNotComplete}`
    );
    error.code = "PHASE3_SUBSCRIBER_PUBLICATION_FORWARD_REPAIR_POSTFLIGHT_FAILED";
    throw error;
  }
}

module.exports = {
  REQUIRED_PUBLICATION_COLUMNS,
  REQUIRED_INDEXES,
  missingFrom,
  inspect,
  main,
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => null);
    });
}
