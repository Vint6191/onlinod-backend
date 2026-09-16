-- Actual60 F60-SCALE-1
--
-- IMPORTANT DEPLOYMENT CONTRACT
-- -----------------------------
-- A populated RefreshSession can be very large. A normal CREATE INDEX here can
-- take a write-blocking table lock while Prisma applies this migration. The
-- production `npm run prisma:migrate` command therefore applies schema
-- migrations first and then executes
-- scripts/database/actual60-refreshsession-online-index-preflight.js, which
-- creates/repairs these indexes with CREATE INDEX CONCURRENTLY.
--
-- Keep a fresh/empty database self-contained: on an empty RefreshSession the
-- ordinary build is effectively free, so create the indexes here. On any
-- populated table this migration records the schema step but deliberately
-- leaves physical index construction to the post-migration online ensure.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RefreshSession" LIMIT 1) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "RefreshSession_live_authorization_lookup_idx"
        ON "RefreshSession"(
          "userId", "agencyId", "deviceId", "authorizationSessionId", "expiresAt" DESC
        ) INCLUDE ("id")
        WHERE "revokedAt" IS NULL
    $idx$;

    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "RefreshSession_live_lineage_lookup_idx"
        ON "RefreshSession"(
          "authorizationSessionId", "userId", "agencyId", "deviceId", "expiresAt" DESC
        ) INCLUDE ("id")
        WHERE "revokedAt" IS NULL
          AND "authorizationSessionId" IS NOT NULL
    $idx$;

    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "RefreshSession_authorization_history_idx"
        ON "RefreshSession"(
          "authorizationSessionId", "agencyId", "userId", "expiresAt" DESC
        )
        WHERE "authorizationSessionId" IS NOT NULL
    $idx$;
  END IF;
END $$;
