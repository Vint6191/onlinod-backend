"use strict";
const prisma = require("../prisma");
const { runDbTransaction } = require("./db-transaction-service");
const { createPlannedJob, publishPlannedJobAvailable } = require("./job-planning-repository");
const { DIALOG_INTELLIGENCE_JOB_KEY, DIALOG_CONTROL_TRANSACTION_OPTIONS } = require("./dialog-intelligence-service");
const { DIALOG_HISTORY_BATCH_DIALOG_ID } = require("./dialog-history-batch-service");
function object(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function clean(v, max = 240) {
  return (
    String(v ?? "")
      .trim()
      .slice(0, max) || null
  );
}
async function latestDiscoveryPlanTx(tx, agencyId, creatorId) {
  return tx.dialogScanRun.findFirst({
    where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
    orderBy: { createdAt: "desc" },
  });
}

async function setHistoryPlanControlTx(tx, { agencyId, creatorId, state, reason, now = new Date() }) {
  const discovery = await latestDiscoveryPlanTx(tx, agencyId, creatorId);
  if (!discovery) return null;
  const continuation = object(discovery.continuation);
  await tx.dialogScanRun.update({
    where: { id: discovery.id },
    data: {
      continuation: {
        ...continuation,
        historyControl: {
          state: clean(state, 40)?.toUpperCase() || "ACTIVE",
          reason: clean(reason, 500),
          at: now.toISOString(),
        },
      },
    },
  });
  return discovery;
}

async function pauseCreatorRuns({ agencyId, creatorId, reason, db = prisma }) {
  const now = new Date();
  return runDbTransaction(
    db,
    async (tx) => {
      const discovery = await setHistoryPlanControlTx(tx, {
        agencyId,
        creatorId,
        state: "PAUSED",
        reason,
        now,
      });
      const jobs = await tx.jobInstance.updateMany({
        where: {
          agencyId,
          creatorId,
          jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
          status: { in: ["SCHEDULED", "CLAIMED"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: now,
          lastError: null,
          result: { control: { kind: "paused", reason, at: now.toISOString() } },
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          workId: null,
          leaseRevision: { increment: 1 },
        },
      });
      const runs = await tx.dialogScanRun.updateMany({
        where: { agencyId, creatorId, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "PAUSED", pausedAt: now, lastError: null },
      });
      const states = await tx.dialogScanState.updateMany({
        where: {
          agencyId,
          creatorId,
          ...(discovery ? { generation: Number(discovery.generation || 0) } : {}),
          dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
          OR: [
            // IDLE inside the current frozen generation is a stranded legacy
            // state, not a terminal result. Pause must own it too or the UI can
            // report pending work while the control endpoint changes zero rows.
            { status: { in: ["IDLE", "PLANNED", "QUEUED", "RUNNING"] } },
            { activeRunId: { not: null } },
            { activeJobId: { not: null } },
          ],
        },
        // Keep activeRunId for an already claimed batch/discovery run so resume
        // can normalize it deterministically. Standalone PLANNED rows have no
        // activeRunId and are resumed directly back to PLANNED below.
        data: { status: "PAUSED", activeJobId: null, lastError: null },
      });
      return {
        paused: runs.count + states.count,
        pausedRuns: runs.count,
        pausedJobs: jobs.count,
        pausedStates: states.count,
        runs: [],
      };
    },
    DIALOG_CONTROL_TRANSACTION_OPTIONS
  );
}

async function resumeCreatorRuns({ agencyId, creatorId, db = prisma }) {
  let plannedJob = null;
  const result = await runDbTransaction(
    db,
    async (tx) => {
      const now = new Date();
      const selectedDiscovery = await tx.dialogScanRun.findFirst({
        where: { agencyId, creatorId, status: "PAUSED", dialogId: "__dialog_discovery__" },
        orderBy: [{ generation: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      });
      await setHistoryPlanControlTx(tx, { agencyId, creatorId, state: "ACTIVE", reason: "resumed by user", now });
      const keep = selectedDiscovery?.id || "";
      await tx.$executeRawUnsafe(
        `UPDATE "JobInstance" j SET "status"='CANCELLED',"completedAt"=$4,"lastError"='Returned to dialog batch plan',"claimedByDeviceId"=NULL,"claimedAt"=NULL,"leaseUntil"=NULL,"leaseTokenHash"=NULL,"workId"=NULL,"leaseRevision"=j."leaseRevision"+1 FROM "DialogScanRun" r WHERE r."agencyId"=$1 AND r."creatorId"=$2 AND r."status"='PAUSED' AND r."id"<>$3 AND j."id"=r."jobId" AND j."status" IN ('SCHEDULED','CLAIMED','FAILED')`,
        agencyId,
        creatorId,
        keep,
        now
      );
      const detached = await tx.$executeRawUnsafe(
        `UPDATE "DialogScanState" s SET "status"=CASE WHEN s."dialogId"='__dialog_discovery__' THEN 'IDLE' ELSE 'PLANNED' END,"activeRunId"=NULL,"activeJobId"=NULL,"lastError"=NULL FROM "DialogScanRun" r WHERE r."agencyId"=$1 AND r."creatorId"=$2 AND r."status"='PAUSED' AND r."id"<>$3 AND s."agencyId"=$1 AND s."creatorId"=$2 AND s."activeRunId"=r."id"`,
        agencyId,
        creatorId,
        keep
      );
      const normalized = await tx.dialogScanRun.updateMany({
        where: { agencyId, creatorId, status: "PAUSED", id: { not: keep } },
        data: { status: "CANCELLED", pausedAt: null, completedAt: now, lastError: "Returned to dialog batch plan" },
      });
      const standaloneHistory = await tx.dialogScanState.updateMany({
        where: {
          agencyId,
          creatorId,
          status: "PAUSED",
          dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
          activeRunId: null,
        },
        data: { status: "PLANNED", activeRunId: null, activeJobId: null, lastError: null },
      });
      if (!selectedDiscovery)
        return {
          resumed: standaloneHistory.count + Number(detached),
          resumedStates: standaloneHistory.count + Number(detached),
          normalized: normalized.count,
          items: [],
        };
      const oldJob = selectedDiscovery.jobId
        ? await tx.jobInstance.findUnique({ where: { id: selectedDiscovery.jobId } })
        : null;
      const job = await createPlannedJob({
        db: tx,
        publish: false,
        jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
        scope: "creator",
        creatorId: selectedDiscovery.creatorId,
        agencyId: selectedDiscovery.agencyId,
        idempotencyKey: `${DIALOG_INTELLIGENCE_JOB_KEY}:resume:${selectedDiscovery.id}:${Date.now()}`,
        params: {
          ...(oldJob?.params && typeof oldJob.params === "object" ? oldJob.params : {}),
          scanRunId: selectedDiscovery.id,
          dialogId: "__dialog_discovery__",
          mode: "discovery",
        },
        continuation: oldJob?.continuation || selectedDiscovery.continuation || null,
        progress: oldJob?.progress || selectedDiscovery.progress || null,
        priority: oldJob?.priority || 70,
        scheduledAt: now,
        nextRunAt: now,
      });
      plannedJob = job;
      await tx.dialogScanRun.update({
        where: { id: selectedDiscovery.id },
        data: { status: "QUEUED", jobId: job.id, pausedAt: null, completedAt: null, lastError: null },
      });
      await tx.dialogScanState.updateMany({
        where: { agencyId, creatorId, dialogId: "__dialog_discovery__" },
        data: { status: "QUEUED", activeJobId: job.id, activeRunId: selectedDiscovery.id, lastError: null },
      });

      return {
        resumed: 1 + standaloneHistory.count + Number(detached),
        resumedStates: standaloneHistory.count + Number(detached),
        normalized: normalized.count,
        items: [
          {
            runId: selectedDiscovery.id,
            jobId: job.id,
            dialogId: "__dialog_discovery__",
            generation: selectedDiscovery.generation,
          },
        ],
      };
    },
    DIALOG_CONTROL_TRANSACTION_OPTIONS
  );
  if (plannedJob) publishPlannedJobAvailable(plannedJob);
  return result;
}

async function cancelCreatorRuns({ agencyId, creatorId, reason = "cancelled by user", db = prisma }) {
  const now = new Date();
  const result = await runDbTransaction(
    db,
    async (tx) => {
      const discovery = await setHistoryPlanControlTx(tx, {
        agencyId: agencyId,
        creatorId: creatorId,
        state: "CANCELLED",
        reason,
        now,
      });
      // Scope-based updates are intentional. A creator can have more than 10k
      // planned dialog rows, and building a giant id list used to expire the
      // interactive transaction before its first update completed.
      const jobs = await tx.jobInstance.updateMany({
        where: {
          agencyId: agencyId,
          creatorId: creatorId,
          jobKey: DIALOG_INTELLIGENCE_JOB_KEY,
          status: { in: ["SCHEDULED", "CLAIMED"] },
        },
        data: {
          status: "CANCELLED",
          completedAt: now,
          lastError: null,
          result: { control: { kind: "cancelled", reason, at: now.toISOString() } },
          claimedByDeviceId: null,
          leaseUntil: null,
          leaseTokenHash: null,
          workId: null,
          leaseRevision: { increment: 1 },
        },
      });
      const runs = await tx.dialogScanRun.updateMany({
        where: {
          agencyId: agencyId,
          creatorId: creatorId,
          status: { in: ["QUEUED", "RUNNING", "PAUSED"] },
        },
        data: { status: "CANCELLED", canceledAt: now, completedAt: now, pausedAt: null, lastError: null },
      });
      const states = await tx.dialogScanState.updateMany({
        where: {
          agencyId: agencyId,
          creatorId: creatorId,
          ...(discovery ? { generation: Number(discovery.generation || 0) } : {}),
          dialogId: { notIn: ["__dialog_discovery__", DIALOG_HISTORY_BATCH_DIALOG_ID] },
          OR: [
            { status: { in: ["IDLE", "PLANNED", "QUEUED", "RUNNING", "PAUSED"] } },
            { activeRunId: { not: null } },
            { activeJobId: { not: null } },
          ],
        },
        data: { status: "IDLE", activeRunId: null, activeJobId: null, lastError: null },
      });
      return { canceled: runs.count, canceledJobs: jobs.count, resetStates: states.count };
    },
    DIALOG_CONTROL_TRANSACTION_OPTIONS
  );
  return { ok: true, ...result, runIds: [] };
}
async function cancelDialogRun({ db, agencyId, creatorId, dialogId, reason = "cancelled by user" }) {
  const row = await db.dialogScanRun.findFirst({
    where: { agencyId, creatorId, dialogId, status: { in: ["QUEUED", "RUNNING", "PAUSED"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!row) return { canceled: false };
  const now = new Date();
  if (row.jobId)
    await db.jobInstance.updateMany({
      where: { id: row.jobId, agencyId, creatorId, status: { in: ["SCHEDULED", "CLAIMED", "FAILED"] } },
      data: {
        status: "CANCELLED",
        completedAt: now,
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        workId: null,
        leaseRevision: { increment: 1 },
        result: { control: { kind: "cancelled", reason, at: now.toISOString() } },
      },
    });
  await db.dialogScanRun.update({
    where: { id: row.id },
    data: { status: "CANCELLED", canceledAt: now, completedAt: now, lastError: null },
  });
  await db.dialogScanState.updateMany({
    where: { agencyId, creatorId, dialogId, activeRunId: row.id },
    data: { status: "IDLE", activeRunId: null, activeJobId: null, lastError: null },
  });
  return { canceled: true, runId: row.id };
}
module.exports = { pauseCreatorRuns, resumeCreatorRuns, cancelCreatorRuns, cancelDialogRun };
