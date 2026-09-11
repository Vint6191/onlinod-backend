-- ONLINOD Phase 2 / Actual55 INT7.
--
-- Broad claim fairness must not rebuild DISTINCT partition heads from the complete
-- outstanding DomainWorkItem set on every claim.  This migration turns the existing
-- Phase2WorkBroadClaimPartitionState table into a durable *catalog/fairness hint*.
-- DomainWorkItem remains the only execution truth: claim SQL re-proves due physical
-- work before locking anything, and has a one-row physical fallback if catalog state
-- is missing/corrupt.

CREATE OR REPLACE FUNCTION "phase2_track_domain_work_broad_partition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."isOutstanding" IS TRUE THEN
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
  RETURN NEW;
END;
$$;

-- PostgreSQL fires triggers of the same kind in name order. FamilyState must lock
-- before PartitionCatalog on every DWI mutation so publication and claim share the
-- same DWI -> FamilyState -> PartitionCatalog order. A `broad_...` trigger name
-- would sort before `...family_state` and recreate a reachable deadlock cycle.
DROP TRIGGER IF EXISTS "trg_phase2_domain_work_broad_partition_catalog" ON "DomainWorkItem";
DROP TRIGGER IF EXISTS "trg_phase2_domain_work_partition_catalog" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase2_domain_work_partition_catalog"
AFTER INSERT OR UPDATE OF "agencyId","workClass","partitionKey","activeGeneration","isOutstanding"
ON "DomainWorkItem"
FOR EACH ROW
EXECUTE FUNCTION "phase2_track_domain_work_broad_partition"();

-- Global broad-recovery admission scans by work class/generation across Agencies.
-- Keep that exceptional probe on the compact catalog rather than the DWI backlog.
CREATE INDEX IF NOT EXISTS "Phase2WorkBroadClaimPartitionState_recovery_idx"
  ON "Phase2WorkBroadClaimPartitionState"(
    "workClass","activeGeneration","lastClaimedAt","agencyId","partitionKey"
  );

-- Seed every physically-current outstanding partition that predates the trigger.
-- This is migration/bootstrap metadata only; stale extra rows are harmless because
-- runtime admission always checks EXISTS against current due DomainWorkItem truth.
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
GROUP BY d."agencyId",d."workClass",d."partitionKey",d."activeGeneration"
ON CONFLICT ("agencyId","workClass","partitionKey") DO UPDATE SET
  "activeGeneration"=EXCLUDED."activeGeneration",
  "lastClaimedAt"=CASE
    WHEN "Phase2WorkBroadClaimPartitionState"."activeGeneration" IS DISTINCT FROM EXCLUDED."activeGeneration"
    THEN NULL
    ELSE "Phase2WorkBroadClaimPartitionState"."lastClaimedAt"
  END,
  "updatedAt"=CURRENT_TIMESTAMP;
