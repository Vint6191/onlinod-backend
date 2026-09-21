"use strict";

const getPrisma = () => require("../../src/prisma");

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
  SubscriberScanRun_publication_recovery_idx: { table: "SubscriberScanRun", keys: [["status"], ["publicationstatus"], ["updatedat"]] },
  SubscriberScanRun_publication_job_reconcile_idx: { table: "SubscriberScanRun", keys: [["updatedat"], ["id"]], predicateTokens: ["publicationjobreconciledat", "publicationstatus", "published", "superseded", "complete"] },
  SubscriberScanRun_creator_publication_generation_idx: { table: "SubscriberScanRun", keys: [["creatorid"], ["publicationgeneration"]] },
  SubscriberScanRun_publication_debt_idx: { table: "SubscriberScanRun", keys: [["agencyid"], ["creatorid"], ["updatedat"], ["id"]], predicateTokens: ["fanprojectionstatus", "publicationstatus", "hasmore", "complete", "pending", "current", "previous", "finalize"] },
  SubscriberScanRun_retention_eligible_idx: { table: "SubscriberScanRun", keys: [["creatorid"], ["createdat"], ["id"]], orders: ["ASC", "DESC", "ASC"], predicateTokens: ["publicationstatus", "complete", "superseded", "failed"] },
  SubscriberScanRun_creator_reconcile_idx: { table: "SubscriberScanRun", keys: [["creatorid"], ["updatedat"], ["id"]], predicateTokens: ["publicationjobreconciledat", "publicationstatus", "published", "superseded", "complete"] },
  SubscriberScanItem_run_id_cursor_idx: { table: "SubscriberScanItem", keys: [["runid"], ["id"]] },
  SubscriberDirectoryMaintenanceSignal_creator_kind_key: { table: "SubscriberDirectoryMaintenanceSignal", keys: [["creatorid"], ["kind"]], unique: true },
  SubscriberDirectoryMaintenanceSignal_due_claim_idx: { table: "SubscriberDirectoryMaintenanceSignal", keys: [["dueat"], ["creatorid"], ["kind"], ["coalesce", "claimuntil", "-infinity"]], predicateTokens: ["attempts", "100"] },
  SubscriberDirectoryMaintenanceSignal_poison_idx: { table: "SubscriberDirectoryMaintenanceSignal", keys: [["attempts"], ["dueat"], ["creatorid"], ["kind"]], orders: ["DESC", "ASC", "ASC", "ASC"], predicateTokens: ["attempts", "100"] },
  CreatorFanRefreshDemand_promoter_ready_idx: { table: "CreatorFanRefreshDemand", keys: [["creatorid"], ["lastrequestedat"], ["id"]], predicateTokens: ["status", "queued", "activerefreshjobid"] },
  CreatorFanRefreshDemand_recovery_order_idx: { table: "CreatorFanRefreshDemand", keys: [["creatorid"], ["coalesce", "nextretryat", "lastfailedat", "updatedat"], ["id"]], predicateTokens: ["status", "failed", "activerefreshjobid"] },
  CreatorFanRefreshDemand_canonical_heal_idx: { table: "CreatorFanRefreshDemand", keys: [["creatorid"], ["updatedat"], ["id"]], predicateTokens: ["status", "queued", "failed"] },
  CampaignFanRefreshPromotionSignal_claim_due_idx: { table: "CampaignFanRefreshPromotionSignal", keys: [["dueat"], ["creatorid"], ["coalesce", "claimuntil", "-infinity"]] },
});
const REQUIRED_INDEXES = Object.freeze(Object.keys(REQUIRED_INDEX_SPECS));
const REQUIRED_CONSTRAINT_SPECS = Object.freeze({
  SubscriberDirectoryMaintenanceSignal_agencyId_fkey: {
    table: "SubscriberDirectoryMaintenanceSignal", type: "f",
    tokens: ["foreign key (agencyid)", "references agency(id)", "on update cascade", "on delete cascade"],
  },
  SubscriberDirectoryMaintenanceSignal_creator_fkey: {
    table: "SubscriberDirectoryMaintenanceSignal", type: "f",
    tokens: ["foreign key (agencyid, creatorid)", "references creatoraccount(agencyid, id)", "on update cascade", "on delete cascade"],
  },
  SubscriberDirectoryMaintenanceSignal_kind_check: {
    table: "SubscriberDirectoryMaintenanceSignal", type: "c",
    tokens: ["check", "kind", "recovery", "retention"],
  },
  SubscriberDirectoryMaintenanceSignal_revision_positive: {
    table: "SubscriberDirectoryMaintenanceSignal", type: "c",
    tokens: ["check", "revision", "> 0"],
  },
  SubscriberDirectoryMaintenanceSignal_attempts_nonnegative: {
    table: "SubscriberDirectoryMaintenanceSignal", type: "c",
    tokens: ["check", "attempts", ">= 0"],
  },
  CreatorCampaignFrontierFan_creatorId_campaignId_fkey: {
    table: "CreatorCampaignFrontierFan", type: "f",
    tokens: ["foreign key (creatorid, campaignid)", "references creatorcampaign(creatorid, id)", "on update cascade", "on delete cascade"],
  },
  CreatorCampaignCollectionState_completion_nonnegative_chk: {
    table: "CreatorCampaignCollectionState", type: "c",
    tokens: ["check", "campaignproofcampaignbatches", "campaignproofclaimerbatches", "campaignproofrejectedbatches", "campaignproofrejectedrows", ">= 0"],
  },
});
const REQUIRED_CONSTRAINTS = Object.freeze(Object.keys(REQUIRED_CONSTRAINT_SPECS));
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

function assertPostgresIdentifierWidths(names, label) {
  const tooWide = (names || []).filter((name) => Buffer.byteLength(String(name), "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES);
  if (!tooWide.length) return true;
  const error = new Error(`${label || "PostgreSQL identifiers"} exceed ${POSTGRES_IDENTIFIER_MAX_BYTES} bytes: ${tooWide.join(", ")}`);
  error.code = "PHASE3_POSTFLIGHT_IDENTIFIER_TOO_LONG";
  throw error;
}

assertPostgresIdentifierWidths(Object.keys(REQUIRED_INDEX_SPECS), "required index names");
assertPostgresIdentifierWidths(REQUIRED_CONSTRAINTS, "required constraint names");

function missingFrom(actual, required) {
  const present = new Set((actual || []).map(String));
  return required.filter((value) => !present.has(value));
}
function normalized(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function canonicalIndexSql(value) {
  return normalized(value)
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function canonicalConstraintSql(value) {
  return canonicalIndexSql(value)
    .replace(/\s*,\s*/g, ", ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}
function validateConstraintRow(name, spec, row) {
  const definition = canonicalConstraintSql(row?.definition);
  const problems = [];
  if (String(row?.tableName) !== spec.table) problems.push(`table=${row?.tableName}`);
  if (String(row?.constraintType || "") !== spec.type) problems.push(`type=${row?.constraintType}`);
  if (row?.validated !== true) problems.push("convalidated=false");
  for (const token of spec.tokens || []) {
    if (!definition.includes(canonicalConstraintSql(token))) problems.push(`missing-def:${token}`);
  }
  return { name, problems, definition: normalized(row?.definition) };
}
async function inspectConstraints(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT c.conname AS "constraintName", t.relname AS "tableName",
           c.contype AS "constraintType", c.convalidated AS "validated",
           pg_get_constraintdef(c.oid, true) AS "definition"
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema()
      AND c.conname=ANY($1::text[])
    ORDER BY c.conname
  `, [...REQUIRED_CONSTRAINTS]);
  const byName = new Map(rows.map((row) => [String(row.constraintName), row]));
  const invalidConstraints = [];
  for (const [name, spec] of Object.entries(REQUIRED_CONSTRAINT_SPECS)) {
    const row = byName.get(name);
    if (!row) continue;
    const validation = validateConstraintRow(name, spec, row);
    if (validation.problems.length) invalidConstraints.push(validation);
  }
  return { rows, byName, invalidConstraints };
}
function expressionHasTokens(expression, tokens) {
  const canonical = canonicalIndexSql(expression);
  let offset = 0;
  for (const token of tokens || []) {
    const normalizedToken = canonicalIndexSql(token);
    const next = canonical.indexOf(normalizedToken, offset);
    if (next < 0) return false;
    offset = next + normalizedToken.length;
  }
  return true;
}
function keyExpressionMatches(expression, expectedTokens) {
  const canonical = canonicalIndexSql(expression);
  const tokens = (expectedTokens || []).map(canonicalIndexSql);
  if (tokens.length === 1) return canonical === tokens[0];
  return expressionHasTokens(canonical, tokens);
}

async function tableColumns(db, tableName) {
  const rows = await db.$queryRawUnsafe(`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1
    ORDER BY ordinal_position ASC
  `, tableName);
  return rows.map((row) => row.columnName);
}

function validateIndexRow(name, spec, row) {
  const def = normalized(row?.indexDef);
  const predicate = normalized(row?.predicate);
  const keyExpressions = Array.isArray(row?.keyExpressions) ? row.keyExpressions.map(normalized) : [];
  const keyOrders = Array.isArray(row?.keyOrders) ? row.keyOrders.map((value) => String(value || "").toUpperCase()) : [];
  const problems = [];
  if (String(row?.tableName) !== spec.table) problems.push(`table=${row?.tableName}`);
  if (String(row?.accessMethod || "").toLowerCase() !== "btree") problems.push(`access-method=${row?.accessMethod}`);
  if (row?.isValid !== true) problems.push("indisvalid=false");
  if (row?.isReady !== true) problems.push("indisready=false");
  if (spec.unique === true && row?.isUnique !== true) problems.push("indisunique=false");
  if (keyExpressions.length !== (spec.keys || []).length) {
    problems.push(`key-count=${keyExpressions.length};expected=${(spec.keys || []).length}`);
  }
  for (let index = 0; index < (spec.keys || []).length; index += 1) {
    const expectedTokens = spec.keys[index];
    const expression = keyExpressions[index] || "";
    if (!keyExpressionMatches(expression, expectedTokens)) {
      problems.push(`key-${index + 1}=${JSON.stringify(expression)};expectedTokens=${JSON.stringify(expectedTokens)}`);
    }
  }
  const expectedOrders = spec.orders || Array.from({ length: (spec.keys || []).length }, () => "ASC");
  if (keyOrders.length !== expectedOrders.length) {
    problems.push(`order-count=${keyOrders.length};expected=${expectedOrders.length}`);
  } else {
    expectedOrders.forEach((expectedOrder, index) => {
      if (keyOrders[index] !== expectedOrder) problems.push(`order-${index + 1}=${keyOrders[index]};expected=${expectedOrder}`);
    });
  }
  if ((spec.predicateTokens || []).length === 0) {
    if (canonicalIndexSql(predicate) !== "") problems.push("unexpected-predicate");
  } else {
    if (canonicalIndexSql(predicate) === "") problems.push("missing-predicate");
    for (const token of spec.predicateTokens || []) {
      if (!expressionHasTokens(predicate, [token])) problems.push(`missing-predicate:${token}`);
    }
  }
  return { name, problems, indexDef: def, keyExpressions, keyOrders, predicate };
}

async function inspectIndexes(db) {
  const rows = await db.$queryRawUnsafe(`
    SELECT idx.relname AS "indexName", tbl.relname AS "tableName", am.amname AS "accessMethod",
           i.indisvalid AS "isValid", i.indisready AS "isReady", i.indisunique AS "isUnique",
           i.indnkeyatts AS "keyCount",
           pg_get_indexdef(i.indexrelid) AS "indexDef",
           COALESCE(pg_get_expr(i.indpred, i.indrelid), '') AS "predicate",
           ARRAY(
             SELECT pg_get_indexdef(i.indexrelid, ord, true)
             FROM generate_series(1, i.indnkeyatts) AS ord
             ORDER BY ord
           ) AS "keyExpressions",
           ARRAY(
             SELECT CASE WHEN ((i.indoption[ord - 1]::int & 1) = 1) THEN 'DESC' ELSE 'ASC' END
             FROM generate_series(1, i.indnkeyatts) AS ord
             ORDER BY ord
           ) AS "keyOrders"
    FROM pg_index i
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_am am ON am.oid=idx.relam
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
    const validation = validateIndexRow(name, spec, row);
    if (validation.problems.length) invalidIndexes.push(validation);
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

async function inspect(db) {
  if (!db) db = getPrisma();
  const runColumns = await tableColumns(db, "SubscriberScanRun");
  const stateColumns = await tableColumns(db, "SubscriberDirectoryState");
  const signalColumns = await tableColumns(db, "SubscriberDirectoryMaintenanceSignal");
  const indexes = await inspectIndexes(db);
  const constraints = await inspectConstraints(db);

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
  const constraintNames = constraints.rows.map((row) => row.constraintName);
  const missingConstraints = missingFrom(constraintNames, REQUIRED_CONSTRAINTS);
  const historicalRowsNotComplete = Number(historyRows?.[0]?.count || 0);
  const invalidPublicationGenerations = Number(invalidGenerationRows?.[0]?.count || 0);
  const invalidDirectoryGenerations = Number(invalidStateRows?.[0]?.count || 0);
  const missingStateCount = Number(debtStateRows?.[0]?.missingStateCount || 0);
  const stateBehindCount = Number(debtStateRows?.[0]?.stateBehindCount || 0);
  const missingRecoverySignalCount = Number(debtStateRows?.[0]?.missingRecoverySignalCount || 0);
  const invalidMaintenanceSignals = Number(invalidSignalRows?.[0]?.count || 0);

  const valid = missingColumns.length === 0 && missingStateColumns.length === 0 && missingSignalColumns.length === 0
    && missingIndexes.length === 0 && indexes.invalidIndexes.length === 0
    && missingConstraints.length === 0 && constraints.invalidConstraints.length === 0
    && historicalRowsNotComplete === 0 && invalidPublicationGenerations === 0 && invalidDirectoryGenerations === 0
    && missingStateCount === 0 && stateBehindCount === 0 && missingRecoverySignalCount === 0
    && invalidMaintenanceSignals === 0 && claimPlan.indexUsed === true;
  return {
    runColumns, stateColumns, signalColumns, indexes: indexNames, indexDetails: indexes.rows,
    invalidIndexes: indexes.invalidIndexes, constraints: constraintNames, invalidConstraints: constraints.invalidConstraints,
    missingColumns, missingStateColumns, missingSignalColumns, missingIndexes, missingConstraints,
    historicalRowsNotComplete, invalidPublicationGenerations, invalidDirectoryGenerations,
    missingStateCount, stateBehindCount, missingRecoverySignalCount, invalidMaintenanceSignals,
    maintenanceClaimPlan: claimPlan, valid,
  };
}

async function main({ db } = {}) {
  if (!db) db = getPrisma();
  const state = await inspect(db);
  console.log(JSON.stringify({
    ok: state.valid,
    phase: "PHASE3_SUBSCRIBER_PUBLICATION_A26_POSTFLIGHT",
    requiredPublicationColumns: REQUIRED_PUBLICATION_COLUMNS,
    requiredDirectoryStateColumns: REQUIRED_DIRECTORY_STATE_COLUMNS,
    requiredMaintenanceSignalColumns: REQUIRED_MAINTENANCE_SIGNAL_COLUMNS,
    requiredIndexes: REQUIRED_INDEXES,
    requiredConstraints: REQUIRED_CONSTRAINTS,
    missingColumns: state.missingColumns,
    missingStateColumns: state.missingStateColumns,
    missingSignalColumns: state.missingSignalColumns,
    missingIndexes: state.missingIndexes,
    invalidIndexes: state.invalidIndexes,
    missingConstraints: state.missingConstraints,
    invalidConstraints: state.invalidConstraints,
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
      invalidIndexes: state.invalidIndexes, missingConstraints: state.missingConstraints,
      invalidConstraints: state.invalidConstraints, historicalRowsNotComplete: state.historicalRowsNotComplete,
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
  POSTGRES_IDENTIFIER_MAX_BYTES,
  assertPostgresIdentifierWidths,
  REQUIRED_PUBLICATION_COLUMNS, REQUIRED_DIRECTORY_STATE_COLUMNS, REQUIRED_MAINTENANCE_SIGNAL_COLUMNS,
  REQUIRED_INDEXES, REQUIRED_INDEX_SPECS, REQUIRED_CONSTRAINTS, REQUIRED_CONSTRAINT_SPECS,
  missingFrom, canonicalIndexSql, canonicalConstraintSql, expressionHasTokens, keyExpressionMatches,
  validateIndexRow, validateConstraintRow, inspectIndexes, inspectConstraints, explainMaintenanceClaim, inspect, main,
};

if (require.main === module) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
    .finally(async () => { const db = getPrisma(); await db.$disconnect().catch(() => null); });
}
