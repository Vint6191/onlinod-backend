-- ONLINOD Phase 2 / Actual56 closure — M1 Team control-plane rolling activation.
--
-- The C2 total lock order is intentionally incompatible with old Member/Role
-- writers that never acquired the Team topology fence. PostgreSQL cannot repair
-- that old lock order after the old transaction has already taken Member/Role
-- locks, so the new binary must not enter the new C2 lock graph during overlap.
--
-- Cutover contract:
--   migration -> DRAINING
--   deploy new binary (Team control-plane writes fail closed before business locks)
--   drain every incompatible old binary
--   explicit operator activation -> ACTIVE
--
-- New-binary Team transactions hold the shared release advisory fence before
-- reading ACTIVE. Activation holds the exclusive form of the same fence, so an
-- activation commit cannot race a newly admitted C2 transaction.

BEGIN;

ALTER TABLE "Phase2ReleaseCompatibilityAuthority"
  ADD COLUMN IF NOT EXISTS "activationState" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "drainStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activationConfirmedAt" TIMESTAMP(3);

ALTER TABLE "Phase2ReleaseCompatibilityAuthority"
  ALTER COLUMN "activatedAt" DROP NOT NULL;

ALTER TABLE "Phase2ReleaseCompatibilityAuthority"
  DROP CONSTRAINT IF EXISTS "Phase2ReleaseCompatibilityAuthority_activationState_check";
ALTER TABLE "Phase2ReleaseCompatibilityAuthority"
  ADD CONSTRAINT "Phase2ReleaseCompatibilityAuthority_activationState_check"
  CHECK ("activationState" IN ('DRAINING','ACTIVE'));

INSERT INTO "Phase2ReleaseCompatibilityAuthority"(
  "scope","requiredGeneration","activationState","drainStartedAt",
  "activatedAt","activationConfirmedAt","createdAt","updatedAt"
) VALUES (
  'TEAM_CONTROL_PLANE',
  'phase2_team_control_plane_v1_actual56_postcut',
  'DRAINING',
  CURRENT_TIMESTAMP,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("scope") DO UPDATE SET
  "requiredGeneration"=EXCLUDED."requiredGeneration",
  "activationState"=CASE
    WHEN "Phase2ReleaseCompatibilityAuthority"."requiredGeneration"=EXCLUDED."requiredGeneration"
      AND "Phase2ReleaseCompatibilityAuthority"."activationState"='ACTIVE'
    THEN 'ACTIVE'
    ELSE 'DRAINING'
  END,
  "drainStartedAt"=CASE
    WHEN "Phase2ReleaseCompatibilityAuthority"."requiredGeneration"=EXCLUDED."requiredGeneration"
      AND "Phase2ReleaseCompatibilityAuthority"."activationState"='ACTIVE'
    THEN "Phase2ReleaseCompatibilityAuthority"."drainStartedAt"
    ELSE CURRENT_TIMESTAMP
  END,
  "activatedAt"=CASE
    WHEN "Phase2ReleaseCompatibilityAuthority"."requiredGeneration"=EXCLUDED."requiredGeneration"
      AND "Phase2ReleaseCompatibilityAuthority"."activationState"='ACTIVE'
    THEN "Phase2ReleaseCompatibilityAuthority"."activatedAt"
    ELSE NULL
  END,
  "activationConfirmedAt"=CASE
    WHEN "Phase2ReleaseCompatibilityAuthority"."requiredGeneration"=EXCLUDED."requiredGeneration"
      AND "Phase2ReleaseCompatibilityAuthority"."activationState"='ACTIVE'
    THEN "Phase2ReleaseCompatibilityAuthority"."activationConfirmedAt"
    ELSE NULL
  END,
  "updatedAt"=CURRENT_TIMESTAMP;

COMMIT;
