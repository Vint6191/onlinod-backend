-- A37-R4. Serialize locator identity creation AND child-head reconciliation.
-- ON CONFLICT without a target arbitrates both id and natural unique indexes.
-- Missing locators are materialized only while their child witness exists.
-- An uncommitted placeholder establishes the row lock before reading fresh child truth;
-- it is finalized or deleted below in this same transaction, never exposed.
-- No per-locator advisory locks: bulk publication must not exhaust PostgreSQL's
-- shared lock table. Callers retain sorted partition -> shard -> Agency order.
-- Work rows are never locked here; child probes remain indexed and LIMIT 1.
-- Deferred delete intents survive their Agency cascade. Absence without a child
-- witness is already converged; it must not resurrect a row under a dead parent.
-- The pre-insert witness is only admission. Due truth is re-read AFTER locking.
BEGIN;

CREATE OR REPLACE FUNCTION "phase3_reconcile_domain_work_claim_partition"(
  p_agency TEXT,p_work_class TEXT,p_generation TEXT,p_partition TEXT,p_touched_at TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_revision BIGINT;
  v_last_selected TIMESTAMP(3);
  v_exists BOOLEAN;
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
  v_try INTEGER;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL OR p_partition IS NULL THEN
    RETURN FALSE;
  END IF;

  v_id := 'p2wbcps_' || md5(p_agency || E'\x1f' || p_work_class || E'\x1f' || p_partition);
  -- At most eight attempts if another transaction repeatedly deletes/recreates
  -- this identity. The caller must retry the whole transaction on serialization failure.
  FOR v_try IN 1..8 LOOP
    SELECT p."revision",CASE WHEN p."activeGeneration"=p_generation
    THEN p."lastClaimedAt" ELSE NULL END INTO v_revision,v_last_selected
    FROM "Phase2WorkBroadClaimPartitionState" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class AND p."partitionKey"=p_partition
   FOR UPDATE;
    EXIT WHEN FOUND;
    -- No locator and no committed/own child: nothing to publish. A peer's
    -- private child is reconciled by that peer's own deferred flush.
    IF NOT EXISTS (
      SELECT 1 FROM "DomainWorkItem" d
       WHERE d."agencyId"=p_agency AND d."workClass"=p_work_class
         AND d."partitionKey"=p_partition AND d."activeGeneration"=p_generation
         AND d."isOutstanding"=TRUE
       LIMIT 1
    ) THEN RETURN TRUE; END IF;
    INSERT INTO "Phase2WorkBroadClaimPartitionState"(
      "id","agencyId","workClass","partitionKey","activeGeneration",
      "outstandingCount","claimShard","nextClaimableAt","lastClaimedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_partition,p_generation,1,
      "phase3_domain_work_claim_shard"(p_partition),CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      -- Our INSERT already owns this row. Avoid a redundant index lookup in
      -- large publications; competitors still retry through SELECT FOR UPDATE.
      v_revision := 1;
      v_last_selected := NULL;
      EXIT;
    END IF;
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM "Phase2WorkBroadClaimPartitionState" p
       WHERE p."id"=v_id AND NOT (p."agencyId"=p_agency AND p."workClass"=p_work_class AND p."partitionKey"=p_partition)
    ) THEN
      RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_CONFLICT:partition' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_RETRY' USING ERRCODE='40001';
  END IF;

  -- Positive witness and indexed claimable head; no history count.
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
  v_dispatch := CASE WHEN v_due IS NULL THEN NULL
    ELSE GREATEST(v_due,p_touched_at,v_last_selected) END;


  UPDATE "Phase2WorkBroadClaimPartitionState" p
     SET "activeGeneration"=p_generation,
         "claimShard"="phase3_domain_work_claim_shard"(p_partition),
         "nextClaimableAt"=v_dispatch,
         "lastClaimedAt"=GREATEST(p_touched_at,v_last_selected),
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
  v_last_selected TIMESTAMP(3);
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
  v_try INTEGER;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= 128 THEN
    RETURN FALSE;
  END IF;

  v_id := 'dwcss_' || md5(p_agency || E'\x1f' || p_work_class || E'\x1f' || p_shard::TEXT);
  -- At most eight attempts if another transaction repeatedly deletes/recreates
  -- this identity. The caller must retry the whole transaction on serialization failure.
  FOR v_try IN 1..8 LOOP
    SELECT s."revision",CASE WHEN s."activeGeneration"=p_generation
    THEN s."lastSelectedAt" ELSE NULL END INTO v_revision,v_last_selected
    FROM "DomainWorkClaimShardState" s
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class AND s."claimShard"=p_shard
   FOR UPDATE;
    EXIT WHEN FOUND;
    -- No locator and no committed/own child: nothing to publish. A peer's
    -- private child is reconciled by that peer's own deferred flush.
    IF NOT EXISTS (
      SELECT 1 FROM "Phase2WorkBroadClaimPartitionState" p
       WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
         AND p."activeGeneration"=p_generation AND p."claimShard"=p_shard
         AND p."nextClaimableAt" IS NOT NULL
       LIMIT 1
    ) THEN RETURN TRUE; END IF;
    INSERT INTO "DomainWorkClaimShardState"(
      "id","agencyId","workClass","claimShard","activeGeneration",
      "nextDispatchAt","lastSelectedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_shard,p_generation,CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      -- Our INSERT already owns this row. Avoid a redundant index lookup in
      -- large publications; competitors still retry through SELECT FOR UPDATE.
      v_revision := 1;
      v_last_selected := NULL;
      EXIT;
    END IF;
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM "DomainWorkClaimShardState" s
       WHERE s."id"=v_id AND NOT (s."agencyId"=p_agency AND s."workClass"=p_work_class AND s."claimShard"=p_shard)
    ) THEN
      RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_CONFLICT:shard' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_RETRY' USING ERRCODE='40001';
  END IF;

  SELECT p."nextClaimableAt" INTO v_due
    FROM "Phase2WorkBroadClaimPartitionState" p
   WHERE p."agencyId"=p_agency AND p."workClass"=p_work_class
     AND p."activeGeneration"=p_generation AND p."claimShard"=p_shard
     AND p."nextClaimableAt" IS NOT NULL
   ORDER BY p."nextClaimableAt",p."revision",p."partitionKey"
   LIMIT 1;

  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkClaimShardState" s
     WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
       AND s."claimShard"=p_shard AND s."revision"=v_revision;
    RETURN FOUND;
  END IF;

  v_dispatch := GREATEST(v_due,p_touched_at,v_last_selected);

  UPDATE "DomainWorkClaimShardState" s
     SET "activeGeneration"=p_generation,
         "nextDispatchAt"=v_dispatch,
         "lastSelectedAt"=GREATEST(p_touched_at,v_last_selected),
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
  v_last_selected TIMESTAMP(3);
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
  v_try INTEGER;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL THEN
    RETURN FALSE;
  END IF;

  v_id := 'dwcas_' || md5(p_agency || E'\x1f' || p_work_class);
  -- At most eight attempts if another transaction repeatedly deletes/recreates
  -- this identity. The caller must retry the whole transaction on serialization failure.
  FOR v_try IN 1..8 LOOP
    SELECT a."revision",CASE WHEN a."activeGeneration"=p_generation
    THEN a."lastSelectedAt" ELSE NULL END INTO v_revision,v_last_selected
    FROM "DomainWorkClaimAgencyState" a
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class
   FOR UPDATE;
    EXIT WHEN FOUND;
    -- No locator and no committed/own child: nothing to publish. A peer's
    -- private child is reconciled by that peer's own deferred flush.
    IF NOT EXISTS (
      SELECT 1 FROM "DomainWorkClaimShardState" s
       WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
         AND s."activeGeneration"=p_generation
       LIMIT 1
    ) THEN RETURN TRUE; END IF;
    INSERT INTO "DomainWorkClaimAgencyState"(
      "id","agencyId","workClass","activeGeneration",
      "nextDispatchAt","lastSelectedAt","revision","createdAt","updatedAt"
    ) VALUES (
      v_id,p_agency,p_work_class,p_generation,CURRENT_TIMESTAMP,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      -- Our INSERT already owns this row. Avoid a redundant index lookup in
      -- large publications; competitors still retry through SELECT FOR UPDATE.
      v_revision := 1;
      v_last_selected := NULL;
      EXIT;
    END IF;
    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM "DomainWorkClaimAgencyState" a
       WHERE a."id"=v_id AND NOT (a."agencyId"=p_agency AND a."workClass"=p_work_class)
    ) THEN
      RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_CONFLICT:agency' USING ERRCODE='23505';
    END IF;
  END LOOP;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'PHASE3_CLAIM_LOCATOR_IDENTITY_RETRY' USING ERRCODE='40001';
  END IF;

  SELECT s."nextDispatchAt" INTO v_due
    FROM "DomainWorkClaimShardState" s
   WHERE s."agencyId"=p_agency AND s."workClass"=p_work_class
     AND s."activeGeneration"=p_generation
   ORDER BY s."nextDispatchAt",s."revision",s."claimShard"
   LIMIT 1;

  IF v_due IS NULL THEN
    DELETE FROM "DomainWorkClaimAgencyState" a
     WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
    RETURN FOUND;
  END IF;

  v_dispatch := GREATEST(v_due,p_touched_at,v_last_selected);

  UPDATE "DomainWorkClaimAgencyState" a
     SET "activeGeneration"=p_generation,
         "nextDispatchAt"=v_dispatch,
         "lastSelectedAt"=GREATEST(p_touched_at,v_last_selected),
         "revision"=a."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
  RETURN FOUND;
END;
$$;

COMMIT;
