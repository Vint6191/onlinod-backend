-- PHASE 3 Analytics final authority / recovery / legacy / scale cutover.
-- 1) Subscriber Directory publishes canonical FanData incrementally per provider page.
ALTER TABLE "SubscriberScanRun"
  ADD COLUMN IF NOT EXISTS "fanProjectionStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "fanProjectionCursorOffset" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanProjectionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanProjectionCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fanProjectionLastError" VARCHAR(1000),
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

ALTER TABLE "SubscriberScanItem"
  ADD COLUMN IF NOT EXISTS "pageOffset" INTEGER;

CREATE INDEX IF NOT EXISTS "SubscriberScanItem_run_pageOffset_idx"
  ON "SubscriberScanItem"("runId", "pageOffset");

-- Published legacy runs already completed the old whole-run projection. Mark them
-- as complete so the new publication barrier does not reinterpret immutable history.
UPDATE "SubscriberScanRun"
SET "fanProjectionStatus" = 'COMPLETE',
    "fanProjectionCursorOffset" = GREATEST("fanProjectionCursorOffset", "nextOffset"),
    "fanProjectionCount" = GREATEST("fanProjectionCount", "scannedCount"),
    "fanProjectionCompletedAt" = COALESCE("fanProjectionCompletedAt", "publishedAt", "completedAt", "updatedAt")
WHERE "status" IN ('PUBLISHED', 'SUPERSEDED');

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

-- 2) Durable creator-scoped promotion signal. Global recovery/promoter scans are
-- replaced by SKIP LOCKED signal claiming, one creator transaction at a time.
CREATE TABLE IF NOT EXISTS "CampaignFanRefreshPromotionSignal" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" VARCHAR(64) NOT NULL DEFAULT 'QUEUED_DEBT',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimToken" VARCHAR(120),
  "claimUntil" TIMESTAMP(3),
  "lastError" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignFanRefreshPromotionSignal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampaignFanRefreshPromotionSignal_creatorId_key" UNIQUE ("creatorId"),
  CONSTRAINT "CampaignFanRefreshPromotionSignal_agency_creator_key" UNIQUE ("agencyId", "creatorId"),
  CONSTRAINT "CampaignFanRefreshPromotionSignal_creator_fkey"
    FOREIGN KEY ("agencyId", "creatorId") REFERENCES "CreatorAccount"("agencyId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CampaignFanRefreshPromotionSignal_due_claim_creator_idx"
  ON "CampaignFanRefreshPromotionSignal"("dueAt", "claimUntil", "creatorId");

-- Seed durable work for every creator that already has open Campaign FanData debt.
INSERT INTO "CampaignFanRefreshPromotionSignal" (
  "id", "agencyId", "creatorId", "dueAt", "reason", "revision", "attempts", "createdAt", "updatedAt"
)
SELECT
  'campaign_promote_' || md5(d."creatorId"),
  MIN(d."agencyId"),
  d."creatorId",
  COALESCE(MIN(CASE WHEN d."status" = 'FAILED' THEN d."nextRetryAt" ELSE d."lastRequestedAt" END), CURRENT_TIMESTAMP),
  'CUTOVER_BACKFILL',
  1,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "CreatorFanRefreshDemand" d
WHERE d."status" IN ('QUEUED', 'FAILED')
GROUP BY d."creatorId"
ON CONFLICT ("creatorId") DO UPDATE SET
  "dueAt" = LEAST("CampaignFanRefreshPromotionSignal"."dueAt", EXCLUDED."dueAt"),
  "reason" = 'CUTOVER_BACKFILL',
  "revision" = "CampaignFanRefreshPromotionSignal"."revision" + 1,
  "updatedAt" = CURRENT_TIMESTAMP;

-- 3) Exact hot-path indexes for the creator-scoped Campaign debt lanes.
-- These predicates/orderings intentionally mirror runtime queries; generic
-- status indexes were not sufficient evidence for large-debt behavior.
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

-- 4) Legacy snapshot retirement is deliberately TWO-PHASE. This migration is
-- Phase A only. Runtime readers/writers are retired in the new revision, but the
-- physical legacy tables are preserved unchanged through the rolling-deploy and
-- rollback window so the previous revision's analyticsSnapshot.upsert() cannot
-- hit a read-only view or a missing relation.
--
-- Phase B is a separate, future destructive migration and MUST NOT be added here.
-- Before Phase B: prove all old revisions drained, take/verify an explicit backup
-- of all three legacy tables, record row counts/checksums, and retain a rollback
-- artifact. See docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md.
--
-- Intentionally preserved in Phase A:
--   "AnalyticsSnapshot"
--   "CreatorCampaignsSnapshot"
--   "CreatorEarningsSnapshot"
