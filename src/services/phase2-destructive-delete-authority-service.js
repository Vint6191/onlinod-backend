"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const {
  WORK_CLASS,
  publishDomainWork,
  lockDomainWorkClaimForCommit,
} = require("./domain-work-authority-service");
const {
  assertAgencyCustomPipelineRetirable,
  assertCreatorCustomPipelineRetirable,
  lockAgencyPipelineLifecycleExclusive,
  lockCreatorPipelineLifecycle,
} = require("./custom-content-pipeline-authority-service");
const { assertAgencyMassCampaignRetirable, assertCreatorMassCampaignRetirable } = require("./mass-campaign-authority-service");
const { retireCreatorWithinTransaction } = require("./creator-lifecycle-authority-service");
const { assertTeamControlPlaneWriteAdmission } = require("./phase2-release-compatibility-authority-service");

const CREATOR_DELETE_BATCH = 250;
const AGENCY_DELETE_BATCH = 250;
const MAX_CASCADE_PATH_DEPTH = 16;
const FK_CONSTRAINT_CACHE = new WeakMap();

function ids(rows) {
  return Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.id || "").trim())
    .filter(Boolean)));
}

function scopedOr(creatorId, { orderIds = [], submissionIds = [], intentIds = [], inboundIds = [], deliveryIds = [] } = {}) {
  const or = [{ creatorId: String(creatorId) }];
  if (orderIds.length) or.push({ customOrderId: { in: orderIds } });
  if (submissionIds.length) or.push({ customSubmissionId: { in: submissionIds } });
  if (intentIds.length) or.push({ intentId: { in: intentIds } });
  if (deliveryIds.length) or.push({ objectType: "AutomationDelivery", objectId: { in: deliveryIds } });
  if (inboundIds.length) or.push({ objectType: "TelegramInboundEvent", objectId: { in: inboundIds } });
  return or;
}

// Compatibility helper retained for source/tests. Production Actual53 hard Creator deletion no
// longer calls it because collecting the whole lifetime scope in Node was F53-12 itself.
async function collectCreatorPhase2DestructiveScope({ db, agencyId, creatorId }) {
  const agency = String(agencyId || "").trim();
  const creator = String(creatorId || "").trim();
  if (!db || !agency || !creator) {
    const error = new Error("Creator destructive scope requires db, agencyId and creatorId");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }
  const [orderRows, submissionRows, deliveryRows] = await Promise.all([
    db.customOrder.findMany({ where: { agencyId: agency, creatorId: creator }, select: { id: true }, take: CREATOR_DELETE_BATCH }),
    db.customContentSubmission.findMany({ where: { agencyId: agency, creatorId: creator }, select: { id: true }, take: CREATOR_DELETE_BATCH }),
    db.automationDelivery.findMany({
      where: { agencyId: agency, creatorId: creator, actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] } },
      select: { id: true }, take: CREATOR_DELETE_BATCH,
    }),
  ]);
  const orderIds = ids(orderRows);
  const submissionIds = ids(submissionRows);
  const intentRows = await db.telegramDeliveryIntent.findMany({
    where: { agencyId: agency, OR: [{ creatorId: creator }, ...(orderIds.length ? [{ customOrderId: { in: orderIds } }] : []), ...(submissionIds.length ? [{ customSubmissionId: { in: submissionIds } }] : [])] },
    select: { id: true }, take: CREATOR_DELETE_BATCH,
  });
  const inboundRows = await db.telegramInboundEvent.findMany({
    where: { agencyId: agency, OR: [{ creatorId: creator }, ...(orderIds.length ? [{ customOrderId: { in: orderIds } }] : []), ...(submissionIds.length ? [{ submissionId: { in: submissionIds } }] : [])] },
    select: { id: true }, take: CREATOR_DELETE_BATCH,
  });
  return { agencyId: agency, creatorId: creator, orderIds, submissionIds, intentIds: ids(intentRows), inboundIds: ids(inboundRows), deliveryIds: ids(deliveryRows), bounded: true };
}

async function purgeAgencyPhase2ProviderLedgersForHardDelete({ db, agencyId }) {
  const agency = String(agencyId || "").trim();
  if (!db || !agency) {
    const error = new Error("Agency provider-ledger purge requires db and agencyId");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }

  // Actual53/F53-11: all confirmed Phase2 non-FK tenant roots are explicitly
  // destroyed in the same guarded hard-delete transaction. FK-backed facts and
  // projections still rely on Agency cascade. New current-work head/state tables
  // also have no Prisma Agency relation and must not survive a tenant identity.
  const delegates = [
    ["providerOperationalDebt", "ProviderOperationalDebt"],
    ["telegramDeliveryIntent", "TelegramDeliveryIntent"],
    ["telegramInboundEvent", "TelegramInboundEvent"],
    ["teamSentMessageLedger", "TeamSentMessageLedger"],
    ["teamPpvPurchaseLedger", "TeamPpvPurchaseLedger"],
    ["teamTipLedger", "TeamTipLedger"],
    ["teamPpvResolveJob", "TeamPpvResolveJob"],
  ];
  const result = {};
  for (const [delegateName, resultName] of delegates) {
    const delegate = db?.[delegateName];
    if (!delegate?.deleteMany) continue;
    const deleted = await delegate.deleteMany({ where: { agencyId: agency } });
    result[resultName] = Number(deleted?.count || 0);
  }
  return result;
}

async function purgeAgencyPhase2CurrentWorkRootsAfterCascade({ db, agencyId }) {
  const agency = String(agencyId || "").trim();
  if (!db || !agency) {
    const error = new Error("Agency current-work root purge requires db and agencyId");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }

  // DomainWorkItem is Agency-FK backed. Its AFTER DELETE triggers intentionally
  // maintain Phase2WorkFamilyState/Ready* and can therefore recreate zero-count
  // current-work rows while the Agency cascade is executing. These non-FK roots
  // must be removed *after* the DomainWorkItem cascade statement has completed.
  const delegates = [
    ["phase2WorkFamilyState", "Phase2WorkFamilyState"],
    ["domainWorkReadyPartition", "DomainWorkReadyPartition"],
    ["domainWorkReadyAgency", "DomainWorkReadyAgency"],
  ];
  const result = {};
  for (const [delegateName, resultName] of delegates) {
    const delegate = db?.[delegateName];
    if (!delegate?.deleteMany) continue;
    const deleted = await delegate.deleteMany({ where: { agencyId: agency } });
    result[resultName] = Number(deleted?.count || 0);
  }
  return result;
}

// Legacy bounded compatibility purge. It is deliberately no longer the production hard-delete
// authority; the durable worker below avoids all-history arrays and survives restart.
async function purgeCreatorPhase2ResidualsForHardDelete({ db, scope }) {
  const agencyId = String(scope?.agencyId || "").trim();
  const creatorId = String(scope?.creatorId || "").trim();
  if (!db || !agencyId || !creatorId) {
    const error = new Error("Creator provider-ledger purge requires a captured destructive scope");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }
  const orderIds = Array.from(new Set(scope.orderIds || [])).slice(0, CREATOR_DELETE_BATCH);
  const submissionIds = Array.from(new Set(scope.submissionIds || [])).slice(0, CREATOR_DELETE_BATCH);
  const intentIds = Array.from(new Set(scope.intentIds || [])).slice(0, CREATOR_DELETE_BATCH);
  const inboundIds = Array.from(new Set(scope.inboundIds || [])).slice(0, CREATOR_DELETE_BATCH);
  const deliveryIds = Array.from(new Set(scope.deliveryIds || [])).slice(0, CREATOR_DELETE_BATCH);

  const telegramDelivery = await db.telegramDeliveryIntent.deleteMany({ where: { agencyId, OR: [{ creatorId }, ...(orderIds.length ? [{ customOrderId: { in: orderIds } }] : []), ...(submissionIds.length ? [{ customSubmissionId: { in: submissionIds } }] : [])] } });
  const telegramInbound = await db.telegramInboundEvent.deleteMany({ where: { agencyId, OR: [{ creatorId }, ...(orderIds.length ? [{ customOrderId: { in: orderIds } }] : []), ...(submissionIds.length ? [{ submissionId: { in: submissionIds } }] : [])] } });
  const providerDebt = await db.providerOperationalDebt.deleteMany({ where: { agencyId, OR: scopedOr(creatorId, { orderIds, submissionIds, intentIds, inboundIds, deliveryIds }) } });
  const domainWork = await db.domainWorkItem.deleteMany({ where: { agencyId, creatorId } });
  const dependencyState = await db.phase2DependencyState.deleteMany({ where: { agencyId, dependencyKind: "CREATOR_BINDING", dependencyKey: creatorId } });
  return {
    telegramDeliveryIntent: Number(telegramDelivery?.count || 0), telegramInboundEvent: Number(telegramInbound?.count || 0),
    providerOperationalDebt: Number(providerDebt?.count || 0), domainWorkItem: Number(domainWork?.count || 0), phase2DependencyState: Number(dependencyState?.count || 0),
  };
}

function qident(value) {
  const text = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw Object.assign(new Error(`Unsafe SQL identifier: ${text}`), { code: "PHASE2_DESTRUCTIVE_IDENTIFIER_INVALID" });
  return `"${text.replace(/"/g, '""')}"`;
}

async function rawDeleteBatch(tx, sql, params, limit) {
  const rows = await tx.$queryRawUnsafe(sql, ...params, Math.max(1, Number(limit) || 1));
  return Number(Array.isArray(rows) ? rows.length : 0);
}

async function purgeCreatorNonFkPhase2Batch({ tx, agencyId, creatorId, limit }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { deleted: 0, exhausted: false, source: "no_raw_sql" };
  let remaining = Math.max(1, Number(limit) || CREATOR_DELETE_BATCH);
  let deleted = 0;
  const run = async (table, predicate) => {
    if (remaining <= 0) return;
    const count = await rawDeleteBatch(tx,
      `DELETE FROM ${qident(table)} t WHERE t.ctid IN (SELECT x.ctid FROM ${qident(table)} x WHERE x."agencyId"=$1 AND (${predicate}) ORDER BY x.ctid LIMIT $3) RETURNING 1`,
      [agencyId, creatorId], remaining);
    deleted += count; remaining -= count;
  };

  // Do this before FK/cascade child rows disappear: the EXISTS branches preserve
  // old rows that carry only an order/submission identity and no direct creatorId.
  await run("TelegramDeliveryIntent", `x."creatorId"=$2 OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."customOrderId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE s."id"=x."customSubmissionId" AND s."agencyId"=$1 AND s."creatorId"=$2)`);
  await run("TelegramInboundEvent", `x."creatorId"=$2 OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."customOrderId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE s."id"=x."submissionId" AND s."agencyId"=$1 AND s."creatorId"=$2)`);
  await run("ProviderOperationalDebt", `x."creatorId"=$2 OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."customOrderId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE s."id"=x."customSubmissionId" AND s."agencyId"=$1 AND s."creatorId"=$2)`);
  // Do not match the DESTRUCTIVE_CREATOR_CLEANUP item itself: it intentionally
  // has creatorId NULL and objectType Phase2CreatorDestructiveCleanup.
  await run("DomainWorkItem", `x."creatorId"=$2 OR (x."objectType"='CreatorAccount' AND x."objectId"=$2) OR (x."dependencyKind"='CREATOR_BINDING' AND x."dependencyKey"=$2) OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE x."objectType"='CustomOrder' AND o."id"=x."objectId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE x."objectType"='CustomContentSubmission' AND s."id"=x."objectId" AND s."agencyId"=$1 AND s."creatorId"=$2)`);
  await run("Phase2DependencyState", `x."dependencyKind"='CREATOR_BINDING' AND x."dependencyKey"=$2 OR (x."dependencyKind"='REMINDER_OUTCOME' AND EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."dependencyKey" AND o."agencyId"=$1 AND o."creatorId"=$2))`);
  // Legacy server automation queues are executable work, not historical facts. They
  // are not FK-backed to CreatorAccount, so hard delete must drain jobs before tasks.
  await run("AutomationJob", `x."creatorId"=$2 OR x."accountId"=$2 OR EXISTS (SELECT 1 FROM "AutomationTask" t WHERE t."id"=x."taskId" AND t."agencyId"=$1 AND t."creatorId"=$2)`);
  await run("AutomationTask", `x."creatorId"=$2`);
  await run("TeamSentMessageLedger", `x."creatorId"=$2`);
  await run("TeamPpvPurchaseLedger", `x."creatorId"=$2`);
  await run("TeamTipLedger", `x."creatorId"=$2`);
  await run("TeamPpvResolveJob", `x."creatorId"=$2`);

  return { deleted, exhausted: remaining <= 0, remaining };
}

function normalizePgTextArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (text.startsWith("{") && text.endsWith("}")) {
    return text.slice(1, -1).split(",").map((item) => item.replace(/^"|"$/g, "").trim()).filter(Boolean);
  }
  return [];
}

const PG_DELETE_ACTION = Object.freeze({
  a: "NO_ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET_NULL",
  d: "SET_DEFAULT",
});

async function loadForeignKeyConstraints(tx) {
  if (typeof tx?.$queryRawUnsafe !== "function") return [];
  if (tx && (typeof tx === "object" || typeof tx === "function") && FK_CONSTRAINT_CACHE.has(tx)) {
    return FK_CONSTRAINT_CACHE.get(tx);
  }
  const loading = (async () => {
  const rows = await tx.$queryRawUnsafe(`
    SELECT con.conname::text AS "constraintName",
           con.confdeltype::text AS "deleteActionCode",
           parent.relname::text AS "parentTable",
           child.relname::text AS "childTable",
           ARRAY(
             SELECT a.attname::text
               FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum,ord)
               JOIN pg_attribute a ON a.attrelid=parent.oid AND a.attnum=k.attnum
              ORDER BY k.ord
           ) AS "parentColumns",
           ARRAY(
             SELECT a.attname::text
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum,ord)
               JOIN pg_attribute a ON a.attrelid=child.oid AND a.attnum=k.attnum
              ORDER BY k.ord
           ) AS "childColumns"
      FROM pg_constraint con
      JOIN pg_class parent ON parent.oid=con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
      JOIN pg_class child ON child.oid=con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
     WHERE con.contype='f'
       AND parent_ns.nspname=current_schema() AND child_ns.nspname=current_schema()
     ORDER BY parent.relname,child.relname,con.conname
  `);
  return (rows || []).map((row) => {
    const parentColumns = normalizePgTextArray(row.parentColumns);
    const childColumns = normalizePgTextArray(row.childColumns);
    if (!parentColumns.length || parentColumns.length !== childColumns.length) {
      const error = new Error(`Unsupported destructive FK shape: ${String(row.constraintName || "unknown")}`);
      error.code = "PHASE2_DESTRUCTIVE_FK_SHAPE_UNSUPPORTED";
      throw error;
    }
    const deleteActionCode = String(row.deleteActionCode || "").trim();
    const deleteAction = PG_DELETE_ACTION[deleteActionCode];
    if (!deleteAction) {
      const error = new Error(`Unsupported PostgreSQL delete action ${deleteActionCode || "unknown"}: ${String(row.constraintName || "unknown")}`);
      error.code = "PHASE2_DESTRUCTIVE_FK_ACTION_UNSUPPORTED";
      throw error;
    }
    return {
      constraintName: String(row.constraintName || ""),
      parentTable: String(row.parentTable || ""),
      childTable: String(row.childTable || ""),
      parentColumns,
      childColumns,
      deleteActionCode,
      deleteAction,
    };
  }).filter((row) => row.parentTable && row.childTable);
  })();
  if (tx && (typeof tx === "object" || typeof tx === "function")) FK_CONSTRAINT_CACHE.set(tx, loading);
  try {
    return await loading;
  } catch (error) {
    if (tx && (typeof tx === "object" || typeof tx === "function")) FK_CONSTRAINT_CACHE.delete(tx);
    throw error;
  }
}

async function loadCascadeConstraints(tx) {
  return (await loadForeignKeyConstraints(tx)).filter((edge) => edge.deleteAction === "CASCADE");
}

function cascadeDeletePlanFromConstraints(constraints, rootTable, orderingConstraints = constraints) {
  const root = String(rootTable || "").trim();
  if (!root) throw Object.assign(new Error("Cascade root table is required"), { code: "PHASE2_DESTRUCTIVE_ROOT_REQUIRED" });
  const cascadeEdges = (constraints || []).filter((edge) => !edge.deleteAction || edge.deleteAction === "CASCADE");
  const byParent = new Map();
  for (const edge of cascadeEdges) {
    if (!byParent.has(edge.parentTable)) byParent.set(edge.parentTable, []);
    byParent.get(edge.parentTable).push(edge);
  }
  const pathsByTable = new Map();
  const visit = (table, path, seen) => {
    for (const edge of byParent.get(table) || []) {
      if (seen.has(edge.childTable)) {
        const error = new Error(`Cascade cycle reachable from ${root}: ${[...seen, edge.childTable].join(" -> ")}`);
        error.code = "PHASE2_DESTRUCTIVE_CASCADE_CYCLE_UNSUPPORTED";
        throw error;
      }
      const nextPath = [...path, edge];
      if (nextPath.length > MAX_CASCADE_PATH_DEPTH) {
        const error = new Error(`Cascade path from ${root} exceeds ${MAX_CASCADE_PATH_DEPTH} levels`);
        error.code = "PHASE2_DESTRUCTIVE_CASCADE_DEPTH_EXCEEDED";
        throw error;
      }
      if (!pathsByTable.has(edge.childTable)) pathsByTable.set(edge.childTable, []);
      pathsByTable.get(edge.childTable).push(nextPath);
      visit(edge.childTable, nextPath, new Set([...seen, edge.childTable]));
    }
  };
  visit(root, [], new Set([root]));

  const deletionTables = new Set(pathsByTable.keys());
  const internalChildren = new Map();
  for (const table of deletionTables) internalChildren.set(table, new Set());
  for (const edge of orderingConstraints || []) {
    if (!deletionTables.has(edge.parentTable) || !deletionTables.has(edge.childTable)) continue;
    if (edge.parentTable === edge.childTable) {
      const error = new Error(`Self-referential destructive dependency is unsupported: ${edge.parentTable}`);
      error.code = "PHASE2_DESTRUCTIVE_DEPENDENCY_CYCLE_UNSUPPORTED";
      throw error;
    }
    // Regardless of ON DELETE action, delete a root-owned child before its parent.
    // This prevents one parent statement from hiding unbounded CASCADE/SET NULL work
    // and prevents RESTRICT/NO ACTION from blocking a supposedly bounded batch.
    internalChildren.get(edge.parentTable).add(edge.childTable);
  }

  const rankMemo = new Map();
  const visiting = new Set();
  const rank = (table) => {
    if (rankMemo.has(table)) return rankMemo.get(table);
    if (visiting.has(table)) {
      const error = new Error(`Destructive FK dependency cycle reachable from ${root}: ${table}`);
      error.code = "PHASE2_DESTRUCTIVE_DEPENDENCY_CYCLE_UNSUPPORTED";
      throw error;
    }
    visiting.add(table);
    let value = 1;
    for (const child of internalChildren.get(table) || []) value = Math.max(value, 1 + rank(child));
    visiting.delete(table);
    rankMemo.set(table, value);
    return value;
  };

  return Array.from(pathsByTable.entries()).map(([tableName, paths]) => ({
    tableName,
    paths,
    depth: Math.max(...paths.map((path) => path.length)),
    destructiveRank: rank(tableName),
  })).sort((a, b) => a.destructiveRank - b.destructiveRank || b.depth - a.depth || a.tableName.localeCompare(b.tableName));
}

function externalCascadeForeignActionPlanFromConstraints(constraints, rootTable, cascadePlan = []) {
  const root = String(rootTable || "").trim();
  if (!root) throw Object.assign(new Error("Cascade root table is required"), { code: "PHASE2_DESTRUCTIVE_ROOT_REQUIRED" });
  const entries = new Map((cascadePlan || []).map((entry, index) => [String(entry.tableName), { ...entry, destructiveIndex: index }]));
  const deletionTables = new Set(entries.keys());
  const out = [];
  for (const edge of constraints || []) {
    if (!deletionTables.has(edge.parentTable) || deletionTables.has(edge.childTable)) continue;
    if (edge.deleteAction === "CASCADE") {
      // A CASCADE child of a reachable cascade parent must itself be reachable.
      // Treat any mismatch as planner corruption rather than allowing a hidden
      // unbounded cascade to ride along with the parent DELETE statement.
      const error = new Error(`Cascade planner omitted reachable table ${edge.childTable} from ${edge.parentTable}`);
      error.code = "PHASE2_DESTRUCTIVE_CASCADE_PLAN_INCOMPLETE";
      error.constraintName = edge.constraintName;
      throw error;
    }
    const parentEntry = entries.get(edge.parentTable);
    out.push({ ...edge, parentPaths: parentEntry.paths, parentDepth: parentEntry.depth, destructiveIndex: parentEntry.destructiveIndex });
  }
  return out.sort((a, b) => a.destructiveIndex - b.destructiveIndex
    || a.childTable.localeCompare(b.childTable)
    || a.constraintName.localeCompare(b.constraintName));
}

function joinColumns(leftAlias, leftColumns, rightAlias, rightColumns) {
  if (!Array.isArray(leftColumns) || leftColumns.length !== rightColumns?.length || !leftColumns.length) {
    const error = new Error("Cascade FK columns are not comparable");
    error.code = "PHASE2_DESTRUCTIVE_CASCADE_SHAPE_UNSUPPORTED";
    throw error;
  }
  return leftColumns.map((column, index) => `${leftAlias}.${qident(column)}=${rightAlias}.${qident(rightColumns[index])}`).join(" AND ");
}

function cascadePathPredicate(path, targetAlias = "x", rootParam = "$1") {
  if (!Array.isArray(path) || !path.length) throw Object.assign(new Error("Cascade path is empty"), { code: "PHASE2_DESTRUCTIVE_CASCADE_PATH_INVALID" });
  const depth = path.length;
  const last = path[depth - 1];
  let sql = `EXISTS (SELECT 1 FROM ${qident(last.parentTable)} p${depth - 1}`;
  for (let index = depth - 2; index >= 0; index -= 1) {
    const edge = path[index];
    sql += ` JOIN ${qident(edge.parentTable)} p${index} ON ${joinColumns(`p${index + 1}`, edge.childColumns, `p${index}`, edge.parentColumns)}`;
  }
  sql += ` WHERE ${joinColumns(targetAlias, last.childColumns, `p${depth - 1}`, last.parentColumns)} AND p0."id"=${rootParam})`;
  return sql;
}

function indirectForeignMatchPredicate(edge, parentPaths, childAlias = "x", parentAlias = "p", rootParam = "$1") {
  const ownership = (parentPaths || []).map((path) => cascadePathPredicate(path, parentAlias, rootParam));
  if (!ownership.length) {
    const error = new Error(`Destructive ownership path is missing for ${edge.constraintName}`);
    error.code = "PHASE2_DESTRUCTIVE_CASCADE_PATH_INVALID";
    throw error;
  }
  return `EXISTS (SELECT 1 FROM ${qident(edge.parentTable)} ${parentAlias} WHERE ${joinColumns(childAlias, edge.childColumns, parentAlias, edge.parentColumns)} AND (${ownership.join(" OR ")}))`;
}

async function cascadeDeletePlan(tx, rootTable) {
  const allConstraints = await loadForeignKeyConstraints(tx);
  const cascadeConstraints = allConstraints.filter((edge) => edge.deleteAction === "CASCADE");
  return cascadeDeletePlanFromConstraints(cascadeConstraints, rootTable, allConstraints);
}

async function purgeRootCascadeDescendantsBatch({ tx, rootTable, rootId, limit, excludeTables = [] }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { deleted: 0, exhausted: false, remaining: Number(limit) || 0, tables: 0 };
  const excluded = new Set((excludeTables || []).map(String));
  const allConstraints = await loadForeignKeyConstraints(tx);
  const cascadeConstraints = allConstraints.filter((edge) => edge.deleteAction === "CASCADE");
  const plan = cascadeDeletePlanFromConstraints(cascadeConstraints, rootTable, allConstraints);
  const externalActions = externalCascadeForeignActionPlanFromConstraints(allConstraints, rootTable, plan);
  const externalByParent = new Map();
  for (const edge of externalActions) {
    if (!externalByParent.has(edge.parentTable)) externalByParent.set(edge.parentTable, []);
    externalByParent.get(edge.parentTable).push(edge);
  }
  let remaining = Math.max(1, Number(limit) || CREATOR_DELETE_BATCH);
  let deleted = 0;
  let externalChanged = 0;
  let lastTable = null;
  let lastDepth = null;
  let lastAction = null;
  for (const entry of plan) {
    if (remaining <= 0) break;
    if (excluded.has(entry.tableName)) continue;

    // A cascade-owned intermediate parent may itself be referenced by history that
    // is NOT part of the root cascade. Drain those physical FK actions first so a
    // bounded parent DELETE cannot hide an unbounded SET NULL/CASCADE side effect.
    // RESTRICT/NO ACTION/SET DEFAULT are deliberately fail-closed until a domain
    // policy explicitly classifies them.
    for (const edge of externalByParent.get(entry.tableName) || []) {
      if (remaining <= 0) break;
      const table = qident(edge.childTable);
      const predicate = indirectForeignMatchPredicate(edge, edge.parentPaths, "x", "p", "$1");
      let rows;
      if (edge.deleteAction === "SET_NULL") {
        const setClause = edge.childColumns.map((column) => `${qident(column)}=NULL`).join(",");
        rows = await tx.$queryRawUnsafe(
          `UPDATE ${table} t SET ${setClause} WHERE t.ctid IN (SELECT x.ctid FROM ${table} x WHERE ${predicate} ORDER BY x.ctid LIMIT $2) RETURNING 1`,
          rootId,
          remaining,
        );
      } else if (edge.deleteAction === "RESTRICT" || edge.deleteAction === "NO_ACTION") {
        const error = new Error(`Intermediate hard-delete policy required for ${edge.deleteAction} FK ${edge.constraintName} (${edge.childTable} -> ${edge.parentTable})`);
        error.code = "PHASE2_DESTRUCTIVE_INTERMEDIATE_RESTRICT_POLICY_REQUIRED";
        error.constraintName = edge.constraintName;
        error.tableName = edge.childTable;
        error.parentTable = edge.parentTable;
        throw error;
      } else if (edge.deleteAction === "SET_DEFAULT") {
        const error = new Error(`Intermediate SET DEFAULT hard-delete policy is unsupported for ${edge.constraintName}`);
        error.code = "PHASE2_DESTRUCTIVE_SET_DEFAULT_UNSUPPORTED";
        throw error;
      } else {
        const error = new Error(`Unexpected intermediate FK action ${edge.deleteAction}: ${edge.constraintName}`);
        error.code = "PHASE2_DESTRUCTIVE_FK_ACTION_UNSUPPORTED";
        throw error;
      }
      const count = Number(Array.isArray(rows) ? rows.length : 0);
      externalChanged += count;
      remaining -= count;
      if (count > 0) { lastTable = edge.childTable; lastDepth = entry.depth; lastAction = edge.deleteAction; }
    }
    if (remaining <= 0) break;

    const predicates = entry.paths.map((path) => cascadePathPredicate(path, "x", "$1"));
    if (!predicates.length) continue;
    const table = qident(entry.tableName);
    const count = await rawDeleteBatch(
      tx,
      `DELETE FROM ${table} t WHERE t.ctid IN (SELECT x.ctid FROM ${table} x WHERE (${predicates.join(" OR ")}) ORDER BY x.ctid LIMIT $2) RETURNING 1`,
      [rootId],
      remaining,
    );
    deleted += count;
    remaining -= count;
    if (count > 0) { lastTable = entry.tableName; lastDepth = entry.depth; }
  }
  const workUnits = deleted + externalChanged;
  return { deleted, externalChanged, workUnits, exhausted: remaining <= 0, remaining, tables: plan.length, externalActions: externalActions.length, lastTable, lastDepth, lastAction };
}


function directRootForeignActionPlanFromConstraints(constraints, rootTable, cascadePlan = []) {
  const root = String(rootTable || "").trim();
  const cascadeTables = new Set((cascadePlan || []).map((entry) => String(entry.tableName)));
  return (constraints || [])
    .filter((edge) => edge.parentTable === root && edge.deleteAction !== "CASCADE" && !cascadeTables.has(edge.childTable))
    .sort((a, b) => a.childTable.localeCompare(b.childTable) || a.constraintName.localeCompare(b.constraintName));
}

async function rootDirectForeignActionPlan(tx, rootTable) {
  const allConstraints = await loadForeignKeyConstraints(tx);
  const cascadeConstraints = allConstraints.filter((edge) => edge.deleteAction === "CASCADE");
  const cascadePlan = cascadeDeletePlanFromConstraints(cascadeConstraints, rootTable, allConstraints);
  return directRootForeignActionPlanFromConstraints(allConstraints, rootTable, cascadePlan);
}

function directRootMatchPredicate(edge, childAlias = "x", rootAlias = "r", rootParam = "$1") {
  return `EXISTS (SELECT 1 FROM ${qident(edge.parentTable)} ${rootAlias} WHERE ${joinColumns(childAlias, edge.childColumns, rootAlias, edge.parentColumns)} AND ${rootAlias}."id"=${rootParam})`;
}

async function purgeRootDirectForeignActionsBatch({ tx, rootTable, rootId, limit, deleteRestrictedTables = [] }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { changed: 0, exhausted: false, remaining: Number(limit) || 0, actions: 0 };
  const allowDelete = new Set((deleteRestrictedTables || []).map(String));
  const plan = await rootDirectForeignActionPlan(tx, rootTable);
  let remaining = Math.max(1, Number(limit) || CREATOR_DELETE_BATCH);
  let changed = 0;
  let lastTable = null;
  let lastAction = null;
  for (const edge of plan) {
    if (remaining <= 0) break;
    const table = qident(edge.childTable);
    const predicate = directRootMatchPredicate(edge, "x", "r", "$1");
    let rows;
    if (edge.deleteAction === "SET_NULL") {
      const setClause = edge.childColumns.map((column) => `${qident(column)}=NULL`).join(",");
      rows = await tx.$queryRawUnsafe(
        `UPDATE ${table} t SET ${setClause} WHERE t.ctid IN (SELECT x.ctid FROM ${table} x WHERE ${predicate} ORDER BY x.ctid LIMIT $2) RETURNING 1`,
        rootId,
        remaining,
      );
    } else if (edge.deleteAction === "RESTRICT" || edge.deleteAction === "NO_ACTION") {
      if (!allowDelete.has(edge.childTable)) {
        const error = new Error(`Hard-delete policy required for ${edge.deleteAction} FK ${edge.constraintName} (${edge.childTable} -> ${rootTable})`);
        error.code = "PHASE2_DESTRUCTIVE_RESTRICT_POLICY_REQUIRED";
        error.constraintName = edge.constraintName;
        error.tableName = edge.childTable;
        throw error;
      }
      const allConstraints = await loadForeignKeyConstraints(tx);
      const dependent = allConstraints.find((candidate) => candidate.parentTable === edge.childTable);
      if (dependent) {
        const error = new Error(`Restricted child ${edge.childTable} has its own dependent FK ${dependent.constraintName}; classify it in the destructive graph before deletion`);
        error.code = "PHASE2_DESTRUCTIVE_RESTRICT_NESTED_DEPENDENCY";
        error.constraintName = dependent.constraintName;
        error.tableName = edge.childTable;
        throw error;
      }
      rows = await tx.$queryRawUnsafe(
        `DELETE FROM ${table} t WHERE t.ctid IN (SELECT x.ctid FROM ${table} x WHERE ${predicate} ORDER BY x.ctid LIMIT $2) RETURNING 1`,
        rootId,
        remaining,
      );
    } else if (edge.deleteAction === "SET_DEFAULT") {
      const error = new Error(`SET DEFAULT hard-delete policy is unsupported for ${edge.constraintName}`);
      error.code = "PHASE2_DESTRUCTIVE_SET_DEFAULT_UNSUPPORTED";
      throw error;
    } else {
      const error = new Error(`Unexpected root FK action ${edge.deleteAction}: ${edge.constraintName}`);
      error.code = "PHASE2_DESTRUCTIVE_FK_ACTION_UNSUPPORTED";
      throw error;
    }
    const count = Number(Array.isArray(rows) ? rows.length : 0);
    changed += count;
    remaining -= count;
    if (count > 0) { lastTable = edge.childTable; lastAction = edge.deleteAction; }
  }
  return { changed, exhausted: remaining <= 0, remaining, actions: plan.length, lastTable, lastAction };
}

async function rootDirectForeignActionsRemain(tx, rootTable, rootId) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  const plan = await rootDirectForeignActionPlan(tx, rootTable);
  for (const edge of plan) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT 1 AS present FROM ${qident(edge.childTable)} x WHERE ${directRootMatchPredicate(edge, "x", "r", "$1")} LIMIT 1`,
      rootId,
    );
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
}

async function rootCascadeRowsRemain(tx, rootTable, rootId, { excludeTables = [] } = {}) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  const excluded = new Set((excludeTables || []).map(String));
  const plan = await cascadeDeletePlan(tx, rootTable);
  for (const entry of plan) {
    if (excluded.has(entry.tableName)) continue;
    const predicates = entry.paths.map((path) => cascadePathPredicate(path, "x", "$1"));
    if (!predicates.length) continue;
    const rows = await tx.$queryRawUnsafe(`SELECT 1 AS present FROM ${qident(entry.tableName)} x WHERE (${predicates.join(" OR ")}) LIMIT 1`, rootId);
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
}

async function creatorCascadeRelations(tx) {
  const plan = await cascadeDeletePlan(tx, "CreatorAccount");
  return plan.map((entry) => ({ tableName: entry.tableName, depth: entry.depth, paths: entry.paths.length }));
}

async function purgeCreatorCascadeChildrenBatch({ tx, creatorId, limit }) {
  const result = await purgeRootCascadeDescendantsBatch({ tx, rootTable: "CreatorAccount", rootId: creatorId, limit });
  return { ...result, relations: result.tables };
}

async function creatorCascadeRowsRemain(tx, creatorId) {
  return rootCascadeRowsRemain(tx, "CreatorAccount", creatorId);
}

async function phase2CreatorResidualRowsRemain(tx, agencyId, creatorId) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  // Proof-zero must use the same semantic ownership surface as the bounded purge.
  // A direct creatorId-only recheck can miss rows whose owner is encoded through
  // an order/submission/object/dependency identity.
  const checks = [
    [`"TelegramDeliveryIntent"`, `x."creatorId"=$2 OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."customOrderId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE s."id"=x."customSubmissionId" AND s."agencyId"=$1 AND s."creatorId"=$2)`],
    [`"TelegramInboundEvent"`, `x."creatorId"=$2 OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."customOrderId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE s."id"=x."submissionId" AND s."agencyId"=$1 AND s."creatorId"=$2)`],
    [`"ProviderOperationalDebt"`, `x."creatorId"=$2 OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."customOrderId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE s."id"=x."customSubmissionId" AND s."agencyId"=$1 AND s."creatorId"=$2)`],
    [`"DomainWorkItem"`, `x."creatorId"=$2 OR (x."objectType"='CreatorAccount' AND x."objectId"=$2) OR (x."dependencyKind"='CREATOR_BINDING' AND x."dependencyKey"=$2) OR EXISTS (SELECT 1 FROM "CustomOrder" o WHERE x."objectType"='CustomOrder' AND o."id"=x."objectId" AND o."agencyId"=$1 AND o."creatorId"=$2) OR EXISTS (SELECT 1 FROM "CustomContentSubmission" s WHERE x."objectType"='CustomContentSubmission' AND s."id"=x."objectId" AND s."agencyId"=$1 AND s."creatorId"=$2)`],
    [`"Phase2DependencyState"`, `x."dependencyKind"='CREATOR_BINDING' AND x."dependencyKey"=$2 OR (x."dependencyKind"='REMINDER_OUTCOME' AND EXISTS (SELECT 1 FROM "CustomOrder" o WHERE o."id"=x."dependencyKey" AND o."agencyId"=$1 AND o."creatorId"=$2))`],
    [`"AutomationJob"`, `x."creatorId"=$2 OR x."accountId"=$2 OR EXISTS (SELECT 1 FROM "AutomationTask" t WHERE t."id"=x."taskId" AND t."agencyId"=$1 AND t."creatorId"=$2)`],
    [`"AutomationTask"`, `x."creatorId"=$2`],
    [`"TeamSentMessageLedger"`, `x."creatorId"=$2`],
    [`"TeamPpvPurchaseLedger"`, `x."creatorId"=$2`],
    [`"TeamTipLedger"`, `x."creatorId"=$2`],
    [`"TeamPpvResolveJob"`, `x."creatorId"=$2`],
  ];
  for (const [table, predicate] of checks) {
    const rows = await tx.$queryRawUnsafe(`SELECT 1 AS present FROM ${table} x WHERE x."agencyId"=$1 AND (${predicate}) LIMIT 1`, agencyId, creatorId);
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
}


const AGENCY_NON_FK_TENANT_TABLES = Object.freeze([
  "ProviderOperationalDebt",
  "TelegramDeliveryIntent",
  "TelegramInboundEvent",
  "RefreshSession",
  "AnalyticsCollectionDemand",
  "DeviceCommand",
  "AutomationTask",
  "AutomationJob",
  "AutomationEvent",
  "ContentUsageEvent",
  "BumpDeliveryStat",
  "TeamSentMessageLedger",
  "TeamPpvPurchaseLedger",
  "TeamTipLedger",
  "TeamPpvResolveJob",
]);

async function purgeAgencyNonFkTenantBatch({ tx, agencyId, limit }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { deleted: 0, exhausted: false, remaining: Number(limit) || 0 };
  let remaining = Math.max(1, Number(limit) || AGENCY_DELETE_BATCH);
  let deleted = 0;
  let lastTable = null;
  for (const tableName of AGENCY_NON_FK_TENANT_TABLES) {
    if (remaining <= 0) break;
    const table = qident(tableName);
    const count = await rawDeleteBatch(
      tx,
      `DELETE FROM ${table} t WHERE t.ctid IN (SELECT x.ctid FROM ${table} x WHERE x."agencyId"=$1 ORDER BY x.ctid LIMIT $2) RETURNING 1`,
      [agencyId],
      remaining,
    );
    deleted += count;
    remaining -= count;
    if (count > 0) lastTable = tableName;
  }
  return { deleted, exhausted: remaining <= 0, remaining, lastTable };
}

async function purgeAgencyDomainWorkBatch({ tx, agencyId, protectedWorkId, limit }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { deleted: 0, exhausted: false, remaining: Number(limit) || 0 };
  const workId = String(protectedWorkId || "").trim();
  if (!workId) throw Object.assign(new Error("Agency destructive work id is required"), { code: "PHASE2_AGENCY_DESTRUCTIVE_WORK_ID_REQUIRED" });
  const count = await rawDeleteBatch(
    tx,
    `DELETE FROM "DomainWorkItem" d WHERE d.ctid IN (
       SELECT x.ctid FROM "DomainWorkItem" x
        WHERE x."agencyId"=$1 AND x."id"<>$2
        ORDER BY x.ctid LIMIT $3
     ) RETURNING 1`,
    [agencyId, workId],
    limit,
  );
  return { deleted: count, exhausted: count >= Math.max(1, Number(limit) || 1), remaining: Math.max(0, (Number(limit) || 0) - count) };
}

async function agencyNonFkRowsRemain(tx, agencyId) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  for (const tableName of AGENCY_NON_FK_TENANT_TABLES) {
    const rows = await tx.$queryRawUnsafe(`SELECT 1 AS present FROM ${qident(tableName)} WHERE "agencyId"=$1 LIMIT 1`, agencyId);
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
}

async function agencyOtherDomainWorkRowsRemain(tx, agencyId, protectedWorkId) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  const rows = await tx.$queryRawUnsafe(
    `SELECT 1 AS present FROM "DomainWorkItem" WHERE "agencyId"=$1 AND "id"<>$2 LIMIT 1`,
    agencyId,
    protectedWorkId,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureAgencyCreatorCleanupBatch({ tx, agencyId, now, limit = 10 }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { scheduled: 0, creatorIds: [] };
  const take = Math.max(1, Math.min(25, Number(limit) || 10));
  const rows = await tx.$queryRawUnsafe(
    `SELECT c."id",c."deletedAt"
       FROM "CreatorAccount" c
      WHERE c."agencyId"=$1
        AND NOT EXISTS (
          SELECT 1 FROM "DomainWorkItem" d
           WHERE d."agencyId"=$1
             AND d."workClass"=$2
             AND d."objectType"='Phase2CreatorDestructiveCleanup'
             AND d."objectId"=c."id"
             AND d."isOutstanding"=TRUE
        )
      ORDER BY c."id"
      FOR UPDATE OF c SKIP LOCKED
      LIMIT $3`,
    agencyId,
    WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP,
    take,
  );
  const creatorIds = [];
  for (const row of rows || []) {
    const creatorId = String(row?.id || "").trim();
    if (!creatorId) continue;
    // Agency destruction is a privileged mode of the same Creator lifecycle, not
    // a second writer. This performs scope/invitation cleanup, Team live-edge
    // retirement, crypto/session revocation, device/job cancellation and child
    // destructive publication under the same canonical transition.
    await retireCreatorWithinTransaction({
      tx,
      agencyId,
      creatorId,
      actorUserId: null,
      mode: "HARD",
      retiredAt: now,
      sourceRequestId: `agency-destructive:${agencyId}:creator:${creatorId}:${now.getTime()}`,
      revokeReason: "AGENCY_DESTRUCTIVE_CREATOR_RETIREMENT",
    });
    creatorIds.push(creatorId);
  }
  return { scheduled: creatorIds.length, creatorIds };
}

async function agencyCreatorRowsRemain(tx, agencyId) {
  if (typeof tx?.$queryRawUnsafe === "function") {
    const rows = await tx.$queryRawUnsafe(`SELECT 1 AS present FROM "CreatorAccount" WHERE "agencyId"=$1 LIMIT 1`, agencyId);
    return Array.isArray(rows) && rows.length > 0;
  }
  if (tx?.creatorAccount?.findFirst) return Boolean(await tx.creatorAccount.findFirst({ where: { agencyId }, select: { id: true } }));
  return false;
}

async function processAgencyHardDeleteWorkItem({ db, item, ownerToken, batchSize = AGENCY_DELETE_BATCH, fallbackNow = new Date() } = {}) {
  if (!db || !item || String(item.workClass) !== WORK_CLASS.DESTRUCTIVE_AGENCY_CLEANUP) {
    return { ok: false, code: "PHASE2_AGENCY_DESTRUCTIVE_WORK_INVALID" };
  }
  const agencyId = String(item.agencyId || "").trim();
  if (!agencyId || String(item.objectId || "") !== agencyId) return { ok: false, code: "PHASE2_AGENCY_DESTRUCTIVE_IDENTITY_INVALID" };
  const limit = Math.max(10, Math.min(1000, Number(batchSize) || AGENCY_DELETE_BATCH));
  const now = fallbackNow instanceof Date ? fallbackNow : new Date(fallbackNow || Date.now());

  return runDbTransaction(db, async (tx) => {
    // Agency destructive cleanup also mutates Team current topology through child
    // Creator retirement. Keep it outside the new C2 graph until release ACTIVE.
    // DRAINING is an intentional deployment dependency, not a failed destructive
    // attempt: yield this durable work instead of polluting retry/error telemetry.
    try {
      await assertTeamControlPlaneWriteAdmission(tx);
    } catch (error) {
      if (error?.code === "TEAM_CONTROL_PLANE_DRAINING") {
        return { ok: true, complete: false, phase: "WAIT_TEAM_CONTROL_PLANE_RELEASE" };
      }
      throw error;
    }
    await lockAgencyPipelineLifecycleExclusive({ db: tx, agencyId, allowDeleted: true });
    const agency = await tx.agency.findUnique({ where: { id: agencyId }, select: { id: true, deletedAt: true, status: true } });
    if (!agency) return { ok: true, complete: true, alreadyDeleted: true, identityDeleted: true, phase: "IDENTITY_ABSENT" };
    if (!agency.deletedAt) return { ok: false, code: "PHASE2_AGENCY_DELETE_BARRIER_MISSING" };

    await assertAgencyCustomPipelineRetirable({ db: tx, agencyId });
    await assertAgencyMassCampaignRetirable({ db: tx, agencyId, requireFreshProviderSnapshot: false });
    const claim = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow: now });
    if (claim?.lost) return { ok: false, lost: true, code: claim.code || "DOMAIN_WORK_CLAIM_LOST" };

    // DestructiveInternalAuthority: mark only this claimed transaction as the
    // authorized Agency cleanup executor. DB fences require both this local token
    // and the durable destructive DWI, so ordinary/stale writers remain blocked.
    if (typeof tx?.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, agencyId);
    }

    // Agency destruction composes the existing Creator destructive lifecycle instead of
    // bypassing it. At most 10 Creator cleanup authorities are published in one transaction.
    const seeded = await ensureAgencyCreatorCleanupBatch({ tx, agencyId, now, limit: 10 });
    if (seeded.scheduled > 0) {
      return { ok: true, complete: false, deleted: 0, workUnits: seeded.scheduled, phase: "CREATOR_LIFECYCLES", creatorIds: seeded.creatorIds };
    }
    if (await agencyCreatorRowsRemain(tx, agencyId)) {
      return { ok: true, complete: false, deleted: 0, phase: "WAIT_CREATOR_LIFECYCLES" };
    }

    let remaining = limit;
    const nonFk = await purgeAgencyNonFkTenantBatch({ tx, agencyId, limit: remaining });
    remaining -= nonFk.deleted;
    if (remaining <= 0) return { ok: true, complete: false, deleted: nonFk.deleted, phase: "NON_FK_TENANT" };

    const otherWork = await purgeAgencyDomainWorkBatch({ tx, agencyId, protectedWorkId: item.id, limit: remaining });
    remaining -= otherWork.deleted;
    let deleted = nonFk.deleted + otherWork.deleted;
    if (remaining <= 0) return { ok: true, complete: false, deleted, phase: "DOMAIN_WORK" };

    const directActions = await purgeRootDirectForeignActionsBatch({
      tx,
      rootTable: "Agency",
      rootId: agencyId,
      limit: remaining,
      deleteRestrictedTables: [],
    });
    remaining -= directActions.changed;
    deleted += directActions.changed;
    if (remaining <= 0) return { ok: true, complete: false, deleted, phase: "DIRECT_FK_ACTIONS", table: directActions.lastTable, action: directActions.lastAction };

    const cascade = await purgeRootCascadeDescendantsBatch({
      tx,
      rootTable: "Agency",
      rootId: agencyId,
      limit: remaining,
      excludeTables: ["CreatorAccount", "DomainWorkItem"],
    });
    remaining -= cascade.workUnits;
    deleted += cascade.workUnits;
    if (remaining <= 0) return { ok: true, complete: false, deleted, phase: "TENANT_CASCADE_DESCENDANTS", table: cascade.lastTable, depth: cascade.lastDepth };

    if (await agencyNonFkRowsRemain(tx, agencyId)) return { ok: true, complete: false, deleted, phase: "NON_FK_RECHECK" };
    if (await agencyOtherDomainWorkRowsRemain(tx, agencyId, item.id)) return { ok: true, complete: false, deleted, phase: "DOMAIN_WORK_RECHECK" };
    if (await rootDirectForeignActionsRemain(tx, "Agency", agencyId)) return { ok: true, complete: false, deleted, phase: "DIRECT_FK_RECHECK" };
    if (await rootCascadeRowsRemain(tx, "Agency", agencyId, { excludeTables: ["CreatorAccount", "DomainWorkItem"] })) {
      return { ok: true, complete: false, deleted, phase: "TENANT_CASCADE_RECHECK" };
    }

    // The only Agency-cascade row intentionally allowed to remain is this cleanup DWI.
    // Deleting Agency removes that row atomically, then the DWI AFTER DELETE trigger may
    // recreate zero-count non-FK current-work roots; purge those after the cascade.
    await tx.agency.delete({ where: { id: agencyId } });
    await purgeAgencyPhase2CurrentWorkRootsAfterCascade({ db: tx, agencyId });
    return { ok: true, complete: true, identityDeleted: true, deleted, phase: "IDENTITY_DELETED" };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

async function processCreatorHardDeleteWorkItem({ db, item, ownerToken, batchSize = CREATOR_DELETE_BATCH, fallbackNow = new Date() } = {}) {
  if (!db || !item || String(item.workClass) !== WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP) {
    return { ok: false, code: "PHASE2_DESTRUCTIVE_WORK_INVALID" };
  }
  const agencyId = String(item.agencyId || "");
  const creatorId = String(item.objectId || "");
  const limit = Math.max(10, Math.min(1000, Number(batchSize) || CREATOR_DELETE_BATCH));

  return runDbTransaction(db, async (tx) => {
    // Shared lifecycle/Creator row precedes the work claim, matching normal Phase2
    // producer lock order. deletedAt is the durable DELETING barrier for this v1 API.
    await lockCreatorPipelineLifecycle({ db: tx, agencyId, creatorId, allowDeleted: true });
    const creator = await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId }, select: { id: true, deletedAt: true } });
    if (!creator) return { ok: true, complete: true, alreadyDeleted: true };
    if (!creator.deletedAt) return { ok: false, code: "PHASE2_CREATOR_DELETE_BARRIER_MISSING" };

    await assertCreatorCustomPipelineRetirable({ db: tx, agencyId, creatorId });
    await assertCreatorMassCampaignRetirable({ db: tx, agencyId, creatorId, requireFreshProviderSnapshot: false });
    const claim = await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken, fallbackNow });
    if (claim?.lost) return { ok: false, lost: true, code: claim.code || "DOMAIN_WORK_CLAIM_LOST" };

    // Creator cleanup gets an explicit transaction-local authorization token.
    // Trigger policy may suppress cleanup-generated invalidations only for this
    // claimed destructive transaction, never merely because deletion is pending.
    if (typeof tx?.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_creator_id',$1,true) AS value`, creatorId);
      await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_destructive_agency_id',$1,true) AS value`, agencyId);
    }

    let remaining = limit;
    const nonFk = await purgeCreatorNonFkPhase2Batch({ tx, agencyId, creatorId, limit: remaining });
    remaining -= nonFk.deleted;
    if (remaining <= 0) return { ok: true, complete: false, deleted: nonFk.deleted, phase: "NON_FK" };

    const directActions = await purgeRootDirectForeignActionsBatch({
      tx,
      rootTable: "CreatorAccount",
      rootId: creatorId,
      limit: remaining,
      // Historical TeamShiftCreator rows are retained. Migration 170000 moves
      // the live Creator FK onto nullable creatorRefId with ON DELETE SET NULL,
      // while creatorId remains durable schedule evidence. Any future direct
      // RESTRICT/NO ACTION relation fails closed until explicitly classified.
      deleteRestrictedTables: [],
    });
    remaining -= directActions.changed;
    let deleted = nonFk.deleted + directActions.changed;
    if (remaining <= 0) return { ok: true, complete: false, deleted, phase: "DIRECT_FK_ACTIONS", table: directActions.lastTable, action: directActions.lastAction };

    const cascade = await purgeCreatorCascadeChildrenBatch({ tx, creatorId, limit: remaining });
    remaining -= cascade.workUnits;
    deleted += cascade.workUnits;
    if (remaining <= 0) return { ok: true, complete: false, deleted, phase: "CASCADE_CHILDREN" };

    if (await phase2CreatorResidualRowsRemain(tx, agencyId, creatorId)) return { ok: true, complete: false, deleted, phase: "NON_FK_RECHECK" };
    if (await rootDirectForeignActionsRemain(tx, "CreatorAccount", creatorId)) return { ok: true, complete: false, deleted, phase: "DIRECT_FK_RECHECK" };
    if (await creatorCascadeRowsRemain(tx, creatorId)) return { ok: true, complete: false, deleted, phase: "CASCADE_RECHECK" };

    await tx.creatorAccount.delete({ where: { id: creatorId } });
    return { ok: true, complete: true, deleted, phase: "IDENTITY_DELETED" };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
}

module.exports = {
  CREATOR_DELETE_BATCH,
  AGENCY_DELETE_BATCH,
  collectCreatorPhase2DestructiveScope,
  purgeAgencyPhase2ProviderLedgersForHardDelete,
  purgeAgencyPhase2CurrentWorkRootsAfterCascade,
  purgeCreatorPhase2ResidualsForHardDelete,
  processCreatorHardDeleteWorkItem,
  processAgencyHardDeleteWorkItem,
  purgeCreatorNonFkPhase2Batch,
  purgeCreatorCascadeChildrenBatch,
  purgeAgencyNonFkTenantBatch,
  purgeRootCascadeDescendantsBatch,
  purgeRootDirectForeignActionsBatch,
  rootDirectForeignActionsRemain,
  loadForeignKeyConstraints,
  cascadeDeletePlanFromConstraints,
  externalCascadeForeignActionPlanFromConstraints,
  directRootForeignActionPlanFromConstraints,
};
