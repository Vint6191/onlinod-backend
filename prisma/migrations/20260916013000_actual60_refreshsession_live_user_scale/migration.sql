-- Actual60 INT60.3: user-level CURRENT session listing must stay bounded by
-- unexpired current state even when naturally-expired, never-explicitly-revoked
-- RefreshSession rows accumulate over time.
--
-- Same online deployment rule as the F60 hot/cold migration: populated tables
-- are indexed after `prisma migrate deploy` by the concurrent online ensure.
-- Fresh/empty databases still get the index from migrations alone.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RefreshSession" LIMIT 1) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "RefreshSession_live_user_lookup_idx"
        ON "RefreshSession"(
          "userId", "expiresAt" DESC, "lastUsedAt" DESC, "createdAt" DESC
        ) INCLUDE (
          "id", "agencyId", "deviceId", "authorizationSessionId", "rememberDevice"
        )
        WHERE "revokedAt" IS NULL
    $idx$;
  END IF;
END $$;
