BEGIN;

-- The executable catalog includes this lane, but releases through v31
-- never installed its admission row. Preserve the existing dispatch history;
-- a new lane receives one early opportunity, then joins the fair sequence.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "MaintenanceAdmissionClassState" IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
BEGIN
  -- A conflicting identity is not an earlier release's missing seed. Refuse
  -- it instead of renumbering another lane or resetting recorded progress.
  IF EXISTS (
    SELECT 1 FROM "MaintenanceAdmissionClassState"
    WHERE "generation" = 'onlinod_maintenance_v1'
      AND (("laneName" = 'financialProofAdoption' AND "ordinal" <> 41)
        OR ("ordinal" = 41 AND "laneName" <> 'financialProofAdoption'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'MAINTENANCE_FINANCIAL_PROOF_CATALOG_CONFLICT';
  END IF;

  INSERT INTO "MaintenanceAdmissionClassState"
    ("generation", "laneName", "ordinal", "turnCount", "admissionSequence", "lastAdmittedAt")
  VALUES
    ('onlinod_maintenance_v1', 'financialProofAdoption', 41, 0, 0, NULL)
  ON CONFLICT ("generation", "laneName") DO NOTHING;
END;
$migration$;

COMMIT;
