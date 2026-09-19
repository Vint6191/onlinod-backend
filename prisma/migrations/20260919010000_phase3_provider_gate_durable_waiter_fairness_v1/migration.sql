-- Phase 3 INT5.9A-13
-- Durable cross-replica provider waiter fairness and background category credit.
-- Additive only. The singleton permit remains the physical safety authority.
ALTER TABLE "OfProviderRequestGateState"
  ADD COLUMN IF NOT EXISTS "priorityCursor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "backgroundCategoryCursor" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "OfProviderRequestGateWaiter" (
  "ticket" BIGSERIAL NOT NULL,
  "waiterId" TEXT NOT NULL,
  "ownerInstanceId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "source" TEXT,
  "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfProviderRequestGateWaiter_pkey" PRIMARY KEY ("ticket"),
  CONSTRAINT "OfProviderRequestGateWaiter_waiterId_key" UNIQUE ("waiterId")
);

CREATE INDEX IF NOT EXISTS "OfProviderRequestGateWaiter_lease_idx"
  ON "OfProviderRequestGateWaiter"("leaseUntil");
CREATE INDEX IF NOT EXISTS "OfProviderRequestGateWaiter_bucket_ticket_idx"
  ON "OfProviderRequestGateWaiter"("priority", "category", "ticket");
CREATE INDEX IF NOT EXISTS "OfProviderRequestGateWaiter_owner_lease_idx"
  ON "OfProviderRequestGateWaiter"("ownerInstanceId", "leaseUntil");
CREATE INDEX IF NOT EXISTS "OfProviderRequestGateWaiter_creator_ticket_idx"
  ON "OfProviderRequestGateWaiter"("creatorId", "ticket");

-- Rolling A12/A13 fence: once an A13 waiter exists, a legacy Backend must not
-- bypass the durable queue by writing an arbitrary active permit. A13 uses the
-- waiterId itself as permitId. Legacy A12 remains able to drain an already-held
-- permit and can acquire only while there is no live A13 waiter.
CREATE OR REPLACE FUNCTION "onlinod_enforce_provider_gate_waiter_registration"()
RETURNS trigger AS $$
BEGIN
  IF NEW."activePermitId" IS NOT NULL
     AND NEW."activePermitId" IS DISTINCT FROM OLD."activePermitId"
     AND EXISTS (
       SELECT 1 FROM "OfProviderRequestGateWaiter" w
       WHERE w."leaseUntil" > clock_timestamp()
     )
     AND NOT EXISTS (
       SELECT 1 FROM "OfProviderRequestGateWaiter" w
       WHERE w."waiterId" = NEW."activePermitId"
         AND w."agencyId" = NEW."activeAgencyId"
         AND w."creatorId" = NEW."activeCreatorId"
         AND w."deviceId" = NEW."activeDeviceId"
         AND w."capability" = NEW."activeCapability"
         AND w."leaseUntil" > clock_timestamp()
     )
  THEN
    RAISE EXCEPTION 'ONLINOD_PROVIDER_GATE_WAITER_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "onlinod_provider_gate_waiter_registration" ON "OfProviderRequestGateState";
CREATE TRIGGER "onlinod_provider_gate_waiter_registration"
BEFORE UPDATE OF "activePermitId" ON "OfProviderRequestGateState"
FOR EACH ROW EXECUTE FUNCTION "onlinod_enforce_provider_gate_waiter_registration"();
