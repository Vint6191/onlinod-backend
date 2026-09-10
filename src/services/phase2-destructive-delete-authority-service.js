"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const {
  WORK_CLASS,
  lockDomainWorkClaimForCommit,
} = require("./domain-work-authority-service");
const {
  assertCreatorCustomPipelineRetirable,
  lockCreatorPipelineLifecycle,
} = require("./custom-content-pipeline-authority-service");
const { assertCreatorMassCampaignRetirable } = require("./mass-campaign-authority-service");

const CREATOR_DELETE_BATCH = 250;

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
  await run("TeamSentMessageLedger", `x."creatorId"=$2`);
  await run("TeamPpvPurchaseLedger", `x."creatorId"=$2`);
  await run("TeamTipLedger", `x."creatorId"=$2`);
  await run("TeamPpvResolveJob", `x."creatorId"=$2`);

  return { deleted, exhausted: remaining <= 0, remaining };
}

async function creatorCascadeRelations(tx) {
  if (typeof tx?.$queryRawUnsafe !== "function") return [];
  const rows = await tx.$queryRawUnsafe(`
    SELECT child.relname AS "tableName", child_col.attname AS "columnName"
    FROM pg_constraint con
    JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
    JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS ck(attnum,ord) ON TRUE
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS pk(attnum,ord) ON pk.ord=ck.ord
    JOIN pg_attribute parent_col ON parent_col.attrelid=parent.oid AND parent_col.attnum=pk.attnum
    JOIN pg_attribute child_col ON child_col.attrelid=child.oid AND child_col.attnum=ck.attnum
    WHERE con.contype='f' AND con.confdeltype='c'
      AND parent_ns.nspname=current_schema() AND child_ns.nspname=current_schema()
      AND parent.relname='CreatorAccount' AND parent_col.attname='id'
    ORDER BY child.relname ASC, child_col.attname ASC
  `);
  return (rows || []).map((row) => ({ tableName: String(row.tableName), columnName: String(row.columnName) }));
}

async function purgeCreatorCascadeChildrenBatch({ tx, creatorId, limit }) {
  if (typeof tx?.$queryRawUnsafe !== "function") return { deleted: 0, exhausted: false, relations: 0 };
  const relations = await creatorCascadeRelations(tx);
  let remaining = Math.max(1, Number(limit) || CREATOR_DELETE_BATCH);
  let deleted = 0;
  for (const relation of relations) {
    if (remaining <= 0) break;
    const table = qident(relation.tableName);
    const column = qident(relation.columnName);
    const count = await rawDeleteBatch(tx,
      `DELETE FROM ${table} t WHERE t.ctid IN (SELECT x.ctid FROM ${table} x WHERE x.${column}=$1 ORDER BY x.ctid LIMIT $2) RETURNING 1`,
      [creatorId], remaining);
    deleted += count; remaining -= count;
  }
  return { deleted, exhausted: remaining <= 0, remaining, relations: relations.length };
}

async function creatorCascadeRowsRemain(tx, creatorId) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  for (const relation of await creatorCascadeRelations(tx)) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT 1 AS present FROM ${qident(relation.tableName)} WHERE ${qident(relation.columnName)}=$1 LIMIT 1`, creatorId);
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
}

async function phase2CreatorResidualRowsRemain(tx, agencyId, creatorId) {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  const checks = [
    [`"TelegramDeliveryIntent"`, `"creatorId"=$2`],
    [`"TelegramInboundEvent"`, `"creatorId"=$2`],
    [`"ProviderOperationalDebt"`, `"creatorId"=$2`],
    [`"DomainWorkItem"`, `"creatorId"=$2 OR ("objectType"='CreatorAccount' AND "objectId"=$2)`],
    [`"Phase2DependencyState"`, `"dependencyKind"='CREATOR_BINDING' AND "dependencyKey"=$2`],
    [`"TeamSentMessageLedger"`, `"creatorId"=$2`],
    [`"TeamPpvPurchaseLedger"`, `"creatorId"=$2`],
    [`"TeamTipLedger"`, `"creatorId"=$2`],
    [`"TeamPpvResolveJob"`, `"creatorId"=$2`],
  ];
  for (const [table, predicate] of checks) {
    const rows = await tx.$queryRawUnsafe(`SELECT 1 AS present FROM ${table} WHERE "agencyId"=$1 AND (${predicate}) LIMIT 1`, agencyId, creatorId);
    if (Array.isArray(rows) && rows.length) return true;
  }
  return false;
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

    let remaining = limit;
    const nonFk = await purgeCreatorNonFkPhase2Batch({ tx, agencyId, creatorId, limit: remaining });
    remaining -= nonFk.deleted;
    if (remaining <= 0) return { ok: true, complete: false, deleted: nonFk.deleted, phase: "NON_FK" };

    const cascade = await purgeCreatorCascadeChildrenBatch({ tx, creatorId, limit: remaining });
    remaining -= cascade.deleted;
    const deleted = nonFk.deleted + cascade.deleted;
    if (remaining <= 0) return { ok: true, complete: false, deleted, phase: "CASCADE_CHILDREN" };

    if (await phase2CreatorResidualRowsRemain(tx, agencyId, creatorId)) return { ok: true, complete: false, deleted, phase: "NON_FK_RECHECK" };
    if (await creatorCascadeRowsRemain(tx, creatorId)) return { ok: true, complete: false, deleted, phase: "CASCADE_RECHECK" };

    await tx.creatorAccount.delete({ where: { id: creatorId } });
    return { ok: true, complete: true, deleted, phase: "IDENTITY_DELETED" };
  }, { isolationLevel: "Serializable" });
}

module.exports = {
  CREATOR_DELETE_BATCH,
  collectCreatorPhase2DestructiveScope,
  purgeAgencyPhase2ProviderLedgersForHardDelete,
  purgeAgencyPhase2CurrentWorkRootsAfterCascade,
  purgeCreatorPhase2ResidualsForHardDelete,
  processCreatorHardDeleteWorkItem,
  purgeCreatorNonFkPhase2Batch,
  purgeCreatorCascadeChildrenBatch,
};
