-- ONLINOD Phase 2 / Actual56 final closure A.
-- C1: race-safe conservation for the CURRENT broad-claim partition projection.
--
-- The previous AFTER trigger used a statement-snapshot NOT EXISTS proof. Two
-- concurrent final settlements could each observe the other row as outstanding and
-- both leave a stale projection row. The projection now owns an exact conserved
-- outstandingCount. Every membership edge changes that one row atomically, so the
-- last decrement is serialized by PostgreSQL row locking and removes the projection.

BEGIN;

-- Migration baseline must be one atomic state transition while an older Render
-- instance may still be serving. Block DomainWorkItem writers first; every runtime
-- projection mutation originates from a DWI mutation, so this also prevents a
-- DWI -> projection lock-order inversion during the exact-count rebuild.
LOCK TABLE "DomainWorkItem" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Phase2WorkBroadClaimPartitionState" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "Phase2WorkBroadClaimPartitionState"
  ADD COLUMN IF NOT EXISTS "outstandingCount" INTEGER NOT NULL DEFAULT 0;


CREATE OR REPLACE FUNCTION "phase2_domain_work_current_partition_lock_key"(
  p_agency TEXT,p_work_class TEXT,p_partition TEXT
) RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT hashtextextended(
    'phase2:domain-work-current-partition:v1:'
      || COALESCE(p_agency,'') || E'\x1f'
      || COALESCE(p_work_class,'') || E'\x1f'
      || COALESCE(p_partition,''),
    0
  );
$$;

-- Shared repair/trigger lock identity. Runtime repair invokes this wrapper with
-- $executeRawUnsafe in a separate statement so a PostgreSQL READ COMMITTED
-- snapshot is acquired only after any prior partition transition has committed.
CREATE OR REPLACE FUNCTION "phase2_lock_domain_work_current_partition"(
  p_agency TEXT,p_work_class TEXT,p_partition TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_agency IS NULL OR p_work_class IS NULL OR p_partition IS NULL THEN
    RAISE EXCEPTION 'phase2 current partition lock identity is required';
  END IF;
  PERFORM pg_advisory_xact_lock(
    "phase2_domain_work_current_partition_lock_key"(p_agency,p_work_class,p_partition)
  );
END;
$$;

CREATE OR REPLACE FUNCTION "phase2_track_domain_work_current_partition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_generation TEXT;
  v_old_membership BOOLEAN := FALSE;
  v_new_membership BOOLEAN := FALSE;
  v_identity_changed BOOLEAN := FALSE;
  v_remove_transition BOOLEAN := FALSE;
  v_add_transition BOOLEAN := FALSE;
  v_old_partition_lock BIGINT;
  v_new_partition_lock BIGINT;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT g."activeGeneration" INTO v_current_generation
      FROM "Phase2WorkGenerationAuthority" g
     WHERE g."workClass"=NEW."workClass";
    v_new_membership := NEW."isOutstanding" IS TRUE
      AND (v_current_generation IS NULL OR v_current_generation=NEW."activeGeneration");
  END IF;

  IF TG_OP <> 'INSERT' THEN
    v_old_membership := OLD."isOutstanding" IS TRUE;
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

  -- Runtime physical repair and normal membership transitions share one
  -- per-partition transaction fence. When an UPDATE moves between two
  -- partitions, acquire both 64-bit lock identities in numeric order so A->B
  -- and B->A cannot create an advisory-lock cycle. The key intentionally omits
  -- generation because the projection has one row per agency/class/partition.
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

  -- Remove OLD membership without ever writing an invalid zero count. The
  -- UPDATE and DELETE both lock the same partition row, so two concurrent
  -- final settlements serialize and exactly one transition removes the row.
  IF v_remove_transition THEN
    UPDATE "Phase2WorkBroadClaimPartitionState" f
       SET "outstandingCount"=f."outstandingCount"-1,
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
      "outstandingCount","lastClaimedAt","createdAt","updatedAt"
    ) VALUES (
      'p2wbcps_' || md5(NEW."agencyId" || E'\x1f' || NEW."workClass" || E'\x1f' || NEW."partitionKey"),
      NEW."agencyId",NEW."workClass",NEW."partitionKey",NEW."activeGeneration",
      1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
      "activeGeneration"=EXCLUDED."activeGeneration",
      "outstandingCount"=CASE
        WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
          THEN 1
        ELSE "Phase2WorkBroadClaimPartitionState"."outstandingCount"+1
      END,
      "lastClaimedAt"=CASE
        WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
          THEN NULL
        ELSE "Phase2WorkBroadClaimPartitionState"."lastClaimedAt"
      END,
      "updatedAt"=CURRENT_TIMESTAMP;
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Rebuild exact counts from physical current truth. This is both migration repair
-- for the old boolean catalog and the conservation baseline for the new trigger.
DELETE FROM "Phase2WorkBroadClaimPartitionState";
INSERT INTO "Phase2WorkBroadClaimPartitionState"(
  "id","agencyId","workClass","partitionKey","activeGeneration",
  "outstandingCount","lastClaimedAt","createdAt","updatedAt"
)
SELECT
  'p2wbcps_' || md5(d."agencyId" || E'\x1f' || d."workClass" || E'\x1f' || d."partitionKey"),
  d."agencyId",d."workClass",d."partitionKey",d."activeGeneration",
  COUNT(*)::INTEGER,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM "DomainWorkItem" d
JOIN "Phase2WorkGenerationAuthority" g
  ON g."workClass"=d."workClass"
 AND g."activeGeneration"=d."activeGeneration"
WHERE d."isOutstanding"=TRUE
GROUP BY d."agencyId",d."workClass",d."partitionKey",d."activeGeneration";

ALTER TABLE "Phase2WorkBroadClaimPartitionState"
  DROP CONSTRAINT IF EXISTS "Phase2WorkBroadClaimPartitionState_outstandingCount_check";
ALTER TABLE "Phase2WorkBroadClaimPartitionState"
  ADD CONSTRAINT "Phase2WorkBroadClaimPartitionState_outstandingCount_check"
  CHECK ("outstandingCount" > 0);

COMMIT;
