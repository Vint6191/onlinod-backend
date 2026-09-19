-- Phase 3 INT5.9A-18: explicit future-debt coverage for provider background work.
-- JobInstance is the durable work authority for background readonly provider jobs,
-- but exact future OF-call cardinality is not inferred from a generic job row.
ALTER TABLE "ProviderCapacityDebtState"
  ADD COLUMN IF NOT EXISTS "backgroundOtherPendingJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "backgroundOtherOldestScheduledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "backgroundOtherPendingJobClasses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "backgroundOtherCallCardinalityKnown" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "futureDebtCoverageStatus" VARCHAR(40) NOT NULL DEFAULT 'COMPLETE_AT_SAMPLE',
  ADD COLUMN IF NOT EXISTS "futureDebtCoverageReason" VARCHAR(500);
