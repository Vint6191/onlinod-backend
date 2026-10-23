"use strict";

const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { pauseDeletedAgencyProjection } = require("./analytics-projection-lifecycle-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { scheduleOfflineDialogRecovery, shouldPreserveRealtimeCoverage } = require("./dialog-offline-recovery-service");

const WORK_CLASS = "DIALOG_OFFLINE_RECOVERY";

// A heartbeat records a durable request; it never plans each creator inline.
// One request per creator coalesces multiple devices and survives process death.
async function enqueue({ db, agencyId, candidates, bindings, now }) {
  const accounts = new Map(bindings.map(x => [x.creatorId, x.account]));
  let queued = 0;
  for (let start = 0; start < candidates.length; start += 500) {
    const rows = candidates.slice(start, start + 500).map(x => ({
      creatorId: x.creatorId,
      lastCoveredAt: x.lastCoveredAt,
      sampleAt: accounts.get(x.creatorId)?.lastWsFrameAt,
    })).filter(x => x.sampleAt).sort((a, b) => a.creatorId.localeCompare(b.creatorId));
    if (!rows.length) continue;
    const requests = await db.$queryRawUnsafe(`
      INSERT INTO "CreatorDialogRecoveryRequest"("creatorId","agencyId","lastCoveredAt","sampleAt","nextCheckAt",queued)
      SELECT x."creatorId",$1,x."lastCoveredAt",x."sampleAt",$3,true
      FROM jsonb_to_recordset($2::jsonb) x("creatorId" text,"lastCoveredAt" timestamp,"sampleAt" timestamp)
      ORDER BY x."creatorId"
      ON CONFLICT("creatorId") DO UPDATE SET
        "lastCoveredAt"=EXCLUDED."lastCoveredAt","sampleAt"=EXCLUDED."sampleAt",queued=true
      WHERE NOT "CreatorDialogRecoveryRequest".queued AND "CreatorDialogRecoveryRequest"."nextCheckAt"<=$3
      RETURNING "creatorId"`, agencyId, JSON.stringify(rows), now);
    if (requests.length) {
      await work.publishDomainWorkBatch({ db, items: requests.map(x => ({
        agencyId, creatorId: x.creatorId, workClass: WORK_CLASS,
        objectType: "CreatorAccount", objectId: x.creatorId, partitionKey: x.creatorId,
      })) });
      queued += requests.length;
    }
  }
  return { ok: true, queued, reason: "recovery_check_queued" };
}

function assertOwned(result) {
  if (!result || result.lost) throw Object.assign(new Error("DIALOG_RECOVERY_CLAIM_LOST"), { code: "DIALOG_RECOVERY_CLAIM_LOST" });
}

async function processRequest({ db, item, ownerToken, schedule = null }) {
  if (item.workClass !== WORK_CLASS || item.creatorId !== item.objectId) throw Error("DIALOG_RECOVERY_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    // Producers lock the request before publishing work. Taking the same order
    // avoids a heartbeat/worker deadlock, and SKIP LOCKED lets other creators run.
    const [request] = await tx.$queryRawUnsafe(`SELECT * FROM "CreatorDialogRecoveryRequest"
      WHERE "agencyId"=$1 AND "creatorId"=$2 FOR UPDATE SKIP LOCKED`, item.agencyId, item.creatorId);
    assertOwned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true };
    if (!request) {
      const exists = await tx.$queryRawUnsafe(`SELECT 1 FROM "CreatorDialogRecoveryRequest" WHERE "agencyId"=$1 AND "creatorId"=$2`, item.agencyId, item.creatorId);
      if (exists.length) assertOwned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken }));
      else assertOwned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
      return { waiting: exists.length > 0 };
    }
    if (!request.queued) {
      assertOwned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
      return { created: false };
    }
    const current = await tx.teamObservationState.findUnique({
      where: { agencyId_creatorId: { agencyId: item.agencyId, creatorId: item.creatorId } },
      select: { lastRealtimeEventAt: true },
    });
    const decision = await scheduleOfflineDialogRecovery({
      db: tx, agencyId: item.agencyId, creatorId: item.creatorId,
      lastCoveredAt: current?.lastRealtimeEventAt || request.lastCoveredAt,
      now: request.sampleAt,
      schedule: schedule || (input => require("./dialog-intelligence-service").restartCreatorDialogPlanTx(tx, input)),
    });
    const now = await dbAuthorityNow({ db: tx });
    const preserve = shouldPreserveRealtimeCoverage(decision);
    if (!preserve) {
      await tx.$executeRawUnsafe(`UPDATE "TeamObservationState" SET
        "lastRealtimeEventAt"=CASE WHEN "lastRealtimeEventAt">$4::timestamp+interval '30 seconds' THEN $3
          ELSE GREATEST("lastRealtimeEventAt",$3) END
        WHERE "agencyId"=$1 AND "creatorId"=$2`, item.agencyId, item.creatorId, request.sampleAt, now);
    }
    // No provider polling timer. Unresolved coverage is checked again only on a
    // later healthy heartbeat; paused/missing baselines get a longer DB backoff.
    const delay = ["baseline_missing", "history_paused", "history_cancelled", "module_disabled", "recovery_stopped"].includes(decision.reason) ? 300000 : 60000;
    await tx.$executeRawUnsafe(`UPDATE "CreatorDialogRecoveryRequest" SET queued=false,"nextCheckAt"=$3,reason=$4
      WHERE "agencyId"=$1 AND "creatorId"=$2`, item.agencyId, item.creatorId, new Date(+now + delay), decision.reason || null);
    assertOwned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
    return { created: decision.created === true, reason: decision.reason, coverageReleased: !preserve };
  }, { profile: "JOB_CHUNK", authority: { kind: WORK_CLASS, agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function runSweep({ db = require("../prisma"), limit = 16, concurrency = 4, maxRuntimeMs = 5000 } = {}) {
  const report = { ok: true, processed: 0, created: 0, failed: 0 }, start = performance.now();
  let reserved = 0;
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, concurrency)) }, async () => {
    while (reserved < Math.min(64, limit) && performance.now() - start < maxRuntimeMs) {
      reserved++;
      const claim = await work.claimDomainWorkBatch({ db, workClass: WORK_CLASS, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
      const item = claim.items?.[0];
      if (!item) break;
      try {
        const result = await processRequest({ db, item, ownerToken: claim.ownerToken });
        report.processed++;
        report.created += result.created ? 1 : 0;
      } catch (error) {
        report.ok = false; report.failed++;
        await work.failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error });
      }
    }
  }));
  return report;
}

module.exports = { WORK_CLASS, enqueue, processRequest, runSweep };
