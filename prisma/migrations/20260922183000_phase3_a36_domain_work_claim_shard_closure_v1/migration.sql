-- ONLINOD Phase 3 / A36 DomainWork two-axis scale closure.
--
-- DomainWorkItem remains the only executable-work truth.  Admission uses three
-- rebuildable, current-only locator levels:
--   agency dispatch -> fixed per-agency shard dispatch -> partition dispatch.
-- Agency and shard reservations commit before physical DWI locking, so global
-- fairness and intra-agency parallelism never reverse the canonical mutation
-- order (DWI -> partition -> shard -> agency).  Every physical claim revalidates
-- indexed DWI truth and uses SKIP LOCKED.  Every writer-side locator mutation is
-- deferred and transaction-batched so nested or multi-row writers reconcile the
-- complete touched hierarchy once, in canonical order, at commit.
-- Cardinality contract for A Agencies x C current creator partitions:
--   Agency locators O(A), shard locators O(A * min(128,C)), partitions O(A*C).
-- A and C are independent production axes: 1000+ Agencies x 1000+ creators
-- per Agency means 1M+ current identities, not a single 4000-creator dimension.
-- A claim touches only its bounded batch/quantum plus at most 128 repair shards;
-- it never enumerates A, C, A*C, or lifetime DONE history.
--
-- Populated upgrades are deliberately split across the deployment boundary:
--   online preflight -> this short EXPAND/live-producer cutover -> resumable
--   current-only backfill -> physical validation -> ACTIVE.
-- This migration never builds a populated index or enumerates A*C while holding
-- a DomainWorkItem writer lock.  Direct `prisma migrate deploy` on a populated
-- installation fails closed unless the concurrent-index preflight has run.

BEGIN;

CREATE OR REPLACE FUNCTION "phase3_domain_work_claim_shard"(p_partition TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (((hashtextextended(COALESCE(p_partition,''),0) % 128) + 128) % 128)::INTEGER;
$$;

CREATE OR REPLACE FUNCTION "phase3_domain_work_claimable_at"(
  p_state TEXT,
  p_available_at TIMESTAMP(3),
  p_next_attempt_at TIMESTAMP(3),
  p_lease_until TIMESTAMP(3)
)
RETURNS TIMESTAMP(3)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_state='READY' THEN GREATEST(p_available_at,COALESCE(p_next_attempt_at,p_available_at))
    WHEN p_state='CLAIMED' THEN GREATEST(
      p_available_at,
      COALESCE(p_next_attempt_at,p_available_at),
      COALESCE(p_lease_until,p_available_at)
    )
    ELSE NULL
  END;
$$;

-- Dependency invalidation is itself durable work.  The old implementation
-- advanced the revision and synchronously rewrote every matching BLOCKED DWI
-- in the producer transaction.  An Agency-wide AUTO_PROVIDER change therefore
-- held the account/config writer open for O(all blocked creator work).  At
-- A Agencies x C creators this becomes a repeated lock/WAL fan-out, not a
-- bounded control-plane mutation.
--
-- Use a new work class rather than a new object type in the legacy
-- DEPENDENCY_FANOUT class.  Rolling pre-A36 replicas never claim an unknown
-- class, so they cannot acknowledge the new wake protocol with their old
-- object-type fallback while the current-only topology is still BUILDING.
INSERT INTO "Phase2WorkGenerationAuthority"(
  "workClass","activeGeneration","projectionVersion","revision",
  "previousGeneration","activatedAt","createdAt","updatedAt"
) VALUES (
  'DEPENDENCY_WAKE','phase2_domain_work_v3_actual55',
  'phase2_domain_work_v3_actual55',1,NULL,
  CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
)
ON CONFLICT ("workClass") DO UPDATE SET
  "activeGeneration"=EXCLUDED."activeGeneration",
  "projectionVersion"=EXCLUDED."projectionVersion",
  "updatedAt"=CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION "phase2_bump_dependency"(
  p_agency TEXT,p_kind TEXT,p_key TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision BIGINT;
  v_id TEXT;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_agency,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_kind,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_key,'')),'') IS NULL THEN
    RETURN 0;
  END IF;

  v_id := 'p2dep_' || md5(p_agency || E'\x1f' || p_kind || E'\x1f' || p_key);
  INSERT INTO "Phase2DependencyState"(
    "id","agencyId","dependencyKind","dependencyKey","revision",
    "changedAt","createdAt","updatedAt"
  ) VALUES (
    v_id,p_agency,p_kind,p_key,1,
    CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  )
  ON CONFLICT ("agencyId","dependencyKind","dependencyKey") DO UPDATE SET
    "revision"="Phase2DependencyState"."revision"+1,
    "changedAt"=CURRENT_TIMESTAMP,
    "updatedAt"=CURRENT_TIMESTAMP
  RETURNING "revision" INTO v_revision;

  -- One coalescing durable identity per exact dependency.  No creator, Agency,
  -- history, or blocked-work enumeration is legal in this producer transaction.
  PERFORM "phase2_publish_domain_work"(
    p_agency,'DEPENDENCY_WAKE','DomainDependency',v_id,p_key,
    NULL,NULL,p_kind,p_key,v_revision,CURRENT_TIMESTAMP
  );
  RETURN v_revision;
END;
$$;

-- Wake at most p_limit physical rows and prove whether another bounded unit is
-- required.  SKIP LOCKED cannot be treated as completion: a locked BLOCKED row
-- is still visible to the final EXISTS probe and keeps the durable wake item
-- alive.  A concurrent newer bump increments the wake DWI revision, so normal
-- claim settlement restarts against the newer dependency revision.
CREATE OR REPLACE FUNCTION "phase3_wake_domain_dependency_batch"(
  p_agency TEXT,p_kind TEXT,p_key TEXT,p_revision BIGINT,p_limit INTEGER DEFAULT 100
)
RETURNS TABLE("woken" INTEGER,"remaining" BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit INTEGER := GREATEST(1,LEAST(COALESCE(p_limit,100),500));
  v_woken INTEGER := 0;
  v_remaining BOOLEAN := FALSE;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_agency,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_kind,'')),'') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_key,'')),'') IS NULL
     OR COALESCE(p_revision,0) <= 0 THEN
    RETURN QUERY SELECT 0,FALSE;
    RETURN;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT d."id"
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency
       AND d."state"='BLOCKED'
       AND d."isOutstanding"=TRUE
       AND d."dependencyKind"=p_kind
       AND d."dependencyKey"=p_key
       AND d."dependencyRevision" < p_revision
     ORDER BY d."dependencyRevision",d."id"
     LIMIT v_limit
     FOR UPDATE OF d SKIP LOCKED
  ), updated AS (
    UPDATE "DomainWorkItem" d
       SET "state"='READY',
           "isOutstanding"=TRUE,
           "availableAt"=CURRENT_TIMESTAMP,
           "nextAttemptAt"=NULL,
           "ownerToken"=NULL,
           "leaseUntil"=CURRENT_TIMESTAMP,
           "progressCursor"=NULL,
           "errorClass"=NULL,
           "lastError"=NULL,
           "terminalCause"=NULL,
           "updatedAt"=CURRENT_TIMESTAMP
      FROM candidates c
     WHERE d."id"=c."id"
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_woken FROM updated;

  SELECT EXISTS(
    SELECT 1
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency
       AND d."state"='BLOCKED'
       AND d."isOutstanding"=TRUE
       AND d."dependencyKind"=p_kind
       AND d."dependencyKey"=p_key
       AND d."dependencyRevision" < p_revision
     LIMIT 1
  ) INTO v_remaining;

  RETURN QUERY SELECT v_woken,v_remaining;
END;
$$;

-- Scoped access is a control-plane payload, not an unbounded runtime query.
-- The public Team contract already caps an explicit scope at 10k creators; make
-- that boundary true for every SQL writer before materializing it below.
DO $$
DECLARE
  v_populated BOOLEAN;
  v_constraint_valid BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM "AgencyMember" LIMIT 1) INTO v_populated;
  SELECT c.convalidated INTO v_constraint_valid
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname=current_schema()
     AND t.relname='AgencyMember'
     AND c.conname='AgencyMember_assignedCreators_cardinality_check';

  IF v_constraint_valid IS NULL THEN
    IF v_populated THEN
      RAISE EXCEPTION 'A36 populated AgencyMember scope requires online cardinality CHECK preflight';
    END IF;
    ALTER TABLE "AgencyMember"
      ADD CONSTRAINT "AgencyMember_assignedCreators_cardinality_check"
      CHECK (cardinality("phase2_scope_creator_ids"("assignedCreators")) <= 10000);
  ELSIF v_constraint_valid IS NOT TRUE THEN
    IF NOT v_populated THEN
      ALTER TABLE "AgencyMember"
        VALIDATE CONSTRAINT "AgencyMember_assignedCreators_cardinality_check";
    END IF;
    -- A populated table deliberately keeps this CHECK NOT VALID here. PostgreSQL
    -- enforces it for every new/changed row immediately; the online activator
    -- validates each current member in bounded keyset batches without scanning
    -- deleted membership history in one deployment transaction.
  END IF;
END;
$$;

-- Never acquire/retain ACCESS EXCLUSIVE on a populated A*C projection merely
-- because IF NOT EXISTS was written.  The online preflight commits the metadata
-- EXPAND and validates the CHECK in separate short/online transactions.  Fresh
-- empty installations can safely create the same shape here.
DO $$
DECLARE
  v_populated BOOLEAN;
  v_missing_columns TEXT[];
  v_constraint_valid BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM "Phase2WorkBroadClaimPartitionState" LIMIT 1) INTO v_populated;
  SELECT ARRAY_AGG(required_name ORDER BY required_name) INTO v_missing_columns
    FROM unnest(ARRAY['claimShard','nextClaimableAt','revision']) AS required(required_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema=current_schema()
        AND c.table_name='Phase2WorkBroadClaimPartitionState'
        AND c.column_name=required.required_name
   );

  IF COALESCE(array_length(v_missing_columns,1),0) > 0 THEN
    IF v_populated THEN
      RAISE EXCEPTION 'A36 populated partition topology requires online column EXPAND; missing=%',v_missing_columns;
    END IF;
    ALTER TABLE "Phase2WorkBroadClaimPartitionState"
      ADD COLUMN IF NOT EXISTS "claimShard" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "nextClaimableAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "revision" BIGINT NOT NULL DEFAULT 1;
  END IF;

  SELECT c.convalidated INTO v_constraint_valid
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname=current_schema()
     AND t.relname='Phase2WorkBroadClaimPartitionState'
     AND c.conname='Phase2WorkBroadClaimPartitionState_claimShard_check';

  IF v_constraint_valid IS NULL THEN
    IF v_populated THEN
      RAISE EXCEPTION 'A36 populated partition topology requires online CHECK preflight';
    END IF;
    ALTER TABLE "Phase2WorkBroadClaimPartitionState"
      ADD CONSTRAINT "Phase2WorkBroadClaimPartitionState_claimShard_check"
      CHECK ("claimShard" >= 0 AND "claimShard" < 128);
  ELSIF v_constraint_valid IS NOT TRUE THEN
    IF NOT v_populated THEN
      ALTER TABLE "Phase2WorkBroadClaimPartitionState"
        VALIDATE CONSTRAINT "Phase2WorkBroadClaimPartitionState_claimShard_check";
    END IF;
    -- Populated upgrades deliberately retain NOT VALID here.  It fences every
    -- new/changed row immediately, while the online activator rewrites current
    -- locators in bounded keyset batches instead of scanning A*C in migration.
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS "DomainWorkClaimAgencyState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "nextDispatchAt" TIMESTAMP(3) NOT NULL,
  "lastSelectedAt" TIMESTAMP(3),
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkClaimAgencyState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DomainWorkClaimAgencyState_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "DomainWorkClaimShardState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "claimShard" INTEGER NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "nextDispatchAt" TIMESTAMP(3) NOT NULL,
  "lastSelectedAt" TIMESTAMP(3),
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkClaimShardState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DomainWorkClaimShardState_agencyId_fkey"
    FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DomainWorkClaimShardState_claimShard_check"
    CHECK ("claimShard" >= 0 AND "claimShard" < 128)
);

-- Durable rollout authority.  Readers do not use the hierarchical locator
-- topology until the post-migration activator has completed every committed
-- keyset batch and proved that no current executable DWI lacks a complete
-- partition -> shard -> Agency path.  A fresh/empty database can activate in
-- this migration because there is nothing to enumerate.
CREATE TABLE IF NOT EXISTS "DomainWorkClaimTopologyState" (
  "id" TEXT NOT NULL,
  "generation" TEXT NOT NULL,
  "activationState" TEXT NOT NULL DEFAULT 'BUILDING',
  "cursorAgencyId" TEXT,
  "cursorWorkClass" TEXT,
  "cursorPartitionKey" TEXT,
  "cursorActiveGeneration" TEXT,
  "cursorWorkId" TEXT,
  "backfilledPartitions" BIGINT NOT NULL DEFAULT 0,
  "partitionsBackfilledAt" TIMESTAMP(3),
  "cursorMemberId" TEXT,
  "backfilledMembers" BIGINT NOT NULL DEFAULT 0,
  "membersBackfilledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkClaimTopologyState_pkey" PRIMARY KEY ("id")
);

-- The JSON field remains the management command/source representation.  These
-- two tables are rebuildable current projections for execution admission only:
-- exact member->creator grants and at most 128 non-empty scope shards/member.
-- No row is multiplied by Agency count, work history, or DomainWork count.
CREATE TABLE IF NOT EXISTS "AgencyMemberCreatorAccessCurrent" (
  "agencyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "accessEpoch" INTEGER NOT NULL,
  "claimShard" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgencyMemberCreatorAccessCurrent_identity_key"
    PRIMARY KEY ("memberId","creatorId"),
  CONSTRAINT "AgencyMemberCreatorAccessCurrent_claimShard_check"
    CHECK ("claimShard" >= 0 AND "claimShard" < 128)
);

CREATE TABLE IF NOT EXISTS "DomainWorkMemberScopeShardState" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "accessEpoch" INTEGER NOT NULL,
  "claimShard" INTEGER NOT NULL,
  "cursorCreatorId" TEXT,
  "lastSelectedAt" TIMESTAMP(3),
  "revision" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkMemberScopeShardState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DomainWorkMemberScopeShardState_claimShard_check"
    CHECK ("claimShard" >= 0 AND "claimShard" < 128)
);

CREATE INDEX IF NOT EXISTS "AgencyMemberCreatorAccessCurrent_claim_idx"
  ON "AgencyMemberCreatorAccessCurrent"("memberId","accessEpoch","claimShard","creatorId");
CREATE INDEX IF NOT EXISTS "AgencyMemberCreatorAccessCurrent_creator_idx"
  ON "AgencyMemberCreatorAccessCurrent"("agencyId","creatorId","memberId");
CREATE UNIQUE INDEX IF NOT EXISTS "DomainWorkMemberScopeShardState_identity_key"
  ON "DomainWorkMemberScopeShardState"("memberId","claimShard");
CREATE INDEX IF NOT EXISTS "DomainWorkMemberScopeShardState_claim_idx"
  ON "DomainWorkMemberScopeShardState"(
    "memberId","accessEpoch","lastSelectedAt","revision","claimShard"
  );
CREATE INDEX IF NOT EXISTS "DomainWorkMemberScopeShardState_agency_member_idx"
  ON "DomainWorkMemberScopeShardState"("agencyId","memberId");

-- Close destructive-lifecycle ownership for non-FK authorities introduced
-- after Actual55.  The canonical Agency fence is reused, with one narrow
-- exception: the already-claimed Agency destructive transaction may converge
-- its own projections while the durable delete barrier is present.  No caller
-- can manufacture this transaction-local token without first passing the
-- destructive DomainWork claim boundary.
CREATE OR REPLACE FUNCTION "phase2_fence_non_fk_tenant_insert_during_agency_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id TEXT;
  v_locked BOOLEAN;
  v_internal_agency_id TEXT;
  v_internal_work_id TEXT;
  v_internal_owner_token TEXT;
BEGIN
  v_agency_id := NULLIF(BTRIM(COALESCE(to_jsonb(NEW)->>'agencyId','')),'');
  IF v_agency_id IS NULL THEN RETURN NEW; END IF;

  SELECT pg_try_advisory_xact_lock_shared(hashtext('agency-lifecycle:' || v_agency_id))
    INTO v_locked;
  IF NOT COALESCE(v_locked,FALSE) THEN
    RAISE EXCEPTION USING
      ERRCODE='55P03',
      MESSAGE=format('PHASE2_AGENCY_LIFECYCLE_BUSY agency=%s table=%s',v_agency_id,TG_TABLE_NAME);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "Agency" a WHERE a."id"=v_agency_id) THEN
    RAISE EXCEPTION USING
      ERRCODE='23503',
      MESSAGE=format('PHASE2_AGENCY_IDENTITY_ABSENT agency=%s table=%s',v_agency_id,TG_TABLE_NAME);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId"=v_agency_id
       AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
       AND d."objectType"='Phase2AgencyDestructiveCleanup'
       AND d."objectId"=v_agency_id
     LIMIT 1
  ) THEN
    v_internal_agency_id := NULLIF(
      BTRIM(COALESCE(current_setting('onlinod.phase2_destructive_agency_id',TRUE),'')),''
    );
    v_internal_work_id := NULLIF(
      BTRIM(COALESCE(current_setting('onlinod.phase2_destructive_agency_work_id',TRUE),'')),''
    );
    v_internal_owner_token := NULLIF(
      BTRIM(COALESCE(current_setting('onlinod.phase2_destructive_agency_owner_token',TRUE),'')),''
    );
    IF v_internal_agency_id IS DISTINCT FROM v_agency_id OR NOT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."id"=v_internal_work_id
         AND d."agencyId"=v_agency_id
         AND d."workClass"='DESTRUCTIVE_AGENCY_CLEANUP'
         AND d."objectType"='Phase2AgencyDestructiveCleanup'
         AND d."objectId"=v_agency_id
         AND d."state"='CLAIMED'
         AND d."ownerToken"=v_internal_owner_token
         AND d."leaseUntil">clock_timestamp()
       LIMIT 1
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',
        MESSAGE=format('PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s table=%s',v_agency_id,TG_TABLE_NAME);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'AgencyMemberCreatorAccessCurrent',
    'DomainWorkMemberScopeShardState',
    'FanObservationReadLease',
    'FanObservationToken',
    'OfProviderRequestGateWaiter'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "phase2_non_fk_tenant_insert_fence" ON %I',v_table);
    EXECUTE format(
      'CREATE TRIGGER "phase2_non_fk_tenant_insert_fence" BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "phase2_fence_non_fk_tenant_insert_during_agency_delete"()',
      v_table
    );
  END LOOP;
END;
$$;

-- The grant projection intentionally permits an assigned creator identity to
-- be temporarily absent, so the generic direct-creator fence is too strict for
-- it.  Still serialize a present Creator against hard deletion, and preserve
-- the durable destructive DWI as a tombstone that rejects a late raw/projection
-- writer after physical identity removal.
CREATE OR REPLACE FUNCTION "phase3_fence_member_creator_access_during_creator_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_creator_agency_id TEXT;
BEGIN
  BEGIN
    SELECT c."agencyId" INTO v_creator_agency_id
      FROM "CreatorAccount" c
     WHERE c."id"=NEW."creatorId"
     FOR KEY SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING
      ERRCODE='55P03',
      MESSAGE=format(
        'PHASE2_CREATOR_LIFECYCLE_BUSY agency=%s creator=%s table=%s',
        NEW."agencyId",NEW."creatorId",TG_TABLE_NAME
      );
  END;

  IF v_creator_agency_id IS NOT NULL AND v_creator_agency_id IS DISTINCT FROM NEW."agencyId" THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE=format(
        'PHASE2_CREATOR_OWNERSHIP_CONFLICT table=%s agency=%s creator=%s',
        TG_TABLE_NAME,NEW."agencyId",NEW."creatorId"
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DomainWorkItem" d
     WHERE d."agencyId"=NEW."agencyId"
       AND d."workClass"='DESTRUCTIVE_CREATOR_CLEANUP'
       AND d."objectType"='Phase2CreatorDestructiveCleanup'
       AND d."objectId"=NEW."creatorId"
     LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format(
        'PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS agency=%s creator=%s table=%s',
        NEW."agencyId",NEW."creatorId",TG_TABLE_NAME
      );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "phase3_member_creator_access_destructive_fence"
  ON "AgencyMemberCreatorAccessCurrent";
CREATE TRIGGER "phase3_member_creator_access_destructive_fence"
BEFORE INSERT OR UPDATE ON "AgencyMemberCreatorAccessCurrent"
FOR EACH ROW
EXECUTE FUNCTION "phase3_fence_member_creator_access_during_creator_delete"();

-- These three rows are short-lived executable capabilities.  Unlike the
-- member grant projection they must never be recreated for a Creator whose
-- irreversible destructive work has started.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'FanObservationReadLease',
    'FanObservationToken',
    'OfProviderRequestGateWaiter'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS "phase2_direct_creator_insert_fence" ON %I',v_table);
    EXECUTE format(
      'CREATE TRIGGER "phase2_direct_creator_insert_fence" BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "phase2_fence_direct_creator_insert_during_creator_delete"()',
      v_table
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_member_has_broad_creator_access"(
  p_role TEXT,p_role_key TEXT,p_scope JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF UPPER(COALESCE(p_role,''))='OWNER' OR LOWER(COALESCE(p_role_key,''))='owner' THEN
    RETURN TRUE;
  END IF;
  IF p_scope IS NULL OR jsonb_typeof(p_scope)='null' OR p_scope='"all"'::jsonb THEN
    RETURN TRUE;
  END IF;
  IF jsonb_typeof(p_scope)='object' THEN
    IF LOWER(COALESCE(p_scope->>'mode',''))='all' THEN RETURN TRUE; END IF;
    BEGIN
      IF COALESCE((p_scope->>'all')::BOOLEAN,FALSE) THEN RETURN TRUE; END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN FALSE;
    END;
  END IF;
  RETURN FALSE;
END;
$$;

-- A scope/role/lifecycle writer cannot silently preserve an old execution
-- lease generation.  Application writers may advance by more than one; raw or
-- future writers that forget the bump are fenced here for the whole system.
CREATE OR REPLACE FUNCTION "phase3_fence_agency_member_access_epoch"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."accessEpoch" < OLD."accessEpoch" THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AGENCY_MEMBER_ACCESS_EPOCH_REGRESSION';
  END IF;
  IF OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId"
     OR OLD."role" IS DISTINCT FROM NEW."role"
     OR OLD."roleKey" IS DISTINCT FROM NEW."roleKey"
     OR OLD."permissions" IS DISTINCT FROM NEW."permissions"
     OR OLD."assignedCreators" IS DISTINCT FROM NEW."assignedCreators"
     OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt"
     OR OLD."deactivatedAt" IS DISTINCT FROM NEW."deactivatedAt" THEN
    IF NEW."accessEpoch" <= OLD."accessEpoch" THEN
      NEW."accessEpoch" := OLD."accessEpoch" + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_refresh_member_creator_scope"(p_member_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_member "AgencyMember"%ROWTYPE;
  v_count INTEGER := 0;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_member_id,'')),'') IS NULL THEN RETURN 0; END IF;

  DELETE FROM "DomainWorkMemberScopeShardState" s WHERE s."memberId"=p_member_id;
  DELETE FROM "AgencyMemberCreatorAccessCurrent" a WHERE a."memberId"=p_member_id;

  SELECT m.* INTO v_member FROM "AgencyMember" m WHERE m."id"=p_member_id;
  IF NOT FOUND OR v_member."deletedAt" IS NOT NULL OR v_member."deactivatedAt" IS NOT NULL
     OR "phase3_member_has_broad_creator_access"(
          v_member."role"::TEXT,v_member."roleKey",v_member."assignedCreators"
        ) THEN
    RETURN 0;
  END IF;

  -- Normalize the member grant itself, not a grant x current-Creator snapshot.
  -- Creator liveness is rechecked by each bounded reader.  This keeps soft
  -- delete/restore and later identity materialization from requiring an
  -- O(all members assigned to creator) fan-out rebuild.
  INSERT INTO "AgencyMemberCreatorAccessCurrent"(
    "agencyId","memberId","creatorId","accessEpoch","claimShard","createdAt","updatedAt"
  )
  SELECT v_member."agencyId",v_member."id",scope."creatorId",v_member."accessEpoch",
         "phase3_domain_work_claim_shard"(scope."creatorId"),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM unnest("phase2_scope_creator_ids"(v_member."assignedCreators")) AS scope("creatorId")
   ORDER BY scope."creatorId"
  ON CONFLICT ("memberId","creatorId") DO UPDATE SET
    "agencyId"=EXCLUDED."agencyId",
    "accessEpoch"=EXCLUDED."accessEpoch",
    "claimShard"=EXCLUDED."claimShard",
    "updatedAt"=CURRENT_TIMESTAMP;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO "DomainWorkMemberScopeShardState"(
    "id","agencyId","memberId","accessEpoch","claimShard","cursorCreatorId",
    "lastSelectedAt","revision","createdAt","updatedAt"
  )
  SELECT 'dwmsss_' || md5(v_member."id" || E'\x1f' || a."claimShard"::TEXT),
         v_member."agencyId",v_member."id",v_member."accessEpoch",a."claimShard",
         NULL,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM "AgencyMemberCreatorAccessCurrent" a
   WHERE a."memberId"=v_member."id" AND a."accessEpoch"=v_member."accessEpoch"
   GROUP BY a."claimShard"
   ORDER BY a."claimShard"
  ON CONFLICT ("memberId","claimShard") DO UPDATE SET
    "agencyId"=EXCLUDED."agencyId",
    "accessEpoch"=EXCLUDED."accessEpoch",
    "cursorCreatorId"=CASE
      WHEN "DomainWorkMemberScopeShardState"."accessEpoch"=EXCLUDED."accessEpoch"
        THEN "DomainWorkMemberScopeShardState"."cursorCreatorId"
      ELSE NULL END,
    "lastSelectedAt"=CASE
      WHEN "DomainWorkMemberScopeShardState"."accessEpoch"=EXCLUDED."accessEpoch"
        THEN "DomainWorkMemberScopeShardState"."lastSelectedAt"
      ELSE NULL END,
    "revision"="DomainWorkMemberScopeShardState"."revision"+1,
    "updatedAt"=CURRENT_TIMESTAMP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_refresh_member_creator_scope_trigger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "phase3_refresh_member_creator_scope"(
    CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END
  );
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Generation authority is a writer to the meaning of every current DWI even
-- when it does not touch a DWI row itself.  Fence that all-writer boundary: a
-- future/raw generation switch cannot leave an old locator graph advertised as
-- ACTIVE.  Member grants are generation-independent, so only the DWI cursor is
-- reset; the bounded post-migration activator will prove the new work graph.
CREATE OR REPLACE FUNCTION "phase3_invalidate_domain_work_claim_generation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."activeGeneration" IS DISTINCT FROM NEW."activeGeneration" THEN
    UPDATE "DomainWorkClaimTopologyState"
       SET "activationState"='BUILDING',
           "cursorAgencyId"=NULL,
           "cursorWorkClass"=NULL,
           "cursorPartitionKey"=NULL,
           "cursorActiveGeneration"=NULL,
           "cursorWorkId"=NULL,
           "backfilledPartitions"=0,
           "partitionsBackfilledAt"=NULL,
           "startedAt"=CURRENT_TIMESTAMP,
           "activatedAt"=NULL,
           "lastError"=NULL,
           "revision"="revision"+1,
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE "id"='phase3_domain_work_claim_topology_a36_v1';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Phase2WorkGenerationAuthority_phase3_claim_invalidate"
  ON "Phase2WorkGenerationAuthority";
CREATE TRIGGER "Phase2WorkGenerationAuthority_phase3_claim_invalidate"
AFTER UPDATE OF "activeGeneration" ON "Phase2WorkGenerationAuthority"
FOR EACH ROW
EXECUTE FUNCTION "phase3_invalidate_domain_work_claim_generation"();

-- Writer-side locator reconciliation is transaction-batched.  A DWI writer
-- records only transaction-private partition identities here; one deferred
-- flush reconciles every touched partition, then every touched shard, then every
-- touched Agency in deterministic global order.  This covers inserts, claims,
-- heartbeats, acknowledgements, blocks, retries, yields, and deletes regardless
-- of which application path performed the mutation.  It also prevents a
-- multi-row or nested-trigger writer from holding Agency A and later descending
-- back to another shard/partition in the same transaction.
-- The staging rows are unlogged because they are created and consumed inside
-- one transaction; the authoritative DWI and committed locator changes remain
-- fully WAL-logged and atomic at commit.
CREATE UNLOGGED TABLE IF NOT EXISTS "DomainWorkClaimLocatorMutationBatch" (
  "txId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkClaimLocatorMutationBatch_pkey" PRIMARY KEY ("txId")
);

CREATE UNLOGGED TABLE IF NOT EXISTS "DomainWorkClaimLocatorMutationIntent" (
  "txId" BIGINT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "workClass" TEXT NOT NULL,
  "partitionKey" TEXT NOT NULL,
  "activeGeneration" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainWorkClaimLocatorMutationIntent_identity_key"
    PRIMARY KEY ("txId","agencyId","workClass","partitionKey"),
  CONSTRAINT "DomainWorkClaimLocatorMutationIntent_txId_fkey"
    FOREIGN KEY ("txId") REFERENCES "DomainWorkClaimLocatorMutationBatch"("txId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "DomainWorkClaimLocatorMutationIntent_agency_idx"
  ON "DomainWorkClaimLocatorMutationIntent"("agencyId");

CREATE UNIQUE INDEX IF NOT EXISTS "DomainWorkClaimAgencyState_identity_key"
  ON "DomainWorkClaimAgencyState"("agencyId","workClass");
CREATE INDEX IF NOT EXISTS "DomainWorkClaimAgencyState_dispatch_idx"
  ON "DomainWorkClaimAgencyState"(
    "workClass","activeGeneration","nextDispatchAt","revision","agencyId"
  );
CREATE UNIQUE INDEX IF NOT EXISTS "DomainWorkClaimShardState_identity_key"
  ON "DomainWorkClaimShardState"("agencyId","workClass","claimShard");
CREATE INDEX IF NOT EXISTS "DomainWorkClaimShardState_dispatch_idx"
  ON "DomainWorkClaimShardState"(
    "agencyId","workClass","activeGeneration","nextDispatchAt","revision","claimShard"
  );
-- Physical fallback indexes keep every locator non-authoritative.  On an empty
-- installation ordinary CREATE INDEX is free.  On a populated installation
-- every large index must already be valid/ready from CREATE INDEX CONCURRENTLY;
-- fail closed instead of turning migration deploy into an unbounded writer stop.
DO $$
DECLARE
  v_dwi_populated BOOLEAN;
  v_partition_populated BOOLEAN;
  v_member_populated BOOLEAN;
  v_missing TEXT[];
BEGIN
  SELECT EXISTS(SELECT 1 FROM "DomainWorkItem" LIMIT 1) INTO v_dwi_populated;
  SELECT EXISTS(SELECT 1 FROM "Phase2WorkBroadClaimPartitionState" LIMIT 1) INTO v_partition_populated;
  SELECT EXISTS(SELECT 1 FROM "AgencyMember" LIMIT 1) INTO v_member_populated;

  IF v_dwi_populated THEN
    SELECT ARRAY_AGG(required_name ORDER BY required_name) INTO v_missing
      FROM unnest(ARRAY[
        'DomainWorkItem_claimable_global_a36_idx',
        'DomainWorkItem_claimable_partition_a36_idx',
        'DomainWorkItem_claimable_agency_shard_a36_idx',
        'DomainWorkItem_claimable_creator_a36_idx',
        'DomainWorkItem_current_activation_a36_idx'
      ]) AS required(required_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_index i
         JOIN pg_class idx ON idx.oid=i.indexrelid
         JOIN pg_class tbl ON tbl.oid=i.indrelid
         JOIN pg_namespace n ON n.oid=tbl.relnamespace
        WHERE n.nspname=current_schema() AND tbl.relname='DomainWorkItem'
          AND idx.relname=required.required_name
          AND i.indisvalid=TRUE AND i.indisready=TRUE
     );
    IF COALESCE(array_length(v_missing,1),0) > 0 THEN
      RAISE EXCEPTION 'A36 populated DomainWorkItem requires online index preflight; missing/invalid=%',v_missing;
    END IF;
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS "DomainWorkItem_claimable_global_a36_idx" ON "DomainWorkItem"("workClass","activeGeneration","phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),"agencyId","partitionKey","id") WHERE "isOutstanding"=TRUE AND "state" IN (''READY'',''CLAIMED'')';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "DomainWorkItem_claimable_partition_a36_idx" ON "DomainWorkItem"("agencyId","workClass","activeGeneration","partitionKey","phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),"id") WHERE "isOutstanding"=TRUE AND "state" IN (''READY'',''CLAIMED'')';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "DomainWorkItem_claimable_agency_shard_a36_idx" ON "DomainWorkItem"("agencyId","workClass","activeGeneration","phase3_domain_work_claim_shard"("partitionKey"),"phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),"partitionKey","id") WHERE "isOutstanding"=TRUE AND "state" IN (''READY'',''CLAIMED'')';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "DomainWorkItem_claimable_creator_a36_idx" ON "DomainWorkItem"("agencyId","workClass","activeGeneration","creatorId","phase3_domain_work_claimable_at"("state","availableAt","nextAttemptAt","leaseUntil"),"id") WHERE "isOutstanding"=TRUE AND "creatorId" IS NOT NULL AND "state" IN (''READY'',''CLAIMED'')';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_activation_a36_idx" ON "DomainWorkItem"("agencyId","workClass","partitionKey","activeGeneration","id") WHERE "isOutstanding"=TRUE';
  END IF;

  IF v_partition_populated THEN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class idx ON idx.oid=i.indexrelid
        JOIN pg_class tbl ON tbl.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=tbl.relnamespace
       WHERE n.nspname=current_schema()
         AND tbl.relname='Phase2WorkBroadClaimPartitionState'
         AND idx.relname='Phase2WorkBroadClaimPartitionState_shard_due_idx'
         AND i.indisvalid=TRUE AND i.indisready=TRUE
    ) THEN
      RAISE EXCEPTION 'A36 populated partition topology requires online index preflight';
    END IF;
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS "Phase2WorkBroadClaimPartitionState_shard_due_idx" ON "Phase2WorkBroadClaimPartitionState"("agencyId","workClass","activeGeneration","claimShard","nextClaimableAt","revision","partitionKey")';
  END IF;

  IF v_member_populated THEN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_class idx ON idx.oid=i.indexrelid
        JOIN pg_class tbl ON tbl.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=tbl.relnamespace
       WHERE n.nspname=current_schema()
         AND tbl.relname='AgencyMember'
         AND idx.relname='AgencyMember_current_activation_a36_idx'
         AND i.indisvalid=TRUE AND i.indisready=TRUE
    ) THEN
      RAISE EXCEPTION 'A36 populated AgencyMember requires online current-only index preflight';
    END IF;
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS "AgencyMember_current_activation_a36_idx" ON "AgencyMember"("id") WHERE "deletedAt" IS NULL AND "deactivatedAt" IS NULL';
  END IF;
END;
$$;

-- While a locator is intact the row trigger conserves its current membership
-- count, but that count is never execution authority.  A physically missing
-- locator is rebuilt from one indexed positive witness rather than COUNTing an
-- arbitrarily large partition. claimability writes are deliberately lower-only:
-- a mutation that makes work earlier is visible immediately. The deferred
-- writer boundary below raises/removes later or non-claimable work from every
-- locator level after physical revalidation.
CREATE OR REPLACE FUNCTION "phase2_track_domain_work_current_partition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_current_generation TEXT;
  v_new_current_generation TEXT;
  v_old_membership BOOLEAN := FALSE;
  v_new_membership BOOLEAN := FALSE;
  v_identity_changed BOOLEAN := FALSE;
  v_remove_transition BOOLEAN := FALSE;
  v_add_transition BOOLEAN := FALSE;
  v_old_partition_lock BIGINT;
  v_new_partition_lock BIGINT;
  v_old_due TIMESTAMP(3);
  v_new_due TIMESTAMP(3);
BEGIN
  IF TG_OP='UPDATE' AND OLD."workClass" IS NOT DISTINCT FROM NEW."workClass" THEN
    SELECT g."activeGeneration" INTO v_new_current_generation
      FROM "Phase2WorkGenerationAuthority" g
     WHERE g."workClass"=NEW."workClass";
    v_old_current_generation := v_new_current_generation;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      SELECT g."activeGeneration" INTO v_old_current_generation
        FROM "Phase2WorkGenerationAuthority" g
       WHERE g."workClass"=OLD."workClass";
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT g."activeGeneration" INTO v_new_current_generation
        FROM "Phase2WorkGenerationAuthority" g
       WHERE g."workClass"=NEW."workClass";
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    v_old_membership := OLD."isOutstanding" IS TRUE
      AND (v_old_current_generation IS NULL OR v_old_current_generation=OLD."activeGeneration");
    v_old_due := "phase3_domain_work_claimable_at"(
      OLD."state",OLD."availableAt",OLD."nextAttemptAt",OLD."leaseUntil"
    );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_membership := NEW."isOutstanding" IS TRUE
      AND (v_new_current_generation IS NULL OR v_new_current_generation=NEW."activeGeneration");
    v_new_due := "phase3_domain_work_claimable_at"(
      NEW."state",NEW."availableAt",NEW."nextAttemptAt",NEW."leaseUntil"
    );
  END IF;

  IF TG_OP='UPDATE' THEN
    v_identity_changed := OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
      OR OLD."workClass" IS DISTINCT FROM NEW."workClass"
      OR OLD."partitionKey" IS DISTINCT FROM NEW."partitionKey"
      OR OLD."activeGeneration" IS DISTINCT FROM NEW."activeGeneration";
  END IF;

  v_remove_transition := v_old_membership AND (
    TG_OP='DELETE' OR v_identity_changed OR NEW."isOutstanding" IS FALSE
  );
  v_add_transition := v_new_membership AND (
    TG_OP='INSERT' OR v_identity_changed OR OLD."isOutstanding" IS FALSE
  );

  -- Only exact membership edges need the shared advisory identity.  Ordinary
  -- due changes are one atomic lower-only row update and cannot lose an earlier
  -- concurrent publication.
  IF v_remove_transition THEN
    v_old_partition_lock := "phase2_domain_work_current_partition_lock_key"(
      OLD."agencyId",OLD."workClass",OLD."partitionKey"
    );
  END IF;
  IF v_add_transition THEN
    v_new_partition_lock := "phase2_domain_work_current_partition_lock_key"(
      NEW."agencyId",NEW."workClass",NEW."partitionKey"
    );
  END IF;

  IF v_old_partition_lock IS NOT NULL AND v_new_partition_lock IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(LEAST(v_old_partition_lock,v_new_partition_lock));
    IF v_old_partition_lock <> v_new_partition_lock THEN
      PERFORM pg_advisory_xact_lock(GREATEST(v_old_partition_lock,v_new_partition_lock));
    END IF;
  ELSIF v_old_partition_lock IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(v_old_partition_lock);
  ELSIF v_new_partition_lock IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(v_new_partition_lock);
  END IF;

  IF v_remove_transition THEN
    UPDATE "Phase2WorkBroadClaimPartitionState" f
       SET "outstandingCount"=f."outstandingCount"-1,
           "revision"=f."revision"+1,
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE f."agencyId"=OLD."agencyId"
       AND f."workClass"=OLD."workClass"
       AND f."partitionKey"=OLD."partitionKey"
       AND f."activeGeneration"=OLD."activeGeneration"
       AND f."outstandingCount" > 1;

    IF NOT FOUND THEN
      DELETE FROM "Phase2WorkBroadClaimPartitionState" f
       WHERE f."agencyId"=OLD."agencyId"
         AND f."workClass"=OLD."workClass"
         AND f."partitionKey"=OLD."partitionKey"
         AND f."activeGeneration"=OLD."activeGeneration"
         AND f."outstandingCount" = 1;
    END IF;
  END IF;

  IF v_add_transition THEN
    INSERT INTO "Phase2WorkBroadClaimPartitionState"(
      "id","agencyId","workClass","partitionKey","activeGeneration",
      "outstandingCount","claimShard","nextClaimableAt","lastClaimedAt","revision","createdAt","updatedAt"
    ) VALUES (
      'p2wbcps_' || md5(NEW."agencyId" || E'\x1f' || NEW."workClass" || E'\x1f' || NEW."partitionKey"),
      NEW."agencyId",NEW."workClass",NEW."partitionKey",NEW."activeGeneration",
      1,"phase3_domain_work_claim_shard"(NEW."partitionKey"),v_new_due,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration",
      "outstandingCount"=CASE
        WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
          THEN 1
        ELSE "Phase2WorkBroadClaimPartitionState"."outstandingCount"+1
      END,
      "claimShard"=EXCLUDED."claimShard",
      "nextClaimableAt"=CASE
        WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
          THEN EXCLUDED."nextClaimableAt"
        WHEN EXCLUDED."nextClaimableAt" IS NULL
          THEN "Phase2WorkBroadClaimPartitionState"."nextClaimableAt"
        WHEN "Phase2WorkBroadClaimPartitionState"."nextClaimableAt" IS NULL
          THEN EXCLUDED."nextClaimableAt"
        ELSE LEAST("Phase2WorkBroadClaimPartitionState"."nextClaimableAt",EXCLUDED."nextClaimableAt")
      END,
      "lastClaimedAt"=CASE
        WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
          THEN NULL ELSE "Phase2WorkBroadClaimPartitionState"."lastClaimedAt" END,
      "revision"="Phase2WorkBroadClaimPartitionState"."revision"+1,
      "updatedAt"=CURRENT_TIMESTAMP;
  ELSIF TG_OP='UPDATE' AND NOT v_identity_changed AND v_new_membership
        AND v_new_due IS NOT NULL
        AND (v_old_due IS NULL OR v_new_due < v_old_due) THEN
    UPDATE "Phase2WorkBroadClaimPartitionState" f
       SET "nextClaimableAt"=CASE
             WHEN v_new_due IS NULL THEN f."nextClaimableAt"
             WHEN f."nextClaimableAt" IS NULL THEN v_new_due
             ELSE LEAST(f."nextClaimableAt",v_new_due)
           END,
           "revision"=f."revision"+1,
           "updatedAt"=CURRENT_TIMESTAMP
     WHERE f."agencyId"=NEW."agencyId"
       AND f."workClass"=NEW."workClass"
       AND f."partitionKey"=NEW."partitionKey"
       AND f."activeGeneration"=NEW."activeGeneration";
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Statement triggers record transaction-private mutation identities.  The one
-- deferred batch trigger below is the writer-independent reconciliation
-- boundary.  Ordering only inside each DWI statement is insufficient: nested
-- row triggers can execute many DWI statements inside one outer transaction.
CREATE OR REPLACE FUNCTION "phase3_queue_domain_work_claim_locator_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_txid BIGINT := txid_current();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM new_rows LIMIT 1) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "DomainWorkClaimLocatorMutationBatch"("txId","createdAt")
  VALUES (v_txid,CURRENT_TIMESTAMP)
  ON CONFLICT ("txId") DO NOTHING;

  INSERT INTO "DomainWorkClaimLocatorMutationIntent"(
    "txId","agencyId","workClass","partitionKey","activeGeneration","createdAt"
  )
  SELECT DISTINCT v_txid,n."agencyId",n."workClass",n."partitionKey",
         COALESCE(g."activeGeneration",n."activeGeneration"),CURRENT_TIMESTAMP
    FROM new_rows n
    LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=n."workClass"
   WHERE n."isOutstanding"=TRUE
     AND (g."activeGeneration" IS NULL OR g."activeGeneration"=n."activeGeneration")
   ORDER BY n."agencyId",n."workClass",n."partitionKey",
            COALESCE(g."activeGeneration",n."activeGeneration")
  ON CONFLICT ("txId","agencyId","workClass","partitionKey") DO UPDATE SET
    "activeGeneration"=EXCLUDED."activeGeneration";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_queue_domain_work_claim_locator_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_txid BIGINT := txid_current();
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM old_rows o
      FULL JOIN new_rows n ON n."id"=o."id"
     WHERE o."id" IS NULL OR n."id" IS NULL
        OR o."agencyId" IS DISTINCT FROM n."agencyId"
        OR o."workClass" IS DISTINCT FROM n."workClass"
        OR o."partitionKey" IS DISTINCT FROM n."partitionKey"
        OR o."activeGeneration" IS DISTINCT FROM n."activeGeneration"
        OR o."isOutstanding" IS DISTINCT FROM n."isOutstanding"
        OR o."state" IS DISTINCT FROM n."state"
        OR o."availableAt" IS DISTINCT FROM n."availableAt"
        OR o."nextAttemptAt" IS DISTINCT FROM n."nextAttemptAt"
        OR o."leaseUntil" IS DISTINCT FROM n."leaseUntil"
     LIMIT 1
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "DomainWorkClaimLocatorMutationBatch"("txId","createdAt")
  VALUES (v_txid,CURRENT_TIMESTAMP)
  ON CONFLICT ("txId") DO NOTHING;

  WITH changed AS MATERIALIZED (
    SELECT o."id" AS "oldId",n."id" AS "newId"
      FROM old_rows o
      FULL JOIN new_rows n ON n."id"=o."id"
     WHERE o."id" IS NULL OR n."id" IS NULL
        OR o."agencyId" IS DISTINCT FROM n."agencyId"
        OR o."workClass" IS DISTINCT FROM n."workClass"
        OR o."partitionKey" IS DISTINCT FROM n."partitionKey"
        OR o."activeGeneration" IS DISTINCT FROM n."activeGeneration"
        OR o."isOutstanding" IS DISTINCT FROM n."isOutstanding"
        OR o."state" IS DISTINCT FROM n."state"
        OR o."availableAt" IS DISTINCT FROM n."availableAt"
        OR o."nextAttemptAt" IS DISTINCT FROM n."nextAttemptAt"
        OR o."leaseUntil" IS DISTINCT FROM n."leaseUntil"
  ), touched AS MATERIALIZED (
    SELECT o."agencyId",o."workClass",o."partitionKey",o."activeGeneration",o."isOutstanding"
      FROM old_rows o JOIN changed c ON c."oldId"=o."id"
    UNION
    SELECT n."agencyId",n."workClass",n."partitionKey",n."activeGeneration",n."isOutstanding"
      FROM new_rows n JOIN changed c ON c."newId"=n."id"
  )
  INSERT INTO "DomainWorkClaimLocatorMutationIntent"(
    "txId","agencyId","workClass","partitionKey","activeGeneration","createdAt"
  )
  SELECT DISTINCT v_txid,t."agencyId",t."workClass",t."partitionKey",
         COALESCE(g."activeGeneration",t."activeGeneration"),CURRENT_TIMESTAMP
    FROM touched t
    LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=t."workClass"
   WHERE t."isOutstanding"=TRUE
     AND (g."activeGeneration" IS NULL OR g."activeGeneration"=t."activeGeneration")
   ORDER BY t."agencyId",t."workClass",t."partitionKey",
            COALESCE(g."activeGeneration",t."activeGeneration")
  ON CONFLICT ("txId","agencyId","workClass","partitionKey") DO UPDATE SET
    "activeGeneration"=EXCLUDED."activeGeneration";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_queue_domain_work_claim_locator_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_txid BIGINT := txid_current();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM old_rows LIMIT 1) THEN
    RETURN NULL;
  END IF;

  INSERT INTO "DomainWorkClaimLocatorMutationBatch"("txId","createdAt")
  VALUES (v_txid,CURRENT_TIMESTAMP)
  ON CONFLICT ("txId") DO NOTHING;

  INSERT INTO "DomainWorkClaimLocatorMutationIntent"(
    "txId","agencyId","workClass","partitionKey","activeGeneration","createdAt"
  )
  SELECT DISTINCT v_txid,o."agencyId",o."workClass",o."partitionKey",
         COALESCE(g."activeGeneration",o."activeGeneration"),CURRENT_TIMESTAMP
    FROM old_rows o
    LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=o."workClass"
   WHERE o."isOutstanding"=TRUE
     AND (g."activeGeneration" IS NULL OR g."activeGeneration"=o."activeGeneration")
   ORDER BY o."agencyId",o."workClass",o."partitionKey",
            COALESCE(g."activeGeneration",o."activeGeneration")
  ON CONFLICT ("txId","agencyId","workClass","partitionKey") DO UPDATE SET
    "activeGeneration"=EXCLUDED."activeGeneration";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_flush_domain_work_claim_locator_mutations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_txid BIGINT := NEW."txId";
  v_touched_at TIMESTAMP(3) := clock_timestamp();
  v_intent RECORD;
BEGIN
  IF v_txid IS NULL OR v_txid <> txid_current() THEN
    RETURN NULL;
  END IF;

  -- Partition -> shard -> Agency is one global order for every DWI writer.
  -- The generation authority is resolved again at commit so a generation
  -- activation in the same transaction cannot leave old-generation locators.
  FOR v_intent IN
    SELECT i."agencyId",i."workClass",i."partitionKey",
           COALESCE(g."activeGeneration",i."activeGeneration") AS "activeGeneration"
      FROM "DomainWorkClaimLocatorMutationIntent" i
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=i."workClass"
     WHERE i."txId"=v_txid
     ORDER BY i."agencyId",i."workClass",i."partitionKey"
  LOOP
    PERFORM "phase3_reconcile_domain_work_claim_partition"(
      v_intent."agencyId",v_intent."workClass",v_intent."activeGeneration",
      v_intent."partitionKey",v_touched_at
    );
  END LOOP;

  FOR v_intent IN
    SELECT DISTINCT i."agencyId",i."workClass",
           COALESCE(g."activeGeneration",i."activeGeneration") AS "activeGeneration",
           "phase3_domain_work_claim_shard"(i."partitionKey") AS "claimShard"
      FROM "DomainWorkClaimLocatorMutationIntent" i
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=i."workClass"
     WHERE i."txId"=v_txid
     ORDER BY i."agencyId",i."workClass","claimShard"
  LOOP
    PERFORM "phase3_reconcile_domain_work_claim_shard"(
      v_intent."agencyId",v_intent."workClass",v_intent."activeGeneration",
      v_intent."claimShard",v_touched_at
    );
  END LOOP;

  FOR v_intent IN
    SELECT DISTINCT i."agencyId",i."workClass",
           COALESCE(g."activeGeneration",i."activeGeneration") AS "activeGeneration"
      FROM "DomainWorkClaimLocatorMutationIntent" i
      LEFT JOIN "Phase2WorkGenerationAuthority" g ON g."workClass"=i."workClass"
     WHERE i."txId"=v_txid
     ORDER BY i."agencyId",i."workClass",
              COALESCE(g."activeGeneration",i."activeGeneration")
  LOOP
    PERFORM "phase3_reconcile_domain_work_claim_agency"(
      v_intent."agencyId",v_intent."workClass",v_intent."activeGeneration",v_touched_at
    );
  END LOOP;

  DELETE FROM "DomainWorkClaimLocatorMutationBatch" b WHERE b."txId"=v_txid;
  RETURN NULL;
END;
$$;

-- Exact raises/deletes happen only after physical revalidation, in a new SQL
-- statement.  Revision-CAS means a concurrent earlier publication always wins.
CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_partition"(
  p_agency TEXT,p_work_class TEXT,p_generation TEXT,p_partition TEXT,p_touched_at TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision BIGINT;
  v_count INTEGER;
  v_exists BOOLEAN;
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL OR p_partition IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p."revision" INTO v_revision
    FROM "Phase2WorkBroadClaimPartitionState" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class AND p."partitionKey"=p_partition;

  -- Locators are rebuildable positive witnesses, never count authority.  Even
  -- exceptional loss must stay bounded: prove one physical member and seek one
  -- claimable head.  An approximate positive count may be deleted by a later
  -- membership edge, but that transaction's deferred revalidation recreates it
  -- before commit whenever another physical member still exists.
  IF v_revision IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
         AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
         AND d."isOutstanding"=TRUE
       LIMIT 1
    ) INTO v_exists;
    IF NOT COALESCE(v_exists,FALSE) THEN RETURN TRUE; END IF;
    v_count := 1;

    SELECT "phase3_domain_work_claimable_at"(
             d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
           ) INTO v_due
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
       AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
       AND d."isOutstanding"=TRUE AND d."state" IN ('READY','CLAIMED')
     ORDER BY "phase3_domain_work_claimable_at"(
                d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
              ),d."id"
     LIMIT 1;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
         AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
         AND d."isOutstanding"=TRUE
       LIMIT 1
    ) INTO v_exists;
    IF NOT COALESCE(v_exists,FALSE) THEN
      DELETE FROM "Phase2WorkBroadClaimPartitionState" p
       WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
         AND p."partitionKey"=p_partition AND p."revision"=v_revision;
      RETURN FOUND;
    END IF;

    SELECT "phase3_domain_work_claimable_at"(
             d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
           ) INTO v_due
      FROM "DomainWorkItem" d
     WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
       AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
       AND d."isOutstanding"=TRUE AND d."state" IN ('READY','CLAIMED')
     ORDER BY "phase3_domain_work_claimable_at"(
                d."state",d."availableAt",d."nextAttemptAt",d."leaseUntil"
              ),d."id"
     LIMIT 1;
  END IF;

  v_dispatch := CASE WHEN v_due IS NULL THEN NULL
    ELSE GREATEST(v_due,COALESCE(p_touched_at,v_due)) END;
  v_id := 'p2wbcps_' || md5(p_agency || E'\x1f' || p_work_class || E'\x1f' || p_partition);

  IF v_revision IS NULL THEN
    INSERT INTO "Phase2WorkBroadClaimPartitionState"(
      "id","agencyId","workClass","partitionKey","activeGeneration",
      "outstandingCount","claimShard","nextClaimableAt","lastClaimedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_partition,p_generation,v_count,
      "phase3_domain_work_claim_shard"(p_partition),v_dispatch,p_touched_at,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId","workClass","partitionKey") DO NOTHING;
    RETURN FOUND;
  END IF;

  UPDATE "Phase2WorkBroadClaimPartitionState" p
     SET "activeGeneration"=p_generation,
         "claimShard"="phase3_domain_work_claim_shard"(p_partition),
         "nextClaimableAt"=v_dispatch,
         "lastClaimedAt"=COALESCE(p_touched_at,p."lastClaimedAt"),
         "revision"=p."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
     AND p."partitionKey"=p_partition AND p."revision"=v_revision;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_shard"(
  p_agency TEXT,p_work_class TEXT,p_generation TEXT,p_shard INTEGER,p_touched_at TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision BIGINT;
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= 128 THEN
    RETURN FALSE;
  END IF;

  SELECT s."revision" INTO v_revision
    FROM "DomainWorkClaimShardState" s
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class AND s."claimShard"=p_shard;

  SELECT p."nextClaimableAt" INTO v_due
    FROM "Phase2WorkBroadClaimPartitionState" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
     AND p."activeGeneration"=p_generation AND p."claimShard"=p_shard
     AND p."nextClaimableAt" IS NOT NULL
   ORDER BY p."nextClaimableAt",p."revision",p."partitionKey"
   LIMIT 1;

  IF v_due IS NULL THEN
    IF v_revision IS NULL THEN RETURN TRUE; END IF;
    DELETE FROM "DomainWorkClaimShardState" s
     WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
       AND s."claimShard"=p_shard AND s."revision"=v_revision;
    RETURN FOUND;
  END IF;

  v_dispatch := GREATEST(v_due,COALESCE(p_touched_at,v_due));
  v_id := 'dwcss_' || md5(p_agency || E'\x1f' || p_work_class || E'\x1f' || p_shard::TEXT);
  IF v_revision IS NULL THEN
    INSERT INTO "DomainWorkClaimShardState"(
      "id","agencyId","workClass","claimShard","activeGeneration",
      "nextDispatchAt","lastSelectedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_shard,p_generation,v_dispatch,p_touched_at,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId","workClass","claimShard") DO NOTHING;
    RETURN FOUND;
  END IF;

  UPDATE "DomainWorkClaimShardState" s
     SET "activeGeneration"=p_generation,
         "nextDispatchAt"=v_dispatch,
         "lastSelectedAt"=COALESCE(p_touched_at,s."lastSelectedAt"),
         "revision"=s."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
     AND s."claimShard"=p_shard AND s."revision"=v_revision;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_agency"(
  p_agency TEXT,p_work_class TEXT,p_generation TEXT,p_touched_at TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision BIGINT;
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT a."revision" INTO v_revision
    FROM "DomainWorkClaimAgencyState" a
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class;

  SELECT s."nextDispatchAt" INTO v_due
    FROM "DomainWorkClaimShardState" s
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
     AND s."activeGeneration"=p_generation
   ORDER BY s."nextDispatchAt",s."revision",s."claimShard"
   LIMIT 1;

  IF v_due IS NULL THEN
    IF v_revision IS NULL THEN RETURN TRUE; END IF;
    DELETE FROM "DomainWorkClaimAgencyState" a
     WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
    RETURN FOUND;
  END IF;

  v_dispatch := GREATEST(v_due,COALESCE(p_touched_at,v_due));
  v_id := 'dwcas_' || md5(p_agency || E'\x1f' || p_work_class);
  IF v_revision IS NULL THEN
    INSERT INTO "DomainWorkClaimAgencyState"(
      "id","agencyId","workClass","activeGeneration",
      "nextDispatchAt","lastSelectedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_generation,v_dispatch,p_touched_at,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT ("agencyId","workClass") DO NOTHING;
    RETURN FOUND;
  END IF;

  UPDATE "DomainWorkClaimAgencyState" a
     SET "activeGeneration"=p_generation,
         "nextDispatchAt"=v_dispatch,
         "lastSelectedAt"=COALESCE(p_touched_at,a."lastSelectedAt"),
         "revision"=a."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
  RETURN FOUND;
END;
$$;

-- Install live capture last so the populated cutover holds its DWI table lock
-- only for trigger catalog changes and the tiny authority-row insert below.
-- All functions called by the deferred boundary already exist at this point.
DROP TRIGGER IF EXISTS "trg_phase3_domain_work_claim_locator_mutation_flush" ON "DomainWorkClaimLocatorMutationBatch";
CREATE CONSTRAINT TRIGGER "trg_phase3_domain_work_claim_locator_mutation_flush"
AFTER INSERT ON "DomainWorkClaimLocatorMutationBatch"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "phase3_flush_domain_work_claim_locator_mutations"();

DROP TRIGGER IF EXISTS "trg_phase3_domain_work_claim_locators_insert" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase3_domain_work_claim_locators_insert"
AFTER INSERT ON "DomainWorkItem"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "phase3_queue_domain_work_claim_locator_insert"();

DROP TRIGGER IF EXISTS "trg_phase3_domain_work_claim_locators_update" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase3_domain_work_claim_locators_update"
AFTER UPDATE ON "DomainWorkItem"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "phase3_queue_domain_work_claim_locator_update"();

DROP TRIGGER IF EXISTS "trg_phase3_domain_work_claim_locators_delete" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase3_domain_work_claim_locators_delete"
AFTER DELETE ON "DomainWorkItem"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "phase3_queue_domain_work_claim_locator_delete"();

-- Install the current-scope producers before the online member keyset pass.
-- UPDATE is deliberately column-scoped: display-name/heartbeat writes never
-- rebuild a potentially large (but control-plane-capped) explicit scope.
DROP TRIGGER IF EXISTS "AgencyMember_phase3_access_epoch_fence" ON "AgencyMember";
CREATE TRIGGER "AgencyMember_phase3_access_epoch_fence"
BEFORE UPDATE OF "agencyId","userId","role","roleKey","permissions","assignedCreators","accessEpoch","deletedAt","deactivatedAt"
ON "AgencyMember"
FOR EACH ROW
EXECUTE FUNCTION "phase3_fence_agency_member_access_epoch"();

DROP TRIGGER IF EXISTS "AgencyMember_phase3_scope_projection_insert" ON "AgencyMember";
CREATE TRIGGER "AgencyMember_phase3_scope_projection_insert"
AFTER INSERT ON "AgencyMember"
FOR EACH ROW
EXECUTE FUNCTION "phase3_refresh_member_creator_scope_trigger"();

DROP TRIGGER IF EXISTS "AgencyMember_phase3_scope_projection_update" ON "AgencyMember";
CREATE TRIGGER "AgencyMember_phase3_scope_projection_update"
AFTER UPDATE OF "agencyId","userId","role","roleKey","permissions","assignedCreators","accessEpoch","deletedAt","deactivatedAt"
ON "AgencyMember"
FOR EACH ROW
EXECUTE FUNCTION "phase3_refresh_member_creator_scope_trigger"();

DROP TRIGGER IF EXISTS "AgencyMember_phase3_scope_projection_delete" ON "AgencyMember";
CREATE TRIGGER "AgencyMember_phase3_scope_projection_delete"
AFTER DELETE ON "AgencyMember"
FOR EACH ROW
EXECUTE FUNCTION "phase3_refresh_member_creator_scope_trigger"();

-- Live DWI producers are installed above before any existing identity is
-- enumerated.  The online activator now owns the only current-work pass.  It
-- advances a full DWI lexicographic cursor in bounded transactions, writes conservative
-- lower hints, and can resume after process/deploy failure without losing a live
-- mutation.  Runtime broad readers fail closed while this row is BUILDING.
INSERT INTO "DomainWorkClaimTopologyState"(
  "id","generation","activationState",
  "cursorAgencyId","cursorWorkClass","cursorPartitionKey","cursorActiveGeneration","cursorWorkId",
  "backfilledPartitions","partitionsBackfilledAt",
  "cursorMemberId","backfilledMembers","membersBackfilledAt",
  "startedAt","activatedAt","lastError",
  "revision","createdAt","updatedAt"
)
SELECT
  'phase3_domain_work_claim_topology_a36_v1',
  'phase3_domain_work_claim_topology_a36_v1',
  CASE WHEN EXISTS(SELECT 1 FROM "DomainWorkItem" d WHERE d."isOutstanding"=TRUE LIMIT 1)
          OR EXISTS(
            SELECT 1 FROM "AgencyMember" m
             WHERE m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
             LIMIT 1
          )
       THEN 'BUILDING' ELSE 'ACTIVE' END,
  NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,0,NULL,CURRENT_TIMESTAMP,
  CASE WHEN EXISTS(SELECT 1 FROM "DomainWorkItem" d WHERE d."isOutstanding"=TRUE LIMIT 1)
          OR EXISTS(
            SELECT 1 FROM "AgencyMember" m
             WHERE m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL
             LIMIT 1
          )
       THEN NULL ELSE CURRENT_TIMESTAMP END,
  NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
ON CONFLICT ("id") DO NOTHING;

COMMIT;
