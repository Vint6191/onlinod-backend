"use strict";

const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const ACTIVE_STATUSES = ["SCHEDULED", "PUBLISHING", "CLAIMED", "PAUSED"];

// Trigger provenance does not create a separate collector. START, STOP and the
// operational reader must select the same job, including an automatic run that
// a manual START adopted. Completed manual history is a separate presentation.
async function activeCollectorJob(db, creatorId, jobKey) {
  const rows = await db.jobInstance.findMany({
    where: { creatorId, jobKey, status: { in: ACTIVE_STATUSES } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 1,
  });
  return rows.find(row => ACTIVE_STATUSES.includes(row.status)) || null;
}

async function pauseCollectorJob({ db, creatorId, jobKey, collectorType, now = new Date() }) {
  // STOP mutates only the leased job and its observation lease. It neither
  // plans nor publishes collector state. Taking the collector lock here made
  // STOP wait for Job while a progress/publication transaction held Job and
  // waited for Collector. The job status+revision CAS is the STOP authority.
  return runDbTransaction(db, async tx => {
    const active = await activeCollectorJob(tx, creatorId, jobKey);
    if (!active) return { job: null, action: "idle" };
    if (active.status === "PUBLISHING") return { job: active, action: "publishing" };
    if (active.status === "PAUSED") return { job: active, action: "already_paused" };
    const authorityNow = await dbAuthorityNow({ db: tx, fallbackNow: now });
    const result = await tx.jobInstance.updateMany({
      where: { id: active.id, status: { in: ["SCHEDULED", "CLAIMED"] }, leaseRevision: active.leaseRevision },
      data: {
        status: "PAUSED", claimedAt: null, claimedByDeviceId: null, leaseUntil: null,
        leaseTokenHash: null, leaseRevision: { increment: 1 }, workId: null,
        completedAt: null, lastError: null, lastProgressAt: active.lastProgressAt || authorityNow,
      },
    });
    if (result.count && active.status === "CLAIMED" && active.claimedByDeviceId
      && typeof tx.fanObservationReadLease?.deleteMany === "function") {
      await tx.fanObservationReadLease.deleteMany({ where: {
        creatorId, jobId: active.id, deviceId: active.claimedByDeviceId, leaseRevision: active.leaseRevision,
      } });
    }
    const current = await tx.jobInstance.findUnique({ where: { id: active.id } });
    return { job: current, action: result.count ? "paused" : current?.status === "PAUSED" ? "already_paused" : "changed" };
  });
}

module.exports = { activeCollectorJob, pauseCollectorJob };
