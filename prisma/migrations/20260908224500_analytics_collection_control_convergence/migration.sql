-- Phase 1 Analytics collection-control convergence.
-- Business facts remain in their specialized canonical tables. These small
-- state rows own collector baseline/catch-up/generation semantics independently
-- of technical JobInstance / AnalyticsIngestBatch retention.

ALTER TABLE "CreatorNotificationSyncState"
  ADD COLUMN IF NOT EXISTS "activeGeneration" TEXT,
  ADD COLUMN IF NOT EXISTS "activeRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retryAfterAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastCatchupVerifiedAt" TIMESTAMP(3);

CREATE TABLE "CreatorFinancialCollectionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "activeGeneration" TEXT,
    "activeRequestedAt" TIMESTAMP(3),
    "baselineVerifiedAt" TIMESTAMP(3),
    "baselineGeneration" TEXT,
    "baselineRangeFrom" TIMESTAMP(3),
    "baselineRangeTo" TIMESTAMP(3),
    "lastCatchupCompletedAt" TIMESTAMP(3),
    "lastCatchupGeneration" TEXT,
    "lastBoundary" TEXT,
    "retryAfterAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorFinancialCollectionState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorFinancialCollectionState_creatorId_key" ON "CreatorFinancialCollectionState"("creatorId");
CREATE UNIQUE INDEX "CreatorFinancialCollectionState_agency_creator_key" ON "CreatorFinancialCollectionState"("agencyId", "creatorId");
CREATE INDEX "CreatorFinancialCollectionState_agency_status_idx" ON "CreatorFinancialCollectionState"("agencyId", "status", "updatedAt");
CREATE INDEX "CreatorFinancialCollectionState_creator_baseline_idx" ON "CreatorFinancialCollectionState"("creatorId", "baselineVerifiedAt");
CREATE INDEX "CreatorFinancialCollectionState_creator_catchup_idx" ON "CreatorFinancialCollectionState"("creatorId", "lastCatchupCompletedAt");
ALTER TABLE "CreatorFinancialCollectionState"
ADD CONSTRAINT "CreatorFinancialCollectionState_agencyId_creatorId_fkey"
FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorCampaignCollectionState" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
    "mode" TEXT NOT NULL DEFAULT 'full',
    "activeGeneration" TEXT,
    "activeRequestedAt" TIMESTAMP(3),
    "baselineVerifiedAt" TIMESTAMP(3),
    "baselineGeneration" TEXT,
    "lastCatchupCompletedAt" TIMESTAMP(3),
    "lastCatchupGeneration" TEXT,
    "lastCompleteScanRunId" TEXT,
    "retryAfterAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "sourceDeviceId" TEXT,
    "sourceJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorCampaignCollectionState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorCampaignCollectionState_creatorId_key" ON "CreatorCampaignCollectionState"("creatorId");
CREATE UNIQUE INDEX "CreatorCampaignCollectionState_agency_creator_key" ON "CreatorCampaignCollectionState"("agencyId", "creatorId");
CREATE INDEX "CreatorCampaignCollectionState_agency_status_idx" ON "CreatorCampaignCollectionState"("agencyId", "status", "updatedAt");
CREATE INDEX "CreatorCampaignCollectionState_creator_baseline_idx" ON "CreatorCampaignCollectionState"("creatorId", "baselineVerifiedAt");
CREATE INDEX "CreatorCampaignCollectionState_creator_catchup_idx" ON "CreatorCampaignCollectionState"("creatorId", "lastCatchupCompletedAt");
ALTER TABLE "CreatorCampaignCollectionState"
ADD CONSTRAINT "CreatorCampaignCollectionState_agencyId_creatorId_fkey"
FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Notification catch-up keeps only a small HEAD frontier in durable collector
-- state. Full per-page audit becomes independently time-bounded.
ALTER TABLE "CreatorNotificationSyncState"
ADD COLUMN "knownNotificationIds" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Preserve only a currently proven successful catch-up as freshness evidence.
-- Older PARTIAL/FAILED traversals may have lastCatchupCompletedAt but are not
-- upgraded into VERIFIED truth.
UPDATE "CreatorNotificationSyncState"
SET "lastCatchupVerifiedAt" = "lastCatchupCompletedAt"
WHERE "lastCatchupCompletedAt" IS NOT NULL
  AND "status" = 'COMPLETE'::"AnalyticsCoverageStatus"
  AND "lastErrorCode" IS NULL;

-- Durable interactive demand is real work. Persistent failures therefore need
-- bounded retry/backoff/quarantine rather than an immediately reclaimable row.
ALTER TABLE "AnalyticsCollectionDemand" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AnalyticsCollectionDemand" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "AnalyticsCollectionDemand" ADD COLUMN "lastErrorCode" TEXT;
ALTER TABLE "AnalyticsCollectionDemand" ADD COLUMN "lastErrorClass" TEXT;
ALTER TABLE "AnalyticsCollectionDemand" ADD COLUMN "quarantinedAt" TIMESTAMP(3);
DROP INDEX IF EXISTS "AnalyticsCollectionDemand_due_idx";
CREATE INDEX "AnalyticsCollectionDemand_due_v2_idx"
ON "AnalyticsCollectionDemand"("completedAt", "quarantinedAt", "nextAttemptAt", "claimUntil", "requestedAt");

-- Migrate only previously proven Financial full-baseline rows. The durable
-- state copies server JobInstance completion time; it does not retain the job as
-- the business proof authority.
INSERT INTO "CreatorFinancialCollectionState" (
    "id", "agencyId", "creatorId", "status", "mode",
    "baselineVerifiedAt", "baselineGeneration", "baselineRangeFrom", "baselineRangeTo",
    "sourceJobId", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (t."creatorId")
    'migrated_financial_' || md5(t."creatorId"),
    t."agencyId", t."creatorId", 'COMPLETE'::"AnalyticsCoverageStatus", 'full',
    j."completedAt", 'MIGRATED_JOB:' || j."id", t."rangeFrom", t."rangeTo",
    j."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CreatorEarningsTotal" t
JOIN "JobInstance" j ON j."id" = t."sourceJobId"
WHERE t."category" = 'TOTAL'::"CreatorEarningsCategory"
  AND t."rangeFrom" <= TIMESTAMP '2016-01-02 00:00:00'
  AND j."status" = 'DONE'
  AND j."completedAt" IS NOT NULL
  AND COALESCE(j."params"->>'financialMode', 'full') <> 'catchup'
ORDER BY t."creatorId", j."completedAt" DESC, j."id" DESC
ON CONFLICT ("creatorId") DO NOTHING;

UPDATE "CreatorFinancialCollectionState" s
SET "lastCatchupCompletedAt" = recent."completedAt",
    "lastCatchupGeneration" = 'MIGRATED_JOB:' || recent."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (j."creatorId") j."creatorId", j."id", j."completedAt"
    FROM "JobInstance" j
    WHERE j."jobKey" = 'financial_transactions_scan'
      AND j."status" = 'DONE'
      AND j."completedAt" IS NOT NULL
      AND j."params"->>'financialMode' = 'catchup'
    ORDER BY j."creatorId", j."completedAt" DESC, j."id" DESC
) recent
WHERE recent."creatorId" = s."creatorId";

-- Campaign migration detaches the old generic AnalyticsCoverage completion bit
-- into specialized collector state. Prefer server ingest completion time over
-- any historical client-observed timestamp.
INSERT INTO "CreatorCampaignCollectionState" (
    "id", "agencyId", "creatorId", "status", "mode",
    "baselineVerifiedAt", "baselineGeneration", "sourceJobId", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (c."creatorId")
    'migrated_campaign_' || md5(c."creatorId"),
    c."agencyId", c."creatorId", 'COMPLETE'::"AnalyticsCoverageStatus", 'full',
    b."completedAt",
    'MIGRATED_COVERAGE:' || c."id",
    b."sourceJobId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "AnalyticsCoverage" c
JOIN "AnalyticsIngestBatch" b
  ON b."id" = c."ingestBatchId"
 AND b."status" = 'COMMITTED'::"AnalyticsIngestStatus"
 AND b."completedAt" IS NOT NULL
JOIN "JobInstance" j
  ON j."id" = b."sourceJobId"
 AND j."status" = 'DONE'
 AND j."completedAt" IS NOT NULL
WHERE c."dataType" = 'CAMPAIGNS'::"AnalyticsDataType"
  AND c."status" = 'COMPLETE'::"AnalyticsCoverageStatus"
ORDER BY c."creatorId", b."completedAt" DESC, c."id" DESC
ON CONFLICT ("creatorId") DO NOTHING;

UPDATE "CreatorCampaignCollectionState" s
SET "lastCatchupCompletedAt" = recent."completedAt",
    "lastCatchupGeneration" = 'MIGRATED_JOB:' || recent."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (j."creatorId") j."creatorId", j."id", j."completedAt"
    FROM "JobInstance" j
    WHERE j."jobKey" = 'fetch_campaigns'
      AND j."status" = 'DONE'
      AND j."completedAt" IS NOT NULL
      AND j."params"->>'campaignMode' = 'catchup'
    ORDER BY j."creatorId", j."completedAt" DESC, j."id" DESC
) recent
WHERE recent."creatorId" = s."creatorId";

-- Retention paths are cursor/batch bounded; support them with deterministic
-- indexes so GC does not devolve into full historical scans at scale.
CREATE INDEX "CreatorNotificationScanItem_retention_idx" ON "CreatorNotificationScanItem"("createdAt", "id");
CREATE INDEX "AnalyticsIngestBatch_retention_idx" ON "AnalyticsIngestBatch"("dataType", "completedAt", "id");
CREATE INDEX "JobInstance_analytics_retention_idx" ON "JobInstance"("jobKey", "status", "completedAt", "id");
CREATE INDEX "JobInstance_analytics_terminal_updated_retention_idx" ON "JobInstance"("jobKey", "status", "updatedAt", "id");

-- Jobs queued by pre-cutover builds do not carry the server-authoritative
-- collection command required by the new Financial/Campaign/Notification handlers. They
-- must not survive deploy as blockers for canonical planner work.
UPDATE "JobInstance"
SET "status" = 'CANCELLED',
    "completedAt" = CURRENT_TIMESTAMP,
    "lastError" = 'retired_analytics_collection_contract_pre_v1',
    "claimedAt" = NULL,
    "claimedByDeviceId" = NULL,
    "leaseUntil" = NULL,
    "leaseTokenHash" = NULL,
    "leaseRevision" = "leaseRevision" + 1,
    "workId" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobKey" IN ('financial_transactions_scan', 'fetch_campaigns', 'catchup_notifications_scan')
  AND "status" IN ('SCHEDULED', 'CLAIMED', 'PAUSED')
  AND COALESCE("params"->>'collectionContractVersion', '') <> '1';
