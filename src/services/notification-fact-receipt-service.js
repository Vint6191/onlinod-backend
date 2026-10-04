"use strict";
const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { pauseDeletedAgencyProjection } = require("./analytics-projection-lifecycle-service");
const WORK_CLASS = "NOTIFICATION_FACT_RECEIPTS";
const KINDS = ["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent"];
const MODELS = ["creatorSale", "creatorTip", "creatorSubscriptionEvent"];
const PAGE = 50;
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"]);
function owned(value) {
  if (!value || value.lost) throw Object.assign(new Error("NOTIFICATION_RECEIPT_CLAIM_LOST"), { code: "NOTIFICATION_RECEIPT_CLAIM_LOST" });
  return value;
}

async function capture({ db, job, groups }) {
  if (job?.jobKey !== "catchup_notifications_scan" || job.sourceJobId === null) return;
  const records = groups.flatMap(({ kind, ids }) => (ids || []).map(factId => ({ kind, factId })));
  if (!records.length) return;
  // Includes unchanged accepted rows. An unchanged observation has no row
  // UPDATE trigger, but still belongs to this job's delivery contract.
  await db.$executeRawUnsafe(`INSERT INTO "NotificationFactReceipt"("jobId","kind","factId","agencyId","creatorId","historical")
    SELECT j.id,r.kind,r."factId",j."agencyId",j."creatorId",COALESCE(j.params->>'notificationMode','')<>'catchup'
    FROM "JobInstance" j CROSS JOIN jsonb_to_recordset($4::jsonb) r(kind text,"factId" text)
    WHERE j.id=$1 AND j."agencyId"=$2 AND j."creatorId"=$3 AND j."jobKey"='catchup_notifications_scan'
    ON CONFLICT DO NOTHING`, job.id, job.agencyId, job.creatorId, JSON.stringify(records));
  await work.publishDomainWork({ db, agencyId: job.agencyId, creatorId: job.creatorId, workClass: WORK_CLASS,
    objectType: "JobInstance", objectId: job.id, partitionKey: job.creatorId, parentObjectId: job.creatorId });
}

async function processPage({ db, item, ownerToken }) {
  if (item.workClass !== WORK_CLASS || item.objectType !== "JobInstance" || !item.creatorId) throw new Error("NOTIFICATION_RECEIPT_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    await tx.$queryRawUnsafe('SELECT id FROM "JobInstance" WHERE id=$1 AND "agencyId"=$2 FOR SHARE', item.objectId, item.agencyId);
    // Same order as producers: Job -> Receipt -> DomainWork. No cursor can
    // jump past a newly inserted lower ID: successfully delivered rows disappear.
    const receipts = await tx.$queryRawUnsafe(`SELECT * FROM "NotificationFactReceipt" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "jobId"=$3
      ORDER BY kind,"factId" LIMIT $4 FOR UPDATE SKIP LOCKED`, item.agencyId, item.creatorId, item.objectId, PAGE);
    const claim = owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true, processed: 0 };
    const creator = await tx.creatorAccount.findFirst({ where: { id: item.creatorId, agencyId: item.agencyId, deletedAt: null }, select: { id: true } });
    if (!lifecycle.row || !creator) {
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" }));
      return { completed: true, retired: true, processed: 0 };
    }
    const retainedJob = await tx.jobInstance.findUnique({ where: { id: item.objectId } });
    if (retainedJob && (retainedJob.agencyId !== item.agencyId || retainedJob.creatorId !== item.creatorId || retainedJob.jobKey !== "catchup_notifications_scan")) throw new Error("NOTIFICATION_RECEIPT_JOB_SCOPE_INVALID");
    if (retainedJob && !TERMINAL.has(retainedJob.status)) {
      owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken, availableAt: new Date(+claim.authorityNow + 30000) }));
      return { waiting: true, processed: 0 };
    }
    // Job retention cannot erase a pending receipt. Missing old job metadata
    // permits only reconciliation, never replay of historical automation.
    const job = retainedJob || { id: item.objectId, agencyId: item.agencyId, creatorId: item.creatorId, params: {} };
    const { projectFacts } = require("./notification-consequence-service");
    const historical = !retainedJob || receipts.some(row => row.historical);
    let historyPolicy = null;
    if (historical) {
      const policy = await require("./retention-service").getRetentionSettings({ db: tx });
      if (!policy.ok) throw new Error("NOTIFICATION_RECEIPT_RETENTION_POLICY_UNAVAILABLE");
      historyPolicy = { organicCutoff: policy.settings.trafficPaidOrganicLedgerDays > 0 ? new Date(+claim.authorityNow - policy.settings.trafficPaidOrganicLedgerDays * 86400000) : null };
    }
    for (let table = 0; table < KINDS.length; table++) {
      const ids = receipts.filter(row => row.kind === KINDS[table]).map(row => row.factId);
      if (!ids.length) continue;
      const rows = await tx[MODELS[table]].findMany({ where: { agencyId: item.agencyId, creatorId: item.creatorId, id: { in: ids } },
        include: { fan: { select: { onlyFansUserId: true, username: true, displayName: true } } } });
      await projectFacts({ db: tx, job, table, rows, historical, historyPolicy });
    }
    if (receipts.some(row => !KINDS.includes(row.kind))) throw new Error("NOTIFICATION_RECEIPT_KIND_INVALID");
    if (receipts.length) await tx.$executeRawUnsafe(`DELETE FROM "NotificationFactReceipt" f USING jsonb_to_recordset($4::jsonb) r(kind text,"factId" text)
      WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f."jobId"=$3 AND f.kind=r.kind AND f."factId"=r."factId"`,
      item.agencyId, item.creatorId, item.objectId, JSON.stringify(receipts.map(({ kind, factId }) => ({ kind, factId }))));
    const pending = await tx.notificationFactReceipt.findFirst({ where: { agencyId: item.agencyId, creatorId: item.creatorId, jobId: item.objectId }, select: { factId: true } });
    const processed = Number(claim.item.progressCursor?.processed || 0) + receipts.length;
    if (pending) owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken, progressCursor: { processed } }));
    else {
      // This marks delivery only. Collection clocks remain owned by the scan
      // completion, and a newer scan's summary cannot be overwritten here.
      if (retainedJob) await tx.$executeRawUnsafe(`UPDATE "TeamObservationState" SET "lastScanSummary"=COALESCE("lastScanSummary",'{}'::jsonb)
        || jsonb_build_object('compatibilityComplete',TRUE,'compatibilityDeferred',FALSE,'compatibilityProcessed',$4::int,'projection','notification_fact_receipts_v1')
        WHERE "agencyId"=$1 AND "creatorId"=$2 AND "lastScanSummary"->>'jobId'=$3
          AND ("lockedUntil" IS NULL OR "lockedUntil"<=$5::timestamp)`, item.agencyId, item.creatorId, item.objectId, processed, claim.authorityNow);
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
    }
    return { processed: receipts.length, completed: !pending, yielded: Boolean(pending) };
  }, { profile: "JOB_CHUNK", authority: { kind: WORK_CLASS, agencyId: item.agencyId, creatorId: item.creatorId } });
}
module.exports = { WORK_CLASS, PAGE, capture, processPage };
