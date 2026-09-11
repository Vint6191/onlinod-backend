-- ONLINOD Phase 2 / Actual55 fresh-source INT5 closure.
--
-- A: broad DomainWork scheduling needs durable fairness metadata that is explicitly
--    non-authoritative for work truth; claims still come only from current DWI rows.
-- E: polymorphic Phase2DependencyState ownership can be retargeted by UPDATE, not
--    only created by INSERT. TeamShiftCreator's destructive SET NULL exemption is
--    narrowed to the FK detach itself.

ALTER TABLE "Phase2WorkFamilyState"
  ADD COLUMN IF NOT EXISTS "lastBroadClaimedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "Phase2WorkBroadClaimPartitionState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "partitionKey" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "lastClaimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2WorkBroadClaimPartitionState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Phase2WorkBroadClaimPartitionState_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Phase2WorkBroadClaimPartitionState_identity_key"
  ON "Phase2WorkBroadClaimPartitionState"("agencyId","workClass","partitionKey");

CREATE INDEX IF NOT EXISTS "Phase2WorkBroadClaimPartitionState_claim_idx"
  ON "Phase2WorkBroadClaimPartitionState"("agencyId","workClass","activeGeneration","lastClaimedAt","partitionKey");

-- Broad admission first finds one physical head per partition, so this index makes
-- that operation scale with partition heads instead of locking/scanning a 4096-row
-- prefix from one hot partition.
CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_agency_partition_due_v3_idx"
  ON "DomainWorkItem"("agencyId","workClass","activeGeneration","partitionKey","availableAt","id")
  WHERE "isOutstanding"=TRUE;

DROP INDEX IF EXISTS "Phase2WorkFamilyState_claim_v3_idx";
CREATE INDEX "Phase2WorkFamilyState_claim_v3_idx"
  ON "Phase2WorkFamilyState"("workClass","activeGeneration","lastBroadClaimedAt","lastRequestedAt","agencyId")
  WHERE "outstandingCount">0;

-- UPDATE can retarget an existing dependency row into a deleting Creator after the
-- cleanup worker has proved zero. Reuse the INT4 trigger function for both INSERT
-- and UPDATE so the proof-zero fence covers the complete mutation surface.
DROP TRIGGER IF EXISTS "phase2_creator_dependency_insert_fence" ON "Phase2DependencyState";
CREATE TRIGGER "phase2_creator_dependency_insert_fence"
BEFORE INSERT OR UPDATE ON "Phase2DependencyState"
FOR EACH ROW
EXECUTE FUNCTION "phase2_fence_creator_dependency_insert_during_creator_delete"();

-- Narrow the TeamShiftCreator exception from "creatorRefId becomes NULL" to the
-- exact FK detach: every other column must remain byte-for-byte identical. This
-- prevents an arbitrary UPDATE from piggybacking on the destructive SET NULL path.
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

  IF TG_TABLE_NAME = 'TeamShiftCreator'
     AND TG_OP = 'UPDATE'
     AND NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorRefId', '')), '') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorRefId', '')), '') IS NULL
     AND (to_jsonb(NEW) - 'creatorRefId') = (to_jsonb(OLD) - 'creatorRefId') THEN
    RETURN NEW;
  END IF;

  IF v_creator_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_agency_id, v_creator_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

-- Ownership UPDATEs must fence both sides of the move. Checking NEW alone lets a
-- stale writer move a row away from a deleting Agency/Creator after proof-zero and
-- thereby escape the destructive ownership set. DELETE remains cleanup authority.
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

CREATE OR REPLACE FUNCTION "phase2_fence_non_fk_tenant_insert_during_agency_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_agency_id text;
  v_new_agency_id text;
BEGIN
  v_new_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId', '')), '');
  IF TG_OP = 'UPDATE' THEN
    v_old_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'agencyId', '')), '');
    IF v_old_agency_id IS DISTINCT FROM v_new_agency_id THEN
      PERFORM "phase2_assert_agency_destructive_mutation_allowed"(v_old_agency_id, TG_TABLE_NAME);
    END IF;
  END IF;
  PERFORM "phase2_assert_agency_destructive_mutation_allowed"(v_new_agency_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

-- Direct creatorId carriers use the same two-sided ownership fence. The sole
-- exception is the exact TeamShiftCreator live-reference detach established above.
CREATE OR REPLACE FUNCTION "phase2_fence_direct_creator_insert_during_creator_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_agency_id text;
  v_old_creator_id text;
  v_new_agency_id text;
  v_new_creator_id text;
BEGIN
  v_new_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId', '')), '');
  v_new_creator_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorId', '')), '');

  IF TG_TABLE_NAME = 'TeamShiftCreator'
     AND TG_OP = 'UPDATE'
     AND NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorRefId', '')), '') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'creatorRefId', '')), '') IS NULL
     AND (to_jsonb(NEW) - 'creatorRefId') = (to_jsonb(OLD) - 'creatorRefId') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'agencyId', '')), '');
    v_old_creator_id := NULLIF(BTRIM(COALESCE(to_jsonb(OLD)->>'creatorId', '')), '');
    IF v_old_creator_id IS NOT NULL
       AND (v_old_creator_id IS DISTINCT FROM v_new_creator_id OR v_old_agency_id IS DISTINCT FROM v_new_agency_id) THEN
      PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_old_agency_id, v_old_creator_id, TG_TABLE_NAME);
    END IF;
  END IF;

  IF v_new_creator_id IS NOT NULL THEN
    PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_new_agency_id, v_new_creator_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_assert_indirect_creator_residual_row_allowed"(
  p_table_name text,
  p_row jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id text;
  v_creator_id text;
  v_candidate text;
  v_ref text;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(p_row->>'agencyId', '')), '');
  v_creator_id := NULLIF(BTRIM(COALESCE(p_row->>'creatorId', '')), '');
  IF v_agency_id IS NULL THEN RETURN; END IF;

  IF p_table_name = 'DomainWorkItem'
     AND COALESCE(p_row->>'workClass', '') = 'DESTRUCTIVE_CREATOR_CLEANUP'
     AND COALESCE(p_row->>'objectType', '') = 'Phase2CreatorDestructiveCleanup' THEN
    RETURN;
  END IF;

  IF p_table_name IN ('ProviderOperationalDebt', 'TelegramInboundEvent') THEN
    v_ref := NULLIF(BTRIM(COALESCE(p_row->>'customOrderId', '')), '');
    IF v_ref IS NOT NULL THEN
      SELECT o."creatorId" INTO v_candidate
        FROM "CustomOrder" o
       WHERE o."agencyId" = v_agency_id AND o."id" = v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s order=%s', p_table_name, v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=%s order=%s', p_table_name, v_ref);
      END IF;
    END IF;

    v_ref := CASE WHEN p_table_name='ProviderOperationalDebt'
      THEN NULLIF(BTRIM(COALESCE(p_row->>'customSubmissionId', '')), '')
      ELSE NULLIF(BTRIM(COALESCE(p_row->>'submissionId', '')), '') END;
    IF v_ref IS NOT NULL THEN
      SELECT s."creatorId" INTO v_candidate
        FROM "CustomContentSubmission" s
       WHERE s."agencyId" = v_agency_id AND s."id" = v_ref;
      IF FOUND THEN
        IF v_creator_id IS NOT NULL AND v_creator_id <> v_candidate THEN
          RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=format('PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s submission=%s', p_table_name, v_ref);
        END IF;
        v_creator_id := COALESCE(v_creator_id, v_candidate);
      ELSIF v_creator_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE=format('PHASE2_CREATOR_OWNER_PARENT_ABSENT table=%s submission=%s', p_table_name, v_ref);
      END IF;
    END IF;
  ELSIF p_table_name = 'AutomationJob' THEN
    v_candidate := NULLIF(BTRIM(COALESCE(p_row->>'accountId', '')), '');
    IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=AutomationJob accountId';
    END IF;
    v_creator_id := COALESCE(v_creator_id, v_candidate);

    v_ref := NULLIF(BTRIM(COALESCE(p_row->>'taskId', '')), '');
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
  ELSIF p_table_name = 'DomainWorkItem' THEN
    IF COALESCE(p_row->>'objectType', '') = 'CreatorAccount' THEN
      v_candidate := NULLIF(BTRIM(COALESCE(p_row->>'objectId', '')), '');
      IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem objectType=CreatorAccount';
      END IF;
      v_creator_id := COALESCE(v_creator_id, v_candidate);
    END IF;
    IF COALESCE(p_row->>'dependencyKind', '') = 'CREATOR_BINDING' THEN
      v_candidate := NULLIF(BTRIM(COALESCE(p_row->>'dependencyKey', '')), '');
      IF v_creator_id IS NOT NULL AND v_candidate IS NOT NULL AND v_creator_id <> v_candidate THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PHASE2_CREATOR_OWNERSHIP_CONFLICT table=DomainWorkItem dependency=CREATOR_BINDING';
      END IF;
      v_creator_id := COALESCE(v_creator_id, v_candidate);
    END IF;
    IF COALESCE(p_row->>'objectType', '') = 'CustomOrder' THEN
      v_ref := NULLIF(BTRIM(COALESCE(p_row->>'objectId', '')), '');
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
    ELSIF COALESCE(p_row->>'objectType', '') = 'CustomContentSubmission' THEN
      v_ref := NULLIF(BTRIM(COALESCE(p_row->>'objectId', '')), '');
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
    PERFORM "phase2_assert_creator_destructive_insert_allowed"(v_agency_id, v_creator_id, p_table_name);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_fence_indirect_creator_residual_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_old_signature jsonb;
  v_new_signature jsonb;
BEGIN
  v_new := to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF TG_TABLE_NAME IN ('ProviderOperationalDebt', 'TelegramInboundEvent') THEN
      v_old_signature := jsonb_build_array(v_old->>'agencyId',v_old->>'creatorId',v_old->>'customOrderId',v_old->>'customSubmissionId',v_old->>'submissionId');
      v_new_signature := jsonb_build_array(v_new->>'agencyId',v_new->>'creatorId',v_new->>'customOrderId',v_new->>'customSubmissionId',v_new->>'submissionId');
    ELSIF TG_TABLE_NAME = 'AutomationJob' THEN
      v_old_signature := jsonb_build_array(v_old->>'agencyId',v_old->>'creatorId',v_old->>'accountId',v_old->>'taskId');
      v_new_signature := jsonb_build_array(v_new->>'agencyId',v_new->>'creatorId',v_new->>'accountId',v_new->>'taskId');
    ELSE
      v_old_signature := jsonb_build_array(v_old->>'agencyId',v_old->>'creatorId',v_old->>'workClass',v_old->>'objectType',v_old->>'objectId',v_old->>'dependencyKind',v_old->>'dependencyKey');
      v_new_signature := jsonb_build_array(v_new->>'agencyId',v_new->>'creatorId',v_new->>'workClass',v_new->>'objectType',v_new->>'objectId',v_new->>'dependencyKind',v_new->>'dependencyKey');
    END IF;
    IF v_old_signature IS DISTINCT FROM v_new_signature THEN
      PERFORM "phase2_assert_indirect_creator_residual_row_allowed"(TG_TABLE_NAME, v_old);
    END IF;
  END IF;
  PERFORM "phase2_assert_indirect_creator_residual_row_allowed"(TG_TABLE_NAME, v_new);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_assert_creator_dependency_row_allowed"(
  p_agency_id text,
  p_dependency_kind text,
  p_dependency_key text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator_id text;
BEGIN
  IF p_dependency_kind = 'CREATOR_BINDING' THEN
    v_creator_id := NULLIF(BTRIM(p_dependency_key), '');
  ELSIF p_dependency_kind = 'REMINDER_OUTCOME' THEN
    SELECT o."creatorId" INTO v_creator_id
      FROM "CustomOrder" o
     WHERE o."agencyId" = p_agency_id
       AND o."id" = p_dependency_key
     LIMIT 1;
    IF v_creator_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = format('PHASE2_REMINDER_DEPENDENCY_PARENT_ABSENT agency=%s order=%s', p_agency_id, p_dependency_key);
    END IF;
  ELSE
    RETURN;
  END IF;
  PERFORM "phase2_assert_creator_destructive_insert_allowed"(p_agency_id, v_creator_id, 'Phase2DependencyState');
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_fence_creator_dependency_insert_during_creator_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(OLD."agencyId", OLD."dependencyKind", OLD."dependencyKey")
         IS DISTINCT FROM
         ROW(NEW."agencyId", NEW."dependencyKind", NEW."dependencyKey") THEN
    PERFORM "phase2_assert_creator_dependency_row_allowed"(OLD."agencyId", OLD."dependencyKind", OLD."dependencyKey");
  END IF;
  PERFORM "phase2_assert_creator_dependency_row_allowed"(NEW."agencyId", NEW."dependencyKind", NEW."dependencyKey");
  RETURN NEW;
END;
$$;
