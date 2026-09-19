-- Phase 3 INT5.9A-17
-- Account every acknowledged physical OF transport start inside the existing
-- durable /started transaction. No second per-request writer/ledger is added.

ALTER TABLE "OfProviderRequestGateState"
  ADD COLUMN IF NOT EXISTS "activePriority" TEXT,
  ADD COLUMN IF NOT EXISTS "activeCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "usageWindowStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "usageTotalStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageCriticalWriteStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageInteractiveStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageRealtimeStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageNormalStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageCampaignDirectoryStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageCampaignFrontierStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageFanDataStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageBackgroundOtherStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usageUnclassifiedStarts" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "ProviderCapacityDebtState"
  ADD COLUMN IF NOT EXISTS "actualUsageWindowStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "actualUsageTotalStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageCriticalWriteStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageInteractiveStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageRealtimeStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageNormalStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageCampaignDirectoryStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageCampaignFrontierStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageFanDataStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageBackgroundOtherStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageUnclassifiedStarts" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualUsageAccountingComplete" BOOLEAN NOT NULL DEFAULT TRUE;
