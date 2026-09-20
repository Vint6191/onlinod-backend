"use strict";

const prisma = require("../../src/prisma");

const REQUIRED_PUBLICATION_COLUMNS = Object.freeze([
  "publicationStatus",
  "publicationGeneration",
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

const REQUIRED_DIRECTORY_STATE_COLUMNS = Object.freeze([
  "publicationGeneration",
  "publishedGeneration",
]);

const REQUIRED_INDEXES = Object.freeze([
  "SubscriberScanRun_publication_recovery_idx",
  "SubscriberScanRun_publication_job_reconcile_idx",
  "SubscriberScanRun_creator_publication_generation_idx",
  "SubscriberScanRun_publication_debt_idx",
  "SubscriberScanItem_run_id_cursor_idx",
  "CreatorFanRefreshDemand_promoter_ready_idx",
  "CreatorFanRefreshDemand_recovery_order_idx",
  "CreatorFanRefreshDemand_canonical_heal_idx",
  "CampaignFanRefreshPromotionSignal_claim_due_idx",
]);

function missingFrom(actual, required) {
  const present = new Set((actual || []).map(String));
  return required.filter((value) => !present.has(value));
}

async function tableColumns(db, tableName) {
  const rows = await db.$queryRawUnsafe(`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
    ORDER BY ordinal_position ASC
  `, tableName);
  return rows.map((row) => row.columnName);
}

async function inspect(db = prisma) {
  const runColumns = await tableColumns(db, "SubscriberScanRun");
  const stateColumns = await tableColumns(db, "SubscriberDirectoryState");
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
  const invalidGenerationRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count"
    FROM "SubscriberScanRun"
    WHERE "publicationGeneration" <= 0
  `);
  const invalidStateRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count"
    FROM "SubscriberDirectoryState"
    WHERE "publicationGeneration" < "publishedGeneration"
       OR "publicationGeneration" < 0
       OR "publishedGeneration" < 0
  `);

  const indexes = indexRows.map((row) => row.indexName);
  const missingColumns = missingFrom(runColumns, REQUIRED_PUBLICATION_COLUMNS);
  const missingStateColumns = missingFrom(stateColumns, REQUIRED_DIRECTORY_STATE_COLUMNS);
  const missingIndexes = missingFrom(indexes, REQUIRED_INDEXES);
  const historicalRowsNotComplete = Number(historyRows?.[0]?.count || 0);
  const invalidPublicationGenerations = Number(invalidGenerationRows?.[0]?.count || 0);
  const invalidDirectoryGenerations = Number(invalidStateRows?.[0]?.count || 0);

  return {
    runColumns,
    stateColumns,
    indexes,
    missingColumns,
    missingStateColumns,
    missingIndexes,
    historicalRowsNotComplete,
    invalidPublicationGenerations,
    invalidDirectoryGenerations,
    valid: missingColumns.length === 0
      && missingStateColumns.length === 0
      && missingIndexes.length === 0
      && historicalRowsNotComplete === 0
      && invalidPublicationGenerations === 0
      && invalidDirectoryGenerations === 0,
  };
}

async function main({ db = prisma } = {}) {
  const state = await inspect(db);
  console.log(JSON.stringify({
    ok: state.valid,
    phase: "PHASE3_SUBSCRIBER_PUBLICATION_A21_POSTFLIGHT",
    requiredPublicationColumns: REQUIRED_PUBLICATION_COLUMNS,
    requiredDirectoryStateColumns: REQUIRED_DIRECTORY_STATE_COLUMNS,
    requiredIndexes: REQUIRED_INDEXES,
    missingColumns: state.missingColumns,
    missingStateColumns: state.missingStateColumns,
    missingIndexes: state.missingIndexes,
    historicalRowsNotComplete: state.historicalRowsNotComplete,
    invalidPublicationGenerations: state.invalidPublicationGenerations,
    invalidDirectoryGenerations: state.invalidDirectoryGenerations,
  }, null, 2));

  if (!state.valid) {
    const error = new Error(
      `Phase 3 Subscriber publication A21 postflight failed: `
      + `missingColumns=${state.missingColumns.join(",") || "none"} `
      + `missingStateColumns=${state.missingStateColumns.join(",") || "none"} `
      + `missingIndexes=${state.missingIndexes.join(",") || "none"} `
      + `historicalRowsNotComplete=${state.historicalRowsNotComplete} `
      + `invalidPublicationGenerations=${state.invalidPublicationGenerations} `
      + `invalidDirectoryGenerations=${state.invalidDirectoryGenerations}`
    );
    error.code = "PHASE3_SUBSCRIBER_PUBLICATION_A21_POSTFLIGHT_FAILED";
    throw error;
  }
}

module.exports = {
  REQUIRED_PUBLICATION_COLUMNS,
  REQUIRED_DIRECTORY_STATE_COLUMNS,
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
