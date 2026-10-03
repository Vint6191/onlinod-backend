"use strict";

const { COLLECTION_FUTURE_SKEW_TOLERANCE_MS } = require("./analytics-freshness-policy");
const { signalCampaignFanRefreshPromotion } = require("./campaign-fan-refresh-queue-service");
const MAX_FANS = 100;

// Called inside the projection root commit, after acquiring Campaign authority.
// Internal fan ids are re-resolved against current membership and canonical
// value facts. No payload money/timestamp, run id or historical work is trusted.
async function requestExpiredCampaignValues({ tx, agencyId, creatorId, fanIds, now, freshnessMs }) {
  const ids = [...new Set(fanIds || [])].sort();
  if (!ids.length) return { requested: 0 };
  if (!agencyId || !creatorId || ids.length > MAX_FANS || !Number.isFinite(+now)
    || !Number.isSafeInteger(freshnessMs) || freshnessMs < 60_000) throw new Error("CAMPAIGN_VALUE_REFRESH_SCOPE_INVALID");
  // Demand cutoffs are inclusive, whereas the live TTL expires at equality.
  const cutoff = new Date(+now - freshnessMs + 1);
  const ceiling = new Date(+now + COLLECTION_FUTURE_SKEW_TOLERANCE_MS);
  const rows = await tx.$queryRawUnsafe(`
    WITH candidates AS MATERIALIZED (
      SELECT f."onlyFansUserId" FROM unnest($3::text[]) input(id)
      JOIN "CreatorFan" f ON f."id"=input.id AND f."agencyId"=$1 AND f."creatorId"=$2
      LEFT JOIN "CreatorFanValueCurrent" v ON v."agencyId"=$1 AND v."creatorId"=$2 AND v."fanId"=f."id"
      WHERE EXISTS(SELECT 1 FROM "CreatorCampaignFan" m WHERE m."agencyId"=$1 AND m."creatorId"=$2 AND m."fanId"=f."id")
        AND (v."fetchedAt" IS NULL OR v."fetchedAt"<"phase3_utc_timestamp"($4::timestamptz)
          OR v."fetchedAt">"phase3_utc_timestamp"($6::timestamptz))
    )
    INSERT INTO "CreatorFanRefreshDemand" AS d
      ("id","agencyId","creatorId","onlyFansUserId","requestedFreshnessCutoffAt","requestedRevision",
       "satisfiedRevision","status","lastRequestedAt","createdAt","updatedAt")
    SELECT 'cvd_'||md5(jsonb_build_array($2::text,c."onlyFansUserId")::text),$1,$2,c."onlyFansUserId",
      "phase3_utc_timestamp"($4::timestamptz),1,0,'QUEUED',"phase3_utc_timestamp"($5::timestamptz),
      "phase3_utc_timestamp"($5::timestamptz),"phase3_utc_timestamp"($5::timestamptz)
    FROM candidates c ORDER BY c."onlyFansUserId"
    ON CONFLICT("creatorId","onlyFansUserId") DO UPDATE SET
      "requestedFreshnessCutoffAt"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."requestedFreshnessCutoffAt" ELSE GREATEST(d."requestedFreshnessCutoffAt",EXCLUDED."requestedFreshnessCutoffAt") END,
      "requestedRevision"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."requestedRevision" ELSE d."requestedRevision"+1 END,
      "status"=CASE WHEN d."status"='FAILED' THEN d."status" ELSE 'QUEUED' END,
      "activeRefreshJobId"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."activeRefreshJobId" ELSE NULL END,
      "activeRefreshRevision"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."activeRefreshRevision" ELSE NULL END,
      "retryAttempts"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."retryAttempts" ELSE 0 END,
      "nextRetryAt"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."nextRetryAt" ELSE NULL END,
      "quarantinedAt"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."quarantinedAt" ELSE NULL END,
      "lastError"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."lastError" ELSE NULL END,
      "lastRequestedAt"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."lastRequestedAt" ELSE EXCLUDED."lastRequestedAt" END,
      "updatedAt"=CASE WHEN d."status" IN ('QUEUED','FAILED') THEN d."updatedAt" ELSE EXCLUDED."updatedAt" END
    RETURNING "status","activeRefreshJobId","nextRetryAt","quarantinedAt"
  `, agencyId, creatorId, ids, cutoff, now, ceiling);
  const dates = rows.flatMap(row => row.activeRefreshJobId ? []
    : row.status === "QUEUED" ? [+now]
    : !row.quarantinedAt && row.nextRetryAt ? [Math.max(+now, +new Date(row.nextRetryAt))] : []);
  if (dates.length) await signalCampaignFanRefreshPromotion({
    db: tx, agencyId, creatorId, dueAt: new Date(Math.min(...dates)), reason: "CAMPAIGN_VALUE_EXPIRED",
  });
  return { requested: rows.length, signaled: dates.length > 0 };
}
module.exports = { MAX_FANS, requestExpiredCampaignValues };
