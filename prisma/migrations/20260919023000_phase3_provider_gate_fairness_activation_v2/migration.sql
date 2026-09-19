-- Phase 3 INT5.9A-14
-- Rolling-safe activation for durable provider waiter fairness.
--
-- A13 introduced typed durable waiters, but an unconditional trigger could
-- make a still-running A12 Backend fail its direct permit UPDATE during mixed
-- rollout. This migration makes waiter enforcement an explicit DRAINING ->
-- QUIESCING -> ACTIVE cutover while keeping the singleton 700ms physical gate
-- authoritative throughout all three states. It is additive/idempotent so an
-- environment that already applied the original A13 migration can still move
-- safely to the A14 protocol.

ALTER TABLE "OfProviderRequestGateState"
  ADD COLUMN IF NOT EXISTS "fairnessGeneration" TEXT NOT NULL DEFAULT 'phase3_provider_gate_fairness_v2_a14',
  ADD COLUMN IF NOT EXISTS "fairnessActivationState" TEXT NOT NULL DEFAULT 'DRAINING',
  ADD COLUMN IF NOT EXISTS "fairnessDrainStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fairnessActivatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fairnessActivationConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "legacyPermitLastSeenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "legacyPermitCount" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "OfProviderRequestGateState"
  DROP CONSTRAINT IF EXISTS "OfProviderRequestGateState_fairnessActivationState_check";
ALTER TABLE "OfProviderRequestGateState"
  ADD CONSTRAINT "OfProviderRequestGateState_fairnessActivationState_check"
  CHECK ("fairnessActivationState" IN ('DRAINING','QUIESCING','ACTIVE'));

INSERT INTO "OfProviderRequestGateState"(
  "id","revision","priorityCursor","backgroundCategoryCursor",
  "fairnessGeneration","fairnessActivationState","fairnessDrainStartedAt",
  "legacyPermitCount","createdAt","updatedAt"
) VALUES (
  'of-global',0,0,0,
  'phase3_provider_gate_fairness_v2_a14','DRAINING',clock_timestamp(),
  0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO UPDATE SET
  "fairnessGeneration"='phase3_provider_gate_fairness_v2_a14',
  "fairnessActivationState"=CASE
    WHEN "OfProviderRequestGateState"."fairnessGeneration"='phase3_provider_gate_fairness_v2_a14'
      AND "OfProviderRequestGateState"."fairnessActivationState"='ACTIVE'
    THEN 'ACTIVE'
    ELSE 'DRAINING'
  END,
  "fairnessDrainStartedAt"=CASE
    WHEN "OfProviderRequestGateState"."fairnessGeneration"='phase3_provider_gate_fairness_v2_a14'
      AND "OfProviderRequestGateState"."fairnessActivationState"='ACTIVE'
    THEN "OfProviderRequestGateState"."fairnessDrainStartedAt"
    ELSE COALESCE("OfProviderRequestGateState"."fairnessDrainStartedAt", clock_timestamp())
  END,
  "fairnessActivatedAt"=CASE
    WHEN "OfProviderRequestGateState"."fairnessGeneration"='phase3_provider_gate_fairness_v2_a14'
      AND "OfProviderRequestGateState"."fairnessActivationState"='ACTIVE'
    THEN "OfProviderRequestGateState"."fairnessActivatedAt"
    ELSE NULL
  END,
  "fairnessActivationConfirmedAt"=CASE
    WHEN "OfProviderRequestGateState"."fairnessGeneration"='phase3_provider_gate_fairness_v2_a14'
      AND "OfProviderRequestGateState"."fairnessActivationState"='ACTIVE'
    THEN "OfProviderRequestGateState"."fairnessActivationConfirmedAt"
    ELSE NULL
  END,
  "updatedAt"=CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "onlinod_enforce_provider_gate_waiter_registration"()
RETURNS trigger AS $$
BEGIN
  IF NEW."activePermitId" IS NOT NULL
     AND NEW."activePermitId" IS DISTINCT FROM OLD."activePermitId"
  THEN
    IF COALESCE(OLD."fairnessActivationState", 'DRAINING') = 'ACTIVE' THEN
      IF NOT EXISTS (
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
    ELSE
      NEW."legacyPermitLastSeenAt" := clock_timestamp();
      NEW."legacyPermitCount" := COALESCE(OLD."legacyPermitCount", 0) + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "onlinod_provider_gate_waiter_registration" ON "OfProviderRequestGateState";
CREATE TRIGGER "onlinod_provider_gate_waiter_registration"
BEFORE UPDATE OF "activePermitId" ON "OfProviderRequestGateState"
FOR EACH ROW EXECUTE FUNCTION "onlinod_enforce_provider_gate_waiter_registration"();
