-- ONLINOD Phase 2 / Actual56 destructive audit closure — M1 DB-enforced
-- Team control-plane writer generation.
--
-- The prior DRAINING/ACTIVE protocol depended on an operator assertion that
-- every incompatible old binary had been drained. This migration turns that
-- promise into a PostgreSQL authority: every Team/current-authority mutation
-- must carry the exact transaction-local generation written by the new binary.
-- Old binaries do not know this setting and are physically rejected.
--
-- The migration itself establishes the old/new writer serialization point with
-- PostgreSQL table locks. After the trigger set + v2 generation commit, old
-- binaries are physically fenced. v2 remains DRAINING until explicit activation.
-- If operational-OWNER data is bad, abort before the v2 fence is published. Once
-- v2/DRAINING commits, Team current-authority state is intentionally immutable
-- until explicit activation; no DRAINING writer token is exposed by the product.

BEGIN;

-- Serialize the schema cutover with both generations of application-level Team
-- release admission/activation before touching topology tables.  The application
-- uses the same hashtext key for shared writer admission and exclusive activation.
-- Taking the exclusive transaction lock first preserves the global order:
-- release fence -> Team tables.  A v1 activation already in flight finishes
-- before this migration resets the row to v2/DRAINING; an activation that starts
-- after this lock waits and then observes the v2 generation instead.
SELECT pg_advisory_xact_lock(hashtext('phase2:release-activation:TEAM_CONTROL_PLANE'));

-- Establish one multi-table cutover point before any v2 trigger becomes visible.
-- SHARE ROW EXCLUSIVE conflicts with ordinary INSERT/UPDATE/DELETE writers, so
-- every pre-migration Team writer already touching any current-authority table
-- must finish before this transaction can proceed. The locks are held through
-- trigger installation + generation publication and released only at COMMIT.
LOCK TABLE
  "Agency",
  "User",
  "AgencyMember",
  "AgencyInvitation",
  "TeamMemberFunction",
  "AgencyCustomRole",
  "AgencyRoleOverride",
  "AgencySubPermissionOverride"
IN SHARE ROW EXCLUSIVE MODE;

-- Prove the activation invariant BEFORE publishing the v2 DB fence. The locks
-- above make this snapshot stable against every legacy/current Team writer. If
-- legacy data is already invalid, abort the entire 08000 transaction so the v2
-- trigger fence is not installed and the pre-08000 compatible deployment remains
-- the recovery side. This prevents an unrecoverable v2/DRAINING trap for an
-- Agency with zero Members or no operational User; v2 deliberately exposes no
-- DRAINING Team mutation/repair authority.
DO $$
DECLARE
  blocker_agency_id TEXT;
BEGIN
  SELECT a."id"
    INTO blocker_agency_id
    FROM "Agency" a
   WHERE a."deletedAt" IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "AgencyMember" m
         JOIN "User" u ON u."id" = m."userId"
        WHERE m."agencyId" = a."id"
          AND m."deletedAt" IS NULL
          AND m."deactivatedAt" IS NULL
          AND u."disabledAt" IS NULL
          AND (m."roleKey" = 'owner' OR m."role" = 'OWNER')
     )
   ORDER BY a."id" ASC
   LIMIT 1;

  IF blocker_agency_id IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE2_TEAM_CONTROL_PLANE_OWNER_PREFLIGHT_FAILED agency=%', blocker_agency_id
      USING ERRCODE = '23514',
            HINT = 'Repair the live Agency operational OWNER invariant on the pre-08000 compatible deployment, then retry migration 08000.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION phase2_require_team_control_plane_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_generation TEXT;
  activation_state TEXT;
  writer_generation TEXT;
BEGIN
  SELECT "requiredGeneration", "activationState"
    INTO required_generation, activation_state
    FROM "Phase2ReleaseCompatibilityAuthority"
   WHERE "scope"='TEAM_CONTROL_PLANE';

  writer_generation := current_setting('onlinod.phase2_team_control_plane_generation', true);

  IF required_generation IS NULL
     OR required_generation <> 'phase2_team_control_plane_v2_durable_access'
     OR activation_state IS DISTINCT FROM 'ACTIVE'
     OR writer_generation IS DISTINCT FROM required_generation THEN
    RAISE EXCEPTION 'PHASE2_INCOMPATIBLE_TEAM_CONTROL_PLANE_WRITER'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Member/current-role topology.
DROP TRIGGER IF EXISTS "phase2_team_writer_generation_agency_member" ON "AgencyMember";
CREATE TRIGGER "phase2_team_writer_generation_agency_member"
BEFORE INSERT OR UPDATE OR DELETE ON "AgencyMember"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

DROP TRIGGER IF EXISTS "phase2_team_writer_generation_member_function" ON "TeamMemberFunction";
CREATE TRIGGER "phase2_team_writer_generation_member_function"
BEFORE INSERT OR UPDATE OR DELETE ON "TeamMemberFunction"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

DROP TRIGGER IF EXISTS "phase2_team_writer_generation_custom_role" ON "AgencyCustomRole";
CREATE TRIGGER "phase2_team_writer_generation_custom_role"
BEFORE INSERT OR UPDATE OR DELETE ON "AgencyCustomRole"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

DROP TRIGGER IF EXISTS "phase2_team_writer_generation_role_override" ON "AgencyRoleOverride";
CREATE TRIGGER "phase2_team_writer_generation_role_override"
BEFORE INSERT OR UPDATE OR DELETE ON "AgencyRoleOverride"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

DROP TRIGGER IF EXISTS "phase2_team_writer_generation_subpermission_override" ON "AgencySubPermissionOverride";
CREATE TRIGGER "phase2_team_writer_generation_subpermission_override"
BEFORE INSERT OR UPDATE OR DELETE ON "AgencySubPermissionOverride"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

DROP TRIGGER IF EXISTS "phase2_team_writer_generation_invitation" ON "AgencyInvitation";
CREATE TRIGGER "phase2_team_writer_generation_invitation"
BEFORE INSERT OR UPDATE OR DELETE ON "AgencyInvitation"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

-- Cross-Agency lifecycle facts. User lifecycle changes and Agency lifecycle/new-live-Agency
-- creation are fenced; ordinary User/Agency metadata and billing writes remain outside Team release.
DROP TRIGGER IF EXISTS "phase2_team_writer_generation_user_disabled" ON "User";
CREATE TRIGGER "phase2_team_writer_generation_user_disabled"
BEFORE UPDATE OF "disabledAt" OR DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

DROP TRIGGER IF EXISTS "phase2_team_writer_generation_agency_lifecycle" ON "Agency";
CREATE TRIGGER "phase2_team_writer_generation_agency_lifecycle"
BEFORE INSERT OR UPDATE OF "deletedAt" OR DELETE ON "Agency"
FOR EACH ROW EXECUTE FUNCTION phase2_require_team_control_plane_generation();

INSERT INTO "Phase2ReleaseCompatibilityAuthority"(
  "scope","requiredGeneration","activationState","drainStartedAt",
  "activatedAt","activationConfirmedAt","createdAt","updatedAt"
) VALUES (
  'TEAM_CONTROL_PLANE',
  'phase2_team_control_plane_v2_durable_access',
  'DRAINING',
  CURRENT_TIMESTAMP,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("scope") DO UPDATE SET
  "requiredGeneration"=EXCLUDED."requiredGeneration",
  "activationState"='DRAINING',
  "drainStartedAt"=COALESCE("Phase2ReleaseCompatibilityAuthority"."drainStartedAt", CURRENT_TIMESTAMP),
  "activatedAt"=NULL,
  "activationConfirmedAt"=NULL,
  "updatedAt"=CURRENT_TIMESTAMP;

COMMIT;
