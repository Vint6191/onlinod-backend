-- Phase 3 INT5.5D-1: cross-device causal read serialization.
-- One durable row per creator fences provider reads from before the OF request
-- until the server-owned observation token has been issued.
CREATE TABLE IF NOT EXISTS "FanObservationReadLease" (
  "creatorId" TEXT NOT NULL,
  "agencyId" TEXT,
  "token" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "jobId" TEXT,
  "deliveryId" TEXT,
  "deviceId" TEXT NOT NULL,
  "leaseRevision" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FanObservationReadLease_pkey" PRIMARY KEY ("creatorId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FanObservationReadLease_token_key"
  ON "FanObservationReadLease"("token");
CREATE INDEX IF NOT EXISTS "FanObservationReadLease_expiresAt_idx"
  ON "FanObservationReadLease"("expiresAt");
CREATE INDEX IF NOT EXISTS "FanObservationReadLease_jobId_leaseRevision_idx"
  ON "FanObservationReadLease"("jobId", "leaseRevision");
CREATE INDEX IF NOT EXISTS "FanObservationReadLease_deliveryId_leaseRevision_idx"
  ON "FanObservationReadLease"("deliveryId", "leaseRevision");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'FanObservationReadLease_exactly_one_owner_check'
      AND conrelid = '"FanObservationReadLease"'::regclass
  ) THEN
    ALTER TABLE "FanObservationReadLease"
      ADD CONSTRAINT "FanObservationReadLease_exactly_one_owner_check"
      CHECK (num_nonnulls("jobId", "deliveryId") = 1) NOT VALID;
  END IF;
END $$;
ALTER TABLE "FanObservationReadLease"
  VALIDATE CONSTRAINT "FanObservationReadLease_exactly_one_owner_check";
