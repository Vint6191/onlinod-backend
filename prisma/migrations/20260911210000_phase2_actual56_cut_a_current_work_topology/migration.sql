-- ONLINOD Phase 2 / Actual56 CUT A.
--
-- F56-01/F56-03/F56-04:
-- * the broad partition table is a CURRENT projection, not a lifetime catalog;
-- * Agency+workClass FamilyState is retired from the hot execution path;
-- * current freshness is proven from indexed DomainWorkItem truth;
-- * DWI mutation has one derived hot projection (current partition state), removing
--   the FamilyState <-> PartitionCatalog lock-order cycle.

-- Current-work physical probes used by coverage and corruption recovery.
CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_family_probe_idx"
  ON "DomainWorkItem"("agencyId","workClass","activeGeneration","id")
  WHERE "isOutstanding"=TRUE;

CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_broad_due_idx"
  ON "DomainWorkItem"("workClass","activeGeneration","agencyId","partitionKey","availableAt","id")
  WHERE "isOutstanding"=TRUE;

-- FamilyState remains schema-compatible for old binaries/migration evidence, but the
-- current binary no longer mutates or consumes it as execution/freshness authority.
DROP TRIGGER IF EXISTS "trg_phase2_domain_work_family_state" ON "DomainWorkItem";

CREATE OR REPLACE FUNCTION "phase2_track_domain_work_current_partition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_agency TEXT;
  v_old_class TEXT;
  v_old_partition TEXT;
  v_old_generation TEXT;
  v_new_generation TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_agency := OLD."agencyId";
    v_old_class := OLD."workClass";
    v_old_partition := OLD."partitionKey";
    v_old_generation := OLD."activeGeneration";
  END IF;

  -- Add/refresh only physically-current outstanding partitions.
  IF TG_OP <> 'DELETE' AND NEW."isOutstanding" IS TRUE THEN
    SELECT g."activeGeneration" INTO v_new_generation
      FROM "Phase2WorkGenerationAuthority" g
     WHERE g."workClass"=NEW."workClass";

    IF v_new_generation IS NULL OR v_new_generation = NEW."activeGeneration" THEN
      INSERT INTO "Phase2WorkBroadClaimPartitionState"(
        "id","agencyId","workClass","partitionKey","activeGeneration",
        "lastClaimedAt","createdAt","updatedAt"
      ) VALUES (
        'p2wbcps_' || md5(NEW."agencyId" || E'\x1f' || NEW."workClass" || E'\x1f' || NEW."partitionKey"),
        NEW."agencyId",NEW."workClass",NEW."partitionKey",NEW."activeGeneration",
        NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      )
      ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
        "activeGeneration"=EXCLUDED."activeGeneration",
        "lastClaimedAt"=CASE
          WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
          THEN NULL
          ELSE "Phase2WorkBroadClaimPartitionState"."lastClaimedAt"
        END,
        "updatedAt"=CURRENT_TIMESTAMP;
    END IF;
  END IF;

  -- Remove an old/current partition row once no physically-current outstanding DWI
  -- remains for that identity. This is what makes the projection current-only instead
  -- of monotonically growing with every partition ever observed.
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP='DELETE'
       OR OLD."agencyId" IS DISTINCT FROM NEW."agencyId"
       OR OLD."workClass" IS DISTINCT FROM NEW."workClass"
       OR OLD."partitionKey" IS DISTINCT FROM NEW."partitionKey"
       OR OLD."activeGeneration" IS DISTINCT FROM NEW."activeGeneration"
       OR (OLD."isOutstanding" IS TRUE AND NEW."isOutstanding" IS FALSE) THEN
      IF NOT EXISTS (
        SELECT 1
          FROM "DomainWorkItem" d
          JOIN "Phase2WorkGenerationAuthority" g
            ON g."workClass"=d."workClass" AND g."activeGeneration"=d."activeGeneration"
         WHERE d."agencyId"=v_old_agency
           AND d."workClass"=v_old_class
           AND d."partitionKey"=v_old_partition
           AND d."activeGeneration"=v_old_generation
           AND d."isOutstanding"=TRUE
         LIMIT 1
      ) THEN
        DELETE FROM "Phase2WorkBroadClaimPartitionState" f
         WHERE f."agencyId"=v_old_agency
           AND f."workClass"=v_old_class
           AND f."partitionKey"=v_old_partition
           AND f."activeGeneration"=v_old_generation;
      END IF;
    END IF;
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_phase2_domain_work_broad_partition_catalog" ON "DomainWorkItem";
DROP TRIGGER IF EXISTS "trg_phase2_domain_work_partition_catalog" ON "DomainWorkItem";
DROP TRIGGER IF EXISTS "trg_phase2_domain_work_current_partition" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase2_domain_work_current_partition"
AFTER INSERT OR UPDATE OR DELETE ON "DomainWorkItem"
FOR EACH ROW
EXECUTE FUNCTION "phase2_track_domain_work_current_partition"();

-- Rebuild the projection from physical current truth. Stale lifetime rows disappear.
DELETE FROM "Phase2WorkBroadClaimPartitionState";
INSERT INTO "Phase2WorkBroadClaimPartitionState"(
  "id","agencyId","workClass","partitionKey","activeGeneration",
  "lastClaimedAt","createdAt","updatedAt"
)
SELECT
  'p2wbcps_' || md5(d."agencyId" || E'\x1f' || d."workClass" || E'\x1f' || d."partitionKey"),
  d."agencyId",d."workClass",d."partitionKey",d."activeGeneration",
  NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM "DomainWorkItem" d
JOIN "Phase2WorkGenerationAuthority" g
  ON g."workClass"=d."workClass"
 AND g."activeGeneration"=d."activeGeneration"
WHERE d."isOutstanding"=TRUE
GROUP BY d."agencyId",d."workClass",d."partitionKey",d."activeGeneration";
