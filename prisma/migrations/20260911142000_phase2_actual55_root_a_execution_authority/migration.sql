BEGIN;

-- ONLINOD Phase 2 / Actual55 Root A closure.
-- Ready-head rows are retired as execution authority. Claims now seek the
-- physically-current DomainWorkItem workset directly, with LIMIT-first bounded
-- admission. This removes the advisory-lock/ready-head failure cluster while the
-- durable generation cutover fences older binaries before they can claim through
-- the retired locator.

LOCK TABLE "DomainWorkItem" IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_broad_due_v3_idx"
  ON "DomainWorkItem"("workClass","activeGeneration","availableAt","agencyId","partitionKey","id")
  WHERE "isOutstanding"=TRUE;

CREATE INDEX IF NOT EXISTS "DomainWorkItem_current_agency_due_v3_idx"
  ON "DomainWorkItem"("agencyId","workClass","activeGeneration","availableAt","partitionKey","id")
  WHERE "isOutstanding"=TRUE;

CREATE INDEX IF NOT EXISTS "Phase2WorkFamilyState_claim_v3_idx"
  ON "Phase2WorkFamilyState"("workClass","activeGeneration","lastRequestedAt","agencyId")
  WHERE "outstandingCount">0;

-- The old ready-head trigger and its BEFORE advisory scope were correctness
-- authorities in Actual55. Remove both before activating v3. Ready* tables remain
-- schema-compatible for rollback/destructive cleanup, but no current runtime reads
-- or writes them after this migration.
DROP TRIGGER IF EXISTS "trg_00_phase2_domain_work_mutation_scope" ON "DomainWorkItem";
DROP TRIGGER IF EXISTS "trg_phase2_domain_work_ready_head" ON "DomainWorkItem";

UPDATE "Phase2WorkGenerationAuthority"
   SET "previousGeneration" = CASE
         WHEN "activeGeneration" <> 'phase2_domain_work_v3_actual55' THEN "activeGeneration"
         ELSE "previousGeneration" END,
       "activeGeneration" = 'phase2_domain_work_v3_actual55',
       "projectionVersion" = 'phase2_domain_work_v3_actual55',
       "revision" = CASE
         WHEN "activeGeneration" <> 'phase2_domain_work_v3_actual55' THEN "revision" + 1
         ELSE "revision" END,
       "activatedAt" = CASE
         WHEN "activeGeneration" <> 'phase2_domain_work_v3_actual55' THEN CURRENT_TIMESTAMP
         ELSE "activatedAt" END,
       "updatedAt" = CURRENT_TIMESTAMP;

-- Fenced rolling cutover: the existing generation trigger converts outstanding
-- work into v3 and invalidates old ownership. Historical DONE identities remain
-- historical and are not rewritten.
UPDATE "DomainWorkItem"
   SET "activeGeneration"='phase2_domain_work_v3_actual55',
       "projectionVersion"='phase2_domain_work_v3_actual55',
       "updatedAt"=CURRENT_TIMESTAMP
 WHERE "isOutstanding"=TRUE
   AND "activeGeneration" IS DISTINCT FROM 'phase2_domain_work_v3_actual55';

UPDATE "Phase2WorkFamilyState"
   SET "activeGeneration"='phase2_domain_work_v3_actual55',
       "updatedAt"=CURRENT_TIMESTAMP
 WHERE "activeGeneration" IS DISTINCT FROM 'phase2_domain_work_v3_actual55';

-- These are now non-authoritative compatibility tables. Clearing them makes a
-- stale/rollback reader fail visibly instead of trusting a frozen head while v3 is
-- active. An Actual55 binary is already fenced by generation before claim.
DELETE FROM "DomainWorkReadyPartition";
DELETE FROM "DomainWorkReadyAgency";

ALTER TABLE "DomainWorkItem" ALTER COLUMN "activeGeneration" SET DEFAULT 'phase2_domain_work_v3_actual55';
ALTER TABLE "DomainWorkItem" ALTER COLUMN "projectionVersion" SET DEFAULT 'phase2_domain_work_v3_actual55';

CREATE OR REPLACE FUNCTION "phase2_current_domain_work_generation"(p_class TEXT)
RETURNS TEXT AS $$
DECLARE v_generation TEXT;
BEGIN
  SELECT "activeGeneration" INTO v_generation
    FROM "Phase2WorkGenerationAuthority"
   WHERE "workClass"=p_class;
  RETURN COALESCE(v_generation,'phase2_domain_work_v3_actual55');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "phase2_current_domain_work_projection"(p_class TEXT)
RETURNS TEXT AS $$
DECLARE v_projection TEXT;
BEGIN
  SELECT "projectionVersion" INTO v_projection
    FROM "Phase2WorkGenerationAuthority"
   WHERE "workClass"=p_class;
  RETURN COALESCE(v_projection,'phase2_domain_work_v3_actual55');
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
