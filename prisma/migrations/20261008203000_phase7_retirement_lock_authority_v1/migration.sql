-- Archive, scoped lifecycle deletion and destructive admission share one
-- metadata order. Historical migration bytes and contract SQL stay unchanged.
-- A contention refusal aborts the entire transaction; retry starts from a new
-- lease/scope/source epoch. Never continue after a partially acquired prefix.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Finite, shared source relation pins. Compatible with normal readers and
-- lifecycle writes; only schema destruction conflicts. No tenant enumeration.
CREATE OR REPLACE FUNCTION phase7_lock_retirement_sources() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE relations text;
BEGIN
 SELECT string_agg(format('%I.%I',n.nspname,c.relname),',' ORDER BY c.relname) INTO relations
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=ANY(ARRAY[
   'AnalyticsSnapshot','AutomationJob','CreatorCampaignsSnapshot','CreatorEarningsSnapshot','FanObservationClock',
   'ImpersonationToken','TeamPendingDialogState','TeamResponseCase','TrafficDailyAggregate']);
 IF relations IS NOT NULL THEN EXECUTE 'LOCK TABLE '||relations||' IN ACCESS SHARE MODE NOWAIT'; END IF;
EXCEPTION WHEN lock_not_available OR undefined_table THEN
 RAISE EXCEPTION 'PHASE7_RETIREMENT_BUSY' USING ERRCODE='55P03';
END
$fn$;

CREATE OR REPLACE FUNCTION phase7_lock_retirement_cohort(cohort_id text)
 RETURNS "Phase7RetirementCohort" LANGUAGE plpgsql AS $fn$
DECLARE c "Phase7RetirementCohort";
BEGIN
 IF cohort_id IS NULL OR cohort_id<>ALL(ARRAY['analytics_compat','automation_job','impersonation_retired',
   'observation_bridge','team_compat','traffic_aggregate']) THEN RAISE EXCEPTION 'PHASE7_COHORT_INVALID'; END IF;
 LOCK TABLE "Phase7RetirementCohort" IN ROW SHARE MODE NOWAIT;
 SELECT * INTO c FROM "Phase7RetirementCohort" WHERE "id"=cohort_id FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND OR c."planHash"<>'9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac'
 THEN RAISE EXCEPTION 'PHASE7_STORAGE_MANIFEST_MISMATCH'; END IF;
 RETURN c;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'PHASE7_RETIREMENT_BUSY' USING ERRCODE='55P03';
END
$fn$;

CREATE OR REPLACE FUNCTION phase7_legacy_storage_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; agency text; creator text; source_hash text; partition_key text; detached boolean := false; allowed text[];
BEGIN
 -- Only PostgreSQL FK detach is admitted; direct updates and payload edits stay frozen.
 IF TG_OP='UPDATE' AND TG_ARGV[2]='ARCHIVE_RETAIN' AND (pg_trigger_depth()>1 OR current_setting('onlinod.phase7_lifecycle_generation',true)='phase7_legacy_storage_v1') THEN
   allowed := CASE TG_TABLE_NAME
 WHEN 'AutomationLog' THEN ARRAY['createdByUserId','runId']
 WHEN 'AutomationRun' THEN ARRAY['createdByUserId','ruleId']
 WHEN 'CampaignDraft' THEN ARRAY['segmentId']
 WHEN 'CreatorPresenceSnapshot' THEN ARRAY['updatedByDeviceId']
 WHEN 'CreatorPresenceUser' THEN ARRAY['updatedByDeviceId']
 WHEN 'CrmAnalysisRun' THEN ARRAY['profileId']
 WHEN 'FanList' THEN ARRAY['creatorId']
 WHEN 'FanListMember' THEN ARRAY['creatorId']
 WHEN 'MessageTemplate' THEN ARRAY['groupId']
 WHEN 'MessageTemplateUsageEvent' THEN ARRAY['creatorId','userId']
 WHEN 'SavedSegment' THEN ARRAY['creatorId']
 WHEN 'VaultPurchaseLedger' THEN ARRAY['messageLedgerId']
   ELSE ARRAY[]::text[] END;
   detached := to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) AND NOT EXISTS (
     SELECT 1 FROM jsonb_each(to_jsonb(NEW)) n WHERE n.value IS DISTINCT FROM to_jsonb(OLD)->n.key
     AND NOT (n.key=ANY(allowed) AND n.value='null'::jsonb));
 END IF;
 IF TG_OP <> 'DELETE' AND NOT detached THEN RAISE EXCEPTION 'PHASE7_LEGACY_STORAGE_READ_ONLY:%',TG_TABLE_NAME; END IF;
 r := to_jsonb(OLD); agency := r->>TG_ARGV[1]; creator := r->>'creatorId';
 IF NOT (detached AND pg_trigger_depth()>1) AND (TG_ARGV[1] = '' OR nullif(current_setting('onlinod.phase7_lifecycle_agency',true),'') IS DISTINCT FROM agency
    OR nullif(current_setting('onlinod.phase7_lifecycle_generation',true),'') IS DISTINCT FROM 'phase7_legacy_storage_v1'
    OR (nullif(current_setting('onlinod.phase7_lifecycle_creator',true),'') IS NOT NULL AND creator IS NOT NULL
        AND current_setting('onlinod.phase7_lifecycle_creator',true) IS DISTINCT FROM creator))
 THEN RAISE EXCEPTION 'PHASE7_SCOPED_LIFECYCLE_REQUIRED:%',TG_TABLE_NAME; END IF;
 -- A lifecycle transaction may reach several cohorts in either domain order.
 -- Never wait for a second cohort while holding source/business/partition rows.
 -- NO KEY UPDATE keeps immutable proof FK checks compatible with this owner.
 IF TG_ARGV[2]='COMPAT_DRAIN_DROP' THEN
   PERFORM phase7_lock_retirement_sources();
   PERFORM phase7_lock_retirement_cohort(TG_ARGV[0]);
 END IF;
 source_hash := encode(sha256(convert_to(r::text,'UTF8')),'hex');
 IF TG_TABLE_NAME='AutomationJob' AND NOT EXISTS (
   SELECT 1 FROM "Phase7RetirementProof" WHERE "sourceTable"=TG_TABLE_NAME AND "sourceId"=r->>'id'
   AND "sourceHash"=source_hash AND "kind" IN ('CONSUMED','SFS_CLEANUP','SETTLED','NO_EFFECT')
 ) THEN RAISE EXCEPTION 'PHASE7_LEGACY_OBLIGATION_NOT_REPRESENTED'; END IF;
 INSERT INTO "Phase7RetirementProof"("id","cohortId","sourceTable","sourceId","sourceHash","kind","agencyId","creatorId","evidence")
 VALUES ('delete:'||md5(TG_TABLE_NAME||':'||(r->>'id')||':'||source_hash),TG_ARGV[0],TG_TABLE_NAME,r->>'id',source_hash,'LIFECYCLE',agency,creator,
 jsonb_build_object('disposition',CASE WHEN detached THEN 'FOREIGN_KEY_DETACH' ELSE 'AUTHORIZED_DOMAIN_DELETE' END)) ON CONFLICT DO NOTHING;
 IF TG_ARGV[2]='COMPAT_DRAIN_DROP' THEN
   partition_key := TG_TABLE_NAME||':'||md5('a:'||agency);
   INSERT INTO "Phase7RetirementPartition"("id","cohortId","tableName","agencyKey","agencyId","sourceEpoch")
   VALUES(partition_key,TG_ARGV[0],TG_TABLE_NAME,'a:'||agency,agency,2)
   ON CONFLICT("tableName","agencyKey") DO UPDATE SET
     "sourceEpoch"="Phase7RetirementPartition"."sourceEpoch"+1,"cursor"=NULL,"upperBound"=NULL,
     "rows"=0,"bytes"=0,"digest"='',"sequence"=0,"state"='PENDING',"ownerToken"=NULL,"leaseUntil"=NULL,
     "archiveVerifiedAt"=NULL,"verifiedDigest"=NULL,"verifiedSequence"=0,"restoreRoot"=NULL,"nextAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP;
   UPDATE "Phase7RetirementCohort" SET "state"='DRAINING',"revision"="revision"+1,"verifiedAt"=NULL,"updatedAt"=CURRENT_TIMESTAMP
   WHERE "id"=TG_ARGV[0] AND "state" IN ('VERIFIED','PURGE_READY');
 END IF;
 IF detached THEN RETURN NEW; END IF;
 RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION phase7_retirement_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE archive jsonb; role_name text; r record;
BEGIN
 IF OLD."state"='PURGED' AND NEW."state"<>'PURGED' THEN RAISE EXCEPTION 'PHASE7_PURGE_IS_IRREVERSIBLE'; END IF;
 IF OLD."state"='PURGED' THEN
   IF NEW."releaseManifest" IS DISTINCT FROM OLD."releaseManifest" OR NEW."planHash" IS DISTINCT FROM OLD."planHash"
     OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt" OR NEW."rollbackClosedAt" IS DISTINCT FROM OLD."rollbackClosedAt"
   THEN RAISE EXCEPTION 'PHASE7_PURGED_RECEIPT_IMMUTABLE'; END IF;
   RETURN NEW;
 END IF;
 IF NEW."state" NOT IN ('PURGE_READY','PURGED') OR NEW."id" NOT IN
   ('analytics_compat','automation_job','impersonation_retired','observation_bridge','team_compat','traffic_aggregate') THEN RETURN NEW; END IF;
 archive:=NEW."releaseManifest"->'operatorEvidence'->'archive';
 IF NEW."planHash"<>'9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac' OR NOT NEW."enumerationComplete"
   OR NEW."verifiedAt" IS NULL OR NEW."rollbackClosedAt" IS NULL
   OR COALESCE(archive->>'exportRoot','') !~ '^[a-f0-9]{64}$' OR COALESCE(archive->>'restoreRoot','') !~ '^[a-f0-9]{64}$'
   OR archive->>'exportRoot' IS NOT DISTINCT FROM archive->>'restoreRoot'
   OR COALESCE((archive->>'retentionUntil')::timestamptz,'-infinity')<=clock_timestamp()
 THEN RAISE EXCEPTION 'PHASE7_CONTRACT_RECEIPT_INVALID:%',NEW."id"; END IF;
 IF EXISTS(SELECT 1 FROM "Phase7RetirementPartition" p LEFT JOIN LATERAL (
     SELECT count(*) n,COALESCE(sum(c."rows"),0) rows,COALESCE(sum(c."bytes"),0) bytes,min(c."sequence") first,max(c."sequence") last
     FROM "Phase7RetirementChunk" c WHERE c."partitionId"=p."id" AND c."sourceEpoch"=p."sourceEpoch") c ON true
   WHERE p."cohortId"=NEW."id" AND (p."state"<>'VERIFIED' OR p."sourceEpoch"<1 OR p."sequence"<0
     OR p."archiveVerifiedAt" IS NULL OR p."restoreRoot" IS DISTINCT FROM archive->>'restoreRoot'
     OR p."verifiedSequence"<>p."sequence" OR COALESCE(p."verifiedDigest",'')<>p."digest"
     OR c.n<>p."sequence" OR c.rows<>p."rows" OR c.bytes<>p."bytes"
     OR (p."sequence"=0 AND (p."rows"<>0 OR p."bytes"<>0 OR p."digest"<>'' OR p."cursor" IS NOT NULL))
     OR (p."sequence">0 AND (p."archiveRoot" IS DISTINCT FROM archive->>'exportRoot' OR c.first<>1 OR c.last<>p."sequence"
       OR p."rows"<p."sequence" OR p."bytes"<=0 OR p."digest" !~ '^[a-f0-9]{64}$'
       OR p."cursor" IS NULL OR p."upperBound" IS NULL OR p."cursor" IS DISTINCT FROM p."upperBound"))))
 THEN RAISE EXCEPTION 'PHASE7_ARCHIVE_ADMISSION_INCONSISTENT'; END IF;
 IF jsonb_typeof(NEW."releaseManifest"->'roleReport'->'runtimeRoles') IS DISTINCT FROM 'array'
   OR jsonb_array_length(NEW."releaseManifest"->'roleReport'->'runtimeRoles') NOT BETWEEN 1 AND 32
 THEN RAISE EXCEPTION 'PHASE7_RUNTIME_ROLE_SEPARATION_REQUIRED'; END IF;
 FOR role_name IN SELECT x->>'name' FROM jsonb_array_elements(NEW."releaseManifest"->'roleReport'->'runtimeRoles') x LOOP
   SELECT * INTO r FROM pg_roles WHERE rolname=role_name;
   IF NOT FOUND OR r.rolsuper OR r.rolcreaterole OR r.rolbypassrls OR r.rolcreatedb OR r.rolreplication
     OR has_schema_privilege(r.oid,'public','CREATE')
     OR EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(r.oid,d.datdba,'MEMBER'))
     OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND pg_has_role(r.oid,n.nspowner,'MEMBER'))
     OR EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolcreaterole OR p.rolbypassrls OR p.rolcreatedb OR p.rolreplication) AND pg_has_role(r.oid,p.oid,'MEMBER'))
     OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relkind IN ('r','p') AND pg_has_role(r.oid,t.relowner,'MEMBER'))
     OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND pg_has_role(r.oid,p.proowner,'MEMBER'))
   THEN RAISE EXCEPTION 'PHASE7_RUNTIME_ROLE_UNSAFE:%',role_name; END IF;
 END LOOP;
 -- The historical contract already owns source tables and cohort rows here.
 -- Runtime mutations enter through Agency/Creator/Candidate/Delivery instead.
 -- Refuse contention immediately; waiting here would reverse that authority.
 -- Include the relation locks: row-level NOWAIT alone does not cover DDL.
 LOCK TABLE "CreatorAccount","SfsTargetCandidate","AutomationDelivery" IN ROW SHARE MODE NOWAIT;
 -- Pin each live execution identity through the transaction's final commit.
 PERFORM d."id" FROM "AutomationDelivery" d JOIN "CreatorAccount" c ON c."id"=d."creatorId"
 JOIN "SfsTargetCandidate" k ON k."id"=d."payload"->>'candidateId'
 WHERE d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET' AND d."payload"->>'legacyMigration'='true'
   AND NOT (d."status"='COMPLETED' AND d."finishedAt" IS NOT NULL AND COALESCE(d."result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered')
     AND (d."result"->>'code'='already_unfollowed' OR d."writeCommitAt" IS NOT NULL)) FOR SHARE OF d,c,k NOWAIT;
 IF EXISTS(SELECT 1 FROM "AutomationDelivery" d WHERE d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET'
   AND d."payload"->>'legacyMigration'='true' AND NOT phase7_cleanup_attested(d."id")
   AND NOT (d."status"='COMPLETED' AND d."finishedAt" IS NOT NULL AND COALESCE(d."result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered')
     AND (d."result"->>'code'='already_unfollowed' OR d."writeCommitAt" IS NOT NULL)))
 THEN RAISE EXCEPTION 'PHASE7_CLEANUP_HANDOFF_INCOMPLETE'; END IF;
 RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
 RAISE EXCEPTION 'PHASE7_RETIREMENT_BUSY' USING ERRCODE='55P03';
END
$fn$;
COMMIT;
