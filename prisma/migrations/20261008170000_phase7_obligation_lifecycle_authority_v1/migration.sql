-- One durable cleanup identity survives source export, settlement and retention.
-- The old contract remains byte-identical; its final cohort update is guarded
-- inside the same transaction, so refusal also rolls back every preceding DROP.
BEGIN;
CREATE UNIQUE INDEX "phase7_cleanup_one_settlement" ON "Phase7RetirementProof"("deliveryId")
 WHERE "kind"='SETTLED' AND "sourceTable"='AutomationDelivery';

CREATE OR REPLACE FUNCTION phase7_cleanup_attested(delivery_id text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
 SELECT EXISTS(SELECT 1 FROM "AutomationDelivery" d
 JOIN "Phase7RetirementProof" p ON p."id"=d."legacyCleanupProofId"
 JOIN "CreatorAccount" c ON c."id"=d."creatorId" AND c."agencyId"=d."agencyId"
 JOIN "SfsTargetCandidate" k ON k."id"=d."payload"->>'candidateId' AND k."agencyId"=d."agencyId" AND k."creatorId"=d."creatorId"
 WHERE d."id"=delivery_id AND d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET' AND d."payload"->>'legacyMigration'='true'
 AND p."kind"='SFS_CLEANUP' AND p."cohortId"='automation_job' AND p."classifierVersion"=1 AND p."sourceHash" ~ '^[a-f0-9]{64}$'
 AND ((p."sourceTable"='AutomationJob' AND p."sourceId"=d."payload"->>'sourceJobId') OR (p."sourceTable"='AutomationDelivery' AND p."sourceId"=d."id"))
 AND p."deliveryId"=d."id" AND p."agencyId"=d."agencyId" AND p."creatorId"=d."creatorId"
 AND p."targetId"=d."targetId" AND p."targetId"=d."fanId" AND p."generation"=d."generation" AND p."generation">0
 AND p."providerSubject"=c."remoteId" AND COALESCE(c."remoteId",'')<>''
 AND k."targetUserId"=d."targetId" AND k."safetyUnfollowDeliveryId"=d."id" AND p."evidence"->>'candidateId'=k."id"
 AND ((p."evidence"->>'basis'='CURRENT_FOLLOW_RECEIPT' AND COALESCE(p."evidence"->>'followDeliveryId','')<>'')
   OR (p."evidence"->>'basis' ~ '^P14_ACCEPTED_COMPENSATION:[a-f0-9]{64}$' AND p."evidence"->'followDeliveryId'='null'::jsonb))
 AND NOT (COALESCE(k."metadata"->>'followEffectOwnership','')='OWNED' AND COALESCE(k."metadata"->>'followEffectDeliveryId','')<>''
   AND k."metadata"->>'followEffectDeliveryId' IS DISTINCT FROM p."evidence"->>'followDeliveryId'))
$fn$;

CREATE OR REPLACE FUNCTION phase7_preserve_cleanup_settlements(delivery_ids text[]) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE inserted integer;
BEGIN
 IF cardinality(delivery_ids)>500 OR current_setting('onlinod.phase7_executor_generation',true) IS DISTINCT FROM 'phase7_legacy_storage_v1'
 THEN RAISE EXCEPTION 'PHASE7_SETTLEMENT_WRITER_REQUIRED'; END IF;
 WITH receipts AS MATERIALIZED (
   SELECT d.*,p."providerSubject",p."evidence"->>'candidateId' AS candidate_id,
     jsonb_build_object('basis','CURRENT_CLEANUP_RECEIPT','cleanupProofId',p."id",'candidateId',p."evidence"->>'candidateId',
       'outcomeCode',d."result"->>'code','finishedAt',to_char(d."finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'writeCommitAt',to_char(d."writeCommitAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS evidence
   FROM "AutomationDelivery" d JOIN "Phase7RetirementProof" p ON p."id"=d."legacyCleanupProofId"
   WHERE d."id"=ANY(delivery_ids) AND d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET'
     AND d."payload"->>'legacyMigration'='true' AND d."status"='COMPLETED' AND d."finishedAt" IS NOT NULL
     AND COALESCE(d."result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered')
     AND (d."result"->>'code'='already_unfollowed' OR d."writeCommitAt" IS NOT NULL) AND phase7_cleanup_attested(d."id")
 ), identities AS (
   SELECT r.*,encode(sha256(convert_to(jsonb_build_array(r."id",r."agencyId",r."creatorId",r."targetId",r."generation",r.evidence)::text,'UTF8')),'hex') AS source_hash FROM receipts r
 ) INSERT INTO "Phase7RetirementProof"("id","cohortId","sourceTable","sourceId","sourceHash","kind","agencyId","creatorId",
   "providerSubject","targetId","generation","deliveryId","evidence")
 SELECT 'settled:'||source_hash,'automation_job','AutomationDelivery',"id",source_hash,'SETTLED',"agencyId","creatorId",
   "providerSubject","targetId","generation","id",evidence FROM identities ORDER BY "id" ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 RETURN inserted;
END
$fn$;

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
 -- Pin each live execution identity through the transaction's final commit.
 PERFORM d."id" FROM "AutomationDelivery" d JOIN "CreatorAccount" c ON c."id"=d."creatorId"
 JOIN "SfsTargetCandidate" k ON k."id"=d."payload"->>'candidateId'
 WHERE d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET' AND d."payload"->>'legacyMigration'='true'
   AND NOT (d."status"='COMPLETED' AND d."finishedAt" IS NOT NULL AND COALESCE(d."result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered')
     AND (d."result"->>'code'='already_unfollowed' OR d."writeCommitAt" IS NOT NULL)) FOR SHARE OF d,c,k;
 IF EXISTS(SELECT 1 FROM "AutomationDelivery" d WHERE d."moduleKey"='sfs' AND d."actionType"='SFS_UNFOLLOW_TARGET'
   AND d."payload"->>'legacyMigration'='true' AND NOT phase7_cleanup_attested(d."id")
   AND NOT (d."status"='COMPLETED' AND d."finishedAt" IS NOT NULL AND COALESCE(d."result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered')
     AND (d."result"->>'code'='already_unfollowed' OR d."writeCommitAt" IS NOT NULL)))
 THEN RAISE EXCEPTION 'PHASE7_CLEANUP_HANDOFF_INCOMPLETE'; END IF;
 RETURN NEW;
END
$fn$;
CREATE TRIGGER phase7_retirement_admission BEFORE UPDATE ON "Phase7RetirementCohort"
 FOR EACH ROW EXECUTE FUNCTION phase7_retirement_admission_guard();
COMMIT;
