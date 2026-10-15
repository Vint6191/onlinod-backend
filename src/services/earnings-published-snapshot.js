"use strict";

// The collector owns mutable candidate rows; only a committed money proof may
// replace this read model. The replacement shares the proof's transaction.
const DAY = 86_400_000;
function hourlyPoints(payload, from, to) {
  if (payload.hourlyPoints == null) return null;
  const points = payload.hourlyPoints;
  const day = from.toISOString().slice(0, 10);
  if (+from !== +to || !Array.isArray(points) || points.length < 1 || points.length > 24) throw new Error("EARNINGS_HOURLY_POINTS_INVALID");
  let previous = "", sum = 0;
  for (const point of points) {
    if (!point || !new RegExp(`^${day}T(?:[01]\\d|2[0-3]):00:00\\.000Z$`).test(point.label)
      || point.label <= previous || !Number.isSafeInteger(point.valueCents) || point.valueCents < 0) throw new Error("EARNINGS_HOURLY_POINTS_INVALID");
    previous = point.label; sum += point.valueCents;
  }
  if (!Number.isSafeInteger(sum) || sum !== payload.summary?.totalCents) throw new Error("EARNINGS_HOURLY_TOTAL_MISMATCH");
  return points.map(({ label, valueCents }) => ({ label, valueCents }));
}

async function publishEarningsSnapshot({ db, job, scanProofId, scanRunId, from, to, payload }) {
  const days = (+to - +from) / DAY + 1;
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("EARNINGS_PUBLICATION_WINDOW_TOO_LARGE");
  const hourly = hourlyPoints(payload, from, to);
  return db.$executeRawUnsafe(`/* earnings_verified_snapshot_v1 */
    INSERT INTO "CreatorEarningsPublishedDay" AS target
      ("id","agencyId","creatorId","date","sourceTimezone","subscriptionsCents","messagesCents","tipsCents","postsCents",
       "streamsCents","referralsCents","totalCents","currency","sourceUpdatedAt","sourceScanRunId","sourceScanRequestedAt",
       "scanProofId","collectedAt","createdAt","updatedAt","coverageStatus","lastVerifiedAt","hourlyPoints")
    SELECT d."id",d."agencyId",d."creatorId",d."date",d."sourceTimezone",d."subscriptionsCents",d."messagesCents",d."tipsCents",d."postsCents",
       d."streamsCents",d."referralsCents",d."totalCents",d."currency",d."sourceUpdatedAt",d."sourceScanRunId",d."sourceScanRequestedAt",
       p."id",d."collectedAt",d."createdAt",clock_timestamp(),
       CASE WHEN d."date" < COALESCE(p."observationStartedAt",p."requestedAt")::date THEN 'COMPLETE' ELSE 'PARTIAL' END,
       COALESCE(p."observationStartedAt",p."requestedAt"),$7::jsonb
    FROM "CreatorEarningsDaily" d JOIN "AnalyticsScanProof" p ON p."id"=$4 AND p."agencyId"=d."agencyId" AND p."creatorId"=d."creatorId"
      AND p."scanRunId"=d."sourceScanRunId" AND p."sourceTimezone"='UTC' AND p."dataType"='EARNINGS'
      AND p."status"='COMMITTED' AND p."proofVersion"=2 AND p."committedAt" IS NOT NULL
    WHERE d."agencyId"=$1 AND d."creatorId"=$2 AND d."sourceScanRunId"=$3 AND d."sourceTimezone"='UTC'
      AND d."date" BETWEEN ($5::timestamptz AT TIME ZONE 'UTC')::date AND ($6::timestamptz AT TIME ZONE 'UTC')::date
      AND d."date" BETWEEN p."scanFrom" AND p."scanTo" AND d."scanProofId"=p."id"
    ORDER BY d."date"
    ON CONFLICT ("creatorId","date","sourceTimezone") DO UPDATE SET
      "subscriptionsCents"=EXCLUDED."subscriptionsCents","messagesCents"=EXCLUDED."messagesCents","tipsCents"=EXCLUDED."tipsCents",
      "postsCents"=EXCLUDED."postsCents","streamsCents"=EXCLUDED."streamsCents","referralsCents"=EXCLUDED."referralsCents",
      "totalCents"=EXCLUDED."totalCents","currency"=EXCLUDED."currency","sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt",
      "sourceScanRunId"=EXCLUDED."sourceScanRunId","sourceScanRequestedAt"=EXCLUDED."sourceScanRequestedAt",
      "scanProofId"=EXCLUDED."scanProofId","collectedAt"=EXCLUDED."collectedAt","updatedAt"=EXCLUDED."updatedAt",
      "coverageStatus"=EXCLUDED."coverageStatus","lastVerifiedAt"=EXCLUDED."lastVerifiedAt","hourlyPoints"=EXCLUDED."hourlyPoints"
    WHERE target."agencyId"=EXCLUDED."agencyId" AND
      (target."sourceScanRequestedAt" IS NULL OR target."sourceScanRequestedAt"<=EXCLUDED."sourceScanRequestedAt")`,
    job.agencyId, job.creatorId, scanRunId, scanProofId, from, to, hourly ? JSON.stringify(hourly) : null);
}

module.exports = { publishEarningsSnapshot, hourlyPoints };
