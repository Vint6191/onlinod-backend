-- PHASE 3 Analytics final authority / recovery / legacy / scale cutover.
-- 1) Subscriber Directory publishes canonical FanData incrementally per provider page.
ALTER TABLE "SubscriberScanRun"
  ADD COLUMN IF NOT EXISTS "fanProjectionStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "fanProjectionCursorOffset" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanProjectionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fanProjectionCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fanProjectionLastError" VARCHAR(1000);

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

-- 3) Retire obsolete Analytics snapshot generations. Current Home/Stats/Billing
-- read relational canonical facts; these archive tables must no longer be physical
-- runtime authority or a future accidental fallback.
--
-- Render runs migrations while the previous application revision can still be serving.
-- Dropping the legacy relations outright would therefore create a rolling-deploy window
-- where the old Billing binary can fail with relation-does-not-exist. Remove the physical
-- tables/data, then atomically replace their old relation names with zero-row read-only
-- compatibility views. The new revision has no Prisma models or source readers/writers for
-- these names; the views exist only so an old in-flight revision observes "no legacy data"
-- until traffic has fully cut over.
DROP TABLE IF EXISTS "AnalyticsSnapshot" CASCADE;
DROP TABLE IF EXISTS "CreatorCampaignsSnapshot" CASCADE;
DROP TABLE IF EXISTS "CreatorEarningsSnapshot" CASCADE;

CREATE VIEW "CreatorEarningsSnapshot" AS
SELECT
  NULL::text AS "id",
  NULL::text AS "creatorId",
  NULL::text AS "agencyId",
  NULL::text AS "rangeKey",
  NULL::timestamp(3) AS "rangeStartAt",
  NULL::timestamp(3) AS "rangeEndAt",
  NULL::bigint AS "totalCents",
  NULL::bigint AS "grossCents",
  NULL::bigint AS "deltaCents",
  NULL::integer AS "salesCount",
  NULL::integer AS "uniqueFans",
  NULL::integer AS "avgSaleCents",
  NULL::integer AS "fanLtvCents",
  NULL::jsonb AS "raw",
  NULL::timestamp(3) AS "capturedAt",
  NULL::text AS "capturedByDeviceId",
  NULL::text AS "capturedByUserId",
  NULL::timestamp(3) AS "createdAt",
  NULL::timestamp(3) AS "updatedAt"
WHERE FALSE;

CREATE VIEW "CreatorCampaignsSnapshot" AS
SELECT
  NULL::text AS "id",
  NULL::text AS "creatorId",
  NULL::text AS "agencyId",
  NULL::text AS "rangeKey",
  NULL::jsonb AS "campaigns",
  NULL::integer AS "totalActive",
  NULL::integer AS "totalClaimers",
  NULL::integer AS "totalClicks",
  NULL::timestamp(3) AS "capturedAt",
  NULL::text AS "capturedByDeviceId",
  NULL::text AS "capturedByUserId",
  NULL::timestamp(3) AS "createdAt",
  NULL::timestamp(3) AS "updatedAt"
WHERE FALSE;

CREATE VIEW "AnalyticsSnapshot" AS
SELECT
  NULL::text AS "id",
  NULL::text AS "agencyId",
  NULL::text AS "scope",
  NULL::text AS "rangeKey",
  NULL::jsonb AS "payload",
  NULL::timestamp(3) AS "capturedAt",
  NULL::timestamp(3) AS "createdAt",
  NULL::timestamp(3) AS "updatedAt"
WHERE FALSE;

COMMENT ON VIEW "CreatorEarningsSnapshot" IS 'Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain';
COMMENT ON VIEW "CreatorCampaignsSnapshot" IS 'Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain';
COMMENT ON VIEW "AnalyticsSnapshot" IS 'Phase-3 rolling-deploy tombstone; zero rows; remove after legacy revision drain';
