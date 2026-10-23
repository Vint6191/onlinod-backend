"use strict";
const { createHash } = require("node:crypto");
const date = value => value && Number.isFinite(+new Date(value)) ? new Date(value) : null;

function episode({ agencyId, creatorId, gapFrom, targetAt, sourceIntentId = null }) {
  const from = date(gapFrom), target = date(targetAt);
  if (!from || !target || target <= from) return null;
  return { version: 1, id: createHash("sha256").update(JSON.stringify([agencyId, creatorId, from.toISOString(), target.toISOString()])).digest("hex"),
    gapFrom: from.toISOString(), targetAt: target.toISOString(), ...(sourceIntentId ? { sourceIntentId } : {}) };
}

// TeamObservationState is a display/heartbeat clock, not acquisition proof.
// Only an already-durable newer loss episode from the capture authority can
// release a failed dialog recovery. Reconnect, status polling and elapsed time
// cannot allocate another retry budget for the same gap.
async function independentEpisode(db, { agencyId, creatorId, failedRun, now = new Date() }) {
  if (!failedRun?.jobId || typeof db.jobInstance?.findUnique !== "function" || typeof db.$queryRawUnsafe !== "function") return null;
  const prior = await db.jobInstance.findUnique({ where: { id: failedRun.jobId }, select: { id: true, agencyId: true, creatorId: true, params: true, createdAt: true } });
  if (!prior || prior.agencyId !== agencyId || prior.creatorId !== creatorId) return null;
  const target = date(prior.params?.dialogRecoveryEpisode?.targetAt) || date(prior.createdAt) || date(failedRun.createdAt);
  if (!target) return null;
  const [intent] = await db.$queryRawUnsafe(`SELECT i.id,i."gapFrom",i."targetAt" FROM "CreatorRecoveryIntent" i
    JOIN "CreatorLiveSync" live ON live."creatorId"=i."creatorId" AND live."agencyId"=i."agencyId"
    WHERE i."creatorId"=$1 AND i."agencyId"=$2 AND i."targetAt">$3::timestamp AND i."gapFrom">$3::timestamp
      AND i."targetAt"<=$4::timestamp AND i.reason IN ('OFFLINE_GAP','CAPTURE_LOSS')
      AND (i.reason='CAPTURE_LOSS' OR i."targetAt"-i."gapFrom">=interval '1 hour')
      AND live."lastCapturedAt">=i."gapFrom"
    ORDER BY i."targetAt" DESC,i.id DESC LIMIT 1`, creatorId, agencyId, target.toISOString(), new Date(+new Date(now) + 30000).toISOString());
  return intent ? episode({ agencyId, creatorId, gapFrom: intent.gapFrom, targetAt: intent.targetAt, sourceIntentId: intent.id }) : null;
}

module.exports = { episode, independentEpisode };
