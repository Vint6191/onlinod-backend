-- Actual59 INT59.3: make the whole human-performance authorization generation
-- server-verifiable at commit time: login lineage + member epoch + creator
-- catalog generation. Also fix the INT59.2 member boundary timestamp so a
-- writer that waited behind a telemetry SHARE lock cannot back-date revocation.
BEGIN;

ALTER TABLE "RefreshSession"
  ADD COLUMN IF NOT EXISTS "authorizationSessionId" TEXT;

CREATE INDEX IF NOT EXISTS "RefreshSession_authorizationSessionId_idx"
  ON "RefreshSession"("authorizationSessionId");

CREATE TABLE IF NOT EXISTS "AuthorizationSessionBoundary" (
  "authorizationSessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "deviceId" TEXT,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthorizationSessionBoundary_pkey" PRIMARY KEY ("authorizationSessionId")
);
CREATE INDEX IF NOT EXISTS "AuthorizationSessionBoundary_agency_user_ended_idx"
  ON "AuthorizationSessionBoundary"("agencyId", "userId", "endedAt");

-- A refresh rotation creates the replacement row before revoking the old token.
-- Therefore this trigger only closes a login lineage when no other live refresh
-- row for that lineage exists. Ordinary logout/admin revocation remains covered
-- even when it is issued outside auth-service.js.
CREATE OR REPLACE FUNCTION "capture_authorization_session_boundary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."revokedAt" IS NULL
     AND NEW."revokedAt" IS NOT NULL
     AND NEW."authorizationSessionId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "RefreshSession" r
        WHERE r."authorizationSessionId" = NEW."authorizationSessionId"
          AND r."id" <> NEW."id"
          AND r."revokedAt" IS NULL
          AND r."expiresAt" > clock_timestamp()
     ) THEN
    INSERT INTO "AuthorizationSessionBoundary" (
      "authorizationSessionId", "userId", "agencyId", "deviceId", "endedAt"
    ) VALUES (
      NEW."authorizationSessionId", NEW."userId", NEW."agencyId", NEW."deviceId", clock_timestamp()
    )
    ON CONFLICT ("authorizationSessionId") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "RefreshSession_capture_authorization_boundary" ON "RefreshSession";
CREATE TRIGGER "RefreshSession_capture_authorization_boundary"
AFTER UPDATE OF "revokedAt" ON "RefreshSession"
FOR EACH ROW
WHEN (OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL)
EXECUTE FUNCTION "capture_authorization_session_boundary"();

CREATE TABLE IF NOT EXISTS "AgencyCreatorCatalogGenerationBoundary" (
  "agencyId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "nextGeneration" INTEGER NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyCreatorCatalogGenerationBoundary_pkey" PRIMARY KEY ("agencyId", "generation"),
  CONSTRAINT "AgencyCreatorCatalogGenerationBoundary_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AgencyCreatorCatalogGenerationBoundary_agency_ended_idx"
  ON "AgencyCreatorCatalogGenerationBoundary"("agencyId", "endedAt");

CREATE OR REPLACE FUNCTION "capture_creator_catalog_generation_boundary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."generation" IS DISTINCT FROM OLD."generation" THEN
    INSERT INTO "AgencyCreatorCatalogGenerationBoundary" (
      "agencyId", "generation", "nextGeneration", "endedAt"
    ) VALUES (
      OLD."agencyId", OLD."generation", NEW."generation", clock_timestamp()
    )
    ON CONFLICT ("agencyId", "generation") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AgencyCreatorCatalogState_capture_generation_boundary" ON "AgencyCreatorCatalogState";
CREATE TRIGGER "AgencyCreatorCatalogState_capture_generation_boundary"
AFTER UPDATE OF "generation" ON "AgencyCreatorCatalogState"
FOR EACH ROW
WHEN (OLD."generation" IS DISTINCT FROM NEW."generation")
EXECUTE FUNCTION "capture_creator_catalog_generation_boundary"();

-- Replace the INT59.2 function. clock_timestamp() is evaluated after any lock
-- wait at the physical UPDATE boundary; statement_timestamp() could otherwise
-- truncate legitimate performance time by the duration of that wait.
CREATE OR REPLACE FUNCTION "capture_agency_member_access_epoch_boundary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."accessEpoch" IS DISTINCT FROM OLD."accessEpoch" THEN
    INSERT INTO "AgencyMemberAccessEpochBoundary" (
      "memberId", "agencyId", "userId", "accessEpoch", "nextAccessEpoch", "endedAt"
    ) VALUES (
      OLD."id", OLD."agencyId", OLD."userId", OLD."accessEpoch", NEW."accessEpoch", clock_timestamp()
    )
    ON CONFLICT ("memberId", "accessEpoch") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
