"use strict";
const { performance } = require("node:perf_hooks");
const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const work = require("./domain-work-authority-service");
const { projectFacts, PAGE_SIZE } = require("./notification-consequence-service");
const KEY = "phase5_notification_history_v1";
const RECEIPT_KEY = "phase5_notification_history_v2";
const RECEIPT_WORK_CLASS = work.WORK_CLASS.NOTIFICATION_RECEIPT_REPAIR;
const WORK_CLASS = work.WORK_CLASS.NOTIFICATION_HISTORY_REPAIR;
const TABLES = ["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent"];
const MODELS = ["creatorSale", "creatorTip", "creatorSubscriptionEvent"];
const CATALOG_PAGE = 10;
function fault(code) { return Object.assign(new Error(code), { code }); }
function owned(value) { if (!value || value.lost) throw fault("NOTIFICATION_HISTORY_CLAIM_LOST"); return value; }

// This exact tuple query is shared with the EXPLAIN proof. No OFFSET, no scan of
// old jobs, no dependence on a retained sourceJobId or a still-live fan relation.
function pageSql(table) {
  if (!TABLES.includes(table)) throw fault("NOTIFICATION_HISTORY_TABLE_INVALID");
  return `SELECT "id","createdAt" FROM "${table}"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "createdAt" <= $3::timestamp
      AND ("createdAt","id") > ($4::timestamp,$5::text)
    ORDER BY "createdAt","id" LIMIT $6`;
}

async function enumerateHistoryCreators({ db, receiptRepair = false }) {
  const key = receiptRepair ? RECEIPT_KEY : KEY;
  const workClass = receiptRepair ? RECEIPT_WORK_CLASS : WORK_CLASS;
  return runRootCommit(db, async ({ tx }) => {
    const rows = await tx.$queryRawUnsafe('SELECT * FROM "MaintenanceLaneState" WHERE "key"=$1 FOR UPDATE SKIP LOCKED', key);
    const state = rows[0];
    if (!state) return { ok: true, skipped: true, reason: "migration_pending_or_busy" };
    if (state.generation !== key || state.activeGeneration !== key) throw fault("NOTIFICATION_HISTORY_GENERATION_MISMATCH");
    if (state.completedAt) return { ok: true, complete: true, selected: 0 };
    const cursor = state.cursor;
    if (!cursor || typeof cursor.upperId !== "string" || !Number.isFinite(Date.parse(cursor.cutoffAt))) throw fault("NOTIFICATION_HISTORY_CATALOG_CURSOR_INVALID");
    // Selection reads only the PK page. Acquire lifecycle locks in agency/creator
    // order before publishing each intent; a retired tenant cannot be resurrected.
    const creators = await tx.creatorAccount.findMany({ where: { id: { gt: cursor.afterId || "", lte: cursor.upperId } }, orderBy: { id: "asc" }, take: CATALOG_PAGE, select: { id: true, agencyId: true } });
    let published = 0;
    for (const candidate of [...creators].sort((a,b) => a.agencyId.localeCompare(b.agencyId) || a.id.localeCompare(b.id))) {
      const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: candidate.agencyId });
      if (!lifecycle.row || lifecycle.row.deletedAt) continue;
      await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 FOR SHARE', candidate.id, candidate.agencyId);
      const creator = await tx.creatorAccount.findFirst({ where: { id: candidate.id, agencyId: candidate.agencyId, deletedAt: null }, select: { id: true } });
      if (!creator) continue;
      const identity = { agencyId: candidate.agencyId, workClass, objectType: "CreatorAccount", objectId: candidate.id };
      const id = work.workId(identity);
      if (await tx.domainWorkItem.findUnique({ where: { id }, select: { id: true } })) continue;
      const item = await work.publishDomainWork({ db: tx, ...identity, creatorId: candidate.id, parentObjectId: candidate.id, partitionKey: candidate.id });
      if (!item?.id) throw fault("NOTIFICATION_HISTORY_INTENT_REQUIRED");
      await tx.domainWorkItem.update({ where: { id: item.id }, data: { progressCursor: { cutoffAt: cursor.cutoffAt, generation: key,
        tailFrom: null, afterCreatedAt: null, afterId: "",
        table: 0, processed: 0, identityMissing: 0 } } });
      published++;
    }
    const complete = creators.length < CATALOG_PAGE || creators.at(-1)?.id === cursor.upperId;
    const now = await dbAuthorityNow({ db: tx });
    await tx.maintenanceLaneState.update({ where: { key }, data: {
      cursor: { ...cursor, afterId: creators.at(-1)?.id || cursor.afterId || "" },
      progress: { enumerated: Number(state.progress?.enumerated || 0) + creators.length, published: Number(state.progress?.published || 0) + published },
      completedAt: complete ? now : null, lastRunAt: now, lastOutcome: complete ? "ENUMERATION_COMPLETE" : "ENUMERATING",
    } });
    return { ok: true, complete, selected: creators.length, published };
  }, { profile: "JOB_CHUNK", authority: { kind: "NOTIFICATION_HISTORY_ENUMERATION" } });
}

async function processHistoryPage({ db, item, ownerToken }) {
  if (![WORK_CLASS, RECEIPT_WORK_CLASS].includes(item.workClass) || item.objectType !== "CreatorAccount" || item.objectId !== item.creatorId) throw fault("NOTIFICATION_HISTORY_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 FOR SHARE', item.creatorId, item.agencyId);
    const claim = owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    const creator = await tx.creatorAccount.findFirst({ where: { id: item.creatorId, agencyId: item.agencyId, deletedAt: null }, select: { id: true } });
    if (!lifecycle.row || lifecycle.row.deletedAt || !creator) {
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" }));
      return { completed: true, retired: true, processed: 0 };
    }
    if (claim.newerRevision) throw fault("NOTIFICATION_HISTORY_UNEXPECTED_REPUBLICATION");
    const cursor = claim.item.progressCursor || {};
    const table = cursor.table;
    if (!Number.isInteger(table) || table < 0 || table >= TABLES.length || !Number.isFinite(Date.parse(cursor.cutoffAt))) throw fault("NOTIFICATION_HISTORY_CURSOR_INVALID");
    const page = await tx.$queryRawUnsafe(pageSql(TABLES[table]), item.agencyId, item.creatorId,
      new Date(cursor.cutoffAt), new Date(cursor.afterCreatedAt || "0001-01-01T00:00:00Z"), cursor.afterId || "", PAGE_SIZE);
    const rows = page.length ? await tx[MODELS[table]].findMany({
      where: { agencyId: item.agencyId, creatorId: item.creatorId, id: { in: page.map(row => row.id) } },
      include: { fan: { select: { onlyFansUserId: true, username: true, displayName: true } } },
    }) : [];
    if (rows.length !== page.length) throw fault("NOTIFICATION_HISTORY_SOURCE_CHANGED");
    const identityMissing = rows.filter(row => !(row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId)).length;
    const policy = await require("./retention-service").getRetentionSettings({ db: tx });
    if (!policy.ok) throw fault("NOTIFICATION_HISTORY_RETENTION_POLICY_UNAVAILABLE");
    const now = await dbAuthorityNow({ db: tx });
    const historyPolicy = { organicCutoff: policy.settings.trafficPaidOrganicLedgerDays > 0 ? new Date(now.getTime() - policy.settings.trafficPaidOrganicLedgerDays * 86400000) : null };
    const effects = await projectFacts({ db: tx, job: { agencyId: item.agencyId, creatorId: item.creatorId, params: {} }, table, rows, historical: true, historyPolicy });
    const more = page.length === PAGE_SIZE;
    const next = { cutoffAt: cursor.cutoffAt, generation: cursor.generation || KEY, tailFrom: cursor.tailFrom || null, table: more ? table : table + 1,
      afterId: more ? page.at(-1).id : null, afterCreatedAt: more ? page.at(-1).createdAt.toISOString() : (table === 0 ? cursor.tailFrom || null : null),
      retentionExcluded: Number(cursor.retentionExcluded || 0) + effects.retentionExcluded,
      processed: Number(cursor.processed || 0) + rows.length, identityMissing: Number(cursor.identityMissing || 0) + identityMissing };
    if (next.table < TABLES.length) {
      owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken, progressCursor: next }));
      return { yielded: true, processed: rows.length, identityMissing };
    }
    // Retain a durable, scoped reconstruction report. This never fabricates a
    // collector frontier, a successful Job, or coverage for absent historical rows.
    await tx.domainWorkItem.update({ where: { id: item.id }, data: { lastRepair: { ...next, coverage: next.identityMissing ? "RETAINED_FACTS_WITH_IDENTITY_GAPS" : "RETAINED_FACTS_ONLY" } } });
    owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: next.identityMissing ? "HISTORY_REPAIRED_WITH_IDENTITY_GAPS" : "RETAINED_HISTORY_REPAIRED" }));
    return { completed: true, processed: rows.length, identityMissing };
  }, { profile: "JOB_CHUNK", authority: { kind: "NOTIFICATION_HISTORY_REPAIR", agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function runNotificationHistoryRepairSweep({ db = require("../prisma"), limit = 4, maxRuntimeMs = 3000 } = {}) {
  const started = performance.now();
  const enumeration = await enumerateHistoryCreators({ db });
  const receiptEnumeration = await enumerateHistoryCreators({ db, receiptRepair: true });
  const report = { ok: true, enumeration, receiptEnumeration, processed: 0, completed: 0, yielded: 0, failed: 0, identityMissing: 0 };
  for (let step = 0; step < Math.max(1, Math.min(8, Number(limit) || 4)) && performance.now() - started < maxRuntimeMs; step++) {
    const claim = await work.claimDomainWorkBatch({ db, workClass: step % 2 ? RECEIPT_WORK_CLASS : WORK_CLASS, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
    if (claim.skipped) { report.ok = false; report.reason = claim.reason; break; }
    const item = claim.items?.[0]; if (!item) continue;
    try {
      const result = await processHistoryPage({ db, item, ownerToken: claim.ownerToken });
      report.processed += result.processed; report.identityMissing += result.identityMissing || 0;
      if (result.completed) report.completed++; if (result.yielded) report.yielded++;
    } catch (error) {
      await work.failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error }); report.failed++; report.ok = false;
    }
  }
  return report;
}
module.exports = { KEY, RECEIPT_KEY, RECEIPT_WORK_CLASS, WORK_CLASS, TABLES, PAGE_SIZE, CATALOG_PAGE, pageSql, enumerateHistoryCreators, processHistoryPage, runNotificationHistoryRepairSweep };
