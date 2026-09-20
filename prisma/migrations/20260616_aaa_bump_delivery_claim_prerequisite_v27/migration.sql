-- A21 clean-bootstrap prerequisite.
--
-- 20260616_bump_cancelat_backfill_v26 sorts before the historical
-- 20260616_bump_delivery_claim_queue_v24 migration but already references the
-- distributed claim columns.  Production databases happened to have those
-- columns from prior upgrade history; a clean migration chain did not.
--
-- Keep this migration forward-only and idempotent.  The later v24 migration is
-- intentionally left untouched and becomes a harmless IF NOT EXISTS verifier.
ALTER TABLE "AutomationDelivery"
  ADD COLUMN IF NOT EXISTS "cancelAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimedByDeviceId" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 5;
