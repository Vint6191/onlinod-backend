"use strict";
const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { pauseDeletedAgencyProjection } = require("./analytics-projection-lifecycle-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const WORK_CLASS = "FINANCIAL_RECEIPT_RETENTION", KEEP_MS = 30 * 86400000, PAGE = 100;
function owned(value) { if (!value || value.lost) throw new Error("FINANCIAL_RETENTION_CLAIM_LOST"); return value; }
async function publish({ db, job, now }) {
  return work.publishDomainWork({ db, agencyId: job.agencyId, creatorId: job.creatorId, workClass: WORK_CLASS,
    objectType: "CreatorAccount", objectId: job.creatorId, partitionKey: job.creatorId, availableAt: new Date(+now + KEEP_MS) });
}
async function processPage({ db, item, ownerToken }) {
  if (item.workClass !== WORK_CLASS || item.objectId !== item.creatorId) throw new Error("FINANCIAL_RETENTION_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    const now = await dbAuthorityNow({ db: tx }), cutoff = new Date(+now - KEEP_MS);
    // Producer and consumer both lock Run before retention work. Referenced
    // proof headers remain; their bulky dedupe/page details are no longer used
    // after a committed run. A paused/in-flight generation is never compacted.
    const [run] = await tx.$queryRawUnsafe(`SELECT r.* FROM "FinancialReceiptRun" r
      LEFT JOIN "CreatorFinancialCollectionState" s ON s."creatorId"=r."creatorId"
      WHERE r."agencyId"=$1 AND r."creatorId"=$2 AND r."createdAt"<$3
        AND (r."compactedAt" IS NULL OR (r.generation IS DISTINCT FROM s."activeGeneration"
          AND r.generation IS DISTINCT FROM s."baselineGeneration" AND r.generation IS DISTINCT FROM s."lastCatchupGeneration"))
        AND NOT EXISTS(SELECT 1 FROM "JobInstance" j WHERE j.id=r."jobId" AND j.params->>'collectionGeneration'=r.generation
          AND j.status IN ('SCHEDULED','CLAIMED','PAUSED','PUBLISHING'))
      ORDER BY r."createdAt",r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, item.agencyId, item.creatorId, cutoff);
    owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true, deleted: 0 };
    if (!run) {
      const next = await tx.financialReceiptRun.findFirst({ where: { agencyId: item.agencyId, creatorId: item.creatorId, compactedAt: null, createdAt: { gte: cutoff } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { createdAt: true } });
      if (next) owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken, availableAt: new Date(Math.max(+now + 1000, +next.createdAt + KEEP_MS + 1000)) }));
      else owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
      return { deleted: 0, completed: !next };
    }
    await require("./financial-receipt-authority").enter(tx);
    if (!run.detailsRetiredAt) await tx.financialReceiptRun.update({ where: { id: run.id }, data: { detailsRetiredAt: now } });
    let deleted = 0;
    const facts = await tx.financialObservedFact.findMany({ where: { runId: run.id }, orderBy: [{ windowIndex: "asc" }, { externalId: "asc" }], take: PAGE, select: { windowIndex: true, externalId: true } });
    if (facts.length) deleted = (await tx.financialObservedFact.deleteMany({ where: { runId: run.id, OR: facts } })).count;
    else {
      const pages = await tx.financialPageReceipt.findMany({ where: { runId: run.id }, orderBy: [{ windowIndex: "asc" }, { page: "asc" }], take: PAGE, select: { windowIndex: true, page: true } });
      if (pages.length) deleted = (await tx.financialPageReceipt.deleteMany({ where: { runId: run.id, OR: pages } })).count;
      else {
        const state = await tx.creatorFinancialCollectionState.findUnique({ where: { creatorId: item.creatorId } });
        const retained = [state?.activeGeneration, state?.baselineGeneration, state?.lastCatchupGeneration].includes(run.generation);
        await require("./financial-receipt-authority").enter(tx);
        if (retained) await tx.financialReceiptRun.update({ where: { id: run.id }, data: { compactedAt: now } });
        else { await tx.financialReceiptRun.delete({ where: { id: run.id } }); deleted++; }
      }
    }
    owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken }));
    return { deleted, yielded: true };
  }, { profile: "JOB_CHUNK", authority: { kind: WORK_CLASS, agencyId: item.agencyId, creatorId: item.creatorId } });
}
async function runSweep({ db = require("../prisma"), limit = 4 } = {}) {
  const report = { ok: true, deleted: 0, failed: 0 };
  for (let i = 0; i < Math.min(8, limit); i++) {
    const claim = await work.claimDomainWorkBatch({ db, workClass: WORK_CLASS, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
    const item = claim.items?.[0]; if (!item) break;
    try { report.deleted += (await processPage({ db, item, ownerToken: claim.ownerToken })).deleted; }
    catch (error) { await work.failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error }); report.failed++; report.ok = false; }
  }
  return report;
}
module.exports = { WORK_CLASS, KEEP_MS, PAGE, publish, processPage, runSweep };
