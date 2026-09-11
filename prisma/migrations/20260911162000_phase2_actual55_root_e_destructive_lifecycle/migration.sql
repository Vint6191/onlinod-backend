BEGIN;

-- ONLINOD Phase 2 / Actual55 Root E closure.
-- Agency hard deletion joins the canonical DomainWork generation instead of
-- executing one tenant-wide HTTP transaction. Creator/Agency cleanup workers
-- then physically drain cascade descendants in bounded deepest-first batches.
INSERT INTO "Phase2WorkGenerationAuthority"(
  "workClass","activeGeneration","projectionVersion","revision","previousGeneration","activatedAt","createdAt","updatedAt"
)
VALUES(
  'DESTRUCTIVE_AGENCY_CLEANUP',
  'phase2_domain_work_v3_actual55',
  'phase2_domain_work_v3_actual55',
  1,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("workClass") DO UPDATE SET
  "previousGeneration"=CASE
    WHEN "Phase2WorkGenerationAuthority"."activeGeneration" <> EXCLUDED."activeGeneration"
    THEN "Phase2WorkGenerationAuthority"."activeGeneration"
    ELSE "Phase2WorkGenerationAuthority"."previousGeneration"
  END,
  "activeGeneration"=EXCLUDED."activeGeneration",
  "projectionVersion"=EXCLUDED."projectionVersion",
  "revision"=CASE
    WHEN "Phase2WorkGenerationAuthority"."activeGeneration" <> EXCLUDED."activeGeneration"
    THEN "Phase2WorkGenerationAuthority"."revision"+1
    ELSE "Phase2WorkGenerationAuthority"."revision"
  END,
  "activatedAt"=CASE
    WHEN "Phase2WorkGenerationAuthority"."activeGeneration" <> EXCLUDED."activeGeneration"
    THEN CURRENT_TIMESTAMP ELSE "Phase2WorkGenerationAuthority"."activatedAt" END,
  "updatedAt"=CURRENT_TIMESTAMP;

COMMIT;
