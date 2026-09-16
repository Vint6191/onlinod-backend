-- Actual60 INT60.10: rolling activation fence for raw RefreshSession retention.
-- Raw history purge must stay disabled while tombstone-unaware auth publishers
-- may coexist. Once activated, PostgreSQL physically rejects old lineaged
-- RefreshSession INSERT/adoption statements that do not carry the new writer generation.

INSERT INTO "Phase2ReleaseCompatibilityAuthority" (
  "scope", "requiredGeneration", "activationState", "drainStartedAt", "activatedAt", "activationConfirmedAt", "createdAt", "updatedAt"
)
VALUES (
  'AUTHORIZATION_HISTORY_PURGE',
  'actual60_auth_history_publisher_v1',
  'DRAINING',
  clock_timestamp(),
  NULL,
  NULL,
  clock_timestamp(),
  clock_timestamp()
)
ON CONFLICT ("scope") DO NOTHING;

CREATE OR REPLACE FUNCTION actual60_require_auth_history_publisher_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_generation text;
  activation_state text;
  provided_generation text;
BEGIN
  SELECT "requiredGeneration", "activationState"
    INTO required_generation, activation_state
    FROM "Phase2ReleaseCompatibilityAuthority"
   WHERE "scope"='AUTHORIZATION_HISTORY_PURGE';

  IF activation_state='ACTIVE' THEN
    provided_generation := current_setting('onlinod.actual60_auth_history_generation', true);
    IF provided_generation IS DISTINCT FROM required_generation
       OR provided_generation IS DISTINCT FROM 'actual60_auth_history_publisher_v1' THEN
      RAISE EXCEPTION 'ACTUAL60_INCOMPATIBLE_AUTH_HISTORY_PUBLISHER'
        USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS actual60_auth_history_refresh_insert ON "RefreshSession";
CREATE TRIGGER actual60_auth_history_refresh_insert
BEFORE INSERT ON "RefreshSession"
FOR EACH ROW
WHEN (NEW."authorizationSessionId" IS NOT NULL)
EXECUTE FUNCTION actual60_require_auth_history_publisher_generation();

DROP TRIGGER IF EXISTS actual60_auth_history_refresh_adoption ON "RefreshSession";
CREATE TRIGGER actual60_auth_history_refresh_adoption
BEFORE UPDATE OF "authorizationSessionId" ON "RefreshSession"
FOR EACH ROW
WHEN (
  NEW."authorizationSessionId" IS NOT NULL
  AND NEW."authorizationSessionId" IS DISTINCT FROM OLD."authorizationSessionId"
)
EXECUTE FUNCTION actual60_require_auth_history_publisher_generation();
