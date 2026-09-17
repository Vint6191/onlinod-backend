-- Phase 3 / INT5.5B-1
-- Extend the existing provider-read observation-token authority to
-- AutomationDelivery-scoped USER_PROFILE reads. Do not create a second clock or
-- token lifecycle: JobInstance and AutomationDelivery are mutually-exclusive
-- scope owners of the same server-owned monotonic observation token.

ALTER TABLE "FanObservationToken"
  ADD COLUMN IF NOT EXISTS "deliveryId" TEXT;

-- Existing JobInstance tokens keep jobId. Action-delivery tokens carry
-- deliveryId instead, so the legacy jobId column must become nullable.
ALTER TABLE "FanObservationToken"
  ALTER COLUMN "jobId" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'FanObservationToken_exactly_one_owner_check'
      AND conrelid = '"FanObservationToken"'::regclass
  ) THEN
    ALTER TABLE "FanObservationToken"
      ADD CONSTRAINT "FanObservationToken_exactly_one_owner_check"
      CHECK (num_nonnulls("jobId", "deliveryId") = 1)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "FanObservationToken"
  VALIDATE CONSTRAINT "FanObservationToken_exactly_one_owner_check";
