"use strict";
const { runRootCommit } = require("./db-commit-kernel");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { lockAgencyLifecycle } = require("./management-commit-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { resumeCreatorRuns } = require("./dialog-scan-control-service");
async function configure({ db, agencyId, enabled, settings }) {
  const setting = await db.moduleSetting.upsert({
    where: { agencyId_moduleKey: { agencyId, moduleKey: "dialog_intelligence" } },
    create: {
      agencyId,
      moduleKey: "dialog_intelligence",
      enabled,
      status: enabled ? "active" : "disabled",
      config: settings || {},
    },
    update: { enabled, status: enabled ? "active" : "disabled", ...(settings ? { config: settings } : {}) },
  });
  if (!enabled) {
    const now = await dbAuthorityNow({ db });
    await db.jobInstance.updateMany({
      where: { agencyId, jobKey: "dialog_intelligence_scan", status: { in: ["SCHEDULED", "CLAIMED"] } },
      data: {
        status: "CANCELLED",
        completedAt: now,
        claimedByDeviceId: null,
        leaseUntil: null,
        leaseTokenHash: null,
        workId: null,
        leaseRevision: { increment: 1 },
        result: { control: { kind: "module_disabled", at: now.toISOString() } },
      },
    });
    await db.dialogScanRun.updateMany({
      where: { agencyId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "PAUSED", pausedAt: now },
    });
    await db.dialogScanState.updateMany({
      where: {
        agencyId,
        status: { in: ["IDLE", "PLANNED", "QUEUED", "RUNNING"] },
        dialogId: { not: "__dialog_discovery__" },
      },
      data: { status: "PAUSED", activeJobId: null },
    });
    return { action: "disabled" };
  }
  // Desired module state and resume demands commit together. No 10k cap, no
  // post-response loop whose progress is forgotten on process restart.
  const count = await db.$executeRawUnsafe(
    `INSERT INTO "DialogControlResumeDemand" ("id","agencyId","creatorId","moduleUpdatedAt","creatorControlRevision","status","updatedAt")
 SELECT md5($1||':'||x."creatorId"||':'||$2::text),$1,x."creatorId",$2,COALESCE((SELECT SUM(v."revision") FROM "OperationalControlState" v WHERE v."agencyId"=$1 AND v."creatorId"=x."creatorId" AND v."family" IN ('dialog','dialog_single')),0),'PENDING',CURRENT_TIMESTAMP
 FROM (SELECT DISTINCT "creatorId" FROM "DialogScanRun" WHERE "agencyId"=$1 AND "status"='PAUSED'
 UNION SELECT DISTINCT "creatorId" FROM "DialogScanState" WHERE "agencyId"=$1 AND "status"='PAUSED') x
 WHERE NOT EXISTS (SELECT 1 FROM "OperationalControlState" v WHERE v."agencyId"=$1 AND v."creatorId"=x."creatorId" AND v."family"='dialog' AND v."lastOperation" IN ('pause','cancel'))
 AND COALESCE((SELECT r."continuation"->'historyControl'->>'state' FROM "DialogScanRun" r WHERE r."agencyId"=$1 AND r."creatorId"=x."creatorId" AND r."dialogId"='__dialog_discovery__' ORDER BY r."createdAt" DESC,r."id" DESC LIMIT 1),'ACTIVE') NOT IN ('PAUSED','CANCELLED')
 ON CONFLICT ("id") DO NOTHING`,
    agencyId,
    setting.updatedAt
  );
  return { action: "enabled", requested: Number(count) };
}
async function resumeDemand({ db, id }) {
  return runRootCommit(
    db,
    async ({ tx }) => {
      const observed = await tx.dialogControlResumeDemand.findUnique({ where: { id } });
      if (!observed || observed.status !== "PENDING") return false;
      await lockAgencyLifecycle({ tx, agencyId: observed.agencyId });
      await lockDbAdvisoryXact({ db: tx, key: `dialog-module:${observed.agencyId}` });
      const [row] = await tx.$queryRawUnsafe('SELECT * FROM "DialogControlResumeDemand" WHERE "id"=$1 FOR UPDATE', id);
      if (!row || row.status !== "PENDING") return false;
      const now = await dbAuthorityNow({ db: tx });
      if (new Date(row.nextAttemptAt) > now) return false;
      const [creator] = await tx.$queryRawUnsafe(
        'SELECT "id","deletedAt" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 FOR UPDATE',
        row.creatorId,
        row.agencyId
      );
      const setting = await tx.moduleSetting.findUnique({
        where: { agencyId_moduleKey: { agencyId: row.agencyId, moduleKey: "dialog_intelligence" } },
      });
      const controls = await tx.operationalControlState.aggregate({
        where: { agencyId: row.agencyId, creatorId: row.creatorId, family: { in: ["dialog", "dialog_single"] } },
        _sum: { revision: true },
      });
      if (
        (controls._sum.revision || 0) !== row.creatorControlRevision ||
        !creator ||
        creator.deletedAt ||
        !setting?.enabled ||
        setting.updatedAt.getTime() !== new Date(row.moduleUpdatedAt).getTime()
      ) {
        await tx.dialogControlResumeDemand.update({ where: { id }, data: { status: "SUPERSEDED" } });
        return false;
      }
      await resumeCreatorRuns({ db: tx, agencyId: row.agencyId, creatorId: row.creatorId });
      await tx.dialogControlResumeDemand.update({
        where: { id },
        data: { status: "COMPLETED", attempts: { increment: 1 } },
      });
      return true;
    },
    { profile: "SECRET_WRITE", maxAttempts: 1 }
  );
}
function startDialogControlWorker({ db, intervalMs = 10000 }) {
  let stopped = false,
    flight = null;
  const drain = () => {
    if (stopped || flight) return;
    flight = (async () => {
      const rows = await db.dialogControlResumeDemand.findMany({
        where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        take: 20,
        select: { id: true },
      });
      for (const { id } of rows) {
        if (stopped) break;
        try {
          await resumeDemand({ db, id });
        } catch {
          await db.dialogControlResumeDemand.updateMany({
            where: { id, status: "PENDING" },
            data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 30000) },
          });
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        flight = null;
      });
  };
  const timer = setInterval(drain, intervalMs);
  timer.unref?.();
  drain();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await flight;
  };
}
module.exports = { configure, resumeDemand, startDialogControlWorker };
