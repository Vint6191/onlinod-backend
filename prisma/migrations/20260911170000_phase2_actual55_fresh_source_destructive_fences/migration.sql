-- Actual55 fresh-source destructive closure.
--
-- INT3 made Creator/Agency destruction bounded by physical rows, but a fresh-source
-- adversarial pass found three remaining gaps:
--   1) proof-zero non-FK roots could be recreated after a cleanup chunk proved zero;
--   2) Creator residual ownership can be indirect (order/submission/work identity),
--      so a creatorId-only fence is insufficient;
--   3) TeamShiftCreator used RESTRICT as a historical-retention guard, while the
--      INT3 worker deleted the assignment to get past the FK. Hard delete must keep
--      the historical planned-shift fact instead of silently erasing it.
--
-- The fences below cover INSERT and UPDATE because an existing non-FK row can
-- otherwise be retargeted into a deleting Agency/Creator after proof-zero. DELETE
-- remains available to destructive cleanup. PostgreSQL INSERT triggers also run on
-- the INSERT leg of INSERT ... ON CONFLICT DO UPDATE.

-- TeamShiftCreator is historical schedule evidence. Keep creatorId as a durable
-- immutable historical identity and move the live Creator relation onto creatorRefId.
-- Hard Creator deletion then SET NULLs only the live edge; the planned-shift fact survives.
ALTER TABLE "TeamShiftCreator"
  ADD COLUMN IF NOT EXISTS "creatorRefId" TEXT;

UPDATE "TeamShiftCreator"
   SET "creatorRefId" = "creatorId"
 WHERE "creatorRefId" IS NULL;

ALTER TABLE "TeamShiftCreator"
  DROP CONSTRAINT IF EXISTS "TeamShiftCreator_creatorId_fkey";

ALTER TABLE "TeamShiftCreator"
  ADD CONSTRAINT "TeamShiftCreator_creatorRefId_fkey"
  FOREIGN KEY ("creatorRefId") REFERENCES "CreatorAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "TeamShiftCreator_creatorRefId_shiftId_idx"
  ON "TeamShiftCreator"("creatorRefId", "shiftId");

CREATE OR REPLACE FUNCTION "phase2_fence_non_fk_tenant_insert_during_agency_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id text;
  v_locked boolean;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId', '')), '');
  IF v_agency_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Use the SAME canonical lifecycle advisory key as application Agency work, but
  -- never wait from a row trigger. A waiting trigger could hold an unrelated row
  -- while Agency destruction owns the lifecycle lock and later needs that row,
  -- producing a row <-> advisory deadlock. try-lock fails closed immediately.
  SELECT pg_try_advisory_xact_lock_shared(hashtext('agency-lifecycle:' || v_agency_id))
    INTO v_locked;
  IF NOT COALESCE(v_locked, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = format('PHASE2_AGENCY_LIFECYCLE_BUSY agency=%s table=%s', v_agency_id, TG_TABLE_NAME);
  END IF;

  -- While shared lifecycle authority is held, canonical hard deletion cannot remove
  -- Agency. Missing identity therefore means the insert is definitely stale.
  IF NOT EXISTS (SELECT 1 FROM "Agency" a WHERE a."id" = v_agency_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('PHASE2_AGENCY_IDENTITY_ABSENT agency=%s table=%s', v_agency_id, TG_TABLE_NAME);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId" = v_agency_id
       AND d."workClass" = 'DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType" = 'Phase2AgencyDestructiveCleanup'
       AND d."objectId" = v_agency_id
     LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s table=%s', v_agency_id, TG_TABLE_NAME);
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'ProviderOperationalDebt',
    'TelegramDeliveryIntent',
    'TelegramInboundEvent',
    'RefreshSession',
    'AnalyticsCollectionDemand',
    'DeviceCommand',
    'AutomationTask',
    'AutomationJob',
    'AutomationEvent',
    'ContentUsageEvent',
    'BumpDeliveryStat',
    'TeamSentMessageLedger',
    'TeamPpvPurchaseLedger',
    'TeamTipLedger',
    'TeamPpvResolveJob'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "phase2_non_fk_tenant_insert_fence" ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER "phase2_non_fk_tenant_insert_fence" BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "phase2_fence_non_fk_tenant_insert_during_agency_delete"()',
      v_table
    );
  END LOOP;
END;
$$;

-- Shared creator hard-delete guard used by direct and indirect residual-root
-- triggers. A producer that wins Creator KEY SHARE first is visible to the later
-- destructive transaction. If destructive work owns Creator FOR UPDATE first, the
-- producer fails NOWAIT instead of participating in a lock cycle. Between cleanup
-- chunks, durable destructive DomainWork makes all new creator-owned residual work
-- fail closed even though the Creator identity still exists.
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
  IF NULLIF(BTRIM(COALESCE(p_creator_id, '')), '') IS NULL THEN
    RETURN;
  END IF;

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
  ) THEN
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
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format('PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s', v_agency_id, p_creator_id, p_table_name);
  END IF;
END;
$$;

-- Direct creatorId residual/history rows. TeamShiftCreator is intentionally NOT
-- deleted by Creator hard-delete; this trigger only prevents a stale scheduler from
-- appending a new assignment after irreversible hard-delete intent has started.
CREATE OR REPLACE FUNCTION "phase2_fence_direct_creator_insert_during_creator_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id text;
  v_creator_id text;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId', '')), '');
  v_creator_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorId', '')), '');

  -- Bounded Creator cleanup (and the final FK action) intentionally detach only
  -- TeamShiftCreator.creatorRefId while preserving historical creatorId. Do not
  -- let the mutation fence block that one-way live-reference release. Rebinding
  -- creatorRefId or changing creatorId still goes through the normal fence.
  IF TG_TABLE_NAME = 'TeamShiftCreator'
     AND TG_OP = 'UPDATE'
     AND NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorId', '')), '') IS NOT DISTINCT FROM v_creator_id
     AND NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorRefId', '')), '') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorRefId', '')), '') IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_creator_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_agency_id, v_creator_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'TelegramDeliveryIntent',
    'TeamSentMessageLedger',
    'TeamPpvPurchaseLedger',
    'TeamTipLedger',
    'TeamPpvResolveJob',
    'AutomationTask',
    'TeamShiftCreator'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "phase2_direct_creator_insert_fence" ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER "phase2_direct_creator_insert_fence" BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "phase2_fence_direct_creator_insert_during_creator_delete"()',
      v_table
    );
  END LOOP;
END;
$$;

-- Provider debt / Telegram inbound / DomainWork can carry Creator ownership without
-- creatorId. Resolve the same semantic identities used by bounded cleanup, then join
-- the Creator hard-delete fence. If the only ownership reference is already orphaned,
-- fail closed: allowing it would create a row the Creator worker can no longer prove.
CREATE OR REPLACE FUNCTION "phase2_fence_indirect_creator_residual_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_row jsonb;
  v_agency_id text;
  v_creator_id text;
  v_candidate text;
  v_ref text;
BEGIN
  v_row := to_jsonb(NEW);
  v_agency_id := NULLIF(BTRIM(COALESCE(v_row->>'agencyId', '')), '');
  v_creator_id := NULLIF(BTRIM(COALESCE(v_row->>'creatorId', '')), '');
  IF v_agency_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'DomainWorkItem'
     AND COALESCE(v_row->>'workClass', '') = 'DESTRUCTIVE_CREATOR_CLEANUP'
     AND COALESCE(v_row->>'objectType', '') = 'Phase2CreatorDestructiveCleanup' THEN
    -- The cleanup authority itself intentionally has creatorId=NULL and must be
    -- publishable after the durable Creator DELETING barrier is set.
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME IN ('ProviderOperationalDebt', 'TelegramInboundEvent') THEN
    v_ref := NULLIF(BTRIM(COALESCE(v_row->>'customOrderId', '')), '');
    IF v_ref IS NOT NULL THEN
      SELECT o."creatorId" INTO v_candidate
        FROM "CustomOrder" o
       WHERE o."agencyId" = v_agency_id AND o."id" = v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s order=%s', TG_TABLE_NAME, v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=%s order=%s', TG_TABLE_NAME, v_ref);
      END IF;
    END IF;

    v_ref := CASE WHEN TG_TABLE_NAME='ProviderOperationalDebt'
      THEN NULLIF(BTRIM(COALESCE(v_row->>'customSubmissionId', '')), '')
      ELSE NULLIF(BTRIM(COALESCE(v_row->>'submissionId', '')), '') END;
    IF v_ref IS NOT NULL THEN
      SELECT s."creatorId" INTO v_candidate
        FROM "CustomContentSubmission" s
       WHERE s."agencyId" = v_agency_id AND s."id" = v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s submission=%s', TG_TABLE_NAME, v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=%s submission=%s', TG_TABLE_NAME, v_ref);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'AutomationJob' THEN
    v_candidate := NULLIF(BTRIM(COALESCE(v_row->>'accountId', '')), '');
    IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=AutomationJob accountId';
    END IF;
    v_creator_id := COALESCE(v_creator_id, v_candidate);

    v_ref := NULLIF(BTRIM(COALESCE(v_row->>'taskId', '')), '');
    IF v_ref IS NOT NULL THEN
      SELECT t."creatorId" INTO v_candidate
        FROM "AutomationTask" t
       WHERE t."agencyId" = v_agency_id AND t."id" = v_ref;
      IF FOUND AND v_candidate IS NOT NULL THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=AutomationJob task=%s', v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'DomainWorkItem' THEN
    IF COALESCE(v_row->>'objectType', '') = 'CreatorAccount' THEN
      v_candidate := NULLIF(BTRIM(COALESCE(v_row->>'objectId', '')), '');
      IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem objectType=CreatorAccount';
      END IF;
      v_creator_id := COALESCE(v_creator_id, v_candidate);
    END IF;
    IF COALESCE(v_row->>'dependencyKind', '') = 'CREATOR_BINDING' THEN
      v_candidate := NULLIF(BTRIM(COALESCE(v_row->>'dependencyKey', '')), '');
      IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem dependency=CREATOR_BINDING';
      END IF;
      v_creator_id := COALESCE(v_creator_id, v_candidate);
    END IF;
    IF COALESCE(v_row->>'objectType', '') = 'CustomOrder' THEN
      v_ref := NULLIF(BTRIM(COALESCE(v_row->>'objectId', '')), '');
      SELECT o."creatorId" INTO v_candidate FROM "CustomOrder" o
       WHERE o."agencyId"=v_agency_id AND o."id"=v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem order=%s', v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=DomainWorkItem order=%s', v_ref);
      END IF;
    ELSIF COALESCE(v_row->>'objectType', '') = 'CustomContentSubmission' THEN
      v_ref := NULLIF(BTRIM(COALESCE(v_row->>'objectId', '')), '');
      SELECT s."creatorId" INTO v_candidate FROM "CustomContentSubmission" s
       WHERE s."agencyId"=v_agency_id AND s."id"=v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem submission=%s', v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=DomainWorkItem submission=%s', v_ref);
      END IF;
    END IF;
  END IF;

  IF v_creator_id IS NOT NULL THEN
    PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_agency_id, v_creator_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['ProviderOperationalDebt', 'TelegramInboundEvent', 'AutomationJob', 'DomainWorkItem'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "phase2_indirect_creator_residual_insert_fence" ON %I', v_table);
    EXECUTE format(
      'CREATE TRIGGER "phase2_indirect_creator_residual_insert_fence" BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "phase2_fence_indirect_creator_residual_insert"()',
      v_table
    );
  END LOOP;
END;
$$;

-- Phase2DependencyState is polymorphic and has no creatorId column. Fence the two
-- creator-owned dependency identities that hard Creator cleanup explicitly removes.
CREATE OR REPLACE FUNCTION "phase2_fence_creator_dependency_insert_during_creator_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator_id text;
BEGIN
  IF NEW."dependencyKind" = 'CREATOR_BINDING' THEN
    v_creator_id := NULLIF(BTRIM(NEW."dependencyKey"), '');
  ELSIF NEW."dependencyKind" = 'REMINDER_OUTCOME' THEN
    SELECT o."creatorId"
      INTO v_creator_id
      FROM "CustomOrder" o
     WHERE o."agencyId" = NEW."agencyId"
       AND o."id" = NEW."dependencyKey"
     LIMIT 1;
    IF v_creator_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = format('PHASE2_REMINDER_DEPENDENCY_PARENT_ABSENT agency=%s order=%s', NEW."agencyId", NEW."dependencyKey");
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM "phase2_assert_creator_destructive_insert_allowed"(NEW."agencyId", v_creator_id, 'Phase2DependencyState');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "phase2_creator_dependency_insert_fence" ON "Phase2DependencyState";
CREATE TRIGGER "phase2_creator_dependency_insert_fence"
BEFORE INSERT ON "Phase2DependencyState"
FOR EACH ROW
EXECUTE FUNCTION "phase2_fence_creator_dependency_insert_during_creator_delete"();
