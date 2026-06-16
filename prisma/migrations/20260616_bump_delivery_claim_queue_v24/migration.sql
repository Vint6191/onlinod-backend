-- Bump cancellation distributed worker queue.
-- Active AutomationDelivery rows are used as compact pending tasks; terminal rows are still compacted into BumpDeliveryStat and deleted.
ALTER TABLE "AutomationDelivery"
  ADD COLUMN IF NOT EXISTS "cancelAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimedByDeviceId" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 5;

-- Backfill cancelAt from compact result JSON for rows written before this migration.
UPDATE "AutomationDelivery"
SET "cancelAt" = NULLIF("result"->>'cancelAt', '')::timestamptz
WHERE "cancelAt" IS NULL
  AND "result" IS NOT NULL
  AND NULLIF("result"->>'cancelAt', '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS "AutomationDelivery_creator_status_cancelAt_idx"
  ON "AutomationDelivery"("creatorId", "status", "cancelAt");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_claimUntil_idx"
  ON "AutomationDelivery"("claimUntil");
CREATE INDEX IF NOT EXISTS "AutomationDelivery_cancelAt_idx"
  ON "AutomationDelivery"("cancelAt");
