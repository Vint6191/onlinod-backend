-- Phase 7: freeze old writers before any enumeration. Historical migrations stay unchanged.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE "AutomationDelivery" ADD COLUMN "legacyStorageGeneration" text, ADD COLUMN "legacyCleanupProofId" text;
ALTER TABLE "JobInstance" ADD COLUMN "legacyStorageGeneration" text;
ALTER TABLE "DomainWorkItem" ADD COLUMN "legacyStorageGeneration" text;
DO $$
DECLARE setting jsonb; floor_at timestamp(3);
BEGIN
 SELECT "value" INTO setting FROM "SystemSetting" WHERE "key"='phase3.fanObservationCreatorClockV1' FOR UPDATE;
 IF setting IS NULL THEN RAISE EXCEPTION 'PHASE7_CLOCK_BARRIER_MISSING'; END IF;
 IF (setting->>'active') IS DISTINCT FROM 'true' THEN
   SELECT "lastObservedAt" INTO floor_at FROM "FanObservationClock" WHERE "id"=1 FOR UPDATE;
   IF floor_at IS NULL OR floor_at > clock_timestamp() THEN RAISE EXCEPTION 'PHASE7_CLOCK_ACTIVATION_REQUIRED'; END IF;
   UPDATE "SystemSetting" SET "value"=jsonb_build_object('active',true,'epoch',GREATEST(0,COALESCE((setting->>'epoch')::int,0))+1,
     'floorObservedAt',floor_at,'activatedAt',clock_timestamp(),'activatedBy','phase7-forward-migration'),"updatedAt"=CURRENT_TIMESTAMP
   WHERE "key"='phase3.fanObservationCreatorClockV1';
 ELSE
   floor_at := (NULLIF(setting->>'floorObservedAt',''))::timestamp(3);
   IF floor_at IS NULL OR COALESCE((setting->>'epoch')::int,0)<1
   THEN RAISE EXCEPTION 'PHASE7_CLOCK_ACTIVE_STATE_INVALID'; END IF;
 END IF;
END $$;
CREATE TABLE "Phase7RetirementCohort" (
 "id" text PRIMARY KEY, "planHash" text NOT NULL, "state" text NOT NULL,
 "databaseEpoch" text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
 "enumeration" jsonb NOT NULL DEFAULT '{}', "enumerationComplete" boolean NOT NULL DEFAULT false,
 "revision" bigint NOT NULL DEFAULT 1, "rollbackClosedAt" timestamp(3),
 "releaseManifest" jsonb, "fingerprint" text, "fencedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "verifiedAt" timestamp(3), "purgedAt" timestamp(3), "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "phase7_cohort_state" CHECK ("state" IN ('WRITES_FENCED','DRAINING','BLOCKED','VERIFIED','PURGE_READY','PURGED','RETAINED_READ_ONLY'))
);
CREATE TABLE "Phase7RetirementPartition" (
 "id" text PRIMARY KEY, "cohortId" text NOT NULL REFERENCES "Phase7RetirementCohort"("id") ON DELETE RESTRICT,
 "tableName" text NOT NULL, "agencyKey" text NOT NULL, "agencyId" text,
 "sourceEpoch" bigint NOT NULL DEFAULT 1, "cursor" text, "upperBound" text,
 "rows" bigint NOT NULL DEFAULT 0, "bytes" bigint NOT NULL DEFAULT 0, "digest" text NOT NULL DEFAULT '',
 "sequence" integer NOT NULL DEFAULT 0, "state" text NOT NULL DEFAULT 'PENDING',
 "ownerToken" text, "leaseRevision" bigint NOT NULL DEFAULT 0, "leaseUntil" timestamp(3),
 "nextAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastError" text,
 "archiveRoot" text, "restoreRoot" text, "archiveVerifiedAt" timestamp(3), "verifiedDigest" text, "verifiedSequence" integer NOT NULL DEFAULT 0,
 "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("tableName","agencyKey"),
 CONSTRAINT "phase7_partition_state" CHECK ("state" IN ('PENDING','RUNNING','BLOCKED','EXPORTED','VERIFIED'))
);
CREATE INDEX "phase7_partition_due" ON "Phase7RetirementPartition"("state","nextAt","agencyKey","id");
CREATE INDEX "phase7_partition_cohort" ON "Phase7RetirementPartition"("cohortId","state","id");
CREATE INDEX "phase7_partition_unverified" ON "Phase7RetirementPartition"("cohortId","id") WHERE "state"<>'VERIFIED';
CREATE TABLE "Phase7RetirementChunk" (
 "id" text PRIMARY KEY, "partitionId" text NOT NULL REFERENCES "Phase7RetirementPartition"("id") ON DELETE RESTRICT,
 "sourceEpoch" bigint NOT NULL, "sequence" integer NOT NULL, "startCursor" text, "endCursor" text NOT NULL,
 "rows" integer NOT NULL, "bytes" integer NOT NULL, "digest" text NOT NULL, "previousDigest" text NOT NULL,
 "fileName" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("partitionId","sourceEpoch","sequence")
);
CREATE TABLE "Phase7RetirementProof" (
 "id" text PRIMARY KEY, "cohortId" text NOT NULL REFERENCES "Phase7RetirementCohort"("id") ON DELETE RESTRICT,
 "sourceTable" text NOT NULL, "sourceId" text NOT NULL, "sourceHash" text NOT NULL,
 "kind" text NOT NULL, "agencyId" text, "creatorId" text, "providerSubject" text, "targetId" text,
 "generation" integer, "deliveryId" text, "consumptionKey" text, "evidence" jsonb NOT NULL DEFAULT '{}',
 "classifierVersion" integer NOT NULL DEFAULT 1, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("sourceTable","sourceId","sourceHash","kind"),
 CONSTRAINT "phase7_evidence_size" CHECK (octet_length("evidence"::text) <= 8192)
);
CREATE UNIQUE INDEX "phase7_cleanup_one_proof" ON "Phase7RetirementProof"("deliveryId") WHERE "kind"='SFS_CLEANUP';
CREATE INDEX "phase7_proof_delivery" ON "Phase7RetirementProof"("deliveryId","kind");
CREATE INDEX "phase7_proof_consumption" ON "Phase7RetirementProof"("agencyId","creatorId","targetId","kind");
CREATE OR REPLACE FUNCTION phase7_immutable_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PHASE7_IMMUTABLE_RECEIPT'; END $$;
CREATE TRIGGER phase7_proof_immutable BEFORE UPDATE OR DELETE ON "Phase7RetirementProof" FOR EACH ROW EXECUTE FUNCTION phase7_immutable_receipt();
CREATE TRIGGER phase7_chunk_immutable BEFORE UPDATE OR DELETE ON "Phase7RetirementChunk" FOR EACH ROW EXECUTE FUNCTION phase7_immutable_receipt();
CREATE TRIGGER phase7_proof_no_truncate BEFORE TRUNCATE ON "Phase7RetirementProof" FOR EACH STATEMENT EXECUTE FUNCTION phase7_immutable_receipt();
CREATE TRIGGER phase7_chunk_no_truncate BEFORE TRUNCATE ON "Phase7RetirementChunk" FOR EACH STATEMENT EXECUTE FUNCTION phase7_immutable_receipt();

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
CREATE OR REPLACE FUNCTION phase7_legacy_truncate_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PHASE7_TRUNCATE_RETIRED:%',TG_TABLE_NAME; END $$;

-- Only acquisition/commit is gated. Settlement of an already issued external
-- attempt remains governed by its original lease/access/effect identity.
CREATE OR REPLACE FUNCTION phase7_sfs_acquisition_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."moduleKey"='sfs' AND NEW."actionType"='SFS_UNFOLLOW_TARGET' AND NEW."payload"->>'legacyMigration'='true'
    AND TG_OP='INSERT' AND current_setting('onlinod.phase7_executor_generation',true) IS DISTINCT FROM 'phase7_legacy_storage_v1'
 THEN RAISE EXCEPTION 'PHASE7_LEGACY_ADOPTION_GENERATION_REQUIRED'; END IF;
 IF TG_OP='UPDATE' AND OLD."legacyCleanupProofId" IS NOT NULL AND NEW."legacyCleanupProofId" IS DISTINCT FROM OLD."legacyCleanupProofId"
 THEN RAISE EXCEPTION 'PHASE7_CLEANUP_PROOF_IMMUTABLE'; END IF;
 IF NEW."legacyCleanupProofId" IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM "Phase7RetirementProof" p WHERE p."id"=NEW."legacyCleanupProofId" AND p."kind"='SFS_CLEANUP'
   AND p."deliveryId"=NEW."id" AND p."agencyId"=NEW."agencyId" AND p."creatorId"=NEW."creatorId"
   AND p."targetId"=NEW."targetId" AND p."targetId"=NEW."fanId" AND p."generation"=NEW."generation"
   AND NEW."moduleKey"='sfs' AND NEW."actionType"='SFS_UNFOLLOW_TARGET'
   AND NEW."payload"->>'legacyMigration'='true' AND p."evidence"->>'candidateId'=NEW."payload"->>'candidateId')
 THEN RAISE EXCEPTION 'PHASE7_CLEANUP_PROOF_BINDING_INVALID'; END IF;
 IF NEW."moduleKey" <> 'sfs' OR NEW."actionType" <> 'SFS_UNFOLLOW_TARGET' THEN RETURN NEW; END IF;
 IF (TG_OP='INSERT' AND NEW."status" IN ('CLAIMED','RUNNING','COMMITTING')) OR
    (TG_OP='UPDATE' AND ((NEW."status" IN ('CLAIMED','COMMITTING') AND NEW."status" IS DISTINCT FROM OLD."status")
       OR NEW."writeCommitRevision" > OLD."writeCommitRevision")) THEN
   IF current_setting('onlinod.phase7_sfs_generation',true) IS DISTINCT FROM 'phase7_legacy_storage_v1'
   THEN RAISE EXCEPTION 'PHASE7_SFS_EXECUTOR_GENERATION_REQUIRED'; END IF;
   IF NEW."status"='COMMITTING' AND COALESCE((NEW."payload"->>'legacyMigration')::boolean,false) AND NOT EXISTS (
      SELECT 1 FROM "Phase7RetirementProof" p JOIN "CreatorAccount" c ON c."id"=p."creatorId" AND c."agencyId"=p."agencyId"
      JOIN "SfsTargetCandidate" k ON k."id"=p."evidence"->>'candidateId' AND k."agencyId"=p."agencyId"
       AND k."creatorId"=p."creatorId" AND k."targetUserId"=p."targetId" AND k."safetyUnfollowDeliveryId"=p."deliveryId"
      WHERE p."kind"='SFS_CLEANUP' AND p."id"=NEW."legacyCleanupProofId" AND p."deliveryId"=NEW."id" AND p."agencyId"=NEW."agencyId"
      AND p."creatorId"=NEW."creatorId" AND p."targetId"=NEW."targetId" AND p."targetId"=NEW."fanId"
      AND p."generation"=NEW."generation" AND p."providerSubject"=c."remoteId"
      AND p."evidence"->>'candidateId'=NEW."payload"->>'candidateId'
      AND NOT (COALESCE(k."metadata"->>'followEffectOwnership','')='OWNED'
       AND COALESCE(k."metadata"->>'followEffectDeliveryId','')<>''
       AND k."metadata"->>'followEffectDeliveryId' IS DISTINCT FROM p."evidence"->>'followDeliveryId')
      FOR SHARE OF c,k
   ) THEN RAISE EXCEPTION 'PHASE7_SFS_ATTESTATION_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase7_sfs_acquisition BEFORE INSERT OR UPDATE ON "AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION phase7_sfs_acquisition_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('analytics_compat','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','WRITES_FENCED');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "AnalyticsSnapshot" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('analytics_compat','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "AnalyticsSnapshot" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CreatorEarningsSnapshot" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('analytics_compat','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CreatorEarningsSnapshot" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CreatorCampaignsSnapshot" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('analytics_compat','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CreatorCampaignsSnapshot" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('team_compat','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','WRITES_FENCED');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "TeamResponseCase" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('team_compat','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "TeamResponseCase" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "TeamPendingDialogState" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('team_compat','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "TeamPendingDialogState" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('automation_job','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','WRITES_FENCED');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "AutomationJob" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('automation_job','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "AutomationJob" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('observation_bridge','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','WRITES_FENCED');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "FanObservationClock" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('observation_bridge','','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "FanObservationClock" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('traffic_aggregate','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','WRITES_FENCED');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "TrafficDailyAggregate" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('traffic_aggregate','agencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "TrafficDailyAggregate" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('impersonation_retired','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','WRITES_FENCED');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "ImpersonationToken" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('impersonation_retired','targetAgencyId','COMPAT_DRAIN_DROP');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "ImpersonationToken" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('old_automation','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "AutomationRule" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_automation','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "AutomationRule" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "AutomationRun" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_automation','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "AutomationRun" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "AutomationLog" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_automation','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "AutomationLog" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('old_presence','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CreatorPresenceSnapshot" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_presence','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CreatorPresenceSnapshot" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CreatorPresenceUser" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_presence','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CreatorPresenceUser" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CreatorFanLocalCoverage" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_presence','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CreatorFanLocalCoverage" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('old_templates','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "MessageTemplateGroup" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_templates','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "MessageTemplateGroup" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "MessageTemplate" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_templates','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "MessageTemplate" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "MessageTemplateUsageEvent" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('old_templates','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "MessageTemplateUsageEvent" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('crm_archive','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CrmProfile" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('crm_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CrmProfile" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CrmProfileTag" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('crm_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CrmProfileTag" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CrmProfileRawTag" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('crm_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CrmProfileRawTag" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CrmNote" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('crm_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CrmNote" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CrmAnalysisRun" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('crm_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CrmAnalysisRun" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('lists_campaign_archive','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "FanList" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('lists_campaign_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "FanList" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "FanListMember" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('lists_campaign_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "FanListMember" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "SavedSegment" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('lists_campaign_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "SavedSegment" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CampaignDraft" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('lists_campaign_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CampaignDraft" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "CampaignQueueStatus" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('lists_campaign_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "CampaignQueueStatus" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('follow_vault_archive','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "FollowBackTask" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('follow_vault_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "FollowBackTask" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "VaultMediaSale" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('follow_vault_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "VaultMediaSale" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "VaultPurchaseMessage" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('follow_vault_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "VaultPurchaseMessage" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
INSERT INTO "Phase7RetirementCohort"("id","planHash","state") VALUES('server_ledger_archive','9fb409e3d948c17e3f71914de68c0ef2de116ffa250c73eb48191d1466eab2ac','RETAINED_READ_ONLY');
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "DialogMessageLedger" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('server_ledger_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "DialogMessageLedger" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "DialogMessageMedia" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('server_ledger_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "DialogMessageMedia" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "DialogPurchaseSignal" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('server_ledger_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "DialogPurchaseSignal" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "VaultPurchaseLedger" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('server_ledger_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "VaultPurchaseLedger" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE TRIGGER phase7_storage_fence BEFORE INSERT OR UPDATE OR DELETE ON "VaultPurchaseMedia" FOR EACH ROW EXECUTE FUNCTION phase7_legacy_storage_fence('server_ledger_archive','agencyId','ARCHIVE_RETAIN');
CREATE TRIGGER phase7_truncate_fence BEFORE TRUNCATE ON "VaultPurchaseMedia" FOR EACH STATEMENT EXECUTE FUNCTION phase7_legacy_truncate_fence();
CREATE OR REPLACE FUNCTION phase7_new_execution_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acquire boolean := false;
BEGIN
 IF TG_TABLE_NAME='DomainWorkItem' THEN
   acquire := NEW."state"='CLAIMED' AND (TG_OP='INSERT' OR OLD."state" IS DISTINCT FROM NEW."state" OR OLD."ownerToken" IS DISTINCT FROM NEW."ownerToken");
 ELSIF TG_TABLE_NAME='JobInstance' THEN
   acquire := NEW."status" IN ('CLAIMED','RUNNING') AND (TG_OP='INSERT'
     OR OLD."leaseRevision" IS DISTINCT FROM NEW."leaseRevision"
     OR (NEW."status"='CLAIMED' AND OLD."status" IS DISTINCT FROM NEW."status")
     OR (NEW."status"='RUNNING' AND OLD."status" NOT IN ('CLAIMED','RUNNING')));
 ELSE
   acquire := NEW."status" IN ('CLAIMED','RUNNING','COMMITTING') AND (TG_OP='INSERT'
     OR OLD."leaseRevision" IS DISTINCT FROM NEW."leaseRevision" OR OLD."writeCommitRevision" IS DISTINCT FROM NEW."writeCommitRevision"
     OR (NEW."status" IN ('CLAIMED','COMMITTING') AND OLD."status" IS DISTINCT FROM NEW."status")
     OR (NEW."status"='RUNNING' AND OLD."status" NOT IN ('CLAIMED','RUNNING','COMMITTING')));
 END IF;
 IF acquire AND current_setting('onlinod.phase7_executor_generation',true) IS DISTINCT FROM 'phase7_legacy_storage_v1'
 THEN RAISE EXCEPTION 'PHASE7_NEW_EXECUTION_GENERATION_REQUIRED'; END IF;
 IF acquire THEN NEW."legacyStorageGeneration" := 'phase7_legacy_storage_v1'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phase7_execution_generation BEFORE INSERT OR UPDATE ON "DomainWorkItem" FOR EACH ROW EXECUTE FUNCTION phase7_new_execution_generation();
CREATE TRIGGER phase7_execution_generation BEFORE INSERT OR UPDATE ON "JobInstance" FOR EACH ROW EXECUTE FUNCTION phase7_new_execution_generation();
CREATE TRIGGER phase7_execution_generation BEFORE INSERT OR UPDATE ON "AutomationDelivery" FOR EACH ROW EXECUTE FUNCTION phase7_new_execution_generation();
CREATE OR REPLACE FUNCTION phase7_storage_fingerprint() RETURNS text LANGUAGE sql STABLE AS $fn$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM
   (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema()) c),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid,true)) ORDER BY c.relname,k.conname)
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.relname,x.indisvalid,x.indisready,pg_get_indexdef(i.oid)) ORDER BY c.relname,i.relname)
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid)) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.prokind IN ('f','p')),
 'views',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_viewdef(c.oid,true)) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='v'),
 'enums',(SELECT jsonb_agg(jsonb_build_array(t.typname,e.enumsortorder,e.enumlabel) ORDER BY t.typname,e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=current_schema())
 )::text,'UTF8')),'hex')
$fn$;
INSERT INTO "Phase2ReleaseCompatibilityAuthority"("scope","requiredGeneration","activationState","activatedAt","updatedAt")
 VALUES('LEGACY_STORAGE_RETIREMENT_V1','phase7_legacy_storage_v1','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
RESET lock_timeout;
RESET statement_timeout;
