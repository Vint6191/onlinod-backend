-- A37-R2: dispatch position is a monotonic watermark within a generation.
-- Reconciliation can lower future due time after a new publication, but may not
-- undo an already committed dispatch reservation. Preserve each level's own
-- watermark, including stale/null touch inputs and delayed deferred flushes.
-- No table rebuild, history scan or backfill. Existing timestamp/int8 wrappers
-- continue to delegate to these three canonical implementations.
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
  v_count INTEGER;
  v_exists BOOLEAN;
  v_due TIMESTAMP(3);
  v_dispatch TIMESTAMP(3);
  v_id TEXT;
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL OR p_partition IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p."revision",CASE WHEN p."activeGeneration"=p_generation
    THEN p."lastClaimedAt" ELSE NULL END INTO v_revision,v_last_selected
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
    ELSE GREATEST(v_due,p_touched_at,v_last_selected) END;
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
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= 128 THEN
    RETURN FALSE;
  END IF;

  SELECT s."revision",CASE WHEN s."activeGeneration"=p_generation
    THEN s."lastSelectedAt" ELSE NULL END INTO v_revision,v_last_selected
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

  v_dispatch := GREATEST(v_due,p_touched_at,v_last_selected);
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
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_generation IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT a."revision",CASE WHEN a."activeGeneration"=p_generation
    THEN a."lastSelectedAt" ELSE NULL END INTO v_revision,v_last_selected
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

  v_dispatch := GREATEST(v_due,p_touched_at,v_last_selected);
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
         "lastSelectedAt"=GREATEST(p_touched_at,v_last_selected),
         "revision"=a."revision"+1,
         "updatedAt"=CURRENT_TIMESTAMP
   WHERE a."agencyId"=p_agency AND a."workClass"=p_work_class AND a."revision"=v_revision;
  RETURN FOUND;
END;
$$;

COMMIT;
