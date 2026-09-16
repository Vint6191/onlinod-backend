-- Actual60 INT60.4
-- Complete the RefreshSession hot/cold physical query map:
--   1) agency-wide current-session lifecycle mutations must be O(current state),
--      not O(all historical rotations for the agency);
--   2) the intentional admin/recovery history view (latest sessions for one user)
--      must be ordered/indexed history rather than sorting the user's full lineage history.
--
-- Populated tables are handled after Prisma migrations by the online concurrent
-- index ensure. Fresh/empty databases build these tiny indexes inline.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RefreshSession" LIMIT 1) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "RefreshSession_live_agency_lookup_idx"
        ON "RefreshSession"(
          "agencyId", "expiresAt" DESC, "userId", "deviceId"
        ) INCLUDE ("id", "authorizationSessionId")
        WHERE "revokedAt" IS NULL
    $idx$;

    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "RefreshSession_user_history_created_idx"
        ON "RefreshSession"("userId", "createdAt" DESC)
    $idx$;
  END IF;
END $$;
