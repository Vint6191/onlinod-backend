BEGIN;

-- ONLINOD Phase 3 / A36 R2 destructive claim-authority closure.
--
-- The Actual56 internal helpers described a claimed destructive transaction,
-- but accepted only an Agency/Creator GUC plus the existence of any outstanding
-- destructive DWI.  A stale transaction-local marker could therefore bypass
-- mutation/invalidation fences after ownership moved to another worker, after
-- the lease expired, or before the work had ever been claimed.
--
-- Bind both internal authorities to the exact live DWI claim.  These helpers are
-- VOLATILE because lease validity is evaluated against clock_timestamp().
CREATE OR REPLACE FUNCTION "phase2_internal_agency_destructive_authorized"(p_agency_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
AS $$
  SELECT NULLIF(BTRIM(COALESCE(p_agency_id,'')),'') IS NOT NULL
     AND current_setting('onlinod.phase2_destructive_agency_id',TRUE)=BTRIM(p_agency_id)
     AND EXISTS (
       SELECT 1
         FROM "DomainWorkItem" d
        WHERE d."id"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_agency_work_id',TRUE),''
              )), '')
          AND d."agencyId"=BTRIM(p_agency_id)
          AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
          AND d."objectType"='Phase2AgencyDestructiveCleanup'
          AND d."objectId"=BTRIM(p_agency_id)
          AND d."state"='CLAIMED'
          AND d."isOutstanding"=TRUE
          AND d."ownerToken"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_agency_owner_token',TRUE),''
              )), '')
          AND d."leaseUntil">clock_timestamp()
        LIMIT 1
     );
$$;

CREATE OR REPLACE FUNCTION "phase2_internal_creator_destructive_authorized"(
  p_agency_id text,
  p_creator_id text
)
RETURNS boolean
LANGUAGE sql
VOLATILE
AS $$
  SELECT NULLIF(BTRIM(COALESCE(p_agency_id,'')),'') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(p_creator_id,'')),'') IS NOT NULL
     AND current_setting('onlinod.phase2_destructive_agency_id',TRUE)=BTRIM(p_agency_id)
     AND current_setting('onlinod.phase2_destructive_creator_id',TRUE)=BTRIM(p_creator_id)
     AND EXISTS (
       SELECT 1
         FROM "DomainWorkItem" d
        WHERE d."id"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_creator_work_id',TRUE),''
              )), '')
          AND d."agencyId"=BTRIM(p_agency_id)
          AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
          AND d."objectType"='Phase2CreatorDestructiveCleanup'
          AND d."objectId"=BTRIM(p_creator_id)
          AND d."state"='CLAIMED'
          AND d."isOutstanding"=TRUE
          AND d."ownerToken"=NULLIF(BTRIM(COALESCE(
                current_setting('onlinod.phase2_destructive_creator_owner_token',TRUE),''
              )), '')
          AND d."leaseUntil">clock_timestamp()
        LIMIT 1
     );
$$;

-- Agency hard deletion first publishes and then waits for independently claimed
-- child Creator cleanup work.  While the parent Agency barrier is outstanding,
-- creator-specific mutations must accept the exact child Creator claim; granting
-- generic Agency authority to that child would allow cross-Creator mutation.
CREATE OR REPLACE FUNCTION "phase2_assert_creator_destructive_insert_allowed"(
  p_agency_id text,
  p_creator_id text,
  p_table_name text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id text;
  v_creator_internal boolean;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_creator_id, '')), '') IS NULL THEN RETURN; END IF;

  BEGIN
    SELECT c."agencyId"
      INTO v_agency_id
      FROM "CreatorAccount" c
     WHERE c."id"=p_creator_id
       AND (
         NULLIF(BTRIM(COALESCE(p_agency_id, '')), '') IS NULL
         OR c."agencyId"=p_agency_id
       )
     FOR KEY SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING
      ERRCODE='55P03',
      MESSAGE=format(
        'PHASE2_CREATOR_LIFECYCLE_BUSY agency=%s creator=%s table=%s',
        COALESCE(p_agency_id,'?'),p_creator_id,p_table_name
      );
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='23503',
      MESSAGE=format(
        'PHASE2_CREATOR_IDENTITY_ABSENT agency=%s creator=%s table=%s',
        COALESCE(p_agency_id,'?'),p_creator_id,p_table_name
      );
  END IF;

  v_creator_internal := "phase2_internal_creator_destructive_authorized"(
    v_agency_id,p_creator_id
  );

  IF EXISTS (
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=v_agency_id
       AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType"='Phase2AgencyDestructiveCleanup'
       AND d."objectId"=v_agency_id
     LIMIT 1
  )
  AND NOT "phase2_internal_agency_destructive_authorized"(v_agency_id)
  AND NOT v_creator_internal THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format(
        'PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s',
        v_agency_id,p_creator_id,p_table_name
      );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=v_agency_id
       AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
       AND d."objectType"='Phase2CreatorDestructiveCleanup'
       AND d."objectId"=p_creator_id
     LIMIT 1
  )
  AND NOT v_creator_internal THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format(
        'PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s',
        v_agency_id,p_creator_id,p_table_name
      );
  END IF;
END;
$$;

COMMIT;
