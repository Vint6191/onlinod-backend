-- Phase 3 / INT5.9A-1
-- Split Campaign membership coverage from FanData freshness coverage and
-- coalesce refresh demand across Campaign runs by creator + OF fan identity.

ALTER TABLE "CreatorCampaignCollectionState"
  ADD COLUMN IF NOT EXISTS "membershipCoverageStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
  ADD COLUMN IF NOT EXISTS "membershipCoverageCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fanValueCoverageScanRunId" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "fanValueFreshnessCutoffAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fanValueFreshnessStatus" "AnalyticsCoverageStatus" NOT NULL DEFAULT 'MISSING',
  ADD COLUMN IF NOT EXISTS "fanValueExpected" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueAlreadyFresh" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueQueued" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueSucceeded" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueUnavailable" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueFailed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueOutstanding" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanValueCoverageUpdatedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "CreatorFanRefreshDemand" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "onlyFansUserId" VARCHAR(180) NOT NULL,
  "requestedFreshnessCutoffAt" TIMESTAMP(3) NOT NULL,
  "requestedRevision" INTEGER NOT NULL DEFAULT 1,
  "satisfiedRevision" INTEGER NOT NULL DEFAULT 0,
  "activeRefreshJobId" TEXT,
  "activeRefreshRevision" INTEGER,
  "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  "lastRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMP(3),
  "lastOutcome" VARCHAR(32),
  "lastCompletedAt" TIMESTAMP(3),
  "lastFailedAt" TIMESTAMP(3),
  "lastError" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorFanRefreshDemand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorFanRefreshDemand_creator_fan_key"
  ON "CreatorFanRefreshDemand"("creatorId", "onlyFansUserId");
CREATE INDEX IF NOT EXISTS "CreatorFanRefreshDemand_active_job_idx"
  ON "CreatorFanRefreshDemand"("activeRefreshJobId");
CREATE INDEX IF NOT EXISTS "CreatorFanRefreshDemand_creator_status_idx"
  ON "CreatorFanRefreshDemand"("creatorId", "status", "updatedAt");

DO $$ BEGIN
  ALTER TABLE "CreatorFanRefreshDemand"
    ADD CONSTRAINT "CreatorFanRefreshDemand_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CreatorFanRefreshDemand"
    ADD CONSTRAINT "CreatorFanRefreshDemand_active_job_fkey"
    FOREIGN KEY ("activeRefreshJobId") REFERENCES "JobInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "CreatorCampaignFanRefreshWork"
  ADD COLUMN IF NOT EXISTS "demandId" TEXT,
  ADD COLUMN IF NOT EXISTS "requestedRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS "outcome" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "observedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastError" VARCHAR(1000);

DO $$ BEGIN
  ALTER TABLE "CreatorCampaignFanRefreshWork"
    ADD CONSTRAINT "CreatorCampaignFanRefreshWork_demand_fkey"
    FOREIGN KEY ("demandId") REFERENCES "CreatorFanRefreshDemand"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_creator_run_status_idx"
  ON "CreatorCampaignFanRefreshWork"("creatorId", "scanRunId", "status");
CREATE INDEX IF NOT EXISTS "CreatorCampaignFanRefreshWork_demand_status_idx"
  ON "CreatorCampaignFanRefreshWork"("demandId", "status");

-- Adopt existing Actual67 per-run work into one cross-run demand row. Do not
-- invent successful freshness: terminal success is accepted only when current
-- canonical FanData actually satisfies that work row's cutoff.
INSERT INTO "CreatorFanRefreshDemand" (
  "id", "agencyId", "creatorId", "onlyFansUserId",
  "requestedFreshnessCutoffAt", "requestedRevision", "satisfiedRevision",
  "status", "lastRequestedAt", "createdAt", "updatedAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text || w."creatorId" || w."onlyFansUserId"),
  MIN(w."agencyId"), w."creatorId", w."onlyFansUserId",
  MAX(w."freshnessCutoffAt"), 1, 0,
  'QUEUED', MAX(w."scheduledAt"), MIN(w."createdAt"), CURRENT_TIMESTAMP
FROM "CreatorCampaignFanRefreshWork" w
GROUP BY w."creatorId", w."onlyFansUserId"
ON CONFLICT ("creatorId", "onlyFansUserId") DO UPDATE SET
  "requestedFreshnessCutoffAt" = GREATEST(
    "CreatorFanRefreshDemand"."requestedFreshnessCutoffAt",
    EXCLUDED."requestedFreshnessCutoffAt"
  ),
  "lastRequestedAt" = GREATEST("CreatorFanRefreshDemand"."lastRequestedAt", EXCLUDED."lastRequestedAt"),
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "CreatorCampaignFanRefreshWork" w
SET "demandId" = d."id"
FROM "CreatorFanRefreshDemand" d
WHERE d."creatorId" = w."creatorId"
  AND d."onlyFansUserId" = w."onlyFansUserId"
  AND w."demandId" IS NULL;

UPDATE "CreatorFanRefreshDemand" d
SET "activeRefreshJobId" = (
  SELECT w."refreshJobId"
  FROM "CreatorCampaignFanRefreshWork" w
  JOIN "JobInstance" j ON j."id" = w."refreshJobId"
  WHERE w."creatorId" = d."creatorId"
    AND w."onlyFansUserId" = d."onlyFansUserId"
    AND j."status" IN ('SCHEDULED', 'CLAIMED')
  ORDER BY w."scheduledAt" DESC, w."id" DESC
  LIMIT 1
),
"activeRefreshRevision" = d."requestedRevision",
"updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM "CreatorCampaignFanRefreshWork" w
  JOIN "JobInstance" j ON j."id" = w."refreshJobId"
  WHERE w."creatorId" = d."creatorId"
    AND w."onlyFansUserId" = d."onlyFansUserId"
    AND j."status" IN ('SCHEDULED', 'CLAIMED')
);

-- Classify already-terminal legacy work from canonical value evidence. Rows
-- whose old job is still active remain QUEUED and are adopted by the demand.
WITH classified AS (
  SELECT
    w."id",
    w."freshnessCutoffAt",
    value."fetchedAt" AS value_observed_at,
    value."availability" AS value_availability,
    job."status" AS job_status
  FROM "CreatorCampaignFanRefreshWork" w
  LEFT JOIN "CreatorFan" fan
    ON fan."creatorId" = w."creatorId" AND fan."onlyFansUserId" = w."onlyFansUserId"
  LEFT JOIN "CreatorFanValueCurrent" value
    ON value."creatorId" = fan."creatorId" AND value."fanId" = fan."id"
  LEFT JOIN "JobInstance" job ON job."id" = w."refreshJobId"
)
UPDATE "CreatorCampaignFanRefreshWork" w
SET
  "status" = CASE
    WHEN c.value_observed_at >= c."freshnessCutoffAt" AND c.value_availability = 'AVAILABLE' THEN 'SUCCEEDED'
    WHEN c.value_observed_at >= c."freshnessCutoffAt" THEN 'UNAVAILABLE'
    WHEN c.job_status = 'FAILED' THEN 'FAILED'
    ELSE 'QUEUED'
  END,
  "outcome" = CASE
    WHEN c.value_observed_at >= c."freshnessCutoffAt" AND c.value_availability = 'AVAILABLE' THEN 'SUCCEEDED'
    WHEN c.value_observed_at >= c."freshnessCutoffAt" THEN 'UNAVAILABLE'
    WHEN c.job_status = 'FAILED' THEN 'FAILED'
    ELSE NULL
  END,
  "observedAt" = CASE WHEN c.value_observed_at >= c."freshnessCutoffAt" THEN c.value_observed_at ELSE NULL END,
  "completedAt" = CASE WHEN c.value_observed_at >= c."freshnessCutoffAt" OR c.job_status = 'FAILED' THEN CURRENT_TIMESTAMP ELSE NULL END
FROM classified c
WHERE c."id" = w."id";

UPDATE "CreatorFanRefreshDemand" d
SET
  "status" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "CreatorCampaignFanRefreshWork" w
      WHERE w."demandId" = d."id" AND w."status" = 'QUEUED'
    ) THEN 'QUEUED'
    WHEN EXISTS (
      SELECT 1 FROM "CreatorCampaignFanRefreshWork" w
      WHERE w."demandId" = d."id" AND w."status" = 'FAILED'
    ) THEN 'FAILED'
    WHEN EXISTS (
      SELECT 1 FROM "CreatorCampaignFanRefreshWork" w
      WHERE w."demandId" = d."id" AND w."status" = 'UNAVAILABLE'
    ) THEN 'UNAVAILABLE'
    ELSE 'COMPLETE'
  END,
  "satisfiedRevision" = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM "CreatorCampaignFanRefreshWork" w
      WHERE w."demandId" = d."id" AND w."status" IN ('QUEUED','FAILED')
    ) THEN d."requestedRevision"
    ELSE d."satisfiedRevision"
  END,
  "lastObservedAt" = (
    SELECT MAX(w."observedAt") FROM "CreatorCampaignFanRefreshWork" w WHERE w."demandId" = d."id"
  ),
  "lastCompletedAt" = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM "CreatorCampaignFanRefreshWork" w
      WHERE w."demandId" = d."id" AND w."status" = 'QUEUED'
    ) THEN CURRENT_TIMESTAMP
    ELSE d."lastCompletedAt"
  END,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Actual67 did not persist already-fresh candidates and unconditionally marked
-- delegated FanData as complete. Historical run-level coverage therefore cannot
-- be reconstructed truthfully from the old work table. Adopt active refresh
-- demand above, but fail closed at the collection layer: the next campaigns-v11
-- traversal restarts from page 1 and rebuilds exact expected/alreadyFresh/queued
-- coverage. Never publish a guessed historical COMPLETE state.
UPDATE "CreatorCampaignCollectionState"
SET
  "membershipCoverageStatus" = CASE
    WHEN "status" = 'SCANNING' THEN 'SCANNING'::"AnalyticsCoverageStatus"
    WHEN "campaignProofScanRunId" IS NOT NULL THEN 'PARTIAL'::"AnalyticsCoverageStatus"
    ELSE 'MISSING'::"AnalyticsCoverageStatus"
  END,
  "membershipCoverageCompletedAt" = NULL,
  "fanValueCoverageScanRunId" = NULL,
  "fanValueFreshnessCutoffAt" = NULL,
  "fanValueFreshnessStatus" = 'MISSING'::"AnalyticsCoverageStatus",
  "fanValueExpected" = 0,
  "fanValueAlreadyFresh" = 0,
  "fanValueQueued" = 0,
  "fanValueSucceeded" = 0,
  "fanValueUnavailable" = 0,
  "fanValueFailed" = 0,
  "fanValueOutstanding" = 0,
  "fanValueCoverageUpdatedAt" = CURRENT_TIMESTAMP,
  "status" = CASE WHEN "status" = 'COMPLETE' THEN 'PARTIAL'::"AnalyticsCoverageStatus" ELSE "status" END,
  "lastCompleteScanRunId" = CASE WHEN "status" = 'COMPLETE' THEN NULL ELSE "lastCompleteScanRunId" END,
  "lastErrorCode" = CASE WHEN "status" = 'COMPLETE' THEN 'CAMPAIGN_FRESHNESS_COVERAGE_REBUILD_REQUIRED' ELSE "lastErrorCode" END,
  "lastErrorMessage" = CASE WHEN "status" = 'COMPLETE' THEN 'Campaign membership was collected before truthful FanData freshness coverage; campaigns-v11 must rebuild coverage.' ELSE "lastErrorMessage" END;

ALTER TABLE "CreatorCampaignCollectionState"
  DROP CONSTRAINT IF EXISTS "CreatorCampaignCollectionState_fan_value_coverage_nonnegative";
ALTER TABLE "CreatorCampaignCollectionState"
  ADD CONSTRAINT "CreatorCampaignCollectionState_fan_value_coverage_nonnegative" CHECK (
    "fanValueExpected" >= 0 AND "fanValueAlreadyFresh" >= 0 AND "fanValueQueued" >= 0 AND
    "fanValueSucceeded" >= 0 AND "fanValueUnavailable" >= 0 AND "fanValueFailed" >= 0 AND
    "fanValueOutstanding" >= 0
  );

ALTER TABLE "CreatorFanRefreshDemand"
  DROP CONSTRAINT IF EXISTS "CreatorFanRefreshDemand_revision_nonnegative";
ALTER TABLE "CreatorFanRefreshDemand"
  ADD CONSTRAINT "CreatorFanRefreshDemand_revision_nonnegative" CHECK (
    "requestedRevision" >= 1 AND "satisfiedRevision" >= 0 AND "satisfiedRevision" <= "requestedRevision" AND
    ("activeRefreshRevision" IS NULL OR ("activeRefreshRevision" >= 1 AND "activeRefreshRevision" <= "requestedRevision"))
  );
