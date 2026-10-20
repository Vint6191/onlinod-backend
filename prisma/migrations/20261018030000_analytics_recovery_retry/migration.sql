BEGIN;
SET LOCAL TIME ZONE 'UTC';
-- Resume existing accepted protocol executions through their normal database
-- writer contracts. These transaction-local capabilities do not change input.
SET LOCAL onlinod.financial_receipts_v1 = '1';
SET LOCAL onlinod.campaign_bounded_traversal_version = '1';
SET LOCAL onlinod.campaign_traversal_authority_version = '1';
SET LOCAL onlinod.campaign_fair_pages_version = '1';

-- Default health must distinguish a drained queue from non-runnable debt.
CREATE INDEX "AnalyticsCollectionDemand_quarantine_pending_idx"
  ON "AnalyticsCollectionDemand" ("key")
  WHERE "completedAt" IS NULL AND "quarantinedAt" IS NOT NULL;

-- Prior workers quarantined even explicitly classified database outages after
-- eight attempts. Preserve the original requested actor/revision and cursor:
-- the normal planner rechecks current authorization before creating any job.
UPDATE "AnalyticsCollectionDemand" SET
  "quarantinedAt" = NULL, "nextAttemptAt" = clock_timestamp(),
  "claimToken" = NULL, "claimUntil" = NULL, "updatedAt" = clock_timestamp()
WHERE "completedAt" IS NULL AND "quarantinedAt" IS NOT NULL
  AND "lastErrorClass" = 'TRANSIENT'
  AND "lastErrorCode" IN ('P1001','P1002','P1008','P1017','P2024','P2034')
  AND ("claimUntil" IS NULL OR "claimUntil" <= clock_timestamp());

-- A rejected publication is immutable execution evidence. Recover only the
-- exact execution the old worker rejected for a known database availability
-- error, while that same job is still FAILED and no newer generation owns it.
-- Restart proof building from accepted facts; never mark the job DONE here.
-- P2010/P2028 without their diagnostic details are deliberately not inferred.
CREATE TEMP TABLE analytics_transient_publication_repair ON COMMIT DROP AS
SELECT p."id" AS "publicationId", p."jobId", p."agencyId", p."creatorId", j."jobKey",
  w."id" AS "workId", p."lastError" AS "previousError"
FROM "AnalyticsPublication" p
JOIN "JobInstance" j ON j."id" = p."jobId"
JOIN "Agency" a ON a."id" = p."agencyId" AND a."deletedAt" IS NULL
JOIN "CreatorAccount" c ON c."id" = p."creatorId" AND c."agencyId" = p."agencyId" AND c."deletedAt" IS NULL
JOIN "DomainWorkItem" w ON w."agencyId" = p."agencyId"
  AND w."workClass" = 'ANALYTICS_PUBLICATION' AND w."objectType" = 'ANALYTICS_PUBLICATION'
  AND w."objectId" = p."id" AND w."activeGeneration" = 'phase2_domain_work_v3_actual55'
WHERE p."state" = 'REJECTED' AND p."stage" = 'TERMINAL'
  AND split_part(p."lastError", '; ', 1) IN ('P1001','P1002','P1008','P1017','P2024','P2034',
    '08000','08001','08003','08006','08007','40001','40P01','55P03','57014','57P01','57P02','57P03','53300','DB_COMMIT_DEADLINE_EXCEEDED')
  AND (p."lastError" = split_part(p."lastError", '; ', 1)
    OR (j."jobKey" = 'fetch_earnings'
      AND p."lastError" LIKE split_part(p."lastError", '; ', 1) || '; EARNINGS_DAILY_INCOMPLETE: %'))
  AND j."status" = 'FAILED' AND j."leaseRevision" = p."leaseRevision"
  AND j."lastError" = p."lastError" AND j."agencyId" = p."agencyId" AND j."creatorId" = p."creatorId"
  AND j."jobKey" IN ('fetch_earnings','fetch_campaigns','financial_transactions_scan')
  AND w."state" IN ('DONE','RECONCILE_REQUIRED') AND w."ownerToken" IS NULL
  AND (w."leaseUntil" IS NULL OR w."leaseUntil" <= clock_timestamp())
  AND NOT EXISTS (SELECT 1 FROM "CreatorFinancialCollectionState" s
    WHERE j."jobKey" = 'financial_transactions_scan' AND s."creatorId" = p."creatorId"
      AND s."activeGeneration" IS NOT NULL AND s."activeGeneration" IS DISTINCT FROM j."params"->>'collectionGeneration')
  AND NOT EXISTS (SELECT 1 FROM "CreatorCampaignCollectionState" s
    WHERE j."jobKey" = 'fetch_campaigns' AND s."creatorId" = p."creatorId"
      AND s."activeGeneration" IS NOT NULL AND s."activeGeneration" IS DISTINCT FROM j."params"->>'collectionGeneration')
ORDER BY p."id"
FOR UPDATE OF j,p,w;

-- Collection state may have moved while the candidate rows were being locked.
-- Hold the exact current state through the final validation and revival.
SELECT s."creatorId" FROM "CreatorCampaignCollectionState" s
JOIN analytics_transient_publication_repair r ON r."jobKey" = 'fetch_campaigns'
  AND s."agencyId" = r."agencyId" AND s."creatorId" = r."creatorId"
ORDER BY s."creatorId" FOR UPDATE OF s;
SELECT s."creatorId" FROM "CreatorFinancialCollectionState" s
JOIN analytics_transient_publication_repair r ON r."jobKey" = 'financial_transactions_scan'
  AND s."agencyId" = r."agencyId" AND s."creatorId" = r."creatorId"
ORDER BY s."creatorId" FOR UPDATE OF s;

DELETE FROM analytics_transient_publication_repair r USING "JobInstance" j
WHERE j."id" = r."jobId" AND r."jobKey" = 'fetch_campaigns'
  AND NOT EXISTS (SELECT 1 FROM "CreatorCampaignCollectionState" s
    WHERE s."agencyId" = r."agencyId" AND s."creatorId" = r."creatorId"
      AND s."sourceJobId" = r."jobId" AND s."activeGeneration" = j."params"->>'collectionGeneration'
      AND (s."status" IN ('SCANNING','COMPLETE','PARTIAL')
        OR (s."status" = 'FAILED' AND s."retryAfterAt" IS NULL
          AND s."lastErrorCode" = 'CAMPAIGN_COLLECTION_FAILED' AND s."lastErrorMessage" = r."previousError")));

-- A FAILED execution may already have entered receipt retention. Lock the run
-- before checking retirement so neither a missing receipt nor a partially
-- purged fact set is revived as if it were intact publication input.
SELECT f."id" FROM "FinancialReceiptRun" f
JOIN analytics_transient_publication_repair r ON r."jobKey" = 'financial_transactions_scan'
  AND f."agencyId" = r."agencyId" AND f."creatorId" = r."creatorId" AND f."jobId" = r."jobId"
JOIN "JobInstance" j ON j."id" = r."jobId" AND f."generation" = j."params"->>'collectionGeneration'
ORDER BY f."id" FOR UPDATE OF f;
DELETE FROM analytics_transient_publication_repair r USING "JobInstance" j
WHERE j."id" = r."jobId" AND r."jobKey" = 'financial_transactions_scan'
  AND (j."params"->>'financialReceiptVersion' IS DISTINCT FROM '1'
    OR NOT EXISTS (SELECT 1 FROM "CreatorFinancialCollectionState" s
      WHERE s."agencyId" = r."agencyId" AND s."creatorId" = r."creatorId"
        AND s."activeGeneration" = j."params"->>'collectionGeneration')
    OR NOT EXISTS (SELECT 1 FROM "FinancialReceiptRun" f
      WHERE f."agencyId" = r."agencyId" AND f."creatorId" = r."creatorId" AND f."jobId" = r."jobId"
        AND f."generation" = j."params"->>'collectionGeneration'
        AND f."detailsRetiredAt" IS NULL AND f."compactedAt" IS NULL));

-- The old terminal worker also rejected Campaign's generation. Undo only that
-- same failure; retain its directory/frontier observations and proof counters.
UPDATE "CreatorCampaignCollectionState" s SET
  "status" = 'SCANNING', "retryAfterAt" = NULL, "lastErrorCode" = NULL,
  "lastErrorMessage" = NULL, "updatedAt" = clock_timestamp()
FROM analytics_transient_publication_repair r JOIN "JobInstance" j ON j."id" = r."jobId"
WHERE r."jobKey" = 'fetch_campaigns' AND s."agencyId" = r."agencyId" AND s."creatorId" = r."creatorId"
  AND s."sourceJobId" = r."jobId" AND s."activeGeneration" = j."params"->>'collectionGeneration'
  AND s."status" = 'FAILED' AND s."retryAfterAt" IS NULL
  AND s."lastErrorCode" = 'CAMPAIGN_COLLECTION_FAILED' AND s."lastErrorMessage" = r."previousError";

UPDATE "AnalyticsPublication" p SET
  "state" = 'PENDING', "stage" = CASE r."jobKey"
    WHEN 'fetch_earnings' THEN 'EARNINGS_BATCHES'
    WHEN 'fetch_campaigns' THEN 'CAMPAIGN_DIRECTORY' ELSE 'FINANCIAL_ROWS' END,
  "cursor" = '{}'::jsonb, "proof" = '{}'::jsonb, "response" = NULL,
  "attempts" = 0, "availableAt" = clock_timestamp(), "completedAt" = NULL,
  "lastError" = NULL, "updatedAt" = clock_timestamp()
FROM analytics_transient_publication_repair r WHERE p."id" = r."publicationId";

UPDATE "JobInstance" j SET
  "status" = 'PUBLISHING', "completedAt" = NULL, "lastProgressAt" = clock_timestamp(),
  "lastError" = NULL, "progress" = '{"percent":99,"message":"Resuming verified analytics publication"}'::jsonb,
  "updatedAt" = clock_timestamp()
FROM analytics_transient_publication_repair r WHERE j."id" = r."jobId";

UPDATE "DomainWorkItem" w SET
  "requestedRevision" = w."requestedRevision" + 1, "state" = 'READY', "isOutstanding" = TRUE,
  "availableAt" = clock_timestamp(), "nextAttemptAt" = NULL, "ownerToken" = NULL, "leaseUntil" = NULL,
  "progressCursor" = NULL, "failureRevision" = 0, "consecutiveFailures" = 0,
  "errorClass" = NULL, "lastError" = NULL, "terminalCause" = NULL, "lastFailureAt" = NULL,
  "lastRepair" = jsonb_build_object('kind','analytics_transient_publication_recovery_v1',
    'previousError',r."previousError",'at',clock_timestamp()), "updatedAt" = clock_timestamp()
FROM analytics_transient_publication_repair r WHERE w."id" = r."workId";

COMMIT;
