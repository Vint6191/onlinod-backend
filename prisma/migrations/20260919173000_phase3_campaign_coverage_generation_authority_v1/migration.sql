-- Phase 3 A20.2: make current Campaign FanData coverage ownership durable.
ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "fanValueCoverageDelegated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "fanValueCoverageOwnerKind" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "fanValueCoverageCollectorVersion" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "fanValueCoverageSourceJobId" TEXT;

-- Rolling-upgrade backfill from the durable source JobInstance when available.
-- Old rows remain fail-closed (delegated=false) unless their persisted job params
-- explicitly prove the server-side Campaign freshness coverage contract.
UPDATE "CreatorCampaignCollectionState" s
SET "fanValueCoverageDelegated" = CASE
      WHEN COALESCE(j."params"->>'campaignFreshnessCoverageVersion', '') ~ '^[0-9]+$'
       AND (j."params"->>'campaignFreshnessCoverageVersion')::int >= 1 THEN true
      ELSE s."fanValueCoverageDelegated"
    END,
    "fanValueCoverageOwnerKind" = COALESCE(
      s."fanValueCoverageOwnerKind",
      CASE WHEN j."params"->>'manualCampaignScan' = 'true' THEN 'MANUAL' ELSE 'AUTOMATIC' END
    ),
    "fanValueCoverageCollectorVersion" = COALESCE(
      s."fanValueCoverageCollectorVersion",
      j."continuation"->'jobContinuation'->>'collectorVersion',
      j."continuation"->>'collectorVersion',
      j."result"->>'collectorVersion'
    ),
    "fanValueCoverageSourceJobId" = COALESCE(s."fanValueCoverageSourceJobId", s."sourceJobId")
FROM "JobInstance" j
WHERE s."sourceJobId" = j."id"
  AND s."fanValueCoverageScanRunId" IS NOT NULL;

-- If state.sourceJobId predates the coverage cutover, Campaign work itself is
-- exact durable proof that this coverage generation delegated FanData.
WITH coverage_job AS (
  SELECT DISTINCT ON (w."creatorId", w."scanRunId")
    w."creatorId", w."scanRunId", w."campaignJobId", j."params", j."continuation", j."result"
  FROM "CreatorCampaignFanRefreshWork" w
  JOIN "JobInstance" j ON j."id" = w."campaignJobId"
  ORDER BY w."creatorId", w."scanRunId", w."id"
)
UPDATE "CreatorCampaignCollectionState" s
SET "fanValueCoverageDelegated" = true,
    "fanValueCoverageOwnerKind" = COALESCE(
      s."fanValueCoverageOwnerKind",
      CASE WHEN coverage_job."params"->>'manualCampaignScan' = 'true' THEN 'MANUAL' ELSE 'AUTOMATIC' END
    ),
    "fanValueCoverageCollectorVersion" = COALESCE(
      s."fanValueCoverageCollectorVersion",
      coverage_job."continuation"->'jobContinuation'->>'collectorVersion',
      coverage_job."continuation"->>'collectorVersion',
      coverage_job."result"->>'collectorVersion'
    ),
    "fanValueCoverageSourceJobId" = COALESCE(s."fanValueCoverageSourceJobId", coverage_job."campaignJobId")
FROM coverage_job
WHERE s."creatorId" = coverage_job."creatorId"
  AND s."fanValueCoverageScanRunId" = coverage_job."scanRunId";
