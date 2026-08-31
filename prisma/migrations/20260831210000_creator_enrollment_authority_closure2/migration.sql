-- Audit 14 Closure 2: destructive connection management authority and
-- stale-safe current platform-profile observation provenance.

ALTER TABLE "CreatorAccount"
  ADD COLUMN "platformProfileObservedAt" TIMESTAMP(3),
  ADD COLUMN "platformProfileSourceDeviceId" TEXT,
  ADD COLUMN "platformProfileConnectionGeneration" INTEGER;

-- Existing profile fields intentionally remain without a fabricated observation
-- timestamp. The first verified Desktop /users/me observation establishes the
-- current freshness clock. Arrival/backend time is never backfilled as platform
-- observation time.
