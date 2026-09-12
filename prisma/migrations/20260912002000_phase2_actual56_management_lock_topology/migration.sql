-- ONLINOD Phase 2 / Actual56 final closure B.
-- C2-A: creator-scope writes only fence newly introduced Creator IDs.
-- Removing C1 from [C1,C2] must not re-lock retained C2 after the member row is
-- already locked by Creator C1 retirement; otherwise two concurrent retirements can
-- form C1 -> Member -> C2 / C2 -> Member deadlocks.

CREATE OR REPLACE FUNCTION "phase2_fence_creator_access_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator_id text;
  v_new_ids text[];
  v_old_ids text[];
  v_ids_to_fence text[];
BEGIN
  v_new_ids := "phase2_scope_creator_ids"(NEW."assignedCreators");

  IF TG_OP='INSERT' OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId" THEN
    SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::text[])
      INTO v_ids_to_fence
      FROM unnest(v_new_ids) AS u(x);
  ELSE
    v_old_ids := "phase2_scope_creator_ids"(OLD."assignedCreators");
    SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::text[])
      INTO v_ids_to_fence
      FROM unnest(v_new_ids) AS u(x)
     WHERE NOT (x = ANY(v_old_ids));
  END IF;

  FOREACH v_creator_id IN ARRAY v_ids_to_fence LOOP
    PERFORM 1
      FROM "CreatorAccount" c
     WHERE c."id"=v_creator_id
       AND c."agencyId"=NEW."agencyId"
       AND c."deletedAt" IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE='23503',
        MESSAGE=format('PHASE2_CREATOR_SCOPE_RETIRED creator=%s agency=%s',v_creator_id,NEW."agencyId");
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
