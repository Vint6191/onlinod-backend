BEGIN;
-- Preserve the preceding generation for rolling deployment and its turn counts.
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount","lastAdmittedAt")
SELECT 'phase6_maintenance_registry_v5',"laneName","ordinal","turnCount","lastAdmittedAt"
FROM "MaintenanceAdmissionClassState" WHERE "generation"='phase6_maintenance_registry_v4'
ON CONFLICT ("generation","laneName") DO NOTHING;
INSERT INTO "MaintenanceAdmissionClassState"("generation","laneName","ordinal","turnCount")
SELECT 'phase6_maintenance_registry_v5','massObservationRetention',29,COALESCE(min("turnCount"),0)
FROM "MaintenanceAdmissionClassState" WHERE "generation"='phase6_maintenance_registry_v4'
ON CONFLICT ("generation","laneName") DO NOTHING;


COMMIT;
