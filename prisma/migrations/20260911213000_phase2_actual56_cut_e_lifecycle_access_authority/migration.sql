-- ONLINOD Phase 2 / Actual56 CUT E
-- Current creator-scope commit authority + indexed inverse lookup.

CREATE INDEX IF NOT EXISTS "AgencyMember_live_assignedCreators_gin_idx"
  ON "AgencyMember" USING GIN ("assignedCreators" jsonb_path_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "AgencyInvitation_pending_assignedCreators_gin_idx"
  ON "AgencyInvitation" USING GIN ("assignedCreators" jsonb_path_ops)
  WHERE "claimedAt" IS NULL AND "revokedAt" IS NULL;

CREATE OR REPLACE FUNCTION "phase2_scope_creator_ids"(p_scope jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE v_ids jsonb;
BEGIN
  IF p_scope IS NULL OR jsonb_typeof(p_scope) = 'null' THEN RETURN ARRAY[]::text[]; END IF;
  IF jsonb_typeof(p_scope) = 'array' THEN v_ids := p_scope;
  ELSIF jsonb_typeof(p_scope) = 'object' AND jsonb_typeof(p_scope->'ids')='array' THEN v_ids := p_scope->'ids';
  ELSIF jsonb_typeof(p_scope) = 'object' AND jsonb_typeof(p_scope->'creatorIds')='array' THEN v_ids := p_scope->'creatorIds';
  ELSE RETURN ARRAY[]::text[];
  END IF;
  RETURN COALESCE(ARRAY(SELECT DISTINCT BTRIM(value) FROM jsonb_array_elements_text(v_ids) value WHERE BTRIM(value)<>'' ORDER BY BTRIM(value)), ARRAY[]::text[]);
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_remove_creator_from_access_scope"(p_scope jsonb,p_creator_id text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE v_id text := BTRIM(COALESCE(p_creator_id,''));
DECLARE v_filtered jsonb;
BEGIN
  IF v_id='' OR p_scope IS NULL THEN RETURN p_scope; END IF;
  IF jsonb_typeof(p_scope)='array' THEN
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) INTO v_filtered
      FROM jsonb_array_elements_text(p_scope) WITH ORDINALITY e(value,ord) WHERE value<>v_id;
    RETURN v_filtered;
  END IF;
  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'ids')='array' THEN
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'ids') WITH ORDINALITY e(value,ord) WHERE value<>v_id;
    RETURN jsonb_set(p_scope,'{ids}',v_filtered,true);
  END IF;
  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'creatorIds')='array' THEN
    SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb) INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'creatorIds') WITH ORDINALITY e(value,ord) WHERE value<>v_id;
    RETURN jsonb_set(p_scope,'{creatorIds}',v_filtered,true);
  END IF;
  RETURN p_scope;
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_fence_creator_access_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_creator_id text;
DECLARE v_ids text[];
BEGIN
  v_ids := "phase2_scope_creator_ids"(NEW."assignedCreators");
  FOREACH v_creator_id IN ARRAY v_ids LOOP
    PERFORM 1
      FROM "CreatorAccount" c
     WHERE c."id"=v_creator_id
       AND c."agencyId"=NEW."agencyId"
       AND c."deletedAt" IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_SCOPE_RETIRED creator=%s agency=%s',v_creator_id,NEW."agencyId");
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AgencyMember_phase2_creator_scope_fence" ON "AgencyMember";
CREATE TRIGGER "AgencyMember_phase2_creator_scope_fence"
BEFORE INSERT OR UPDATE OF "assignedCreators","agencyId" ON "AgencyMember"
FOR EACH ROW EXECUTE FUNCTION "phase2_fence_creator_access_scope"();

DROP TRIGGER IF EXISTS "AgencyInvitation_phase2_creator_scope_fence" ON "AgencyInvitation";
CREATE TRIGGER "AgencyInvitation_phase2_creator_scope_fence"
BEFORE INSERT OR UPDATE OF "assignedCreators","agencyId" ON "AgencyInvitation"
FOR EACH ROW EXECUTE FUNCTION "phase2_fence_creator_access_scope"();

-- Current Team/access readers need one SQL-compatible scope predicate as well as
-- the JS normalizer. "all"/NULL are broad; arrays and {ids|creatorIds:[...]} are scoped.
CREATE OR REPLACE FUNCTION "phase2_scope_allows_creator"(p_scope jsonb,p_creator_id text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE v_mode text;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_creator_id,'')),'') IS NULL THEN RETURN FALSE; END IF;
  IF p_scope IS NULL OR jsonb_typeof(p_scope)='null' THEN RETURN TRUE; END IF;
  IF p_scope = '"all"'::jsonb THEN RETURN TRUE; END IF;
  IF jsonb_typeof(p_scope)='object' THEN
    IF COALESCE((p_scope->>'all')::boolean,FALSE) THEN RETURN TRUE; END IF;
    v_mode := LOWER(COALESCE(p_scope->>'mode',''));
    IF v_mode='all' THEN RETURN TRUE; END IF;
  END IF;
  RETURN BTRIM(p_creator_id) = ANY("phase2_scope_creator_ids"(p_scope));
EXCEPTION WHEN invalid_text_representation THEN
  RETURN BTRIM(p_creator_id) = ANY("phase2_scope_creator_ids"(p_scope));
END;
$$;

-- ---------------------------------------------------------------------------
-- DestructiveInternalAuthority
-- ---------------------------------------------------------------------------
-- A destructive DWI blocks stale/normal mutations. The claimed cleanup worker,
-- however, must be able to perform its own bounded barrier/cleanup transitions.
-- Authorization therefore requires BOTH a transaction-local execution token and
-- the matching durable outstanding destructive DWI. Merely setting a GUC or merely
-- having deletion pending is not enough.
CREATE OR REPLACE FUNCTION "phase2_internal_agency_destructive_authorized"(p_agency_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(BTRIM(COALESCE(p_agency_id,'')),'') IS NOT NULL
     AND current_setting('onlinod.phase2_destructive_agency_id', true) = BTRIM(p_agency_id)
     AND EXISTS (
       SELECT 1 FROM "DomainWorkItem" d
        WHERE d."agencyId"=BTRIM(p_agency_id)
          AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
          AND d."objectType"='Phase2AgencyDestructiveCleanup'
          AND d."objectId"=BTRIM(p_agency_id)
          AND d."isOutstanding"=TRUE
     );
$$;

CREATE OR REPLACE FUNCTION "phase2_internal_creator_destructive_authorized"(p_agency_id text,p_creator_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(BTRIM(COALESCE(p_agency_id,'')),'') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(p_creator_id,'')),'') IS NOT NULL
     AND current_setting('onlinod.phase2_destructive_creator_id', true) = BTRIM(p_creator_id)
     AND current_setting('onlinod.phase2_destructive_agency_id', true) = BTRIM(p_agency_id)
     AND EXISTS (
       SELECT 1 FROM "DomainWorkItem" d
        WHERE d."agencyId"=BTRIM(p_agency_id)
          AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
          AND d."objectType"='Phase2CreatorDestructiveCleanup'
          AND d."objectId"=BTRIM(p_creator_id)
          AND d."isOutstanding"=TRUE
     );
$$;

-- Agency fence: ordinary writes still fail closed. The claimed Agency cleanup
-- transaction may make bounded internal transitions (including seeding Creator
-- destructive barriers) without blocking itself on its own durable DWI.
CREATE OR REPLACE FUNCTION "phase2_assert_agency_destructive_mutation_allowed"(
  p_agency_id text,
  p_table_name text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id text;
  v_locked boolean;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(p_agency_id, '')), '');
  IF v_agency_id IS NULL THEN RETURN; END IF;

  IF "phase2_internal_agency_destructive_authorized"(v_agency_id) THEN
    RETURN;
  END IF;

  SELECT pg_try_advisory_xact_lock_shared(hashtext('agency-lifecycle:' || v_agency_id))
    INTO v_locked;
  IF NOT COALESCE(v_locked, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = format('PHASE2_AGENCY_LIFECYCLE_BUSY agency=%s table=%s', v_agency_id, p_table_name);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "Agency" a WHERE a."id" = v_agency_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('PHASE2_AGENCY_IDENTITY_ABSENT agency=%s table=%s', v_agency_id, p_table_name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId" = v_agency_id
       AND d."workClass" = 'DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType" = 'Phase2AgencyDestructiveCleanup'
       AND d."objectId" = v_agency_id
     LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s table=%s', v_agency_id, p_table_name);
  END IF;
END;
$$;

-- Creator fence shares the same rule. A child Creator cleanup composed under an
-- Agency cleanup is explicitly authorized for the parent Agency barrier, while a
-- normal writer remains blocked by either destructive authority.
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
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_creator_id, '')), '') IS NULL THEN RETURN; END IF;

  BEGIN
    SELECT c."agencyId"
      INTO v_agency_id
      FROM "CreatorAccount" c
     WHERE c."id" = p_creator_id
       AND (NULLIF(BTRIM(COALESCE(p_agency_id, '')), '') IS NULL OR c."agencyId" = p_agency_id)
     FOR KEY SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = format('PHASE2_CREATOR_LIFECYCLE_BUSY agency=%s creator=%s table=%s', COALESCE(p_agency_id, '?'), p_creator_id, p_table_name);
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('PHASE2_CREATOR_IDENTITY_ABSENT agency=%s creator=%s table=%s', COALESCE(p_agency_id, '?'), p_creator_id, p_table_name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId" = v_agency_id
       AND d."workClass" = 'DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType" = 'Phase2AgencyDestructiveCleanup'
       AND d."objectId" = v_agency_id
     LIMIT 1
  ) AND NOT "phase2_internal_agency_destructive_authorized"(v_agency_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s', v_agency_id, p_creator_id, p_table_name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId" = v_agency_id
       AND d."workClass" = 'DESTRUCTIVE_CREATOR_CLEANUP'
       AND d."objectType" = 'Phase2CreatorDestructiveCleanup'
       AND d."objectId" = p_creator_id
     LIMIT 1
  ) AND NOT "phase2_internal_creator_destructive_authorized"(v_agency_id,p_creator_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s', v_agency_id, p_creator_id, p_table_name);
  END IF;
END;
$$;

-- Cleanup DELETEs are not business mutations. Suppress only the two confirmed
-- creator-owned invalidation producers while a *claimed* destructive transaction
-- holds explicit internal authority. Normal DELETE/UPDATE/INSERT semantics remain.
CREATE OR REPLACE FUNCTION "phase2_intent_domain_work_trigger"()
RETURNS TRIGGER AS $$
DECLARE v_confirm_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF "phase2_internal_creator_destructive_authorized"(OLD."agencyId",OLD."creatorId")
       OR "phase2_internal_agency_destructive_authorized"(OLD."agencyId") THEN
      RETURN OLD;
    END IF;
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
      IF OLD."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') THEN
        PERFORM "phase2_bump_dependency"(OLD."agencyId",'REMINDER_OUTCOME',OLD."customOrderId");
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."kind" IN ('AUTO_REMINDER','MANUAL_REMINDER') AND
       (TG_OP='INSERT' OR OLD."state" IS DISTINCT FROM NEW."state" OR OLD."outcomeReason" IS DISTINCT FROM NEW."outcomeReason" OR OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt") THEN
      PERFORM "phase2_bump_dependency"(NEW."agencyId",'REMINDER_OUTCOME',NEW."customOrderId");
    END IF;
  END IF;

  IF TG_OP='INSERT' THEN
    v_confirm_changed := NEW."state"='CONFIRMED' OR NEW."projectionBlockedAt" IS NOT NULL;
  ELSE
    v_confirm_changed :=
      (NEW."state"='CONFIRMED' AND (
        OLD."state" IS DISTINCT FROM NEW."state" OR
        OLD."remoteMessageId" IS DISTINCT FROM NEW."remoteMessageId" OR
        OLD."remoteRecipientTelegramUserId" IS DISTINCT FROM NEW."remoteRecipientTelegramUserId" OR
        OLD."remoteSentAt" IS DISTINCT FROM NEW."remoteSentAt" OR
        OLD."confirmedAt" IS DISTINCT FROM NEW."confirmedAt" OR
        OLD."confirmationAuthority" IS DISTINCT FROM NEW."confirmationAuthority"
      )) OR
      (NEW."projectionBlockedAt" IS NOT NULL AND OLD."projectionBlockedAt" IS DISTINCT FROM NEW."projectionBlockedAt");
  END IF;

  IF v_confirm_changed THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_CONFIRMED_PROJECTION','TelegramDeliveryIntent',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    IF NEW."state"='CONFIRMED' AND NEW."remoteMessageId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(NEW."agencyId",'TELEGRAM_INBOUND_PROJECTION','TelegramDeliveryReceipt',NEW."id",COALESCE(NEW."accountId",NEW."creatorId"),NEW."creatorId",NEW."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."accountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "phase2_submission_domain_work_trigger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF "phase2_internal_creator_destructive_authorized"(OLD."agencyId",OLD."creatorId")
       OR "phase2_internal_agency_destructive_authorized"(OLD."agencyId") THEN
      RETURN OLD;
    END IF;
    IF OLD."customOrderId" IS NOT NULL THEN
      PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
    END IF;
    RETURN OLD;
  END IF;

  PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_SOURCE_PIPELINE','CustomContentSubmission',NEW."id",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  IF NEW."customOrderId" IS NOT NULL THEN
    PERFORM "phase2_publish_domain_work"(NEW."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',NEW."customOrderId",NEW."creatorId",NEW."creatorId",NEW."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;

  IF TG_OP='UPDATE' AND OLD."customOrderId" IS NOT NULL AND
     (OLD."customOrderId" IS DISTINCT FROM NEW."customOrderId" OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId") THEN
    PERFORM "phase2_publish_domain_work"(OLD."agencyId",'CUSTOM_COMMUNICATION','CustomOrder',OLD."customOrderId",OLD."creatorId",OLD."creatorId",OLD."telegramSourceAccountId",NULL,NULL,0,CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- Legacy current-state repair for CUT E
-- ---------------------------------------------------------------------------
-- Previous generations could leave explicit Creator ids in member/invitation
-- scope after Creator retirement, and TeamShiftCreator.creatorRefId could remain
-- attached across a soft retirement because the FK only reacts to hard DELETE.
-- Repair current operational edges once; historical ids remain untouched.
CREATE OR REPLACE FUNCTION "phase2_filter_live_creator_scope"(p_scope jsonb,p_agency_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_filtered jsonb;
BEGIN
  IF p_scope IS NULL OR jsonb_typeof(p_scope)='null' OR p_scope='"all"'::jsonb THEN RETURN p_scope; END IF;
  IF jsonb_typeof(p_scope)='object' AND (COALESCE((p_scope->>'all')::boolean,FALSE) OR LOWER(COALESCE(p_scope->>'mode',''))='all') THEN RETURN p_scope; END IF;

  IF jsonb_typeof(p_scope)='array' THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements_text(p_scope) WITH ORDINALITY e(value,ord)
     WHERE EXISTS (
       SELECT 1 FROM "CreatorAccount" c
        WHERE c."id"=BTRIM(e.value) AND c."agencyId"=p_agency_id AND c."deletedAt" IS NULL
     );
    RETURN v_filtered;
  END IF;

  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'ids')='array' THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'ids') WITH ORDINALITY e(value,ord)
     WHERE EXISTS (
       SELECT 1 FROM "CreatorAccount" c
        WHERE c."id"=BTRIM(e.value) AND c."agencyId"=p_agency_id AND c."deletedAt" IS NULL
     );
    RETURN jsonb_set(p_scope,'{ids}',v_filtered,true);
  END IF;

  IF jsonb_typeof(p_scope)='object' AND jsonb_typeof(p_scope->'creatorIds')='array' THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements_text(p_scope->'creatorIds') WITH ORDINALITY e(value,ord)
     WHERE EXISTS (
       SELECT 1 FROM "CreatorAccount" c
        WHERE c."id"=BTRIM(e.value) AND c."agencyId"=p_agency_id AND c."deletedAt" IS NULL
     );
    RETURN jsonb_set(p_scope,'{creatorIds}',v_filtered,true);
  END IF;

  RETURN p_scope;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN p_scope;
END;
$$;

WITH repaired AS (
  SELECT m."id", "phase2_filter_live_creator_scope"(m."assignedCreators",m."agencyId") AS next_scope
    FROM "AgencyMember" m
   WHERE m."deletedAt" IS NULL AND m."assignedCreators" IS NOT NULL
)
UPDATE "AgencyMember" m
   SET "assignedCreators"=r.next_scope,
       "accessEpoch"=m."accessEpoch"+1,
       "updatedAt"=CURRENT_TIMESTAMP
  FROM repaired r
 WHERE m."id"=r."id" AND m."assignedCreators" IS DISTINCT FROM r.next_scope;

WITH repaired AS (
  SELECT i."id", "phase2_filter_live_creator_scope"(i."assignedCreators",i."agencyId") AS next_scope
    FROM "AgencyInvitation" i
   WHERE i."claimedAt" IS NULL AND i."revokedAt" IS NULL AND i."assignedCreators" IS NOT NULL
)
UPDATE "AgencyInvitation" i
   SET "assignedCreators"=r.next_scope
  FROM repaired r
 WHERE i."id"=r."id" AND i."assignedCreators" IS DISTINCT FROM r.next_scope;

UPDATE "TeamShiftCreator" sc
   SET "creatorRefId"=NULL
  FROM "TeamShift" s
 WHERE s."id"=sc."shiftId"
   AND sc."creatorRefId" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "CreatorAccount" c
      WHERE c."id"=sc."creatorRefId"
        AND c."agencyId"=s."agencyId"
        AND c."deletedAt" IS NULL
   );
