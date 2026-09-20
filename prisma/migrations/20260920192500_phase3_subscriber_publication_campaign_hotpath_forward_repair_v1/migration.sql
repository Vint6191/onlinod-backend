-- Phase 3 forward repair for DDL that was added to the already-applied
-- 20260920123000_phase3_analytics_final_authority_cutover_v1 migration.
--
-- IMPORTANT: this migration is monotonic and idempotent at the DDL level. It is
-- required for databases that applied the earlier checksum before publication
-- state and exact hot-path indexes were added to the source migration.

ALTER TABLE "SubscriberScanRun"
  ADD COLUMN IF NOT EXISTS "publicationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "publicationCursorId" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "publicationPreviousRunId" TEXT,
  ADD COLUMN IF NOT EXISTS "publicationAddedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "publicationChangedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "publicationDisappearedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "publicationStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publicationCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publicationJobReconciledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publicationLastError" VARCHAR(1000);

-- Runs published by the pre-publication-state generation already completed the
-- legacy whole-run publication. Mark immutable history COMPLETE so recovery does
-- not reinterpret it as new debt after this forward repair.
UPDATE "SubscriberScanRun"
SET "publicationStatus" = 'COMPLETE',
    "publicationStartedAt" = COALESCE("publicationStartedAt", "publishedAt", "completedAt", "updatedAt"),
    "publicationCompletedAt" = COALESCE("publicationCompletedAt", "publishedAt", "completedAt", "updatedAt"),
    "publicationAddedCount" = GREATEST("publicationAddedCount",
      CASE WHEN COALESCE("summary"->>'addedCount', '') ~ '^[0-9]+$' THEN ("summary"->>'addedCount')::integer ELSE 0 END),
    "publicationChangedCount" = GREATEST("publicationChangedCount",
      CASE WHEN COALESCE("summary"->>'changedCount', '') ~ '^[0-9]+$' THEN ("summary"->>'changedCount')::integer ELSE 0 END),
    "publicationDisappearedCount" = GREATEST("publicationDisappearedCount",
      CASE WHEN COALESCE("summary"->>'disappearedCount', '') ~ '^[0-9]+$' THEN ("summary"->>'disappearedCount')::integer ELSE 0 END),
    "publicationJobReconciledAt" = COALESCE("publicationJobReconciledAt", "publishedAt", "completedAt", "updatedAt")
WHERE "status" IN ('PUBLISHED', 'SUPERSEDED');

CREATE INDEX IF NOT EXISTS "SubscriberScanRun_publication_recovery_idx"
  ON "SubscriberScanRun"("status", "publicationStatus", "updatedAt");

CREATE INDEX IF NOT EXISTS "SubscriberScanRun_publication_job_reconcile_idx"
  ON "SubscriberScanRun"("updatedAt", "id")
  WHERE "status" IN ('PUBLISHED', 'SUPERSEDED')
    AND "publicationStatus" = 'COMPLETE'
    AND "publicationJobReconciledAt" IS NULL;

-- Exact indexes for creator-scoped Campaign debt maintenance. These were also
-- introduced after the original migration had already been applied in production.
CREATE INDEX IF NOT EXISTS "CreatorFanRefreshDemand_promoter_ready_idx"
  ON "CreatorFanRefreshDemand"("creatorId", "lastRequestedAt", "id")
  WHERE "status" = 'QUEUED' AND "activeRefreshJobId" IS NULL;

CREATE INDEX IF NOT EXISTS "CreatorFanRefreshDemand_recovery_order_idx"
  ON "CreatorFanRefreshDemand"(
    "creatorId",
    (COALESCE("nextRetryAt", "lastFailedAt", "updatedAt")),
    "id"
  )
  WHERE "status" = 'FAILED' AND "activeRefreshJobId" IS NULL;

CREATE INDEX IF NOT EXISTS "CreatorFanRefreshDemand_canonical_heal_idx"
  ON "CreatorFanRefreshDemand"("creatorId", "updatedAt", "id")
  WHERE "status" IN ('QUEUED', 'FAILED');

CREATE INDEX IF NOT EXISTS "CampaignFanRefreshPromotionSignal_claim_due_idx"
  ON "CampaignFanRefreshPromotionSignal"(
    "dueAt",
    "creatorId",
    (COALESCE("claimUntil", '-infinity'::timestamp))
  );
