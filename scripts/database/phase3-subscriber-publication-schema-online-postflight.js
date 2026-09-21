"use strict";

const prisma = require("../../src/prisma");

const REQUIRED_PUBLICATION_COLUMNS = Object.freeze([
  "publicationStatus", "publicationGeneration", "publicationCursorId", "publicationPreviousRunId",
  "publicationAddedCount", "publicationChangedCount", "publicationDisappearedCount", "publicationStartedAt",
  "publicationCompletedAt", "publicationJobReconciledAt", "publicationLastError",
]);
const REQUIRED_DIRECTORY_STATE_COLUMNS = Object.freeze(["publicationGeneration", "publishedGeneration"]);
const REQUIRED_MAINTENANCE_SIGNAL_COLUMNS = Object.freeze([
  "id", "agencyId", "creatorId", "kind", "dueAt", "reason", "revision", "attempts",
  "claimToken", "claimUntil", "lastError", "createdAt", "updatedAt",
]);

const REQUIRED_INDEX_SPECS = Object.freeze({
  SubscriberScanRun_publication_recovery_idx: { table: "SubscriberScanRun", tokens: ['"status"', '"publicationStatus"', '"updatedAt"'] },
  SubscriberScanRun_publication_job_reconcile_idx: { table: "SubscriberScanRun", tokens: ['"updatedAt"', '"id"'], predicateTokens: ['publicationJobReconciledAt', 'publicationStatus'] },
  SubscriberScanRun_creator_publication_generation_idx: { table: "SubscriberScanRun", tokens: ['"creatorId"', '"publicationGeneration"'] },
  SubscriberScanRun_publication_debt_idx: { table: "SubscriberScanRun", tokens: ['"agencyId"', '"creatorId"', '"updatedAt"', '"id"'], predicateTokens: ['fanProjectionStatus', 'publicationStatus'] },
  SubscriberScanRun_retention_eligible_idx: { table: "SubscriberScanRun", tokens: ['"creatorId"', '"createdAt"', '"id"'], predicateTokens: ['publicationStatus', 'SUPERSEDED', 'FAILED'] },
  SubscriberScanRun_creator_reconcile_idx: { table: "SubscriberScanRun", tokens: ['"creatorId"', '"updatedAt"', '"id"'], predicateTokens: ['publicationJobReconciledAt', 'publicationStatus'] },
  SubscriberScanItem_run_id_cursor_idx: { table: "SubscriberScanItem", tokens: ['"runId"', '"id"'] },
  SubscriberDirectoryMaintenanceSignal_creator_kind_key: { table: "SubscriberDirectoryMaintenanceSignal", tokens: ['"creatorId"', '"kind"'], unique: true },
  SubscriberDirectoryMaintenanceSignal_due_claim_idx: { table: "SubscriberDirectoryMaintenanceSignal", tokens: ['"dueAt"', '"creatorId"', '"kind"', 'COALESCE'], predicateTokens: ['attempts', '100'] },
  CreatorFanRefreshDemand_promoter_ready_idx: { table: "CreatorFanRefreshDemand", tokens: ['creatorId', 'status', 'activeRefreshJobId'] },
  CreatorFanRefreshDemand_recovery_order_idx: { table: "CreatorFanRefreshDemand", tokens: ['creatorId'] },
  CreatorFanRefreshDemand_canonical_heal_idx: { table: "CreatorFanRefreshDemand", tokens: ['creatorId'] },
  CampaignFanRefreshPromotionSignal_claim_due_idx: { table: "CampaignFanRefreshPromotionSignal", tokens: ['dueAt', 'claimUntil'] },
});
const REQUIRED_INDEXES = Object.freeze(Object.keys(REQUIRED_INDEX_SPECS));

function missingFrom(actual, required) {
  const present = new Set((actual || []).map(String));
  return required.filter((value) => !present.has(value));
}
function normalized(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

async function tableColumns(db, tableName) {
  const rows = await db.$queryRawUnsafe(`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1
    ORDER BY ordinal_position ASC
  `, tableName);
  return rows.map((row) => row.columnName);
}

async function inspectIndexes(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT idx.relname AS "indexName", tbl.relname AS "tableName",
           i.indisvalid AS "isValid", i.indisready AS "isReady", i.indisunique AS "isUnique",
           pg_get_indexdef(i.indexrelid) AS "indexDef",
           COALESCE(pg_get_expr(i.indpred, i.indrelid), '') AS "predicate"
    FROM pg_index i
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class tbl ON tbl.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=tbl.relnamespace
    WHERE n.nspname=current_schema() AND idx.relname=ANY($1::text[])
    ORDER BY idx.relname
  `, [...REQUIRED_INDEXES]);
  const byName = new Map(rows.map((row) => [String(row.indexName), row]));
  const invalidIndexes = [];
  for (const [name, spec] of Object.entries(REQUIRED_INDEX_SPECS)) {
    const row = byName.get(name);
    if (!row) continue;
    const def = normalized(row.indexDef);
    const predicate = normalized(row.predicate);
    const problems = [];
    if (String(row.tableName) !== spec.table) problems.push(`table=${row.tableName}`);
    if (row.isValid !== true) problems.push("indisvalid=false");
    if (row.isReady !== true) problems.push("indisready=false");
    if (spec.unique === true && row.isUnique !== true) problems.push("indisunique=false");
    for (const token of spec.tokens || []) if (!def.includes(token)) problems.push(`missing-def:${token}`);
    for (const token of spec.predicateTokens || []) if (!predicate.includes(token)) problems.push(`missing-predicate:${token}`);
    if (problems.length) invalidIndexes.push({ name, problems, indexDef: def, predicate });
  }
  return { rows, byName, invalidIndexes };
}

async function explainMaintenanceClaim(db) {
  if (typeof db?.$transaction !== "function") return { indexUsed: false, plan: null, reason: "transaction_unsupported" };
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    const clock = await tx.$queryRawUnsafe('SELECT clock_timestamp() AS "now"');
    const authorityNow = clock?.[0]?.now || new Date();
    const rows = await tx.$queryRawUnsafe(`EXPLAIN (COSTS OFF, FORMAT JSON)
      SELECT s."id"
      FROM "SubscriberDirectoryMaintenanceSignal" s
      WHERE s."dueAt" <= $1
        AND s."attempts" < 100
        AND COALESCE(s."claimUntil", '-infinity'::timestamp) <= $1
      ORDER BY s."dueAt" ASC, s."creatorId" ASC, s."kind" ASC
      LIMIT 1
    `, authorityNow);
    const plan = JSON.stringify(rows?.[0]?.["QUERY PLAN"] || rows || []);
    return { indexUsed: plan.includes("SubscriberDirectoryMaintenanceSignal_due_claim_idx"), plan };
  }, { maxWait: 5_000, timeout: 5_000 });
}

async function inspect(db = prisma) {
  const runColumns = await tableColumns(db, "SubscriberScanRun");
  const stateColumns = await tableColumns(db, "SubscriberDirectoryState");
  const signalColumns = await tableColumns(db, "SubscriberDirectoryMaintenanceSignal");
  const indexes = await inspectIndexes(db);

  const historyRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count" FROM "SubscriberScanRun"
    WHERE "status" IN ('PUBLISHED','SUPERSEDED') AND "publicationStatus" <> 'COMPLETE'
  `);
  const invalidGenerationRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count" FROM "SubscriberScanRun" WHERE "publicationGeneration" <= 0
  `);
  const invalidStateRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count" FROM "SubscriberDirectoryState"
    WHERE "publicationGeneration" < "publishedGeneration" OR "publicationGeneration" < 0 OR "publishedGeneration" < 0
  `);
  const debtStateRows = await db.$queryRawUnsafe(`
    WITH debt AS (
      SELECT r."agencyId",r."creatorId",MAX(r."publicationGeneration")::int AS "maxGeneration",
             MAX(CASE WHEN r."status" IN ('PUBLISHED','SUPERSEDED') AND r."publicationStatus"='COMPLETE'
                      THEN r."publicationGeneration" ELSE 0 END)::int AS "maxPublishedGeneration"
      FROM "SubscriberScanRun" r
      WHERE (r."hasMore"=false AND r."fanProjectionStatus"='COMPLETE' AND r."publicationStatus" IN ('PENDING','CURRENT','PREVIOUS','FINALIZE'))
         OR (r."status" IN ('PUBLISHED','SUPERSEDED') AND r."publicationStatus"='COMPLETE' AND r."publicationJobReconciledAt" IS NULL)
      GROUP BY r."agencyId",r."creatorId"
    )
    SELECT
      COUNT(*) FILTER (WHERE s."creatorId" IS NULL)::bigint AS "missingStateCount",
      COUNT(*) FILTER (WHERE s."creatorId" IS NOT NULL AND (s."publicationGeneration" < d."maxGeneration" OR s."publishedGeneration" < d."maxPublishedGeneration"))::bigint AS "stateBehindCount",
      COUNT(*) FILTER (WHERE sig."id" IS NULL)::bigint AS "missingRecoverySignalCount"
    FROM debt d
    LEFT JOIN "SubscriberDirectoryState" s ON s."creatorId"=d."creatorId" AND s."agencyId"=d."agencyId"
    LEFT JOIN "SubscriberDirectoryMaintenanceSignal" sig ON sig."creatorId"=d."creatorId" AND sig."kind"='RECOVERY'
  `);
  const invalidSignalRows = await db.$queryRawUnsafe(`
    SELECT COUNT(*)::bigint AS "count" FROM "SubscriberDirectoryMaintenanceSignal"
    WHERE "kind" NOT IN ('RECOVERY','RETENTION') OR "revision" <= 0 OR "attempts" < 0
  `);
  const claimPlan = await explainMaintenanceClaim(db);

  const indexNames = indexes.rows.map((row) => row.indexName);
  const missingColumns = missingFrom(runColumns, REQUIRED_PUBLICATION_COLUMNS);
  const missingStateColumns = missingFrom(stateColumns, REQUIRED_DIRECTORY_STATE_COLUMNS);
  const missingSignalColumns = missingFrom(signalColumns, REQUIRED_MAINTENANCE_SIGNAL_COLUMNS);
  const missingIndexes = missingFrom(indexNames, REQUIRED_INDEXES);
  const historicalRowsNotComplete = Number(historyRows?.[0]?.count || 0);
  const invalidPublicationGenerations = Number(invalidGenerationRows?.[0]?.count || 0);
  const invalidDirectoryGenerations = Number(invalidStateRows?.[0]?.count || 0);
  const missingStateCount = Number(debtStateRows?.[0]?.missingStateCount || 0);
  const stateBehindCount = Number(debtStateRows?.[0]?.stateBehindCount || 0);
  const missingRecoverySignalCount = Number(debtStateRows?.[0]?.missingRecoverySignalCount || 0);
  const invalidMaintenanceSignals = Number(invalidSignalRows?.[0]?.count || 0);

  const valid = missingColumns.length === 0 && missingStateColumns.length === 0 && missingSignalColumns.length === 0
    && missingIndexes.length === 0 && indexes.invalidIndexes.length === 0
    && historicalRowsNotComplete === 0 && invalidPublicationGenerations === 0 && invalidDirectoryGenerations === 0
    && missingStateCount === 0 && stateBehindCount === 0 && missingRecoverySignalCount === 0
    && invalidMaintenanceSignals === 0 && claimPlan.indexUsed === true;
  return {
    runColumns, stateColumns, signalColumns, indexes: indexNames, indexDetails: indexes.rows,
    invalidIndexes: indexes.invalidIndexes, missingColumns, missingStateColumns, missingSignalColumns, missingIndexes,
    historicalRowsNotComplete, invalidPublicationGenerations, invalidDirectoryGenerations,
    missingStateCount, stateBehindCount, missingRecoverySignalCount, invalidMaintenanceSignals,
    maintenanceClaimPlan: claimPlan, valid,
  };
}

async function main({ db = prisma } = {}) {
  const state = await inspect(db);
  console.log(JSON.stringify({
    ok: state.valid,
    phase: "PHASE3_SUBSCRIBER_PUBLICATION_A26_POSTFLIGHT",
    requiredPublicationColumns: REQUIRED_PUBLICATION_COLUMNS,
    requiredDirectoryStateColumns: REQUIRED_DIRECTORY_STATE_COLUMNS,
    requiredMaintenanceSignalColumns: REQUIRED_MAINTENANCE_SIGNAL_COLUMNS,
    requiredIndexes: REQUIRED_INDEXES,
    missingColumns: state.missingColumns,
    missingStateColumns: state.missingStateColumns,
    missingSignalColumns: state.missingSignalColumns,
    missingIndexes: state.missingIndexes,
    invalidIndexes: state.invalidIndexes,
    historicalRowsNotComplete: state.historicalRowsNotComplete,
    invalidPublicationGenerations: state.invalidPublicationGenerations,
    invalidDirectoryGenerations: state.invalidDirectoryGenerations,
    missingStateCount: state.missingStateCount,
    stateBehindCount: state.stateBehindCount,
    missingRecoverySignalCount: state.missingRecoverySignalCount,
    invalidMaintenanceSignals: state.invalidMaintenanceSignals,
    maintenanceClaimIndexUsed: state.maintenanceClaimPlan.indexUsed,
  }, null, 2));
  if (!state.valid) {
    const error = new Error(`Phase 3 Subscriber publication A26 postflight failed: ${JSON.stringify({
      missingColumns: state.missingColumns, missingStateColumns: state.missingStateColumns,
      missingSignalColumns: state.missingSignalColumns, missingIndexes: state.missingIndexes,
      invalidIndexes: state.invalidIndexes, historicalRowsNotComplete: state.historicalRowsNotComplete,
      invalidPublicationGenerations: state.invalidPublicationGenerations, invalidDirectoryGenerations: state.invalidDirectoryGenerations,
      missingStateCount: state.missingStateCount, stateBehindCount: state.stateBehindCount,
      missingRecoverySignalCount: state.missingRecoverySignalCount, invalidMaintenanceSignals: state.invalidMaintenanceSignals,
      maintenanceClaimIndexUsed: state.maintenanceClaimPlan.indexUsed,
    })}`);
    error.code = "PHASE3_SUBSCRIBER_PUBLICATION_A26_POSTFLIGHT_FAILED";
    throw error;
  }
}

module.exports = {
  REQUIRED_PUBLICATION_COLUMNS, REQUIRED_DIRECTORY_STATE_COLUMNS, REQUIRED_MAINTENANCE_SIGNAL_COLUMNS,
  REQUIRED_INDEXES, REQUIRED_INDEX_SPECS, missingFrom, inspectIndexes, explainMaintenanceClaim, inspect, main,
};

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect().catch(() => null); });
}
