-- Campaign collection-state migration sanitation.
--
-- Historical AnalyticsCoverage(CAMPAIGNS) rows predate the specialized
-- CreatorCampaignCollectionState contract. They could be produced by either a
-- FULL traversal or a bounded CATCHUP traversal, so a generic COMPLETE coverage
-- row is not, by itself, proof of a full historical baseline.
--
-- Historical catchup JobInstance=DONE is also insufficient: the old client-clock
-- generation fence could mark an older run superseded when a newer generation
-- had merely started ingesting. A superseded run returned successful execution
-- without publishing its own COMPLETE campaign coverage row.
--
-- Re-prove migrated FULL/CATCHUP state from the linked completion batch,
-- coverage row, exact source job/run, source completion counters and mode. Any
-- ambiguous migrated proof is cleared fail-closed and the current planner will
-- collect it again under the server-owned generation contract.

WITH "MigratedCampaignBaseline" AS (
  SELECT
    s."creatorId",
    s."agencyId",
    s."baselineGeneration",
    split_part(s."baselineGeneration", ':', 2) AS "coverageId",
    c."id" AS "resolvedCoverageId",
    c."agencyId" AS "coverageAgencyId",
    c."creatorId" AS "coverageCreatorId",
    c."dataType" AS "coverageDataType",
    c."status" AS "coverageStatus",
    c."ingestBatchId",
    b."id" AS "batchId",
    b."agencyId" AS "batchAgencyId",
    b."creatorId" AS "batchCreatorId",
    b."sourceJobId" AS "batchSourceJobId",
    b."idempotencyKey",
    b."dataType" AS "batchDataType",
    b."status" AS "batchStatus",
    b."rejectedRows",
    b."completedAt" AS "batchCompletedAt",
    j."id" AS "resolvedJobId",
    j."agencyId" AS "jobAgencyId",
    j."creatorId" AS "jobCreatorId",
    j."jobKey",
    j."status" AS "jobStatus",
    j."params" AS "jobParams",
    j."result" AS "jobResult",
    NULLIF(j."result"->>'scanRunId', '') AS "scanRunId"
  FROM "CreatorCampaignCollectionState" s
  LEFT JOIN "AnalyticsCoverage" c
    ON c."id" = split_part(s."baselineGeneration", ':', 2)
  LEFT JOIN "AnalyticsIngestBatch" b
    ON b."id" = c."ingestBatchId"
  LEFT JOIN "JobInstance" j
    ON j."id" = b."sourceJobId"
  WHERE s."baselineGeneration" LIKE 'MIGRATED_COVERAGE:%'
),
"InvalidMigratedCampaignBaseline" AS (
  SELECT b."creatorId"
  FROM "MigratedCampaignBaseline" b
  WHERE NOT COALESCE((
    b."resolvedCoverageId" IS NOT NULL
    AND b."coverageAgencyId" = b."agencyId"
    AND b."coverageCreatorId" = b."creatorId"
    AND b."coverageDataType" = 'CAMPAIGNS'::"AnalyticsDataType"
    AND b."coverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
    AND b."batchId" IS NOT NULL
    AND b."batchAgencyId" = b."agencyId"
    AND b."batchCreatorId" = b."creatorId"
    AND b."batchDataType" = 'CAMPAIGNS'::"AnalyticsDataType"
    AND b."batchStatus" = 'COMMITTED'::"AnalyticsIngestStatus"
    AND b."batchCompletedAt" IS NOT NULL
    AND b."rejectedRows" = 0
    AND b."resolvedJobId" IS NOT NULL
    AND b."batchSourceJobId" = b."resolvedJobId"
    AND b."jobAgencyId" = b."agencyId"
    AND b."jobCreatorId" = b."creatorId"
    AND b."jobKey" = 'fetch_campaigns'
    AND b."jobStatus" = 'DONE'
    AND COALESCE(b."jobResult"->>'campaignMode', b."jobParams"->>'campaignMode', 'full') <> 'catchup'
    AND b."jobResult"->>'campaignPagesComplete' = 'true'
    AND b."jobResult"->>'claimersComplete' = 'true'
    AND b."jobResult"->>'fanValuesComplete' = 'true'
    AND b."jobResult"->>'truncated' = 'false'
    AND b."scanRunId" IS NOT NULL
    AND b."idempotencyKey" = 'campaigns:' || b."resolvedJobId" || ':run:' || b."scanRunId" || ':completion:v7'
  ), FALSE)
)
UPDATE "CreatorCampaignCollectionState" s
SET "baselineVerifiedAt" = NULL,
    "baselineGeneration" = NULL,
    "sourceJobId" = CASE
      WHEN s."sourceJobId" IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM "AnalyticsCoverage" c
         JOIN "AnalyticsIngestBatch" b ON b."id" = c."ingestBatchId"
         WHERE c."id" = split_part(s."baselineGeneration", ':', 2)
           AND b."sourceJobId" = s."sourceJobId"
       )
      THEN NULL
      ELSE s."sourceJobId"
    END,
    "status" = CASE
      WHEN s."activeGeneration" IS NULL
       AND s."status" IN ('COMPLETE'::"AnalyticsCoverageStatus", 'PARTIAL'::"AnalyticsCoverageStatus")
      THEN 'MISSING'::"AnalyticsCoverageStatus"
      ELSE s."status"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "InvalidMigratedCampaignBaseline" invalid
WHERE invalid."creatorId" = s."creatorId"
  AND s."baselineGeneration" LIKE 'MIGRATED_COVERAGE:%';

WITH "MigratedCampaignCatchup" AS (
  SELECT
    s."creatorId",
    s."agencyId",
    s."lastCatchupGeneration",
    split_part(s."lastCatchupGeneration", ':', 2) AS "jobId",
    j."id" AS "resolvedJobId",
    j."agencyId" AS "jobAgencyId",
    j."creatorId" AS "jobCreatorId",
    j."jobKey",
    j."status" AS "jobStatus",
    j."params" AS "jobParams",
    j."result" AS "jobResult",
    NULLIF(j."result"->>'scanRunId', '') AS "scanRunId",
    c."id" AS "coverageId",
    c."status" AS "coverageStatus",
    c."dataType" AS "coverageDataType",
    b."id" AS "batchId",
    b."sourceJobId" AS "batchSourceJobId",
    b."idempotencyKey",
    b."status" AS "batchStatus",
    b."dataType" AS "batchDataType",
    b."rejectedRows",
    b."completedAt" AS "batchCompletedAt"
  FROM "CreatorCampaignCollectionState" s
  LEFT JOIN "JobInstance" j
    ON j."id" = split_part(s."lastCatchupGeneration", ':', 2)
  LEFT JOIN "AnalyticsIngestBatch" b
    ON b."sourceJobId" = j."id"
   AND b."dataType" = 'CAMPAIGNS'::"AnalyticsDataType"
   AND b."idempotencyKey" = 'campaigns:' || j."id" || ':run:' || NULLIF(j."result"->>'scanRunId', '') || ':completion:v7'
  LEFT JOIN "AnalyticsCoverage" c
    ON c."ingestBatchId" = b."id"
   AND c."creatorId" = s."creatorId"
   AND c."dataType" = 'CAMPAIGNS'::"AnalyticsDataType"
  WHERE s."lastCatchupGeneration" LIKE 'MIGRATED_JOB:%'
),
"ValidMigratedCampaignCatchup" AS (
  SELECT c."creatorId"
  FROM "MigratedCampaignCatchup" c
  WHERE COALESCE((
    c."resolvedJobId" IS NOT NULL
    AND c."jobAgencyId" = c."agencyId"
    AND c."jobCreatorId" = c."creatorId"
    AND c."jobKey" = 'fetch_campaigns'
    AND c."jobStatus" = 'DONE'
    AND COALESCE(c."jobResult"->>'campaignMode', c."jobParams"->>'campaignMode', '') = 'catchup'
    AND c."jobResult"->>'campaignPagesComplete' = 'true'
    AND c."jobResult"->>'claimersComplete' = 'true'
    AND c."jobResult"->>'fanValuesComplete' = 'true'
    AND c."jobResult"->>'truncated' = 'false'
    AND c."scanRunId" IS NOT NULL
    AND c."coverageId" IS NOT NULL
    AND c."coverageStatus" = 'COMPLETE'::"AnalyticsCoverageStatus"
    AND c."coverageDataType" = 'CAMPAIGNS'::"AnalyticsDataType"
    AND c."batchId" IS NOT NULL
    AND c."batchSourceJobId" = c."resolvedJobId"
    AND c."batchStatus" = 'COMMITTED'::"AnalyticsIngestStatus"
    AND c."batchDataType" = 'CAMPAIGNS'::"AnalyticsDataType"
    AND c."rejectedRows" = 0
    AND c."batchCompletedAt" IS NOT NULL
    AND c."idempotencyKey" = 'campaigns:' || c."resolvedJobId" || ':run:' || c."scanRunId" || ':completion:v7'
  ), FALSE)
),
"InvalidMigratedCampaignCatchup" AS (
  SELECT s."creatorId"
  FROM "CreatorCampaignCollectionState" s
  WHERE s."lastCatchupGeneration" LIKE 'MIGRATED_JOB:%'
    AND NOT EXISTS (
      SELECT 1 FROM "ValidMigratedCampaignCatchup" valid
      WHERE valid."creatorId" = s."creatorId"
    )
)
UPDATE "CreatorCampaignCollectionState" s
SET "lastCatchupCompletedAt" = NULL,
    "lastCatchupGeneration" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "InvalidMigratedCampaignCatchup" invalid
WHERE invalid."creatorId" = s."creatorId"
  AND s."lastCatchupGeneration" LIKE 'MIGRATED_JOB:%';
