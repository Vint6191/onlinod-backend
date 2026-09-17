-- Phase 3 / INT5.7A-2
-- Mixed-replica observation-clock bridge.
--
-- The bridge is intentionally inactive after migration. While inactive, a
-- bridge-capable Backend serializes token issue through the legacy singleton
-- AND synchronizes the per-creator clock to the same-or-newer value. This is
-- required while older Backend replicas can still issue from FanObservationClock.
-- After every old Backend issuer has been drained, the operator activation
-- captures the final legacy floor and flips this row active. Active binaries
-- then issue only from FanObservationCreatorClock.
INSERT INTO "SystemSetting" ("id", "key", "value", "createdAt", "updatedAt")
VALUES (
  'phase3-fan-observation-creator-clock-v1',
  'phase3.fanObservationCreatorClockV1',
  '{"active":false,"epoch":0}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

-- Correctness guard for an accidentally undrained old Backend replica. Old
-- binaries know only the singleton UPDATE path. Once activation is visible,
-- that path must fail closed rather than mint a chronology that the creator
-- clocks can no longer observe. The trigger is intentionally permissive while
-- the bridge row is inactive.
CREATE OR REPLACE FUNCTION "phase3RejectRetiredLegacyFanObservationClockWrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SystemSetting"
    WHERE "key" = 'phase3.fanObservationCreatorClockV1'
      AND COALESCE(("value"->>'active')::boolean, false) = true
  ) THEN
    RAISE EXCEPTION 'FAN_OBSERVATION_LEGACY_CLOCK_RETIRED'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "phase3_reject_retired_legacy_fan_observation_clock_write"
  ON "FanObservationClock";

CREATE TRIGGER "phase3_reject_retired_legacy_fan_observation_clock_write"
BEFORE UPDATE ON "FanObservationClock"
FOR EACH ROW
EXECUTE FUNCTION "phase3RejectRetiredLegacyFanObservationClockWrite"();
