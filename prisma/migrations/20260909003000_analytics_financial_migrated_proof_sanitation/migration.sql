-- Financial collection-state migration sanitation.
--
-- The initial collection-control cutover copied historical Financial readiness
-- from JobInstance rows that were DONE. Older Financial completion semantics,
-- however, could mark a JobInstance DONE even when the canonical reconciliation
-- was incomplete. Job status is execution history, not durable business proof.
--
-- Preserve a migrated FULL baseline only when the historical result and the
-- canonical relational facts independently re-prove the current FULL contract:
--   * source traversal reached its boundary;
--   * the scanner rejected zero source rows;
--   * a TOTAL chart exists for the same job + scan generation; and
--   * non-refund transaction count/gross/net reconcile to that TOTAL chart.
--
-- Preserve a migrated CATCHUP frontier only when the historical result proves
-- source-boundary completion with zero scanner rejects. Empty catchups are valid,
-- so no transaction-row existence requirement is imposed on catchup proof.
--
-- This is a follow-up migration instead of rewriting the earlier migration so
-- already-applied Prisma migration checksums remain immutable. Fresh databases
-- run the original backfill and this fail-closed sanitation consecutively.

WITH "MigratedFinancialBaseline" AS (
  SELECT
    s."creatorId",
    s."agencyId",
    s."baselineGeneration",
    split_part(s."baselineGeneration", ':', 2) AS "jobId",
    j."id" AS "resolvedJobId",
    j."jobKey",
    j."status" AS "jobStatus",
    j."agencyId" AS "jobAgencyId",
    j."creatorId" AS "jobCreatorId",
    j."params" AS "jobParams",
    j."result" AS "jobResult",
    NULLIF(j."result"->>'scanRunId', '') AS "scanRunId",
    t."id" AS "totalId",
    t."sourceJobId" AS "totalSourceJobId",
    t."scanRunId" AS "totalScanRunId",
    t."transactionsCount" AS "chartTransactionsCount",
    t."grossCents" AS "chartGrossCents",
    t."netCents" AS "chartNetCents"
  FROM "CreatorFinancialCollectionState" s
  LEFT JOIN "JobInstance" j
    ON j."id" = split_part(s."baselineGeneration", ':', 2)
  LEFT JOIN "CreatorEarningsTotal" t
    ON t."creatorId" = s."creatorId"
   AND t."category" = 'TOTAL'::"CreatorEarningsCategory"
  WHERE s."baselineGeneration" LIKE 'MIGRATED_JOB:%'
),
"MigratedFinancialBaselineFacts" AS (
  SELECT
    b."creatorId",
    b."jobId",
    COUNT(f."id") FILTER (
      WHERE LOWER(TRIM(COALESCE(f."transactionStatus", ''))) <> 'undo'
    )::BIGINT AS "earningsTransactionsCount",
    COALESCE(SUM(f."amountCents") FILTER (
      WHERE LOWER(TRIM(COALESCE(f."transactionStatus", ''))) <> 'undo'
    ), 0)::BIGINT AS "earningsGrossCents",
    COALESCE(SUM(COALESCE(f."netCents", 0)) FILTER (
      WHERE LOWER(TRIM(COALESCE(f."transactionStatus", ''))) <> 'undo'
    ), 0)::BIGINT AS "earningsNetCents"
  FROM "MigratedFinancialBaseline" b
  LEFT JOIN "CreatorFinancialTransaction" f
    ON f."creatorId" = b."creatorId"
   AND f."sourceJobId" = b."resolvedJobId"
   AND f."scanRunId" = b."scanRunId"
  GROUP BY b."creatorId", b."jobId"
),
"InvalidMigratedFinancialBaseline" AS (
  SELECT b."creatorId"
  FROM "MigratedFinancialBaseline" b
  LEFT JOIN "MigratedFinancialBaselineFacts" f
    ON f."creatorId" = b."creatorId"
   AND f."jobId" = b."jobId"
  WHERE NOT COALESCE((
    b."resolvedJobId" IS NOT NULL
    AND b."jobKey" = 'financial_transactions_scan'
    AND b."jobStatus" = 'DONE'
    AND b."jobCreatorId" = b."creatorId"
    AND b."jobAgencyId" = b."agencyId"
    AND COALESCE(b."jobParams"->>'financialMode', 'full') <> 'catchup'
    AND b."jobResult"->>'sourceBoundaryReached' = 'true'
    AND b."jobResult"->>'scannerRejected' = '0'
    AND b."scanRunId" IS NOT NULL
    AND b."totalId" IS NOT NULL
    AND b."totalSourceJobId" = b."resolvedJobId"
    AND b."totalScanRunId" = b."scanRunId"
    AND b."chartTransactionsCount"::BIGINT = COALESCE(f."earningsTransactionsCount", 0)
    AND b."chartGrossCents"::BIGINT = COALESCE(f."earningsGrossCents", 0)
    AND b."chartNetCents"::BIGINT = COALESCE(f."earningsNetCents", 0)
  ), FALSE)
)
UPDATE "CreatorFinancialCollectionState" s
SET "baselineVerifiedAt" = NULL,
    "baselineGeneration" = NULL,
    "baselineRangeFrom" = NULL,
    "baselineRangeTo" = NULL,
    "sourceJobId" = CASE
      WHEN s."sourceJobId" IS NOT NULL
       AND s."sourceJobId" = split_part(s."baselineGeneration", ':', 2)
      THEN NULL
      ELSE s."sourceJobId"
    END,
    "status" = CASE
      -- Never clobber an in-flight current generation or a later explicit
      -- terminal failure. Only demote states whose apparent usability came
      -- from the migrated proof being invalidated here.
      WHEN s."activeGeneration" IS NULL
       AND s."status" IN ('COMPLETE'::"AnalyticsCoverageStatus", 'PARTIAL'::"AnalyticsCoverageStatus")
      THEN 'MISSING'::"AnalyticsCoverageStatus"
      ELSE s."status"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "InvalidMigratedFinancialBaseline" invalid
WHERE invalid."creatorId" = s."creatorId"
  AND s."baselineGeneration" LIKE 'MIGRATED_JOB:%';

WITH "MigratedFinancialCatchup" AS (
  SELECT
    s."creatorId",
    s."agencyId",
    s."lastCatchupGeneration",
    split_part(s."lastCatchupGeneration", ':', 2) AS "jobId",
    j."id" AS "resolvedJobId",
    j."jobKey",
    j."status" AS "jobStatus",
    j."agencyId" AS "jobAgencyId",
    j."creatorId" AS "jobCreatorId",
    j."params" AS "jobParams",
    j."result" AS "jobResult",
    NULLIF(j."result"->>'scanRunId', '') AS "scanRunId"
  FROM "CreatorFinancialCollectionState" s
  LEFT JOIN "JobInstance" j
    ON j."id" = split_part(s."lastCatchupGeneration", ':', 2)
  WHERE s."lastCatchupGeneration" LIKE 'MIGRATED_JOB:%'
),
"InvalidMigratedFinancialCatchup" AS (
  SELECT c."creatorId"
  FROM "MigratedFinancialCatchup" c
  WHERE NOT COALESCE((
    c."resolvedJobId" IS NOT NULL
    AND c."jobKey" = 'financial_transactions_scan'
    AND c."jobStatus" = 'DONE'
    AND c."jobCreatorId" = c."creatorId"
    AND c."jobAgencyId" = c."agencyId"
    AND COALESCE(c."jobResult"->>'financialMode', c."jobParams"->>'financialMode', '') = 'catchup'
    AND c."jobResult"->>'sourceBoundaryReached' = 'true'
    AND c."jobResult"->>'scannerRejected' = '0'
    AND c."scanRunId" IS NOT NULL
  ), FALSE)
)
UPDATE "CreatorFinancialCollectionState" s
SET "lastCatchupCompletedAt" = NULL,
    "lastCatchupGeneration" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "InvalidMigratedFinancialCatchup" invalid
WHERE invalid."creatorId" = s."creatorId"
  AND s."lastCatchupGeneration" LIKE 'MIGRATED_JOB:%';
