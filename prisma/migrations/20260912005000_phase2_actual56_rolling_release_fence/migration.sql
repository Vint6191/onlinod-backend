-- ONLINOD Phase 2 / Actual56 final closure — M1 rolling binary compatibility.
--
-- Purpose: after this authority migration, an incompatible old binary may continue
-- reading and may finish an already-held DomainWork claim, but it cannot acquire NEW
-- current-work execution or mutate CreatorAccount through retired writer shapes.
-- Physical AgencyMember deletion is reserved for the claimed destructive authority.
-- This is a DB compatibility fence; normal business authorization remains in JS.

BEGIN;

-- Publish the compatibility generation, Creator/Member writer fences and
-- DomainWork executor fence as one PostgreSQL cutover. No externally visible
-- intermediate schema may advertise the new authority while an old writer can
-- still pass through a trigger that has not been installed yet.

CREATE TABLE IF NOT EXISTS "Phase2ReleaseCompatibilityAuthority" (
  "scope" TEXT NOT NULL,
  "requiredGeneration" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2ReleaseCompatibilityAuthority_pkey" PRIMARY KEY ("scope")
);

INSERT INTO "Phase2ReleaseCompatibilityAuthority"("scope","requiredGeneration","activatedAt","createdAt","updatedAt") VALUES
  ('CREATOR_ACCOUNT_WRITER','phase2_creator_writer_v2_actual56_postcut',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('DOMAIN_WORK_EXECUTOR','phase2_domain_executor_v4_actual56_postcut',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
ON CONFLICT ("scope") DO UPDATE SET
  "requiredGeneration"=EXCLUDED."requiredGeneration",
  "activatedAt"=CURRENT_TIMESTAMP,
  "updatedAt"=CURRENT_TIMESTAMP;

ALTER TABLE "DomainWorkItem"
  ADD COLUMN IF NOT EXISTS "claimExecutionGeneration" TEXT;

CREATE INDEX IF NOT EXISTS "DomainWorkItem_legacy_claim_drain_idx"
  ON "DomainWorkItem"("workClass","state","leaseUntil","claimExecutionGeneration","id")
  WHERE "isOutstanding"=TRUE AND "state"='CLAIMED';

CREATE OR REPLACE FUNCTION "phase2_required_release_generation"(p_scope text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT a."requiredGeneration"
    FROM "Phase2ReleaseCompatibilityAuthority" a
   WHERE a."scope"=BTRIM(COALESCE(p_scope,''))
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION "phase2_release_generation_authorized"(p_scope text,p_setting text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_required text;
  v_actual text;
BEGIN
  v_required := "phase2_required_release_generation"(p_scope);
  IF v_required IS NULL THEN RETURN FALSE; END IF;
  v_actual := current_setting(p_setting, true);
  RETURN v_actual = v_required;
END;
$$;

-- All CreatorAccount mutations cross the Cut-E/C5/C6 authority boundary. New code
-- proves its release generation in the SAME transaction before mutation. An old
-- binary has no such proof, so migrated PostgreSQL fails it closed. Claimed bounded
-- destructive cleanup is the only intentional exception for physical deletion.
CREATE OR REPLACE FUNCTION "phase2_fence_creator_account_release_writer"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_agency_id text;
  v_creator_id text;
BEGIN
  v_agency_id := CASE WHEN TG_OP='DELETE' THEN OLD."agencyId" ELSE NEW."agencyId" END;
  v_creator_id := CASE WHEN TG_OP='DELETE' THEN OLD."id" ELSE NEW."id" END;

  IF TG_OP='DELETE' AND (
       "phase2_internal_creator_destructive_authorized"(v_agency_id,v_creator_id)
       OR "phase2_internal_agency_destructive_authorized"(v_agency_id)
     ) THEN
    RETURN OLD;
  END IF;

  IF NOT "phase2_release_generation_authorized"(
    'CREATOR_ACCOUNT_WRITER','onlinod.phase2_creator_writer_generation'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='55000',
      MESSAGE=format('PHASE2_INCOMPATIBLE_CREATOR_WRITER agency=%s creator=%s op=%s',COALESCE(v_agency_id,'?'),COALESCE(v_creator_id,'?'),TG_OP);
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_phase2_creator_account_release_writer" ON "CreatorAccount";
CREATE TRIGGER "trg_phase2_creator_account_release_writer"
BEFORE INSERT OR UPDATE OR DELETE ON "CreatorAccount"
FOR EACH ROW EXECUTE FUNCTION "phase2_fence_creator_account_release_writer"();

-- Pre-Cut-E platform-admin used physical AgencyMember DELETE. Current lifecycle is
-- soft-retention. Do not permit a release-generation token to turn physical deletion
-- back on: only the exact claimed Agency destructive transaction may physically
-- remove/cascade historical member identity.
CREATE OR REPLACE FUNCTION "phase2_fence_agency_member_physical_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF "phase2_internal_agency_destructive_authorized"(OLD."agencyId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE='55000',
    MESSAGE=format('PHASE2_AGENCY_MEMBER_PHYSICAL_DELETE_RETIRED agency=%s member=%s',OLD."agencyId",OLD."id");
END;
$$;

DROP TRIGGER IF EXISTS "trg_phase2_agency_member_physical_delete" ON "AgencyMember";
CREATE TRIGGER "trg_phase2_agency_member_physical_delete"
BEFORE DELETE ON "AgencyMember"
FOR EACH ROW EXECUTE FUNCTION "phase2_fence_agency_member_physical_delete"();

-- A new DomainWork executor must prove the current release generation when it
-- ACQUIRES ownership. Existing pre-migration claims are intentionally allowed to
-- heartbeat/settle with their old/null generation so they can drain. New binaries
-- wait for those live legacy leases before claiming the same class.
CREATE OR REPLACE FUNCTION "phase2_fence_domain_work_executor_acquire"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_required text;
BEGIN
  IF NEW."state"='CLAIMED'
     AND (
       OLD."state" IS DISTINCT FROM 'CLAIMED'
       OR OLD."ownerToken" IS DISTINCT FROM NEW."ownerToken"
       OR OLD."claimFence" IS DISTINCT FROM NEW."claimFence"
     ) THEN
    v_required := "phase2_required_release_generation"('DOMAIN_WORK_EXECUTOR');
    IF v_required IS NULL
       OR NOT "phase2_release_generation_authorized"(
         'DOMAIN_WORK_EXECUTOR','onlinod.phase2_domain_executor_generation'
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE='55000',
        MESSAGE=format('PHASE2_INCOMPATIBLE_DOMAIN_EXECUTOR work=%s class=%s',NEW."id",NEW."workClass");
    END IF;
    NEW."claimExecutionGeneration" := v_required;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_phase2_domain_work_executor_release" ON "DomainWorkItem";
CREATE TRIGGER "trg_phase2_domain_work_executor_release"
BEFORE UPDATE OF "state","ownerToken","claimFence" ON "DomainWorkItem"
FOR EACH ROW EXECUTE FUNCTION "phase2_fence_domain_work_executor_acquire"();

COMMIT;
