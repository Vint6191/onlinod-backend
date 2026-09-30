-- Explicit contract only. Use phase7-deploy.js; never auto-purge on ordinary deploy.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE "AnalyticsSnapshot","AutomationJob","CreatorCampaignsSnapshot","CreatorEarningsSnapshot","FanObservationClock","ImpersonationToken","TeamPendingDialogState","TeamResponseCase","TrafficDailyAggregate" IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE c record; rr record; role_name text; expected text; actual text; seen integer := 0;
BEGIN
 actual := phase7_storage_fingerprint();
 FOR c IN SELECT * FROM "Phase7RetirementCohort" WHERE "id"=ANY(ARRAY['analytics_compat','automation_job','impersonation_retired','observation_bridge','team_compat','traffic_aggregate']) ORDER BY "id" FOR UPDATE LOOP
   seen:=seen+1;
   IF c."planHash"<>'9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac' OR c."state"<>'PURGE_READY' OR NOT c."enumerationComplete"
    OR c."rollbackClosedAt" IS NULL OR c."verifiedAt" IS NULL OR c."fingerprint" IS DISTINCT FROM actual
    OR c."releaseManifest"->>'generation' IS DISTINCT FROM 'phase7_legacy_storage_v1'
    OR c."releaseManifest"->>'planHash' IS DISTINCT FROM c."planHash"
    OR length(COALESCE(c."releaseManifest"->>'backendHash',''))<>64
    OR length(COALESCE(c."releaseManifest"->>'desktopHash',''))<>64
    OR length(COALESCE(c."releaseManifest"->>'operatorEvidenceHash',''))<>64
    OR c."releaseManifest"->'roleReport'->>'verified' IS DISTINCT FROM 'true'
    OR c."releaseManifest"->'operatorEvidence'->>'noOldBinariesRemain' IS DISTINCT FROM 'true'
    OR c."releaseManifest"->'operatorEvidence'->>'backendHash' IS DISTINCT FROM c."releaseManifest"->>'backendHash'
    OR c."releaseManifest"->'operatorEvidence'->>'desktopHash' IS DISTINCT FROM c."releaseManifest"->>'desktopHash'
    OR c."releaseManifest"->'operatorEvidence'->>'rollbackMode' IS DISTINCT FROM 'restore_database_and_matching_sources'
    OR c."releaseManifest"->'operatorEvidence'->'archive'->>'durability' IS DISTINCT FROM 'persistent_backup'
    OR COALESCE((c."releaseManifest"->'operatorEvidence'->'archive'->>'retentionUntil')::timestamptz,'-infinity')<=clock_timestamp()
   THEN RAISE EXCEPTION 'PHASE7_CONTRACT_RECEIPT_INVALID:%',c."id"; END IF;
   IF jsonb_array_length(COALESCE(c."releaseManifest"->'roleReport'->'runtimeRoles','[]'::jsonb)) NOT BETWEEN 1 AND 32
   THEN RAISE EXCEPTION 'PHASE7_RUNTIME_ROLE_SEPARATION_REQUIRED'; END IF;
   FOR role_name IN SELECT r->>'name' FROM jsonb_array_elements(c."releaseManifest"->'roleReport'->'runtimeRoles') r LOOP
     SELECT * INTO rr FROM pg_roles WHERE rolname=role_name;
     IF NOT FOUND OR rr.rolsuper OR rr.rolcreaterole OR rr.rolbypassrls
       OR has_schema_privilege(rr.oid,'public','CREATE')
       OR EXISTS(SELECT 1 FROM pg_roles owner WHERE (owner.rolsuper OR owner.rolcreaterole) AND pg_has_role(rr.oid,owner.oid,'MEMBER'))
       OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relkind IN ('r','p') AND pg_has_role(rr.oid,t.relowner,'MEMBER'))
       OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public' AND pg_has_role(rr.oid,f.proowner,'MEMBER'))
     THEN RAISE EXCEPTION 'PHASE7_RUNTIME_ROLE_UNSAFE:%',role_name; END IF;
   END LOOP;
   IF expected IS NULL THEN expected:=c."releaseManifest"::text; END IF;
   IF expected<>c."releaseManifest"::text THEN RAISE EXCEPTION 'PHASE7_RELEASE_MISMATCH'; END IF;
   IF EXISTS(SELECT 1 FROM "Phase7RetirementPartition" p WHERE p."cohortId"=c."id" AND p."state"<>'VERIFIED')
   THEN RAISE EXCEPTION 'PHASE7_PARTITION_UNVERIFIED'; END IF;
 END LOOP;
 IF seen<>6 THEN RAISE EXCEPTION 'PHASE7_COHORT_SET_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "legacyStorageGeneration" IS DISTINCT FROM 'phase7_legacy_storage_v1' AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED'))
 OR EXISTS(SELECT 1 FROM "JobInstance" WHERE "legacyStorageGeneration" IS DISTINCT FROM 'phase7_legacy_storage_v1' AND "status" IN ('CLAIMED','RUNNING'))
 OR EXISTS(SELECT 1 FROM "DomainWorkItem" WHERE "legacyStorageGeneration" IS DISTINCT FROM 'phase7_legacy_storage_v1' AND "state"='CLAIMED')
 THEN RAISE EXCEPTION 'PHASE7_OLD_EXECUTION_NOT_DRAINED'; END IF;
 IF EXISTS(SELECT 1 FROM "AutomationDelivery" WHERE "moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET'
 AND "payload"->>'legacyMigration'='true' AND "legacyCleanupProofId" IS NULL
 AND "status" IN ('QUEUED','CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED','RETRY_SCHEDULED','PAUSED'))
 THEN RAISE EXCEPTION 'PHASE7_CLEANUP_HANDOFF_INCOMPLETE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "SystemSetting" WHERE "key"='phase3.fanObservationCreatorClockV1'
 AND "value"->>'active'='true' AND ("value"->>'epoch')::int>=1 AND nullif("value"->>'floorObservedAt','') IS NOT NULL)
 THEN RAISE EXCEPTION 'PHASE7_CLOCK_NOT_ACTIVE'; END IF;
END $$;
DROP TABLE "AnalyticsSnapshot" RESTRICT;
DROP TABLE "AutomationJob" RESTRICT;
DROP TABLE "CreatorCampaignsSnapshot" RESTRICT;
DROP TABLE "CreatorEarningsSnapshot" RESTRICT;
DROP TABLE "FanObservationClock" RESTRICT;
DROP TABLE "ImpersonationToken" RESTRICT;
DROP TABLE "TeamPendingDialogState" RESTRICT;
DROP TABLE "TeamResponseCase" RESTRICT;
DROP TABLE "TrafficDailyAggregate" RESTRICT;
UPDATE "Phase7RetirementCohort" SET "state"='PURGED',"purgedAt"=clock_timestamp(),"revision"="revision"+1,"updatedAt"=clock_timestamp()
 WHERE "id"=ANY(ARRAY['analytics_compat','automation_job','impersonation_retired','observation_bridge','team_compat','traffic_aggregate']);
COMMIT;
